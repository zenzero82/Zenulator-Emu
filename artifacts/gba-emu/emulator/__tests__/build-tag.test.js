const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../buildTag.ts'), 'utf8');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: exportsObject });

test('current core tag starts at Version 1.0 without a revision', () => {
  assert.equal(exportsObject.BUILD_TAG, 'Version 1.0');
});
test('revision suffix changes independently of store release version', () => {
  assert.equal(exportsObject.formatCoreTag('1.0', 1), 'Version 1.0 (1)');
  assert.equal(exportsObject.formatCoreTag('1.0', 12), 'Version 1.0 (12)');
  assert.equal(exportsObject.formatCoreTag('1.1', 0), 'Version 1.1');
  for (const revision of [-1, 0.5, NaN]) {
    assert.throws(() => exportsObject.formatCoreTag('1.0', revision), /Invalid core revision/);
  }
});
test('actual headless core uses the same release tag as Settings', () => {
  const { extractCoreScript } = require('../fixtures/extract-core');
  assert.ok(extractCoreScript().includes("var BUILD_TAG='Version 1.0';"));
});