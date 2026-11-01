// Color-effect regressions, asserted against real rendered output:
//  1. A semi-transparent OBJ (gfx mode 1) forces an eva/evb alpha blend with
//     the second-target layer below it, regardless of the BLDCNT effect bits.
//  2. Effect 3 (darken) applies BLDY to first-target BGs elsewhere.
// The expected values are hand-computed from GBATEK's blend equations, so a
// too-dark/too-light blend (e.g. swapped eva/evb, wrong shift) fails loudly.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

function rgb5(c) { return (((c & 0x1F) * 527 + 23) >> 6) & 0xFF; }
function argb(c15) {
  return (0xFF000000 | (rgb5(c15 >>> 10) << 16) | (rgb5(c15 >>> 5) << 8) | rgb5(c15)) >>> 0;
}
function blend555(a, b, eva, evb) {
  const r = Math.min(31, (((a & 0x1F) * eva + (b & 0x1F) * evb) >> 4));
  const g = Math.min(31, ((((a >>> 5) & 0x1F) * eva + ((b >>> 5) & 0x1F) * evb) >> 4));
  const bl = Math.min(31, ((((a >>> 10) & 0x1F) * eva + ((b >>> 10) & 0x1F) * evb) >> 4));
  return r | (g << 5) | (bl << 10);
}
function darken555(c, evy) {
  const r = c & 0x1F, g = (c >>> 5) & 0x1F, b = (c >>> 10) & 0x1F;
  return (r - ((r * evy) >> 4)) | ((g - ((g * evy) >> 4)) << 5) | ((b - ((b * evy) >> 4)) << 10);
}

const COL_BG0 = 0x001F;   // red
const COL_SHADOW = 0x0000; // black shadow sprite (palette index 1, color black)

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

  // Palettes: backdrop white, BG0 color 1 red, OBJ color 1 black.
  store16(0x7FFF, 0x05000000);
  store16(COL_BG0, 0x05000002);
  store16(COL_SHADOW, 0x05000202);

  // 4bpp solid tile 1 for BG (char base 0) and OBJ.
  for (let w = 0; w < 8; w++) {
    store32(0x11111111, 0x06000020 + w * 4);
    store32(0x11111111, 0x06010020 + w * 4);
  }

  // BG0: char base 0, screen base 8, priority 0.
  store16(0x0800, 0x04000008);
  // BG0 tile at map cell (0,0) => x0-7 y0-7 (darken check region) and at
  // map cell (12,5) => x96-103 y40-47 (under the shadow sprite).
  store16(0x0001, 0x06004000);
  store16(0x0001, 0x06004000 + (5 * 32 + 12) * 2);

  // OAM: one 8x8 SEMI-TRANSPARENT sprite (attr0 gfx mode 01) at (100,40).
  store16(40 | 0x0400, 0x07000000); // y=40, gfx mode 1 (semi-transparent)
  store16(100, 0x07000002);
  store16(0x0001, 0x07000004);      // tile 1, priority 0, palette 0

  // BLDCNT: effect 3 (darken), first target BG0, second target BG0.
  //   => plain BG0 pixels darken by EVY; under the semi OBJ the forced
  //      eva/evb blend must win instead (effect bits ignored there).
  // (bits: firstMask=0x01, effect=3 -> 0xC0, secondMask BG0 -> 0x0100)
  store16(0x01C1, 0x04000050);
  store16(0x0808, 0x04000052); // BLDALPHA eva=8, evb=8
  store16(0x0008, 0x04000054); // BLDY evy=8

  // Full-screen WIN0 with the effects bit CLEAR inside (WININ=0x001F: BG0-3
  // + OBJ displayed, color effects disabled). Real hardware still applies
  // the FORCED semi-transparent OBJ blend in this state — only the
  // BLDCNT-selected effect is gated — which is exactly how pokeemerald-style
  // field shadows are drawn (regression: they rendered as opaque black).
  store16(0x00F0, 0x04000040); // WIN0H: X1=0, X2=240
  store16(0x00A0, 0x04000044); // WIN0V: Y1=0, Y2=160
  store16(0x001F, 0x04000048); // WININ: win0 shows all layers, NO effects
  store16(0x003F, 0x0400004A); // WINOUT (unused; win0 covers the screen)

  // DISPCNT: mode 0, BG0 + OBJ + WIN0 enable (bit 13).
  store16(0x3100, 0x04000000);

  const spin = a;
  emit(0xEA000000 | (((spin - (a + 8)) >> 2) & 0xFFFFFF));
  return rom;
}

test('PPU: semi-transparent OBJ forces eva/evb blend; darken elsewhere', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 10 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }

  const row = (y) => {
    send({ type: 'readPixelRow', y });
    const m = posted.filter((x) => x.type === 'pixelRow').pop();
    const p = m.payload || m;
    assert.equal(p.y, y);
    return p.row;
  };

  // Effect region: WIN0 covers the screen with effects DISABLED, so the
  // BLDCNT darken must NOT apply — plain BG0 red. (The window gates the
  // selected effect...)
  const r2 = row(2);
  assert.equal(r2[2] >>> 0, argb(COL_BG0), 'window fx-disable gates the BLDCNT darken');

  // Shadow region: (...but NOT the forced semi blend.) Black semi OBJ over
  // red BG0, eva=evb=8 -> 50/50 blend = half-red (r=15), NOT solid black,
  // even though WIN0's effects bit is clear here.
  const r42 = row(42);
  assert.equal(
    r42[102] >>> 0,
    argb(blend555(COL_SHADOW, COL_BG0, 8, 8)),
    'semi OBJ shadow is a 50/50 blend, not opaque black'
  );

  // probePixel diagnostic: valid coords return a trace showing the forced
  // semi blend despite the window's fx-disable; out-of-range coords are
  // rejected without disturbing renderer state or the framebuffer.
  send({ type: 'probePixel', x: 102, y: 42 });
  const t = posted.filter((m) => m.type === 'pixelTrace').pop();
  assert.equal(t.trace.semi, 1, 'probe sees the semi-transparent OBJ');
  assert.equal(t.trace.fxOK, false, 'window fx bit is off at the probe');
  assert.equal(t.trace.out, blend555(COL_SHADOW, COL_BG0, 8, 8), 'probe out is the forced blend');

  send({ type: 'probePixel', x: 5, y: 400 });
  const bad = posted.filter((m) => m.type === 'pixelTrace').pop();
  assert.equal(bad.error, 'out of range', 'invalid probe coords rejected');
  const r42b = row(42);
  assert.equal(r42b[102] >>> 0, r42[102] >>> 0, 'framebuffer row unchanged after probes');
});
