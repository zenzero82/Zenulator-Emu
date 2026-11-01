'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCoreScript } = require('../fixtures/extract-core');
const { makeSandbox } = require('../fixtures/run-core');
const { originalTwoCycleScheduler, originalTimerTicks } = require('../fixtures/scheduler-baseline');

const source = extractCoreScript();
const baseline = originalTwoCycleScheduler(originalTimerTicks(source));

// Mainline: VBlankIntrWait, count wakes, repeat. A real HLE-dispatched ARM IRQ handler
// acknowledges IF and returns to the sentinel with BX LR.
function makeRom() {
  const rom = Buffer.alloc(0x200);
  rom.writeUInt32LE(0xef050000, 0);
  rom.writeUInt32LE(0xe2888001, 4); // add r8,r8,#1
  rom.writeUInt32LE(0xeafffffc, 8); // b 0
  rom.writeUInt32LE(0xe5901200, 0x40); // ldr r1,[r0,#0x200]
  rom.writeUInt32LE(0xe5801200, 0x44); // str r1,[r0,#0x200] (ack IF)
  rom.writeUInt32LE(0xe12fff1e, 0x48); // bx lr
  return rom;
}

function core(script, setup = '') {
  const host = makeSandbox();
  const names = Object.keys(host.sandbox);
  const hooked = script.replace(/\}\)\(\);\s*$/, `
    var testCycles=0,testTicks=[],testEvents=[],testSteps=[];
    var oldTick=tickTimers,oldSample=pushAudioSample,oldRender=renderLine;
    var oldDMA=triggerDMA,oldIRQ=checkIRQ,oldARM=stepARM,oldTHUMB=stepTHUMB;
    tickTimers=function(c,idle){testTicks.push(c);testCycles+=c;oldTick(c,idle);};
    pushAudioSample=function(){testEvents.push(['audio',testCycles]);oldSample();};
    renderLine=function(y){testEvents.push(['render',testCycles,y]);oldRender(y);};
    triggerDMA=function(t){testEvents.push(['dma',testCycles,t]);oldDMA(t);};
    checkIRQ=function(){
      var n=irqCount;oldIRQ();
      if(n!==irqCount)testEvents.push(['irq',testCycles,lastIRQ.pending,scanline,r[15]]);
    };
    stepARM=function(){testSteps.push([testCycles,r[15],instrCount]);oldARM();};
    stepTHUMB=function(){testSteps.push([testCycles,r[15],instrCount]);oldTHUMB();};
    window.testCore={
      boot:function(bytes){
        rom=new Uint8Array(bytes);resetGBA();halted=true;r[15]=0x08000008;MAX_CALLBACK_MS=Infinity;
        w32(IRQ_HANDLER_PTR_ADDR,0x08000040);
      },
      run:function(code){return eval(code);},
      budget:function(c){pacingCycles=c;lastPacingMs=performance.now();},
      snapshot:function(){return {
        cycles:testCycles,events:testEvents,steps:testSteps,
        r:Array.from(r),cpsr:cpsr,halted:halted,wait:intrWaitFlags,
        irqStack:irqReturnStack,irqCount:irqCount,instrCount:instrCount,
        scanline:scanline,scanlineCycles:scanlineCycles,hblank:hblankFlagged,
        vblanks:vblankCount,pacing:pacingCycles,io:Array.from(io),pal:Array.from(pal),
        pixels:Array.from(pixels),presentation:Array.from(presentationData.data),
        timerCounter:timerCounter,timerPrescaleCnt:timerPrescaleCnt,dma:dma,
        audioAcc:audioCycleAcc,audioWrite:audioWrite,audioRead:audioRead,
        audioL:Array.from(audioRingL.slice(0,Math.min(audioWrite,AUDIO_RING))),
        audioR:Array.from(audioRingR.slice(0,Math.min(audioWrite,AUDIO_RING))),
        psgOn:psgOn,sqTimer:sqTimer,sqDutyPos:sqDutyPos,psgFrame:psgFrame,
        psgFrameAcc:psgFrameAcc,dsA:dsA,dsB:dsB,fifoALen:fifoALen,fifoBLen:fifoBLen,
        error:cpuErrorInfo,stuck:stuckReason,linkBusy:linkBusy,linkActiveId:linkActiveId
      };},
      ticks:function(){return testTicks;}
    };
  })();`);
  new Function(...names, hooked)(...names.map((name) => host.sandbox[name]));
  const api = host.sandbox.window.testCore;
  api.boot(makeRom());
  api.run(setup);
  function tick(budget) {
    api.budget(budget);
    assert.equal(host.rafQueue.length, 1);
    host.rafQueue.shift().fn();
  }
  function send(data) {
    host.listeners.message.forEach((fn) => fn({ data: JSON.stringify(data) }));
  }
  return { host, api, tick, send };
}

function pair(setup = '') {
  const old = core(baseline, setup);
  const current = core(source, setup);
  function compare(budget) {
    old.tick(budget);
    current.tick(budget);
    const actual = current.api.snapshot();
    assert.deepEqual(actual, old.api.snapshot(), `budget ${budget}: all hardware/state/event order`);
    assert.equal(actual.error, null);
    assert.equal(actual.stuck, null);
    return actual;
  }
  return { old, current, compare };
}

const audioSetup = `
  w16(0x04000084,0x80);w16(0x04000080,0x1177);w16(0x04000082,2);
  w16(0x04000062,0xF080);w16(0x04000064,0x8400);
`;

test('idle batching retains audio samples, every rendered line, HBlank DMA and full raster wrap', () => {
  const p = pair(audioSetup + `
    w16(0x04000000,0x0403);
    for(var i=0;i<SCREEN_W*SCREEN_H;i++)w16(0x06000000+i*2,i&0x7FFF);
    w16(0x02000000,0x1234);
    w32(0x040000B0,0x02000000);w32(0x040000B4,0x05000000);
    w16(0x040000B8,1);w16(0x040000BA,0xA340);
  `);
  const s = p.compare(280896 * 2);
  assert.equal(s.vblanks, 2);
  assert.equal(s.events.filter((e) => e[0] === 'render').length, 320);
  assert.equal(s.audioWrite, 1097);
  assert.ok(s.audioL.some((v) => v !== 0), 'real PSG samples are non-silent');
  assert.equal(s.pal[0] | (s.pal[1] << 8), 0x1234, 'real HBlank DMA executed');
  assert.ok(p.current.api.ticks().some((c) => c > 2), 'idle path actually batches');
  assert.ok(p.current.api.ticks().length < p.old.api.ticks().length / 100);
});

for (const [name, dispstat, ie, cycles, pending] of [
  ['HBlank', 0x10, 2, 1000, 2],
  ['VCount', 0x0120, 4, 1272, 4],
  ['VBlank', 0x08, 1, 160 * 1232 + 40, 1],
  ['VCount at wrap to zero', 0x20, 4, 280896 + 40, 4],
]) {
  test(`${name} IRQ wakes at the original cycle and executes the first handler instruction`, () => {
    const p = pair(`io[4]=${dispstat & 255};io[5]=${dispstat >>> 8};io[0x200]=${ie};io[0x208]=1;`);
    const s = p.compare(cycles);
    assert.equal(s.irqCount, 1);
    assert.equal(s.r[8], 1, 'mainline resumed once');
    const irq = s.events.find((e) => e[0] === 'irq');
    assert.equal(irq[2], pending);
    assert.equal(s.steps[0][1], 0x08000044, 'same-iteration dispatch fetch uses handler+4');
    assert.equal(s.steps[0][0], irq[1]);
  });
}

test('coincident audio, VCount and VBlank preserve IRQ order and combined pending flags', () => {
  const p = pair(audioSetup + 'io[4]=0x38;io[5]=160;io[0x200]=7;io[0x208]=1;intrWaitFlags=1;');
  const boundary = 160 * 1232;
  const s = p.compare(boundary + 8);
  assert.ok(s.irqCount > 150, 'unrelated HBlank wakes re-park IntrWait');
  assert.equal(s.events.filter((e) => e[0] === 'irq').at(-1)[2], 5);
  assert.deepEqual(s.events.filter((e) => e[1] === boundary).map((e) => e[0]),
    ['audio', 'dma', 'irq'], 'sample then VBlank DMA then next-iteration dispatch');
  assert.equal(s.wait, null, 'only awaited VBlank releases IntrWait');
  assert.equal(s.r[8], 1);
  assert.equal(p.compare(32).wait, 1, 'mainline enters the next VBlankIntrWait normally');
});

test('pending enabled IF wakes even without IME, before batching is selected', () => {
  const p = pair('io[0x200]=2;io[0x202]=2;io[0x208]=0;');
  const s = p.compare(6);
  assert.equal(s.irqCount, 0);
  assert.equal(s.instrCount, 3, 'pending HALT wakes even with delivery disabled');
  assert.equal(p.current.api.ticks()[0], 2, 'executed instruction is not expanded');
});

test('instructions that newly halt or return to the IRQ sentinel retain two-cycle accounting', () => {
  const p = pair('halted=false;r[15]=0x08000004;io[4]=0x10;io[0x200]=2;io[0x208]=1;intrWaitFlags=1;');
  const s = p.compare(1100);
  assert.ok(s.steps.length >= 4, 'IntrWait and real IRQ handler ran');
  assert.equal(s.halted, true, 'unrelated IRQ sentinel return re-parks the wait');
  // Each instruction completes at +2, including SWI IntrWait and BX LR that
  // atomically unwinds to a newly halted state.
  const ticks = p.current.api.ticks();
  let elapsed = 0;
  const instructionCycles = new Map();
  for (const delta of ticks) { instructionCycles.set(elapsed, delta); elapsed += delta; }
  for (const [at] of s.steps) assert.equal(instructionCycles.get(at), 2);
});

test('sentinel already present at iteration start unwinds before idle batching', () => {
  const p = pair(`
    cpsr=0x92;r[15]=(IRQ_RETURN_MAGIC+4)>>>0;intrWaitFlags=1;
    irqSPSR=0x1F;r[13]=0x03007F88;
    [11,22,33,44,55,0x08000004].forEach(function(v,i){w32(r[13]+i*4,v);});
    irqReturnStack.push({lr:0x08000004,spsr:0x1F,pending:2,prevIrqSPSR:0});
  `);
  const s = p.compare(101);
  assert.equal(s.irqStack.length, 0);
  assert.equal(s.r[0], 11);
  assert.equal(s.wait, 1);
  assert.equal(p.current.api.ticks()[0], 2, 'sentinel-only iteration remains two cycles');
  assert.ok(p.current.api.ticks()[1] > 2);
});

for (let timer = 0; timer < 4; timer++) {
  for (const cascade of timer > 0 ? [false, true] : [false]) {
    test(`enabled timer ${timer} (${cascade ? 'cascade' : 'clocked'}) batches without changing hardware events`, () => {
      const p = pair(audioSetup + `
        w16(0x04000100+${timer}*4,0xFF00);
        w16(0x04000102+${timer}*4,${cascade ? 0xC4 : 0xC0});
        timerCounter[${timer}]=0xFF00;
        w32(0x040000A0,0x40404040);
      `);
      const s = p.compare(3000.25);
      assert.ok(p.current.api.ticks().some((c) => c > 2));
      assert.equal(s.cycles, 3002);
      if (!cascade) assert.ok(s.io[0x202] & (8 << timer), 'real timer overflow IRQ raised');
    });
  }
}

test('timer enabled by HBlank DMA constrains subsequent idle batches', () => {
  const p = pair(`
    w16(0x02000000,0x0080);
    w32(0x040000B0,0x02000000);w32(0x040000B4,0x04000102);
    w16(0x040000B8,1);w16(0x040000BA,0xA140);
  `);
  const s = p.compare(1100);
  assert.ok(s.io[0x102] & 0x80);
  assert.ok(p.current.api.ticks().some((c) => c > 2));
  assert.ok(p.current.api.ticks().at(-1) > 2);
});

test('prescaled clocks, cascades and odd phases preserve every sample and IRQ edge', () => {
  for (let prescaler = 0; prescaler < 4; prescaler++) {
    const p = pair(audioSetup + `
      w16(0x04000100,0xFFFD);w16(0x04000102,0xC0|${prescaler});
      w16(0x04000104,0xFFFE);w16(0x04000106,0xC4);
      w16(0x04000108,0xFFFF);w16(0x0400010A,0xC4);
      timerPrescaleCnt[0]=${[0, 63, 255, 1023][prescaler]};
    `);
    for (const cycles of [3, 123, 511, 1025, 4097]) p.compare(cycles);
  }
});

test('FIFO DMA sees other timer counters at the correct pre-edge phase', () => {
  const p = pair(audioSetup + `
    w16(0x04000100,0xFF80);w16(0x04000102,0x80);
    w16(0x04000104,0x1234);w16(0x04000106,0x80);
    w32(0x040000BC,0x04000104);w32(0x040000C0,0x040000A0);
    w16(0x040000C4,4);w16(0x040000C6,0xB740);
  `);
  for (const cycles of [128, 256, 511, 1024]) p.compare(cycles);
});

test('odd/fractional budgets and loaded odd hardware phases stay on the original two-cycle grid', () => {
  for (const phase of [0, 1, 0.5]) {
    const p = pair(audioSetup + `scanlineCycles=${phase};audioCycleAcc=${phase};`);
    for (const budget of [0, 0.25, 1, 1.5, 3, 509.5, 447, 273.25, 1233, 2047.5, 0.1]) {
      const before = p.current.api.snapshot().cycles;
      const s = p.compare(budget);
      assert.equal(s.cycles - before, Math.ceil(budget / 2) * 2);
      assert.equal(s.pacing, 0);
    }
  }
});

test('serial wait freezes hardware; completion IRQ wakes before a new start blocks at +2 cycles', () => {
  const p = pair(`
    linkConnected=true;linkBusy=true;linkActiveId=9;io[0x128]=0x80;io[0x129]=0x60;
    io[0x200]=0x80;
    // On serial completion the first real instruction writes a SIO start.
    r[0]=0x04000128;r[1]=0x80;r[15]=0x08000084;
    rom[0x80]=0;rom[0x81]=0x10;rom[0x82]=0xC0;rom[0x83]=0xE5;
  `);
  assert.equal(p.compare(20000).cycles, 0);
  const completion = { type: 'linkRemoteComplete', id: 9, words: [0x1234, 0xABCD, 0xFFFF, 0xFFFF] };
  p.old.send(completion);
  p.current.send(completion);
  const s = p.compare(20000);
  assert.equal(s.cycles, 2, 'SIO-start instruction costs exactly two cycles');
  assert.equal(s.instrCount, 1);
  assert.equal(s.linkBusy, true);
  assert.equal(s.pacing, 0);
  assert.equal(p.compare(20000).cycles, 2, 'pending transfer advances no hardware');
  assert.deepEqual(p.current.host.posted, p.old.host.posted);
});

test('wall-clock yield stays at the original 2048-cycle work boundary while halted', () => {
  const p = pair('MAX_CALLBACK_MS=10;');
  for (const c of [p.old, p.current]) {
    let clock = 0;
    c.host.sandbox.performance.now = () => (clock += 11);
  }
  const s = p.compare(280896 * 4);
  assert.equal(s.cycles, 2048);
  assert.equal(s.pacing, 280896 * 4 - 2048);
});