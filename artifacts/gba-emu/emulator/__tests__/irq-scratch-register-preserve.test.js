// Regression: HLE IRQ dispatch must save/restore r0-r3 and r12 around the
// user handler call, mirroring the real BIOS trampoline's
// 'stmfd sp!,{r0-r3,r12,lr}' ... 'ldmfd sp!,{r0-r3,r12,lr}; subs pc,lr,#4'.
//
// IntrMain-style handlers are AAPCS-free to clobber r0-r3/r12 precisely
// because the BIOS saved them. Before this fix the core only saved lr/SPSR
// in its return-context stack, so every IRQ return handed the interrupted
// mainline corrupted scratch registers. Games mostly survive because they
// sit halted in IntrWait (no live scratch regs at that instant), but any
// busy-wait loop holding a live pointer in r0-r3 breaks: on-device,
// pokeemerald's flash-probe timeout countdown kept the stack counter's
// address in r2, a VBlank IRQ trashed it, and the countdown then
// read/wrote BIOS space forever -> display never enabled.
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
  // Load live sentinel values into the scratch registers, then busy-wait
  // (poll the handler-ran marker) so the VBlank IRQ interrupts THIS loop
  // while the sentinels are live.
  ldrLit(1, 0x11111111);
  ldrLit(2, 0x22222222);
  ldrLit(3, 0x33333333);
  ldrLit(12, 0xCCCCCCCC);
  ldrLit(6, 0x02000000);
  const loop = a;
  emit(0xE5967000);              // ldr r7,[r6]     poll handler marker
  emit(0xE3570001);              // cmp r7,#1
  emit(0x1A000000 | (((loop - (a + 8)) >> 2) & 0xFFFFFF)); // bne loop
  emit(0xE5861004);              // str r1,[r6,#4]  dump survivors
  emit(0xE5862008);              // str r2,[r6,#8]
  emit(0xE586300C);              // str r3,[r6,#12]
  emit(0xE586C010);              // str r12,[r6,#16]
  emit(0xEAFFFFFE);              // b .

  // Handler at 0x300: clobbers r0-r3 and r12 WITHOUT saving them — legal
  // for a BIOS-called handler. Acks IF, sets the marker, returns.
  w32(0x300, 0xE59F1024);        // ldr r1,=0x04000202
  w32(0x304, 0xE1D120B0);        // ldrh r2,[r1]
  w32(0x308, 0xE1C120B0);        // strh r2,[r1]   ack IF
  w32(0x30C, 0xE3A00DEA);        // mov r0,#0x3A80    (clobber)
  w32(0x310, 0xE3A03C99);        // mov r3,#0x9900    (clobber)
  w32(0x314, 0xE3A0C0DD);        // mov r12,#0xDD     (clobber)
  w32(0x318, 0xE59F2010);        // ldr r2,=0x02000000
  w32(0x31C, 0xE3A01001);        // mov r1,#1
  w32(0x320, 0xE5821000);        // handler-ran marker = 1
  w32(0x324, 0xE12FFF1E);        // bx lr
  w32(0x32C, 0x04000202);
  w32(0x330, 0x02000000);
  return rom;
}

test('IRQ dispatch preserves r0-r3/r12 across a scratch-clobbering handler', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 60 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }

  const bad = posted.find(m => m.type === 'cpuError' || m.type === 'cpuStuck');
  assert.ok(!bad, 'core crashed: ' + (bad && JSON.stringify(bad.payload || bad).slice(0, 300)));

  const probes = [0x02000000, 0x02000004, 0x02000008, 0x0200000C, 0x02000010];
  probes.forEach(addr => send({ type: 'readMem32', addr }));
  const mems = posted.filter(m => m.type === 'mem32').map(m => ((m.payload || m).value) >>> 0);

  assert.strictEqual(mems[0], 1, 'handler never ran');
  assert.strictEqual(mems[1] >>> 0, 0x11111111, 'r1 corrupted across IRQ: 0x' + mems[1].toString(16));
  assert.strictEqual(mems[2] >>> 0, 0x22222222, 'r2 corrupted across IRQ: 0x' + mems[2].toString(16));
  assert.strictEqual(mems[3] >>> 0, 0x33333333, 'r3 corrupted across IRQ: 0x' + mems[3].toString(16));
  assert.strictEqual(mems[4] >>> 0, 0xCCCCCCCC, 'r12 corrupted across IRQ: 0x' + mems[4].toString(16));
});
