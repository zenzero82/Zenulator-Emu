// Runs the real emulator core (extracted from html.ts) headlessly under
// Node with a minimal DOM/WebView shim, loads a ROM directly (bypassing
// the WebView message-passing layer, which is pure plumbing), and steps
// frames deterministically. Exposes the module-level state we need for
// diagnostics via a debug hook the core posts through `window.ReactNativeWebView`.
'use strict';
const vm = require('vm');
const { extractCoreScript } = require('./extract-core');

function makeSandbox() {
  const posted = [];
  const rafQueue = [];
  let rafId = 0;

  // Retain the ImageData the core renders into so tests/diagnostic drivers
  // can read the actual framebuffer (the core keeps one ImageData and
  // mutates its pixel buffer in place, so holding the last one is enough).
  const frames = { last: null };
  const canvasStub = {
    getContext() {
      return {
        createImageData(w, h) { const img = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; frames.last = img; return img; },
        putImageData(img) { frames.last = img; },
      };
    },
  };
  const statusStub = { _text: '', style: {}, set textContent(v) { this._text = v; }, get textContent() { return this._text; } };

  const listeners = {};
  const windowStub = {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    ReactNativeWebView: {
      postMessage(json) { posted.push(JSON.parse(json)); },
    },
    crypto: undefined, // SHA-256 path deliberately skipped in this headless harness
  };
  const documentStub = {
    getElementById(id) { return id === 'screen' ? canvasStub : statusStub; },
  };

  let now = 0;
  const performanceStub = { now() { return now; } };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    performance: performanceStub,
    navigator: { getGamepads: () => [] },
    console,
    requestAnimationFrame(fn) { const id = ++rafId; rafQueue.push({ id, fn }); return id; },
    cancelAnimationFrame(id) { const idx = rafQueue.findIndex((e) => e.id === id); if (idx >= 0) rafQueue.splice(idx, 1); },
    atob(s) { return Buffer.from(s, 'base64').toString('binary'); },
    btoa(s) { return Buffer.from(s, 'binary').toString('base64'); },
    setTimeout,
    Math, JSON, Object, Array, Uint8Array, Uint32Array, Int32Array, Uint8ClampedArray,
    String, Number, Boolean, BigInt, Error,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  return { sandbox, posted, rafQueue, listeners, frames, advanceTime: (ms) => { now += ms; }, get now() { return now; } };
}

/**
 * Loads `romBytes` into a freshly-booted core and runs it for `frames`
 * emulated VBlank frames (each call to the queued requestAnimationFrame
 * callback executes one runFrame(), which internally advances until the
 * next scanline budget is exhausted — NOT necessarily one full GBA frame
 * per call once halted/stuck, so we drive it by wall-clock-ish ticks and
 * inspect the posted `debugStats`/`cpuStuck`/`romInfo` messages instead of
 * assuming frame-for-frame lockstep).
 */
function runCore(romBytes, { ticks = 300 } = {}) {
  const { sandbox, posted, rafQueue, listeners, advanceTime } = makeSandbox();
  const script = extractCoreScript();
  const context = vm.createContext(sandbox);
  vm.runInContext(script, context, { filename: 'gba-core.js' });

  // Feed the ROM in exactly the way loadRomFromUri does post-fetch, via the
  // window 'message' listener the core installs — this exercises the real
  // message-handling code path, not a shortcut.
  const msgListeners = listeners['message'] || [];
  if (msgListeners.length === 0) throw new Error('Core did not register a message listener — extraction may be stale');

  // There's no fetch() in this shim, so we drive the ROM in through the
  // chunked romStart/romChunk path (the documented web-fallback path),
  // which *is* real production code, rather than poking `rom` directly.
  const b64 = Buffer.from(romBytes).toString('base64');
  const CHUNK = 200000;
  const chunks = [];
  for (let i = 0; i < b64.length; i += CHUNK) chunks.push(b64.slice(i, i + CHUNK));
  msgListeners.forEach((fn) => fn({ data: JSON.stringify({ type: 'romStart', total: chunks.length }) }));
  chunks.forEach((c, i) => msgListeners.forEach((fn) => fn({ data: JSON.stringify({ type: 'romChunk', index: i, data: c }) })));

  // receiveRomChunk's final step uses setTimeout(fn, 0) to decode+reset;
  // flush the Node microtask/timer queue so that runs before we start
  // pumping animation frames.
  return new Promise((resolve) => {
    setTimeout(() => {
      for (let t = 0; t < ticks; t++) {
        advanceTime(16); // ~60Hz wall clock
        const due = rafQueue.slice();
        rafQueue.length = 0;
        due.forEach((e) => e.fn());
      }
      resolve({ posted });
    }, 10);
  });
}

/**
 * Boots the real core with `romBytes` loaded and returns a handle for
 * sending further postMessage-style messages (e.g. `readMem32`) and
 * inspecting the `posted` array — used by the ROM-mapping unit tests to
 * probe live memory reads through the actual message-handling code path
 * rather than reimplementing the address math in the test itself.
 */
function bootCoreInteractive(romBytes) {
  const { sandbox, posted, rafQueue, listeners, frames, advanceTime } = makeSandbox();
  const script = extractCoreScript();
  const context = vm.createContext(sandbox);
  vm.runInContext(script, context, { filename: 'gba-core.js' });

  const msgListeners = listeners['message'] || [];
  if (msgListeners.length === 0) throw new Error('Core did not register a message listener — extraction may be stale');
  const send = (msg) => msgListeners.forEach((fn) => fn({ data: JSON.stringify(msg) }));

  const b64 = Buffer.from(romBytes).toString('base64');
  const CHUNK = 200000;
  const chunks = [];
  for (let i = 0; i < b64.length; i += CHUNK) chunks.push(b64.slice(i, i + CHUNK));
  send({ type: 'romStart', total: chunks.length });
  chunks.forEach((c, i) => send({ type: 'romChunk', index: i, data: c }));

  return new Promise((resolve) => {
    setTimeout(() => resolve({ send, posted, rafQueue, advanceTime, frames }), 10);
  });
}

module.exports = { runCore, makeSandbox, bootCoreInteractive };
