import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

export type NativeInputEvent =
  | { kind: 'button'; keyCode: number; pressed: boolean; gamepad: boolean; deviceId: number }
  | { kind: 'axis'; deviceId: number; x: number; y: number; leftTrigger: boolean; rightTrigger: boolean };

export interface NativeDeviceEvent { deviceId: number; connected: boolean; name: string }

interface Subscription { remove: () => void }

interface ZenulatorInputNative {
  isSupported: () => boolean;
  setCaptureEnabled: (enabled: boolean) => void;
  getControllers: () => Array<{ deviceId: number; name: string }>;
  addListener: (event: string, listener: (payload: never) => void) => Subscription;
}

// Present only in a native Android build that includes this local module
// (a dev-client / release rebuild is required after adding it). Expo Go, iOS
// and web return null and callers fall back to WebView-side input handling.
const native: ZenulatorInputNative | null = Platform.OS === 'android'
  ? requireOptionalNativeModule<ZenulatorInputNative>('ZenulatorInput')
  : null;

export const isNativeInputAvailable = native !== null;

export function setNativeInputCapture(enabled: boolean): void {
  try { native?.setCaptureEnabled(enabled); } catch { /* module missing in this binary */ }
}

export function getNativeControllers(): Array<{ deviceId: number; name: string }> {
  try { return native?.getControllers() ?? []; } catch { return []; }
}

export function addNativeInputListener(listener: (event: NativeInputEvent) => void): Subscription {
  return native ? native.addListener('onInput', listener as (payload: never) => void) : { remove: () => {} };
}

export function addNativeDeviceListener(listener: (event: NativeDeviceEvent) => void): Subscription {
  return native ? native.addListener('onDeviceChange', listener as (payload: never) => void) : { remove: () => {} };
}
