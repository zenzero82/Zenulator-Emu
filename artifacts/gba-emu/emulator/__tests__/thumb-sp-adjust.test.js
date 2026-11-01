// Regression: THUMB Format 13 (add/sub sp,#imm, 0xB0xx) vs Format 14 (PUSH/POP).
//
// The PUSH/POP decoder guarded on (ins>>>12)===0xB, which swallowed EVERY
// 0xBxxx instruction — including 0xB0xx SP-adjust, whose real handler was
// unreachable dead code. "add sp,#4" (0xB001) therefore executed as
// "push {r0}": SP moved DOWN 4 instead of up 4, so a standard agbcc epilogue
//   add sp,#4 ; pop {r4,r5} ; pop {r0} ; bx r0
// popped the caller's saved r4 as the return address and the CPU slid off
// into RAM (the 0x300392c crash). Real PUSH/POP is only 0xB4/B5/BC/BD
// (bits 10-9 == 10): guard must be (ins&0xF600)===0xB400.
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
  A(0xE59F6010);          // ldr r6,[pc,#0x10] -> results base 0x02000000
  A(0xE59FD010);          // ldr sp,[pc,#0x10] -> 0x03007F00
  A(0xE59F4010);          // ldr r4,[pc,#0x10] -> thumb entry | 1
  A(0xE12FFF14);          // bx r4
  // literals (pc = instr+8)
  w32(0xC0 + 8 + 0x10, 0x02000000);
  w32(0xC4 + 8 + 0x10, 0x03007F00);
  w32(0xC8 + 8 + 0x10, 0x08000200 | 1);

  // THUMB at 0x200: caller sets up known r4/r5, calls F, records results.
  let t = 0x200;
  const T = (v) => { w16(t, v); t += 2; };
  T(0x24AA);              // movs r4,#0xAA   (caller's r4 - must survive)
  T(0x25BB);              // movs r5,#0xBB
  T(0xF000); T(0xF80A);   // bl F (0x21C)
  // If F's epilogue is broken we never get here.
  T(0x6034);              // str r4,[r6]     [0] expect 0xAA (restored)
  T(0x6075);              // str r5,[r6,#4]  [1] expect 0xBB
  T(0x2001);              // movs r0,#1
  T(0x60B0);              // str r0,[r6,#8]  [2] sentinel: returned at all
  T(0xE7FE);              // b .
  while (t < 0x21C) T(0x46C0); // nop padding
  // F at 0x21C: classic agbcc frame.
  T(0xB530);              // push {r4,r5,lr}
  T(0xB081);              // sub sp,#4       (local slot)
  T(0x24CC);              // movs r4,#0xCC   (clobber)
  T(0x25DD);              // movs r5,#0xDD
  T(0x9400);              // str r4,[sp,#0]  (touch the local)
  T(0xB001);              // add sp,#4       <- THE bug: ran as push {r0}
  T(0xBC30);              // pop {r4,r5}
  T(0xBC01);              // pop {r0}
  T(0x4700);              // bx r0
  return rom;
}

test('THUMB add/sub sp,#imm must not decode as PUSH/POP; agbcc epilogue returns correctly', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 10 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }
  for (let k = 0; k < 3; k++) send({ type: 'readMem32', addr: 0x02000000 + k * 4 });
  const mems = posted.filter(m => m.type === 'mem32').map(m => ((m.payload || m).value) >>> 0);
  assert.strictEqual(mems[2], 1, 'F must return to its caller (add sp,#4 must not run as push {r0})');
  assert.strictEqual(mems[0], 0xAA, 'callee-saved r4 must be restored by the epilogue');
  assert.strictEqual(mems[1], 0xBB, 'callee-saved r5 must be restored by the epilogue');
});
