// Regression: THUMB Format 7/8 (register-offset load/store, 0x5xxx).
//
// The decoder treated bit10 as "byte vs halfword" and NEVER did word
// accesses: `ldr rd,[rb,ro]` executed as ldrb and `str` as strb, and the
// Format 8 sign-extended ops (ldsb/ldsh) were decoded as plain byte/half.
// Real-world symptom: m4a SoundInit's function table copied correctly to
// RAM, but MPlayOpen's `ldr r3,[r3,r2]` fetched only the LOW BYTE of the
// pointer (0x21 of 0x08002521) and `bx r3` slid into the BIOS region.
// Correct decode: bit9=0 -> Format 7 (00 str, 01 strb, 10 ldr, 11 ldrb);
// bit9=1 -> Format 8 (00 strh, 01 ldsb, 10 ldrh, 11 ldsh).
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
  A(0xE59F6008);          // ldr r6,[pc,#8]  -> results base 0x02000000
  A(0xE59F4008);          // ldr r4,[pc,#8]  -> thumb entry | 1
  A(0xE12FFF14);          // bx r4
  w32(0xC0 + 8 + 0x08, 0x02000000);
  w32(0xC4 + 8 + 0x08, 0x08000200 | 1);

  // THUMB at 0x200. r6 = 0x02000000 results/work base.
  let t = 0x200;
  const T = (v) => { w16(t, v); t += 2; };
  // Build r0 = 0x08002521 style pattern: 0x81FF7F21 (exercises sign bits)
  T(0x2081);              // movs r0,#0x81
  T(0x0600);              // lsls r0,#24        -> 0x81000000
  T(0x21FF);              // movs r1,#0xFF
  T(0x0409);              // lsls r1,#16        -> 0x00FF0000
  T(0x4308);              // orrs r0,r1         -> 0x81FF0000
  T(0x217F);              // movs r1,#0x7F
  T(0x0209);              // lsls r1,#8         -> 0x00007F00
  T(0x4308);              // orrs r0,r1         -> 0x81FF7F00
  T(0x2121);              // movs r1,#0x21
  T(0x4308);              // orrs r0,r1         -> 0x81FF7F21
  T(0x2500);              // movs r5,#0         (offset reg = 0)
  // --- Format 7: str (word) via register offset
  T(0x5170);              // str r0,[r6,r5]     word store at +0
  // --- Format 7: ldr (word) back — THE bug (was ldrb)
  T(0x5971);              // ldr r1,[r6,r5]
  T(0x6071);              // str r1,[r6,#4]     [1] expect 0x81FF7F21
  // --- Format 8: ldrh (must be zero-extended halfword)
  T(0x5B71);              // ldrh r1,[r6,r5]
  T(0x60B1);              // str r1,[r6,#8]     [2] expect 0x00007F21
  // --- Format 8: ldsh (sign-extended halfword: 0x7F21 -> positive)
  T(0x5F71);              // ldsh r1,[r6,r5]
  T(0x60F1);              // str r1,[r6,#0xC]   [3] expect 0x00007F21
  // --- Format 8: ldsb at offset 3 (byte 0x81 -> 0xFFFFFF81)
  T(0x2503);              // movs r5,#3
  T(0x5771);              // ldsb r1,[r6,r5]
  T(0x6131);              // str r1,[r6,#0x10]  [4] expect 0xFFFFFF81
  // --- Format 7: ldrb at offset 3 (zero-extended)
  T(0x5D71);              // ldrb r1,[r6,r5]
  T(0x6171);              // str r1,[r6,#0x14]  [5] expect 0x81
  // --- Format 8: strh via register offset, then word-read the pair
  T(0x2518);              // movs r5,#0x18
  T(0x21AB);              // movs r1,#0xAB
  T(0x0209);              // lsls r1,#8
  T(0x31CD);              // adds r1,#0xCD      -> 0xABCD
  T(0x5371);              // strh r1,[r6,r5]    halfword store at +0x18
  // --- Format 7: strb via register offset at +0x1A
  T(0x251A);              // movs r5,#0x1A
  T(0x22EE);              // movs r2,#0xEE
  T(0x5572);              // strb r2,[r6,r5]    byte store at +0x1A
  T(0xE7FE);              // b .
  return rom;
}

test('THUMB Format 7/8 register-offset: word/byte/half/sign-extended all decode correctly', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 10 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }
  for (const off of [0x0, 0x4, 0x8, 0xC, 0x10, 0x14, 0x18]) send({ type: 'readMem32', addr: 0x02000000 + off });
  const mems = posted.filter(m => m.type === 'mem32').map(m => ((m.payload || m).value) >>> 0);
  assert.strictEqual(mems[0], 0x81FF7F21, 'str [rb,ro] must store a full word');
  assert.strictEqual(mems[1], 0x81FF7F21, 'ldr [rb,ro] must load a full word, not a byte');
  assert.strictEqual(mems[2], 0x00007F21, 'ldrh [rb,ro] must zero-extend the halfword');
  assert.strictEqual(mems[3], 0x00007F21, 'ldsh [rb,ro] must sign-extend (positive case)');
  assert.strictEqual(mems[4], 0xFFFFFF81, 'ldsb [rb,ro] must sign-extend the byte');
  assert.strictEqual(mems[5], 0x00000081, 'ldrb [rb,ro] must zero-extend the byte');
  assert.strictEqual(mems[6] & 0x00FFFFFF, 0x00EEABCD, 'strh + strb via register offset must write half/byte');
});
