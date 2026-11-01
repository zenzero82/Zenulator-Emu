import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute the actual orientation effect with a mocked native boundary. This
// checks promise ordering, not native device rotation or UIKit behavior.
const source = readFileSync(new URL('../../app/emulator.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('emulator.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effectSource;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' &&
      node.arguments[0]?.getText(ast).includes('getOrientationLockAsync')) effectSource = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(effectSource, 'orientation lifecycle effect exists');
const javascript = ts.transpileModule(effectSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup({ platform = 'android', enabled = true, pendingLock = false } = {}) {
  const calls = [];
  let cleanup;
  let finishLock;
  const lock = new Promise((resolve) => { finishLock = resolve; });
  vm.runInNewContext(javascript, {
    Platform: { OS: platform },
    useEffect: (fn) => { cleanup = fn(); },
    loadGameplayPreferences: async () => ({ startInLandscape: enabled }),
    ScreenOrientation: {
      OrientationLock: { DEFAULT: 0, UNKNOWN: -1, LANDSCAPE: 6 },
      getOrientationLockAsync: async () => { calls.push('read'); return 3; },
      lockAsync: async (value) => { calls.push(value); if (value === 6 && pendingLock) await lock; },
    },
    console,
  });
  return { calls, cleanup, finishLock };
}

test('landscape preference defaults off and iOS never calls a runtime lock', async () => {
  const off = setup({ enabled: false });
  const ios = setup({ platform: 'ios' });
  await tick();
  off.cleanup?.();
  ios.cleanup?.();
  assert.deepEqual(off.calls, []);
  assert.deepEqual(ios.calls, []);
});

test('Android restores its prior orientation lock on gameplay exit', async () => {
  const env = setup();
  await tick();
  assert.deepEqual(env.calls, ['read', 6]);
  env.cleanup();
  assert.deepEqual(env.calls, ['read', 6, 3]);
});

test('leaving while the native lock is pending still restores the previous lock', async () => {
  const env = setup({ pendingLock: true });
  await tick();
  env.cleanup();
  assert.deepEqual(env.calls, ['read', 6]);
  env.finishLock();
  await tick();
  assert.deepEqual(env.calls, ['read', 6, 3]);
});
