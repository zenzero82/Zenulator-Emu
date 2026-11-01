// MOSAIC (0x400004C) regressions, asserted against rendered output:
//  1. BG mosaic (BGCNT bit 6): horizontal blocks repeat the leftmost pixel;
//     vertical blocks repeat the top line of the screen-aligned block.
//  2. OBJ mosaic (attr0 bit 12): same, using the OBJ nibbles of MOSAIC.
// Tile pattern: row 0 = color 1 at px0 then color 2; rows 1-7 all color 2.
// With an 8x8 mosaic every pixel of the tile must show row0/px0's color 1.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

function rgb5(c) { return (((c & 0x1F) * 527 + 23) >> 6) & 0xFF; }
function argb(c15) {
  return (0xFF000000 | (rgb5(c15 >>> 10) << 16) | (rgb5(c15 >>> 5) << 8) | rgb5(c15)) >>> 0;
}

const COL_BG_1 = 0x001F;  // red   (BG color 1)
const COL_BG_2 = 0x03E0;  // green (BG color 2)
const COL_OBJ_1 = 0x7C00; // blue  (OBJ pal0 color 1)
const COL_OBJ_2 = 0x7FFF; // white (OBJ pal0 color 2)
const COL_OBJ1_2 = 0x03FF; // yellow (OBJ pal1 color 2)

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
  store16(0x0000, 0x05000000);      // backdrop black
  store16(COL_BG_1, 0x05000002);
  store16(COL_BG_2, 0x05000004);
  store16(COL_OBJ_1, 0x05000202);
  store16(COL_OBJ_2, 0x05000204);
  store16(COL_OBJ1_2, 0x05000224); // OBJ pal1 color 2
  // Tile 1 pattern (4bpp, little-endian nibbles: low nibble = left pixel):
  // row 0: px0 = color 1, px1-7 = color 2; rows 1-7: all color 2.
  store32(0x22222221, 0x06000020);  // BG tile 1 row 0
  store32(0x22222221, 0x06010020);  // OBJ tile 1 row 0
  for (let w = 1; w < 8; w++) {
    store32(0x22222222, 0x06000020 + w * 4);
    store32(0x22222222, 0x06010020 + w * 4);
  }
  // BG0: char base 0, screen base 8, priority 0, MOSAIC ON (bit 6).
  store16(0x0840, 0x04000008);
  store16(0x0001, 0x06004000);      // tile 1 at map cell (0,0)

  // OBJ 0: 8x8 sprite at x=96 (mosaic-grid aligned), y=40, MOSAIC (attr0 bit12).
  store16(40 | 0x1000, 0x07000000);
  store16(96, 0x07000002);
  store16(0x0001, 0x07000004);
  // OBJ 1: UNALIGNED mosaic sprite at (137,41), palette 1 (clear of OBJ 0).
  // Its first screen block (136..143 x 40..47) sources from OUTSIDE the
  // sprite (sprite x=-1 / line=-1) -> must stay transparent.
  store16(41 | 0x1000, 0x07000008);
  store16(137, 0x0700000A);
  store16(0x1001, 0x0700000C);

  // MOSAIC: BG H=V=8, OBJ H=V=8.
  store16(0x7777, 0x0400004C);

  // DISPCNT: mode 0, 1D OBJ mapping, BG0 + OBJ.
  store16(0x1140, 0x04000000);

  const spin = a;
  emit(0xEA000000 | (((spin - (a + 8)) >> 2) & 0xFFFFFF));
  return rom;
}

test('PPU: BG and OBJ mosaic repeat the top-left pixel of each 8x8 block', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 10 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }

  const row = (y) => {
    send({ type: 'readPixelRow', y });
    const m = posted.filter((x) => x.type === 'pixelRow').pop();
    const p = m.payload || m;
    assert.equal(p.y, y);
    return p.row;
  };

  // BG horizontal mosaic: raw pixel at (6,0) is color 2; block repeats px0.
  const r0 = row(0);
  assert.equal(r0[6] >>> 0, argb(COL_BG_1), 'BG H mosaic repeats leftmost pixel');
  // BG vertical (+horizontal) mosaic: raw row 5 is all color 2; block shows row 0.
  const r5 = row(5);
  assert.equal(r5[0] >>> 0, argb(COL_BG_1), 'BG V mosaic repeats top line');
  assert.equal(r5[6] >>> 0, argb(COL_BG_1), 'BG V+H mosaic shows top-left pixel');

  // OBJ mosaic: at screen row 45 (sprite row 5) and x=102 (sprite px 6) the
  // raw sample is color 2; the screen-aligned 8x8 block starts at (96,40),
  // i.e. sprite pixel (0,0) = color 1 (blue).
  const r45 = row(45);
  assert.equal(r45[102] >>> 0, argb(COL_OBJ_1), 'OBJ mosaic shows block top-left pixel');

  // Unaligned sprite at (137,41): the whole first screen block (rows 40..47)
  // sources line -1 of the sprite -> transparent, NOT a clamped repeat.
  const r41 = row(41);
  assert.equal(r41[138] >>> 0, argb(0x0000), 'leading partial block row is transparent');
  // Row 48 (block 48..55 -> sprite line 7): x 136..143 sources sprite x=-1
  // (transparent); x=144 block sources sprite px (7,7) = pal1 color 2.
  const r48 = row(48);
  assert.equal(r48[140] >>> 0, argb(0x0000), 'leading partial block column is transparent');
  assert.equal(r48[144] >>> 0, argb(COL_OBJ1_2), 'aligned block samples in-sprite texel');
});
