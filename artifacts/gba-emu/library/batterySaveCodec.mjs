const MAX_FILE_BYTES = 0x40000;
const INTERNAL_SAVE_BYTES = 0x20000;
const EEPROM_BYTES = 0x2000;

const SAVE_TYPES = new Set(['sram', 'flash64', 'flash128', 'eeprom']);
const INTERNAL_LENGTHS = Object.freeze({
  sram: INTERNAL_SAVE_BYTES,
  flash64: INTERNAL_SAVE_BYTES,
  flash128: INTERNAL_SAVE_BYTES,
  eeprom: EEPROM_BYTES,
});
const RAW_FILES = new Map([
  [0x200, 'eeprom'],
  [0x2000, 'eeprom'],
  [0x8000, 'sram'],
  [0x10000, 'flash64'],
  [0x20000, 'flash128'],
]);
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function fail(message) {
  throw new Error(`Invalid battery save: ${message}`);
}

function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) sum = (sum + bytes[i]) >>> 0;
  return sum;
}

function encodeBase64(bytes) {
  const output = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = hasB ? bytes[i + 1] : 0;
    const c = hasC ? bytes[i + 2] : 0;
    output.push(
      BASE64_ALPHABET[a >>> 2],
      BASE64_ALPHABET[((a & 3) << 4) | (b >>> 4)],
      hasB ? BASE64_ALPHABET[((b & 15) << 2) | (c >>> 6)] : '=',
      hasC ? BASE64_ALPHABET[c & 63] : '=',
    );
  }
  return output.join('');
}

function base64Value(char) {
  const value = BASE64_ALPHABET.indexOf(char);
  return value;
}

function decodeBase64(value) {
  if (typeof value !== 'string') fail('data must be a base64 string');
  if (value.length % 4 !== 0) fail('data is not valid base64');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('data is not valid base64');

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const byteLength = (value.length / 4) * 3 - padding;
  if (byteLength > MAX_FILE_BYTES) fail('data exceeds the 256KB limit');
  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (let i = 0; i < value.length; i += 4) {
    const a = base64Value(value[i]);
    const b = base64Value(value[i + 1]);
    const c = value[i + 2] === '=' ? 0 : base64Value(value[i + 2]);
    const d = value[i + 3] === '=' ? 0 : base64Value(value[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) fail('data is not valid base64');

    // Reject alternate encodings with non-zero unused bits.
    if (value[i + 2] === '=' && (b & 15) !== 0) fail('data is not canonical base64');
    if (value[i + 3] === '=' && (c & 3) !== 0) fail('data is not canonical base64');

    if (offset < bytes.length) bytes[offset++] = (a << 2) | (b >>> 4);
    if (offset < bytes.length) bytes[offset++] = ((b & 15) << 4) | (c >>> 2);
    if (offset < bytes.length) bytes[offset++] = ((c & 3) << 6) | d;
  }
  return bytes;
}

function decodeUtf8(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const first = bytes[i];
    if (first < 0x80) {
      text += String.fromCharCode(first);
      continue;
    }

    let codePoint;
    let extra;
    if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f;
      extra = 1;
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f;
      extra = 2;
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07;
      extra = 3;
    } else {
      fail('JSON file is not valid UTF-8');
    }
    if (i + extra >= bytes.length) fail('JSON file is not valid UTF-8');

    for (let j = 1; j <= extra; j += 1) {
      const next = bytes[i + j];
      if ((next & 0xc0) !== 0x80) fail('JSON file is not valid UTF-8');
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (
      (extra === 2 && codePoint < 0x800) ||
      (extra === 3 && codePoint < 0x10000) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint > 0x10ffff
    ) {
      fail('JSON file is not valid UTF-8');
    }
    i += extra;
    if (codePoint <= 0xffff) {
      text += String.fromCharCode(codePoint);
    } else {
      const adjusted = codePoint - 0x10000;
      text += String.fromCharCode(0xd800 + (adjusted >>> 10), 0xdc00 + (adjusted & 0x3ff));
    }
  }
  return text;
}

function isJsonStart(bytes) {
  let index = 0;
  while (index < bytes.length && (bytes[index] === 0x09 || bytes[index] === 0x0a || bytes[index] === 0x0d || bytes[index] === 0x20)) {
    index += 1;
  }
  return index < bytes.length && bytes[index] === 0x7b;
}

function assertEnvelopeShape(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    fail('envelope must be a JSON object');
  }
  const keys = Object.keys(envelope).sort();
  if (keys.join(',') !== 'checksum,data,len,saveType,v') {
    fail('envelope must contain exactly v, saveType, len, checksum, and data');
  }
  if (envelope.v !== 1) fail('unsupported envelope version');
  if (typeof envelope.saveType !== 'string' || !SAVE_TYPES.has(envelope.saveType)) {
    fail('unsupported save type');
  }
  const expectedLength = INTERNAL_LENGTHS[envelope.saveType];
  if (!Number.isSafeInteger(envelope.len) || envelope.len !== expectedLength) {
    fail(`${envelope.saveType} envelope must contain ${expectedLength} bytes`);
  }
  if (!Number.isSafeInteger(envelope.checksum) || envelope.checksum < 0 || envelope.checksum > 0xffffffff) {
    fail('checksum must be an unsigned 32-bit integer');
  }
}

function envelopeFromBytes(saveType, bytes) {
  const padded = new Uint8Array(INTERNAL_LENGTHS[saveType]);
  padded.set(bytes);
  return JSON.stringify({
    v: 1,
    saveType,
    len: padded.length,
    checksum: checksum(padded),
    data: encodeBase64(padded),
  });
}

/**
 * Validate an internal battery-save envelope and return its canonical JSON.
 *
 * Core snapshots use a 128KB SRAM/flash buffer and an 8KB EEPROM buffer.
 * Portable raw files are expanded to these sizes by decodeBatteryFile.
 */
export function validateBatterySave(json) {
  if (typeof json !== 'string') fail('envelope must be a JSON string');
  if (json.length > MAX_FILE_BYTES) fail('file exceeds the 256KB limit');

  let envelope;
  try {
    envelope = JSON.parse(json);
  } catch (error) {
    fail(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertEnvelopeShape(envelope);
  const bytes = decodeBase64(envelope.data);
  if (bytes.length !== envelope.len) {
    fail(`length mismatch: expected ${envelope.len} bytes, got ${bytes.length}`);
  }
  if (checksum(bytes) !== envelope.checksum) fail('checksum mismatch');
  if (encodeBase64(bytes) !== envelope.data) fail('data is not canonical base64');

  return JSON.stringify({
    v: 1,
    saveType: envelope.saveType,
    len: bytes.length,
    checksum: envelope.checksum >>> 0,
    data: envelope.data,
  });
}

/**
 * Convert a portable raw .sav file, or an internal JSON .sav, to a core
 * snapshot envelope. Raw SRAM/flash files are padded with zeroes because the
 * emulator's backing buffers are always 128KB.
 */
export function decodeBatteryFile(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('file must be a Uint8Array');
  if (bytes.length > MAX_FILE_BYTES) fail('file exceeds the 256KB limit');

  if (isJsonStart(bytes)) return validateBatterySave(decodeUtf8(bytes));

  const saveType = RAW_FILES.get(bytes.length);
  if (!saveType) {
    fail('unsupported raw save length (expected 512B, 8KB, 32KB, 64KB, or 128KB)');
  }
  return envelopeFromBytes(saveType, bytes);
}

/**
 * Convert a validated core envelope to a portable raw .sav file. Save type
 * determines the standard cartridge size; high bytes of SRAM and flash64
 * snapshots are intentionally omitted.
 */
export function encodeBatteryFile(json) {
  const normalized = JSON.parse(validateBatterySave(json));
  const bytes = decodeBase64(normalized.data);
  const rawLength =
    normalized.saveType === 'sram'
      ? 0x8000
      : normalized.saveType === 'flash64'
        ? 0x10000
        : normalized.saveType === 'flash128'
          ? 0x20000
          : 0x2000;
  return bytes.slice(0, rawLength);
}