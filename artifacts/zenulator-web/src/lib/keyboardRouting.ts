// Web keyboard/controller routing. Mapping semantics (conflicts, reserved
// keys, validation) are shared with Zenulator Mobile via library/inputMapping.
import {
  DEFAULT_GAMEPAD_BINDINGS, DEFAULT_KEYBOARD_BINDINGS, GBA_KEYS, keyboardLookup, parseGamepadBindings,
  parseKeyboardBindings, routeKeyboardCode, type GamepadBindings, type InputAction, type KeyboardBindings,
} from '../../../gba-emu/library/inputMapping';

export {
  ACTION_LABELS, assignGamepadBinding, assignKeyboardBinding, BINDABLE_GAMEPAD_BUTTONS, clearBinding,
  coreInputMapMessage, describeGamepadButton, describeKeyCode, INPUT_ACTIONS,
} from '../../../gba-emu/library/inputMapping';
export type { GamepadBindings, InputAction, KeyboardBindings };

/** Default code -> GBA key table (fast-forward excluded), kept for the core bridge. */
export const KEY_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(keyboardLookup(DEFAULT_KEYBOARD_BINDINGS)).filter(([, action]) => action !== 'speed'),
);

export const FAST_FORWARD_CODE = 'KeyF';
export const INPUT_STORAGE_KEY = 'zenulator-web:input-bindings:v1';

export interface KeyboardModifierState {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/**
 * Browser keyboard shortcuts and text-entry shortcuts must stay browser-owned.
 * Ctrl/Alt/Meta combinations and reserved keys are never game input.
 */
export function canRouteGameKeyboardEvent(
  code: string,
  modifiers: KeyboardModifierState,
  bindings: KeyboardBindings = DEFAULT_KEYBOARD_BINDINGS,
): boolean {
  return Boolean(routeKeyboardCode(bindings, code, modifiers));
}

export function gameKeyForCode(code: string, bindings: KeyboardBindings = DEFAULT_KEYBOARD_BINDINGS): string | undefined {
  const action = routeKeyboardCode(bindings, code);
  return action && action !== 'speed' ? action : undefined;
}

export function actionForCode(code: string, modifiers: KeyboardModifierState, bindings: KeyboardBindings): InputAction | undefined {
  return routeKeyboardCode(bindings, code, modifiers);
}

export function isGameKey(value: unknown): value is string {
  return typeof value === 'string' && (GBA_KEYS as readonly string[]).includes(value);
}

export interface StoredBindings { keyboard: KeyboardBindings; gamepad: GamepadBindings }

export function loadBindings(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): StoredBindings {
  try {
    const raw = storage?.getItem(INPUT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return { keyboard: parseKeyboardBindings(parsed.keyboard), gamepad: parseGamepadBindings(parsed.gamepad) };
  } catch {
    return { keyboard: parseKeyboardBindings(null), gamepad: parseGamepadBindings(null) };
  }
}

export function saveBindings(bindings: StoredBindings, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  storage?.setItem(INPUT_STORAGE_KEY, JSON.stringify(bindings));
}

export function defaultBindings(): StoredBindings {
  return { keyboard: parseKeyboardBindings(DEFAULT_KEYBOARD_BINDINGS), gamepad: parseGamepadBindings(DEFAULT_GAMEPAD_BINDINGS) };
}
