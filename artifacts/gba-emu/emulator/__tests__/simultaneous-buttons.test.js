'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

test('L + R + Start stay held together and release independently', async () => {
  const rom = Buffer.alloc(512);
  rom.writeUInt32LE(0xEAFFFFFE, 0);
  rom[0xB2] = 0x96;
  const core = await bootCoreInteractive(rom);
  function keys() {
    core.posted.length = 0;
    core.send({ type: 'saveState' });
    const snapshot = JSON.parse(core.posted.find((event) => event.type === 'saveState').state);
    return Buffer.from(snapshot.io, 'base64').readUInt16LE(0x130);
  }
  const allReleased = 0x3ff;
  core.send({ type: 'keydown', key: 'l' });
  core.send({ type: 'keydown', key: 'r' });
  core.send({ type: 'keydown', key: 'start' });
  assert.equal(keys(), allReleased & ~(0x200 | 0x100 | 0x8));
  core.send({ type: 'keyup', key: 'r' });
  assert.equal(keys(), allReleased & ~(0x200 | 0x8));
  core.send({ type: 'keyup', key: 'l' });
  assert.equal(keys(), allReleased & ~0x8);
  core.send({ type: 'keyup', key: 'start' });
  assert.equal(keys(), allReleased);
  for (const key of ['up', 'right', 'a', 'b']) core.send({ type: 'keydown', key });
  assert.equal(keys(), allReleased & ~(0x40 | 0x10 | 0x1 | 0x2));
  for (const key of ['up', 'right', 'a', 'b']) core.send({ type: 'keyup', key });
  assert.equal(keys(), allReleased);
});