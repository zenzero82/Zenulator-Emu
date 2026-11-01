// Regression: IRQ dispatch must enter the game's handler in IRQ mode,
// exactly like the real BIOS — NOT pre-switched to System mode.
//
// devkitARM/pokeemerald-style IntrMain handlers do their own mode dance:
//   entry (IRQ mode): mrs spsr, push {r0-r3,lr} on the IRQ stack
//   msr -> System mode: run the real work on the big sys stack
//   msr -> back to IRQ mode: pop {r0-r3,lr}, restore spsr, bx lr
// If the core dispatches in System mode, the entry pushes land on the sys
// stack but the final pops read the untouched IRQ stack — garbage lr,
// bx into zero-filled IWRAM, on-device 'pc-unmapped' crash at first VBlank.
const test = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

function buildRom() {
  const rom = Buffer.alloc(0x1000);
  const w32 = (a, v) => rom.writeUInt32LE(v >>> 0, a);
  w32(0x00, 0xEA00002E); // b 0xC0
  rom[0xB2] = 0x96;

  let a = 0xC0;
  const emit = (v) => { w32(a, v); a += 4; };
  const LIT = 0x200; const lit = {}; let litN = 0;
  const L = (v) => { v >>>= 0; if (!(v in lit)) { lit[v] = LIT + litN * 4; w32(LIT + litN * 4, v); litN++; } return lit[v]; };
  const ldrLit = (rd, v) => { const off = L(v) - (a + 8); emit(0xE59F0000 | (rd << 12) | off); };

  ldrLit(13, 0x03007F00);        // sys stack
  ldrLit(0, 0x08000300);
  ldrLit(1, 0x03007FFC);
  emit(0xE5810000);              // install IRQ handler
  ldrLit(4, 0x04000000);
  emit(0xE3A00008); emit(0xE1C400B4); // DISPSTAT = 8 (VBlank IRQ enable)
  emit(0xE3A00001);
  ldrLit(5, 0x04000200);
  emit(0xE1C500B0);              // IE = 1
  emit(0xE5850008);              // IME = 1
  ldrLit(6, 0x02000000);
  const loop = a;
  emit(0xE5967000);              // ldr r7,[r6]     poll handler marker
  emit(0xE3570001);              // cmp r7,#1
  emit(0x1AFFFFFF & (0x1A000000 | (((loop - (a + 8)) >> 2) & 0xFFFFFF))); // bne loop
  emit(0xE3A00002);
  emit(0xE5860004);              // resumed-after-IRQ marker = 2
  emit(0xEAFFFFFE);              // b .

  // IntrMain-style handler at 0x300 (called in IRQ mode)
  w32(0x300, 0xE14F0000);        // mrs r0, spsr
  w32(0x304, 0xE92D400F);        // stmfd sp!,{r0-r3,lr}   (IRQ stack)
  w32(0x308, 0xE3A0009F);        // mov r0,#0x9F
  w32(0x30C, 0xE121F000);        // msr cpsr_c,r0          -> System mode
  w32(0x310, 0xE92D4000);        // stmfd sp!,{lr}         (sys stack)
  w32(0x314, 0xE59F1064);        // ldr r1,=0x04000202
  w32(0x318, 0xE1D120B0);        // ldrh r2,[r1]
  w32(0x31C, 0xE1C120B0);        // strh r2,[r1]           ack IF
  w32(0x320, 0xE59F305C);        // ldr r3,=0x02000000
  w32(0x324, 0xE3A00001);        // mov r0,#1
  w32(0x328, 0xE5830000);        // handler-ran marker
  w32(0x32C, 0xE583D008);        // record sp while in System mode
  w32(0x330, 0xE8BD4000);        // ldmfd sp!,{lr}
  w32(0x334, 0xE3A00092);        // mov r0,#0x92
  w32(0x338, 0xE121F000);        // msr cpsr_c,r0          -> back to IRQ mode
  w32(0x33C, 0xE8BD400F);        // ldmfd sp!,{r0-r3,lr}   (IRQ stack again)
  w32(0x340, 0xE16FF000);        // msr spsr_cxsf,r0
  w32(0x344, 0xE12FFF1E);        // bx lr
  w32(0x380, 0x04000202);
  w32(0x384, 0x02000000);
  return rom;
}

test('IntrMain-style handler mode dance survives IRQ dispatch and returns', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 60 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }

  const bad = posted.find(m => m.type === 'cpuError' || m.type === 'cpuStuck');
  assert.ok(!bad, 'core crashed: ' + (bad && JSON.stringify(bad.payload || bad).slice(0, 300)));

  const probes = [0x02000000, 0x02000004, 0x02000008, 0x03007F84, 0x03007F9C];
  probes.forEach(addr => send({ type: 'readMem32', addr }));
  const mems = posted.filter(m => m.type === 'mem32').map(m => ((m.payload || m).value) >>> 0);

  assert.strictEqual(mems[0], 1, 'handler never ran');
  assert.strictEqual(mems[1], 2, 'main loop never resumed after IRQ return');
  // sys-mode work must run on the sys stack, just below its base 0x3007F00
  assert.ok(mems[2] > 0x3007E00 && mems[2] <= 0x3007F00,
    'handler C-work ran on wrong stack: sp=0x' + mems[2].toString(16));
  // The BIOS first pushes six words at 0x3007F88..0x3007F9C.
  // The handler's five words then occupy 0x3007F74..0x3007F84.
  assert.strictEqual(mems[3], 0xFFFFFFF0,
    'handler entry pushes did not land on the IRQ stack (saw 0x' + mems[3].toString(16) + ')');
  assert.ok(mems[4] >= 0x08000000 && mems[4] < 0x08001000,
    'BIOS frame must retain the interrupted ROM return address');
});
