// Regression: the real-game boot pattern must get past the white screen.
//
// The bug: the ARM halfword-transfer decode mask included bit 22 (immediate
// vs register offset), so every immediate-offset strh/ldrh — the exact form
// compilers emit for I/O register configuration (DISPCNT, DISPSTAT, IE,
// IME...) — fell through to dataProc and executed as a garbage ALU op.
// Games ran, but no interrupts were ever enabled and the display was never
// configured, so VBlankIntrWait halted forever: the white-screen hang.
//
// This test drives the full boot sequence a devkitARM-style crt0/game does:
// forced blank, CpuSet palette init, IRQ handler install, DISPSTAT/IE/IME
// via immediate-offset strh, then a VBlankIntrWait loop, then unblank+draw.
// Stage markers are written to EWRAM so a failure names the exact stall.
const test = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

function buildBootRom() {
  const rom = Buffer.alloc(0x1000);
  const w32 = (a, v) => rom.writeUInt32LE(v >>> 0, a);
  w32(0x00, 0xEA00002E); // b 0xC0
  rom[0xB2] = 0x96;

  let a = 0xC0;
  const emit = (v) => { w32(a, v); a += 4; };
  const LIT = 0x200; const lit = {}; let litN = 0;
  const L = (v) => { v >>>= 0; if (!(v in lit)) { lit[v] = LIT + litN * 4; w32(LIT + litN * 4, v); litN++; } return lit[v]; };
  const ldrLit = (rd, v) => { const off = L(v) - (a + 8); emit(0xE59F0000 | (rd << 12) | off); };

  ldrLit(13, 0x03007F00);
  ldrLit(6, 0x02000000);
  emit(0xE3A00001); emit(0xE5C60000);            // stage 1
  ldrLit(4, 0x04000000);
  emit(0xE3A00080); emit(0xE1C400B0);            // strh: DISPCNT = 0x80 (forced blank)
  ldrLit(0, 0x08000000 + L(0x7FFF7FFF));
  ldrLit(1, 0x05000000);
  ldrLit(2, (1 << 24) | (1 << 26) | 0x100);
  emit(0xEF0B0000);                              // swi CpuSet (palette fill)
  emit(0xE3A00002); emit(0xE5C60000);            // stage 2
  ldrLit(0, 0x08000300);
  ldrLit(1, 0x03007FFC);
  emit(0xE5810000);                              // install IRQ handler
  emit(0xE3A00008); emit(0xE1C400B4);            // strh: DISPSTAT = 8 (VBlank IRQ enable)
  emit(0xE3A00001);
  ldrLit(5, 0x04000200);
  emit(0xE1C500B0);                              // strh: IE = 1
  emit(0xE5850008);                              // str:  IME = 1
  emit(0xE3A00003); emit(0xE5C60000);            // stage 3
  emit(0xE3A07000);
  const loopAddr = a;
  emit(0xEF050000);                              // swi VBlankIntrWait
  emit(0xE2877001);                              // add r7,#1
  emit(0xE5867010);                              // str r7,[r6,#0x10]
  emit(0xE3570003);                              // cmp r7,#3
  emit(0xBA000000 | (((loopAddr - (a + 8)) >> 2) & 0xFFFFFF)); // blt loop
  emit(0xE3A00004); emit(0xE5C60000);            // stage 4
  ldrLit(0, 0x00000403);
  emit(0xE1C400B0);                              // strh: DISPCNT = mode3 | BG2
  ldrLit(1, 0x06000000);
  ldrLit(0, 0x7FFF7FFF);
  emit(0xE5810000);                              // draw
  emit(0xE3A00005); emit(0xE5C60000);            // stage 5
  emit(0xEAFFFFFE);                              // b .

  // IRQ handler: ack IF, mirror into BIOS IF at 0x03007FF8, return
  w32(0x300, 0xE59F0038); // ldr r0,=0x04000200
  w32(0x304, 0xE1D010B2); // ldrh r1,[r0,#2]   (immediate-offset ldrh — also exercises the fix)
  w32(0x308, 0xE1C010B2); // strh r1,[r0,#2]   ack
  w32(0x30C, 0xE59F2030); // ldr r2,=0x03007FF8
  w32(0x310, 0xE1D230B0); // ldrh r3,[r2]
  w32(0x314, 0xE1833001); // orr r3,r3,r1
  w32(0x318, 0xE1C230B0); // strh r3,[r2]
  w32(0x31C, 0xE12FFF1E); // bx lr
  w32(0x340, 0x04000200);
  w32(0x344, 0x03007FF8);
  return rom;
}

test('boot pattern: forced blank -> CpuSet -> VBlank IRQ + IntrWait -> unblank + draw', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildBootRom());
  for (let i = 0; i < 400 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }

  const bad = posted.find(m => m.type === 'cpuError');
  assert.ok(!bad, 'CPU error during boot: ' + (bad && JSON.stringify(bad.payload || bad).slice(0, 300)));

  const probes = [0x02000000, 0x02000010, 0x04000200, 0x04000208];
  probes.forEach(addr => send({ type: 'readMem32', addr }));
  const mems = posted.filter(m => m.type === 'mem32').map(m => ((m.payload || m).value) >>> 0);

  const stage = mems[0] & 0xFF, waits = mems[1], ieif = mems[2], ime = mems[3] & 1;
  assert.strictEqual(ieif & 0xFFFF, 1, 'IE lost — immediate-offset strh to I/O regs not landing (IE=' + (ieif & 0xFFFF) + ')');
  assert.strictEqual(ime, 1, 'IME lost');
  assert.ok(waits >= 3, 'VBlankIntrWait never woke (waits=' + waits + ') — IRQ dispatch or IntrWait broken');
  assert.strictEqual(stage, 5, 'boot stalled at stage ' + stage + ' (3=halted in IntrWait forever = white screen)');
});
