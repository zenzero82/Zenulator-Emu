'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

async function boot() {
  const rom = Buffer.alloc(512);
  rom.writeUInt32LE(0xEAFFFFFE, 0);
  rom[0xB2] = 0x96;
  const core = await bootCoreInteractive(rom);
  core.keys = () => {
    core.posted.length = 0;
    core.send({ type: 'saveState' });
    const snap = JSON.parse(core.posted.find((e) => e.type === 'saveState').state);
    return Buffer.from(snap.io, 'base64').readUInt16LE(0x130);
  };
  return core;
}
const ALL = 0x3ff;

test('host keys stay pressed across setInputMap and release with releaseAllKeys', async () => {
  const core = await boot();
  core.send({ type: 'setInputMap', keyboard: { KeyQ: 'a' }, gamepad: { 0: 'b' }, keyboardInCore: true });
  core.send({ type: 'keydown', key: 'a' });
  assert.equal(core.keys(), ALL & ~0x1);
  core.send({ type: 'setInputEnabled', enabled: false });
  core.send({ type: 'releaseAllKeys' });
  assert.equal(core.keys(), ALL);
  core.send({ type: 'setInputEnabled', enabled: true });
  core.send({ type: 'keydown', key: 'start' });
  core.send({ type: 'keyup', key: 'start' });
  assert.equal(core.keys(), ALL);
});
