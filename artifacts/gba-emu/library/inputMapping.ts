// Shared GBA input-mapping semantics for Zenulator Mobile and Zenulator Web.
// Pure TypeScript only: no React Native or DOM imports, so both products and
// node:test can load it. Screens stay product-specific; the rules live here.

export const GBA_KEYS = ['up', 'down', 'left', 'right', 'a', 'b', 'l', 'r', 'start', 'select'] as const;
export type GbaKey = (typeof GBA_KEYS)[number];
/** `speed` cycles the 1x/2x/3x target; it is never sent to the core as a key. */
export const INPUT_ACTIONS = [...GBA_KEYS, 'speed'] as const;
export type InputAction = (typeof INPUT_ACTIONS)[number];

export const ACTION_LABELS: Record<InputAction, string> = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  a: 'A', b: 'B', l: 'L', r: 'R', start: 'Start', select: 'Select', speed: 'Cycle speed',
};

/** Keyboard bindings use DOM `KeyboardEvent.code` values on every platform. */
export type KeyboardBindings = Record<InputAction, string[]>;
/** Controller bindings use W3C "standard" gamepad button indices. */
export type GamepadBindings = Record<InputAction, number[]>;

export const DEFAULT_KEYBOARD_BINDINGS: KeyboardBindings = {
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
  b: ['KeyZ'], a: ['KeyX'], l: ['KeyA'], r: ['KeyS'],
  start: ['Enter'], select: ['ShiftLeft', 'ShiftRight'], speed: ['KeyF'],
};

export const DEFAULT_GAMEPAD_BINDINGS: GamepadBindings = {
  a: [0], b: [1], l: [4], r: [5], select: [8], start: [9],
  up: [12], down: [13], left: [14], right: [15], speed: [7],
};

export const MAX_BINDINGS_PER_ACTION = 2;

/**
 * Browser/OS-owned keys. Binding these would steal focus traversal, exit
 * fullscreen, devtools, or system shortcuts, so they are refused outright.
 */
export const RESERVED_KEY_CODES = new Set([
  'Tab', 'Escape', 'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'ContextMenu', 'CapsLock', 'PrintScreen', 'F1', 'F3', 'F5', 'F6', 'F7', 'F11', 'F12',
  'BrowserBack', 'BrowserForward', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute',
]);

export const GAMEPAD_BUTTON_LABELS: Record<number, string> = {
  0: 'South (A / Cross)', 1: 'East (B / Circle)', 2: 'West (X / Square)', 3: 'North (Y / Triangle)',
  4: 'L1 / LB', 5: 'R1 / RB', 6: 'L2 / LT', 7: 'R2 / RT', 8: 'Select / View', 9: 'Start / Menu',
  10: 'Left stick press', 11: 'Right stick press', 12: 'D-pad up', 13: 'D-pad down',
  14: 'D-pad left', 15: 'D-pad right', 16: 'Home / Guide',
};
export const BINDABLE_GAMEPAD_BUTTONS = Array.from({ length: 16 }, (_, index) => index);

/** Key codes offered in pick-from-list rebinding (accessible, works without a keyboard attached). */
export const PICKABLE_KEY_CODES = [
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', 'Backspace', 'ShiftLeft', 'ShiftRight',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
  ...'0123456789'.split('').map((d) => `Digit${d}`),
  'Comma', 'Period', 'Slash', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Minus', 'Equal',
];

export function describeKeyCode(code: string): string {
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  const named: Record<string, string> = {
    ArrowUp: 'Up arrow', ArrowDown: 'Down arrow', ArrowLeft: 'Left arrow', ArrowRight: 'Right arrow',
    ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', Space: 'Space', Enter: 'Enter',
    Backspace: 'Backspace', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
  };
  return named[code] ?? code;
}

export function describeGamepadButton(index: number): string {
  return GAMEPAD_BUTTON_LABELS[index] ?? `Button ${index}`;
}

function isAction(value: string): value is InputAction {
  return (INPUT_ACTIONS as readonly string[]).includes(value);
}

export function isGbaKey(value: unknown): value is GbaKey {
  return typeof value === 'string' && (GBA_KEYS as readonly string[]).includes(value);
}

function cloneBindings<T>(bindings: Record<InputAction, T[]>): Record<InputAction, T[]> {
  const out = {} as Record<InputAction, T[]>;
  for (const action of INPUT_ACTIONS) out[action] = [...(bindings[action] ?? [])];
  return out;
}

export interface AssignResult<T> {
  bindings: Record<InputAction, T[]>;
  /** Actions that lost this input because it was moved to the new action. */
  displaced: InputAction[];
  /** Set when the input was refused (reserved key). */
  rejected?: string;
}

/**
 * Bind `input` to `action`. One physical input drives at most one action:
 * a conflicting binding is removed from its old action and reported, never
 * silently duplicated. `replace` (the default) makes it the action's only
 * binding; otherwise it is added as a secondary binding (max 2).
 */
function assign<T extends string | number>(
  bindings: Record<InputAction, T[]>, action: InputAction, input: T, replace: boolean,
): AssignResult<T> {
  const next = cloneBindings(bindings);
  const displaced: InputAction[] = [];
  for (const other of INPUT_ACTIONS) {
    if (other === action) continue;
    if (next[other].includes(input)) {
      next[other] = next[other].filter((value) => value !== input);
      displaced.push(other);
    }
  }
  if (replace) next[action] = [input];
  else if (!next[action].includes(input)) {
    next[action] = [...next[action], input].slice(-MAX_BINDINGS_PER_ACTION);
  }
  return { bindings: next, displaced };
}

export function assignKeyboardBinding(
  bindings: KeyboardBindings, action: InputAction, code: string, replace = true,
): AssignResult<string> {
  if (RESERVED_KEY_CODES.has(code) || !code) {
    return { bindings: cloneBindings(bindings), displaced: [], rejected: `${describeKeyCode(code)} is reserved by the browser or system.` };
  }
  return assign(bindings, action, code, replace);
}

export function assignGamepadBinding(
  bindings: GamepadBindings, action: InputAction, button: number, replace = true,
): AssignResult<number> {
  if (!Number.isInteger(button) || button < 0 || button > 31) {
    return { bindings: cloneBindings(bindings), displaced: [], rejected: 'Unsupported controller button.' };
  }
  return assign(bindings, action, button, replace);
}

export function clearBinding<T>(bindings: Record<InputAction, T[]>, action: InputAction): Record<InputAction, T[]> {
  const next = cloneBindings(bindings);
  next[action] = [];
  return next;
}

/** Validate untrusted stored JSON; anything malformed falls back per-action to defaults. */
export function parseKeyboardBindings(raw: unknown): KeyboardBindings {
  const out = cloneBindings(DEFAULT_KEYBOARD_BINDINGS);
  if (!raw || typeof raw !== 'object') return out;
  const seen = new Set<string>();
  for (const [action, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAction(action) || !Array.isArray(value)) continue;
    out[action] = value
      .filter((code): code is string => typeof code === 'string' && code.length > 0 && code.length < 32 && !RESERVED_KEY_CODES.has(code))
      .filter((code) => (seen.has(code) ? false : (seen.add(code), true)))
      .slice(0, MAX_BINDINGS_PER_ACTION);
  }
  return out;
}

export function parseGamepadBindings(raw: unknown): GamepadBindings {
  const out = cloneBindings(DEFAULT_GAMEPAD_BINDINGS);
  if (!raw || typeof raw !== 'object') return out;
  const seen = new Set<number>();
  for (const [action, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAction(action) || !Array.isArray(value)) continue;
    out[action] = value
      .filter((button): button is number => Number.isInteger(button) && button >= 0 && button <= 31)
      .filter((button) => (seen.has(button) ? false : (seen.add(button), true)))
      .slice(0, MAX_BINDINGS_PER_ACTION);
  }
  return out;
}

/** Inverse lookups: physical input -> action. These are what routing uses. */
export function keyboardLookup(bindings: KeyboardBindings): Record<string, InputAction> {
  const out: Record<string, InputAction> = {};
  for (const action of INPUT_ACTIONS) for (const code of bindings[action]) out[code] = action;
  return out;
}

export function gamepadLookup(bindings: GamepadBindings): Record<string, InputAction> {
  const out: Record<string, InputAction> = {};
  for (const action of INPUT_ACTIONS) for (const button of bindings[action]) out[String(button)] = action;
  return out;
}

export interface ModifierState { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }

/** Ctrl/Alt/Meta combinations always stay browser/OS owned. */
export function routeKeyboardCode(
  bindings: KeyboardBindings, code: string, modifiers: ModifierState = {},
): InputAction | undefined {
  if (modifiers.altKey || modifiers.ctrlKey || modifiers.metaKey) return undefined;
  if (RESERVED_KEY_CODES.has(code)) return undefined;
  return keyboardLookup(bindings)[code];
}

// ── Android native KeyEvent translation ─────────────────────────────────────
// The local ZenulatorInput module forwards raw Android key codes. Translate
// them to the same DOM code / standard-gamepad vocabulary used everywhere.

const ANDROID_GAMEPAD_KEYCODES: Record<number, number> = {
  96: 0, 97: 1, 99: 2, 100: 3, // BUTTON_A, B, X, Y
  102: 4, 103: 5, 104: 6, 105: 7, // L1, R1, L2, R2
  109: 8, 108: 9, 106: 10, 107: 11, // SELECT, START, THUMBL, THUMBR
  19: 12, 20: 13, 21: 14, 22: 15, // DPAD_*
  110: 16, // MODE
  98: 2, 101: 3, // BUTTON_C, BUTTON_Z (rare layouts)
};

export function androidGamepadButton(keyCode: number): number | undefined {
  return ANDROID_GAMEPAD_KEYCODES[keyCode];
}

export function androidKeyboardCode(keyCode: number): string | undefined {
  if (keyCode >= 29 && keyCode <= 54) return `Key${String.fromCharCode(65 + keyCode - 29)}`;
  if (keyCode >= 7 && keyCode <= 16) return `Digit${keyCode - 7}`;
  const named: Record<number, string> = {
    19: 'ArrowUp', 20: 'ArrowDown', 21: 'ArrowLeft', 22: 'ArrowRight',
    66: 'Enter', 160: 'Enter', 62: 'Space', 67: 'Backspace', 59: 'ShiftLeft', 60: 'ShiftRight',
    55: 'Comma', 56: 'Period', 76: 'Slash', 74: 'Semicolon', 75: 'Quote',
    71: 'BracketLeft', 72: 'BracketRight', 69: 'Minus', 70: 'Equal', 61: 'Tab', 111: 'Escape',
  };
  return named[keyCode];
}

export interface NativeButtonEvent { keyCode: number; pressed: boolean; gamepad: boolean }

export function routeNativeButton(
  event: NativeButtonEvent, keyboard: KeyboardBindings, gamepad: GamepadBindings,
): InputAction | undefined {
  if (event.gamepad) {
    const button = androidGamepadButton(event.keyCode);
    return button === undefined ? undefined : gamepadLookup(gamepad)[String(button)];
  }
  const code = androidKeyboardCode(event.keyCode);
  return code ? routeKeyboardCode(keyboard, code) : undefined;
}

/** Analog stick / hat to D-pad with a 0.5 deadzone. */
export function axesToDirections(x: number, y: number): Record<'up' | 'down' | 'left' | 'right', boolean> {
  return { left: x < -0.5, right: x > 0.5, up: y < -0.5, down: y > 0.5 };
}

// ── Multi-source key aggregation ────────────────────────────────────────────
// Touch, keyboard and controller can hold the same GBA key. The core must see
// one press until the LAST source releases it, and a source that disappears
// (blur, disconnect, menu open) must release only what it was holding.

export interface KeyAggregator {
  set: (source: string, key: GbaKey, pressed: boolean) => void;
  releaseSource: (source: string) => void;
  releaseAll: () => void;
  isHeld: (key: GbaKey) => boolean;
}

export function createKeyAggregator(emit: (key: GbaKey, pressed: boolean) => void): KeyAggregator {
  const holders = new Map<GbaKey, Set<string>>();
  const set = (source: string, key: GbaKey, pressed: boolean) => {
    const current = holders.get(key) ?? new Set<string>();
    const wasHeld = current.size > 0;
    if (pressed) current.add(source); else current.delete(source);
    holders.set(key, current);
    const isHeld = current.size > 0;
    if (wasHeld !== isHeld) emit(key, isHeld);
  };
  return {
    set,
    releaseSource: (source) => {
      // Exact id or any sub-source (`axis:3` also releases `axis:3:up`).
      holders.forEach((sources, key) => {
        [...sources].forEach((held) => {
          if (held === source || held.startsWith(`${source}:`)) set(held, key, false);
        });
      });
    },
    releaseAll: () => {
      holders.forEach((sources, key) => {
        if (sources.size) { sources.clear(); emit(key, false); }
      });
    },
    isHeld: (key) => (holders.get(key)?.size ?? 0) > 0,
  };
}

/** Message payload understood by the shared core's `setInputMap` handler. */
export function coreInputMapMessage(keyboard: KeyboardBindings, gamepad: GamepadBindings, keyboardInCore: boolean) {
  return { type: 'setInputMap' as const, keyboard: keyboardLookup(keyboard), gamepad: gamepadLookup(gamepad), keyboardInCore };
}

// ── Native source tracking ──────────────────────────────────────────────────
// Every source id actually emitted to the aggregator is recorded EXACTLY
// (e.g. `axis:3:up`, `pad:3:96`), so device disconnect / background /
// rebinding releases precisely the ids that were pressed. Format:
// `<kind>:<deviceId>:<detail>`.
export interface NativeSourceTracker {
  track: (source: string) => string;
  /** Remove and return every tracked id belonging to deviceId. */
  takeDevice: (deviceId: number) => string[];
  /** Remove and return every tracked id. */
  takeAll: () => string[];
  size: () => number;
}

export function createNativeSourceTracker(): NativeSourceTracker {
  const sources = new Set<string>();
  return {
    track: (source) => { sources.add(source); return source; },
    takeDevice: (deviceId) => {
      const taken = [...sources].filter((source) => source.split(':')[1] === String(deviceId));
      taken.forEach((source) => sources.delete(source));
      return taken;
    },
    takeAll: () => { const taken = [...sources]; sources.clear(); return taken; },
    size: () => sources.size,
  };
}
