import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

import { db } from '@/lib/db';
import { plainGame } from '@/lib/db';
import { DeviceLibrary, reconcileGameMetadata } from '@/lib/deviceLibrary';
import { SAVE_STATE_BUFFER_LENGTHS } from '@/lib/saveValidation';
import { chooseStateRecovery } from '@/lib/recoveryChoice';
import { automaticArtworkCandidate, scanWithoutHidingBrowserRecovery } from '@/hooks/useLibrary';
import { artworkReference, type ArtworkCandidate } from '@/lib/artwork';

class MemoryFile {
  data: Uint8Array = new Uint8Array();
  failWrites = false;

  async getFile() {
    const bytes = this.data.slice();
    return {
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer,
    };
  }

  async createWritable() {
    if (this.failWrites) throw new DOMException('disk is read-only', 'NotAllowedError');
    let next: Uint8Array | null = null;
    return {
      write: async (value: string | ArrayBuffer) => {
        next = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value.slice(0));
      },
      close: async () => { if (next) this.data = next; },
      abort: async () => undefined,
    };
  }
}

class MemoryDirectory {
  children = new Map<string, MemoryDirectory | MemoryFile>();
  permission: 'granted' | 'denied' | 'prompt' = 'granted';
  failNewWrites = false;

  async queryPermission() { return this.permission; }
  async requestPermission() { return this.permission; }

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing instanceof MemoryDirectory) return existing;
    if (existing || !options?.create) throw new DOMException('not found', 'NotFoundError');
    const directory = new MemoryDirectory();
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing instanceof MemoryFile) return existing;
    if (existing || !options?.create) throw new DOMException('not found', 'NotFoundError');
    const file = new MemoryFile();
    file.failWrites = this.failNewWrites;
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string) {
    if (!this.children.delete(name)) throw new DOMException('not found', 'NotFoundError');
  }
}

const settings = new Map<string, unknown>();
const root = new MemoryDirectory();
const game = {
  id: 'a'.repeat(64), romHash: 'a'.repeat(64), name: 'Test game', fileName: 'test.gba',
  size: 192, addedAt: 1, lastPlayedAt: 0, playTime: 0,
};

async function gameFor(buffer: ArrayBuffer) {
  const hash = Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', buffer)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { ...game, id: hash, romHash: hash, size: buffer.byteLength };
}

function validStatePayload() {
  return JSON.stringify({
    r: Array(16).fill(0), cpsr: 0, scanline: 0, scanlineCycles: 0,
    ...Object.fromEntries(Object.entries(SAVE_STATE_BUFFER_LENGTHS).map(([name, length]) => [name, Buffer.alloc(length).toString('base64')])),
  });
}

function installBrowserMocks() {
  settings.clear();
  root.children.clear();
  root.permission = 'granted';
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { showDirectoryPicker: async () => root } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    locks: { request: async (_name: string, _options: unknown, callback: () => unknown) => callback() },
  } });
  (db as unknown as Record<string, unknown>).getSetting = async (key: string) => settings.get(key) ?? null;
  (db as unknown as Record<string, unknown>).putSetting = async (key: string, value: unknown) => { settings.set(key, value); };
  (db as unknown as Record<string, unknown>).deleteSetting = async (key: string) => { settings.delete(key); };
  (db as unknown as Record<string, unknown>).getSave = async () => null;
  (db as unknown as Record<string, unknown>).getArtwork = async () => null;
  (db as unknown as Record<string, unknown>).getStatesForGame = async () => [];
  (db as unknown as Record<string, unknown>).getGames = async () => [];
}

test('persists the selected handle, commits a manifest, and round-trips a 64 MB ROM', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  assert.equal((await library.chooseFolder()).kind, 'connected');
  const rom = new ArrayBuffer(64 * 1024 * 1024);
  const hashedGame = await gameFor(rom);
  await library.mirrorGame(hashedGame, rom);
  const loaded = await library.readForPlay(hashedGame.id);
  assert.equal(loaded?.rom.byteLength, rom.byteLength);
  assert.equal(loaded?.game.romHash, hashedGame.romHash);
  assert.ok(settings.get('linked-device-folder-v1'));
});

test('requires permission and refuses a stale manifest revision instead of overwriting it', async () => {
  installBrowserMocks();
  root.permission = 'denied';
  const denied = new DeviceLibrary();
  await denied.chooseFolder();
  await assert.rejects(() => denied.readForPlay(game.id), /permission/i);

  root.permission = 'granted';
  const first = new DeviceLibrary();
  await first.chooseFolder();
  const zen = root.children.get('.zenulator') as MemoryDirectory;
  const manifest = JSON.parse(await (await (zen.children.get('manifest.json') as MemoryFile).getFile()).text());
  manifest.revision += 1; // Simulates a committed write by another tab.
  const manifestFile = zen.children.get('manifest.json') as MemoryFile;
  manifestFile.data = new TextEncoder().encode(JSON.stringify(manifest));
  await assert.rejects(() => first.mirrorGame({ ...game, name: 'renamed' }), /another tab/i);
});

test('explicit linked-folder rename changes only the title and survives reopening', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  await library.chooseFolder();
  const rom = new ArrayBuffer(192);
  const hashedGame = await gameFor(rom);
  await library.mirrorGame(hashedGame, rom);
  const zen = root.children.get('.zenulator') as MemoryDirectory;
  const file = zen.children.get('manifest.json') as MemoryFile;
  const before = JSON.parse(await (await file.getFile()).text());
  await library.renameGame(hashedGame.id, 'Custom title');
  const after = JSON.parse(await (await file.getFile()).text());
  assert.deepEqual(after.games[hashedGame.id], { ...before.games[hashedGame.id], name: 'Custom title' });
  const reopened = new DeviceLibrary();
  assert.equal((await reopened.readForPlay(hashedGame.id))?.game.name, 'Custom title');
});

test('a failed immutable-generation write leaves the prior manifest generation readable', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  await library.chooseFolder();
  const rom = new ArrayBuffer(192);
  const hashedGame = await gameFor(rom);
  await library.mirrorGame(hashedGame, rom);
  const zen = root.children.get('.zenulator') as MemoryDirectory;
  const manifestFile = zen.children.get('manifest.json') as MemoryFile;
  const previousManifest = await (await manifestFile.getFile()).text();
  const roms = await zen.getDirectoryHandle('roms', { create: true });
  roms.failNewWrites = true;
  await assert.rejects(() => library.mirrorGame(hashedGame, rom), /denied|could not be accessed|writing/i);
  assert.equal(await (await manifestFile.getFile()).text(), previousManifest);
  assert.equal(roms.children.size, 1, 'failed immutable generation was cleaned without touching the active file');
  assert.equal((await library.getPending()).length, 1);
  const afterReload = new DeviceLibrary();
  assert.equal((await afterReload.readForPlay(hashedGame.id))?.rom.byteLength, 192);
});

test('malformed linked data never replaces an existing browser recovery copy during scan', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  await library.chooseFolder();
  const rom = new ArrayBuffer(192);
  const hashedGame = await gameFor(rom);
  await library.mirrorGame(hashedGame, rom);
  const zen = root.children.get('.zenulator') as MemoryDirectory;
  const manifestFile = zen.children.get('manifest.json') as MemoryFile;
  const manifest = JSON.parse(await (await manifestFile.getFile()).text());
  const states = await zen.getDirectoryHandle('states', { create: true });
  await (await states.getFileHandle(`${hashedGame.id}-1-bad.json`, { create: true })).createWritable()
    .then(async (writer) => { await writer.write('not JSON'); await writer.close(); });
  manifest.games[hashedGame.id].stateFiles = { '1': { file: `states/${hashedGame.id}-1-bad.json`, timestamp: 1 } };
  manifestFile.data = new TextEncoder().encode(JSON.stringify(manifest));
  let writes = 0;
  (db as unknown as Record<string, unknown>).getGame = async () => hashedGame;
  (db as unknown as Record<string, unknown>).getRom = async () => ({ id: hashedGame.id, data: rom });
  (db as unknown as Record<string, unknown>).putGame = async () => { writes += 1; };
  await assert.rejects(() => library.scanIntoBrowser(), /invalid save state/i);
  assert.equal(writes, 0);
});

test('backup writes all generations then commits its manifest once', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  await library.chooseFolder();
  const rom = new ArrayBuffer(192);
  const hashedGame = await gameFor(rom);
  await library.mirrorGame(hashedGame, rom);
  const zen = root.children.get('.zenulator') as MemoryDirectory;
  const manifestFile = zen.children.get('manifest.json') as MemoryFile;
  const previousState = validStatePayload();
  await library.mirrorState({
    id: `${hashedGame.id}_1`, gameId: hashedGame.id, slot: 1, timestamp: 1, data: new TextEncoder().encode(previousState).buffer,
  });
  let commits = 0;
  const originalWritable = manifestFile.createWritable.bind(manifestFile);
  manifestFile.createWritable = async () => {
    const writable = await originalWritable();
    return { ...writable, close: async () => { commits += 1; await writable.close(); } };
  };
  const state = validStatePayload();
  await library.mirrorBackup(hashedGame.id, JSON.stringify({ v: 1, saveType: 'sram', len: 0, checksum: 0, data: '' }), [{
    id: `${hashedGame.id}_1`, gameId: hashedGame.id, slot: 1, timestamp: 1, data: new TextEncoder().encode(state).buffer,
  }]);
  assert.equal(commits, 1);
  const manifest = JSON.parse(await (await manifestFile.getFile()).text());
  assert.deepEqual(Object.keys(manifest.games[hashedGame.id].stateFiles), ['1']);
});

test('generated cleanup keeps active and one prior generation without touching active files', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  await library.chooseFolder();
  const rom = new ArrayBuffer(192);
  const hashedGame = await gameFor(rom);
  await library.mirrorGame(hashedGame, rom);
  const save = (marker: string) => JSON.stringify({ v: 1, saveType: 'sram', len: 1, checksum: marker.charCodeAt(0), data: Buffer.from(marker).toString('base64') });
  await library.mirrorSave(hashedGame.id, save('a'));
  await library.mirrorSave(hashedGame.id, save('b'));
  await library.mirrorSave(hashedGame.id, save('c'));
  const zen = root.children.get('.zenulator') as MemoryDirectory;
  const manifest = JSON.parse(await (await (zen.children.get('manifest.json') as MemoryFile).getFile()).text());
  const active = manifest.games[hashedGame.id].batteryFile.split('/')[1];
  const saves = await zen.getDirectoryHandle('saves');
  assert.ok(saves.children.has(active));
  assert.ok(saves.children.size <= 2, 'current plus one prior generated save is retained');
});

test('successful explicit overwrite clears captured pending writes but retains newer pending records', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  await library.chooseFolder();
  const rom = new ArrayBuffer(192);
  const hashedGame = await gameFor(rom);
  await library.mirrorGame(hashedGame, rom);
  const zen = root.children.get('.zenulator') as MemoryDirectory;
  const roms = await zen.getDirectoryHandle('roms');
  roms.failNewWrites = true;
  await assert.rejects(() => library.mirrorGame(hashedGame, rom));
  const captured = await library.getPending();
  assert.equal(captured.length, 1);
  roms.failNewWrites = false;
  (db as unknown as Record<string, unknown>).getGames = async () => [hashedGame];
  (db as unknown as Record<string, unknown>).getRom = async () => ({ id: hashedGame.id, data: rom });
  await library.importBrowserLibrary(true, () => {
    settings.set('linked-device-folder-pending-v1', [{
      gameId: hashedGame.id, revision: 99, reason: 'A newer tab failed after copy began.', detectedAt: 99,
    }]);
  });
  assert.deepEqual(await library.getPending(), [{
    gameId: hashedGame.id, revision: 99, reason: 'A newer tab failed after copy began.', detectedAt: 99,
  }]);
});

test('browser-only deletion has no device-library deletion API or manifest side effect', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  await library.chooseFolder();
  const rom = new ArrayBuffer(192);
  const hashedGame = await gameFor(rom);
  await library.mirrorGame(hashedGame, rom);
  const zen = root.children.get('.zenulator') as MemoryDirectory;
  const manifestFile = zen.children.get('manifest.json') as MemoryFile;
  const before = await (await manifestFile.getFile()).text();
  assert.equal(typeof (library as unknown as { forgetGame?: unknown }).forgetGame, 'undefined');
  assert.equal(await (await manifestFile.getFile()).text(), before);
});

test('ROM re-import after browser-only deletion preserves linked progress', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  await library.chooseFolder();
  const rom = new ArrayBuffer(192);
  const hashedGame = await gameFor(rom);
  const save = JSON.stringify({ v: 1, saveType: 'sram', len: 1, checksum: 65, data: 'QQ==' });
  const state = {
    id: `${hashedGame.id}_1`,
    gameId: hashedGame.id,
    slot: 1,
    timestamp: 1,
    data: new TextEncoder().encode(validStatePayload()).buffer,
  };
  (db as unknown as Record<string, unknown>).getSave = async () => ({ id: hashedGame.id, data: save });
  (db as unknown as Record<string, unknown>).getStatesForGame = async () => [state];
  await library.mirrorGame(hashedGame, rom);

  const zen = root.children.get('.zenulator') as MemoryDirectory;
  const manifestFile = zen.children.get('manifest.json') as MemoryFile;
  const before = JSON.parse(await (await manifestFile.getFile()).text());
  // This is the browser state after the game was deleted locally and imported
  // again: there is a ROM, but no browser recovery save/state to copy.
  (db as unknown as Record<string, unknown>).getSave = async () => null;
  (db as unknown as Record<string, unknown>).getStatesForGame = async () => [];
  await library.mirrorGame(hashedGame, rom);
  const after = JSON.parse(await (await manifestFile.getFile()).text());
  assert.equal(after.games[hashedGame.id].batteryFile, before.games[hashedGame.id].batteryFile);
  assert.deepEqual(after.games[hashedGame.id].stateFiles, before.games[hashedGame.id].stateFiles);
  const linked = await library.readForPlay(hashedGame.id);
  assert.equal(linked?.save, save);
  assert.equal(linked?.states.length, 1);
});

test('linked cover is hydrated before a one-image same-ROM ZIP can auto-apply artwork', () => {
  const linkedCover = {
    id: game.id,
    data: new Uint8Array([1, 2, 3]).buffer,
    mimeType: 'image/png' as const,
    byteLength: 3,
    fileName: 'custom-cover.png',
    source: 'user' as const,
    width: 320,
    height: 240,
  };
  // Browser-only deletion removes the game and its browser artwork, while the
  // linked folder remains authoritative. Re-import hydration restores the
  // linked reference before evaluating the ZIP's single candidate.
  const reimported = { ...game, artwork: artworkReference(linkedCover) };
  const sameRomZipCandidate: ArtworkCandidate = {
    ...linkedCover,
    id: game.id,
    path: 'art/cover.png',
    source: 'zip',
    score: 100,
  };
  assert.equal(automaticArtworkCandidate(reimported, [sameRomZipCandidate]), null);
  assert.equal(automaticArtworkCandidate(game, [sameRomZipCandidate]), sameRomZipCandidate);
});

test('explicit browser recovery loads its state even when the linked folder is denied', () => {
  const browserState = { id: 'g_1', gameId: 'g', slot: 1, timestamp: 1, data: new Uint8Array([1]).buffer };
  assert.deepEqual(
    chooseStateRecovery(browserState, null, false, true),
    { kind: 'browser', state: browserState },
  );
  assert.deepEqual(chooseStateRecovery(browserState, null, false, false), { kind: 'prompt' });
});

test('reopen scan reconciles stale failed-folder metadata monotonically when saves are identical', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  await library.chooseFolder();
  const rom = new ArrayBuffer(192);
  const hashedGame = { ...(await gameFor(rom)), name: 'Browser chosen name', lastPlayedAt: 10, playTime: 10 };
  await library.mirrorGame(hashedGame, rom);
  // Simulates play history committed locally after a folder metadata write
  // failed. The disk still has the older history but identical media/saves.
  const browserRecovery = { ...hashedGame, lastPlayedAt: 20, playTime: 30 };
  let reconciled: typeof browserRecovery | null = null;
  (db as unknown as Record<string, unknown>).getGame = async () => browserRecovery;
  (db as unknown as Record<string, unknown>).getRom = async () => ({ id: hashedGame.id, data: rom });
  (db as unknown as Record<string, unknown>).putGame = async (value: typeof browserRecovery) => { reconciled = value; };
  assert.equal((await library.readForPlay(hashedGame.id))?.game.playTime, 10);
  await library.scanIntoBrowser();
  assert.equal(reconciled, null, 'scan never writes stale linked metadata over newer browser history');
  assert.equal(browserRecovery.lastPlayedAt, 20);
  assert.equal(browserRecovery.playTime, 30);
  assert.equal(browserRecovery.name, 'Browser chosen name');
  assert.deepEqual(reconcileGameMetadata(browserRecovery, hashedGame), browserRecovery);
});

test('a manifest-referenced missing battery file is corruption, not a no-save result', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  await library.chooseFolder();
  const rom = new ArrayBuffer(192);
  const hashedGame = await gameFor(rom);
  await library.mirrorGame(hashedGame, rom);
  await library.mirrorSave(hashedGame.id, JSON.stringify({ v: 1, saveType: 'sram', len: 1, checksum: 65, data: 'QQ==' }));
  const zen = root.children.get('.zenulator') as MemoryDirectory;
  const manifest = JSON.parse(await (await (zen.children.get('manifest.json') as MemoryFile).getFile()).text());
  const saveName = manifest.games[hashedGame.id].batteryFile.split('/')[1];
  await (await zen.getDirectoryHandle('saves')).removeEntry(saveName);
  await assert.rejects(() => library.readForPlay(hashedGame.id), /battery save.*missing/i);
});

test('linked scan failure returns the already-loaded browser recovery library', async () => {
  const recovery = [{ id: 'recovery-game' }];
  const result = await scanWithoutHidingBrowserRecovery(
    recovery,
    async () => { throw new Error('folder is disconnected'); },
    async () => [{ id: 'incorrectly-replaced' }],
  );
  assert.equal((result.error as Error).message, 'folder is disconnected');
  assert.deepEqual(result.value, recovery);
});

test('metadata-only mirror keeps the newest committed battery reference through reload', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  await library.chooseFolder();
  const rom = new ArrayBuffer(192);
  const hashedGame = await gameFor(rom);
  await library.mirrorGame(hashedGame, rom);
  const first = JSON.stringify({ v: 1, saveType: 'sram', len: 1, checksum: 65, data: 'QQ==' });
  const newest = JSON.stringify({ v: 1, saveType: 'sram', len: 1, checksum: 66, data: 'Qg==' });
  await library.mirrorSave(hashedGame.id, first);
  await library.mirrorSave(hashedGame.id, newest);
  await library.mirrorGame({ ...hashedGame, lastPlayedAt: 2, playTime: 3 });
  const reloaded = new DeviceLibrary();
  assert.equal((await reloaded.readForPlay(hashedGame.id))?.save, newest);
});

test('plain game projection prevents stale manifest paths entering another folder', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  await library.chooseFolder();
  const rom = new ArrayBuffer(192);
  const hashedGame = await gameFor(rom);
  const tainted = {
    ...hashedGame,
    romFile: 'roms/from-another-folder.gba',
    batteryFile: 'saves/from-another-folder.json',
    stateFiles: { '1': { file: 'states/from-another-folder.json', timestamp: 1 } },
    previousFiles: ['roms/from-another-folder.gba'],
  };
  assert.deepEqual(Object.keys(plainGame(tainted as typeof hashedGame)).sort(), ['addedAt', 'fileName', 'id', 'lastPlayedAt', 'name', 'playTime', 'romHash', 'size']);
  await library.mirrorGame(tainted as typeof hashedGame, rom);
  const zen = root.children.get('.zenulator') as MemoryDirectory;
  const manifest = JSON.parse(await (await (zen.children.get('manifest.json') as MemoryFile).getFile()).text());
  const entry = manifest.games[hashedGame.id];
  assert.notEqual(entry.romFile, tainted.romFile);
  assert.equal(entry.batteryFile, undefined);
  assert.deepEqual(entry.stateFiles, {});
  assert.equal(entry.previousFiles, undefined);
});

test('unresolved browser-recovery conflict blocks repeated save, state, and backup folder writes until explicit copy consent', async () => {
  installBrowserMocks();
  const library = new DeviceLibrary();
  await library.chooseFolder();
  const rom = new ArrayBuffer(192);
  const hashedGame = await gameFor(rom);
  await library.mirrorGame(hashedGame, rom);
  const original = JSON.stringify({ v: 1, saveType: 'sram', len: 1, checksum: 65, data: 'QQ==' });
  const changed = JSON.stringify({ v: 1, saveType: 'sram', len: 1, checksum: 66, data: 'Qg==' });
  const state = { id: `${hashedGame.id}_1`, gameId: hashedGame.id, slot: 1, timestamp: 1, data: new TextEncoder().encode(validStatePayload()).buffer };
  await library.mirrorSave(hashedGame.id, original);
  const zen = root.children.get('.zenulator') as MemoryDirectory;
  const manifestFile = zen.children.get('manifest.json') as MemoryFile;
  const before = await (await manifestFile.getFile()).text();
  await library.markBrowserRecoveryConflict(hashedGame.id, 'Browser recovery selected.');
  await assert.rejects(() => library.mirrorSave(hashedGame.id, changed), /explicit Copy browser library/i);
  await assert.rejects(() => library.mirrorState(state), /explicit Copy browser library/i);
  await assert.rejects(() => library.mirrorBackup(hashedGame.id, changed, [state]), /explicit Copy browser library/i);
  assert.equal(await (await manifestFile.getFile()).text(), before);
  assert.equal((await library.readForPlay(hashedGame.id))?.save, original);

  (db as unknown as Record<string, unknown>).getGames = async () => [hashedGame];
  (db as unknown as Record<string, unknown>).getRom = async () => ({ id: hashedGame.id, data: rom });
  (db as unknown as Record<string, unknown>).getSave = async () => ({ id: hashedGame.id, data: changed });
  (db as unknown as Record<string, unknown>).getStatesForGame = async () => [];
  await library.importBrowserLibrary(true);
  assert.deepEqual(await library.getConflicts(), []);
  assert.equal((await library.readForPlay(hashedGame.id))?.save, changed);
});