// Validated, persisted gameplay preferences (pure). Storage I/O lives in
// hooks/useGameplayPreferences.ts. ROMs, battery saves and save states are
// NOT stored here and are never touched by preference reads/writes.
import {
  DEFAULT_GAMEPAD_BINDINGS, DEFAULT_KEYBOARD_BINDINGS, parseGamepadBindings, parseKeyboardBindings,
  type GamepadBindings, type KeyboardBindings,
} from './inputMapping';

export const PREFERENCES_STORAGE_KEY = '@zenulator_gameplay_prefs_v1';

// Session-only FF cycle: Normal, FF +1x, FF +2x, FF +3x.
// Factors are actual multiples of normal GBA clock speed.
export const SPEED_OPTIONS = [1, 2, 3, 4] as const;
export type SpeedFactor = (typeof SPEED_OPTIONS)[number];

export const TOUCH_CONTROL_IDS = ['dpad', 'ab', 'l', 'r', 'startSelect'] as const;
export type TouchControlId = (typeof TOUCH_CONTROL_IDS)[number];
export const TOUCH_CONTROL_LABELS: Record<TouchControlId, string> = {
  dpad: 'D-pad', ab: 'A / B', l: 'L shoulder', r: 'R shoulder', startSelect: 'Start / Select',
};

export type LayoutOrientation = 'portrait' | 'landscape';

export interface ControlLayout {
  /** Offset from the control's default slot, in density-independent px. */
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

export type TouchLayout = Record<LayoutOrientation, Record<TouchControlId, ControlLayout>>;

export const LAYOUT_LIMITS = {
  offset: 72,
  scaleMin: 0.7,
  scaleMax: 1.4,
  opacityMin: 0.3,
  opacityMax: 1,
} as const;

export const DEFAULT_CONTROL_LAYOUT: ControlLayout = { x: 0, y: 0, scale: 1, opacity: 1 };

export function defaultTouchLayout(): TouchLayout {
  const one = () => Object.fromEntries(
    TOUCH_CONTROL_IDS.map((id) => [id, { ...DEFAULT_CONTROL_LAYOUT }]),
  ) as Record<TouchControlId, ControlLayout>;
  return { portrait: one(), landscape: one() };
}

export interface GameplayPreferences {
  startInLandscape: boolean;
  touchLayout: TouchLayout;
  keyboard: KeyboardBindings;
  gamepad: GamepadBindings;
}

export function defaultPreferences(): GameplayPreferences {
  return {
    startInLandscape: false,
    touchLayout: defaultTouchLayout(),
    keyboard: parseKeyboardBindings(DEFAULT_KEYBOARD_BINDINGS),
    gamepad: parseGamepadBindings(DEFAULT_GAMEPAD_BINDINGS),
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeSpeed(value: unknown): SpeedFactor {
  return value === 2 || value === 3 || value === 4 ? value : 1;
}

export function nextSpeed(current: SpeedFactor): SpeedFactor {
  return current === 1 ? 2 : current === 2 ? 3 : current === 3 ? 4 : 1;
}

export function speedLabel(speed: SpeedFactor): string {
  return speed === 1 ? 'Normal' : `FF +${speed - 1}×`;
}

export function normalizeControlLayout(raw: unknown): ControlLayout {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<ControlLayout>;
  const { offset, scaleMin, scaleMax, opacityMin, opacityMax } = LAYOUT_LIMITS;
  return {
    x: Math.round(clamp(value.x, -offset, offset, 0)),
    y: Math.round(clamp(value.y, -offset, offset, 0)),
    scale: Math.round(clamp(value.scale, scaleMin, scaleMax, 1) * 100) / 100,
    opacity: Math.round(clamp(value.opacity, opacityMin, opacityMax, 1) * 100) / 100,
  };
}

export function normalizeTouchLayout(raw: unknown): TouchLayout {
  const out = defaultTouchLayout();
  if (!raw || typeof raw !== 'object') return out;
  for (const orientation of ['portrait', 'landscape'] as const) {
    const group = (raw as Record<string, unknown>)[orientation];
    if (!group || typeof group !== 'object') continue;
    for (const id of TOUCH_CONTROL_IDS) {
      out[orientation][id] = normalizeControlLayout((group as Record<string, unknown>)[id]);
    }
  }
  return out;
}

/** Parse stored JSON. Malformed fields fall back individually to defaults. */
export function parsePreferences(json: string | null): GameplayPreferences {
  if (!json) return defaultPreferences();
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return defaultPreferences();
    raw = parsed as Record<string, unknown>;
  } catch {
    return defaultPreferences();
  }
  return {
    startInLandscape: raw.startInLandscape === true,
    touchLayout: normalizeTouchLayout(raw.touchLayout),
    keyboard: parseKeyboardBindings(raw.keyboard),
    gamepad: parseGamepadBindings(raw.gamepad),
  };
}

export function serializePreferences(prefs: GameplayPreferences): string {
  return JSON.stringify({ ...prefs, version: 1 });
}
