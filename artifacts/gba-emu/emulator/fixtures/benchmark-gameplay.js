// Actual supplied-ROM execution on Node/V8, NOT device gameplay certification.
// Usage: node benchmark-gameplay.js scenario.json output.json [core-script.js]
// Optional CPU sampling: PROFILE=1 (writes output.json.cpuprofile outside Git).
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const inspector = require('node:inspector');
const { performance } = require('node:perf_hooks');
const { extractCoreScript } = require('./extract-core');
const { makeSandbox } = require('./run-core');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');

function writeFrame(file, rgba) {
  function chunk(type, bytes) {
    const data = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, data, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(240); header.writeUInt32BE(160, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(160 * (240 * 4 + 1));
  for (let y = 0; y < 160; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * 960, 960).copy(rows, y * 961 + 1);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}

async function main() {
  const [scenarioFile, output, sourceFile] = process.argv.slice(2);
  assert.ok(scenarioFile && output, 'Provide scenario.json and output.json paths');
  const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
  assert.equal((scenario.speeds || [1]).length, 1,
    'Use a fresh process per speed to start from identical ROM state');
  const rom = fs.readFileSync(scenario.rom);
  const source = sourceFile === '--phase1'
    ? require('./scheduler-baseline').phaseOneBaseline(extractCoreScript())
    : sourceFile ? fs.readFileSync(sourceFile, 'utf8') : extractCoreScript();
  const host = makeSandbox();
  // RTC must see the same instant in both candidates; never use wall-clock
  // calendar time as gameplay input in a deterministic comparison.
  const RealDate = Date;
  host.sandbox.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [scenario.rtcEpochMs ?? 1704067200000])); }
    static now() { return scenario.rtcEpochMs ?? 1704067200000; }
  };
  const events = [];
  host.sandbox.console = { log() {}, warn() {}, error(...args) { events.push(String(args[0])); } };
  host.sandbox.window.ReactNativeWebView.postMessage = (json) => {
    const event = JSON.parse(json);
    if (['cpuError', 'cpuStuck', 'saveError'].includes(event.type)) events.push(event);
  };
  let presents = 0;
  const getContext = host.sandbox.document.getElementById('screen').getContext;
  host.sandbox.document.getElementById('screen').getContext = () => {
    const ctx = getContext();
    const put = ctx.putImageData;
    ctx.putImageData = (img) => { presents++; put(img); };
    return ctx;
  };
  const script = source.replace(/\}\)\(\);\s*$/, `
    var benchRenderMs=0,benchAudioMs=0;
    var benchRender=renderLine,benchAudio=pushAudioSample;
    renderLine=function(line){var t=__now();benchRender(line);benchRenderMs+=__now()-t;};
    pushAudioSample=function(){var t=__now();benchAudio();benchAudioMs+=__now()-t;};
    window.bench={
      boot:function(bytes){rom=new Uint8Array(bytes);resetGBA();},
      battery:function(json){return applyBatterySave(json);},
      state:function(json){applyState(json);},
      rebase:function(){resetFramePacing();},
      frame:function(){return presentationData.data;},
      stats:function(){return {vblanks:vblankCount,instructions:instrCount,pc:r[15]>>>0,
        cpuError:cpuErrorInfo,stuck:stuckReason,saveType:saveType,
        renderMs:benchRenderMs,audioMs:benchAudioMs};},
      digest:function(){return {r:Array.from(r),cpsr:cpsr,scanline:scanline,
        scanlineCycles:scanlineCycles,timerCounter:timerCounter,timerReload:timerReload,
        timerPrescaleCnt:timerPrescaleCnt,audioWrite:audioWrite,dsA:dsA,dsB:dsB,
        fifoALen:fifoALen,fifoBLen:fifoBLen,irqDepth:irqReturnStack.length,
        memory:[wram,iwram,io,pal,vram,oam,sram,eepromData,audioRingL,audioRingR],
        framebuffer:imgData.data};}
    };
  })();
  //# sourceURL=zenulator-profiled-core.js`);
  assert.notEqual(script, source, 'Core extraction hook must match');
  const names = Object.keys(host.sandbox);
  new Function(...names, '__now', script)(...names.map((n) => host.sandbox[n]), () => performance.now());
  const core = host.sandbox.window.bench;
  core.boot(rom);
  if (scenario.battery) {
    const bytes = fs.readFileSync(scenario.battery);
    assert.equal(bytes.length, 131072, 'This raw battery scenario expects a 128KiB Flash 1M save');
    assert.equal(core.stats().saveType, 'flash128', 'Battery must match detected cartridge save type');
    assert.equal(core.battery(JSON.stringify({ v: 1, saveType: 'flash128',
      len: bytes.length, data: bytes.toString('base64') })), null);
  }
  if (scenario.state) core.state(fs.readFileSync(scenario.state, 'utf8'));
  assert.equal(events.length, 0, 'Boot/state load must succeed');
  const send = (data) => host.listeners.message.forEach((fn) => fn({ data: JSON.stringify(data) }));
  const frameMs = 280896 / 16777216 * 1000;
  const pump = (frame, speed = 1) => {
    for (const event of scenario.inputs || []) if (event.frame === frame) send(event.message);
    host.advanceTime(frameMs);
    const queue = host.rafQueue.splice(0);
    assert.equal(queue.length, 1, 'Exactly one core callback expected');
    queue[0].fn();
    if (scenario.captureAt?.includes(frame)) writeFrame(output + `.frame-${frame}.png`, core.frame());
    assert.equal(core.stats().cpuError, null, 'CPU fault invalidates benchmark');
    assert.equal(core.stats().stuck, null, 'Stuck execution invalidates gameplay benchmark');
  };
  const warmup = scenario.warmupFrames ?? 180;
  for (let f = 0; f < warmup; f++) pump(f);
  const session = new inspector.Session();
  const post = (method, params = {}) => new Promise((resolve, reject) =>
    session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  if (process.env.PROFILE === '1') {
    session.connect();
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    await post('Profiler.start');
  }
  const results = [];
  for (const speed of scenario.speeds || [1]) {
    send({ type: 'setFastForward', factor: speed });
    if (scenario.realtime) {
      const virtualStart = host.now, realStart = performance.now();
      host.sandbox.performance.now = () => virtualStart + performance.now() - realStart;
      core.rebase();
    }
    const before = core.stats(), beforePresents = presents;
    const samples = [];
    const start = performance.now();
    for (let f = 0; f < (scenario.callbacks ?? 120); f++) {
      if (scenario.realtime) {
        const wait = start + (f + 1) * (1000 / 60) - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
      const t = performance.now();
      pump(warmup + f);
      samples.push(performance.now() - t);
    }
    const elapsed = performance.now() - start, after = core.stats();
    const frames = after.vblanks - before.vblanks;
    const sorted = samples.slice().sort((a, b) => a - b);
    results.push({ targetSpeed: speed, elapsedMs: elapsed, frames,
      throughputFps: frames / elapsed * 1000, throughputFactor: frames * frameMs / elapsed,
      measurement: scenario.realtime ? 'paced Node simulation, not device FPS' : 'unpaced maximum CPU throughput, not achieved device speed',
      // Mock scheduler time is distinct from measured maximum work throughput.
      scheduledEmulatedMs: frames * frameMs,
      presentedSnapshots: presents - beforePresents,
      renderMs: after.renderMs - before.renderMs, audioGenerationMs: after.audioMs - before.audioMs,
      instructions: after.instructions - before.instructions,
      callbackMedianMs: sorted[Math.floor(sorted.length / 2)],
      callbackP95Ms: sorted[Math.floor(sorted.length * .95)],
      callbackMaxMs: sorted[sorted.length - 1], memory: process.memoryUsage(),
      status: { pc: after.pc, cpuError: after.cpuError, stuck: after.stuck, saveType: after.saveType },
    });
  }
  if (process.env.PROFILE === '1') {
    const { profile } = await post('Profiler.stop');
    fs.writeFileSync(output + '.cpuprofile', JSON.stringify(profile));
    session.disconnect();
  }
  const digest = core.digest();
  if (scenario.captureFrame) writeFrame(output + '.png', core.frame());
  const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
  digest.memory = digest.memory.map((bytes) => hash(bytes));
  digest.framebuffer = hash(digest.framebuffer);
  fs.writeFileSync(output, JSON.stringify({
    environment: 'Node/V8 supplied-ROM headless execution; mocked display/audio output, no physical-device results',
    node: process.version, scenario, romSha256: hash(rom), coreSha256: hash(source),
    results, finalStateDigest: hash(JSON.stringify(digest)), stateChecks: digest, events,
  }, null, 2));
  console.log(output);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
