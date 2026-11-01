'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

test('final save flush returns its correlation token alongside the battery snapshot', async () => {
  const rom = Buffer.alloc(512);
  rom.writeUInt32LE(0xEAFFFFFE, 0);
  rom[0xB2] = 0x96;
  const core = await bootCoreInteractive(rom);
  core.posted.length = 0;
  core.send({ type: 'flushSave', requestId: 'exit-unique-token' });
  const save = core.posted.find((entry) => entry.type === 'batterySave');
  assert.equal(save?.requestId, 'exit-unique-token');
  assert.equal(JSON.parse(save.save).v, 1);
  core.posted.length = 0;
  core.send({ type: 'flushSave' });
  assert.equal(core.posted.find((entry) => entry.type === 'batterySave')?.requestId, undefined);
});