'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { makeSandbox } = require('../fixtures/run-core.js');
const { extractCoreScript } = require('../fixtures/extract-core.js');

function boot(routes) {
  const state = makeSandbox();
  const { sandbox, posted, listeners } = state;
  const registrations = [];
  const addEventListener = sandbox.window.addEventListener;
  sandbox.window.addEventListener = (type, fn, options) => {
    registrations.push({ type, fn, capture: options === true || !!(options && options.capture) });
    addEventListener(type, fn, options);
  };
  sandbox.window.XMLHttpRequest = function FakeXMLHttpRequest() {
    this.status = 0;
    this.response = null;
    this.responseText = '';
    this.timeout = 0;
    this.open = (_method, uri) => { this.uri = uri; };
    this.send = () => {
      const route = routes[this.uri];
      setTimeout(() => {
        if (!route || route.kind === 'error') {
          if (this.onerror) this.onerror(new Error('read failed'));
          return;
        }
        if (route.kind === 'timeout') {
          if (this.ontimeout) this.ontimeout();
          return;
        }
        this.status = route.status === undefined ? 0 : route.status;
        this.response = route.response;
        this.responseText = route.text || '';
        if (this.onload) this.onload();
      }, 0);
    };
  };
  vm.runInNewContext(extractCoreScript(), sandbox);
  const messageRegistrations = registrations.filter((entry) => entry.type === 'message');
  assert.equal(messageRegistrations.length, 1, 'Android fix must keep one message listener');
  return {
    ...state,
    sandbox,
    posted,
    listeners,
    messageRegistrations,
    send(data, target = sandbox.window, bubbles = true) {
      let delivered = 0;
      messageRegistrations.forEach((entry) => {
        // A document-targeted non-bubbling Android event reaches window only
        // through capture; a window-targeted iOS event reaches it once.
        if (target === sandbox.document && !entry.capture) return;
        if (target !== sandbox.document && target !== sandbox.window) return;
        entry.fn({ data: JSON.stringify(data), target, bubbles });
        delivered++;
      });
      return delivered;
    },
  };
}

function romBytes() {
  const bytes = new Uint8Array(0x200);
  bytes[0] = 0xfe;
  bytes[1] = 0xff;
  bytes[2] = 0xff;
  bytes[3] = 0xea;
  bytes[0xb2] = 0x96;
  return bytes;
}

function saveText(bytes) {
  let checksum = 0;
  bytes.forEach((byte) => { checksum = (checksum + byte) >>> 0; });
  return JSON.stringify({
    v: 1,
    saveType: 'sram',
    len: bytes.length,
    checksum,
    data: Buffer.from(bytes).toString('base64'),
  });
}

async function waitForRequests() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test('Android document messages use capture and iOS window messages are handled once', () => {
  const handle = boot({});
  assert.equal(handle.messageRegistrations[0].capture, true);
  const before = handle.posted.length;
  assert.equal(handle.send({ type: 'getDiag' }, handle.sandbox.document, false), 1);
  assert.equal(handle.posted.length, before + 1);
  assert.equal(handle.send({ type: 'getDiag' }, handle.sandbox.document, true), 1);
  assert.equal(handle.posted.length, before + 2);
  assert.equal(handle.send({ type: 'getDiag' }, handle.sandbox.window, true), 1);
  assert.equal(handle.posted.length, before + 3);
});

test('file ROM and battery save load through XHR with status zero', async () => {
  const rom = romBytes();
  const save = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
  const handle = boot({
    'file:///game.gba': { response: rom.buffer },
    'file:///game.sav': { text: saveText(save) },
  });
  assert.equal(handle.send({
    type: 'loadRomFile',
    uri: 'file:///game.gba',
    saveUri: 'file:///game.sav',
  }, handle.sandbox.document, false), 1);
  await waitForRequests();
  assert.ok(handle.posted.some((message) => message.type === 'romLoaded'));
  assert.equal(handle.posted.filter((message) => message.type === 'saveError').length, 0);
  assert.equal(handle.posted.filter((message) => message.type === 'romError').length, 0);

  handle.send({ type: 'saveState' }, handle.sandbox.window);
  const stateMessage = handle.posted.find((message) => message.type === 'saveState');
  const state = JSON.parse(stateMessage.state);
  const loaded = Buffer.from(state.sram, 'base64');
  assert.deepEqual([...loaded.subarray(0, save.length)], [...save]);
});

test('ROM load reports save read failures and timeouts without starting', async () => {
  for (const kind of ['error', 'timeout']) {
    const handle = boot({
      'file:///game.gba': { response: romBytes().buffer },
      'file:///game.sav': { kind },
    });
    handle.send({
      type: 'loadRomFile',
      uri: 'file:///game.gba',
      saveUri: 'file:///game.sav',
    }, handle.sandbox.document, false);
    await waitForRequests();
    assert.ok(handle.posted.some((message) => message.type === 'saveError'));
    assert.ok(handle.posted.some((message) => message.type === 'romError'));
    assert.equal(handle.posted.filter((message) => message.type === 'romLoaded').length, 0);
    assert.equal(handle.rafQueue.length, 0);
  }
});

test('ROM and saved-data validation errors abort before reset', async () => {
  const cases = [
    {
      name: 'empty ROM',
      routes: { 'file:///game.gba': { response: new ArrayBuffer(0) } },
      saveError: false,
    },
    {
      name: 'HTTP ROM failure',
      routes: { 'file:///game.gba': { status: 404, response: romBytes().buffer } },
      saveError: false,
    },
    {
      name: 'invalid saved data',
      routes: {
        'file:///game.gba': { response: romBytes().buffer },
        'file:///game.sav': { text: 'not-json' },
      },
      saveError: true,
    },
  ];
  for (const entry of cases) {
    const handle = boot(entry.routes);
    handle.send({
      type: 'loadRomFile',
      uri: 'file:///game.gba',
      saveUri: entry.saveError ? 'file:///game.sav' : undefined,
    }, handle.sandbox.document, false);
    await waitForRequests();
    assert.ok(handle.posted.some((message) => message.type === 'romError'), entry.name);
    assert.equal(
      handle.posted.some((message) => message.type === 'saveError'),
      entry.saveError,
      entry.name,
    );
    assert.equal(handle.posted.filter((message) => message.type === 'romLoaded').length, 0, entry.name);
    assert.equal(handle.rafQueue.length, 0, entry.name);
  }
});