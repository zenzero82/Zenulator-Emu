// HLE BIOS ObjAffineSet (SWI 0x0F) and BgAffineSet (SWI 0x0E).
// Grow/shrink and rotation animations (e.g. a scaling portal sprite) compute
// their OAM affine matrices through ObjAffineSet; if the SWI silently no-ops
// the params stay stale/zero and the sprite flashes instead of scaling.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

function buildRom() {
  const rom = Buffer.alloc(0x2000);
  const w32 = (a, v) => rom.writeUInt32LE(v >>> 0, a);
  w32(0x00, 0xEA00002E); // b 0xC0
  rom[0xB2] = 0x96;

  let a = 0xC0;
  const emit = (v) => { w32(a, v); a += 4; };
  const LIT = 0x600; const lit = {}; let litN = 0;
  const L = (v) => { v >>>= 0; if (!(v in lit)) { lit[v] = LIT + litN * 4; w32(LIT + litN * 4, v); litN++; } return lit[v]; };
  const ldrLit = (rd, v) => { const off = L(v) - (a + 8); emit(0xE59F0000 | (rd << 12) | off); };
  const store32 = (val, addr) => { ldrLit(0, val); ldrLit(1, addr); emit(0xE5810000); };
  const store16 = (val, addr) => { ldrLit(0, val); ldrLit(1, addr); emit(0xE1C100B0); };

  // ObjAffineSet source: three PACKED 6-byte units (s16 sx, s16 sy,
  // u16 alpha — the BIOS record has NO padding).
  // Unit 1: sx=2.0 (0x200), sy=0.5 (0x080), angle 0.
  store16(0x0200, 0x02000000);
  store16(0x0080, 0x02000002);
  store16(0x0000, 0x02000004);
  // Unit 2: same scales, angle 90 deg (0x4000).
  store16(0x0200, 0x02000006);
  store16(0x0080, 0x02000008);
  store16(0x4000, 0x0200000A);
  // Unit 3: same scales, angle 45 deg (0x2000) — non-cardinal.
  store16(0x0200, 0x0200000C);
  store16(0x0080, 0x0200000E);
  store16(0x2000, 0x02000010);
  ldrLit(0, 0x02000000);
  ldrLit(1, 0x07000006); // OAM affine group 0's pa
  emit(0xE3A02003);      // mov r2, #3  (three calculations)
  emit(0xE3A03008);      // mov r3, #8  (OAM-interleaved param stride)
  emit(0xEF0F0000);      // swi ObjAffineSet

  // BgAffineSet source: one 20-byte unit. Origin (16.0, 32.0) in 19.8,
  // display center (8, 4), scale 1.0/1.0, angle 0.
  store32(0x00001000, 0x02000020);
  store32(0x00002000, 0x02000024);
  store16(0x0008, 0x02000028);
  store16(0x0004, 0x0200002A);
  store16(0x0100, 0x0200002C);
  store16(0x0100, 0x0200002E);
  store16(0x0000, 0x02000030);
  ldrLit(0, 0x02000020);
  ldrLit(1, 0x02000100);
  emit(0xE3A02001);      // mov r2, #1
  emit(0xEF0E0000);      // swi BgAffineSet

  const spin = a;
  emit(0xEA000000 | (((spin - (a + 8)) >> 2) & 0xFFFFFF));
  return rom;
}

test('BIOS ObjAffineSet/BgAffineSet write correct affine matrices', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 3 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }

  const read32 = (addr) => {
    send({ type: 'readMem32', addr });
    const m = posted.filter((x) => x.type === 'mem32').pop();
    return ((m.payload || m).value) >>> 0;
  };
  // OAM group 0 (angle 0): pa=sx, pb=0, pc=0, pd=sy. Each param is the high
  // half of the word at (offset & ~3).
  assert.equal(read32(0x07000004) >>> 16, 0x0200, 'pa = sx at angle 0');
  assert.equal(read32(0x0700000C) >>> 16, 0x0000, 'pb = 0 at angle 0');
  assert.equal(read32(0x07000014) >>> 16, 0x0000, 'pc = 0 at angle 0');
  assert.equal(read32(0x0700001C) >>> 16, 0x0080, 'pd = sy at angle 0');
  // OAM group 1 (90 deg): pa=0, pb=-sx, pc=sy, pd=0.
  assert.equal(read32(0x07000024) >>> 16, 0x0000, 'pa = 0 at 90deg');
  assert.equal(read32(0x0700002C) >>> 16, 0xFE00, 'pb = -sx at 90deg');
  assert.equal(read32(0x07000034) >>> 16, 0x0080, 'pc = sy at 90deg');
  assert.equal(read32(0x0700003C) >>> 16, 0x0000, 'pd = 0 at 90deg');
  // OAM group 2 (45 deg, sin=cos=181/256): fixed-point products with
  // arithmetic >>8. pa=(512*181)>>8=362, pb=(-512*181)>>8=-362, pc=pd=90.
  assert.equal(read32(0x07000044) >>> 16, 0x016A, 'pa at 45deg');
  assert.equal(read32(0x0700004C) >>> 16, 0xFE96, 'pb = -362 at 45deg');
  assert.equal(read32(0x07000054) >>> 16, 0x005A, 'pc at 45deg');
  assert.equal(read32(0x0700005C) >>> 16, 0x005A, 'pd at 45deg');
  // BgAffineSet: identity matrix, start = origin - center mapped through it.
  assert.equal(read32(0x02000100), 0x00000100, 'pb<<16 | pa');
  assert.equal(read32(0x02000104), 0x01000000, 'pd<<16 | pc');
  assert.equal(read32(0x02000108), 0x00000800, 'startX = 0x1000 - 8*0x100');
  assert.equal(read32(0x0200010C), 0x00001C00, 'startY = 0x2000 - 4*0x100');
});
