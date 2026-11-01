// GBATEK: RegisterRamReset (SWI 0x01) ALWAYS sets DISPCNT to 0x0080 (forced
// blank), regardless of the flags argument. pokeemerald-family gpu_regs.c
// only writes DISPSTAT immediately while forced blank is set (or VCOUNT is
// in VBlank); without this side effect the boot-time DISPSTAT VBlank-enable
// write is buffered forever, no IRQ ever fires, and the first
// VBlankIntrWait halts for good.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

function buildRom() {
  const rom = Buffer.alloc(0x1000);
  const w32 = (a, v) => rom.writeUInt32LE(v >>> 0, a);
  w32(0x00, 0xEA00002E); // b 0xC0
  rom[0xB2] = 0x96;
  let a = 0xC0;
  const emit = (v) => { w32(a, v); a += 4; };
  emit(0xE3A0DB0D);  // mov sp, #0x3400 -> wrong; use ldr below instead
  a = 0xC0;          // rewrite: use literal for sp
  w32(0x600, 0x03007F00);
  emit(0xE59FD000 | (0x600 - (a + 8))); // ldr sp,=0x03007F00
  emit(0xE3A00000);  // mov r0,#0 (flags = 0: clear nothing)
  emit(0xEF010000);  // swi 0x01 RegisterRamReset
  const spin = a;
  emit(0xEA000000 | (((spin - (a + 8)) >> 2) & 0xFFFFFF)); // b spin
  return rom;
}

test('RegisterRamReset forces DISPCNT to 0x0080 (forced blank)', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 3 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }
  send({ type: 'readMem32', addr: 0x04000000 });
  const m = posted.filter((x) => x.type === 'mem32').pop();
  const p = m.payload || m;
  assert.equal(p.value & 0xFFFF, 0x0080, 'DISPCNT must be 0x0080 after RegisterRamReset');
});
