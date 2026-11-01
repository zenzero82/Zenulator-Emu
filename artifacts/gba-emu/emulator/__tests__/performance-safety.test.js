'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractCoreScript } = require('../fixtures/extract-core');
const { makeSandbox } = require('../fixtures/run-core');

function setup() {
  const host = makeSandbox();
  const script = extractCoreScript().replace(/\}\)\(\);\s*$/, `
    window.performanceTest={run:function(s){return eval(s);}};
  })();`);
  const names = Object.keys(host.sandbox);
  new Function(...names, script)(...names.map((name) => host.sandbox[name]));
  return {
    ...host,
    run: host.sandbox.window.performanceTest.run,
    send(data) { for (const handler of host.listeners.message) handler({ data: JSON.stringify(data) }); },
  };
}

test('aligned loads equal byte reads across mirrors, GPIO, I/O and 64MB upper-bank boundaries', () => {
  const h = setup();
  const mismatches = h.run(`(function(){
    var failures=[],addresses=[0,0x3ffe,0x02000001,0x0203fffe,0x02040000,
      0x03007fff,0x03008000,0x04000004,0x04000400,0x050003fe,
      0x06017ffe,0x06018000,0x0601fffe,0x070003ff,0x08000000,
      0x080000c2,0x080000c4,0x080000c8,0x080000ca,0x09fffffe,
      0x0a000000,0x0bfffffe,0x0c000000,0x0dfffffe,0x0e000000,0xffffffff];
    for(var size of [7,0x2000000,0x4000000]){
      rom=new Uint8Array(size);
      for(var q=0;q<Math.min(size,256);q++)rom[q]=(q*17+3)&255;
      if(size>0x2000000)rom.set([0xef,0xcd,0xab,0x89],0x2000000);
      wram.fill(0x93);iwram.fill(0x72);pal.fill(0x55);vram.fill(0x34);oam.fill(0xa9);
      for(var gpio of [false,true]){
        gpioReadEnable=gpio;
        for(var a of addresses)for(var width of [2,4]){
          var aligned=(a&~(width-1))>>>0,expected=0;
          for(var b=0;b<width;b++)expected|=r8(aligned+b)<<(b*8);
          expected=width===4?expected>>>0:expected;
          var actual=width===4?r32(a):r16(a);
          if(actual!==expected)failures.push([size,gpio,a,width,actual,expected]);
        }
      }
    }
    return failures;
  })()`);
  assert.deepEqual(mismatches, []);
  assert.equal(h.run('gpioReadEnable=false;r32(0x0a000000)'), 0x89abcdef);
});

test('native background stops CPU work, drops stale FF and keys, and foreground resumes without debt', () => {
  const h = setup();
  h.run('rom=new Uint8Array(512);resetGBA();halted=true;');
  h.send({ type: 'setFastForward', factor: 4 });
  h.send({ type: 'keydown', key: 'b' });
  h.send({ type: 'nativeAudioState', active: false });
  assert.equal(h.run('fastForward'), 1);
  assert.equal(h.run('keyinput'), 0x3ff);
  const frames = h.run('vblankCount');
  h.advanceTime(5000);
  h.run('runFrame()');
  assert.equal(h.run('vblankCount'), frames);
  assert.equal(h.run('frameTimerTimeout'), true);
  h.send({ type: 'nativeAudioState', active: true });
  assert.equal(h.run('frameTimerTimeout'), false);
  assert.equal(h.run('pacingCycles'), 0);
});

test('performance report contains finite real counters without exposing memory or save payloads', () => {
  const h = setup();
  const result = h.run('performanceSnapshot(performance.now())');
  for (const value of Object.values(result)) assert.ok(Number.isFinite(value));
  for (const key of ['emulatedFps', 'presentedFps', 'actualSpeed', 'targetSpeed',
    'averageFrameWorkMs', 'peakFrameWorkMs', 'averageSampledRenderMs',
    'audioUnderruns', 'skippedVideoFrames', 'mainThreadStalls', 'budgetYields']) {
    assert.ok(key in result, key);
  }
  assert.equal('rom' in result, false);
  assert.equal('sram' in result, false);
});
