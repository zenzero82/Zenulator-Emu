import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function loadModule(path, dependencies = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, require: (name) => {
      if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`);
      return dependencies[name];
    }, setTimeout, Uint8Array, console, fetch: (...args) => dependencies.fetch(...args),
  });
  return module.exports;
}
const batch = loadModule('../importBatch.ts');

test('SAF names decode document IDs without losing filenames', () => {
  assert.equal(batch.documentName('content://provider/tree/primary%3AROMs/document/primary%3AROMs%2FGame%20One.gba'), 'Game One.gba');
  assert.equal(batch.documentName('content://provider/document/35%3AGame.zip'), 'Game.zip');
  assert.equal(batch.documentName('content://provider/document/35%3AGame.zip/'), 'Game.zip');
});

test('companion artwork matches ROM names, not unrelated or generic cover files', () => {
  const images = ['Game.png', 'game-cover.jpg', 'Game.cover.webp', 'Other.png', 'cover.png', 'Game.gba']
    .map((name) => ({ name, uri: name }));
  assert.equal(batch.companionArtwork('GAME.gba', images).length, 3);
});

test('batch imports sequentially, reports duplicates/errors, and skips non-ROMs', async () => {
  let active = 0;
  let maximumActive = 0;
  const order = [];
  const summary = await batch.runImportBatch(
    ['first.gba', 'duplicate.zip', 'broken.gba', 'last.agb', 'cover.png', 'notes.txt']
      .map((name) => ({ name, uri: name })),
    async ({ name }) => {
      maximumActive = Math.max(maximumActive, ++active);
      order.push(name);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (name === 'broken.gba') throw new Error('Corrupt ZIP/ROM');
      return name === 'duplicate.zip' ? 'duplicate' : 'imported';
    }, () => false, () => {},
  );
  assert.equal(maximumActive, 1);
  assert.deepEqual(order, ['first.gba', 'duplicate.zip', 'broken.gba', 'last.agb']);
  assert.equal(summary.imported, 2);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.skipped, 1);
});

test('cancelling never interrupts the current committed file and prevents the next', async () => {
  let cancelled = false;
  let calls = 0;
  const summary = await batch.runImportBatch(
    ['a.gba', 'b.gba'].map((name) => ({ name, uri: name })),
    async () => { calls++; cancelled = true; return 'imported'; },
    () => cancelled, () => {},
  );
  assert.equal(calls, 1);
  assert.equal(summary.imported, 1);
  assert.equal(summary.cancelled, true);
});

function nativeImporter() {
  const files = new Map([['content://rom', { size: 1024, md5: 'abc123' }]]);
  const calls = [];
  const fileSystem = {
    documentDirectory: 'file:///documents/',
    EncodingType: { Base64: 'base64' },
    async makeDirectoryAsync() {},
    async copyAsync({ from, to }) { calls.push(['copy', from, to]); files.set(to, files.get(from)); },
    async getInfoAsync(uri) { return files.has(uri) ? { exists: true, ...files.get(uri) } : { exists: false }; },
    async deleteAsync(uri) { calls.push(['delete', uri]); files.delete(uri); },
  };
  const module = loadModule('../importRomAsset.ts', {
    'react-native': { Platform: { OS: 'android' } },
    'expo-file-system/legacy': fileSystem,
    './romArtwork': { MAX_ARCHIVE_BYTES: 128 * 1024 * 1024, MAX_ROM_BYTES: 64 * 1024 * 1024 },
  });
  return { ...module, calls, files };
}

test('native import copies a content URI and commits a disk path, not a ROM payload', async () => {
  const env = nativeImporter();
  const result = await env.importRomAsset({ uri: 'content://rom', name: 'Game.gba' }, async (entry, options) => {
    assert.ok(entry.filePath.startsWith('file:///documents/gba_roms/'));
    assert.equal(options.keepExisting, true);
    assert.equal(options.webBase64, undefined);
    assert.equal(entry.contentHash, 'abc123');
    return { ...entry, id: 'new', addedAt: 1 };
  });
  assert.equal(result.entry.id, 'new');
  assert.equal(env.files.size, 2);
});

test('duplicate native import deletes only the new staged copy', async () => {
  const env = nativeImporter();
  const existing = { id: 'existing', filePath: 'file:///documents/gba_roms/old.gba', artworkPath: 'cover.png' };
  const result = await env.importRomAsset({ uri: 'content://rom', name: 'Game.gba' }, async () => existing);
  assert.equal(result.entry, existing);
  assert.equal(env.files.size, 1);
  assert.equal(env.calls.filter(([kind]) => kind === 'delete').length, 1);
  assert.notEqual(env.calls.find(([kind]) => kind === 'delete')[1], existing.filePath);
});

test('manifest failure removes staged bytes without touching the source', async () => {
  const env = nativeImporter();
  await assert.rejects(env.importRomAsset({ uri: 'content://rom', name: 'Game.gba' }, async () => {
    throw new Error('Storage full');
  }), /Storage full/);
  assert.equal(env.files.size, 1);
  assert.ok(env.files.has('content://rom'));
});

test('oversized files are rejected before even copying them', async () => {
  const env = nativeImporter();
  await assert.rejects(env.importRomAsset({ uri: 'content://rom', name: 'Game.gba', size: 65 * 1048576 }, async () => {
    throw new Error('must not commit');
  }), /64 MB/);
  assert.equal(env.calls.some(([kind]) => kind === 'copy'), false);
});
