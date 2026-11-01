const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(rel, modules) {
  const source = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  });
  const exports = {};
  vm.runInNewContext(outputText, { exports, require: (id) => {
    assert.ok(id in modules, id);
    return modules[id];
  } });
  return exports;
}

const React = { createElement: (type, props, ...children) =>
  typeof type === 'function' ? type({ ...props, children }) : { type, props: { ...props, children } } };
const theme = load('../../constants/libraryTheme.ts', {});

function render(insets) {
  const mod = load('../PillTabBar.tsx', {
    react: React,
    'react-native': { Pressable: 'Pressable', StyleSheet: { create: (s) => s }, Text: 'Text', View: 'View' },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    'react-native-safe-area-context': { useSafeAreaInsets: () => insets },
    '@/constants/libraryTheme': theme,
  });
  const nav = [];
  const tree = mod.default({
    state: { index: 0, routes: [{ key: 'a', name: 'index' }, { key: 'b', name: 'settings' }] },
    descriptors: { a: { options: { title: 'Library' } }, b: { options: { title: 'Settings' } } },
    navigation: { emit: () => ({ defaultPrevented: false }), navigate: (n) => nav.push(n) },
  });
  return { tree, nav };
}
const flat = (n) => (Array.isArray(n) ? n.flatMap(flat) : n && typeof n === 'object' ? [n, ...flat(n.props.children)] : []);

for (const bottom of [0, 24, 48]) {
  test(`pill keeps safe bottom padding for a ${bottom}px system area`, () => {
    const { tree } = render({ bottom, left: 0, right: 0, top: 0 });
    const pad = tree.props.style[1].paddingBottom;
    assert.equal(pad, Math.max(bottom, 12) + 6);
    assert.ok(pad >= bottom + 6);
  });
}
test('landscape side insets are reserved', () => {
  const { tree } = render({ bottom: 0, left: 36, right: 48, top: 0 });
  assert.equal(tree.props.style[1].paddingLeft, 36);
  assert.equal(tree.props.style[1].paddingRight, 48);
});
test('two tabs render and navigate', () => {
  const { tree, nav } = render({ bottom: 0, left: 0, right: 0, top: 0 });
  const tabs = flat(tree).filter((n) => n.type === 'Pressable');
  assert.deepEqual(tabs.map((t) => t.props.testID), ['tab-index', 'tab-settings']);
  tabs[1].props.onPress();
  tabs[0].props.onPress();
  assert.deepEqual(nav, ['settings']);
});
test('pill reserve exceeds pill height plus inset', () => {
  assert.equal(theme.pillReserve(24), 24 + 6 + theme.PILL_HEIGHT);
  assert.ok(theme.pillReserve(0) > theme.PILL_HEIGHT);
});
