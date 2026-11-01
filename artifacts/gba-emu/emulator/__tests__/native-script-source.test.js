'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { makeSandbox } = require('../fixtures/run-core.js');
const { extractCoreScript } = require('../fixtures/extract-core.js');

test('full embedded core parses and signals ready without Function source access', () => {
  const { sandbox, posted } = makeSandbox();
  const context = vm.createContext(sandbox);
  vm.runInContext(
    'Function.prototype.toString = function(){ throw new Error("Native function source unavailable"); };',
    context,
  );
  vm.runInContext(extractCoreScript(), context);
  assert.ok(posted.some((message) => message.type === 'ready'));
});

test('full embedded core accepts a synthetic ROM after native audio setup', async () => {
  const { sandbox, posted, listeners } = makeSandbox();
  vm.runInNewContext(extractCoreScript(), sandbox);
  const send = (data) => listeners.message.forEach((fn) => fn({ data: JSON.stringify(data) }));
  assert.ok(posted.some((message) => message.type === 'ready'));
  send({ type: 'nativeAudioState', active: true, silentPlayback: true });
  // A tiny synthetic homebrew ROM: ARM branch to self.
  const rom = Buffer.alloc(0x200);
  rom.writeUInt32LE(0xEAFFFFFE, 0);
  rom[0xB2] = 0x96;
  send({ type: 'romStart', total: 1 });
  send({ type: 'romChunk', index: 0, total: 1, data: rom.toString('base64') });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(posted.some((message) => message.type === 'romLoaded'));
});