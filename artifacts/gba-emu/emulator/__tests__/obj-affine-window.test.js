// PPU affine sprites + windows, asserted against real rendered output:
//  1. An affine sprite with an identity matrix renders exactly like a normal
//     sprite (8.8 fixed-point mapping, center-relative).
//  2. Double-size + pa=pd=0.5 scales the sprite up 2x inside the 2x field.
//  3. WIN0 clips a BG: enabled inside (WININ bit0), disabled outside
//     (WINOUT bit0 clear); OBJ stays visible outside via WINOUT bit4.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

function rgb5(c) { return (((c & 0x1F) * 527 + 23) >> 6) & 0xFF; }
function argb(c15) {
  return (0xFF000000 | (rgb5(c15 >>> 10) << 16) | (rgb5(c15 >>> 5) << 8) | rgb5(c15)) >>> 0;
}

const COL_BACKDROP = 0x0000; // black
const COL_BG0 = 0x001F;      // red
const COL_SPR_A = 0x7C00;    // blue  (OBJ pal 0) — identity affine sprite
const COL_SPR_B = 0x7FFF;    // white (OBJ pal 1) — double-size scaled sprite

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

  // Palettes.
  store16(COL_BACKDROP, 0x05000000);
  store16(COL_BG0, 0x05000002);
  store16(COL_SPR_A, 0x05000202);
  store16(COL_SPR_B, 0x05000222);
  // 4bpp solid tile 1 for BG (char base 0) and OBJ.
  for (let w = 0; w < 8; w++) {
    store32(0x11111111, 0x06000020 + w * 4);
    store32(0x11111111, 0x06010020 + w * 4);
  }
  // BG0: char base 0, screen base 8, priority 0. Tile 1 at map cell (0,0).
  store16(0x0800, 0x04000008);
  store16(0x0001, 0x06004000);

  // OAM 0: AFFINE (identity, group 0), 8x8, x=100, y=40, pal 0 (blue).
  store16(40 | 0x100, 0x07000000);
  store16(100, 0x07000002);          // group 0 in bits 9-13
  store16(0x0001, 0x07000004);
  // OAM 1: AFFINE + DOUBLE-SIZE (group 1), 8x8, x=140, y=40, pal 1 (white).
  store16(40 | 0x300, 0x07000008);
  store16(140 | (1 << 9), 0x0700000A);
  store16(0x1001, 0x0700000C);
  // Affine group 0 = identity (256,0,0,256).
  store16(256, 0x07000006);
  store16(0, 0x0700000E);
  store16(0, 0x07000016);
  store16(256, 0x0700001E);
  // Affine group 1 = scale up 2x (pa=pd=0.5 in 8.8).
  store16(128, 0x07000026);
  store16(0, 0x0700002E);
  store16(0, 0x07000036);
  store16(128, 0x0700003E);

  // WIN0: x 0..4, y 0..8. Inside: BG0 only. Outside: OBJ only (+fx bit).
  store16(0x0004, 0x04000040); // WIN0H: X1=0, X2=4
  store16(0x0008, 0x04000044); // WIN0V: Y1=0, Y2=8
  store16(0x0001, 0x04000048); // WININ: BG0
  store16(0x0030, 0x0400004A); // WINOUT: OBJ + effects

  // DISPCNT: mode 0, 1D OBJ mapping, BG0 + OBJ + WIN0.
  store16(0x3140, 0x04000000);

  const spin = a;
  emit(0xEA000000 | (((spin - (a + 8)) >> 2) & 0xFFFFFF));
  return rom;
}

test('PPU: affine sprites (identity + double-size scale) and WIN0/WINOUT gating', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 10 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }

  const row = (y) => {
    send({ type: 'readPixelRow', y });
    const m = posted.filter((x) => x.type === 'pixelRow').pop();
    const p = m.payload || m;
    assert.equal(p.y, y);
    return p.row;
  };

  // Window: BG0 tile covers x 0..7 at y 0..7, but WIN0 only spans x 0..3.
  const r2 = row(2);
  assert.equal(r2[2] >>> 0, argb(COL_BG0), 'BG0 visible inside WIN0');
  assert.equal(r2[6] >>> 0, argb(COL_BACKDROP), 'BG0 clipped outside WIN0 (WINOUT bg0=0)');

  const r42 = row(42);
  // Identity affine sprite: exactly x 100..107, visible via WINOUT OBJ bit.
  assert.equal(r42[100] >>> 0, argb(COL_SPR_A), 'identity affine sprite left edge');
  assert.equal(r42[107] >>> 0, argb(COL_SPR_A), 'identity affine sprite right edge');
  assert.equal(r42[99] >>> 0, argb(COL_BACKDROP), 'no pixel left of affine sprite');
  assert.equal(r42[108] >>> 0, argb(COL_BACKDROP), 'no pixel right of affine sprite');
  // Double-size scaled 2x: fills the 16px field, x 140..155.
  assert.equal(r42[141] >>> 0, argb(COL_SPR_B), 'scaled sprite near left of 2x field');
  assert.equal(r42[154] >>> 0, argb(COL_SPR_B), 'scaled sprite near right of 2x field');

  const r50 = row(50);
  // Identity sprite is only 8 tall (rows 40..47); the 2x field spans 40..55.
  assert.equal(r50[102] >>> 0, argb(COL_BACKDROP), 'identity sprite ends at row 47');
  assert.equal(r50[148] >>> 0, argb(COL_SPR_B), 'double-size field extends to row 55');
});
