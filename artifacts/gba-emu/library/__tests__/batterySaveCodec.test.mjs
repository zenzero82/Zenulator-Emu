import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeBatteryFile,
  encodeBatteryFile,
  validateBatterySave,
} from '../batterySaveCodec.mjs';

const INTERNAL_SAVE_BYTES = 0x20000;
const EEPROM_BYTES = 0x2000;

function sum(bytes) {
  let result = 0;
  for (const byte of bytes) result = (result + byte) >>> 0;
  return result;
}

function raw(size, seed = 0) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 17 + seed) & 0xff;
  return bytes;
}

test('decodeBatteryFile identifies and normalizes every standard raw save length', () => {
  const cases = [
    [0x200, 'eeprom', EEPROM_BYTES],
    [0x2000, 'eeprom', EEPROM_BYTES],
    [0x8000, 'sram', INTERNAL_SAVE_BYTES],
    [0x10000, 'flash64', INTERNAL_SAVE_BYTES],
    [0x20000, 'flash128', INTERNAL_SAVE_BYTES],
  ];

  for (const [size, saveType, internalLength] of cases) {
    const input = raw(size, size >>> 8);
    const envelope = JSON.parse(decodeBatteryFile(input));
    assert.equal(envelope.v, 1);
    assert.equal(envelope.saveType, saveType);
    assert.equal(envelope.len, internalLength);
    assert.equal(envelope.checksum, sum(input));
    assert.equal(encodeBatteryFile(JSON.stringify(envelope)).length, saveType === 'eeprom' ? 0x2000 : size === 0x8000 ? 0x8000 : size);
  }
});

test('encodeBatteryFile trims internal buffers to the portable cartridge size', () => {
  for (const [saveType, expectedLength] of [
    ['sram', 0x8000],
    ['flash64', 0x10000],
    ['flash128', 0x20000],
    ['eeprom', 0x2000],
  ]) {
    const internal = raw(saveType === 'eeprom' ? EEPROM_BYTES : INTERNAL_SAVE_BYTES, 0x5a);
    const envelope = JSON.parse(decodeBatteryFile(internal));
    envelope.saveType = saveType;
    const normalized = validateBatterySave(JSON.stringify(envelope));
    const portable = encodeBatteryFile(normalized);
    assert.equal(portable.length, expectedLength);
    assert.deepEqual(portable, internal.slice(0, expectedLength));
  }
});

test('JSON internal .sav envelopes import unchanged after normalization', () => {
  const input = raw(INTERNAL_SAVE_BYTES, 0x22);
  const envelope = decodeBatteryFile(input);
  assert.equal(validateBatterySave(envelope), envelope);
  assert.equal(decodeBatteryFile(new TextEncoder().encode(envelope)), envelope);
});

test('validation rejects malformed, corrupted, and incorrectly sized envelopes', () => {
  const envelope = JSON.parse(decodeBatteryFile(raw(INTERNAL_SAVE_BYTES)));

  assert.throws(() => validateBatterySave('not json'), /JSON parse failed/);
  assert.throws(() => validateBatterySave(JSON.stringify({ ...envelope, v: 2 })), /version/);
  assert.throws(() => validateBatterySave(JSON.stringify({ ...envelope, saveType: 'unknown' })), /save type/);
  assert.throws(() => validateBatterySave(JSON.stringify({ ...envelope, len: 1 })), /must contain/);
  assert.throws(() => validateBatterySave(JSON.stringify({ ...envelope, data: '%%%=' })), /base64/);
  assert.throws(() => validateBatterySave(JSON.stringify({ ...envelope, checksum: (envelope.checksum + 1) >>> 0 })), /checksum/);
  assert.throws(() => validateBatterySave(JSON.stringify({ ...envelope, extra: true })), /exactly/);
});

test('raw imports reject unsupported lengths and oversized files', () => {
  assert.throws(() => decodeBatteryFile(new Uint8Array(1)), /unsupported raw save length/);
  assert.throws(() => decodeBatteryFile(new Uint8Array(0x40001)), /256KB/);
});