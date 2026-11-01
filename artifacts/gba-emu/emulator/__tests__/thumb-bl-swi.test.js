// Regression tests for two THUMB-mode PC-convention bugs that made real
// commercial ROMs (which are mostly THUMB code) hang or fly off into
// unmapped memory while the ARM-only fixture ROM ran fine:
//
//  1. THUMB BL prefix (Format 19) computed LR from pc+2 instead of pc+4,
//     so every THUMB BL landed 2 bytes SHORT of its target.
//  2. doSWI computed the return address as r[15]-4 unconditionally; in
//     THUMB mode r[15]=pc+4 during execute, so the "return address" was
//     the SWI's own address and the SWI re-executed forever.
//
// The test ROM boots in ARM, BXes into THUMB, does a BL to a marker
// function, then a Div SWI, and stores the results to EWRAM. The
// halfword immediately before the BL target is a poison `bx lr`: with
// the old off-by-2 BL bug, execution lands on it and returns without
// writing the marker, so the test fails loudly rather than accidentally
// sliding into the correct function.
//
// Run with: node --test emulator/__tests__/thumb-bl-swi.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootCoreInteractive } = require('../fixtures/run-core');

function w16(buf, off, v) { buf[off] = v & 0xFF; buf[off + 1] = (v >>> 8) & 0xFF; }
function w32(buf, off, v) { w16(buf, off, v & 0xFFFF); w16(buf, off + 2, (v >>> 16) & 0xFFFF); }

function buildThumbTestRom() {
  const rom = Buffer.alloc(0x100, 0);
  // ── ARM boot stub (execution starts at 0x08000000) ──
  w32(rom, 0x00, 0xE59F0000); // ldr r0, [pc, #0]      ; loads word at 0x08
  w32(rom, 0x04, 0xE12FFF10); // bx r0                  ; -> THUMB (bit0 set)
  w32(rom, 0x08, 0x0800000D); // literal: THUMB entry 0x0C | 1
  // ── THUMB main at 0x0C ──
  // BL func@0x28: offset = 0x28 - (0x0C + 4) = 0x18 → hi=0, lo=0x18>>1=0xC
  w16(rom, 0x0C, 0xF000);     // BL prefix
  w16(rom, 0x0E, 0xF80C);     // BL suffix
  w16(rom, 0x10, 0x2064);     // mov r0, #100
  w16(rom, 0x12, 0x2107);     // mov r1, #7
  w16(rom, 0x14, 0xDF06);     // swi 6 (Div) -> r0=14, r1=2
  w16(rom, 0x16, 0x4A02);     // ldr r2, [pc, #8]       ; literal at 0x20
  w16(rom, 0x18, 0x6050);     // str r0, [r2, #4]
  w16(rom, 0x1A, 0x6091);     // str r1, [r2, #8]
  w16(rom, 0x1C, 0xE7FE);     // b . (park forever)
  w16(rom, 0x1E, 0x0000);     // pad
  w32(rom, 0x20, 0x02000000); // literal: EWRAM result base
  w16(rom, 0x24, 0x0000);     // pad
  w16(rom, 0x26, 0x4770);     // POISON: bx lr — old off-by-2 BL lands here
  // ── func at 0x28: write marker 0xAB to [0x02000000], return ──
  w16(rom, 0x28, 0x20AB);     // mov r0, #0xAB
  w16(rom, 0x2A, 0x4901);     // ldr r1, [pc, #4]       ; literal at 0x30
  w16(rom, 0x2C, 0x6008);     // str r0, [r1, #0]
  w16(rom, 0x2E, 0x4770);     // bx lr
  w32(rom, 0x30, 0x02000000);
  return rom;
}

async function readMem32(handle, addr) {
  const before = handle.posted.length;
  handle.send({ type: 'readMem32', addr });
  const msg = handle.posted.slice(before).find((p) => p.type === 'mem32');
  assert.ok(msg, `expected a mem32 response for addr 0x${addr.toString(16)}`);
  return msg.value >>> 0;
}

test('THUMB BL lands on its exact target and THUMB SWI returns past the SWI', async () => {
  const handle = await bootCoreInteractive(buildThumbTestRom());
  // Pump animation frames so the core actually executes the ROM.
  for (let t = 0; t < 60; t++) {
    handle.advanceTime(16);
    const due = handle.rafQueue.slice();
    handle.rafQueue.length = 0;
    due.forEach((e) => e.fn());
  }
  assert.equal(await readMem32(handle, 0x02000000), 0xAB,
    'BL must land exactly on func (old bug: lands 2 bytes short on the poison bx lr, marker never written)');
  assert.equal(await readMem32(handle, 0x02000004), 14,
    'Div SWI quotient must be stored (old bug: THUMB SWI re-executes forever, never reaches the store)');
  assert.equal(await readMem32(handle, 0x02000008), 2,
    'Div SWI remainder must be stored');
});
