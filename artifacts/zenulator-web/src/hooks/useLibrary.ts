import { useState, useEffect, useCallback } from 'react';
import { db, Game } from '@/lib/db';
import {
  artworkFromFile,
  isCompanionArtwork,
  artworkReference,
  readRomImport,
  type ArtworkReference,
  type ArtworkCandidate,
  type GameArtwork,
} from '@/lib/artwork';
import { deviceLibrary, type DeviceConflictRecord, type DeviceFolderStatus } from '@/lib/deviceLibrary';

export interface RomImportResult {
  game: Game;
  artworkCandidates: ArtworkCandidate[];
  warnings: string[];
}

export function automaticArtworkCandidate(game: Game, candidates: ArtworkCandidate[]): ArtworkCandidate | null {
  return candidates.length === 1 && !game.artwork ? candidates[0] : null;
}

export async function scanWithoutHidingBrowserRecovery<T>(
  recovery: T,
  scan: () => Promise<unknown>,
  readAfterScan: () => Promise<T>,
): Promise<{ value: T; error: unknown | null }> {
  try {
    await scan();
    return { value: await readAfterScan(), error: null };
  } catch (error) {
    return { value: recovery, error };
  }
}

export function useLibrary() {
  const [games, setGames] = useState<Game[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [deviceStatus, setDeviceStatus] = useState<DeviceFolderStatus>({
    kind: deviceLibrary.supported() ? 'unlinked' : 'unsupported',
    message: 'Checking linked folder availability…',
  });
  const [deviceConflicts, setDeviceConflicts] = useState<DeviceConflictRecord[]>([]);
  const [devicePending, setDevicePending] = useState<DeviceConflictRecord[]>([]);
  const [libraryNotice, setLibraryNotice] = useState('');

  const loadGames = useCallback(async (scanDevice = false) => {
    setIsLoading(true);
    try {
      // Always obtain recovery first. A disconnected/malformed folder is
      // optional storage and must never hide the browser library.
      let allGames = await db.getGames();
      try {
        const status = await deviceLibrary.status();
        setDeviceStatus(status);
        if (scanDevice && status.kind === 'connected') {
          const scan = await scanWithoutHidingBrowserRecovery(
            allGames,
            () => deviceLibrary.scanIntoBrowser(),
            () => db.getGames(),
          );
          // Include only successfully scanned additions; on failure retain the
          // original recovery snapshot above.
          allGames = scan.value;
          if (scan.error) throw scan.error;
        }
        setDeviceConflicts(await deviceLibrary.getConflicts());
        setDevicePending(await deviceLibrary.getPending());
      } catch (deviceError) {
        setDeviceStatus({
          kind: 'error',
          message: deviceError instanceof Error ? deviceError.message : 'The linked folder could not be scanned. Browser recovery remains available.',
        });
      }
      // Sort by last played, then added
      allGames.sort((a, b) => {
        if (b.lastPlayedAt !== a.lastPlayedAt) {
          return b.lastPlayedAt - a.lastPlayedAt;
        }
        return b.addedAt - a.addedAt;
      });
      setGames(allGames);
    } catch (e) {
      console.error('Failed to load games:', e);
      setDeviceStatus({ kind: 'error', message: e instanceof Error ? e.message : 'The linked folder could not be scanned.' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGames(true);
  }, [loadGames]);

  const generateRomHash = async (buffer: ArrayBuffer) => {
    if (!window.crypto?.subtle) {
      throw new Error('Secure browser storage is unavailable. Open Zenulator Web over HTTPS in a current browser.');
    }
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  };

  const hydrateLinkedArtwork = async (game: Game, artwork: GameArtwork | null): Promise<Game> => {
    if (!artwork) return game;
    const stored: GameArtwork = {
      ...artwork,
      id: game.id,
      data: artwork.data.slice(0),
      byteLength: artwork.data.byteLength,
    };
    await db.putArtwork(stored);
    const updated = { ...game, artwork: artworkReference(stored) };
    await db.putGame(updated);
    return updated;
  };

  const importRom = async (file: File, companions: File[] = []): Promise<RomImportResult> => {
    if (!file.name.toLowerCase().endsWith('.gba') && !file.name.toLowerCase().endsWith('.zip')) {
      throw new Error('Only .gba ROM files or ROM-hack .zip archives are supported.');
    }
    if (navigator.storage?.persist) {
      await navigator.storage.persist().catch(() => false);
    }
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      const available = (estimate.quota ?? 0) - (estimate.usage ?? 0);
      if (estimate.quota && available < file.size * 1.25) {
        throw new Error('This browser does not have enough local storage available for that ROM.');
      }
    }

    const imported = await readRomImport(file);
    // Raw GBA files have no standard embedded cover field. Accept matching
    // companion images explicitly selected alongside them, without ROM edits.
    if (!imported.artworkCandidates.length) {
      for (const image of companions.filter((image) => isCompanionArtwork(file.name, image.name)).slice(0, 8)) {
        try {
          const artwork = await artworkFromFile(image);
          imported.artworkCandidates.push({ ...artwork, path: image.name, score: 100 });
        } catch (error) {
          imported.warnings.push(`${image.name}: ${error instanceof Error ? error.message : 'Invalid artwork.'}`);
        }
      }
    }
    const buffer = imported.rom;
    const romHash = await generateRomHash(buffer);
    const id = romHash;
    
    // Check if game already exists
    const existing = await db.getGame(id);
    const browserArtwork = existing ? await db.getArtwork(id) : null;
    const linkedArtwork = browserArtwork ? null : await deviceLibrary.getLinkedArtwork(id);
    if (existing) {
      // A linked-folder copy can outlive a browser-only deletion. Hydrate its
      // cover before returning candidates so "keep current" is a real local
      // recovery choice rather than an empty metadata reference.
      const hydrated = await hydrateLinkedArtwork(existing, linkedArtwork);
      const automatic = automaticArtworkCandidate(hydrated, imported.artworkCandidates);
      if (automatic) {
        await saveArtworkValue(id, { ...automatic, id });
        await loadGames();
        return { game: (await db.getGame(id))!, artworkCandidates: [], warnings: imported.warnings };
      }
      return { game: hydrated, artworkCandidates: imported.artworkCandidates, warnings: imported.warnings };
    }

    const header = new Uint8Array(buffer, 0xa0, 12);
    const headerName = new TextDecoder('ascii')
      .decode(header)
      .replace(/\0/g, '')
      .trim();
    const name = headerName || file.name.replace(/\.[^/.]+$/, '');

    let game: Game = {
      id,
      romHash,
      name,
      fileName: file.name,
      size: buffer.byteLength,
      addedAt: Date.now(),
      lastPlayedAt: 0,
      playTime: 0,
    };

    try {
      await db.putGame(game, buffer);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        throw new Error('The browser ran out of local storage while importing this ROM.');
      }
      throw error;
    }
    try {
      await deviceLibrary.mirrorGame(game, buffer);
    } catch (error) {
      // IndexedDB has already committed a recovery copy; be explicit that the
      // portable folder did not receive the ROM rather than pretending success.
      throw new Error(`The ROM was saved in browser storage, but not to the linked folder: ${error instanceof Error ? error.message : 'unknown write error'}`);
    }
    // Mirror the ROM before hydrating a linked cover. This lets mirrorGame
    // retain the linked generation and avoids rewriting it merely to display
    // a keep/replace choice for a ZIP candidate.
    game = await hydrateLinkedArtwork(game, linkedArtwork);
    const automaticCandidate = automaticArtworkCandidate(game, imported.artworkCandidates);
    if (automaticCandidate) {
      // A single valid image beside a ROM without existing artwork is
      // unambiguous. Existing browser or linked covers require a choice.
      const candidate = { ...automaticCandidate, id };
      await saveArtworkValue(id, candidate);
      imported.artworkCandidates = [];
    }
    await loadGames();
    return { game: (await db.getGame(id)) ?? game, artworkCandidates: imported.artworkCandidates, warnings: imported.warnings };
  };

  const saveArtworkValue = async (gameId: string, artwork: GameArtwork): Promise<Game> => {
    const game = await db.getGame(gameId);
    if (!game) throw new Error('This game is no longer in the local library.');
    const stored: GameArtwork = {
      id: gameId,
      data: artwork.data.slice(0),
      mimeType: artwork.mimeType,
      byteLength: artwork.data.byteLength,
      fileName: artwork.fileName,
      source: artwork.source,
      ...(artwork.width ? { width: artwork.width } : {}),
      ...(artwork.height ? { height: artwork.height } : {}),
    };
    await db.putArtwork(stored);
    const reference: ArtworkReference = artworkReference(stored);
    const updated = { ...game, artwork: reference };
    await db.putGame(updated);
    try {
      await deviceLibrary.mirrorArtwork(gameId, stored);
    } catch (error) {
      throw new Error(`Artwork was saved in browser storage, but not to the linked folder: ${error instanceof Error ? error.message : 'unknown write error'}`);
    }
    await loadGames();
    return updated;
  };

  const setArtwork = async (gameId: string, file: File): Promise<Game> => {
    return saveArtworkValue(gameId, await artworkFromFile(file));
  };

  const setArtworkCandidate = async (gameId: string, candidate: ArtworkCandidate): Promise<Game> => {
    return saveArtworkValue(gameId, {
      id: gameId,
      data: candidate.data,
      mimeType: candidate.mimeType,
      byteLength: candidate.data.byteLength,
      fileName: candidate.fileName,
      source: candidate.source,
      width: candidate.width,
      height: candidate.height,
    });
  };

  const removeArtwork = async (gameId: string): Promise<Game> => {
    const game = await db.getGame(gameId);
    if (!game) throw new Error('This game is no longer in the local library.');
    await db.deleteArtwork(gameId);
    const updated = { ...game };
    delete updated.artwork;
    await db.putGame(updated);
    try {
      await deviceLibrary.mirrorArtwork(gameId, null);
    } catch (error) {
      throw new Error(`Artwork was removed from browser storage, but not from the linked folder: ${error instanceof Error ? error.message : 'unknown write error'}`);
    }
    await loadGames();
    return updated;
  };

  const deleteGame = async (id: string) => {
    await db.deleteGame(id);
    // The portable manifest and all device files intentionally remain intact.
    // It can therefore return on a later explicit folder import.
    setLibraryNotice('Removed from this browser only. The linked-folder copy remains and can be imported again.');
    await loadGames();
  };

  const chooseDeviceFolder = async () => {
    const status = await deviceLibrary.chooseFolder();
    setDeviceStatus(status);
    if (status.kind === 'connected') await loadGames(true);
    return status;
  };

  const reconnectDeviceFolder = async () => {
    const status = await deviceLibrary.reconnect();
    setDeviceStatus(status);
    if (status.kind === 'connected') await loadGames(true);
    return status;
  };

  const disconnectDeviceFolder = async () => {
    await deviceLibrary.disconnect();
    const status: DeviceFolderStatus = { kind: 'unlinked', message: 'Linked folder disconnected. Files in that folder were not changed.' };
    setDeviceStatus(status);
  };

  const copyToDeviceFolder = async (overwrite = false, onProgress?: (completed: number, total: number) => void) => {
    await deviceLibrary.importBrowserLibrary(overwrite, onProgress);
    const status = await deviceLibrary.status();
    setDeviceStatus(status);
  };

  const useLinkedCopy = async (gameId: string) => {
    await deviceLibrary.replaceBrowserRecoveryFromDevice(gameId);
    await loadGames(false);
  };

  const renameGame = async (id: string, value: string) => {
    const name = value.trim();
    if (!name || name.length > 120) throw new Error('Enter a title between 1 and 120 characters.');
    const game = await db.getGame(id);
    if (!game) throw new Error('This game is no longer in the library.');
    await db.putGame({ ...game, name });
    try {
      await deviceLibrary.renameGame(id, name);
    } catch (error) {
      throw new Error(`Title saved in browser storage, but not to the linked folder: ${error instanceof Error ? error.message : 'Write failed.'}`);
    } finally { await loadGames(false); }
  };

  return {
    games, isLoading, importRom, deleteGame, loadGames, deviceStatus,
    chooseDeviceFolder, reconnectDeviceFolder, disconnectDeviceFolder, copyToDeviceFolder,
    deviceConflicts, devicePending, useLinkedCopy, libraryNotice,
    setArtwork, setArtworkCandidate, removeArtwork, renameGame,
  };
}
