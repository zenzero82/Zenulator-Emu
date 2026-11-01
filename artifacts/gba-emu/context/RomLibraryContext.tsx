import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Image, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import type { ImportOptions } from '../library/importRomAsset';
import { deleteBatterySave } from '@/library/batterySaveStorage';
import {
  ARTWORK_DIRECTORY,
  MAX_ARTWORK_BYTES,
  MAX_ARTWORK_PIXELS,
  base64ToBytes,
  hashBytes,
  portableArtworkPath,
  resolveArtworkUri,
  validateArtworkBytes,
} from '@/library/romArtwork';

export interface RomEntry {
  id: string;
  name: string;
  fileName: string;
  size: number;
  is64MB: boolean;
  addedAt: number;
  lastPlayed?: number;
  playTime?: number;
  filePath?: string; // local filesystem path (not base64)
  /** Content identity used to re-import a ROM without creating a new library entry. */
  contentHash?: string;
  /** Relative to documentDirectory; absolute legacy paths are re-anchored. */
  artworkPath?: string;
  saveStates?: SaveState[];
}

export interface SaveState {
  id: string;
  slot: number;
  timestamp: number;
  data: string; // JSON stringified state
  thumbnail?: string; // base64 canvas screenshot (future)
}

interface RomLibraryContextType {
  roms: RomEntry[];
  ready: boolean;
  loadError: string | null;
  addRom: (entry: Omit<RomEntry, 'id' | 'addedAt'>, options?: ImportOptions) => Promise<RomEntry>;
  removeRom: (id: string) => Promise<void>;
  renameRom: (id: string, name: string) => Promise<void>;
  setArtwork: (id: string, source: RomArtworkSource) => Promise<void>;
  setArtworkFromBase64: (id: string, base64: string, extension: string) => Promise<void>;
  removeArtwork: (id: string) => Promise<void>;
  updateLastPlayed: (id: string) => Promise<void>;
  saveState: (romId: string, slot: number, data: string) => Promise<void>;
  loadState: (romId: string, slot: number) => Promise<SaveState | null>;
  getSaveStates: (romId: string) => SaveState[];
  activeRomId: string | null;
  setActiveRomId: (id: string | null) => void;
}

export interface RomArtworkSource {
  uri: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

const RomLibraryContext = createContext<RomLibraryContextType | null>(null);

const STORAGE_KEY = '@gba_emu_roms';
const ARTWORK_MAX_BASE64_LENGTH = Math.ceil((MAX_ARTWORK_BYTES * 4) / 3) + 8;

function artworkFileExtension(source: RomArtworkSource): string {
  const mime = source.mimeType?.toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpeg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  const name = source.name?.toLowerCase() ?? '';
  const match = /\.(png|jpe?g|webp|gif)$/.exec(name);
  return match?.[1] === 'jpg' ? 'jpeg' : match?.[1] ?? '';
}

function safeArtworkPathForRom(id: string, extension: string): string {
  const safeExtension = ['png', 'jpeg', 'webp', 'gif'].includes(extension) ? extension : 'png';
  const safeId = /^[A-Za-z0-9._-]+$/.test(id) ? id : 'rom';
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${ARTWORK_DIRECTORY}${safeId}-custom-${uniqueSuffix}.${safeExtension}`;
}

function verifyNativeArtwork(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(
      uri,
      (width, height) => {
        if (
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          width <= 0 ||
          height <= 0 ||
          width > 8192 ||
          height > 8192 ||
          width * height > MAX_ARTWORK_PIXELS
        ) {
          reject(new Error('The artwork dimensions are too large.'));
          return;
        }
        resolve({ width, height });
      },
      () => reject(new Error('The selected artwork could not be decoded by the device.')),
    );
  });
}

async function legacyRomMatchesHash(entry: RomEntry, contentHash: string): Promise<boolean> {
  if (entry.contentHash) return entry.contentHash.toLowerCase() === contentHash;
  if (Platform.OS === 'web') {
    try {
      const stored = await AsyncStorage.getItem(`@gba_rom_data_${entry.id}`);
      return !!stored && hashBytes(base64ToBytes(stored)) === contentHash;
    } catch {
      return false;
    }
  }
  if (!entry.filePath) return false;
  try {
    const info = await FileSystem.getInfoAsync(entry.filePath, { md5: true });
    if (info.exists && info.md5) return info.md5.toLowerCase() === contentHash;
    const fileName = entry.filePath.split('/').pop();
    if (!fileName) return false;
    const currentPath = `${FileSystem.documentDirectory}gba_roms/${fileName}`;
    const currentInfo = await FileSystem.getInfoAsync(currentPath, { md5: true });
    return !!(currentInfo.exists && currentInfo.md5 && currentInfo.md5.toLowerCase() === contentHash);
  } catch {
    return false;
  }
}

export function RomLibraryProvider({ children }: { children: React.ReactNode }) {
  const [roms, setRoms] = useState<RomEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeRomId, setActiveRomId] = useState<string | null>(null);
  const romsRef = useRef<RomEntry[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) throw new Error('Invalid ROM library.');
          if (Array.isArray(parsed)) {
            const loaded = parsed.map((entry) => ({
              ...entry,
              artworkPath: portableArtworkPath(entry?.artworkPath),
            }));
            romsRef.current = loaded;
            setRoms(loaded);
          }
        } catch {
          throw new Error('The ROM library could not be read. Import is disabled to protect existing games.');
        }
      }
      setReady(true);
    }).catch((error) => setLoadError(String(error)));
  }, []);

  const persist = useCallback(async (updated: RomEntry[]) => {
    // Do not expose a successful import until its manifest is durable.
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    romsRef.current = updated;
    setRoms(updated);
  }, []);

  const addRom = useCallback(async (entry: Omit<RomEntry, 'id' | 'addedAt'>, options?: ImportOptions): Promise<RomEntry> => {
    let existing: RomEntry | undefined;
    if (entry.contentHash) {
      existing = romsRef.current.find((rom) => rom.contentHash?.toLowerCase() === entry.contentHash);
      if (!existing) {
        for (const rom of romsRef.current) {
          if (await legacyRomMatchesHash(rom, entry.contentHash)) {
            existing = rom;
            break;
          }
        }
      }
    }
    if (existing) {
      if (options?.keepExisting) return existing;
      const merged: RomEntry = {
        ...existing,
        ...entry,
        id: existing.id,
        addedAt: existing.addedAt,
        // Re-importing a ROM updates its bytes/metadata, not its progress or
        // user artwork. Artwork is changed only by an explicit user choice.
        saveStates: existing.saveStates || [],
        artworkPath: existing.artworkPath,
        contentHash: entry.contentHash,
      };
      await persist(romsRef.current.map((rom) => rom.id === existing!.id ? merged : rom));
      if (existing.filePath && merged.filePath && existing.filePath !== merged.filePath) {
        try { await FileSystem.deleteAsync(existing.filePath, { idempotent: true }); } catch {}
        try {
          const fileName = existing.filePath.split('/').pop();
          if (fileName) {
            await FileSystem.deleteAsync(`${FileSystem.documentDirectory}gba_roms/${fileName}`, { idempotent: true });
          }
        } catch {}
      }
      return merged;
    }
    const newEntry: RomEntry = {
      ...entry,
      id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
      addedAt: Date.now(),
      saveStates: entry.saveStates || [],
    };
    // The browser fallback also writes bytes before publishing the entry.
    if (Platform.OS === 'web' && options?.webBase64) {
      await AsyncStorage.setItem(`@gba_rom_data_${newEntry.id}`, options.webBase64);
    }
    try {
      await persist([...romsRef.current, newEntry]);
    } catch (error) {
      if (Platform.OS === 'web' && options?.webBase64) {
        await AsyncStorage.removeItem(`@gba_rom_data_${newEntry.id}`).catch(() => {});
      }
      throw error;
    }
    return newEntry;
  }, [persist]);

  const removeRom = useCallback(async (id: string) => {
    const currentRoms = romsRef.current;
    const entry = currentRoms.find((r) => r.id === id);
    // Remove the manifest entry first. A failed delete then leaves only an
    // orphaned file, never a manifest pointing at missing user data.
    await persist(currentRoms.filter((r) => r.id !== id));
    if (Platform.OS === 'web') {
      // On web, ROM data + battery save live in AsyncStorage
      try { await AsyncStorage.removeItem(`@gba_rom_data_${id}`); } catch {}
    } else if (entry?.filePath) {
      // On native, delete the physical file. Re-anchor to the current
      // documentDirectory too — stored absolute paths go stale after an
      // app update (iOS rotates the container UUID).
      try { await FileSystem.deleteAsync(entry.filePath, { idempotent: true }); } catch {}
      try {
        const fileName = entry.filePath.split('/').pop();
        if (fileName) {
          await FileSystem.deleteAsync(`${FileSystem.documentDirectory}gba_roms/${fileName}`, { idempotent: true });
        }
      } catch {}
    }
    // Serialize cleanup with pending writes and include recovery/pre-import copies.
    try { await deleteBatterySave(id); } catch (error) { console.warn('Battery save cleanup failed', error); }
    // Artwork is kept alongside ROM files, with a portable path in the
    // manifest. Resolve it against the current iOS container first.
    if (Platform.OS !== 'web') {
      try {
        const artworkPath = resolveArtworkUri(entry?.artworkPath, FileSystem.documentDirectory);
        if (artworkPath) await FileSystem.deleteAsync(artworkPath, { idempotent: true });
      } catch {}
    }
  }, [persist]);

  const writeArtwork = useCallback(async (
    id: string,
    base64: string,
    extension: string,
  ): Promise<{ artworkPath: string; finalPath: string; oldPath?: string }> => {
    if (Platform.OS === 'web') {
      throw new Error('Custom ROM artwork is only available on iOS and Android.');
    }
    if (!base64 || base64.length > ARTWORK_MAX_BASE64_LENGTH) {
      throw new Error('Artwork files must be 8 MB or smaller.');
    }
    if (!romsRef.current.some((rom) => rom.id === id)) {
      throw new Error('The ROM is no longer in your library.');
    }
    // Validate the complete payload before touching the old image.  The
    // decoder is deliberately local to this operation so malformed base64
    // never reaches the filesystem.
    const bytes = base64ToBytes(base64);
    const info = validateArtworkBytes(bytes);
    const finalPortablePath = safeArtworkPathForRom(id, info.extension || extension);
    const finalPath = `${FileSystem.documentDirectory}${finalPortablePath}`;
    const artworkDirectory = `${FileSystem.documentDirectory}${ARTWORK_DIRECTORY}`;
    const tempPath = `${finalPath}.tmp.${info.extension}`;
    await FileSystem.makeDirectoryAsync(artworkDirectory, { intermediates: true });
    const current = romsRef.current.find((rom) => rom.id === id);
    const oldPath = resolveArtworkUri(current?.artworkPath, FileSystem.documentDirectory);
    try {
      await FileSystem.writeAsStringAsync(tempPath, base64, { encoding: FileSystem.EncodingType.Base64 });
      await verifyNativeArtwork(tempPath);
      await FileSystem.moveAsync({ from: tempPath, to: finalPath });
    } catch (error) {
      await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
      throw error;
    }
    return { artworkPath: finalPortablePath, finalPath, oldPath };
  }, []);

  const setArtworkFromBase64 = useCallback(async (id: string, base64: string, extension: string) => {
    const result = await writeArtwork(id, base64, extension);
    try {
      await persist(romsRef.current.map((rom) => rom.id === id ? { ...rom, artworkPath: result.artworkPath } : rom));
    } catch (error) {
      await FileSystem.deleteAsync(result.finalPath, { idempotent: true }).catch(() => {});
      throw error;
    }
    // Persist the new manifest before deleting the old file. If this cleanup
    // fails, the manifest still points at a valid replacement.
    if (result.oldPath && result.oldPath !== result.finalPath) {
      await FileSystem.deleteAsync(result.oldPath, { idempotent: true });
    }
  }, [persist, writeArtwork]);

  const setArtwork = useCallback(async (id: string, source: RomArtworkSource) => {
    if (Platform.OS === 'web') {
      throw new Error('Custom ROM artwork is only available on iOS and Android.');
    }
    const info = await FileSystem.getInfoAsync(source.uri);
    if (!info.exists) throw new Error('The selected artwork file is no longer available.');
    const size = (info as { size?: number }).size ?? source.size ?? 0;
    if (!Number.isFinite(size) || size <= 0 || size > MAX_ARTWORK_BYTES) {
      throw new Error('Artwork files must be 8 MB or smaller.');
    }
    const base64 = await FileSystem.readAsStringAsync(source.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    await setArtworkFromBase64(id, base64, artworkFileExtension(source));
  }, [setArtworkFromBase64]);

  const removeArtwork = useCallback(async (id: string) => {
    const current = romsRef.current.find((rom) => rom.id === id);
    const path = resolveArtworkUri(current?.artworkPath, FileSystem.documentDirectory);
    await persist(romsRef.current.map((rom) => {
      if (rom.id !== id) return rom;
      const { artworkPath: _artworkPath, ...withoutArtwork } = rom;
      return withoutArtwork;
    }));
    if (Platform.OS !== 'web') {
      if (path) await FileSystem.deleteAsync(path, { idempotent: true });
    }
  }, [persist]);

  const updateLastPlayed = useCallback(async (id: string) => {
    await persist(romsRef.current.map((r) => r.id === id ? { ...r, lastPlayed: Date.now() } : r));
  }, [persist]);

  const renameRom = useCallback(async (id: string, value: string) => {
    const name = value.trim();
    if (!name || name.length > 120) throw new Error('Enter a title between 1 and 120 characters.');
    if (!romsRef.current.some((rom) => rom.id === id)) throw new Error('This game is no longer in the library.');
    await persist(romsRef.current.map((rom) => rom.id === id ? { ...rom, name } : rom));
  }, [persist]);

  const saveState = useCallback(async (romId: string, slot: number, data: string) => {
    const state: SaveState = {
      id: `${romId}_slot${slot}`,
      slot,
      timestamp: Date.now(),
      data,
    };
    const updated = romsRef.current.map((r) => {
      if (r.id !== romId) return r;
      const states = (r.saveStates || []).filter((s) => s.slot !== slot);
      return { ...r, saveStates: [...states, state] };
    });
    await persist(updated);
  }, [persist]);

  const loadState = useCallback(async (romId: string, slot: number): Promise<SaveState | null> => {
    const rom = romsRef.current.find((r) => r.id === romId);
    if (!rom || !rom.saveStates) return null;
    return rom.saveStates.find((s) => s.slot === slot) || null;
  }, []);

  const getSaveStates = useCallback((romId: string): SaveState[] => {
    const rom = romsRef.current.find((r) => r.id === romId);
    return rom?.saveStates || [];
  }, []);

  return (
    <RomLibraryContext.Provider value={{
      roms, ready, loadError, addRom, removeRom, renameRom, setArtwork, setArtworkFromBase64, removeArtwork, updateLastPlayed,
      saveState, loadState, getSaveStates,
      activeRomId, setActiveRomId,
    }}>
      {children}
    </RomLibraryContext.Provider>
  );
}

export function useRomLibrary() {
  const ctx = useContext(RomLibraryContext);
  if (!ctx) throw new Error('useRomLibrary must be used within RomLibraryProvider');
  return ctx;
}
