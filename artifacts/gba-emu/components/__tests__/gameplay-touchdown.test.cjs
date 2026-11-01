const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// These tests execute the shipped TypeScript. Only React and the native host
// boundary are replaced: touch ownership and D-pad direction logic stay real.
function controlsHarness({ enabled = true, withProvider = true, platform = 'ios' } = {}) {
  const cleanups = [];
  const registrations = [];
  const appListeners = new Set();
  const dimensionListeners = new Set();
  const browserListeners = new Map();
  const renderStates = new Map();
  let renderState = null;
  let hookIndex = 0;
  function slot() {
    if (!renderState) return {};
    const index = hookIndex++;
    return renderState[index] ?? (renderState[index] = {});
  }
  function dependenciesChanged(state, deps) {
    return !state.deps || !deps || deps.some((dep, index) => dep !== state.deps[index]);
  }
  function memo(fn, deps) {
    const state = slot();
    if (dependenciesChanged(state, deps)) {
      state.value = fn();
      state.deps = deps;
    }
    return state.value;
  }
  function render(id, fn) {
    const previousState = renderState;
    const previousIndex = hookIndex;
    renderState = renderStates.get(id) ?? [];
    renderStates.set(id, renderState);
    hookIndex = 0;
    try {
      return fn();
    } finally {
      renderState = previousState;
      hookIndex = previousIndex;
    }
  }
  let context = withProvider
    ? {
        enabled,
        register(name, controller) {
          const registration = { name, controller, removed: false };
          registrations.push(registration);
          return () => {
            registration.removed = true;
          };
        },
      }
    : null;

  const react = {
    createContext: () => ({ Provider: 'ContextProvider' }),
    useContext: () => context,
    useCallback: (fn, deps) => memo(() => fn, deps),
    useMemo: memo,
    useRef: (current) => {
      const state = slot();
      return state.ref ?? (state.ref = { current });
    },
    useState: (initial) => {
      const state = slot();
      if (!('value' in state)) state.value = typeof initial === 'function' ? initial() : initial;
      return [state.value, (next) => {
        state.value = typeof next === 'function' ? next(state.value) : next;
      }];
    },
    useEffect: (fn, deps) => {
      const state = slot();
      if (!dependenciesChanged(state, deps)) return;
      state.cleanup?.();
      const cleanup = fn();
      state.cleanup = cleanup;
      state.deps = deps;
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    createElement: (type, props, ...children) => ({
      type,
      // Match React's children prop when a layout wrapper renders its child.
      props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) },
      children,
    }),
  };

  const View = 'View';
  react.useLayoutEffect = react.useEffect;
  const modules = {
    react,
    'react-native': {
      View,
      Pressable: 'Pressable',
      Text: 'Text',
      StyleSheet: {
        absoluteFill: {
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
        },
        create: (styles) => styles,
      },
      Platform: { OS: platform, select: (values) => values[platform] ?? values.default },
      AppState: {
        currentState: 'active',
        addEventListener: (_type, fn) => {
          appListeners.add(fn);
          return { remove: () => appListeners.delete(fn) };
        },
      },
      Dimensions: {
        addEventListener: (_type, fn) => {
          dimensionListeners.add(fn);
          return { remove: () => dimensionListeners.delete(fn) };
        },
      },
    },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    '@/hooks/useHapticFeedback': {
      ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium' },
      impactAsync: async () => {},
    },
  };

  function load(name) {
    const fileName = join(__dirname, '..', name);
    const { outputText } = ts.transpileModule(readFileSync(fileName, 'utf8'), {
      fileName,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    });
    const exports = {};
    vm.runInNewContext(
      outputText,
      {
        exports,
        require(id) {
          assert.ok(id in modules, `Unexpected module: ${id}`);
          return modules[id];
        },
        Map,
        Set,
        Math,
        String,
        window: {
          addEventListener: (type, fn) => browserListeners.set(type, fn),
          removeEventListener: (type) => browserListeners.delete(type),
        },
      },
      { filename: fileName },
    );
    return exports;
  }

  const touchEvents = load('gameplayTouchEvents.ts');
  modules['./gameplayTouchEvents'] = touchEvents;
  const controls = load('GameplayControls.tsx');
  modules['@/components/GameplayControls'] = controls;
  modules['@/components/ControlSlot'] = load('ControlSlot.tsx');
  modules['@/library/gameplayPreferences'] = {
    speedLabel: (speed) => speed === 1 ? 'Normal' : `FF +${speed - 1}×`,
  };

  return {
    ...controls,
    cleanups,
    registrations,
    touchEvents,
    render,
    emitAppState: (state) => appListeners.forEach((fn) => fn(state)),
    emitDimensions: () => dimensionListeners.forEach((fn) => fn()),
    emitBlur: () => browserListeners.get('blur')?.(),
    renderProvider(nextEnabled = enabled) {
      const element = render('provider', () => controls.GameplayControlsProvider({
        enabled: nextEnabled,
        children: null,
      }));
      context = element.props.value;
      return element.children[0].props;
    },
    loadDPad: () => load('DPad.tsx').default,
    loadActions: () => load('ActionButtons.tsx'),
    setContext(next) {
      context = next;
    },
  };
}

function layout(touchProps, width = 100, height = 100) {
  touchProps.onLayout({
    nativeEvent: { layout: { x: 0, y: 0, width, height } },
  });
}

function start(touchProps, identifier, locationX = 50, locationY = 50) {
  touchProps.onTouchStart({
    nativeEvent: { identifier, locationX, locationY },
  });
}

function move(touchProps, identifier, locationX, locationY) {
  touchProps.onTouchMove({
    nativeEvent: { identifier, locationX, locationY },
  });
}

function finish(touchProps, identifiers, cancelled = false) {
  touchProps[cancelled ? 'onTouchCancel' : 'onTouchEnd']({
    nativeEvent: {
      changedTouches: identifiers.map((identifier) => ({ identifier })),
    },
  });
}

function hook(h, name, events, options) {
  const result = h.useGameplayControl(
    name,
    (key, down) => events.push([key, down]),
    options,
  );
  layout(result.touchProps);
  return result;
}

test('native stationary taps press and release every gameplay button', () => {
  const h = controlsHarness();
  for (const [index, name] of ['a', 'b', 'l', 'r', 'start', 'select'].entries()) {
    const events = [];
    let presses = 0;
    const control = hook(h, name, events, {
      onPress: () => {
        presses++;
      },
    });
    const id = index % 2 ? `finger-${index}` : index;

    start(control.touchProps, id);
    finish(control.touchProps, [id]);

    assert.deepEqual(events, [
      [name, true],
      [name, false],
    ]);
    assert.equal(presses, 1);
  }
});

test('rapid repeated A and B taps never wait for movement', () => {
  const h = controlsHarness();
  const events = [];
  const a = hook(h, 'a', events);
  const b = hook(h, 'b', events);

  for (let id = 0; id < 8; id++) {
    const control = id % 2 ? b : a;
    start(control.touchProps, id, 20, 20);
    finish(control.touchProps, [id]);
  }

  assert.deepEqual(
    events,
    Array.from({ length: 8 }, (_, id) => {
      const name = id % 2 ? 'b' : 'a';
      return [
        [name, true],
        [name, false],
      ];
    }).flat(),
  );
});

test('L + R + Start hold together and releasing R does not release siblings', () => {
  const h = controlsHarness();
  const events = [];
  const held = new Set();
  const onChange = (key, down) => {
    events.push([key, down]);
    if (down) held.add(key);
    else held.delete(key);
  };
  const l = h.useGameplayControl('l', onChange);
  const r = h.useGameplayControl('r', onChange);
  const startButton = h.useGameplayControl('start', onChange);
  [l, r, startButton].forEach(({ touchProps }) => layout(touchProps));

  start(l.touchProps, 'left');
  start(r.touchProps, 22);
  start(startButton.touchProps, 'menu');
  assert.deepEqual([...held], ['l', 'r', 'start']);

  finish(r.touchProps, [22]);
  assert.deepEqual([...held], ['l', 'start']);
  assert.deepEqual(events.at(-1), ['r', false]);

  finish(l.touchProps, ['left']);
  finish(startButton.touchProps, ['menu']);
  assert.equal(held.size, 0);
});

test('two native contacts on one control hold until the final owned ID ends', () => {
  const h = controlsHarness();
  const events = [];
  const a = hook(h, 'a', events);

  start(a.touchProps, 7, 10, 20);
  start(a.touchProps, '8', 30, 40);
  finish(a.touchProps, [7]);
  assert.deepEqual(events, [['a', true]]);

  finish(a.touchProps, ['8']);
  assert.deepEqual(events, [
    ['a', true],
    ['a', false],
  ]);
});

test('changedTouches releases all owned IDs, ignores foreign IDs, and is idempotent at root', () => {
  const h = controlsHarness();
  const events = [];
  const a = hook(h, 'a', events);
  start(a.touchProps, 1);
  start(a.touchProps, 'second');

  finish(a.touchProps, ['foreign', 1, 'second']);
  assert.deepEqual(events, [
    ['a', true],
    ['a', false],
  ]);

  const registration = h.registrations.find(({ name }) => name === 'a');
  assert.ok(registration, 'the hook registers its touch controller');
  registration.controller.releaseTouches(['1', 'second', 'foreign']);
  registration.controller.releaseTouches(['1', 'second']);
  assert.equal(events.length, 2, 'root bubbling must not emit duplicate releases');
});

test('cancel, unmount, and disabled state release safely', () => {
  const h = controlsHarness();
  const events = [];
  const a = hook(h, 'a', events);
  start(a.touchProps, 'cancel-me');
  finish(a.touchProps, ['cancel-me'], true);
  assert.deepEqual(events, [
    ['a', true],
    ['a', false],
  ]);

  start(a.touchProps, 91);
  h.cleanups.forEach((cleanup) => cleanup());
  assert.deepEqual(events.at(-1), ['a', false]);
  assert.ok(h.registrations.every(({ removed }) => removed));

  const disabled = controlsHarness({ enabled: false });
  const disabledEvents = [];
  const b = hook(disabled, 'b', disabledEvents);
  start(b.touchProps, 2);
  finish(b.touchProps, [2]);
  assert.deepEqual(disabledEvents, []);
});

test('dragging outside measured bounds releases, then re-entering reasserts', () => {
  const h = controlsHarness();
  const events = [];
  const a = hook(h, 'a', events);

  start(a.touchProps, 5, 50, 50);
  move(a.touchProps, 5, 101, 50);
  move(a.touchProps, 5, -1, 50);
  move(a.touchProps, 5, 99, 1);
  finish(a.touchProps, [5]);

  assert.deepEqual(events, [
    ['a', true],
    ['a', false],
    ['a', true],
    ['a', false],
  ]);
});

test('point updates are synchronous and native identifiers are normalized to strings', () => {
  const h = controlsHarness();
  const events = [];
  const snapshots = [];
  const dpad = hook(h, 'dpad', events, {
    onPointsChange: (points) => {
      snapshots.push(Array.from(points, ({ id, x, y }) => ({ id, x, y })));
    },
  });

  start(dpad.touchProps, 42, 12, 18);
  assert.deepEqual(snapshots.at(-1), [{ id: '42', x: 12, y: 18 }]);
  move(dpad.touchProps, 42, 70, 80);
  assert.deepEqual(snapshots.at(-1), [{ id: '42', x: 70, y: 80 }]);
  finish(dpad.touchProps, [42]);
  assert.deepEqual(snapshots.at(-1), []);
});

test('hooks require provider context and same-name controls register independently', () => {
  const absent = controlsHarness({ withProvider: false });
  assert.throws(
    () => absent.useGameplayControl('a', () => {}),
    /provider|context|GameplayControls/i,
  );

  const h = controlsHarness();
  const first = h.useGameplayControl('a', () => {});
  const second = h.useGameplayControl('a', () => {});
  const registrations = h.registrations.filter(({ name }) => name === 'a');
  assert.equal(registrations.length, 2);
  assert.notEqual(registrations[0].controller, registrations[1].controller);

  registrations[0].controller.releaseAll();
  registrations[1].controller.releaseAll();
  assert.ok(first.touchProps);
  assert.ok(second.touchProps);
});

test('FF button presents each incremental level and exposes the real multiplier', () => {
  const h = controlsHarness();
  const { SpeedButton } = h.loadActions();
  for (const speed of [1, 2, 3, 4]) {
    let presses = 0;
    const element = SpeedButton({ speed, onPress: () => { presses++; } });
    assert.equal(element.props.accessibilityState.selected, speed > 1);
    assert.ok(element.props.accessibilityLabel.includes(`(${speed} times normal speed)`));
    if (speed > 1) assert.equal(element.children[0].children[0], `FF\n+${speed - 1}×`);
    element.props.onAccessibilityTap();
    assert.equal(presses, 1);
  }
});

test('actual D-pad handles a diagonal beside A and exposes touch handlers on its measured View', () => {
  const h = controlsHarness();
  const DPad = h.loadDPad();
  const events = [];
  const wrapped = DPad({
    onKeyChange: (key, down) => events.push([key, down]),
  });
  const element = wrapped.type === 'View' ? wrapped : wrapped.children[0];

  assert.equal(element.type, 'View');
  assert.equal(typeof element.props.onTouchStart, 'function');
  layout(element.props, 150, 150);

  const aEvents = [];
  const a = hook(h, 'a', aEvents);
  start(element.props, 100, 125, 25);
  start(a.touchProps, 'a-finger');
  assert.deepEqual(events, [
    ['up', true],
    ['right', true],
  ]);
  assert.deepEqual(aEvents, [['a', true]]);

  move(element.props, 100, 25, 125);
  assert.deepEqual(events, [
    ['up', true],
    ['right', true],
    ['up', false],
    ['down', true],
    ['left', true],
    ['right', false],
  ]);

  finish(element.props, [100]);
  finish(a.touchProps, ['a-finger']);
  assert.deepEqual(events.slice(-2), [
    ['down', false],
    ['left', false],
  ]);
  assert.deepEqual(aEvents.at(-1), ['a', false]);

  const decorativeWrapper = element.children.find(
    (child) => child && child.props && child.props.pointerEvents === 'none',
  );
  assert.ok(decorativeWrapper, 'D-pad artwork must not intercept root touches');
});

// Page origins intentionally differ from both local onLayout coordinates and
// window coordinates (e.g. Android status/navigation chrome). These are two
// geometric control decks, not identical overlapping hook-only fixtures.
const ANDROID_LAYOUTS = {
  portrait: {
    l: [39, 457, 90, 40], r: [289, 457, 90, 40],
    dpad: [49, 557, 150, 150], a: [321, 557, 58, 58],
    b: [257, 621, 58, 58], start: [245, 777, 26, 26], select: [197, 777, 26, 26],
  },
  landscape: {
    l: [60, 69, 90, 40], r: [765, 69, 90, 40],
    dpad: [29, 199, 150, 150], a: [807, 199, 58, 58],
    b: [743, 263, 58, 58], start: [459, 388, 26, 26], select: [411, 388, 26, 26],
  },
};

function androidDeck(layoutName = 'portrait', onKeyChange = () => {}, { deferMeasurements = false, onFastForward } = {}) {
  const h = controlsHarness({ platform: 'android' });
  let root = h.renderProvider();
  const rects = Object.fromEntries(Object.entries(ANDROID_LAYOUTS[layoutName]).map(([name, values]) => [
    name, { x: values[0], y: values[1], width: values[2], height: values[3] },
  ]));
  const controls = {};
  if (onFastForward) rects.speed = { x: 600, y: 420, width: 44, height: 44 };
  const queuedMeasurements = [];
  let measurementCount = 0;
  let defer = deferMeasurements;
  const actions = h.loadActions();
  const DPad = h.loadDPad();

  function mount(element) {
    if (!element || typeof element !== 'object') return;
    if (typeof element.type === 'function') return mount(element.type(element.props));
    const name = element.props.testID === 'fast-forward-button'
      ? 'speed' : element.props.testID?.replace('game-button-', '');
    if (name && rects[name]) {
      controls[name] = element.props;
      assert.ok(element.props.ref, `actual ${name} View needs a measurement ref`);
      element.props.ref.current = {
        measure(callback) {
          measurementCount++;
          const { x, y, width, height } = rects[name];
          const done = () => callback(0, 0, width, height, x, y);
          if (defer) queuedMeasurements.push(done);
          else done();
        },
        measureInWindow() {
          assert.fail('Window coordinates cannot be mixed with RootReactView pageX/pageY');
        },
      };
    }
    element.children.flat().forEach(mount);
  }
  h.render('deck', () => {
    for (const Component of [actions.LButton, actions.RButton, actions.MenuButtons, actions.ABButtons, DPad]) {
      mount(Component({ onKeyChange }));
    }
    if (onFastForward) mount(actions.SpeedButton({ speed: 1, onPress: onFastForward }));
  });
  for (const [name, props] of Object.entries(controls)) {
    layout(props, rects[name].width, rects[name].height);
    assert.equal(props.onTouchStart, undefined, `${name} must not own Android's later pointer downs`);
  }

  let firstTarget = null;
  const active = new Map();
  function point(name, id, localX, localY) {
    const rect = rects[name];
    return {
      identifier: id,
      pageX: rect.x + (localX ?? rect.width / 2),
      pageY: rect.y + (localY ?? rect.height / 2),
    };
  }
  function dispatch(type, contacts) {
    if (type === 'onTouchStart') {
      firstTarget ??= Object.keys(rects).find((name) => {
        const rect = rects[name], p = contacts[0];
        return p.pageX >= rect.x && p.pageX <= rect.x + rect.width
          && p.pageY >= rect.y && p.pageY <= rect.y + rect.height;
      }) ?? 'blank-root';
      contacts.forEach((contact) => active.set(String(contact.identifier), contact));
    } else if (type === 'onTouchMove') {
      contacts.forEach((contact) => active.set(String(contact.identifier), contact));
    } else {
      contacts.forEach((contact) => active.delete(String(contact.identifier)));
    }
    const origin = rects[firstTarget] ?? { x: 19, y: 37 };
    const changedTouches = contacts.map((contact) => ({
      ...contact,
      target: firstTarget,
      locationX: contact.pageX - origin.x,
      locationY: contact.pageY - origin.y,
    }));
    // RN's modern TouchesHelper emits one callback per changed contact, each
    // carrying the same full changedTouches. All callbacks retain firstTarget.
    for (const contact of changedTouches) {
      const event = {
        nativeEvent: { ...contact, changedTouches, touches: [...active.values()] },
        currentTarget: firstTarget,
      };
      controls[firstTarget]?.[type]?.(event);
      root[type]?.(event);
    }
    if (active.size === 0) firstTarget = null;
  }
  return {
    h, controls, rects, point, dispatch,
    start: (name, id, x, y) => dispatch('onTouchStart', [point(name, id, x, y)]),
    move: (name, id, x, y) => dispatch('onTouchMove', [point(name, id, x, y)]),
    end: (...ids) => dispatch('onTouchEnd', ids.map((id) => active.get(String(id)) ?? { identifier: id })),
    cancel: () => dispatch('onTouchCancel', [...active.values()]),
    refresh: () => root.onLayout(),
    setEnabled(enabled) { root = h.renderProvider(enabled); },
    get measurementCount() { return measurementCount; },
    flushMeasurements() {
      defer = false;
      queuedMeasurements.splice(0).forEach((done) => done());
    },
  };
}

async function coreKeySink() {
  const { bootCoreInteractive } = require('../../emulator/fixtures/run-core.js');
  const rom = Buffer.alloc(512);
  rom.writeUInt32LE(0xEAFFFFFE, 0); // test fixture: stationary ARM branch
  rom[0xB2] = 0x96;
  const core = await bootCoreInteractive(rom);
  const events = [];
  return {
    events,
    onKeyChange(key, down) {
      events.push([key, down]);
      core.send({ type: down ? 'keydown' : 'keyup', key });
    },
    keys() {
      core.posted.length = 0;
      core.send({ type: 'saveState' });
      const snapshot = JSON.parse(core.posted.find((event) => event.type === 'saveState').state);
      return Buffer.from(snapshot.io, 'base64').readUInt16LE(0x130);
    },
  };
}

test('Android first-target routing activates FF while B is held and releases each contact independently', async () => {
  const sink = await coreKeySink();
  let presses = 0;
  const deck = androidDeck('portrait', sink.onKeyChange, { onFastForward: () => { presses++; } });
  deck.start('b', 1);
  deck.start('speed', 2);
  assert.equal(presses, 1, 'FF activates on stationary second contact, not a drag');
  assert.equal(sink.keys(), 0x3ff & ~2, 'FF does not release B');
  deck.end(2);
  assert.equal(sink.keys(), 0x3ff & ~2);
  deck.end(1);
  assert.equal(sink.keys(), 0x3ff);
});

for (const layoutName of Object.keys(ANDROID_LAYOUTS)) {
  test(`Android ${layoutName}: first L target receives R + Start but keys release independently`, async () => {
    const sink = await coreKeySink();
    const deck = androidDeck(layoutName, sink.onKeyChange);
    const measurements = deck.measurementCount;
    deck.start('l', 1);
    assert.equal(sink.keys(), 0x3ff & ~0x200, 'initial stationary tap presses synchronously');
    deck.start('r', 2);
    deck.start('start', 3);
    assert.equal(sink.keys(), 0x3ff & ~(0x200 | 0x100 | 0x8));
    deck.end(2);
    assert.equal(sink.keys(), 0x3ff & ~(0x200 | 0x8));
    deck.end(1);
    assert.equal(sink.keys(), 0x3ff & ~0x8, 'first target can lift before later contacts');
    deck.end(3);
    assert.equal(sink.keys(), 0x3ff);
    assert.deepEqual(sink.events, [
      ['l', true], ['r', true], ['start', true],
      ['r', false], ['l', false], ['start', false],
    ]);
    assert.equal(deck.measurementCount, measurements, 'no async measurement or waiting on initial taps');
  });

  test(`Android ${layoutName}: D-pad diagonal + A + B route all moves by owner and reach KEYINPUT`, async () => {
    const sink = await coreKeySink();
    const deck = androidDeck(layoutName, sink.onKeyChange);
    deck.start('dpad', 10, 125, 25);
    deck.start('a', 11);
    deck.start('b', 12);
    assert.equal(sink.keys(), 0x3ff & ~(0x40 | 0x10 | 0x1 | 0x2));
    deck.dispatch('onTouchMove', [
      deck.point('dpad', 10, 25, 125), deck.point('a', 11), deck.point('b', 12),
    ]);
    assert.equal(sink.keys(), 0x3ff & ~(0x80 | 0x20 | 0x1 | 0x2));
    deck.end(11);
    assert.equal(sink.keys(), 0x3ff & ~(0x80 | 0x20 | 0x2));
    deck.end(10);
    assert.equal(sink.keys(), 0x3ff & ~0x2);
    deck.end(12);
    assert.equal(sink.keys(), 0x3ff);
  });
}

test('Android: two contacts on A survive one release, move off/re-enter without becoming B', async () => {
  const sink = await coreKeySink();
  const events = sink.events;
  const deck = androidDeck('portrait', sink.onKeyChange);
  deck.start('a', 7);
  deck.start('a', '8');
  deck.end(7);
  assert.deepEqual(events, [['a', true]]);
  assert.equal(sink.keys(), 0x3ff & ~0x1);
  deck.move('b', '8');
  assert.deepEqual(events.at(-1), ['a', false]);
  assert.equal(sink.keys(), 0x3ff);
  assert.ok(!events.some(([key]) => key === 'b'), 'owner never transfers across controls');
  deck.move('a', '8');
  assert.deepEqual(events.at(-1), ['a', true]);
  deck.end('8');
  assert.deepEqual(events.at(-1), ['a', false]);
  assert.equal(sink.keys(), 0x3ff);
});

test('Android: every stationary gameplay button responds to rapid taps without moves or extra measurement', () => {
  const events = [];
  const deck = androidDeck('landscape', (key, down) => events.push([key, down]));
  const measurements = deck.measurementCount;
  for (const name of ['a', 'b', 'l', 'r', 'start', 'select']) {
    for (let id = 0; id < 8; id++) {
      deck.start(name, id);
      assert.deepEqual(events.at(-1), [name, true]);
      deck.end(id);
      assert.deepEqual(events.at(-1), [name, false]);
    }
  }
  assert.equal(events.length, 96);
  assert.equal(deck.measurementCount, measurements);
});

test('Android: blank first target still routes later contacts; unowned moves never acquire a control', () => {
  const events = [];
  const deck = androidDeck('landscape', (key, down) => events.push([key, down]));
  deck.dispatch('onTouchStart', [{ identifier: 1, pageX: 400, pageY: 100 }]);
  deck.move('a', 1);
  assert.deepEqual(events, []);
  deck.start('a', 2);
  deck.start('b', 3);
  assert.deepEqual(events, [['a', true], ['b', true]]);
  deck.end(2, 3, 1);
  assert.deepEqual(events.slice(-2), [['a', false], ['b', false]]);
});

test('Android: multiple D-pad contacts merge directions and hitSlop uses measured local coordinates', () => {
  const events = [];
  const deck = androidDeck('portrait', (key, down) => events.push([key, down]));
  deck.start('dpad', 1, 75, -10); // within its existing 14px hitSlop
  deck.start('dpad', 2, 140, 75);
  assert.deepEqual(events, [['up', true], ['right', true]]);
  deck.end(1);
  assert.deepEqual(events.at(-1), ['up', false]);
  deck.end(2);
  assert.deepEqual(events.at(-1), ['right', false]);
});

test('Android: cancel, background, disable, layout/orientation changes and unmount release real keys', async () => {
  const sink = await coreKeySink();
  const deck = androidDeck('portrait', sink.onKeyChange);
  for (const interrupt of [
    () => deck.cancel(),
    () => deck.h.emitAppState('background'),
    () => deck.setEnabled(false),
    () => deck.refresh(),
    () => deck.h.emitDimensions(),
  ]) {
    deck.start('l', 1);
    deck.start('r', 2);
    deck.start('dpad', 3, 125, 25);
    assert.notEqual(sink.keys(), 0x3ff);
    interrupt();
    assert.equal(sink.keys(), 0x3ff);
    deck.move('l', 1);
    assert.equal(sink.keys(), 0x3ff, 'stale moves cannot re-press after interruption');
    deck.end(1, 2, 3);
    deck.h.emitAppState('active');
    deck.setEnabled(true);
  }
  deck.start('a', 5);
  deck.h.cleanups.forEach((cleanup) => cleanup());
  assert.equal(sink.keys(), 0x3ff, 'unmount emits the final key-up');
});

test('Android: parent/layout movement remeasures real page bounds and rejects stale async measurements', () => {
  const events = [];
  const deck = androidDeck('portrait', (key, down) => events.push([key, down]), {
    deferMeasurements: true,
  });
  const original = { ...deck.rects.a };
  deck.rects.a.x += 40;
  deck.rects.a.y -= 35;
  deck.refresh();
  deck.flushMeasurements();
  deck.dispatch('onTouchStart', [{
    identifier: 1, pageX: original.x + 10, pageY: original.y + 10,
  }]);
  assert.deepEqual(events, [], 'old measurement must not restore old page bounds');
  deck.end(1);
  deck.start('a', 2);
  assert.deepEqual(events, [['a', true]]);
  deck.rects.a.x -= 40;
  layout(deck.controls.b, 58, 58); // sibling/local layout can signal parent relocation
  assert.deepEqual(events.at(-1), ['a', false]);
  deck.end(2);
  deck.start('a', 3);
  assert.deepEqual(events.at(-1), ['a', true]);
  deck.end(3);
});

test('Android: rotating a held portrait deck releases keys, then routes against landscape page geometry', async () => {
  const sink = await coreKeySink();
  const deck = androidDeck('portrait', sink.onKeyChange);
  deck.start('dpad', 1, 125, 25);
  deck.start('a', 2);
  assert.equal(sink.keys(), 0x3ff & ~(0x40 | 0x10 | 0x1));
  for (const [name, [x, y, width, height]] of Object.entries(ANDROID_LAYOUTS.landscape)) {
    Object.assign(deck.rects[name], { x, y, width, height });
  }
  deck.h.emitDimensions();
  deck.refresh();
  assert.equal(sink.keys(), 0x3ff);
  deck.end(1, 2);
  deck.start('l', 3);
  deck.start('r', 4);
  deck.start('start', 5);
  assert.equal(sink.keys(), 0x3ff & ~(0x200 | 0x100 | 0x8));
  deck.end(3, 4, 5);
  assert.equal(sink.keys(), 0x3ff);
});

test('web keeps DOM-target filtering, per-contact releases and mouse capture unchanged', () => {
  const h = controlsHarness({ platform: 'web' });
  const events = [];
  const a = hook(h, 'a', events);
  const target = {};
  let captured;
  const surface = {
    getBoundingClientRect: () => ({ left: 100, top: 200 }),
    contains: (value) => value === target,
    setPointerCapture: (id) => { captured = id; },
  };
  a.touchProps.onTouchStart({
    currentTarget: surface,
    nativeEvent: { changedTouches: [
      { identifier: 1, clientX: 150, clientY: 250, target },
      { identifier: 2, clientX: 350, clientY: 250, target: {} },
    ] },
  });
  assert.deepEqual(events, [['a', true]]);
  finish(a.touchProps, [2]);
  assert.deepEqual(events, [['a', true]]);
  finish(a.touchProps, [1]);
  assert.deepEqual(events.at(-1), ['a', false]);
  a.touchProps.onPointerDown({
    currentTarget: surface,
    nativeEvent: { pointerType: 'mouse', pointerId: 20, button: 0, clientX: 150, clientY: 250 },
  });
  assert.equal(captured, 20);
  assert.deepEqual(events.at(-1), ['a', true]);
  h.emitBlur();
  assert.deepEqual(events.at(-1), ['a', false]);
});