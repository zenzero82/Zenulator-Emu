import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../components/confirmControlReset.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function setup(platform) {
  const prompts = [];
  const exports = {};
  vm.runInNewContext(javascript, {
    exports,
    require: () => ({
      Platform: { OS: platform },
      Alert: { alert: (...args) => prompts.push(args) },
    }),
  });
  return { ...exports, prompts };
}

test('web reset runs directly instead of depending on RN Web no-op Alert', () => {
  const env = setup('web');
  let reset = false;
  env.confirmControlReset('Reset?', 'Restore defaults.', () => { reset = true; });
  assert.equal(reset, true);
  assert.equal(env.prompts.length, 0);
});

test('Android/iOS reset waits for the native confirmation button', () => {
  for (const platform of ['android', 'ios']) {
    const env = setup(platform);
    let reset = false;
    env.confirmControlReset('Reset?', 'Restore defaults.', () => { reset = true; });
    assert.equal(reset, false);
    const buttons = env.prompts[0][2];
    assert.equal(buttons[0].style, 'cancel');
    buttons[1].onPress();
    assert.equal(reset, true);
  }
});

test('the Controls chooser is unmounted when closed to avoid stale fading overlays', () => {
  const controls = readFileSync(new URL('../../app/controls.tsx', import.meta.url), 'utf8');
  assert.match(controls, /\{rebinding \? <Modal/);
  assert.match(controls, /Platform\.OS === 'web' \? 'none' : 'fade'/);
  assert.ok(!controls.includes('Alert.alert'));
});
