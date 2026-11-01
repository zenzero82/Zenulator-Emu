import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const output = ts.transpileModule(readFileSync(new URL('../../context/RomLibraryContext.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;

async function environment(existing = []) {
  const values = new Map([['@gba_emu_roms', JSON.stringify(existing)]]);
  const deletes = [];
  const writes = [];
  let failManifest = false;
  const react = {
    createContext: () => ({ Provider: 'provider' }),
    useRef: (current) => ({ current }), useState: (v) => [v, () => {}],
    useCallback: (v) => v, useEffect: (effect) => effect(),
    createElement: (_, props) => props,
  };
  const mocks = {
    react,
    'react-native': { Platform: { OS: 'web' }, Image: {} },
    '@react-native-async-storage/async-storage': {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        writes.push(key);
        if (key === '@gba_emu_roms' && failManifest) throw new Error('Manifest write failed');
        values.set(key, value);
      },
      removeItem: async (key) => { deletes.push(key); values.delete(key); },
    },
    'expo-file-system/legacy': {},
    '@/library/batterySaveStorage': {},
    '@/library/romArtwork': { MAX_ARTWORK_BYTES: 8 * 1048576, portableArtworkPath: (p) => p },
  };
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, require: (name) => {
      if (!(name in mocks)) throw new Error(`Unexpected import ${name}`);
      return mocks[name];
    }, console,
  });
  const value = module.exports.RomLibraryProvider({ children: null }).value;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { value, values, writes, deletes, fail: () => { failManifest = true; } };
}

test('bulk duplicate detection leaves the complete existing entry and bytes untouched', async () => {
  const original = { id: 'old', name: 'Old title', contentHash: 'abc', addedAt: 1,
    artworkPath: 'gba_artwork/manual.png', saveStates: [{ slot: 1, data: 'progress' }] };
  const env = await environment([original]);
  env.values.set('@gba_rom_data_old', 'existing bytes');
  const result = await env.value.addRom({ name: 'New title', contentHash: 'abc', saveStates: [] },
    { keepExisting: true, webBase64: 'replacement bytes' });
  assert.equal(JSON.stringify(result), JSON.stringify(original));
  assert.equal(env.values.get('@gba_rom_data_old'), 'existing bytes');
  assert.equal(env.writes.length, 0);
});

test('browser import persists ROM bytes before publishing the manifest', async () => {
  const env = await environment();
  const entry = await env.value.addRom({ name: 'Game', contentHash: 'abc', saveStates: [] },
    { keepExisting: true, webBase64: 'game bytes' });
  assert.deepEqual(env.writes, [`@gba_rom_data_${entry.id}`, '@gba_emu_roms']);
  assert.equal(JSON.parse(env.values.get('@gba_emu_roms'))[0].id, entry.id);
});

test('manifest storage failure leaves old library intact and removes orphaned browser bytes', async () => {
  const env = await environment();
  env.fail();
  await assert.rejects(env.value.addRom({ name: 'Game', contentHash: 'abc', saveStates: [] },
    { keepExisting: true, webBase64: 'game bytes' }), /Manifest write failed/);
  assert.equal(env.values.get('@gba_emu_roms'), '[]');
  assert.equal(env.values.size, 1);
  assert.equal(env.deletes.length, 1);
});

test('rename persists only a trimmed display title and preserves ROM/save/artwork identity', async () => {
  const original = { id: 'old', name: 'Old title', contentHash: 'abc', filePath: 'original.gba',
    addedAt: 1, artworkPath: 'gba_artwork/manual.png', saveStates: [{ slot: 1, data: 'progress' }] };
  const env = await environment([original]);
  env.values.set('@gba_rom_data_old', 'original ROM bytes');
  await env.value.renameRom('old', '  Pokémon Monomyth  ');
  assert.deepEqual(JSON.parse(env.values.get('@gba_emu_roms')), [{ ...original, name: 'Pokémon Monomyth' }]);
  assert.equal(env.values.get('@gba_rom_data_old'), 'original ROM bytes');
  assert.deepEqual(env.writes, ['@gba_emu_roms']);
  assert.deepEqual(env.deletes, []);
});

test('rename rejects empty/oversize names and deleted games without writing', async () => {
  const env = await environment([{ id: 'old', name: 'Original' }]);
  for (const name of [' ', 'a'.repeat(121)]) await assert.rejects(env.value.renameRom('old', name), /title/);
  await assert.rejects(env.value.renameRom('missing', 'New'), /no longer/);
  assert.deepEqual(env.writes, []);
});

test('failed rename retains the durable original title', async () => {
  const original = [{ id: 'old', name: 'Original' }];
  const env = await environment(original);
  env.fail();
  await assert.rejects(env.value.renameRom('old', 'New'), /Manifest write failed/);
  assert.deepEqual(JSON.parse(env.values.get('@gba_emu_roms')), original);
});
