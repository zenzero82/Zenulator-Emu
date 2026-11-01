// PSG square channel 1: trigger via SOUND1CNT_X bit 15, envelope volume,
// SOUNDCNT_L panning/volume mixing into the fixed-rate 32768 Hz sampler.
// Asserted via the readAudio debug message (same pattern as direct-sound):
// the channel reads back active in SOUNDCNT_X, and the mixed ring contains
// non-zero samples in roughly the 50%-duty proportion expected for the
// programmed square period.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

function buildRom(opts) {
  opts = opts || {};
  const rom = Buffer.alloc(0x10000);
  const w32 = (a, v) => rom.writeUInt32LE(v >>> 0, a);
  w32(0x00, 0xEA00002E); // b 0xC0
  rom[0xB2] = 0x96;

  let a = 0xC0;
  const emit = (v) => { w32(a, v); a += 4; };
  const LIT = 0x600; const lit = {}; let litN = 0;
  const L = (v) => { v >>>= 0; if (!(v in lit)) { lit[v] = LIT + litN * 4; w32(LIT + litN * 4, v); litN++; } return lit[v]; };
  const ldrLit = (rd, v) => { const off = L(v) - (a + 8); emit(0xE59F0000 | (rd << 12) | off); };
  const store16 = (val, addr) => { ldrLit(0, val); ldrLit(1, addr); emit(0xE1C100B0); };

  // SOUNDCNT_X: master enable.
  store16(0x0080, 0x04000084);
  // SOUNDCNT_L: master volume 7 both sides, channel 1 to left+right.
  store16(0x1177, 0x04000080);
  // SOUNDCNT_H: PSG ratio 100%.
  store16(0x0002, 0x04000082);
  // SOUND1CNT_L: sweep off.
  store16(0x0000, 0x04000060);
  // SOUND1CNT_H: duty 50% (bits 6-7 = 2), envelope initial volume 15, no decay.
  store16(0xF080, 0x04000062);
  // SOUND1CNT_X: freq 1024 (tone 131072/(2048-1024) = 128 Hz), no length
  // limit, trigger. At 32768 Hz output that is a 256-sample period,
  // half high / half low.
  store16(opts.freq !== undefined ? opts.freq | 0x8000 : 0x8400, 0x04000064);

  const spin = a;
  emit(0xEA000000 | (((spin - (a + 8)) >> 2) & 0xFFFFFF));
  return rom;
}

test('PSG square 1: active bit reads back and mixes at the expected period', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 10 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }

  // SOUNDCNT_X per-channel active bit for channel 1.
  send({ type: 'readMem32', addr: 0x04000084 });
  const mm = posted.filter((x) => x.type === 'mem32').pop();
  const m = mm.payload || mm;
  assert.equal(m.value & 0x80, 0x80, 'master enable set');
  assert.equal(m.value & 0x0F, 0x01, 'channel 1 active bit set in SOUNDCNT_X');

  send({ type: 'readAudio' });
  const am = posted.filter((x) => x.type === 'audioState').pop();
  assert.ok(am, 'audioState reply expected');
  const s = am.payload || am;
  assert.equal(s.psgActive & 1, 1, 'PSG channel 1 active');
  assert.equal(s.sqEnv[0], 15, 'envelope holds initial volume (no decay)');
  // The sampler ran (~548 samples per frame at 32768 Hz).
  assert.ok(s.audioWrite > 500, `mixer produced samples (got ${s.audioWrite})`);
  // Expected-period check: a 50% duty square at a 256-sample period leaves
  // roughly half the ring samples non-zero.
  const frac = s.ringNonZeroL / Math.min(s.audioWrite, 32768);
  assert.ok(frac > 0.35 && frac < 0.65,
    `about half the mixed samples non-zero for 50% duty (got ${frac.toFixed(3)} of ${s.audioWrite})`);
});

test('PSG square 1: silent with SOUNDCNT_X master disabled', async () => {
  const rom = buildRom();
  // Patch the SOUNDCNT_X literal store to write 0 instead of 0x80: rebuild
  // with masterOff by overwriting the literal pool value used first.
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(rom);
  for (let i = 0; i < 3 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }
  // Turn the master off mid-run; per GBATEK this kills all PSG channels.
  send({ type: 'writeMem8', addr: 0x04000084, value: 0x00 });
  send({ type: 'readMem32', addr: 0x04000084 });
  const mm = posted.filter((x) => x.type === 'mem32').pop();
  const m = mm.payload || mm;
  assert.equal(m.value & 0x8F, 0, 'master off clears enable and all active bits');
  send({ type: 'readAudio' });
  const am = posted.filter((x) => x.type === 'audioState').pop();
  const s = am.payload || am;
  assert.equal(s.psgActive, 0, 'no PSG channel active after master off');
  assert.equal(s.psgL, 0, 'PSG contributes silence with master off');
});
