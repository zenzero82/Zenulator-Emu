import React, {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import {
  AppState, Dimensions, Platform, View, type GestureResponderEvent, type ViewProps,
} from 'react-native';
import {
  captureMouse, changedTouchIds, containsPoint, controlTouchPoints, mousePoint,
  rootTouchPoints, type ControlBounds, type ControlPoint,
} from './gameplayTouchEvents';

export type GameplayControlName = 'a' | 'b' | 'l' | 'r' | 'start' | 'select' | 'dpad' | 'speed';

interface TouchController {
  releaseAll: () => void;
  releaseTouches: (ids: string[]) => void;
  update: (points: ControlPoint[], starting: boolean) => void;
  measure: () => void;
  getBounds: () => ControlBounds | null;
  hitSlop: number;
}

interface ControlsContext {
  enabled: boolean;
  register: (name: GameplayControlName, controller: TouchController) => () => void;
  refreshLayout: () => void;
}

const GameplayControlsContext = createContext<ControlsContext | null>(null);

export function GameplayControlsProvider({
  enabled, children,
}: { enabled: boolean; children: ReactNode }) {
  const [appActive, setAppActive] = useState(
    AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
  );
  const registrations = useRef(new Map<GameplayControlName, TouchController>());
  const owners = useRef(new Map<string, TouchController>());
  const enabledRef = useRef(enabled && appActive);
  enabledRef.current = enabled && appActive;
  const releaseAll = useCallback(() => {
    owners.current.clear();
    registrations.current.forEach((control) => control.releaseAll());
  }, []);
  const refreshLayout = useCallback(() => {
    if (Platform.OS !== 'android') return;
    // A parent can move a control without changing that control's local layout.
    // Remeasure the whole deck, releasing old contacts instead of reassigning
    // them to a newly positioned control. Never measure or await on touch-down.
    releaseAll();
    registrations.current.forEach((control) => control.measure());
  }, [releaseAll]);
  const register = useCallback((name: GameplayControlName, control: TouchController) => {
    registrations.current.set(name, control);
    if (Platform.OS === 'android') control.measure();
    return () => {
      owners.current.forEach((owner, id) => {
        if (owner === control) owners.current.delete(id);
      });
      if (registrations.current.get(name) === control) registrations.current.delete(name);
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setAppActive(state === 'active');
      if (state !== 'active') {
        enabledRef.current = false;
        releaseAll();
      }
    });
    return () => { subscription.remove(); releaseAll(); };
  }, [releaseAll]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = Dimensions.addEventListener('change', refreshLayout);
    return () => subscription.remove();
  }, [refreshLayout]);

  const controlsEnabled = enabled && appActive;
  useEffect(() => {
    if (!controlsEnabled) releaseAll();
  }, [controlsEnabled, releaseAll]);

  const finishTouches = useCallback((event: GestureResponderEvent) => {
    const ids = changedTouchIds(event);
    if (Platform.OS === 'android') {
      const finished = new Map<TouchController, string[]>();
      ids.forEach((id) => {
        const owner = owners.current.get(id);
        owners.current.delete(id);
        if (!owner) return;
        const contacts = finished.get(owner) ?? [];
        contacts.push(id);
        finished.set(owner, contacts);
      });
      finished.forEach((contacts, control) => control.releaseTouches(contacts));
      return;
    }
    // The original control normally handles this first. Reconcile every owner
    // at the root as well, including contacts from a batched end/cancel event.
    registrations.current.forEach((control) => control.releaseTouches(ids));
  }, []);
  const routeTouches = useCallback((event: GestureResponderEvent, starting: boolean) => {
    if (!enabledRef.current) return;
    const updates = new Map<TouchController, ControlPoint[]>();
    for (const point of rootTouchPoints(event)) {
      let owner = owners.current.get(point.id);
      if (starting && !owner) {
        // Prefer the visible bounds to overlapping hitSlop regions.
        const controls = [...registrations.current.values()];
        owner = controls.find((control) => {
          const rect = control.getBounds();
          return rect && containsPoint(rect, point);
        }) ?? controls.find((control) => {
          const rect = control.getBounds();
          return rect && containsPoint(rect, point, control.hitSlop);
        });
        if (owner) owners.current.set(point.id, owner);
      }
      // Moves never acquire an owner. A finger starting on the screen/blank
      // deck stays unowned, even if it later moves across a gameplay control.
      const rect = owner?.getBounds();
      if (!owner || !rect) continue;
      const local = { id: point.id, x: point.x - rect.x, y: point.y - rect.y };
      const contacts = updates.get(owner) ?? [];
      contacts.push(local);
      updates.set(owner, contacts);
    }
    updates.forEach((contacts, control) => control.update(contacts, starting));
  }, []);
  const value = useMemo(
    () => ({ enabled: controlsEnabled, register, refreshLayout }),
    [controlsEnabled, register, refreshLayout],
  );
  return (
    <GameplayControlsContext.Provider value={value}>
      <View
        style={{ flex: 1, ...(Platform.OS === 'web' ? { touchAction: 'none', userSelect: 'none' } : {}) }}
        collapsable={false}
        {...(Platform.OS === 'android' ? {
          onLayout: refreshLayout,
          onTouchStart: (event: GestureResponderEvent) => routeTouches(event, true),
          onTouchMove: (event: GestureResponderEvent) => routeTouches(event, false),
        } : {})}
        onTouchEnd={finishTouches}
        onTouchCancel={Platform.OS === 'android' ? releaseAll : finishTouches}
      >
        {children}
      </View>
    </GameplayControlsContext.Provider>
  );
}

interface ControlOptions {
  onPress?: () => void;
  hitSlop?: number;
  // D-pad maps contacts to directions rather than emitting a "dpad" key.
  onPointsChange?: (points: ControlPoint[]) => void;
}

export function useGameplayControl(
  name: GameplayControlName,
  onKeyChange: (key: string, pressed: boolean) => void,
  options: ControlOptions = {},
) {
  const context = useContext(GameplayControlsContext);
  if (!context) throw new Error('Gameplay controls require GameplayControlsProvider');
  const latest = useRef({ enabled: context.enabled, onKeyChange, options });
  latest.current = { enabled: context.enabled, onKeyChange, options };
  const points = useRef(new Map<string, ControlPoint>());
  const bounds = useRef<{ width: number; height: number } | null>(null);
  const touchRef = useRef<View | null>(null);
  const pageBounds = useRef<ControlBounds | null>(null);
  const measureRevision = useRef(0);
  const pressedRef = useRef(false);
  const [pressed, setPressed] = useState(false);

  const notify = useCallback(() => {
    const { options: currentOptions, onKeyChange: emit } = latest.current;
    const contacts = [...points.current.values()];
    if (currentOptions.onPointsChange) {
      currentOptions.onPointsChange(contacts);
      return;
    }
    // Match ordinary button behavior: drag off to release, return to re-press.
    // Touch ownership remains until lift, so two fingers on one button work too.
    const next = contacts.some(({ x, y }) => !bounds.current || (
      x >= 0 && y >= 0 && x <= bounds.current.width && y <= bounds.current.height
    ));
    if (next === pressedRef.current) return;
    pressedRef.current = next;
    setPressed(next);
    emit(name, next);
    if (next) currentOptions.onPress?.();
  }, [name]);

  const releaseTouches = useCallback((ids: string[]) => {
    let changed = false;
    ids.forEach((id) => { if (points.current.delete(id)) changed = true; });
    if (changed) notify();
  }, [notify]);
  const releaseAll = useCallback(() => {
    if (!points.current.size) return;
    points.current.clear();
    notify();
  }, [notify]);

  const measure = useCallback(() => {
    pageBounds.current = null;
    const revision = ++measureRevision.current;
    const view = touchRef.current;
    // measure's last coordinates are root/page coordinates; window coordinates
    // include native chrome/status-bar offsets and do not match touch.pageY.
    view?.measure((_x, _y, width, height, pageX, pageY) => {
      if (revision !== measureRevision.current || touchRef.current !== view) return;
      if (width <= 0 || height <= 0) return;
      bounds.current = { width, height };
      pageBounds.current = { x: pageX, y: pageY, width, height };
    });
  }, []);

  useEffect(() => {
    if (!context.enabled) releaseAll();
  }, [context.enabled, releaseAll]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    // Losing the browser window can omit mouseup and touchend.
    window.addEventListener('blur', releaseAll);
    return () => window.removeEventListener('blur', releaseAll);
  }, [releaseAll]);

  const update = useCallback((contacts: ControlPoint[], starting: boolean) => {
    if (!latest.current.enabled) return;
    let changed = false;
    contacts.forEach((point) => {
      if (starting || points.current.has(point.id)) {
        points.current.set(point.id, point);
        changed = true;
      }
    });
    if (changed) notify();
  }, [notify]);

  useLayoutEffect(() => {
    const unregister = context.register(name, {
      releaseAll, releaseTouches, update, measure,
      getBounds: () => pageBounds.current,
      hitSlop: options.hitSlop ?? 0,
    });
    return () => {
      ++measureRevision.current;
      pageBounds.current = null;
      releaseAll();
      unregister();
    };
  }, [context.register, name, releaseAll, releaseTouches, update, measure, options.hitSlop]);

  const touchProps = useMemo<ViewProps>(() => ({
    // Raw touch events, not a drag recognizer or a single-owner JS responder.
    // Every finger gets its own down/up lifecycle, including stationary taps.
    // Android dispatches only at the provider: the first target must NOT accept
    // every pointerDown as its own. Keep iOS and DOM delivery unchanged.
    ...(Platform.OS !== 'android' ? {
      onTouchStart: (event: GestureResponderEvent) => update(controlTouchPoints(event, true), true),
      onTouchMove: (event: GestureResponderEvent) => update(controlTouchPoints(event, false), false),
      onTouchEnd: (event: GestureResponderEvent) => releaseTouches(changedTouchIds(event)),
      onTouchCancel: (event: GestureResponderEvent) => releaseTouches(changedTouchIds(event)),
    } : {}),
    onLayout: (event) => {
      bounds.current = event.nativeEvent.layout;
      if (Platform.OS === 'android') {
        measure();
        context.refreshLayout();
      }
    },
    ...(Platform.OS === 'web' ? {
      // Mouse only: touch pointers use the raw touch handlers above exactly once.
      onPointerDown: (event) => {
        if (event.nativeEvent.pointerType !== 'mouse' || event.nativeEvent.button !== 0) return;
        captureMouse(event);
        update([mousePoint(event)], true);
      },
      onPointerMove: (event) => {
        if (event.nativeEvent.pointerType === 'mouse') update([mousePoint(event)], false);
      },
      onPointerUp: (event) => releaseTouches([`mouse:${event.nativeEvent.pointerId}`]),
      onPointerCancel: (event) => releaseTouches([`mouse:${event.nativeEvent.pointerId}`]),
    } satisfies ViewProps : {}),
  }), [releaseTouches, update, measure, context.refreshLayout]);

  return { touchProps, touchRef, pressed };
}