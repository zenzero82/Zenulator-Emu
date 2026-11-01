import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAST_FORWARD_CODE,
  actionForCode,
  assignKeyboardBinding,
  canRouteGameKeyboardEvent,
  defaultBindings,
  gameKeyForCode,
  isGameKey,
  loadBindings,
  saveBindings,
} from './keyboardRouting';

test('routes the GBA bindings and fast-forward shortcut', () => {
  assert.equal(gameKeyForCode('KeyZ'), 'b');
  assert.equal(gameKeyForCode('ShiftRight'), 'select');
  assert.equal(canRouteGameKeyboardEvent('ArrowUp', {}), true);
  assert.equal(canRouteGameKeyboardEvent(FAST_FORWARD_CODE, {}), true);
  assert.equal(gameKeyForCode(FAST_FORWARD_CODE), undefined);
});

test('does not steal browser or text-entry modifier shortcuts', () => {
  assert.equal(canRouteGameKeyboardEvent('KeyS', { ctrlKey: true }), false);
  assert.equal(canRouteGameKeyboardEvent('KeyF', { metaKey: true }), false);
  assert.equal(canRouteGameKeyboardEvent('KeyZ', { altKey: true }), false);
  assert.equal(canRouteGameKeyboardEvent('Tab', {}), false);
});

test('validates only keys accepted by the core message contract', () => {
  assert.equal(isGameKey('up'), true);
  assert.equal(isGameKey('select'), true);
  assert.equal(isGameKey('speed'), false);
  assert.equal(isGameKey(undefined), false);
});

test('saved remaps route gameplay and survive a reload; reset restores defaults', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  const base = defaultBindings();
  const moved = assignKeyboardBinding(base.keyboard, 'a', 'KeyZ');
  assert.deepEqual(moved.displaced, ['b']);
  saveBindings({ ...base, keyboard: moved.bindings }, storage);
  const loaded = loadBindings(storage);
  assert.equal(actionForCode('KeyZ', {}, loaded.keyboard), 'a');
  assert.equal(actionForCode('KeyX', {}, loaded.keyboard), undefined);
  assert.equal(actionForCode('KeyX', {}, defaultBindings().keyboard), 'a');
  assert.equal(loadBindings({ getItem: () => '{broken' }).keyboard.a[0], 'KeyX');
});
