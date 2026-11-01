// Scratch reproduction: pokeemerald-style IntrMain with nesting enabled,
// VBlank + VCount IRQs, CpuSet SWI inside the handler, IntrWait mainline.
// Hunts the on-device 0xfffffff4 underflow (IRQ return-context stack empty).
'use strict';
const { bootCoreInteractive } = require('./run-core.js');

function buildRom() {
  const rom = Buffer.alloc(0x2000);
  const w32 = (a, v) => rom.writeUInt32LE(v >>> 0, a);
  w32(0x00, 0xEA00002E); // b 0xC0
  rom[0xB2] = 0x96;

  let a = 0xC0;
  const emit = (v) => { w32(a, v); a += 4; };
  const LIT = 0x600; const lit = {}; let litN = 0;
  const L = (v) => { v >>>= 0; if (!(v in lit)) { lit[v] = LIT + litN * 4; w32(LIT + litN * 4, v); litN++; } return lit[v]; };
  const ldrLit = (rd, v) => { const off = L(v) - (a + 8); emit(0xE59F0000 | (rd << 12) | off); };

  ldrLit(13, 0x03007F00);          // sys stack
  ldrLit(0, 0x08000300);           // IntrMain (ARM, in ROM)
  ldrLit(1, 0x03007FFC);
  emit(0xE5810000);                // install handler
  ldrLit(4, 0x04000000);
  // DISPSTAT: VBlank IRQ (bit3) + VCount IRQ (bit5) + VCount target 161 (bits 8-15)
  ldrLit(0, (161 << 8) | 0x28);
  emit(0xE1C400B4);                // strh DISPSTAT
  // Timer0: reload 0xC000 (fires every ~16k cycles ≈ 4 scanlines) — long
  // enough for the handler to complete, short enough to nest inside the
  // VBlank handler's 6000-iteration spin.
  ldrLit(0, 0xFD00);
  ldrLit(1, 0x04000100);
  emit(0xE1C100B0);                // strh reload
  emit(0xE3A000C2);                // cnt = 0xC2 (IRQ + enable, prescale 64) — period 768*64 ≈ 49k cycles, longer than one handler pass so nesting unwinds
  emit(0xE1C100B2);                // strh cntH
  ldrLit(0, 0x0D);                 // IE = VBlank | VCount | Timer0
  ldrLit(5, 0x04000200);
  emit(0xE1C500B0);
  emit(0xE3A00001);
  emit(0xE5850008);                // IME = 1
  ldrLit(0, 0x1100);               // DISPCNT: mode0 + BG0 (silence blank-screen watchdog)
  emit(0xE1C400B0);                // strh DISPCNT
  ldrLit(6, 0x02000000);
  emit(0xE3A07000);                // r7 = frame counter
  const loop = a;
  emit(0xE3A00001); emit(0xE3A01001);
  emit(0xEF040000);                // swi IntrWait(1,1)
  emit(0xE2877001);                // r7++
  emit(0xE5867000);                // [0x2000000] = frames
  emit(0xEA000000 | (((loop - (a + 8)) >> 2) & 0xFFFFFF)); // b loop

  // ── IntrMain replica at 0x300 (entered in IRQ mode) ──
  let h = 0x300;
  const He = (v) => { w32(h, v); h += 4; };
  He(0xE59F30F4);                  // ldr r3,=0x04000200        (@0x300, lit @0x3FC)
  He(0xE1D310B8);                  // ldrh r1,[r3,#8]   IME
  He(0xE1D320B0);                  // ldrh r2,[r3]      IE
  He(0xE3A00000);
  He(0xE1C300B8);                  // IME = 0
  He(0xE14F0000);                  // mrs r0, spsr
  He(0xE92D400F);                  // stmfd sp!,{r0-r3,lr}  (IRQ stack)
  He(0xE1D300B2);                  // ldrh r0,[r3,#2]   IF
  He(0xE1C300B2);                  // strh r0,[r3,#2]   ack all pending
  // enable nesting: sys mode, I clear, IME=1
  He(0xE3A0001F);                  // mov r0,#0x1F
  He(0xE121F000);                  // msr cpsr_c,r0     -> System, I=0
  He(0xE92D4000);                  // stmfd sp!,{lr}    (sys stack)
  He(0xE3A00001);
  He(0xE1C300B8);                  // IME = 1  (nesting open)
  He(0xEB000000 | ((((0x400) - (h + 8)) >> 2) & 0xFFFFFF)); // bl C-handler @0x400
  He(0xE8BD4000);                  // ldmfd sp!,{lr}
  He(0xE3A00092);
  He(0xE121F000);                  // msr cpsr_c,r0     -> IRQ mode, I=1
  He(0xE8BD400F);                  // ldmfd sp!,{r0-r3,lr}
  He(0xE1C320B0);                  // restore IE
  He(0xE1C310B8);                  // restore IME
  He(0xE169F000);                  // msr spsr,r0
  He(0xE12FFF1E);                  // bx lr
  w32(0x3FC, 0x04000200);

  // ── C handler at 0x400: CpuSet SWI + long spin so VCount(161) nests
  //    inside the VBlank(160) handler ──
  let c = 0x400;
  const CLITS = { leaf: 0x478, src: 0x468, dst: 0x46C, spinN: 0x470, cnt: 0x474 };
  const Ce = (v) => { w32(c, v); c += 4; };
  const CeLdr = (rd, key) => { const off = CLITS[key] - (c + 8); w32(c, 0xE59F0000 | (rd << 12) | off); c += 4; };
  Ce(0xE92D4070);                  // push {r4-r6,lr}
  // agbcc-style indirect call: ldr r0,=leaf; mov lr,pc; bx r0 — the leaf
  // returns via pop{r0}; bx r0 like THUMB agbcc epilogues (in ARM here).
  CeLdr(0, 'leaf');
  Ce(0xE1A0E00F);                  // mov lr,pc
  Ce(0xE12FFF10);                  // bx r0
  CeLdr(0, 'src');                 // ldr r0,=0x08000600
  CeLdr(1, 'dst');                 // ldr r1,=0x02000100
  Ce(0xE3A02010);                  // r2 = 16 halfwords
  Ce(0xEF0B0000);                  // swi CpuSet
  CeLdr(4, 'spinN');               // ldr r4,=6000      spin (~3 scanlines)
  const spin = c;
  Ce(0xE2544001);                  // subs r4,#1
  Ce(0x1A000000 | (((spin - (c + 8)) >> 2) & 0xFFFFFF)); // bne spin
  CeLdr(5, 'cnt');                 // ldr r5,=0x02000004
  Ce(0xE5956000);                  // ldr r6,[r5]
  Ce(0xE2866001);                  // add r6,#1
  Ce(0xE5856000);                  // str r6,[r5]       handler-run count
  Ce(0xE8BD4070);                  // pop {r4-r6,lr}
  Ce(0xE12FFF1E);                  // bx lr
  w32(0x468, 0x08000600);
  w32(0x46C, 0x02000100);
  w32(0x470, 6000);
  w32(0x474, 0x02000004);
  w32(0x478, 0x08000500);
  // Leaf at 0x500: push lr, tiny spin, pop{r0}; bx r0 (agbcc-style return)
  w32(0x500, 0xE92D4000);          // push {lr}
  w32(0x504, 0xE3A04020);          // mov r4,#32
  w32(0x508, 0xE2544001);          // subs r4,#1
  w32(0x50C, 0x1AFFFFFD);          // bne -
  w32(0x510, 0xE8BD0001);          // pop {r0}
  w32(0x514, 0xE12FFF10);          // bx r0
  return rom;
}

(async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(buildRom());
  for (let i = 0; i < 2000 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }
  const bad = posted.find(m => (m.type === 'cpuError' || m.type === 'cpuStuck') &&
    ((m.payload || m).category !== 'display-never-enabled'));
  if (bad) {
    const p = bad.payload || bad;
    console.log('CRASHED:', p.category || p.type, p.pc, p.extra);
    console.log('lastSteps:', (p.lastSteps || []).slice(-16));
    console.log('jumps:', (p.jumps || []).slice(-12));
    console.log('lastIRQ:', JSON.stringify(p.lastIRQ), 'lastSWI:', JSON.stringify(p.lastSWI));
  } else {
    [0x02000000, 0x02000004].forEach(addr => send({ type: 'readMem32', addr }));
    const mems = posted.filter(m => m.type === 'mem32').map(m => (m.payload || m).value >>> 0);
    console.log('OK — frames:', mems[0], 'handler runs:', mems[1]);
  }
})();
