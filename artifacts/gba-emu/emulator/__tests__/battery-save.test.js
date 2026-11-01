// Battery-save persistence tests, run against the REAL core extracted
// from html.ts (see fixtures/extract-core.js). They cover the full
// survive-a-force-quit contract:
//   1. a write into cart save memory marks the save dirty and the core
//      pushes a checksummed `batterySave` snapshot within ~1s
//   2. that exact snapshot round-trips back in via `loadSave` and is
//      readable at the SRAM address space again (relaunch survival)
//   3. corrupted / truncated save data is REJECTED with a loud
//      `saveError` message instead of being silently applied
//   4. an explicit `flushSave` message forces an immediate snapshot
//
// Run with: node --test emulator/__tests__/battery-save.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootCoreInteractive } = require('../fixtures/run-core');

const TEST_ROM = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'test-rom.gba'));

function pump(handle, ticks) {
  for (let t = 0; t < ticks; t++) {
    handle.advanceTime(16);
    const due = handle.rafQueue.slice();
    handle.rafQueue.length = 0;
    due.forEach((e) => e.fn());
  }
}

function lastOfType(handle, type) {
  for (let i = handle.posted.length - 1; i >= 0; i--) {
    if (handle.posted[i].type === type) return handle.posted[i];
  }
  return null;
}

function checksum(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s = (s + buf[i]) >>> 0;
  return s;
}

test('SRAM write marks save dirty and auto-flushes a valid checksummed snapshot within ~1s', async () => {
  const handle = await bootCoreInteractive(TEST_ROM);
  // Write a recognizable pattern into SRAM through the real w8 path.
  const pattern = [0xDE, 0xAD, 0xBE, 0xEF, 0x42];
  pattern.forEach((v, i) => handle.send({ type: 'writeMem8', addr: 0x0E000000 + i, value: v }));

  // Pump ~1.5s of wall clock so the once-per-second flush fires.
  pump(handle, 95);

  const msg = lastOfType(handle, 'batterySave');
  assert.ok(msg, 'expected a batterySave message after a dirty SRAM write');
  const save = JSON.parse(msg.save);
  assert.equal(save.v, 1);
  const bytes = Buffer.from(save.data, 'base64');
  assert.equal(bytes.length, save.len, 'declared len must match payload');
  assert.equal(checksum(bytes), save.checksum, 'checksum must match payload');
  pattern.forEach((v, i) => assert.equal(bytes[i], v, `sram[${i}] in snapshot`));
});

test('no spurious flush when nothing was written', async () => {
  const handle = await bootCoreInteractive(TEST_ROM);
  pump(handle, 95);
  assert.equal(lastOfType(handle, 'batterySave'), null, 'clean session must not emit batterySave');
});

test('snapshot round-trips through loadSave and is readable at 0x0E000000 (relaunch survival)', async () => {
  // Session 1: write, flush, capture the snapshot.
  const s1 = await bootCoreInteractive(TEST_ROM);
  s1.send({ type: 'writeMem8', addr: 0x0E000000, value: 0xA5 });
  s1.send({ type: 'writeMem8', addr: 0x0E000003, value: 0x5A });
  s1.send({ type: 'flushSave' });
  const snap = lastOfType(s1, 'batterySave');
  assert.ok(snap, 'flushSave must force an immediate snapshot');

  // Session 2 (fresh core = fresh app launch): restore + read back.
  const s2 = await bootCoreInteractive(TEST_ROM);
  s2.send({ type: 'loadSave', save: snap.save });
  assert.equal(lastOfType(s2, 'saveError'), null, 'valid save must not raise saveError');
  const before = s2.posted.length;
  s2.send({ type: 'readMem32', addr: 0x0E000000 });
  const mem = s2.posted.slice(before).find((p) => p.type === 'mem32');
  assert.ok(mem, 'expected mem32 response');
  // Bytes 0xA5, 0x00, 0x00, 0x5A little-endian => 0x5A0000A5
  assert.equal(mem.value >>> 0, 0x5A0000A5);
});

test('corrupted save data raises saveError instead of being silently applied', async () => {
  const handle = await bootCoreInteractive(TEST_ROM);
  handle.send({ type: 'writeMem8', addr: 0x0E000000, value: 0x11 });
  handle.send({ type: 'flushSave' });
  const snap = JSON.parse(lastOfType(handle, 'batterySave').save);

  const fresh = await bootCoreInteractive(TEST_ROM);

  // Case A: flipped byte -> checksum mismatch
  const corrupted = { ...snap };
  const buf = Buffer.from(corrupted.data, 'base64');
  buf[0] ^= 0xFF;
  corrupted.data = buf.toString('base64');
  fresh.send({ type: 'loadSave', save: JSON.stringify(corrupted) });
  let err = lastOfType(fresh, 'saveError');
  assert.ok(err && /checksum/.test(err.message), 'checksum corruption must be reported');

  // Case B: truncated payload -> length mismatch
  const truncated = { ...snap, data: Buffer.from(buf.subarray(0, 100)).toString('base64') };
  fresh.send({ type: 'loadSave', save: JSON.stringify(truncated) });
  err = lastOfType(fresh, 'saveError');
  assert.ok(err && /truncated/.test(err.message), 'truncation must be reported');

  // Case C: not JSON at all
  fresh.send({ type: 'loadSave', save: 'garbage-not-json' });
  err = lastOfType(fresh, 'saveError');
  assert.ok(err && /JSON/.test(err.message), 'non-JSON must be reported');
});
