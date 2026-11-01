// PPU compositor regressions, asserted against real rendered output via the
// readPixelRow debug message:
//  1. Overlapping sprites resolve by OAM index (lowest wins), NOT by the
//     priority attribute — GBATEK "OBJ Priority" OAM-order semantics.
//  2. The winning sprite's priority attribute is what competes with BGs: a
//     lower-priority (higher number) OBJ sits BEHIND a higher-priority BG.
//  3. BG-vs-BG stacking follows BGCNT priority bits, not BG number.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

// 15-bit BGR555 -> the core's ARGB conversion (rgb5 in html.ts)
function rgb5(c) { return (((c & 0x1F) * 527 + 23) >> 6) & 0xFF; }
function argb(c15) {
  return (0xFF000000 | (rgb5(c15 >>> 10) << 16) | (rgb5(c15 >>> 5) << 8) | rgb5(c15)) >>> 0;
}

const COL_BACKDROP = 0x0000; // black
const COL_BG0 = 0x001F;      // red   (BG palette 0, color 1)
const COL_BG1 = 0x03E0;      // green (BG palette 1, color 1)
const COL_SPR_A = 0x7C00;    // blue  (OBJ palette 0, color 1) — OAM index 0
const COL_SPR_B = 0x7FFF;    // white (OBJ palette 1, color 1) — OAM index 1

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
  // str r0,[r1] then r1 += 4 helper sequences are emitted inline below.
  const store32 = (val, addr) => { ldrLit(0, val); ldrLit(1, addr); emit(0xE5810000); };
  const store16 = (val, addr) => { ldrLit(0, val); ldrLit(1, addr); emit(0xE1C100B0); };

  // Palettes.
  store16(COL_BACKDROP, 0x05000000); // backdrop (BG palette 0, color 0)
  store16(COL_BG0, 0x05000002);      // BG palette 0, color 1
  store16(COL_BG1, 0x05000022);      // BG palette 1, color 1
  store16(COL_SPR_A, 0x05000202);    // OBJ palette 0, color 1
  store16(COL_SPR_B, 0x05000222);    // OBJ palette 1, color 1

  // 4bpp tile 1 = solid color index 1, at char base 0 (BG) and OBJ tiles.
  for (let w = 0; w < 8; w++) {
    store32(0x11111111, 0x06000020 + w * 4);  // BG tile 1 (char base 0)
    store32(0x11111111, 0x06010020 + w * 4);  // OBJ tile 1
  }

  // BG0: char base 0, screen base 8 (0x4000), priority 1 -> BGCNT = 0x0801
  store16(0x0801, 0x04000008);
  // BG1: char base 0, screen base 9 (0x4800), priority 0 -> BGCNT = 0x0900
  store16(0x0900, 0x0400000A);
  // Map entries: both BGs show tile 1 in the top-left map cell (x 0-7, y 0-7).
  // BG0 uses palette 0, BG1 uses palette 1 (bits 12-15).
  store16(0x0001, 0x06004000);
  store16(0x1001, 0x06004800);
  // BG0 additionally shows tile 1 in map cell (1,0) => x 8-15 where BG1 is
  // transparent, proving BG0 still renders where the higher-priority BG1
  // has no opaque pixel.
  store16(0x0001, 0x06004002);

  // OAM: two 8x8 sprites overlapping at (x=100, y=40).
  //  index 0: priority 1, palette 0 (blue)  -> attr2 = tile1 | pr1 | pal0
  //  index 1: priority 0, palette 1 (white) -> attr2 = tile1 | pr0 | pal1
  // Hardware: index 0 wins the OBJ layer despite its WORSE priority.
  store16(40, 0x07000000);            // attr0: y=40, square, 4bpp
  store16(100, 0x07000002);           // attr1: x=100, size 0 (8x8)
  store16(0x0401, 0x07000004);        // attr2: tile 1, priority 1, pal 0
  store16(40, 0x07000008);
  store16(100, 0x0700000A);
  store16(0x1001, 0x0700000C);        // attr2: tile 1, priority 0, pal 1
  // A third sprite at (x=120, y=40), priority 1, palette 1: with all BGs
  // transparent there it must still show; nothing occludes it.
  store16(40, 0x07000010);
  store16(120, 0x07000012);
  store16(0x1401, 0x07000014);        // tile 1, priority 1, pal 1
  // BG0 map cell covering x=96..103 at y=40? Sprite priority-vs-BG check:
  // put BG0 (priority 1) and BG1 (priority 0) tiles under the sprites at
  // map row 5 (y 40-47), map col 12 (x 96-103):
  store16(0x0001, 0x06004000 + (5 * 32 + 12) * 2); // BG0 under sprites
  store16(0x1001, 0x06004800 + (5 * 32 + 12) * 2); // BG1 under sprites

  // DISPCNT: mode 0, BG0+BG1+OBJ, 1D OBJ mapping off (2D fine for 8x8).
  store16(0x1300, 0x04000000);

  // Idle: spin forever (frames keep rendering).
  const spin = a;
  emit(0xEA000000 | (((spin - (a + 8)) >> 2) & 0xFFFFFF)); // b spin
  return rom;
}

test('PPU: OAM-order OBJ resolution, OBJ-vs-BG priority, BG priority bits', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 10 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }

  const row = (y) => {
    send({ type: 'readPixelRow', y });
    const m = posted.filter((x) => x.type === 'pixelRow').pop();
    const p = m.payload || m;
    assert.equal(p.y, y);
    return p.row;
  };

  // BG-vs-BG: at (2,2) both BGs opaque; BG1 (priority 0) must beat BG0
  // (priority 1) even though BG0 has the lower BG number.
  const r2 = row(2);
  assert.equal(r2[2] >>> 0, argb(COL_BG1), 'BG1 (pr0) should cover BG0 (pr1)');
  // At x=10 only BG0 is opaque -> BG0 red shows.
  assert.equal(r2[10] >>> 0, argb(COL_BG0), 'BG0 shows where BG1 transparent');
  // Far right: backdrop.
  assert.equal(r2[200] >>> 0, argb(COL_BACKDROP), 'backdrop elsewhere');

  const r42 = row(42);
  // Overlapping sprites at x=100..107 above BG1 (pr0) + BG0 (pr1):
  // OAM index 0 wins the OBJ layer (blue) despite priority 1 vs index 1's
  // priority 0 — but its priority-1 attribute loses to BG1 (priority 0),
  // so the BG1 green must show on top. This is the hardware OAM-order +
  // winner-priority behavior; a "sort sprites by priority" implementation
  // would wrongly show the white sprite here.
  assert.equal(r42[102] >>> 0, argb(COL_BG1), 'winning sprite (pr1) hides behind BG1 (pr0)');
  // Sprite at x=120..127 with nothing under it: visible.
  assert.equal(r42[122] >>> 0, argb(COL_SPR_B), 'lone sprite visible over backdrop');
});
