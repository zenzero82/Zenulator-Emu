// Regression test for ARM-mode SWI number extraction.
//
// In ARM mode the BIOS function number is encoded in bits 16-23 of the
// 24-bit SWI comment field (e.g. `swi 0x0B0000` = CpuSet), unlike THUMB
// where it is the low byte. The core previously masked the raw comment
// with 0xFF, turning every ARM-mode BIOS call into function 0 — so
// devkitARM-style crt0s that CpuSet-copy code/data at boot silently
// copied nothing, then jumped through a never-initialized pointer to
// address 0 (the real root cause of the "PC entered unmapped memory
// region (0xf90)" crash on real ROMs).
//
// The test ROM mimics that crt0 pattern: it CpuSet-copies a THUMB
// routine + a literal pool from ROM into IWRAM, then jumps through a
// pointer stored inside the COPIED block. With the old bug the copy is
// a no-op and the jump goes to 0; with the fix the copied routine runs
// and writes markers to EWRAM.
//
// Run with: node --test emulator/__tests__/arm-swi-number.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootCoreInteractive } = require('../fixtures/run-core');

function w16(b, o, v) { b[o] = v & 0xFF; b[o + 1] = (v >>> 8) & 0xFF; }
function w32(b, o, v) { w16(b, o, v & 0xFFFF); w16(b, o + 2, (v >>> 16) & 0xFFFF); }

function buildRom() {
  const rom = Buffer.alloc(0x200, 0);
  // ── ARM boot at 0x00 ──
  w32(rom, 0x00, 0xE59F0014); // ldr r0, [pc,#0x14] -> 0x1C: source (payload in ROM)
  w32(rom, 0x04, 0xE59F1014); // ldr r1, [pc,#0x14] -> 0x20: dest (IWRAM 0x03000000)
  w32(rom, 0x08, 0xE59F2014); // ldr r2, [pc,#0x14] -> 0x24: count (words, bit26=1 -> 32-bit)
  w32(rom, 0x0C, 0xEF0B0000); // swi 0x0B0000  (CpuSet — ARM encoding)
  w32(rom, 0x10, 0xE59F3014); // ldr r3, [pc,#0x14] -> 0x2C: pointer INSIDE the copied block
  w32(rom, 0x14, 0xE5933000); // ldr r3, [r3]       ; reads copied literal (0 if copy no-oped)
  w32(rom, 0x18, 0xE12FFF13); // bx r3
  w32(rom, 0x1C, 0x08000100); // src: payload at ROM 0x100
  w32(rom, 0x20, 0x03000000); // dst: IWRAM base
  w32(rom, 0x24, 0x04000004); // CpuSet cnt: 4 words, 32-bit mode (bit 26)
  w32(rom, 0x28, 0x00000000);
  w32(rom, 0x2C, 0x0300000C); // address of the copied literal (payload word 3)
  // ── payload at ROM 0x100 (copied to IWRAM 0x03000000) ──
  // THUMB routine at IWRAM+0: write marker to EWRAM, park.
  w16(rom, 0x100, 0x20CD);    // mov r0, #0xCD
  w16(rom, 0x102, 0x4901);    // ldr r1, [pc,#4] -> IWRAM+0x08
  w16(rom, 0x104, 0x6008);    // str r0, [r1]
  w16(rom, 0x106, 0xE7FE);    // b .
  w32(rom, 0x108, 0x02000000);// literal: EWRAM marker address
  w32(rom, 0x10C, 0x03000001);// function pointer: IWRAM routine | 1 (THUMB)
  return rom;
}

async function readMem32(handle, addr) {
  const before = handle.posted.length;
  handle.send({ type: 'readMem32', addr });
  const msg = handle.posted.slice(before).find((p) => p.type === 'mem32');
  assert.ok(msg, `expected a mem32 response for addr 0x${addr.toString(16)}`);
  return msg.value >>> 0;
}

test('ARM-mode swi 0x0B0000 dispatches CpuSet (bits 16-23), enabling the crt0 copy-then-jump pattern', async () => {
  const handle = await bootCoreInteractive(buildRom());
  for (let t = 0; t < 60; t++) {
    handle.advanceTime(16);
    const due = handle.rafQueue.slice();
    handle.rafQueue.length = 0;
    due.forEach((e) => e.fn());
  }
  assert.equal(await readMem32(handle, 0x03000000), 0x490120CD,
    'CpuSet must actually copy the payload into IWRAM (old bug: ARM SWI number read as 0, copy no-oped)');
  assert.equal(await readMem32(handle, 0x02000000), 0xCD,
    'the copied IWRAM routine must run and write its marker (old bug: jump through null pointer to address 0)');
});
