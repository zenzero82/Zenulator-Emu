'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the exact embedded output-management code with deterministic WebKit doubles.
const source = fs.readFileSync(path.join(__dirname, '../html.ts'), 'utf8');
const functions = source.slice(source.indexOf('function initAudio(){'), source.indexOf('var TIMER_PRESCALE='));
function setup({ stuck = false, reject = false } = {}) {
  const timers = new Map(), contexts = [], media = [], warnings = [];
  let nextTimer = 0;
  class Context {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 0;
      this.resumes = 0;
      contexts.push(this);
    }
    createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
    resume() {
      this.resumes++;
      if (reject) return Promise.reject(new Error('interrupted'));
      if (!stuck) { this.state = 'running'; this.currentTime += 0.01; }
      return Promise.resolve();
    }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  class Media {
    constructor(src) { this.src = src; this.paused = true; media.push(this); }
    setAttribute() {}
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  const c = vm.createContext({
    window: { AudioContext: Context }, Audio: Media,
    navigator: { audioSession: { type: 'auto' } },
    console: { warn: (...args) => warnings.push(args) },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    audioCtx: null, audioNode: null, audioMuted: false, audioPaused: false,
    audioNativeActive: true, audioPageVisible: true, audioSilentPlayback: false,
    audioRecoveryTimers: [], audioRecoveryGeneration: 0, audioSilentElement: null,
    fastForward: 1,
    AUDIO_RING: 32768, audioRingL: new Float32Array(32768), audioRingR: new Float32Array(32768),
    audioRead: 0, audioWrite: 0,
  });
  vm.runInContext(functions, c);
  function tick() {
    const batch = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay);
    for (const [id, timer] of batch) {
      if (timers.delete(id)) timer.fn();
    }
  }
  return { c, timers, contexts, media, warnings, tick };
}

test('foreground recovers interrupted output without recreating a healthy graph', () => {
  const { c, contexts, tick } = setup();
  c.initAudio();
  const original = c.audioCtx;
  c.audioNativeActive = false; c.syncAudioPlayback();
  assert.equal(original.state, 'suspended');
  c.audioCtx.state = 'interrupted';
  c.audioNativeActive = true; c.syncAudioPlayback(); tick();
  assert.equal(original.state, 'running');
  assert.equal(c.audioCtx, original);
  assert.equal(contexts.length, 1);
});

test('muting and explicit pause survive foreground and visibility changes', () => {
  const { c, tick } = setup();
  c.initAudio();
  c.audioWrite = 17;
  for (const setter of [c.setAudioMuted, c.setAudioPaused]) {
    setter(true);
    const before = c.audioCtx.resumes;
    c.audioNativeActive = false; c.syncAudioPlayback();
    c.audioNativeActive = true; c.audioPageVisible = true; c.syncAudioPlayback(); tick();
    assert.equal(c.audioCtx.resumes, before);
    assert.equal(c.audioRead, c.audioWrite);
    setter(false);
    assert.equal(c.audioCtx.state, 'running');
    c.audioWrite += 7;
  }
});

test('background cancels pending recovery and cannot be overridden by page visibility', () => {
  const { c, tick, timers, contexts } = setup({ stuck: true });
  c.initAudio();
  c.audioNativeActive = false; c.syncAudioPlayback();
  c.audioWrite = 23;
  c.audioPageVisible = true; c.syncAudioPlayback(); tick();
  assert.equal(timers.size, 0);
  assert.equal(contexts.length, 1);
  assert.equal(c.audioRead, c.audioWrite);
});

test('stuck and closed contexts rebuild only output once, without a retry loop', () => {
  for (const closed of [false, true]) {
    const { c, tick, contexts, timers } = setup({ stuck: true });
    c.initAudio();
    c.audioWrite = 91;
    c.audioRead = 12;
    if (closed) c.audioCtx.state = 'closed';
    tick(); tick();
    assert.equal(contexts.length, 2);
    assert.equal(contexts[0].state, 'closed');
    assert.equal(c.audioRead, c.audioWrite);
    assert.equal(timers.size, 0);
  }
});

test('iOS selects playback and creates valid silent media, stopped on mute/background', () => {
  const { c, media } = setup();
  c.audioSilentPlayback = true;
  c.initAudio();
  assert.equal(c.navigator.audioSession.type, 'playback');
  assert.equal(media.length, 1);
  const wav = Buffer.from(media[0].src.split(',')[1], 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  assert.ok(wav.subarray(44).every((byte) => byte === 128));
  c.setAudioMuted(true); assert.equal(media[0].paused, true);
  c.setAudioMuted(false); assert.equal(media[0].paused, false);
  c.audioNativeActive = false; c.syncAudioPlayback();
  assert.equal(media[0].paused, true);
});

test('older WebKit uses silent media even without the Audio Session API', () => {
  const { c, media } = setup();
  delete c.navigator.audioSession;
  c.audioSilentPlayback = true;
  c.initAudio();
  assert.equal(media.length, 1);
  assert.equal(media[0].paused, false);
});

test('browser and Android do not create the iOS media helper', () => {
  const { c, media } = setup();
  c.initAudio();
  assert.equal(media.length, 0);
  assert.equal(c.navigator.audioSession.type, 'auto');
});

test('resume promise rejection is handled and does not escape as an unhandled rejection', async () => {
  const { c, warnings } = setup({ reject: true });
  c.initAudio();
  await Promise.resolve();
  assert.equal(warnings.length, 1);
  assert.equal(c.audioCtx.state, 'suspended');
});

test('native foreground messages restore visibility without clearing explicit pause', () => {
  const { c } = setup();
  c.scheduleFrame = () => {};
  c.performance = { now: () => 100 };
  vm.runInContext('var pacingCycles=123,lastPacingMs=0;' +
    source.match(/function resetFramePacing\(\)\{[^}]+\}/)[0], c);
  c.audioPageVisible = false; c.audioPaused = true;
  c.audioWrite = 44; c.audioRead = 3;
  const start = source.indexOf("  if(data.type==='nativeAudioState'){");
  const end = source.indexOf("\n  if(data.type==='reset')", start);
  vm.runInContext('(function(data){' + source.slice(start, end) +
    '})({type:"nativeAudioState",active:true,silentPlayback:true});', c);
  assert.equal(c.audioNativeActive, true);
  assert.equal(c.audioPageVisible, true);
  assert.equal(c.audioPaused, true);
  assert.equal(c.pacingCycles, 0);
  assert.equal(c.lastPacingMs, 100);
  assert.equal(c.audioRead, c.audioWrite);
});