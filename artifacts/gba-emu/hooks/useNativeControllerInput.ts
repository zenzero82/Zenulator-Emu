import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  addNativeDeviceListener, addNativeInputListener, getNativeControllers, isNativeInputAvailable,
  setNativeInputCapture,
} from '@/modules/zenulator-input';
import {
  axesToDirections, createNativeSourceTracker, routeNativeButton,
  type GamepadBindings, type InputAction, type KeyboardBindings,
} from '@/library/inputMapping';

interface Options {
  enabled: boolean;
  keyboard: KeyboardBindings;
  gamepad: GamepadBindings;
  /** source is an exact per-input id so releases stay scoped. */
  onAction: (action: InputAction, pressed: boolean, source: string) => void;
  /** Release exactly this emitted source id. */
  onReleaseSource: (source: string) => void;
}

/**
 * Android hardware keyboard + controller routing through the local
 * ZenulatorInput module. No-op where the module is absent (iOS, web, Expo
 * Go, or an Android binary built before the module existed). Capture is only
 * enabled while gameplay input is enabled (menus/modals disable it).
 */
export function useNativeControllerInput({ enabled, keyboard, gamepad, onAction, onReleaseSource }: Options) {
  const latest = useRef({ keyboard, gamepad, onAction, onReleaseSource });
  latest.current = { keyboard, gamepad, onAction, onReleaseSource };
  const [controllers, setControllers] = useState<Array<{ deviceId: number; name: string }>>([]);
  const trackerRef = useRef(createNativeSourceTracker());
  const axisStateRef = useRef(new Map<number, Record<string, boolean>>());

  const releaseAll = () => {
    trackerRef.current.takeAll().forEach((source) => latest.current.onReleaseSource(source));
    axisStateRef.current.clear();
  };

  // A binding change must not leave an input latched under its old action.
  useEffect(() => {
    releaseAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboard, gamepad]);

  useEffect(() => {
    if (!isNativeInputAvailable || !enabled) return;
    const tracker = trackerRef.current;
    const axisState = axisStateRef.current;
    setNativeInputCapture(true);
    setControllers(getNativeControllers());

    const emit = (action: InputAction, pressed: boolean, source: string) => {
      latest.current.onAction(action, pressed, tracker.track(source));
    };

    const inputSub = addNativeInputListener((event) => {
      const { keyboard: kb, gamepad: pad } = latest.current;
      if (event.kind === 'button') {
        const action = routeNativeButton(event, kb, pad);
        if (!action) return;
        emit(action, event.pressed, `${event.gamepad ? 'pad' : 'kb'}:${event.deviceId}:${event.keyCode}`);
        return;
      }
      // Axis: stick/hat drive the D-pad; analog triggers act as buttons 6/7.
      const prev = axisState.get(event.deviceId) ?? {};
      const next: Record<string, boolean> = { ...axesToDirections(event.x, event.y) };
      (['up', 'down', 'left', 'right'] as const).forEach((dir) => {
        if (!!prev[dir] !== next[dir]) emit(dir, next[dir], `axis:${event.deviceId}:${dir}`);
      });
      const triggers: Array<[string, boolean, number]> = [['lt', event.leftTrigger, 6], ['rt', event.rightTrigger, 7]];
      triggers.forEach(([id, pressed, button]) => {
        next[id] = pressed;
        if (!!prev[id] === pressed) return;
        const action = (Object.keys(pad) as InputAction[]).find((name) => pad[name].includes(button));
        if (action) emit(action, pressed, `axis:${event.deviceId}:${id}`);
      });
      axisState.set(event.deviceId, next);
    });

    const deviceSub = addNativeDeviceListener((event) => {
      if (!event.connected) {
        tracker.takeDevice(event.deviceId).forEach((source) => latest.current.onReleaseSource(source));
        axisState.delete(event.deviceId);
      }
      setControllers(getNativeControllers());
    });

    const appSub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') releaseAll();
    });

    return () => {
      setNativeInputCapture(false);
      inputSub.remove();
      deviceSub.remove();
      appSub.remove();
      releaseAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { available: isNativeInputAvailable, controllers };
}
