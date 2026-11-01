'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { extractCoreScript } = require('../fixtures/extract-core');
const { makeSandbox } = require('../fixtures/run-core');

test('PC history wraps, resets, and preserves stuck classifications', () => {
  const { sandbox } = makeSandbox();
  const script = extractCoreScript().replace(/\}\)\(\);\s*$/, `
window.inspectHistory=function(count,unique,overThreshold){
  rom=new Uint8Array(1024);resetGBA();traceActive=false;
  for(var i=0;i<count;i++)recordStep(0x08000000+(i%unique)*4,0,'ARM');
  r[15]=0x08000004;
  instrSinceVBlank=overThreshold?500001:140448;
  return {count:pcHistoryCount,history:Array.from(pcHistory),stuck:classifyStuck()};
};
})();`);
  vm.runInNewContext(script, sandbox);
  const inspect = sandbox.window.inspectHistory;
  assert.equal(inspect(32,1,false).stuck,null, 'legitimate idle loop must run');
  assert.equal(inspect(32,1,true).stuck.category,'pc-frozen');
  assert.equal(inspect(32,3,true).stuck.category,'pc-oscillating');
  const full = inspect(32,8,true);
  assert.equal(full.stuck,null);
  assert.equal(new Set(full.history).size,8);
  assert.equal(full.count,8);
  const reset = inspect(2,1,true);
  assert.equal(reset.count,2);
  assert.equal(reset.stuck,null,'old entries must not survive reset');
});

test('boot trace completes once while counters and dense/jump crash evidence stay live', () => {
  const { sandbox, posted, listeners } = makeSandbox();
  const script = extractCoreScript().replace(/\}\)\(\);\s*$/, `
window.resetTraceForTest=function(){
  rom=new Uint8Array(1024);
  rom.set([0xfe,0xff,0xff,0xea]); // ARM b . keeps boot sampling deterministic
  resetGBA();
};
window.runTraceStepsForTest=function(count){
  for(var i=0;i<count;i++)stepARM();
  return {traceInstrCount:traceInstrCount,instrCount:instrCount,
    ipsCount:ipsCount,instrSinceVBlank:instrSinceVBlank,pcHistoryCount:pcHistoryCount};
};
window.crashAfterTraceForTest=function(){
  rom.set([0x1e,0xff,0x2f,0xe1]); // ARM bx lr departs ROM after trace completion
  r[14]=0x1000;
  stepARM();
  for(var i=0;i<96;i++)stepARM(); // sequential zero-filled BIOS slide wraps dense history
  return buildCrashReport('pc-unmapped');
};
})();`);
  vm.runInNewContext(script, sandbox);
  const getBootTrace = () => {
    listeners.message.forEach(fn => fn({ data: JSON.stringify({ type: 'getBootTrace' }) }));
    return posted[posted.length - 1];
  };
  sandbox.window.resetTraceForTest();
  assert.equal(getBootTrace().traceActive, true);

  sandbox.window.runTraceStepsForTest(699999);
  const filling = getBootTrace();
  assert.equal(filling.events.length, 1199);
  assert.equal(filling.traceActive, true, 'sampling must stay active until the final slot fills');
  const completedCounters = sandbox.window.runTraceStepsForTest(1);
  const completed = getBootTrace();
  assert.equal(completed.type, 'bootTrace');
  assert.equal(completed.events.length, 1200);
  assert.equal(completed.traceActive, false);
  assert.equal(completed.events[0].n, 1, 'retain the earliest boot sample');
  assert.equal(completed.events[499].n, 500);
  assert.equal(completed.events[500].n, 1000);
  assert.equal(completed.events[1199].n, 700000);
  assert.equal(completedCounters.traceInstrCount, 700000);

  sandbox.window.runTraceStepsForTest(2000);
  const report = sandbox.window.crashAfterTraceForTest();
  assert.deepEqual(getBootTrace(), completed, 'completed boot samples must never shift or change');
  const counters = sandbox.window.runTraceStepsForTest(0);
  assert.equal(counters.traceInstrCount, completedCounters.traceInstrCount, 'sample counter stops too');
  for (const name of ['instrCount', 'ipsCount', 'instrSinceVBlank']) {
    assert.equal(counters[name], completedCounters[name] + 2097, name + ' must remain live');
  }
  assert.equal(counters.pcHistoryCount, 8);
  assert.equal(report.cycle, counters.instrCount);
  assert.equal(report.lastSteps.length, 64);
  assert.equal(report.lastSteps[0], '1080:0:A');
  assert.equal(report.lastSteps[63], '117c:0:A', 'dense history must contain the latest crash steps');
  assert.ok(report.jumps.includes('8000000>1000'), 'departure jump survives the long slide');
  assert.ok(report.jumps.includes('8000000>8000000 x702000'), 'loop dedup counters remain live');
  assert.equal(report.instruction, '0x0');
  assert.equal(report.mode, 'ARM');

  sandbox.window.resetTraceForTest();
  const reset = getBootTrace();
  assert.equal(reset.traceActive, true, 'reset rearms boot sampling');
  assert.deepEqual(reset.events, []);
  assert.equal(sandbox.window.runTraceStepsForTest(1).traceInstrCount, 1);
  assert.equal(getBootTrace().events[0].n, 1);
});