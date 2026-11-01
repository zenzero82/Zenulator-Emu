import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';
import {
  defaultPreferences, parsePreferences, PREFERENCES_STORAGE_KEY, serializePreferences,
  type GameplayPreferences,
} from '@/library/gameplayPreferences';

type Store = { prefs: GameplayPreferences; ready: boolean; error: string | null };

let store: Store = { prefs: defaultPreferences(), ready: false, error: null };
const listeners = new Set<() => void>();
let loading: Promise<GameplayPreferences> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function emit(next: Partial<Store>) {
  store = { ...store, ...next };
  listeners.forEach((listener) => listener());
}

/** Load once per process; later callers share the same hydrated snapshot. */
export function loadGameplayPreferences(): Promise<GameplayPreferences> {
  if (store.ready) return Promise.resolve(store.prefs);
  if (loading) return loading;
  loading = AsyncStorage.getItem(PREFERENCES_STORAGE_KEY)
    .then((json) => {
      const prefs = parsePreferences(json);
      emit({ prefs, ready: true, error: null });
      return prefs;
    })
    .catch((error: unknown) => {
      // Defaults are safe (landscape off, stock layout) — still playable.
      emit({ ready: true, error: `Could not load gameplay settings: ${String(error)}` });
      return store.prefs;
    })
    .finally(() => { loading = null; });
  return loading;
}

export function updateGameplayPreferences(
  patch: Partial<GameplayPreferences> | ((prev: GameplayPreferences) => Partial<GameplayPreferences>),
): Promise<void> {
  const resolved = typeof patch === 'function' ? patch(store.prefs) : patch;
  const prefs = { ...store.prefs, ...resolved };
  emit({ prefs, error: null });
  // Serialize writes so a slow earlier write can never land after a newer one.
  writeQueue = writeQueue.catch(() => {}).then(() => AsyncStorage.setItem(PREFERENCES_STORAGE_KEY, serializePreferences(prefs)))
    .catch((error: unknown) => { emit({ error: `Could not save gameplay settings: ${String(error)}` }); });
  return writeQueue;
}

export function getGameplayPreferences(): GameplayPreferences {
  return store.prefs;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useGameplayPreferences() {
  const snapshot = useSyncExternalStore(subscribe, () => store, () => store);
  useEffect(() => { void loadGameplayPreferences(); }, []);
  return { ...snapshot, update: updateGameplayPreferences };
}
