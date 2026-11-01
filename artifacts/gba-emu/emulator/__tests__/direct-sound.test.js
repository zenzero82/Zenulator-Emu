// Direct Sound (FIFO A) pipeline: CPU primes the FIFO, timer 0 overflows pop
// one signed sample each, and when the FIFO drains to <=16 bytes the special
// (timing-mode-3) DMA1 refills 4 words from an incrementing ROM source.
// Asserted via the readAudio debug message: dsA holds the sample data value,
// the FIFO stays fed by DMA, and the fixed-rate mixer produced samples.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

const SAMPLE = 0x40; // every sample byte in the ROM's sound buffer

function buildRom(opts) {
  opts = opts || {};
  const masterOn = opts.masterOn !== false;
  const repeat = opts.repeat !== false;
  // Big enough that the incrementing DMA source can't run past the ROM end
  // during the test (each timer overflow consumes one sample byte).
  const rom = Buffer.alloc(0x10000);
  const w32 = (a, v) => rom.writeUInt32LE(v >>> 0, a);
  w32(0x00, 0xEA00002E); // b 0xC0
  rom[0xB2] = 0x96;

  // Sound sample buffer at ROM 0x800: constant signed bytes.
  rom.fill(SAMPLE, 0x800, 0x10000);

  let a = 0xC0;
  const emit = (v) => { w32(a, v); a += 4; };
  const LIT = 0x600; const lit = {}; let litN = 0;
  const L = (v) => { v >>>= 0; if (!(v in lit)) { lit[v] = LIT + litN * 4; w32(LIT + litN * 4, v); litN++; } return lit[v]; };
  const ldrLit = (rd, v) => { const off = L(v) - (a + 8); emit(0xE59F0000 | (rd << 12) | off); };
  const store32 = (val, addr) => { ldrLit(0, val); ldrLit(1, addr); emit(0xE5810000); };
  const store16 = (val, addr) => { ldrLit(0, val); ldrLit(1, addr); emit(0xE1C100B0); };

  // SOUNDCNT_X: master enable (or off — the FIFO machine must run anyway).
  store16(masterOn ? 0x0080 : 0x0000, 0x04000084);
  // SOUNDCNT_H: DS A full volume (bit2), A right+left (bits 8,9), timer 0
  // (bit 10 = 0), plus FIFO A reset (bit 11).
  store16(0x0B04, 0x04000082);
  // DMA1: src = ROM 0x800 (incrementing), dst = FIFO_A (fixed), special
  // timing (3), repeat, 32-bit -> cntH = 0xB640.
  store32(0x08000800, 0x040000BC);
  store32(0x040000A0, 0x040000C0);
  store16(0x0000, 0x040000C4);
  store16(repeat ? 0xB640 : 0xB440, 0x040000C6);
  // Timer 0: overflow every 256 cycles (reload 0xFF00, prescaler 1, enable).
  store16(0xFF00, 0x04000100);
  store16(0x0080, 0x04000102);

  const spin = a;
  emit(0xEA000000 | (((spin - (a + 8)) >> 2) & 0xFFFFFF));
  return rom;
}

test('Direct Sound: timer-driven FIFO consumption with special DMA refill', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 10 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }

  send({ type: 'readAudio' });
  const m = posted.filter((x) => x.type === 'audioState').pop();
  assert.ok(m, 'audioState reply expected');
  const s = m.payload || m;
  // The timer popped samples and the DMA kept refilling: current DS A output
  // must be the ROM sample value (sign-extended), not the reset value 0.
  assert.equal(s.dsA, SAMPLE, 'DS A outputs the DMA-fed sample');
  // FIFO must not have drained to empty — refill DMA is keeping pace.
  assert.ok(s.fifoALen > 0, `FIFO A should stay fed (len=${s.fifoALen})`);
  // The fixed-rate output sampler ran (a frame is ~548 samples at 32768 Hz).
  assert.ok(s.audioWrite > 500, `mixer should have produced samples (got ${s.audioWrite})`);
  // FIFO B untouched.
  assert.equal(s.dsB, 0, 'DS B silent');
});

test('Direct Sound: FIFO machine runs with SOUNDCNT_X master disabled', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom({ masterOn: false }));
  for (let i = 0; i < 5 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }
  send({ type: 'readAudio' });
  const sm = posted.filter((x) => x.type === 'audioState').pop();
  const s = sm.payload || sm;
  // Master enable only mutes the mixer; the timer still pops samples and the
  // special DMA still services low-water requests.
  assert.equal(s.dsA, SAMPLE, 'FIFO drains even with master audio off');
  assert.ok(s.fifoALen > 0, 'refill DMA still services requests');
});

test('Direct Sound: non-repeating special DMA disables after one request', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom({ repeat: false }));
  for (let i = 0; i < 5 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }
  send({ type: 'readAudio' });
  const sm = posted.filter((x) => x.type === 'audioState').pop();
  const s = sm.payload || sm;
  // One-shot DMA fills 16 bytes once (immediately on enable, FIFO empty),
  // then disables; the timer drains the rest and the FIFO ends empty.
  assert.equal(s.fifoALen, 0, 'no further refills after the one-shot DMA');
  assert.equal(s.dsA, SAMPLE, 'the one delivered batch was consumed');
  // DMA1 enable bit must read back cleared (0x40000C7 bit 7).
  send({ type: 'readMem32', addr: 0x040000C4 });
  const mm = posted.filter((x) => x.type === 'mem32').pop();
  const m = mm.payload || mm;
  assert.equal((m.value >>> 31) & 1, 0, 'DMA1 enable bit cleared after one-shot');
});
