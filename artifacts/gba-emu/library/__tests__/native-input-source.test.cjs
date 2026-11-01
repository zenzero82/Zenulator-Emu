// Source-level guards for the Android native input module (no Android SDK here).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..', '..');
const kt = readFileSync(join(root, 'modules/zenulator-input/android/src/main/java/expo/modules/zenulatorinput/ZenulatorInputModule.kt'), 'utf8');

test('module is autolinkable with the current gradle plugin', () => {
  const cfg = JSON.parse(readFileSync(join(root, 'modules/zenulator-input/expo-module.config.json'), 'utf8'));
  assert.deepEqual(cfg.android.modules, ['expo.modules.zenulatorinput.ZenulatorInputModule']);
  assert.match(readFileSync(join(root, 'modules/zenulator-input/android/build.gradle'), 'utf8'), /id 'expo-module-gradle-plugin'/);
});

test('releases of forwarded keys are delivered before modifier/capture checks', () => {
  const up = kt.indexOf('forwardedDown.containsKey(physicalId)');
  assert.ok(up > 0);
  assert.ok(up < kt.indexOf('if (!captureEnabled) return false', up - 400 > 0 ? up - 400 : 0) || up < kt.indexOf('event.isCtrlPressed'));
  assert.ok(up < kt.indexOf('event.isCtrlPressed'));
  assert.match(kt, /releaseForwarded\(deviceId\)/);
});

test('D-pad-only controllers are classified as gamepads', () => {
  assert.match(kt, /SOURCE_DPAD\) == InputDevice\.SOURCE_DPAD && !hasKeyboardSource/);
  assert.match(kt, /event\.device\?\.let \{ isController\(it\) \}/);
});

test('system keys pass through and iOS never imports runtime orientation locking paths', () => {
  assert.match(kt, /KEYCODE_BACK/);
  const emu = readFileSync(join(root, 'app/emulator.tsx'), 'utf8');
  const lockIdx = emu.indexOf('ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE)');
  const guard = emu.lastIndexOf("if (Platform.OS !== 'android') return;", lockIdx);
  assert.ok(lockIdx > 0 && guard > 0 && lockIdx - guard < 1200);
  assert.ok(existsSync(join(root, 'modules/zenulator-input/index.ts')));
});
