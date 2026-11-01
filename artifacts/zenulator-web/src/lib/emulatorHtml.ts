// Zenulator Mobile and Zenulator Web are separate products, but both execute
// the same emulator core so game compatibility fixes cannot drift between them.
import { GBA_EMULATOR_HTML as MOBILE_CORE_HTML } from '../../../gba-emu/emulator/html';
import { DEFAULT_KEYBOARD_BINDINGS, keyboardLookup } from '../../../gba-emu/library/inputMapping';

// The shared core reports through the React Native WebView bridge. The desktop
// product supplies the same tiny contract over the browser's iframe channel.
// Keyboard events belong to the iframe once its canvas is focused, so relay
// them to the outer app as core messages. The outer app still owns filtering
// for toolbar controls, dialogs, and text inputs.
const WEB_KEYBOARD_BRIDGE = `
window.ReactNativeWebView = {
  postMessage: function (data) { window.parent.postMessage(data, '*'); }
};
(function () {
  // Replaced by the host's saved bindings via the shared setInputMap message.
  var keyMap = ${JSON.stringify(keyboardLookup(DEFAULT_KEYBOARD_BINDINGS))};
  var held = {};
  window.addEventListener('message', function (event) {
    try {
      var data = JSON.parse(event.data);
      if (data && data.type === 'setInputMap' && data.keyboard && typeof data.keyboard === 'object') {
        keyMap = data.keyboard;
      }
    } catch (error) {}
  });
  var editableSelector = 'a[href], button, input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="menuitem"], [role="option"]';
  function isEditable(target) {
    return target && target.closest && target.closest(editableSelector);
  }
  function canRoute(event) {
    return !event.altKey && !event.ctrlKey && !event.metaKey;
  }
  function send(message) {
    window.parent.postMessage(JSON.stringify(message), '*');
  }
  window.addEventListener('keydown', function (event) {
    if (isEditable(event.target) || !canRoute(event)) return;
    var key = keyMap[event.code];
    if (!key) return;
    event.preventDefault();
    if (key === 'speed') {
      if (!event.repeat) send({ type: 'requestSpeedCycle' });
      return;
    }
    held[event.code] = key;
    send({ type: 'keydown', key: key });
  }, true);
  window.addEventListener('keyup', function (event) {
    // Release exactly what this physical key pressed, even after a rebind.
    var key = held[event.code];
    if (!key) return;
    delete held[event.code];
    event.preventDefault();
    send({ type: 'keyup', key: key });
  }, true);
  function release() { held = {}; send({ type: 'releaseAllKeys' }); }
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') release();
  });
})();
`;

export const GBA_EMULATOR_HTML = MOBILE_CORE_HTML.replace(
  '<script>',
  `<script>${WEB_KEYBOARD_BRIDGE}`,
);