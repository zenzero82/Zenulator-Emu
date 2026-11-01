const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the shipped screen callbacks, not a second implementation of its
// state/ref updates. No browser or device performance is inferred here.
const source = readFileSync(join(__dirname, '../../app/emulator.tsx'), 'utf8');
const ast = ts.createSourceFile('emulator.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = [];
let boot;
function visit(node) {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
    ['applySpeed', 'cycleSpeed'].includes(declaration.name.getText(ast)))) declarations.push(node.getText(ast));
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' &&
    node.arguments[0]?.getText(ast).includes('setFastForward(1)')) boot = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(declarations.length, 2);
assert.ok(boot);
const preferenceSource = readFileSync(join(__dirname, '../gameplayPreferences.ts'), 'utf8');
const preferenceAst = ts.createSourceFile('prefs.ts', preferenceSource, ts.ScriptTarget.Latest, true);
const nextSpeed = preferenceAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === 'nextSpeed');
const javascript = ts.transpileModule(
  [nextSpeed.getText(preferenceAst).replace(/^export /, ''), ...declarations, boot, 'globalThis.cycle=cycleSpeed;'].join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function harness() {
  const bridge = [], states = [];
  const sandbox = {
    speedRef: { current: 1 },
    emulatorRef: { current: { setFastForward: (factor) => bridge.push(factor) } },
    setSpeed: (factor) => states.push(factor),
    useCallback: (callback) => callback,
    useEffect: (callback) => { sandbox.boot = callback; },
    romId: 'synthetic-game',
    Haptics: { impactAsync: async () => {}, ImpactFeedbackStyle: { Light: 'light' } },
  };
  vm.runInNewContext(javascript, sandbox);
  return { sandbox, bridge, states };
}

test('rapid FF presses send 2/3/4/1 to the actual bridge even without a React rerender', () => {
  const { sandbox, bridge, states } = harness();
  for (let press = 0; press < 8; press++) sandbox.cycle();
  assert.deepEqual(bridge, [2, 3, 4, 1, 2, 3, 4, 1]);
  assert.deepEqual(states, bridge);
});

test('a new ROM resets the session and queued core speed to Normal', () => {
  const { sandbox, bridge, states } = harness();
  sandbox.speedRef.current = 4;
  sandbox.boot();
  assert.equal(sandbox.speedRef.current, 1);
  assert.deepEqual(bridge, [1]);
  assert.deepEqual(states, [1]);
  sandbox.cycle();
  assert.equal(bridge.at(-1), 2);
});

test('the mobile Settings speed selector and saved speed dependency are removed', () => {
  const settings = readFileSync(join(__dirname, '../../app/(tabs)/settings.tsx'), 'utf8');
  assert.ok(!settings.includes('Game speed target'));
  assert.ok(!settings.includes('SpeedSelector'));
  assert.ok(!source.includes('prefs.speed'));
  assert.ok(!source.includes('loadedPrefs.speed'));
});
