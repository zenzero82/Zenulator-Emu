// Synthetic Node/V8 throughput, NOT device FPS. Run: node emulator/fixtures/benchmark-ppu.js
// Real extracted core + real homebrew ROM + full CPU/PPU/DMA/timer frame execution.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { extractCoreScript } = require('./extract-core');
const { makeSandbox } = require('./run-core');
const { originalTwoCycleScheduler } = require('./scheduler-baseline');

const rom = fs.readFileSync(path.join(__dirname, 'test-rom.gba'));
// Compare the original scheduler with PPU_SCHEDULER=baseline. The optional
// PPU_SCENARIO=idle parks the initialized homebrew scene (not a real game).
const scheduler = process.env.PPU_SCHEDULER || 'optimized';
const scenario = process.env.PPU_SCENARIO || 'fixture';
assert.ok(['baseline', 'optimized'].includes(scheduler));
assert.ok(['fixture', 'idle'].includes(scenario));
let source = scheduler === 'baseline' ? originalTwoCycleScheduler(extractCoreScript()) : extractCoreScript();
// Freeze the pre-optimization byte-composed loads for a same-core A/B test.
const memoryReads = process.env.PPU_MEMORY_READS || 'optimized';
assert.ok(['baseline', 'optimized'].includes(memoryReads));
if (memoryReads === 'baseline') {
  assert.ok(source.includes('function r16(addr){return readMemory(addr&~1,2);}'));
  assert.ok(source.includes('function r32(addr){return readMemory(addr&~3,4);}'));
  source = source
  .replace('function r16(addr){return readMemory(addr&~1,2);}', 'function r16(addr){addr&=~1;return r8(addr)|(r8(addr+1)<<8);}')
  .replace('function r32(addr){return readMemory(addr&~3,4);}', 'function r32(addr){addr&=~3;return(r8(addr)|(r8(addr+1)<<8)|(r8(addr+2)<<16)|(r8(addr+3)<<24))>>>0;}');
}
const script = source.replace(/\}\)\(\);\s*$/, `
  var benchmarkCompositorMs=0,benchmarkLines=0;
  var originalRenderLine=renderLine;
  renderLine=function(ln){
    var start=__realNow();
    originalRenderLine(ln);
    benchmarkCompositorMs+=__realNow()-start;
    benchmarkLines++;
  };
  window.benchmarkCore={
    boot:function(bytes){
      rom=new Uint8Array(bytes);resetGBA();
      // Disable ONLY the callback wall-time budget, only in this benchmark.
      MAX_CALLBACK_MS=Infinity;
    },
    park:function(){
      halted=true;
      for(var t=0;t<4;t++)w8(0x04000102+t*4,0);
    },
    stats:function(){return {
      frames:vblankCount,lines:benchmarkLines,compositorMs:benchmarkCompositorMs,
      instructions:instrCount,error:cpuErrorInfo,stuck:stuckReason
    };}
  };
})();`);

function sample(frames) {
  const host = makeSandbox();
  const names = Object.keys(host.sandbox);
  new Function(...names, '__realNow', script)(
    ...names.map((name) => host.sandbox[name]), () => performance.now());
  const core = host.sandbox.window.benchmarkCore;
  core.boot(rom);
  // Wall clock advances only BETWEEN callbacks; never while a callback works.
  // One callback accrues exactly one GBA frame of cycles; no CPU/PPU skipping.
  const frameMs = 280896 / 16777216 * 1000;
  if (scenario === 'idle') {
    host.advanceTime(frameMs);
    host.rafQueue.shift().fn(); // initialize the real fixture's display first
    assert.ok(core.stats().instructions > 0);
    core.park();
  }
  const before = core.stats();
  const start = performance.now();
  for (let i = 0; i < frames; i++) {
    host.advanceTime(frameMs);
    assert.equal(host.rafQueue.length, 1);
    host.rafQueue.shift().fn();
  }
  const elapsedMs = performance.now() - start;
  const stats = core.stats();
  assert.equal(stats.error, null, JSON.stringify(stats.error));
  assert.equal(stats.stuck, null, JSON.stringify(stats.stuck));
  assert.equal(stats.frames - before.frames, frames, 'must execute complete emulated frames');
  assert.equal(stats.lines - before.lines, frames * 160, 'must render every visible scanline');
  const instructions = stats.instructions - before.instructions;
  if (scenario === 'fixture') assert.ok(instructions > 0, 'must execute ROM instructions');
  else assert.equal(instructions, 0, 'parked CPU must retire no instructions');
  return { fullCoreMs: elapsedMs, compositorMs: stats.compositorMs - before.compositorMs, instructions };
}

const warmup = Number(process.env.PPU_WARMUP || 4);
const frames = Number(process.env.PPU_FRAMES || 24);
const repeats = Number(process.env.PPU_REPEATS || 5);
sample(warmup);
const samples = Array.from({ length: repeats }, () => sample(frames));
const median = (key) => samples.map((s) => s[key]).sort((a, b) => a - b)[Math.floor(repeats / 2)];
console.log(JSON.stringify({
  description: scenario === 'fixture'
    ? 'Node/V8 synthetic, real homebrew ROM full emulated frames; not device FPS'
    : 'Node/V8 synthetic, parked initialized homebrew scene with full raster/audio; not gameplay or device FPS',
  scheduler, scenario, memoryReads, frames, repeats, instructions: samples[0].instructions,
  fullCoreMedianMs: median('fullCoreMs'), compositorMedianMs: median('compositorMs'),
  samples
}, null, 2));