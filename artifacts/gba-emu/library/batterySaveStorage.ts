import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { validateBatterySave } from './batterySaveCodec.mjs';

/**
 * Battery saves are deliberately kept small.  This limit applies to the
 * persisted JSON envelope, rather than only to the cartridge payload.
 */
export const MAX_BATTERY_SAVE_BYTES = 256 * 1024;

const SAVE_PREFIX = '@gba_battery_';
const RECOVERY_SUFFIX = '.recovery';
const PRE_IMPORT_SUFFIX = '.preimport';
const TEMP_SUFFIX = '.tmp';

const queues = new Map<string, Promise<unknown>>();
// ROM ids are generated once for a library entry and are not reused. Keep a
// process-local tombstone so an emulator that is still unwinding after
// removeRom cannot recreate a save that was just deleted.
const deletedIds = new Set<string>();

function runSerial<T>(romId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(romId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(romId, next);
  void next.then(() => {
    if (queues.get(romId) === next) queues.delete(romId);
  }, () => {
    if (queues.get(romId) === next) queues.delete(romId);
  });
  return next;
}

function assertRomId(romId: string): string {
  if (!romId || romId.includes('/') || romId.includes('\\') || romId.includes('..')) {
    throw new Error('Invalid ROM id for battery save storage.');
  }
  return romId;
}

function normalizeSave(json: string): string {
  const normalized = validateBatterySave(json);
  if (new TextEncoder().encode(normalized).byteLength > MAX_BATTERY_SAVE_BYTES) {
    throw new Error('Battery save exceeds the 256KB limit.');
  }
  return normalized;
}

function nativePath(romId: string, suffix = ''): string {
  const root = FileSystem.documentDirectory;
  if (!root) throw new Error('Native document storage is unavailable.');
  return `${root}gba_saves/${romId}.sav${suffix}`;
}

function storageKey(romId: string, suffix = ''): string {
  return `${SAVE_PREFIX}${romId}${suffix}`;
}

type RawValue = { exists: boolean; value: string | null };

async function readNative(path: string): Promise<RawValue> {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return { exists: false, value: null };
  const size = (info as { size?: number }).size;
  if (!Number.isFinite(size) || (size ?? 0) > MAX_BATTERY_SAVE_BYTES) {
    throw new Error('Battery save file exceeds the 256KB limit.');
  }
  return { exists: true, value: await FileSystem.readAsStringAsync(path) };
}

async function readRaw(romId: string, suffix = ''): Promise<RawValue> {
  if (Platform.OS === 'web') {
    const value = await AsyncStorage.getItem(storageKey(romId, suffix));
    return { exists: value !== null, value };
  }
  return readNative(nativePath(romId, suffix));
}

async function writeNativeAtomic(path: string, value: string): Promise<void> {
  const temp = `${path}${TEMP_SUFFIX}`;
  await FileSystem.makeDirectoryAsync(`${FileSystem.documentDirectory}gba_saves/`, {
    intermediates: true,
  });
  try {
    await FileSystem.writeAsStringAsync(temp, value);
    await FileSystem.deleteAsync(path, { idempotent: true });
    await FileSystem.moveAsync({ from: temp, to: path });
  } catch (error) {
    await FileSystem.deleteAsync(temp, { idempotent: true }).catch(() => {});
    throw error;
  }
}

async function writeRawAtomic(romId: string, value: string, suffix = ''): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(storageKey(romId, suffix), value);
  } else {
    await writeNativeAtomic(nativePath(romId, suffix), value);
  }
}

async function removeRaw(romId: string, suffix = ''): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(storageKey(romId, suffix));
  } else {
    await FileSystem.deleteAsync(nativePath(romId, suffix), { idempotent: true });
  }
}

function validRaw(raw: RawValue): string | null {
  if (!raw.exists || raw.value === null) return null;
  return normalizeSave(raw.value);
}

/**
 * Replace the current save. A valid previous save is first committed to the
 * recovery slot. That slot remains in place until the current replacement
 * has completed, covering the delete/move window on native filesystems.
 */
async function replaceCurrent(romId: string, normalized: string): Promise<void> {
  const current = await readRaw(romId);
  let previous: string | null = null;
  try {
    previous = validRaw(current);
  } catch {
    // A corrupt current file must not become the recovery copy. An existing
    // valid recovery file can still protect the replacement below.
  }

  let recoveryCommitted = false;
  if (previous !== null) {
    await writeRawAtomic(romId, previous, RECOVERY_SUFFIX);
    recoveryCommitted = true;
  }

  try {
    await writeRawAtomic(romId, normalized);
    await removeRaw(romId, RECOVERY_SUFFIX);
  } catch (error) {
    if (recoveryCommitted) {
      try {
        await writeRawAtomic(romId, previous!, RECOVERY_SUFFIX);
        await writeRawAtomic(romId, previous!);
      } catch (restoreError) {
        throw new Error(
          `Battery save write failed and recovery failed: ${String(error)}; ${String(restoreError)}`,
        );
      }
    }
    throw error;
  }
}

async function recoverCurrent(romId: string, recovery: string): Promise<string> {
  // Do not call replaceCurrent: the recovery copy is the only valid source
  // when the current file is missing/corrupt, and it must be used as-is.
  await writeRawAtomic(romId, recovery);
  await removeRaw(romId, RECOVERY_SUFFIX);
  return recovery;
}

async function readLocked(romId: string): Promise<string | null> {
  const current = await readRaw(romId);
  if (current.exists) {
    try {
      return validRaw(current);
    } catch (currentError) {
      const recovery = await readRaw(romId, RECOVERY_SUFFIX);
      try {
        const normalized = validRaw(recovery);
        if (normalized !== null) return recoverCurrent(romId, normalized);
      } catch (recoveryError) {
        throw new Error(
          `Battery save is invalid and recovery is invalid: ${String(currentError)}; ${String(recoveryError)}`,
        );
      }
      throw new Error(`Battery save is invalid and no valid recovery exists: ${String(currentError)}`);
    }
  }

  const recovery = await readRaw(romId, RECOVERY_SUFFIX);
  if (!recovery.exists) return null;
  try {
    const normalized = validRaw(recovery);
    if (normalized !== null) return recoverCurrent(romId, normalized);
  } catch (error) {
    throw new Error(`Battery save is missing and recovery is invalid: ${String(error)}`);
  }
  throw new Error('Battery save is missing and no valid recovery exists.');
}

export function readBatterySave(romId: string): Promise<string | null> {
  const id = assertRomId(romId);
  if (deletedIds.has(id)) return Promise.resolve(null);
  return runSerial(id, () => readLocked(id));
}

export function persistBatterySave(romId: string, json: string): Promise<void> {
  const id = assertRomId(romId);
  if (deletedIds.has(id)) {
    return Promise.reject(new Error('Battery save belongs to a deleted ROM.'));
  }
  const normalized = normalizeSave(json);
  return runSerial(id, () => replaceCurrent(id, normalized));
}

export function importBatterySave(romId: string, json: string): Promise<void> {
  const id = assertRomId(romId);
  if (deletedIds.has(id)) {
    return Promise.reject(new Error('Battery save belongs to a deleted ROM.'));
  }
  const normalized = normalizeSave(json);
  return runSerial(id, async () => {
    // readLocked also repairs a current file left behind by an interrupted
    // move. This makes the pre-import copy a known-good save.
    const current = await readLocked(id);
    if (current !== null) {
      // A repeated import intentionally replaces the old pre-import backup
      // with the save that is visible immediately before this import.
      await writeRawAtomic(id, current, PRE_IMPORT_SUFFIX);
    }
    await replaceCurrent(id, normalized);
  });
}

export function restorePreImportSave(romId: string): Promise<boolean> {
  const id = assertRomId(romId);
  if (deletedIds.has(id)) {
    return Promise.reject(new Error('Battery save belongs to a deleted ROM.'));
  }
  return runSerial(id, async () => {
    const backup = await readRaw(id, PRE_IMPORT_SUFFIX);
    if (!backup.exists) return false;
    let normalized: string;
    try {
      normalized = validRaw(backup) ?? (() => {
        throw new Error('pre-import backup is empty');
      })();
    } catch (error) {
      throw new Error(`Pre-import battery save is invalid: ${String(error)}`);
    }
    await replaceCurrent(id, normalized);
    await removeRaw(id, PRE_IMPORT_SUFFIX);
    return true;
  });
}

export function hasPreImportSave(romId: string): Promise<boolean> {
  const id = assertRomId(romId);
  if (deletedIds.has(id)) return Promise.resolve(false);
  return runSerial(id, async () => {
    const backup = await readRaw(id, PRE_IMPORT_SUFFIX);
    if (!backup.exists) return false;
    try {
      return validRaw(backup) !== null;
    } catch {
      return false;
    }
  });
}

export function resolveBatterySaveUri(romId: string): Promise<string | undefined> {
  const id = assertRomId(romId);
  if (deletedIds.has(id)) return Promise.resolve(undefined);
  return runSerial(id, async () => {
    if (Platform.OS === 'web') return undefined;
    const save = await readLocked(id);
    if (save === null) return undefined;
    const path = nativePath(id);
    const info = await FileSystem.getInfoAsync(path);
    return info.exists ? path : undefined;
  });
}

/**
 * Remove all battery-save generations for a ROM. The library uses this when
 * deleting the ROM entry; it is intentionally queued with reads and writes
 * so a late core flush cannot recreate one of the backup files.
 */
export function deleteBatterySave(romId: string): Promise<void> {
  const id = assertRomId(romId);
  deletedIds.add(id);
  return runSerial(id, async () => {
    await Promise.all([
      removeRaw(id),
      removeRaw(id, RECOVERY_SUFFIX),
      removeRaw(id, PRE_IMPORT_SUFFIX),
      removeRaw(id, TEMP_SUFFIX),
      removeRaw(id, `${RECOVERY_SUFFIX}${TEMP_SUFFIX}`),
      removeRaw(id, `${PRE_IMPORT_SUFFIX}${TEMP_SUFFIX}`),
    ]);
  });
}