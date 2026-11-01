// Regression: shift-amount-0 semantics.
//
// THUMB movs rd,rs is encoded as lsls rd,rs,#0. The decoder converted every
// immediate shift amount of 0 to 32 (correct ONLY for LSR/ASR), so movs
// zeroed its destination. Real ROMs compute copy-loop end pointers through
// register moves; with the size register zeroed, the crt0 copy loop's exit
// compare never fired and games spun forever on a white screen.
// Also covered: THUMB register-specified shift by 0 (must not change value
// or flags) and ARM immediate LSR #0 / ASR #0 (mean #32) and ROR #0 (RRX).
const test = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

function buildRom() {
  const rom = Buffer.alloc(0x400);
  const w32 = (a, v) => rom.writeUInt32LE(v >>> 0, a);
  const w16 = (a, v) => rom.writeUInt16LE(v & 0xFFFF, a);
  w32(0x00, 0xEA00002E); // b 0xC0
  rom[0xB2] = 0x96;

  let a = 0xC0;
  const A = (v) => { w32(a, v); a += 4; };
  A(0xE59F6060);          // ldr r6,[pc,#0x60] -> results base (0x02000000) at 0xC8+0x60=0x128
  // ARM: r0 = 0x80000001 (via mov + orr rotations)
  A(0xE3A00102);          // mov r0,#0x80000000
  A(0xE3800001);          // orr r0,r0,#1
  A(0xE1A01020);          // mov r1, r0, lsr #0  -> means LSR #32 -> 0
  A(0xE5861000);          // str r1,[r6]         [0] expect 0
  A(0xE1A01040);          // mov r1, r0, asr #0  -> ASR #32 -> 0xFFFFFFFF
  A(0xE5861004);          // str r1,[r6,#4]      [1] expect 0xFFFFFFFF
  A(0xE3E02000);          // mvn r2,#0 -> C flag currently unknown; set C=0 via cmp
  A(0xE3500000);          // cmp r0,#0 (r0=0x80000001, C=1 from cmp>=)
  A(0xE1A01060);          // mov r1, r0, ror #0  -> RRX: C(1)<<31 | r0>>1 = 0xC0000000
  A(0xE5861008);          // str r1,[r6,#8]      [2] expect 0xC0000000
  // switch to THUMB at 0x08000100|1
  A(0xE59F4030);          // ldr r4,[pc,#0x30] -> thumb entry lit
  A(0xE12FFF14);          // bx r4
  // literals
  w32(0x128, 0x02000000);

  // thumb-entry literal: at pc+8+0x30 of the ldr r4 instruction
  // ldr r4 is the second-to-last A() -> its address:
  const ldr4At = a - 8;
  w32(ldr4At + 8 + 0x30, 0x08000200 | 1);

  // THUMB code at 0x200
  let t = 0x200;
  const T = (v) => { w16(t, v); t += 2; };
  T(0x2238);              // movs r2,#0x38
  T(0x0015);              // movs r5,r2 (lsls r5,r2,#0) — THE bug: must copy, not zero
  T(0x60F5);              // str r5,[r6,#0xC]   [3] expect 0x38
  T(0x2300);              // movs r3,#0
  T(0x2607);              // movs r6b... careful: r6 holds results base! use r0/r1
  t -= 2;                 // undo — rewrite without clobbering r6
  T(0x2007);              // movs r0,#7
  T(0x4098);              // lsls r0,r3 (register shift by r3=0) — value must stay 7
  T(0x6130);              // str r0,[r6,#0x10]  [4] expect 7
  T(0x2001);              // movs r0,#1
  T(0x2320);              // movs r3,#0x20
  T(0x4098);              // lsls r0,r3 (shift by 32) — result 0
  T(0x6170);              // str r0,[r6,#0x14]  [5] expect 0
  T(0xE7FE);              // b .
  return rom;
}

test('shift amount 0: THUMB movs copies, reg-shift-0 is identity, ARM LSR/ASR #0 mean #32, ROR #0 is RRX', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 10 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }
  for (let k = 0; k < 6; k++) send({ type: 'readMem32', addr: 0x02000000 + k * 4 });
  const mems = posted.filter(m => m.type === 'mem32').map(m => ((m.payload || m).value) >>> 0);
  assert.strictEqual(mems[0], 0, 'ARM LSR #0 must behave as LSR #32');
  assert.strictEqual(mems[1], 0xFFFFFFFF, 'ARM ASR #0 must behave as ASR #32 (sign fill)');
  assert.strictEqual(mems[2], 0xC0000000, 'ARM ROR #0 must behave as RRX');
  assert.strictEqual(mems[3], 0x38, 'THUMB movs rd,rs (lsls #0) must COPY the value, not zero it');
  assert.strictEqual(mems[4], 7, 'THUMB register shift by 0 must leave value unchanged');
  assert.strictEqual(mems[5], 0, 'THUMB register shift by 32 must produce 0');
});
