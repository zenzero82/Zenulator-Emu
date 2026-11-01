// Regression: ARM B/BL must land exactly on the branch target.
//
// The bug: stepARM's fetch convention is r[15] = nextPC + 4, and B/BL left
// r[15] equal to the raw target (pc+8+offset) without the +4 — so every ARM
// branch landed 4 bytes short. Real games put literal-pool words directly
// before subroutine entry points, so a short BL executes pool data as code
// and can skip the real subroutine entirely (build-19 crash trace: bl over
// literal 0x8000679, then a bx lr reached via a skipped entry point returned
// through a stale/zero lr into unmapped memory near 0).
const test = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

test('ARM B skips the following word; BL lands exactly on target through nested calls', async () => {
  const rom = Buffer.alloc(0x200);
  const w32 = (a, v) => rom.writeUInt32LE(v >>> 0, a);
  w32(0x00, 0xEA000000); // b 0x08 — must skip 0x04
  w32(0x04, 0xE3A040AA); // poison: mov r4, #0xAA
  w32(0x08, 0xE3A04001); // mov r4, #1
  w32(0x0C, 0xE59FD044); // ldr sp, [pc,#0x44] -> literal @0x58
  w32(0x10, 0xEB00000A); // bl 0x40
  w32(0x14, 0xE59F0040); // ldr r0, [pc,#0x40] -> literal @0x5C (0x02000000)
  w32(0x18, 0xE5C04000); // strb r4, [r0]
  w32(0x1C, 0xE5C05001); // strb r5, [r0,#1]
  w32(0x20, 0xEAFFFFFE); // b .
  for (let a = 0x24; a <= 0x38; a += 4) w32(a, 0xE1A00000); // nops
  w32(0x3C, 0xE3A040BB); // literal-pool-style poison word directly before function
  w32(0x40, 0xE92D400F); // push {r0-r3, lr}
  w32(0x44, 0xEB000001); // bl 0x50
  w32(0x48, 0xE8BD400F); // pop {r0-r3, lr}
  w32(0x4C, 0xE12FFF1E); // bx lr
  w32(0x50, 0xE3A05077); // inner: mov r5, #0x77
  w32(0x54, 0xE12FFF1E); // bx lr
  w32(0x58, 0x03007F00); // sp literal
  w32(0x5C, 0x02000000); // EWRAM literal

  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(rom);
  for (let i = 0; i < 20 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }

  const stuck = posted.find(m => m.type === 'cpuStuck');
  const p = stuck && (stuck.payload || stuck);
  // The idle loop is expected (pc-frozen at the final b .) — but any
  // pc-unmapped crash means a branch escaped the ROM.
  if (p) assert.notStrictEqual(p.category, 'pc-unmapped', 'branch escaped mapped memory: ' + JSON.stringify(p));

  send({ type: 'readMem32', addr: 0x02000000 });
  const mem = posted.find(m => m.type === 'mem32');
  const word = (mem.payload || mem).value >>> 0;
  const b0 = word & 0xFF, b1 = (word >>> 8) & 0xFF;
  // r4 must be 1 (not 0xAA/0xBB poison), r5 must be 0x77 (inner ran, pop/bx worked)
  assert.strictEqual(b0, 0x01, 'b landed short: poison word at 0x04/0x3C executed (r4=0x' + b0.toString(16) + ')');
  assert.strictEqual(b1, 0x77, 'inner function skipped or return path broken (r5=0x' + b1.toString(16) + ')');
});
