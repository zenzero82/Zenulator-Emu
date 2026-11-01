import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

export { ImpactFeedbackStyle, NotificationFeedbackType } from 'expo-haptics';

const STORAGE_KEY = '@gba_haptic_feedback_enabled';

type HapticState = {
  enabled: boolean;
  ready: boolean;
  saving: boolean;
  error: string | null;
};

let state: HapticState = { enabled: true, ready: false, saving: false, error: null };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let saveQueue: Promise<void> = Promise.resolve();
let pendingSaves = 0;

function update(next: Partial<HapticState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot() {
  return state;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function hydrate(): Promise<void> {
  if (state.ready) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    try {
      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      // Missing storage preserves the previous always-on behavior. An invalid
      // value must not silently turn vibration on.
      if (saved !== null && saved !== 'true' && saved !== 'false') {
        throw new Error('Invalid saved haptic feedback preference');
      }
      update({ enabled: saved !== 'false', ready: true, error: null });
    } catch (error) {
      update({ ready: false, error: `Could not load haptic preference: ${message(error)}` });
      throw error;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function setEnabled(enabled: boolean): Promise<void> {
  pendingSaves++;
  update({ saving: true, error: null });
  const save = saveQueue.catch(() => {}).then(async () => {
    try {
      await hydrate();
      await AsyncStorage.setItem(STORAGE_KEY, String(enabled));
      update({ enabled, error: null });
    } catch (error) {
      update({ error: `Could not save haptic preference: ${message(error)}` });
      throw error;
    } finally {
      pendingSaves--;
      update({ saving: pendingSaves > 0 });
    }
  });
  saveQueue = save;
  return save;
}

export function useHapticFeedback() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    // A read failure is displayed in settings; later calls can retry hydration.
    void hydrate().catch(() => {});
  }, []);
  return { ...snapshot, setEnabled, retry: hydrate };
}

async function feedback(run: () => Promise<void>) {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  try {
    await hydrate();
    if (state.ready && state.enabled && !state.saving) await run();
  } catch {
    // Storage errors remain visible through the hook; unsupported or rejected
    // native haptic calls should never interrupt a gameplay input.
  }
}

export async function impactAsync(style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Medium): Promise<void> {
  await feedback(() => Haptics.impactAsync(style));
}

export async function notificationAsync(type: Haptics.NotificationFeedbackType = Haptics.NotificationFeedbackType.Success): Promise<void> {
  await feedback(() => Haptics.notificationAsync(type));
}