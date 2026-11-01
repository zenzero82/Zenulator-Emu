import { db, plainGame, type Game, type SaveState } from '@/lib/db';
import {
  artworkReference,
  isArtworkMimeType,
  MAX_ARTWORK_BYTES,
  inspectArtworkBytes,
  validateArtworkBytes,
  type GameArtwork,
} from '@/lib/artwork';
import { validateBatterySave, validateSaveState } from '@/lib/saveValidation';

/*
 * The directory is intentionally a plain, portable layout.  The selected
 * directory can be copied to another computer, but its permission is tied to
 * this web origin and must be granted again there.
 */
const ROOT_DIRECTORY = '.zenulator';
const MANIFEST_FILE = 'manifest.json';
const MANIFEST_VERSION = 1;
const HANDLE_SETTING = 'linked-device-folder-v1';
const PENDING_SETTING = 'linked-device-folder-pending-v1';
const CONFLICT_SETTING = 'linked-device-folder-conflicts-v1';
const MAX_ROM_BYTES = 64 * 1024 * 1024;
const MAX_SAVE_CHARS = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 16 * 1024 * 1024;

type Permission = 'granted' | 'denied' | 'prompt';

interface DeviceGame extends Game {
  romFile: string;
  batteryFile?: string;
  artworkFile?: string;
  stateFiles: Record<string, { file: string; timestamp: number }>;
  previousFiles?: string[];
}

interface DeviceManifest {
  app: 'zenulator-web-device-library';
  version: 1;
  revision: number;
  updatedAt: number;
  games: Record<string, DeviceGame>;
}

export interface DeviceConflictRecord {
  gameId: string;
  revision: number;
  reason: string;
  detectedAt: number;
}

export type DeviceFolderStatus =
  | { kind: 'unsupported'; message: string }
  | { kind: 'unlinked'; message: string }
  | { kind: 'permission-needed'; message: string }
  | { kind: 'connected'; message: string; revision: number }
  | { kind: 'error'; message: string };

export class DeviceLibraryError extends Error {}
export class DeviceConflictError extends DeviceLibraryError {}

type Directory = FileSystemDirectoryHandle;
type RootDirectory = Directory & {
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<Permission>;
  requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<Permission>;
};
type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<RootDirectory>;
interface CommitMutation { created?: string[]; cleanup?: string[]; }

function sanitizeFilePart(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DeviceLibraryError('The ROM identity is invalid.');
  return value;
}

function manifestTemplate(): DeviceManifest {
  return {
    app: 'zenulator-web-device-library',
    version: MANIFEST_VERSION,
    revision: 0,
    updatedAt: Date.now(),
    games: {},
  };
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new DeviceLibraryError('Secure SHA-256 support is required to verify ROM files in the linked folder.');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseManifest(value: unknown): DeviceManifest {
  if (!value || typeof value !== 'object') throw new DeviceLibraryError('The linked folder manifest is malformed.');
  const manifest = value as Partial<DeviceManifest>;
  if (
    manifest.app !== 'zenulator-web-device-library' ||
    manifest.version !== MANIFEST_VERSION ||
    typeof manifest.revision !== 'number' ||
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 0 ||
    !manifest.games ||
    typeof manifest.games !== 'object'
  ) {
    throw new DeviceLibraryError('The linked folder uses an unsupported or malformed manifest.');
  }
  for (const [id, game] of Object.entries(manifest.games)) {
    sanitizeFilePart(id);
    if (!game || typeof game !== 'object' || (game as DeviceGame).id !== id || (game as DeviceGame).romHash !== id) {
      throw new DeviceLibraryError('The linked folder manifest contains an invalid game entry.');
    }
    const artwork = (game as DeviceGame).artwork;
    if (
      artwork &&
      (!isArtworkMimeType(artwork.mimeType) ||
        !Number.isSafeInteger(artwork.byteLength) ||
        artwork.byteLength < 1 ||
        artwork.byteLength > MAX_ARTWORK_BYTES ||
        typeof artwork.fileName !== 'string' ||
        (artwork.source !== 'user' && artwork.source !== 'zip'))
    ) {
      throw new DeviceLibraryError('The linked folder manifest contains invalid artwork metadata.');
    }
    if (Boolean(artwork) !== Boolean((game as DeviceGame).artworkFile)) {
      throw new DeviceLibraryError('The linked folder manifest contains an incomplete artwork reference.');
    }
  }
  return manifest as DeviceManifest;
}

function errorMessage(error: unknown, action: string): string {
  if (error instanceof DeviceLibraryError) return error.message;
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return `Folder permission was denied while ${action}.`;
    if (error.name === 'NotFoundError') return `The linked folder or one of its files is no longer available while ${action}.`;
    if (error.name === 'QuotaExceededError') return `The linked folder has no space available while ${action}.`;
  }
  return `The linked folder could not be accessed while ${action}: ${error instanceof Error ? error.message : 'unknown error'}`;
}

function nextGeneration(): string {
  // Generation names are immutable. A failed data write can therefore only
  // leave an unreferenced file, never corrupt the manifest's prior generation.
  return `${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '')}`;
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.every((value, index) => value === b[index]);
}

function referencedFiles(entry: DeviceGame): string[] {
  return [
    entry.romFile,
    ...(entry.batteryFile ? [entry.batteryFile] : []),
    ...(entry.artworkFile ? [entry.artworkFile] : []),
    ...Object.values(entry.stateFiles ?? {}).map((state) => state.file),
  ];
}

// Play counters are monotonic observations, not events: taking the maximum
// prevents a stale folder manifest from decreasing history or double-counting
// time when two recovery copies describe the same session.
export function reconcileGameMetadata(browser: Game, linked: Game): Game {
  return plainGame({
    ...plainGame(browser),
    lastPlayedAt: Math.max(browser.lastPlayedAt, linked.lastPlayedAt),
    playTime: Math.max(browser.playTime, linked.playTime),
  });
}

let fallbackWriteQueue = Promise.resolve();

async function withWriteLock<T>(callback: () => Promise<T>): Promise<T> {
  const locks = navigator.locks;
  if (locks?.request) return locks.request('zenulator-device-library-write-v1', { mode: 'exclusive' }, callback);
  const previous = fallbackWriteQueue;
  let release!: () => void;
  fallbackWriteQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

export class DeviceLibrary {
  private handle: RootDirectory | null = null;
  private revision: number | null = null;

  supported(): boolean {
    return typeof window !== 'undefined' && typeof (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker === 'function';
  }

  async status(): Promise<DeviceFolderStatus> {
    if (!this.supported()) {
      return { kind: 'unsupported', message: 'Linked folders require Chrome or Edge on desktop. Use Import ROM and downloadable backups in this browser.' };
    }
    if (!this.handle) this.handle = await db.getSetting<RootDirectory>(HANDLE_SETTING);
    if (!this.handle) return { kind: 'unlinked', message: 'Browser storage is active. No folder is linked.' };
    try {
      const permission = await this.handle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') return { kind: 'permission-needed', message: 'Reconnect the linked folder to read or save files.' };
      const manifest = await this.readManifest(false);
      this.revision = manifest.revision;
      return { kind: 'connected', message: `Linked folder connected (revision ${manifest.revision}).`, revision: manifest.revision };
    } catch (error) {
      return { kind: 'error', message: errorMessage(error, 'checking the linked folder') };
    }
  }

  async chooseFolder(): Promise<DeviceFolderStatus> {
    if (!this.supported()) return this.status();
    try {
      const picker = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
      if (!picker) throw new DeviceLibraryError('This browser cannot select folders.');
      this.handle = await picker({ mode: 'readwrite' });
      await db.putSetting(HANDLE_SETTING, this.handle);
      const manifest = await this.readManifest(true);
      this.revision = manifest.revision;
      return { kind: 'connected', message: `Linked folder connected (revision ${manifest.revision}).`, revision: manifest.revision };
    } catch (error) {
      return { kind: 'error', message: errorMessage(error, 'selecting the linked folder') };
    }
  }

  async reconnect(): Promise<DeviceFolderStatus> {
    if (!this.handle) this.handle = await db.getSetting<RootDirectory>(HANDLE_SETTING);
    if (!this.handle) return { kind: 'unlinked', message: 'No folder has been selected yet.' };
    try {
      const permission = await this.handle.requestPermission({ mode: 'readwrite' });
      if (permission !== 'granted') return { kind: 'permission-needed', message: 'Folder permission was not granted. Browser storage remains available.' };
      const manifest = await this.readManifest(false);
      this.revision = manifest.revision;
      return { kind: 'connected', message: `Linked folder reconnected (revision ${manifest.revision}).`, revision: manifest.revision };
    } catch (error) {
      return { kind: 'error', message: errorMessage(error, 'requesting folder permission') };
    }
  }

  async disconnect(): Promise<void> {
    this.handle = null;
    this.revision = null;
    await db.deleteSetting(HANDLE_SETTING);
  }

  async getConflicts(): Promise<DeviceConflictRecord[]> {
    return (await db.getSetting<DeviceConflictRecord[]>(CONFLICT_SETTING)) ?? [];
  }

  async getPending(): Promise<DeviceConflictRecord[]> {
    return (await db.getSetting<DeviceConflictRecord[]>(PENDING_SETTING)) ?? [];
  }

  async markBrowserRecoveryConflict(gameId: string, reason: string): Promise<void> {
    await this.addConflict(gameId, this.revision ?? -1, reason);
  }

  private async ensureNoUnresolvedConflict(gameId: string): Promise<void> {
    const conflict = (await this.getConflicts()).find((item) => item.gameId === gameId);
    if (conflict) {
      throw new DeviceConflictError('Linked progress differs from browser recovery. Use the explicit Copy browser library overwrite action before changing folder files.');
    }
  }

  private async addPending(gameId: string, reason: string): Promise<void> {
    const pending = (await db.getSetting<DeviceConflictRecord[]>(PENDING_SETTING)) ?? [];
    await db.putSetting(PENDING_SETTING, [...pending.filter((item) => item.gameId !== gameId), {
      gameId, revision: this.revision ?? -1, reason, detectedAt: Date.now(),
    }]);
  }

  private async addConflict(gameId: string, revision: number, reason: string): Promise<void> {
    const conflicts = await this.getConflicts();
    await db.putSetting(CONFLICT_SETTING, [...conflicts.filter((item) => item.gameId !== gameId), {
      gameId, revision, reason, detectedAt: Date.now(),
    }]);
  }

  private async clearCapturedPending(captured: DeviceConflictRecord[]): Promise<void> {
    if (!captured.length) return;
    const current = await this.getPending();
    const isCaptured = (item: DeviceConflictRecord) => captured.some((before) =>
      before.gameId === item.gameId &&
      before.revision === item.revision &&
      before.detectedAt === item.detectedAt &&
      before.reason === item.reason,
    );
    await db.putSetting(PENDING_SETTING, current.filter((item) => !isCaptured(item)));
  }

  private async clearCapturedConflicts(captured: DeviceConflictRecord[]): Promise<void> {
    if (!captured.length) return;
    const current = await this.getConflicts();
    const isCaptured = (item: DeviceConflictRecord) => captured.some((before) =>
      before.gameId === item.gameId &&
      before.revision === item.revision &&
      before.detectedAt === item.detectedAt &&
      before.reason === item.reason,
    );
    await db.putSetting(CONFLICT_SETTING, current.filter((item) => !isCaptured(item)));
  }

  private async clearConflict(gameId: string): Promise<void> {
    const conflicts = await this.getConflicts();
    await db.putSetting(CONFLICT_SETTING, conflicts.filter((item) => item.gameId !== gameId));
  }

  async isConnected(): Promise<boolean> {
    return (await this.status()).kind === 'connected';
  }

  private async hasLinkedFolderForWrite(): Promise<boolean> {
    if (!this.handle) this.handle = await db.getSetting<RootDirectory>(HANDLE_SETTING);
    if (!this.handle) return false;
    // Do not call status() here: it refreshes the revision and would hide a
    // conflicting write made by another tab between two local operations.
    await this.requireHandle(true);
    return true;
  }

  private async requireHandle(write = false): Promise<RootDirectory> {
    if (!this.handle) this.handle = await db.getSetting<RootDirectory>(HANDLE_SETTING);
    if (!this.handle) throw new DeviceLibraryError('No linked folder is selected.');
    const permission: Permission = await this.handle.queryPermission({ mode: write ? 'readwrite' : 'read' });
    if (permission !== 'granted') throw new DeviceLibraryError('Folder permission is required. Use Reconnect folder and try again.');
    return this.handle;
  }

  private async directory(create: boolean): Promise<Directory> {
    return (await this.requireHandle(create)).getDirectoryHandle(ROOT_DIRECTORY, { create });
  }

  private async readTextFile(directory: Directory, name: string): Promise<string | null> {
    try {
      return await (await directory.getFileHandle(name)).getFile().then((file) => file.text());
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  }

  private async readManifest(create: boolean): Promise<DeviceManifest> {
    const directory = await this.directory(create);
    const text = await this.readTextFile(directory, MANIFEST_FILE);
    if (text === null) {
      if (!create) throw new DeviceLibraryError('The selected folder is not a Zenulator library yet. Choose “Copy browser library” to initialize it.');
      const manifest = manifestTemplate();
      await this.writeFile(directory, MANIFEST_FILE, JSON.stringify(manifest));
      return manifest;
    }
    try {
      return parseManifest(JSON.parse(text));
    } catch (error) {
      if (error instanceof DeviceLibraryError) throw error;
      throw new DeviceLibraryError('The linked folder manifest is malformed.');
    }
  }

  private async writeFile(directory: Directory, name: string, contents: string | ArrayBuffer, removeOnFailure = false): Promise<void> {
    const handle = await directory.getFileHandle(name, { create: true });
    let writable: FileSystemWritableFileStream | null = null;
    try {
      writable = await handle.createWritable();
      await writable.write(contents);
      await writable.close();
    } catch (error) {
      if (writable) {
        try { await writable.abort(); } catch { /* closing failure is secondary */ }
      }
      if (removeOnFailure) {
        try { await directory.removeEntry(name); } catch { /* original disk error is more useful */ }
      }
      throw error;
    }
  }

  private async removeGeneratedFiles(directory: Directory, paths: string[]): Promise<void> {
    for (const path of paths) {
      // Only names generated by this app's immutable naming scheme are ever
      // removed. Arbitrary user files and legacy stable filenames are ignored.
      const match = /^(roms|saves|states|artwork)\/[a-f0-9]{64}(?:-[0-9]+)?-[a-z0-9-]+\.([a-z]+)$/.exec(path);
      if (!match) continue;
      try {
        await (await directory.getDirectoryHandle(match[1])).removeEntry(path.slice(path.lastIndexOf('/') + 1));
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      }
    }
  }

  private async commit(mutator: (manifest: DeviceManifest, directory: Directory) => Promise<CommitMutation | void>): Promise<void> {
    await withWriteLock(async () => {
      let mutation: CommitMutation = {};
      let directory: Directory | null = null;
      let committed = false;
      try {
        directory = await this.directory(true);
        const manifest = await this.readManifest(true);
        const expectedRevision = manifest.revision;
        if (this.revision !== null && manifest.revision !== this.revision) {
          throw new DeviceConflictError('The linked folder changed in another tab. Reload or reconnect before saving so existing progress is not overwritten.');
        }
        mutation = (await mutator(manifest, directory)) ?? {};
        // Web Locks protect tabs on this origin. A second origin/profile cannot
        // share that lock; this recheck detects a manifest it committed while
        // our immutable generation files were being written.
        if ((await this.readManifest(true)).revision !== expectedRevision) {
          throw new DeviceConflictError('The linked folder changed in another browser origin or profile. Its files were left intact; reconnect before saving.');
        }
        manifest.revision += 1;
        manifest.updatedAt = Date.now();
        await this.writeFile(directory, MANIFEST_FILE, JSON.stringify(manifest));
        this.revision = manifest.revision;
        committed = true;
        // Cleanup runs only after the new manifest is durable. The active
        // generation and exactly one prior manifest generation remain.
        await this.removeGeneratedFiles(directory, mutation.cleanup ?? []);
      } catch (error) {
        if (!committed && directory) {
          try { await this.removeGeneratedFiles(directory, mutation.created ?? []); } catch { /* retain original write error */ }
        }
        throw new DeviceLibraryError(errorMessage(error, 'writing the linked folder'));
      }
    });
  }

  async importBrowserLibrary(overwrite = false, onProgress?: (completed: number, total: number) => void): Promise<void> {
    const games = await db.getGames();
    // Only clear failures observed before this explicit successful full copy.
    // A write failure reported by another tab while copying must remain visible.
    const capturedPending = await this.getPending();
    const capturedConflicts = await this.getConflicts();
    await this.commit(async (manifest, directory) => {
      const conflicts = games.filter((game) => manifest.games[game.id]);
      if (conflicts.length && !overwrite) {
        throw new DeviceConflictError(`${conflicts.length} game(s) already exist in the linked folder. Confirm overwrite to copy them.`);
      }
      let completed = 0;
      const created: string[] = [];
      const cleanup: string[] = [];
      for (const game of games) {
        const rom = await db.getRom(game.id);
        if (!rom || rom.data.byteLength > MAX_ROM_BYTES) throw new DeviceLibraryError(`Browser ROM data for ${game.name} is missing or invalid.`);
        const save = await db.getSave(game.id);
        const states = await db.getStatesForGame(game.id);
        const files = await this.writeGameFiles(directory, manifest, game, rom.data, save?.data ?? null, states);
        created.push(...(files.created ?? []));
        cleanup.push(...(files.cleanup ?? []));
        completed += 1;
        onProgress?.(completed, games.length);
      }
      return { created, cleanup };
    });
    await this.clearCapturedPending(capturedPending);
    await this.clearCapturedConflicts(capturedConflicts);
  }

  private async writeGameFiles(directory: Directory, manifest: DeviceManifest, game: Game, rom: ArrayBuffer, save: string | null, states: SaveState[]): Promise<CommitMutation> {
    const id = sanitizeFilePart(game.romHash);
    if (rom.byteLength < 192 || rom.byteLength > MAX_ROM_BYTES) throw new DeviceLibraryError('The ROM is not a valid GBA file (192 bytes to 64 MB).');
    if (save !== null) validateBatterySave(save);
    for (const state of states) {
      if (state.data.byteLength > MAX_STATE_BYTES || state.slot < 1 || state.slot > 10) throw new DeviceLibraryError('A save state in browser storage is invalid.');
      validateSaveState(new TextDecoder().decode(state.data));
    }
    const generation = nextGeneration();
    const romFile = `roms/${id}-${generation}.gba`;
    const created = [romFile];
    const previous = manifest.games[id];
    try {
    const roms = await directory.getDirectoryHandle('roms', { create: true });
    await this.writeFile(roms, `${id}-${generation}.gba`, rom, true);
    const entry: DeviceGame = {
      ...plainGame({ ...game, id, romHash: id }),
      romFile,
      // An explicit browser-library copy can be made after a browser-only
      // deletion or partial recovery. Keep linked progress not represented by
      // this browser snapshot rather than silently deleting its references.
      stateFiles: previous?.stateFiles ? { ...previous.stateFiles } : {},
    };
    let cleanup = previous?.previousFiles ?? [];
    if (previous) entry.previousFiles = referencedFiles(previous);
    if (save !== null) {
      if (save.length > MAX_SAVE_CHARS) throw new DeviceLibraryError('The battery save is too large to store in the linked folder.');
      const saves = await directory.getDirectoryHandle('saves', { create: true });
      entry.batteryFile = `saves/${id}-${generation}.json`;
      created.push(entry.batteryFile);
      await this.writeFile(saves, `${id}-${generation}.json`, save, true);
    } else if (previous?.batteryFile) {
      entry.batteryFile = previous.batteryFile;
    }
    const artwork = await db.getArtwork(id);
    if (game.artwork && !artwork) {
      throw new DeviceLibraryError('The browser artwork metadata exists, but its image data is missing.');
    }
    if (artwork) {
      if (artwork.id !== id || artwork.data.byteLength > MAX_ARTWORK_BYTES) throw new DeviceLibraryError('The browser artwork is missing or too large.');
      const inspected = inspectArtworkBytes(artwork.data, artwork.mimeType);
      const artworkDirectory = await directory.getDirectoryHandle('artwork', { create: true });
      const extension = artwork.mimeType === 'image/jpeg' ? 'jpg' : artwork.mimeType.slice('image/'.length);
      const file = `artwork/${id}-${generation}.${extension}`;
      created.push(file);
      await this.writeFile(artworkDirectory, `${id}-${generation}.${extension}`, artwork.data, true);
      entry.artwork = {
        ...artworkReference({ ...artwork, width: inspected.width, height: inspected.height }),
      };
      entry.artworkFile = file;
    } else if (previous?.artworkFile) {
      // A ROM re-import must not silently remove an image which was already
      // committed to the linked folder. Removing artwork is an explicit UI
      // action through mirrorArtwork.
      entry.artwork = previous.artwork;
      entry.artworkFile = previous.artworkFile;
    }
    if (states.length) {
      const statesDirectory = await directory.getDirectoryHandle('states', { create: true });
      for (const state of states) {
        const file = `states/${id}-${state.slot}-${generation}.json`;
        created.push(file);
        await this.writeFile(statesDirectory, `${id}-${state.slot}-${generation}.json`, state.data, true);
        entry.stateFiles[String(state.slot)] = { file, timestamp: state.timestamp };
      }
    }
    manifest.games[id] = entry;
    cleanup = cleanup.filter((path) => !referencedFiles(entry).includes(path));
    return { created, cleanup };
    } catch (error) {
      await this.removeGeneratedFiles(directory, created);
      throw error;
    }
  }

  async mirrorGame(game: Game, rom?: ArrayBuffer): Promise<void> {
    try {
      if (!(await this.hasLinkedFolderForWrite())) return;
      if (rom) await this.ensureNoUnresolvedConflict(game.id);
      await this.commit(async (manifest, directory) => {
      const existing = manifest.games[game.id];
      if (rom) {
        const save = await db.getSave(game.id);
        const states = await db.getStatesForGame(game.id);
        return this.writeGameFiles(directory, manifest, game, rom, save?.data ?? null, states);
      } else if (existing) {
        const history = reconcileGameMetadata(game, existing);
        // Metadata writes cannot alter the currently committed save references.
        manifest.games[game.id] = {
          ...plainGame({ ...history, name: existing.name, fileName: existing.fileName }),
          romFile: existing.romFile,
          batteryFile: existing.batteryFile,
          artwork: existing.artwork,
          artworkFile: existing.artworkFile,
          stateFiles: existing.stateFiles ?? {},
          ...(existing.previousFiles ? { previousFiles: existing.previousFiles } : {}),
        };
        return {};
      } else {
        throw new DeviceLibraryError('This game has not been copied to the linked folder. Copy the browser library first.');
      }
      });
    } catch (error) { await this.addPending(game.id, errorMessage(error, 'saving')); throw error; }
  }

  async mirrorSave(gameId: string, data: string | null): Promise<void> {
    try {
      if (!(await this.hasLinkedFolderForWrite())) return;
      await this.ensureNoUnresolvedConflict(gameId);
      await this.commit(async (manifest, directory) => {
      const entry = manifest.games[gameId];
      if (!entry) throw new DeviceLibraryError('This game is not present in the linked folder.');
      let cleanup = entry.previousFiles ?? [];
      entry.previousFiles = referencedFiles(entry);
      const created: string[] = [];
      if (data === null) {
        // Intentionally retain the old file: deleting physical progress requires
        // separate, explicit user consent.
        delete entry.batteryFile;
      } else {
        if (data.length > MAX_SAVE_CHARS) throw new DeviceLibraryError('The battery save is too large to store in the linked folder.');
        const saves = await directory.getDirectoryHandle('saves', { create: true });
        const generation = nextGeneration();
        const file = `saves/${gameId}-${generation}.json`;
        created.push(file);
        await this.writeFile(saves, `${gameId}-${generation}.json`, data, true);
        entry.batteryFile = file;
      }
      cleanup = cleanup.filter((path) => !referencedFiles(entry).includes(path));
      return { created, cleanup };
      });
    } catch (error) { await this.addPending(gameId, errorMessage(error, 'saving')); throw error; }
  }

  async mirrorArtwork(gameId: string, artwork: GameArtwork | null): Promise<void> {
    try {
      if (!(await this.hasLinkedFolderForWrite())) return;
      await this.ensureNoUnresolvedConflict(gameId);
      if (artwork) {
        if (artwork.id !== gameId || artwork.data.byteLength > MAX_ARTWORK_BYTES) {
          throw new DeviceLibraryError('The artwork is missing or too large.');
        }
        inspectArtworkBytes(artwork.data, artwork.mimeType);
      }
      await this.commit(async (manifest, directory) => {
        const entry = manifest.games[gameId];
        if (!entry) throw new DeviceLibraryError('This game is not present in the linked folder.');
        let cleanup = entry.previousFiles ?? [];
        entry.previousFiles = referencedFiles(entry);
        const created: string[] = [];
        if (!artwork) {
          delete entry.artwork;
          delete entry.artworkFile;
        } else {
          const generation = nextGeneration();
          const extension = artwork.mimeType === 'image/jpeg' ? 'jpg' : artwork.mimeType.slice('image/'.length);
          const artworkDirectory = await directory.getDirectoryHandle('artwork', { create: true });
          const file = `artwork/${gameId}-${generation}.${extension}`;
          created.push(file);
          await this.writeFile(artworkDirectory, `${gameId}-${generation}.${extension}`, artwork.data, true);
          entry.artwork = artworkReference(artwork);
          entry.artworkFile = file;
        }
        cleanup = cleanup.filter((path) => !referencedFiles(entry).includes(path));
        return { created, cleanup };
      });
    } catch (error) {
      await this.addPending(gameId, errorMessage(error, 'saving artwork'));
      throw error;
    }
  }

  async renameGame(gameId: string, name: string): Promise<void> {
    try {
      if (!(await this.hasLinkedFolderForWrite())) return;
      await this.ensureNoUnresolvedConflict(gameId);
      await this.commit(async (manifest) => {
        const existing = manifest.games[gameId];
        if (existing) manifest.games[gameId] = { ...existing, name };
        return {};
      });
    } catch (error) {
      await this.addPending(gameId, errorMessage(error, 'renaming'));
      throw error;
    }
  }

  async mirrorState(state: SaveState): Promise<void> {
    try {
      if (!(await this.hasLinkedFolderForWrite())) return;
      await this.ensureNoUnresolvedConflict(state.gameId);
      await this.commit(async (manifest, directory) => {
      const entry = manifest.games[state.gameId];
      if (!entry) throw new DeviceLibraryError('This game is not present in the linked folder.');
      let cleanup = entry.previousFiles ?? [];
      entry.previousFiles = referencedFiles(entry);
      if (state.data.byteLength > MAX_STATE_BYTES) throw new DeviceLibraryError('The save state is too large to store in the linked folder.');
      const states = await directory.getDirectoryHandle('states', { create: true });
      const generation = nextGeneration();
      const file = `states/${state.gameId}-${state.slot}-${generation}.json`;
      await this.writeFile(states, `${state.gameId}-${state.slot}-${generation}.json`, state.data, true);
      entry.stateFiles = entry.stateFiles ?? {};
      entry.stateFiles[String(state.slot)] = { file, timestamp: state.timestamp };
      cleanup = cleanup.filter((path) => !referencedFiles(entry).includes(path));
      return { created: [file], cleanup };
      });
    } catch (error) { await this.addPending(state.gameId, errorMessage(error, 'saving')); throw error; }
  }

  async mirrorBackup(gameId: string, batterySave: string | null, states: SaveState[]): Promise<void> {
    try {
      if (!(await this.hasLinkedFolderForWrite())) return;
      await this.ensureNoUnresolvedConflict(gameId);
      if (batterySave !== null) validateBatterySave(batterySave);
      for (const state of states) validateSaveState(new TextDecoder().decode(state.data));
      await this.commit(async (manifest, directory) => {
      const entry = manifest.games[gameId];
      if (!entry) throw new DeviceLibraryError('This game is not present in the linked folder.');
      let cleanup = entry.previousFiles ?? [];
      entry.previousFiles = referencedFiles(entry);
      entry.stateFiles = {};
      const created: string[] = [];
      try {
      const generation = nextGeneration();
      if (batterySave === null) {
        delete entry.batteryFile;
      } else {
        validateBatterySave(batterySave);
        const saves = await directory.getDirectoryHandle('saves', { create: true });
        const file = `saves/${gameId}-${generation}.json`;
        created.push(file);
        await this.writeFile(saves, `${gameId}-${generation}.json`, batterySave, true);
        entry.batteryFile = file;
      }
      const statesDirectory = await directory.getDirectoryHandle('states', { create: true });
      for (const state of states) {
        validateSaveState(new TextDecoder().decode(state.data));
        const file = `states/${gameId}-${state.slot}-${generation}.json`;
        created.push(file);
        await this.writeFile(statesDirectory, `${gameId}-${state.slot}-${generation}.json`, state.data, true);
        entry.stateFiles[String(state.slot)] = { file, timestamp: state.timestamp };
      }
      cleanup = cleanup.filter((path) => !referencedFiles(entry).includes(path));
      return { created, cleanup };
      } catch (error) {
        await this.removeGeneratedFiles(directory, created);
        throw error;
      }
      });
    } catch (error) { await this.addPending(gameId, errorMessage(error, 'restoring backup')); throw error; }
  }

  private async readRelativeFile(root: Directory, path: string): Promise<ArrayBuffer | null> {
    const match = /^(roms|saves|states|artwork)\/([a-z0-9-]+\.)(gba|json|png|jpg|jpeg|webp|gif)$/.exec(path);
    if (!match) throw new DeviceLibraryError('The linked folder manifest contains an unsafe file path.');
    try {
      const directory = await root.getDirectoryHandle(match[1]);
      return (await directory.getFileHandle(`${match[2]}${match[3]}`)).getFile().then((file) => file.arrayBuffer());
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  }

  private async readArtworkEntry(root: Directory, gameId: string, entry: DeviceGame): Promise<GameArtwork | null> {
    if (!entry.artworkFile) return null;
    const artworkBytes = await this.readRelativeFile(root, entry.artworkFile);
    if (!artworkBytes) throw new DeviceLibraryError('The linked artwork referenced by the manifest is missing.');
    if (artworkBytes.byteLength > MAX_ARTWORK_BYTES || !entry.artwork || !isArtworkMimeType(entry.artwork.mimeType)) {
      throw new DeviceLibraryError('The linked artwork is malformed or too large.');
    }
    const inspected = await validateArtworkBytes(artworkBytes, entry.artwork.mimeType);
    return {
      id: gameId,
      data: artworkBytes,
      mimeType: inspected.mimeType,
      byteLength: artworkBytes.byteLength,
      fileName: entry.artwork.fileName,
      source: entry.artwork.source,
      width: inspected.width,
      height: inspected.height,
    };
  }

  async getLinkedArtwork(gameId: string): Promise<GameArtwork | null> {
    if (!this.handle) this.handle = await db.getSetting<RootDirectory>(HANDLE_SETTING);
    if (!this.handle) return null;
    try {
      const root = await this.directory(false);
      const manifest = await this.readManifest(false);
      this.revision = manifest.revision;
      const entry = manifest.games[gameId];
      return entry ? await this.readArtworkEntry(root, gameId, entry) : null;
    } catch (error) {
      // A selected folder which has not been initialized is equivalent to
      // having no linked artwork yet. Permission and corruption failures are
      // real folder errors and remain visible to the caller.
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      if (error instanceof DeviceLibraryError && /not a Zenulator library yet/i.test(error.message)) return null;
      throw new DeviceLibraryError(errorMessage(error, 'reading linked artwork'));
    }
  }

  async readForPlay(gameId: string): Promise<{ game: Game; rom: ArrayBuffer; save: string | null; states: SaveState[]; artwork: GameArtwork | null } | null> {
    if (!this.handle) this.handle = await db.getSetting<RootDirectory>(HANDLE_SETTING);
    if (!this.handle) return null;
    try {
      await this.requireHandle(false);
      const root = await this.directory(false);
      const manifest = await this.readManifest(false);
      this.revision = manifest.revision;
      const entry = manifest.games[gameId];
      if (!entry) return null;
      const rom = await this.readRelativeFile(root, entry.romFile);
      if (!rom || rom.byteLength < 192 || rom.byteLength > MAX_ROM_BYTES) throw new DeviceLibraryError('The linked ROM is missing or invalid.');
      if (await sha256Hex(rom) !== entry.romHash) throw new DeviceLibraryError('The linked ROM no longer matches its SHA-256 identity.');
      const saveBytes = entry.batteryFile ? await this.readRelativeFile(root, entry.batteryFile) : null;
      if (entry.batteryFile && saveBytes === null) {
        throw new DeviceLibraryError('The linked battery save referenced by the manifest is missing.');
      }
      const save = saveBytes === null ? null : new TextDecoder().decode(saveBytes);
      if (save !== null && save.length > MAX_SAVE_CHARS) throw new DeviceLibraryError('The linked battery save is malformed or too large.');
      if (save !== null) validateBatterySave(save);
      const states: SaveState[] = [];
      for (const [slotText, info] of Object.entries(entry.stateFiles ?? {})) {
        const slot = Number(slotText);
        const data = await this.readRelativeFile(root, info.file);
        if (!Number.isInteger(slot) || slot < 1 || slot > 10 || !data || data.byteLength > MAX_STATE_BYTES) {
          throw new DeviceLibraryError('A linked save state is missing or malformed.');
        }
        validateSaveState(new TextDecoder().decode(data));
        states.push({ id: `${gameId}_${slot}`, gameId, slot, timestamp: info.timestamp, data });
      }
      const artwork = await this.readArtworkEntry(root, gameId, entry);
      return { game: entry, rom, save, states, artwork };
    } catch (error) {
      throw new DeviceLibraryError(errorMessage(error, 'reading saved progress from the linked folder'));
    }
  }

  async scanIntoBrowser(): Promise<number> {
    if (!(await this.isConnected())) return 0;
    const manifest = await this.readManifest(false);
    let imported = 0;
    for (const entry of Object.values(manifest.games)) {
      const existing = await db.getGame(entry.id);
      const disk = await this.readForPlay(entry.id);
      if (!disk) continue;
      const existingRom = existing ? await db.getRom(entry.id) : null;
      const existingSave = existing ? await db.getSave(entry.id) : null;
      const existingStates = existing ? await db.getStatesForGame(entry.id) : [];
      const existingArtwork = existing ? await db.getArtwork(entry.id) : null;
      // Never replace an existing browser recovery copy during an automatic
      // scan. A failed folder write may mean it contains newer unsynced data.
      if (existing || existingRom || existingSave || existingStates.length) {
        const sameSave = (existingSave?.data ?? null) === disk.save;
        const sameStates = existingStates.length === disk.states.length && existingStates.every((state) => {
          const linkedState = disk.states.find((candidate) => candidate.slot === state.slot);
          return linkedState !== undefined && sameBytes(state.data, linkedState.data);
        });
        const sameArtwork = (existingArtwork === null && disk.artwork === null) ||
          (existingArtwork !== null && disk.artwork !== null && sameBytes(existingArtwork.data, disk.artwork.data));
        if (!existingRom || !sameSave || !sameStates || !sameArtwork) {
          await this.addConflict(entry.id, manifest.revision, 'Both the browser recovery copy and linked folder contain different progress. Choose which copy to use.');
        } else {
          await this.clearConflict(entry.id);
          const reconciled = reconcileGameMetadata(existing!, entry);
          if (reconciled.lastPlayedAt !== existing!.lastPlayedAt || reconciled.playTime !== existing!.playTime) {
            await db.putGame(reconciled);
          }
        }
        continue;
      }
      await db.putGame(entry, disk.rom);
      if (disk.save !== null) await db.putSave({ id: entry.id, data: disk.save });
      if (disk.artwork) await db.putArtwork(disk.artwork);
      for (const state of disk.states) await db.putState(state);
      imported += 1;
    }
    return imported;
  }

  async replaceBrowserRecoveryFromDevice(gameId: string): Promise<void> {
    const disk = await this.readForPlay(gameId);
    if (!disk) throw new DeviceLibraryError('This game is no longer present in the linked folder.');
    // readForPlay validates ROM identity, battery, and every state before the
    // first IndexedDB mutation below.
    const existing = await db.getGame(gameId);
    await db.putGame(existing ? reconcileGameMetadata(existing, disk.game) : disk.game, disk.rom);
    if (disk.artwork) await db.putArtwork(disk.artwork);
    else await db.deleteArtwork(gameId);
    await db.restoreBackup(gameId, disk.save, disk.states);
    const conflicts = await this.getConflicts();
    await db.putSetting(CONFLICT_SETTING, conflicts.filter((item) => item.gameId !== gameId));
  }
}

export const deviceLibrary = new DeviceLibrary();