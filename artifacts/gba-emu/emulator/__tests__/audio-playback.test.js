'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../html.ts'), 'utf8');
const functions = source.slice(source.indexOf('function initAudio(){'), source.indexOf('var TIMER_PRESCALE='));

function setup(sampleRate = 32768) {
  let processor;
  class Context {
    constructor() {
      this.sampleRate = sampleRate;
      this.state = 'running';
      this.currentTime = 1;
      this.destination = {};
    }
    createScriptProcessor() {
      processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      return processor;
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const c = vm.createContext({
    window: { AudioContext: Context },
    navigator: { audioSession: { type: 'auto' } },
    console,
    Audio: class {},
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout: () => 1,
    clearTimeout() {},
    audioCtx: null,
    audioNode: null,
    audioMuted: false,
    audioPaused: false,
    audioNativeActive: true,
    audioPageVisible: true,
    audioSilentPlayback: false,
    audioRecoveryTimers: [],
    audioRecoveryGeneration: 0,
    audioSilentElement: null,
    fastForward: 1,
    AUDIO_RING: 32768,
    audioRingL: new Float32Array(32768),
    audioRingR: new Float32Array(32768),
    audioRead: 0,
    audioWrite: 0,
  });
  vm.runInContext(functions, c);
  c.initAudio();

  function append(count, start = c.audioWrite) {
    for (let n = 0; n < count; n++) {
      const value = start + n;
      const at = c.audioWrite & (c.AUDIO_RING - 1);
      c.audioRingL[at] = value;
      c.audioRingR[at] = -value - 0.25;
      c.audioWrite++;
    }
  }
  function render(count) {
    const left = new Float32Array(count);
    const right = new Float32Array(count);
    processor.onaudioprocess({
      outputBuffer: { getChannelData: (channel) => channel === 0 ? left : right },
    });
    return { left: [...left], right: [...right] };
  }
  return { c, append, render };
}

for (const rate of [32768, 44100, 48000]) {
  test(`output callback samples the 32768 Hz ring at ${rate} Hz`, () => {
    const { c, append, render } = setup(rate);
    append(64);
    const { left, right } = render(8);
    const step = 32768 / rate;
    const expected = Array.from({ length: 8 }, (_, n) => Math.floor(n * step));
    assert.deepEqual(left, expected);
    assert.deepEqual(right, expected.map((n) => -n - 0.25));
    assert.ok(Math.abs(c.audioRead - 8 * step) < 1e-9);
  });
}

test('fast-forward 2x and 3x advances samples directly, raising pitch', () => {
  for (const speed of [2, 3]) {
    const { c, append, render } = setup();
    append(64);
    c.fastForward = speed;
    const { left, right } = render(6);
    assert.deepEqual(left, Array.from({ length: 6 }, (_, n) => n * speed));
    assert.deepEqual(right, Array.from({ length: 6 }, (_, n) => -n * speed - 0.25));
  }
});

test('mute and pause output silence, discard queued audio, and resume fresh', () => {
  const { c, append, render } = setup();
  append(16);
  c.setAudioMuted(true);
  assert.equal(c.audioRead, c.audioWrite);
  assert.deepEqual(render(4).left, [0, 0, 0, 0]);
  c.setAudioMuted(false);
  append(8, 100);
  assert.deepEqual(render(4).left, [100, 101, 102, 103]);

  c.setAudioPaused(true);
  append(5, 200);
  assert.deepEqual(render(3).right, [0, 0, 0]);
  assert.equal(c.audioRead, c.audioWrite);
  c.setAudioPaused(false);
  append(4, 300);
  assert.deepEqual(render(4).left, [300, 301, 302, 303]);
});

test('stale backlog is bounded and underrun remainder is silent', () => {
  const { c, append, render } = setup();
  append(10000);
  const caughtUpAt = Math.floor(c.audioWrite - 32768 * 0.04);
  const caughtUp = render(4);
  assert.deepEqual(caughtUp.left, [caughtUpAt, caughtUpAt + 1, caughtUpAt + 2, caughtUpAt + 3]);

  c.audioRead = c.audioWrite - 2;
  const short = render(5);
  assert.deepEqual(short.left, [9998, 9999, 0, 0, 0]);
  assert.deepEqual(short.right, [-9998.25, -9999.25, 0, 0, 0]);
  assert.equal(c.audioNode.outputStats.underruns, 1);
  assert.equal(c.audioNode.outputStats.missingSamples, 3);
  assert.ok(c.audioNode.outputStats.droppedSamples > 8000);
});