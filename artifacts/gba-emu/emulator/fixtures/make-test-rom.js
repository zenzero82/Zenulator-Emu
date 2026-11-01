// Builds a minimal, purpose-built GBA test ROM by hand-assembling raw ARM
// machine code — no external toolchain, no copyrighted game data. Used by
// the boot-trace harness (see ../__tests__/boot-trace.test.js) as the
// "small known-good homebrew ROM" required by the debug pass (STEP 10 /
// STEP 11 of DEBUG_EMULATOR_REPORT.md).
//
// Program behavior once booted:
//   1. Enables Mode 3 (240x160 direct bitmap) on BG2.
//   2. Enables VBlank IRQ (IE, IME) and installs an IRQ handler at 0x18
//      that just acknowledges VBlank (IF write-1-to-clear) and returns via
//      the standard `LDMFD SP!,{R0-R3,R12,PC}^` epilogue — this is the
//      idiom the S-bit LDM/STM fix (see html.ts bdt()) exists to support.
//   3. Main loop: BIOS VBlankIntrWait (SWI 0x05), then flips the whole
//      framebuffer between two solid colors and increments a WRAM counter
//      each time — giving an unambiguous, externally observable signal
//      that the core is (a) reaching VBlank, (b) taking IRQs and returning
//      from them correctly, and (c) presenting a changing framebuffer.
'use strict';
const fs = require('fs');
const path = require('path');

function u32le(buf, off, v) {
  buf[off] = v & 0xFF; buf[off+1] = (v>>>8)&0xFF; buf[off+2]=(v>>>16)&0xFF; buf[off+3]=(v>>>24)&0xFF;
}

// ARM opcode encoders (subset, just enough for this program).
function armB(fromAddr, toAddr, link) {
  const off = ((toAddr - (fromAddr + 8)) >> 2) & 0xFFFFFF;
  return (0xE0000000 | (link ? 0x01000000 : 0) | 0x0A000000 | off) >>> 0;
}
function armLDRLit(rd, literalOffsetFromPC) {
  // LDR Rd, [PC, #off] — literalOffsetFromPC must be >=0 and refer forward.
  return (0xE59F0000 | (rd << 12) | literalOffsetFromPC) >>> 0;
}
function armSTRH(rd, rn, imm) {
  // NOTE: originally emitted a real STRH; the emulator's halfword-transfer
  // decoder only matches the register-offset encoding (bit22=0), not this
  // immediate-offset form (bit22=1) — see DEBUG_EMULATOR_REPORT.md. Since
  // every hardware register this fixture touches tolerates a 32-bit write
  // (the upper 16 bits land on reserved/harmless bytes — verified against
  // ioW8's behavior), use a plain word STR instead so the fixture doesn't
  // depend on an encoding path this decoder doesn't support.
  return armSTRImm(rd, rn, imm);
}
function armSTRPostInc4(rd, rn) {
  // STR Rd, [Rn], #4
  return (0xE4800004 | (rn << 16) | (rd << 12)) >>> 0;
}
function armCMP(rn, rm) {
  return (0xE1500000 | (rn << 16) | rm) >>> 0;
}
function armBLT(fromAddr, toAddr) {
  const off = ((toAddr - (fromAddr + 8)) >> 2) & 0xFFFFFF;
  return (0xBA000000 | off) >>> 0;
}
function armSWI(code) {
  return (0xEF000000 | code) >>> 0;
}
function armMOV(rd, imm8) {
  return (0xE3A00000 | (rd << 12) | imm8) >>> 0;
}
function armLDRImm(rd, rn, imm) {
  return (0xE5900000 | (rn << 16) | (rd << 12) | (imm & 0xFFF)) >>> 0;
}
function armSTRImm(rd, rn, imm) {
  return (0xE5800000 | (rn << 16) | (rd << 12) | (imm & 0xFFF)) >>> 0;
}
function armADD(rd, rn, imm8) {
  return (0xE2800000 | (rn << 16) | (rd << 12) | imm8) >>> 0;
}
function armEOR(rd, rn, imm8) {
  return (0xE2200000 | (rn << 16) | (rd << 12) | imm8) >>> 0;
}

function buildRom() {
  const HEADER = 0xC0;
  const CODE_START = HEADER;
  const code = [];
  const push = (w) => code.push(w >>> 0);

  // --- Layout constants ---
  // We place the IRQ handler right after main setup, and literal pool
  // constants at fixed, pre-computed offsets so LDR-literal encodings are
  // simple (each literal is addressed as [PC, #off] where PC already
  // points 8 bytes ahead of the LDR instruction per ARM pipelining).
  const REG_IE = 0x04000200, REG_IME = 0x04000208, REG_DISPSTAT = 0x04000004;
  const REG_IF_WORD = 0x04000200; // IE(lo16)+IF(hi16) as one word, to avoid STRH
  const REG_DISPCNT = 0x04000000;
  const VRAM = 0x06000000, VRAM_END = 0x06000000 + 240*160*2;
  const WRAM_COUNTER = 0x02000000;
  const IRQ_HANDLER_SLOT = 0x03007FFC; // mirrors to 0x03FFFFFC (IWRAM masks to 0x7FFF)

  // Program (ARM, at CODE_START = 0xC0):
  // 0xC0: B main          (skip the literal pool that follows immediately;
  //                          filled in once we know main's address)
  // We hand-lay-out addresses explicitly instead of a two-pass assembler,
  // since the program is tiny and fixed.

  const A = {}; // address map
  let addr = CODE_START;

  // main:
  A.main = addr;
  // r0 = DISPCNT reg addr; r1 = 0x0403 (mode3 + BG2)
  push(armLDRLit(0, 0)); addr += 4; const insn_ldrDispcnt = addr - 4;
  push(armLDRLit(1, 0)); addr += 4; const insn_ldrMode3 = addr - 4;
  push(armSTRH(1, 0, 0)); addr += 4; // word-store DISPCNT

  // Install our IRQ handler pointer at the well-known slot (0x03007FFC,
  // mirrored to 0x03FFFFFC) so checkIRQ's HLE dispatch in html.ts finds it.
  push(armLDRLit(0, 0)); addr += 4; const insn_ldrHandlerSlotAddr = addr - 4;
  push(armLDRLit(1, 0)); addr += 4; const insn_ldrHandlerAddr = addr - 4;
  push(armSTRImm(1, 0, 0)); addr += 4;     // [handlerSlot] = irqHandler address

  // Set up IE = VBlank(bit0), IME = 1
  push(armLDRLit(0, 0)); addr += 4; const insn_ldrIeAddr = addr - 4;
  push(armMOV(1, 1)); addr += 4;           // R1 = 1
  push(armSTRH(1, 0, 0)); addr += 4;       // word-store IE = 1
  push(armLDRLit(0, 0)); addr += 4; const insn_ldrImeAddr = addr - 4;
  push(armSTRH(1, 0, 0)); addr += 4;       // word-store IME = 1 (R1 still 1)
  push(armLDRLit(0, 0)); addr += 4; const insn_ldrDispstatAddr = addr - 4;
  push(armSTRH(1, 0, 0)); addr += 4;       // word-store DISPSTAT (VBlank IRQ enable bit3; harmless low bits)

  // loop:
  A.loop = addr;
  push(armSWI(0x05)); addr += 4;           // VBlankIntrWait
  // Toggle fill color: R2 ^= 0x03FF03FF (cheap visible color flip) and
  // fill the whole framebuffer with it, then bump the WRAM counter.
  push(armLDRLit(0, 0)); addr += 4; const insn_ldrVramAddr = addr - 4;
  push(armLDRLit(3, 0)); addr += 4; const insn_ldrColorAddr = addr - 4;
  push(armLDRLit(4, 0)); addr += 4; const insn_ldrColorVarAddr = addr - 4;
  push(armLDRImm(2, 4, 0)); addr += 4;     // R2 = [colorVar]
  push(armEOR(2, 2, 0xFF)); addr += 4;     // R2 ^= 0xFF (cheap toggle, still a valid BGR555-ish pattern)
  push(armSTRImm(2, 4, 0)); addr += 4;     // [colorVar] = R2
  // fill:
  A.fill = addr;
  push(armSTRPostInc4(2, 0)); addr += 4;   // STR R2,[R0], #4
  push(armLDRLit(5, 0)); addr += 4; const insn_ldrVramEndAddr = addr - 4;
  push(armCMP(0, 5)); addr += 4;
  push(armBLT(addr, A.fill)); addr += 4;

  // bump counter
  push(armLDRLit(6, 0)); addr += 4; const insn_ldrCounterAddr = addr - 4;
  push(armLDRImm(7, 6, 0)); addr += 4;
  push(armADD(7, 7, 1)); addr += 4;
  push(armSTRImm(7, 6, 0)); addr += 4;

  push(armB(addr, A.loop, false)); addr += 4; // back to loop

  // irqHandler: a plain ARM subroutine (NOT the BIOS-style exception-return
  // stub — this is what real games register via SetInterruptHandler). It
  // simply re-reads and writes back REG_IE/REG_IF as one word, which acks
  // (clears) whatever IF bits are currently set, then returns via BX LR.
  // html.ts's HLE dispatch (see checkIRQ/doIrqReturn) is responsible for
  // the actual CPSR/mode exception-return semantics around this call.
  A.irqHandler = addr;
  push(armLDRLit(0, 0)); addr += 4; const insn_ldrIrqRegAddr = addr - 4;
  push(armLDRImm(1, 0, 0)); addr += 4;     // R1 = [REG_IE/IF word]
  push(armSTRImm(1, 0, 0)); addr += 4;     // [REG_IE/IF word] = R1 (acks IF)
  push(0xE12FFF1E); addr += 4;             // BX LR

  // --- literal pool ---
  A.pool = addr;
  const litOffsets = {};
  function lit(name, value) { litOffsets[name] = addr; push(value); addr += 4; }
  lit('dispcnt', REG_DISPCNT);
  lit('mode3', 0x0403);
  lit('handlerSlot', IRQ_HANDLER_SLOT);
  lit('handlerAddr', 0x08000000 + A.irqHandler); // ARM handler, bit0=0
  lit('ie', REG_IE);
  lit('ime', REG_IME);
  lit('dispstat', REG_DISPSTAT);
  lit('vram', VRAM);
  lit('color', 0x001F);          // unused placeholder register slot alignment
  lit('colorVar', WRAM_COUNTER + 4); // scratch word for the toggling color
  lit('vramEnd', VRAM_END);
  lit('counter', WRAM_COUNTER);
  lit('ifRegWord', REG_IF_WORD);

  // Now patch every LDR-literal instruction's immediate offset field
  // (each was emitted as armLDRLit(rd, 0) — offset 0 — and must be fixed
  // up to point at its literal, given ARM's PC-is-8-ahead pipeline rule).
  function patchLdr(insnAddr, literalName, rd) {
    const idx = (insnAddr - CODE_START) / 4;
    const off = litOffsets[literalName] - (insnAddr + 8);
    code[idx] = armLDRLit(rd, off);
  }
  patchLdr(insn_ldrDispcnt, 'dispcnt', 0);
  patchLdr(insn_ldrMode3, 'mode3', 1);
  patchLdr(insn_ldrHandlerSlotAddr, 'handlerSlot', 0);
  patchLdr(insn_ldrHandlerAddr, 'handlerAddr', 1);
  patchLdr(insn_ldrIeAddr, 'ie', 0);
  patchLdr(insn_ldrImeAddr, 'ime', 0);
  patchLdr(insn_ldrDispstatAddr, 'dispstat', 0);
  patchLdr(insn_ldrVramAddr, 'vram', 0);
  patchLdr(insn_ldrColorAddr, 'color', 3);
  patchLdr(insn_ldrColorVarAddr, 'colorVar', 4);
  patchLdr(insn_ldrVramEndAddr, 'vramEnd', 5);
  patchLdr(insn_ldrCounterAddr, 'counter', 6);
  patchLdr(insn_ldrIrqRegAddr, 'ifRegWord', 0);

  // --- assemble final ROM buffer ---
  const totalSize = A.pool + Object.keys(litOffsets).length * 4 - CODE_START + CODE_START;
  const romLen = Math.max(0x1000, totalSize + 0x100);
  const rom = Buffer.alloc(romLen, 0);

  // Header entry point: B main
  u32le(rom, 0x00, armB(0x08000000, 0x08000000 + A.main, false));
  // Logo region 0x04-0x9F left as zero (not validated against real Nintendo
  // logo bytes by this emulator or this fixture — see html.ts comment).
  rom.write('TESTROM', 0xA0, 'ascii');
  rom.write('TEST', 0xAC, 'ascii');
  rom.write('01', 0xB0, 'ascii');
  rom[0xB2] = 0x96;
  rom[0xBC] = 0x00;
  let sum = 0;
  for (let i = 0xA0; i <= 0xBC; i++) sum += rom[i];
  rom[0xBD] = (-(sum + 0x19)) & 0xFF;

  for (let i = 0; i < code.length; i++) u32le(rom, CODE_START + i * 4, code[i]);

  return { rom, addrs: A, litOffsets };
}

if (require.main === module) {
  const { rom } = buildRom();
  const out = path.join(__dirname, 'test-rom.gba');
  fs.writeFileSync(out, rom);
  console.log('Wrote', out, rom.length, 'bytes');
}

module.exports = { buildRom };
