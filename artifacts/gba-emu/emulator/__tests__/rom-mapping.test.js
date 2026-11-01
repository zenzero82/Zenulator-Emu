// Unit tests for the GBA core's ROM address-space mapping (r8/r32 in
// html.ts's memory switch), exercised through the REAL message-handling
// code path (romStart/romChunk + a `readMem32` diagnostic message added
// specifically for this test), not a reimplementation of the address math.
//
// GBA ROM is mirrored across three "wait-state" regions:
//   0x08000000-0x09FFFFFF  (wait-state 0, always the first 32MB)
//   0x0A000000-0x0BFFFFFF  (wait-state 1, second 32MB bank if ROM > 32MB,
//                            else mirrors the first 32MB)
//   0x0C000000-0x0DFFFFFF  (wait-state 2, ALWAYS `addr % rom.length` —
//                            i.e. it wraps around the actual ROM length,
//                            not a fixed 32MB window, and unlike
//                            wait-state 1 never exposes a distinct second
//                            bank near the 32MB boundary unless the ROM
//                            is shorter than 32MB)
//
// Run with: node --test emulator/__tests__/rom-mapping.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootCoreInteractive } = require('../fixtures/run-core');

const ROM_32MB = 0x2000000;

// Reads a little-endian uint32 out of a plain Buffer/Uint8Array at `off`.
function readLE32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}
function writeLE32(buf, off, value) {
  buf[off] = value & 0xFF;
  buf[off + 1] = (value >>> 8) & 0xFF;
  buf[off + 2] = (value >>> 16) & 0xFF;
  buf[off + 3] = (value >>> 24) & 0xFF;
}

async function readMem32(handle, addr) {
  const before = handle.posted.length;
  handle.send({ type: 'readMem32', addr });
  // The handler runs synchronously off the message listener, so the
  // response is already appended by the time send() returns; no need to
  // pump animation frames for this diagnostic path.
  const msg = handle.posted.slice(before).find((p) => p.type === 'mem32');
  assert.ok(msg, `expected a mem32 response for addr 0x${addr.toString(16)}`);
  return msg.value >>> 0;
}

test('standard (<32MB) ROM: all three wait-states mirror the same image, OOB reads return 0xFF', async () => {
  const SIZE = 8 * 1024 * 1024; // 8MB, comfortably under the 32MB window
  const rom = Buffer.alloc(SIZE, 0);
  writeLE32(rom, 0x0, 0x11111111);
  writeLE32(rom, 0x4, 0x22222222);

  const handle = await bootCoreInteractive(rom);

  // Wait-state 0 (0x08/0x09): direct mirror of the ROM buffer.
  assert.equal(await readMem32(handle, 0x08000000), readLE32(rom, 0x0), '0x08000000 should read rom[0]');
  assert.equal(await readMem32(handle, 0x08000004), readLE32(rom, 0x4), '0x08000004 should read rom[4]');
  // Past the end of an 8MB ROM but still inside the 32MB window: open-bus 0xFF fill.
  assert.equal(await readMem32(handle, 0x09FFFFFC), 0xFFFFFFFF, '0x09FFFFFC (beyond ROM length) should read open-bus 0xFF fill');

  // Wait-state 1 (0x0A/0x0B): for a standard ROM this mirrors the SAME
  // first-32MB window (no second bank exists yet).
  assert.equal(await readMem32(handle, 0x0A000000), readLE32(rom, 0x0), '0x0A000000 should mirror rom[0] (no 64MB bank on a standard ROM)');
  assert.equal(await readMem32(handle, 0x0A000004), readLE32(rom, 0x4), '0x0A000004 should mirror rom[4]');
  assert.equal(await readMem32(handle, 0x0BFFFFFC), 0xFFFFFFFF, '0x0BFFFFFC (beyond ROM length) should read open-bus 0xFF fill');

  // Wait-state 2 (0x0C/0x0D): wraps via `addr % rom.length`, so it never
  // reads open bus — it wraps back into the real ROM content instead.
  assert.equal(await readMem32(handle, 0x0C000000), readLE32(rom, 0x0), '0x0C000000 should read rom[0]');
  const expectedOffset = 0x1FFFFFC % SIZE;
  const expected = readLE32(rom, expectedOffset - (expectedOffset % 4)); // word-align defensively
  assert.equal(await readMem32(handle, 0x0DFFFFFC), expected, `0x0DFFFFFC should wrap to rom[${expectedOffset}] via modulo, not open bus`);
});

test('extended (>32MB) ROM: wait-state 1 exposes a distinct second 32MB bank, wait-state 2 does not', async () => {
  const SIZE = 40 * 1024 * 1024; // 40MB: bigger than ROM_32MB, so the second-bank path activates
  assert.ok(SIZE > ROM_32MB, 'test fixture must exceed the 32MB threshold to exercise the extended-ROM path');
  const rom = Buffer.alloc(SIZE, 0);
  writeLE32(rom, 0x0, 0xAAAAAAAA); // first-bank start marker
  writeLE32(rom, 0x4, 0xBBBBBBBB);
  writeLE32(rom, ROM_32MB, 0xCCCCCCCC); // second-bank start marker
  writeLE32(rom, ROM_32MB + 0x4, 0xDDDDDDDD);

  const handle = await bootCoreInteractive(rom);

  // Wait-state 0 always reads the first bank only, regardless of ROM size.
  assert.equal(await readMem32(handle, 0x08000000), readLE32(rom, 0x0), '0x08000000 should always read the first bank');
  assert.equal(await readMem32(handle, 0x08000004), readLE32(rom, 0x4));

  // Wait-state 1 (0x0A/0x0B) adds +32MB to the offset once the ROM is
  // longer than 32MB, exposing the SECOND bank instead of mirroring the first.
  assert.equal(await readMem32(handle, 0x0A000000), readLE32(rom, ROM_32MB), '0x0A000000 should read the second 32MB bank, not mirror the first');
  assert.equal(await readMem32(handle, 0x0A000004), readLE32(rom, ROM_32MB + 0x4));
  // Near the end of the (mapped) second bank, offset 0x1FFFFFC+32MB lands
  // beyond this 40MB fixture's length -> open-bus fallback.
  assert.equal(await readMem32(handle, 0x0BFFFFFC), 0xFFFFFFFF, '0x0BFFFFFC beyond the 40MB fixture should read open-bus 0xFF fill');

  // Wait-state 2 (0x0C/0x0D) is DIFFERENT: it always wraps via
  // `addr % rom.length` over the FULL rom length, not a fixed 32MB
  // window — so near the 32MB boundary it does NOT expose the second
  // bank the way wait-state 1 does. This is a real, non-obvious asymmetry
  // in the core worth calling out explicitly (see DEBUG_EMULATOR_REPORT.md).
  assert.equal(await readMem32(handle, 0x0C000000), readLE32(rom, 0x0), '0x0C000000 should read the first bank');
  const offset = 0x1FFFFFC % SIZE; // < SIZE, so this just reads back into the first bank's tail, not the second bank
  assert.notEqual(offset, ROM_32MB, 'sanity check: this offset should NOT land on the second bank start');
  const expected = readLE32(rom, offset - (offset % 4));
  assert.equal(await readMem32(handle, 0x0DFFFFFC), expected, '0x0DFFFFFC should wrap within the full ROM length, NOT jump to the second bank');
});

test('padded (>32MB but uniform-filler upper half) ROM: trimmed to 32MB so 0x0A/0x0B mirrors the first bank', async () => {
  // Real-world case ("Shadow Realm" pokeemerald hack): the file is padded to
  // 64MB with 0xFF, all real data lives below 32MB, and the game reads via
  // the 0x0A/0x0B wait-state mirror expecting first-bank data. Without the
  // trim, extended-64MB mapping serves it the 0xFF filler (green screen).
  const SIZE = 40 * 1024 * 1024;
  const rom = Buffer.alloc(SIZE, 0);
  writeLE32(rom, 0x0, 0x11223344);
  writeLE32(rom, 0x127F16C, 0x600DDA7A); // the exact kind of offset that failed on-device
  rom.fill(0xFF, ROM_32MB); // uniform filler upper half

  const handle = await bootCoreInteractive(rom);

  // Should behave exactly like a standard ROM: 0x0A/0x0B mirrors bank 0.
  assert.equal(await readMem32(handle, 0x0A000000), readLE32(rom, 0x0), '0x0A000000 should mirror rom[0] after padded-ROM trim');
  assert.equal(await readMem32(handle, 0x0B27F16C), readLE32(rom, 0x127F16C), '0x0B27F16C should mirror rom[0x127F16C], not read 0xFF padding');
});

test('extended (>32MB) ROM: CPU executes code fetched from the second bank (0x0A region)', async () => {
  const SIZE = 34 * 1024 * 1024; // >32MB so 0x0A maps the second bank
  const rom = Buffer.alloc(SIZE, 0);

  // Entry point (0x08000000): b 0x0A000000 — offset = (0x0A000000-(0x08000000+8))/4 = 0x7FFFFE
  writeLE32(rom, 0x0, 0xEA7FFFFE);

  // Second bank, executed at 0x0A000000:
  //   ldr r1,[pc,#8]      ; literal at +0x10
  //   mov r0,#0x02000000
  //   str r1,[r0]
  //   b .
  writeLE32(rom, ROM_32MB + 0x0, 0xE59F1008);
  writeLE32(rom, ROM_32MB + 0x4, 0xE3A00402);
  writeLE32(rom, ROM_32MB + 0x8, 0xE5801000);
  writeLE32(rom, ROM_32MB + 0xC, 0xEAFFFFFE);
  writeLE32(rom, ROM_32MB + 0x10, 0xCAFEF00D);

  const handle = await bootCoreInteractive(rom);
  // Pump a few animation frames so the CPU actually runs.
  for (let t = 0; t < 10; t++) {
    handle.advanceTime(16);
    const due = handle.rafQueue.slice();
    handle.rafQueue.length = 0;
    due.forEach((e) => e.fn());
  }

  assert.equal(await readMem32(handle, 0x02000000), 0xCAFEF00D,
    'marker written by code executing at 0x0A000000 (second bank) should land in EWRAM');
});
