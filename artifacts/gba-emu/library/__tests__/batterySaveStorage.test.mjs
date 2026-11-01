import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const storageSource = readFileSync(new URL('../batterySaveStorage.ts', import.meta.url), 'utf8');

function loadStorage() {
  const files = new Map();
  const asyncValues = new Map();
  const Platform = { OS: 'ios' };
  const FileSystem = {
    documentDirectory: 'file:///documents/',
    async getInfoAsync(uri) {
      const value = files.get(uri);
      return value === undefined ? { exists: false } : { exists: true, size: new TextEncoder().encode(value).length };
    },
    async makeDirectoryAsync() {},
    async writeAsStringAsync(uri, value) { files.set(uri, value); },
    async readAsStringAsync(uri) {
      if (!files.has(uri)) throw new Error('missing file');
      return files.get(uri);
    },
    async deleteAsync(uri) { files.delete(uri); },
    async moveAsync({ from, to }) {
      if (environment.failNextMoveFor === to) {
        environment.failNextMoveFor = null;
        throw new Error('simulated move failure');
      }
      if (!files.has(from)) throw new Error('missing temporary file');
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
  const AsyncStorage = {
    async getItem(key) { return asyncValues.has(key) ? asyncValues.get(key) : null; },
    async setItem(key, value) { asyncValues.set(key, value); },
    async removeItem(key) { asyncValues.delete(key); },
  };
  // Storage only needs validation here; codec behavior is covered by the
  // codec tests. Keep this envelope validator strict enough to catch the
  // corruption paths exercised by the storage contract.
  const codec = {
    validateBatterySave(json) {
      const value = JSON.parse(json);
      if (!value || value.v !== 1 || typeof value.data !== 'string') throw new Error('invalid save');
      const bytes = Uint8Array.from(Buffer.from(value.data, 'base64'));
      if (value.len !== bytes.length) throw new Error('length mismatch');
      let sum = 0;
      for (const byte of bytes) sum = (sum + byte) >>> 0;
      if (sum !== value.checksum) throw new Error('checksum mismatch');
      return JSON.stringify({ v: 1, saveType: value.saveType, len: value.len, checksum: value.checksum, data: value.data });
    },
  };
  const output = ts.transpileModule(storageSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: 'batterySaveStorage.ts',
  }).outputText;
  const exports = {};
  const environment = { failNextMoveFor: null };
  vm.runInNewContext(output, {
    exports,
    module: { exports },
    require(name) {
      if (name === 'react-native') return { Platform };
      if (name === 'expo-file-system/legacy') return FileSystem;
      if (name === '@react-native-async-storage/async-storage') return AsyncStorage;
      if (name.endsWith('batterySaveCodec.mjs')) return codec;
      throw new Error(`unexpected import ${name}`);
    },
    TextEncoder,
    Promise,
    Map,
    Error,
    Number,
    String,
  });
  return { ...exports, files, asyncValues, Platform, environment };
}

function save(seed) {
  const bytes = new Uint8Array(8192);
  bytes.fill(seed);
  const data = Buffer.from(bytes).toString('base64');
  let checksum = 0;
  for (const byte of bytes) checksum = (checksum + byte) >>> 0;
  return JSON.stringify({ v: 1, saveType: 'eeprom', len: bytes.length, checksum, data });
}

test('import keeps a valid pre-import backup and restores it', async () => {
  const s = loadStorage();
  await s.persistBatterySave('game', save(1));
  await s.importBatterySave('game', save(2));
  assert.equal(await s.hasPreImportSave('game'), true);
  assert.equal(JSON.parse(await s.readBatterySave('game')).checksum, JSON.parse(save(2)).checksum);
  assert.equal(await s.restorePreImportSave('game'), true);
  assert.equal(JSON.parse(await s.readBatterySave('game')).checksum, JSON.parse(save(1)).checksum);
  assert.equal(await s.hasPreImportSave('game'), false);
});

test('failed replacement rolls current back and does not destroy pre-import backup', async () => {
  const s = loadStorage();
  await s.persistBatterySave('game', save(1));
  await s.importBatterySave('game', save(2));
  const current = 'file:///documents/gba_saves/game.sav';
  s.environment.failNextMoveFor = current;
  await assert.rejects(s.persistBatterySave('game', save(3)), /simulated move failure/);
  assert.equal(JSON.parse(await s.readBatterySave('game')).checksum, JSON.parse(save(2)).checksum);
  assert.equal(await s.hasPreImportSave('game'), true);
  // A corrupt current cannot replace the valid pre-import backup.
  s.files.set(current, '{broken');
  s.files.delete('file:///documents/gba_saves/game.sav.recovery');
  await assert.rejects(s.importBatterySave('game', save(3)), /invalid/);
  assert.equal(await s.hasPreImportSave('game'), true);
});

test('corrupt current is recovered from the committed recovery file', async () => {
  const s = loadStorage();
  await s.persistBatterySave('game', save(7));
  const current = 'file:///documents/gba_saves/game.sav';
  s.files.set('file:///documents/gba_saves/game.sav.recovery', save(7));
  s.files.set(current, '{corrupt');
  assert.equal(JSON.parse(await s.readBatterySave('game')).checksum, JSON.parse(save(7)).checksum);
  assert.equal(s.files.has(current), true);
  assert.equal(s.files.has('file:///documents/gba_saves/game.sav.recovery'), false);
});

test('concurrent writes are serialized per ROM and delete removes every generation', async () => {
  const s = loadStorage();
  await Promise.all([s.persistBatterySave('game', save(1)), s.persistBatterySave('game', save(2))]);
  assert.equal(JSON.parse(await s.readBatterySave('game')).checksum, JSON.parse(save(2)).checksum);
  await s.importBatterySave('game', save(3));
  await s.deleteBatterySave('game');
  assert.equal(await s.readBatterySave('game'), null);
  assert.equal(await s.hasPreImportSave('game'), false);
  assert.equal([...s.files.keys()].some((uri) => uri.includes('game.sav')), false);
});

test('delete removes interrupted-import temp files and rejects late writes', async () => {
  const s = loadStorage();
  await s.persistBatterySave('deleted-game', save(1));
  const prefix = 'file:///documents/gba_saves/deleted-game.sav';
  for (const suffix of ['', '.recovery', '.preimport', '.tmp', '.recovery.tmp', '.preimport.tmp']) {
    s.files.set(`${prefix}${suffix}`, save(1));
  }

  await s.deleteBatterySave('deleted-game');
  await assert.rejects(
    s.persistBatterySave('deleted-game', save(2)),
    /deleted ROM/,
  );
  assert.equal(await s.readBatterySave('deleted-game'), null);
  assert.equal(await s.hasPreImportSave('deleted-game'), false);
  assert.equal([...s.files.keys()].some((uri) => uri.includes('deleted-game.sav')), false);
});