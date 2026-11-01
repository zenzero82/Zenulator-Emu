const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const fileName = join(__dirname, '..', `${name}.ts`);
  const code = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  cache.set(name, module.exports);
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: (spec) => load(spec.replace('./', '')),
  });
  cache.set(name, module.exports);
  return module.exports;
}
const M = load('inputMapping');
const P = load('gameplayPreferences');

test('rebinding moves a conflicting key and reports the displaced action', () => {
  const r = M.assignKeyboardBinding(M.DEFAULT_KEYBOARD_BINDINGS, 'a', 'KeyZ');
  assert.deepEqual([...r.bindings.a], ['KeyZ']);
  assert.deepEqual([...r.bindings.b], []);
  assert.deepEqual([...r.displaced], ['b']);
  assert.equal(M.routeKeyboardCode(r.bindings, 'KeyZ'), 'a');
  assert.equal(M.routeKeyboardCode(r.bindings, 'KeyX'), undefined);
});

test('reserved and modifier shortcuts stay browser/OS owned', () => {
  const r = M.assignKeyboardBinding(M.DEFAULT_KEYBOARD_BINDINGS, 'a', 'Tab');
  assert.ok(r.rejected);
  assert.equal(M.routeKeyboardCode(M.DEFAULT_KEYBOARD_BINDINGS, 'KeyX', { ctrlKey: true }), undefined);
  assert.equal(M.routeKeyboardCode(M.DEFAULT_KEYBOARD_BINDINGS, 'KeyX', { metaKey: true }), undefined);
});

test('gamepad conflicts, clear and reset via parse', () => {
  const r = M.assignGamepadBinding(M.DEFAULT_GAMEPAD_BINDINGS, 'start', 0);
  assert.deepEqual([...r.displaced], ['a']);
  const cleared = M.clearBinding(r.bindings, 'start');
  assert.deepEqual([...cleared.start], []);
  assert.deepEqual([...M.parseGamepadBindings(null).a], [0]);
});

test('stored bindings are validated and deduplicated', () => {
  const kb = M.parseKeyboardBindings({ a: ['KeyQ', 'KeyQ', 'Escape', 5], b: ['KeyQ'], bogus: ['KeyP'] });
  assert.deepEqual([...kb.a], ['KeyQ']);
  assert.deepEqual([...kb.b], []);
  assert.deepEqual([...kb.up], ['ArrowUp']);
});

test('Android key codes translate to the shared vocabulary', () => {
  assert.equal(M.routeNativeButton({ keyCode: 96, pressed: true, gamepad: true }, M.DEFAULT_KEYBOARD_BINDINGS, M.DEFAULT_GAMEPAD_BINDINGS), 'a');
  assert.equal(M.routeNativeButton({ keyCode: 19, pressed: true, gamepad: true }, M.DEFAULT_KEYBOARD_BINDINGS, M.DEFAULT_GAMEPAD_BINDINGS), 'up');
  assert.equal(M.routeNativeButton({ keyCode: 52, pressed: true, gamepad: false }, M.DEFAULT_KEYBOARD_BINDINGS, M.DEFAULT_GAMEPAD_BINDINGS), 'a'); // X
  assert.equal(M.routeNativeButton({ keyCode: 66, pressed: true, gamepad: false }, M.DEFAULT_KEYBOARD_BINDINGS, M.DEFAULT_GAMEPAD_BINDINGS), 'start');
});

test('aggregator holds a key until the last source releases', () => {
  const out = [];
  const agg = M.createKeyAggregator((k, p) => out.push(`${k}:${p}`));
  agg.set('touch', 'a', true);
  agg.set('pad:1:96', 'a', true);
  agg.set('touch', 'a', false);
  assert.deepEqual(out, ['a:true']);
  agg.releaseSource('pad:1:96');
  assert.deepEqual(out, ['a:true', 'a:false']);
});

test('native tracker releases the exact emitted axis/button source ids', () => {
  const out = [];
  const agg = M.createKeyAggregator((k, p) => out.push(`${k}:${p}`));
  const tracker = M.createNativeSourceTracker();
  agg.set(tracker.track('axis:3:up'), 'up', true);
  agg.set(tracker.track('axis:3:rt'), 'r', true);
  agg.set(tracker.track('pad:3:96'), 'a', true);
  agg.set(tracker.track('pad:4:97'), 'b', true);
  const taken = [...tracker.takeDevice(3)].sort();
  assert.deepEqual(taken, ['axis:3:rt', 'axis:3:up', 'pad:3:96']);
  taken.forEach((s) => agg.releaseSource(s));
  assert.equal(agg.isHeld('up'), false);
  assert.equal(agg.isHeld('r'), false);
  assert.equal(agg.isHeld('a'), false);
  assert.equal(agg.isHeld('b'), true);
  tracker.takeAll().forEach((s) => agg.releaseSource(s));
  assert.equal(agg.isHeld('b'), false);
  assert.equal(tracker.size(), 0);
});

test('preferences ignore old saved speed, preserve layouts, and clamp untrusted values', () => {
  const d = P.parsePreferences(null);
  assert.equal(d.startInLandscape, false);
  assert.equal('speed' in d, false);
  const p = P.parsePreferences(JSON.stringify({
    startInLandscape: true, speed: 7,
    touchLayout: { portrait: { dpad: { x: 999, y: -999, scale: 9, opacity: 0 } } },
  }));
  assert.equal(p.startInLandscape, true);
  assert.equal('speed' in p, false);
  assert.deepEqual({ ...p.touchLayout.portrait.dpad }, { x: 72, y: -72, scale: 1.4, opacity: 0.3 });
  assert.deepEqual({ ...p.touchLayout.landscape.ab }, { x: 0, y: 0, scale: 1, opacity: 1 });
  for (const s of [1, 2, 3, 4]) {
    const migrated = P.parsePreferences(JSON.stringify({ speed: s, startInLandscape: true }));
    assert.equal('speed' in migrated, false);
    assert.equal(migrated.startInLandscape, true);
    assert.equal('speed' in JSON.parse(P.serializePreferences(migrated)), false);
  }
  assert.equal(P.parsePreferences('{bad json').startInLandscape, false);
});

test('four FF presses cycle Normal -> 2x -> 3x -> 4x -> Normal with incremental labels', () => {
  let speed = 1;
  const factors = [], labels = [];
  for (let press = 0; press < 8; press++) {
    speed = P.nextSpeed(speed);
    factors.push(speed);
    labels.push(P.speedLabel(speed));
  }
  assert.deepEqual(factors, [2, 3, 4, 1, 2, 3, 4, 1]);
  assert.deepEqual(labels, ['FF +1×', 'FF +2×', 'FF +3×', 'Normal', 'FF +1×', 'FF +2×', 'FF +3×', 'Normal']);
});
