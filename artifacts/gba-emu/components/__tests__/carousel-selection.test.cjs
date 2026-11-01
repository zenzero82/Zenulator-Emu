const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const src = fs.readFileSync(path.join(__dirname, '../../library/carouselSelection.ts'), 'utf8');
const exp = {};
vm.runInNewContext(ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: exp });
const { indexFromOffset, resolveSelection } = exp;

test('offset maps to clamped snapped index', () => {
  assert.equal(indexFromOffset(0, 100, 3), 0);
  assert.equal(indexFromOffset(149, 100, 3), 1);
  assert.equal(indexFromOffset(151, 100, 3), 2);
  assert.equal(indexFromOffset(900, 100, 3), 2);
  assert.equal(indexFromOffset(-40, 100, 3), 0);
  assert.equal(indexFromOffset(50, 100, 0), 0);
});
test('selection stays on the same id when another ROM is removed', () => {
  assert.equal(resolveSelection(['a', 'c'], ['a', 'b', 'c'], 'c', 1), 'c');
});
test('removing the selected ROM falls back to the neighbour at the same position', () => {
  assert.equal(resolveSelection(['a', 'c'], ['a', 'b', 'c'], 'b', 1), 'c');
  assert.equal(resolveSelection(['a', 'b'], ['a', 'b', 'c'], 'c', 2), 'b');
});
test('newly imported ROM becomes selected, first import included', () => {
  assert.equal(resolveSelection(['a', 'b'], ['a'], 'a', 0), 'b');
  assert.equal(resolveSelection(['a'], [], null, 0), 'a');
  assert.equal(resolveSelection(['a'], null, null, 0), 'a');
});
test('empty library selects nothing', () => {
  assert.equal(resolveSelection([], ['a'], 'a', 0), null);
});
