// Regression: ARM7TDMI unaligned load semantics.
//
// The bug: every word LDR in the core did r32(addr&~3) — force-align, no
// rotate. Real hardware loads the aligned word and rotates it right by
// 8*(addr&3). pokeemerald's BlendPalette loop does `ldr r3,[r0]` at
// unfaded + i*2 (misaligned every odd i) and extracts channels from the LOW
// halfword, relying on the rotate to bring the odd-index color into the low
// half. Without the rotate, every even palette entry got duplicated into the
// following odd slot (title-screen palette + tile corruption, build 14n
// trace at strh pc=0x806fa06). LDRH at odd addresses likewise rotates by 8,
// and misaligned LDRSH degrades to LDRSB.
const test = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

test('unaligned THUMB ldr rotates; blend-style halfword walk sees distinct entries', async () => {
  const rom = Buffer.alloc(0x200);
  const w32 = (a, v) => rom.writeUInt32LE(v >>> 0, a);
  const w16 = (a, v) => rom.writeUInt16LE(v & 0xFFFF, a);

  // ARM header: set up and jump to THUMB code at 0xC0.
  w32(0x00, 0xE59F0038); // ldr r0, [pc,#0x38] -> literal @0x40 (0x020000F0 table)
  w32(0x04, 0xE59F1038); // ldr r1, [pc,#0x38] -> literal @0x44 (0x02000000 out)
  w32(0x08, 0xE59F2038); // ldr r2, [pc,#0x38] -> literal @0x48 (word 0xCAFE1234)
  w32(0x0C, 0xE5802000); // str r2, [r0]      -> table[0..3] = 34 12 FE CA
  w32(0x10, 0xE59F2034); // ldr r2, [pc,#0x34] -> literal @0x4C (0xBEEF5678)
  w32(0x14, 0xE5802004); // str r2, [r0,#4]
  w32(0x18, 0xE59F4030); // ldr r4, [pc,#0x30] -> literal @0x50 (thumb entry|1)
  w32(0x1C, 0xE12FFF14); // bx r4
  w32(0x40, 0x020000F0);
  w32(0x44, 0x02000000);
  w32(0x48, 0xCAFE1234);
  w32(0x4C, 0xBEEF5678);
  w32(0x50, 0x080000C1); // THUMB entry

  // THUMB code at 0xC0. r0=table(0x020000F0), r1=out(0x02000000).
  let a = 0xC0;
  const t = (v) => { w16(a, v); a += 2; };
  // ldr r2, [r0, #0]      ; aligned -> 0xCAFE1234
  t(0x6802);
  // strh r2, [r1, #0]     ; out[0] = 0x1234
  t(0x800A);
  // movs r3, #2 ; adds r0, r0, r3  (advance by one halfword)
  t(0x2302); t(0x18C0);
  // ldr r2, [r0, #0]      ; addr&3==2 -> rotate 16 -> low half = 0xCAFE
  t(0x6802);
  // strh r2, [r1, #2]     ; out[1] = 0xCAFE (was 0x1234 before the fix)
  t(0x804A);
  // lsrs r2, r2, #16 ; strh r2, [r1, #4]  ; high half = 0x5678 (rotated)
  t(0x0C12); t(0x808A);
  // ldrh r2, [r0, #1] ... ldrh has imm*2 encoding; use register offset for odd addr:
  // movs r3,#1 ; adds r4, r0, r3 is not needed — use ldrh r2,[r0,r3] with r3=1? addr = table+2+1 = odd
  t(0x2301);              // movs r3, #1
  t(0x5EC2 & 0xFFFF);     // ldsh r2, [r0, r3]  (0101111 ro=r3 rb=r0 rd=r2 -> 0x5EC2)
  t(0x80CA);              // strh r2, [r1, #6]  ; LDRSH @odd -> sign-extended byte 0xFE.. -> 0xFFFE? byte at table+3 = 0xBE -> 0xFFBE
  t(0x5AC2);              // ldrh r2, [r0, r3]  ; @odd -> r16(aligned)=0xBEEF ror 8 = 0xEF..? low16 = 0x00BE? full: 0xEF0000BE -> strh gives 0x00BE
  t(0x810A);              // strh r2, [r1, #8]
  t(0xE7FE);              // b . (idle)

  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(rom);
  for (let i = 0; i < 20 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }

  const rd = (addr) => {
    send({ type: 'readMem32', addr });
    const msgs = posted.filter(m => m.type === 'mem32');
    const m = msgs[msgs.length - 1];
    return ((m.payload || m).value) >>> 0;
  };

  const w0 = rd(0x02000000); // out[0], out[1]
  const w1 = rd(0x02000004); // out[2], out[3]
  const w2 = rd(0x02000008); // out[4]

  assert.strictEqual(w0 & 0xFFFF, 0x1234, 'aligned ldr low half wrong');
  assert.strictEqual((w0 >>> 16) & 0xFFFF, 0xCAFE,
    'unaligned ldr (addr&3==2) must rotate: low half should be the ODD halfword (got 0x' + ((w0 >>> 16) & 0xFFFF).toString(16) + ')');
  assert.strictEqual(w1 & 0xFFFF, 0x1234, 'unaligned ldr high half should hold the rotated-out low halfword');
  assert.strictEqual((w1 >>> 16) & 0xFFFF, 0xFFCA, 'misaligned LDRSH must degrade to LDRSB of the addressed byte (0xCA)');
  assert.strictEqual(w2 & 0xFFFF, 0x00CA, 'odd-address LDRH must rotate the halfword right by 8');
});
