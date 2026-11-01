'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { makeSandbox } = require('../fixtures/run-core');
const { extractCoreScript } = require('../fixtures/extract-core');

const ROM = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'test-rom.gba'));

function core(options = {}) {
  const host = makeSandbox();
  const tasks = [];
  let taskId = 10000;
  if (options.tasks) {
    host.sandbox.setTimeout = (fn, delay) => {
      const id = ++taskId;
      tasks.push({ id, fn, delay });
      return id;
    };
    host.sandbox.clearTimeout = (id) => {
      const index = tasks.findIndex((task) => task.id === id);
      if (index >= 0) tasks.splice(index, 1);
    };
  }
  const presented = [];
  const canvas = host.sandbox.document.getElementById('screen');
  canvas.getContext = () => ({
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(img) { presented.push(new Uint8ClampedArray(img.data)); },
  });
  const ctx = vm.createContext(host.sandbox);
  const script = extractCoreScript().replace(/\}\)\(\);\s*$/, `
    globalThis.__test={get:function(s){return eval(s)},run:function(s){return eval(s)}};
  })();`);
  vm.runInContext(script, ctx);
  const state = new Proxy({}, {
    get(_, key) { return ctx.__test.get(key); },
    set(_, key, value) {
      ctx.__next = value;
      ctx.__test.run(key + '=globalThis.__next');
      return true;
    },
  });
  ctx.__next = new Uint8Array(ROM);
  ctx.__test.run('rom=globalThis.__next;resetGBA();halted=true');
  function tick(ms) {
    host.advanceTime(ms);
    assert.equal(host.rafQueue.length, 1, 'only one callback is queued');
    host.rafQueue.shift().fn();
  }
  function send(message) {
    for (const listener of host.listeners.message)
      listener({ data: JSON.stringify(message) });
  }
  return { host, ctx: state, run: ctx.__test.run, tick, send, presented, tasks };
}

test('only native Android FF backlog gets a task instead of waiting for another display tick', () => {
  for (const platform of ['android', 'ios', 'web']) {
    const c = core({ tasks: true });
    c.send({ type: 'setHostPlatform', platform });
    c.send({ type: 'setFastForward', factor: 4 });
    c.ctx.pacingCycles = c.ctx.FRAME_CYCLES;
    c.run('scheduleFrame()');
    assert.equal(c.tasks.length, platform === 'android' ? 1 : 0);
    assert.equal(c.host.rafQueue.length, platform === 'android' ? 0 : 1);
    if (platform === 'android') {
      assert.equal(c.tasks[0].delay, 0);
      c.send({ type: 'setFastForward', factor: 1 });
      assert.equal(c.tasks.length, 0, 'normal speed cancels pending FF continuation');
      assert.equal(c.host.rafQueue.length, 1);
    }
  }
});

test('Android task continuation stops when caught up, paused, link-blocked, crashed or backgrounded', () => {
  const c = core({ tasks: true });
  c.send({ type: 'setHostPlatform', platform: 'android' });
  c.send({ type: 'setFastForward', factor: 3 });
  for (const condition of [
    'pacingCycles=0',
    'running=false',
    'linkConnected=true;linkBusy=true',
    "stuckReason={category:'test'}",
    "cpuErrorInfo={kind:'test'}",
  ]) {
    c.run('pacingCycles=FRAME_CYCLES;running=true;linkConnected=false;linkBusy=false;stuckReason=null;cpuErrorInfo=null');
    c.run(condition + ';scheduleFrame()');
    assert.equal(c.tasks.length, 0, condition);
    assert.equal(c.host.rafQueue.length, 1, condition);
  }
  c.run('cpuErrorInfo=null;pacingCycles=FRAME_CYCLES;audioNativeActive=false;scheduleFrame()');
  assert.equal(c.tasks.length, 1);
  assert.equal(c.tasks[0].delay, 1000, 'background stays on its low-frequency maintenance timer');
});

test('Android FF processes more real emulated cycles when display deadlines throttle busy callbacks', (t) => {
  function simulate(platform) {
    const c = core({ tasks: true });
    c.send({ type: 'setHostPlatform', platform });
    c.send({ type: 'setFastForward', factor: 4 });
    let clock = 0, callbacks = 0, continuations = 0;
    // Model CPU cost on each existing sparse clock read, plus a 30Hz
    // display and the browser's nested-timer clamp. This is NOT device FPS.
    c.host.sandbox.performance.now = () => (clock += 0.08);
    while (clock < 2000) {
      let event;
      if (c.tasks.length) {
        event = c.tasks.shift();
        clock += Math.max(4, event.delay);
        continuations++;
      } else {
        assert.equal(c.host.rafQueue.length, 1);
        event = c.host.rafQueue.shift();
        clock = (Math.floor(clock / (1000 / 30)) + 1) * (1000 / 30);
      }
      const start = clock;
      event.fn();
      assert.ok(clock - start < 55, 'work still yields within the existing bounded burst');
      assert.equal(c.tasks.length + c.host.rafQueue.length, 1, 'no duplicate CPU loops');
      callbacks++;
      assert.ok(callbacks < 500);
    }
    return { frames: c.ctx.vblankCount, continuations, clock };
  }
  const android = simulate('android');
  const display = simulate('ios');
  t.diagnostic(`Synthetic busy-clock simulation, not device FPS: ${JSON.stringify({ android, display })}`);
  assert.ok(android.continuations > 0);
  assert.equal(display.continuations, 0);
  assert.ok(android.frames / android.clock > display.frames / display.clock * 1.1,
    `Android continuation should recover display-wait time: ${JSON.stringify({ android, display })}`);
});

test('native Android preserves every requested multiplier across display rates when not CPU-limited', () => {
  for (const factor of [1, 2, 3, 4]) {
    for (const hz of [30, 60, 120]) {
      const c = core({ tasks: true });
      c.send({ type: 'setHostPlatform', platform: 'android' });
      c.send({ type: 'setFastForward', factor });
      for (let i = 0; i < hz; i++) c.tick(1000 / hz);
      assert.ok(Math.abs(c.ctx.vblankCount - 59.7275 * factor) <= 1, `${factor}x at ${hz}Hz`);
      assert.equal(c.tasks.length, 0, 'no timer churn once outstanding cycles are completed');
    }
  }
});

test('30/60/90/120/144 Hz callbacks preserve normal clock and every FF multiplier', () => {
  for (const factor of [1, 2, 3, 4]) {
    const counts = [];
    for (const hz of [30, 60, 90, 120, 144]) {
      const c = core();
      c.send({ type: 'setFastForward', factor });
      // One second is an integer number of callbacks at every test rate.
      for (let i = 0; i < hz; i++) c.tick(1000 / hz);
      counts.push(c.ctx.vblankCount);
      assert.equal(c.ctx.scanlineCycles % 2, 0);
    }
    for (const count of counts) assert.equal(count, counts[0], `${factor}x should not depend on display refresh`);
    assert.ok(Math.abs(counts[0] - 59.7275 * factor) <= 1, `real-time clock at ${factor}x: ${counts}`);
  }
});

test('fast-forward gets more bounded work when normal speed exhausts its budget', () => {
  function slowCallback(factor) {
    const c = core();
    c.send({ type: 'setFastForward', factor });
    let clock = 0;
    c.host.sandbox.performance.now = () => (clock += 2);
    c.tick(17);
    return {
      cycles: c.ctx.scanline * 1232 + c.ctx.scanlineCycles,
      elapsed: clock,
      queued: c.host.rafQueue.length,
    };
  }
  const normal = slowCallback(1);
  const fast = slowCallback(3);
  assert.ok(fast.cycles > normal.cycles * 1.5, '3x must not share the saturated 1x work ceiling');
  assert.ok(fast.elapsed <= 54, 'fast-forward still yields within its bounded burst plus sparse clock checks');
  assert.equal(fast.queued, 1);
});

test('normal mode no longer artificially throttles a core that needs 14ms per emulated frame', () => {
  // Deterministic execution-cost model, not a device performance benchmark.
  // The previous fixed 10ms budget fails at both 60 Hz and 30 Hz here.
  for (const hz of [30, 60, 120]) {
    const c = core();
    c.run(`halted=false;globalThis.__simulatedWork=0;
      stepARM=function(){globalThis.__simulatedWork+=14/(FRAME_CYCLES/2);};
      checkIRQ=function(){};classifyStuck=function(){return null;};
      renderLine=function(){};`);
    c.host.sandbox.performance.now = () => c.host.now + c.ctx.__simulatedWork;
    for (let frame = 0; frame < hz / 5; frame++) {
      c.run('globalThis.__simulatedWork=0');
      c.tick(1000 / hz);
    }
    assert.ok(c.ctx.vblankCount >= 11 && c.ctx.vblankCount <= 12,
      `${hz}Hz should sustain the normal GBA clock, got ${c.ctx.vblankCount} frames`);
  }
});

test('adaptive work budgets are bounded and give FF headroom without changing the normal clock', () => {
  const c = core();
  assert.equal(c.run('frameWorkBudget(1000/60,1)'), 1000 / 60 - 2);
  assert.equal(c.run('frameWorkBudget(1000/30,1)'), 1000 / 30 - 2);
  assert.equal(c.run('frameWorkBudget(1000/120,1)'), 14);
  assert.equal(c.run('frameWorkBudget(2000,1)'), 32);
  assert.equal(c.run('frameWorkBudget(2000,4)'), 48);
  assert.ok(c.run('frameWorkBudget(1000/60,2)>frameWorkBudget(1000/60,1)'));
});

test('pause, resume, speed change, and serial wait discard elapsed debt', () => {
  const c = core();
  c.tick(17);
  const before = c.ctx.vblankCount;
  c.ctx.running = false;
  c.tick(1000);
  c.ctx.running = true;
  c.tick(17);
  assert.ok(c.ctx.vblankCount - before <= 2, 'pause must not trigger catch-up');
  c.tick(30);
  c.send({ type: 'setFastForward', factor: 4 });
  assert.equal(c.ctx.pacingCycles, 0, 'speed change clears old-rate debt');
  c.tick(17);
  c.ctx.linkConnected = true;
  c.ctx.linkBusy = true;
  const atWait = c.ctx.scanline * 1232 + c.ctx.scanlineCycles;
  c.tick(500);
  assert.equal(c.ctx.scanline * 1232 + c.ctx.scanlineCycles, atWait);
  assert.equal(c.ctx.pacingCycles, 0);
  c.ctx.linkBusy = false;
  c.tick(17);
  assert.ok(c.ctx.vblankCount - before < 12, 'resume must not replay wait time');
  c.send({ type: 'reset' });
  assert.equal(c.ctx.pacingCycles, 0, 'reset clears debt');
});

test('catch-up is capped and callback yields on wall-time budget', () => {
  const c = core();
  c.tick(2000);
  assert.ok(c.ctx.vblankCount <= 5, 'one callback cannot replay seconds of frames');
  assert.ok(c.ctx.pacingCycles <= c.ctx.MAX_PACING_CYCLES);

  // A deterministic slow phone clock: advancing on each sparse clock read
  // forces the core to yield before finishing the accumulated four frames.
  const slow = core();
  let now = slow.host.now;
  slow.host.sandbox.performance.now = () => (now += 11);
  slow.tick(100);
  assert.ok(slow.ctx.pacingCycles > 0, 'unfinished work remains for the next callback');
  assert.ok(slow.ctx.pacingCycles < slow.ctx.MAX_PACING_CYCLES);
});

test('batch displays only the latest completed snapshot, never partial scanlines', () => {
  const c = core();
  c.run(`renderLine=function(y){
    imgData.data.fill(vblankCount+1,y*SCREEN_W*4,(y+1)*SCREEN_W*4);
  }`, c.ctx);
  c.tick(36); // two complete frames plus part of the third
  assert.equal(c.presented.length, 1);
  assert.equal(c.ctx.vblankCount, 2);
  assert.equal(c.presented[0][0], 2);
  assert.equal(c.presented[0][159 * 240 * 4], 2);
  assert.equal(c.ctx.imgData.data[0], 3, 'next frame has overwritten the working buffer');
  c.tick(1);
  assert.equal(c.presented.length, 1, 'no presentation on a partial frame');
});

test('a serial start mid-callback blocks immediately and does not replay wait debt', () => {
  const c = core();
  c.ctx.halted = false;
  // The first instruction starts a link transfer; no later instruction runs.
  c.run(`linkConnected=true;
    stepARM=function(){instrCount++;linkBusy=true;};
    checkIRQ=function(){};
    classifyStuck=function(){return null;}`, c.ctx);
  c.tick(100);
  assert.equal(c.ctx.instrCount, 1);
  assert.equal(c.ctx.pacingCycles, 0);
  c.tick(100);
  assert.equal(c.ctx.instrCount, 1);
  c.ctx.linkBusy = false;
  c.ctx.halted = true;
  c.tick(17);
  assert.ok(c.ctx.vblankCount <= 2);
});