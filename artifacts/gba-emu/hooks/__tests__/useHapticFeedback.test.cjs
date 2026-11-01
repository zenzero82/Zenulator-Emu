const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const fileName = join(__dirname, '..', 'useHapticFeedback.ts');
const output = ts.transpileModule(readFileSync(fileName, 'utf8'), {
  fileName,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
}).outputText;

function harness({ os = 'ios', values = new Map(), getItem, setItem, impact, notification } = {}) {
  const calls = [];
  const effects = [];
  const subscriptions = new Set();
  const storage = {
    getItem: getItem || (async (key) => values.get(key) ?? null),
    setItem: setItem || (async (key, value) => { values.set(key, value); }),
  };
  const haptics = {
    ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium' },
    NotificationFeedbackType: { Success: 'Success', Error: 'Error' },
    impactAsync: impact || (async (style) => { calls.push(['impact', style]); }),
    notificationAsync: notification || (async (type) => { calls.push(['notification', type]); }),
  };
  const exports = {};
  vm.runInNewContext(output, {
    exports,
    require(name) {
      if (name === '@react-native-async-storage/async-storage') return storage;
      if (name === 'expo-haptics') return haptics;
      if (name === 'react-native') return { Platform: { OS: os } };
      if (name === 'react') return {
        useEffect: (effect) => { effects.push(effect); },
        useSyncExternalStore: (subscribe, snapshot) => {
          subscriptions.add(subscribe(() => {}));
          return snapshot();
        },
      };
      throw new Error(`Unexpected import: ${name}`);
    },
    Set,
    Promise,
    Error,
    String,
  }, { filename: fileName });
  return {
    api: exports,
    calls,
    effects,
    values,
    hook: () => exports.useHapticFeedback(),
    mount: () => { exports.useHapticFeedback(); effects.splice(0).forEach((effect) => effect()); },
    dispose: () => subscriptions.forEach((unsubscribe) => unsubscribe()),
  };
}

const key = '@gba_haptic_feedback_enabled';
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('loads persisted preference before any vibration, including calls before a hook mounts', async () => {
  let finishRead;
  const values = new Map([[key, 'false']]);
  const h = harness({
    values,
    getItem: () => new Promise((resolve) => { finishRead = () => resolve(values.get(key)); }),
  });
  const feedback = h.api.impactAsync(h.api.ImpactFeedbackStyle.Light);
  assert.equal(h.hook().ready, false);
  assert.deepEqual(h.calls, []);
  finishRead();
  await feedback;
  assert.equal(h.hook().ready, true);
  assert.equal(h.hook().enabled, false);
  assert.deepEqual(h.calls, []);
  h.dispose();
});

test('default on, toggle off/on, and module reload honor persisted preference on ios and android', async () => {
  for (const os of ['ios', 'android']) {
    const values = new Map();
    const h = harness({ os, values });
    h.mount();
    await tick();
    assert.equal(h.hook().enabled, true);
    assert.equal(h.hook().ready, true);
    await h.api.impactAsync();
    await h.hook().setEnabled(false);
    assert.equal(values.get(key), 'false');
    await h.api.impactAsync();
    await h.api.notificationAsync();
    assert.deepEqual(h.calls, [['impact', 'Medium']]);

    const reloaded = harness({ os, values });
    await reloaded.api.notificationAsync();
    assert.deepEqual(reloaded.calls, []);
    assert.equal(reloaded.hook().enabled, false);
    await reloaded.hook().setEnabled(true);
    await reloaded.api.notificationAsync(reloaded.api.NotificationFeedbackType.Error);
    assert.deepEqual(reloaded.calls, [['notification', 'Error']]);
    h.dispose();
    reloaded.dispose();
  }
});

test('web never calls hardware, even with the enabled default', async () => {
  const h = harness({ os: 'web' });
  await h.api.impactAsync();
  await h.api.notificationAsync();
  assert.deepEqual(h.calls, []);
  h.dispose();
});

test('storage read failure blocks vibration, surfaces error, and retries on a later call', async () => {
  let attempts = 0;
  const h = harness({
    getItem: async () => {
      if (++attempts === 1) throw new Error('read denied');
      return 'false';
    },
  });
  await h.api.impactAsync();
  assert.equal(h.hook().ready, false);
  assert.match(h.hook().error, /read denied/);
  assert.deepEqual(h.calls, []);
  await h.api.impactAsync();
  assert.equal(h.hook().ready, true);
  assert.equal(h.hook().enabled, false);
  assert.equal(h.hook().error, null);
  assert.deepEqual(h.calls, []);
  h.dispose();
});

test('failed hydration cannot overwrite an unknown saved preference', async () => {
  let writes = 0;
  const h = harness({
    getItem: async () => { throw new Error('storage locked'); },
    setItem: async () => { writes++; },
  });
  await assert.rejects(h.hook().setEnabled(true), /storage locked/);
  assert.equal(writes, 0);
  assert.equal(h.hook().ready, false);
  assert.equal(h.hook().saving, false);
  assert.match(h.hook().error, /storage locked/);
  h.dispose();
});

test('failed write preserves prior setting, exposes error, and subsequent save succeeds', async () => {
  let fail = true;
  const values = new Map();
  const h = harness({
    values,
    setItem: async (storageKey, value) => {
      if (fail) throw new Error('disk full');
      values.set(storageKey, value);
    },
  });
  await h.api.impactAsync();
  await assert.rejects(h.hook().setEnabled(false), /disk full/);
  assert.equal(h.hook().enabled, true);
  assert.equal(h.hook().saving, false);
  assert.match(h.hook().error, /disk full/);
  fail = false;
  await h.hook().setEnabled(false);
  assert.equal(h.hook().enabled, false);
  assert.equal(h.hook().error, null);
  h.dispose();
});

test('saves serialize; vibration is suppressed while a save is pending', async () => {
  const writes = [];
  let release;
  const h = harness({
    setItem: (storageKey, value) => new Promise((resolve) => {
      writes.push(value);
      release = resolve;
    }),
  });
  const first = h.hook().setEnabled(false);
  const second = h.hook().setEnabled(true);
  await tick();
  assert.deepEqual(writes, ['false']);
  assert.equal(h.hook().saving, true);
  await h.api.impactAsync();
  assert.deepEqual(h.calls, []);
  release();
  await tick();
  assert.deepEqual(writes, ['false', 'true']);
  release();
  await Promise.all([first, second]);
  assert.equal(h.hook().enabled, true);
  assert.equal(h.hook().saving, false);
  h.dispose();
});

test('unavailable and rejected native haptic calls do not reject inputs', async () => {
  const h = harness({
    impact: () => { throw new Error('unavailable hardware'); },
    notification: async () => { throw new Error('rejected hardware'); },
  });
  await assert.doesNotReject(h.api.impactAsync());
  await assert.doesNotReject(h.api.notificationAsync());
  assert.equal(h.hook().enabled, true);
  h.dispose();
});