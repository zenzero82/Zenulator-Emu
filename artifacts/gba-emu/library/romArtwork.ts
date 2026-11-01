/**
 * ROM artwork and ZIP import helpers.
 *
 * This module deliberately has no native dependencies.  It is used by the
 * mobile importer, but keeping the validation and ZIP directory reader pure
 * makes corrupt files safe to reject before they reach the filesystem.
 */

export const ARTWORK_DIRECTORY = 'gba_artwork/';
export const MAX_ARTWORK_BYTES = 8 * 1024 * 1024;
export const MAX_ARTWORK_PIXELS = 16_000_000;
export const MAX_ROM_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 512;
export const MAX_ZIP_CANDIDATE_ATTEMPTS = 8;
export const MAX_ZIP_EXTRACTED_BYTES = MAX_ROM_BYTES + (MAX_ARTWORK_BYTES * 2);

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const ZIP_MAX_COMMENT = 0xffff;

export type ArtworkFormat = 'png' | 'jpeg' | 'webp' | 'gif';

export interface ArtworkInfo {
  format: ArtworkFormat;
  extension: ArtworkFormat;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
  flags: number;
}

export interface ZipArtwork {
  bytes: Uint8Array;
  info: ArtworkInfo;
  entryName: string;
}

export interface ZipImportResult {
  rom: Uint8Array;
  romName: string;
  artwork?: ZipArtwork;
  artworkCandidates: ZipArtwork[];
}

export class ArtworkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtworkValidationError';
  }
}

export class ZipImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipImportError';
  }
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) throw new ZipImportError('The archive is truncated.');
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) throw new ZipImportError('The archive is truncated.');
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] * 0x1000000)
  ) >>> 0;
}

function readU32At(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return readU32(bytes, offset);
}

function readBE32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) throw new ArtworkValidationError('The artwork is truncated.');
  return (
    (bytes[offset] * 0x1000000) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function decodeZipName(bytes: Uint8Array, utf8: boolean): string {
  try {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder(utf8 ? 'utf-8' : 'latin1').decode(bytes);
  } catch {
    // Fall through to the ASCII-compatible decoder used by older runtimes.
  }
  let result = '';
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}

function basename(value: string): string {
  const clean = value.replace(/\\/g, '/');
  return clean.slice(clean.lastIndexOf('/') + 1);
}

function extension(value: string): string {
  const name = basename(value).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

function romNameWithoutExtension(value: string): string {
  const name = basename(value);
  return name.replace(/\.(?:gba|agb|bin)$/i, '').toLowerCase();
}

function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && readU32(bytes, 0) === 0x04034b50;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - (ZIP_MAX_COMMENT + 22));
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (readU32At(bytes, offset) !== ZIP_EOCD) continue;
    const commentLength = readU16(bytes, offset + 20);
    if (offset + 22 + commentLength <= bytes.length) return offset;
  }
  throw new ZipImportError('The ZIP archive is missing its directory.');
}

/**
 * Reads only the ZIP central directory.  It never allocates based on a file
 * name or declared size, and rejects ZIP64 archives rather than risking an
 * integer truncation in the mobile JS runtime.
 */
export function parseZipEntries(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    throw new ZipImportError('The ZIP archive is too large (maximum 128 MB).');
  }
  if (!hasZipSignature(bytes)) throw new ZipImportError('The selected file is not a ZIP archive.');

  const eocd = findEndOfCentralDirectory(bytes);
  const totalEntries = readU16(bytes, eocd + 10);
  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new ZipImportError(`The ZIP archive has too many entries (maximum ${MAX_ZIP_ENTRIES}).`);
  }
  const centralSize = readU32(bytes, eocd + 12);
  const centralOffset = readU32(bytes, eocd + 16);
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipImportError('ZIP64 archives are not supported on this device.');
  }
  if (
    centralOffset > bytes.length ||
    centralSize > bytes.length - centralOffset ||
    centralOffset + centralSize > eocd
  ) {
    throw new ZipImportError('The ZIP directory is outside the archive.');
  }

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  while (cursor < centralEnd && entries.length < totalEntries) {
    if (readU32(bytes, cursor) !== ZIP_CENTRAL) {
      throw new ZipImportError('The ZIP directory is corrupt.');
    }
    if (cursor + 46 > centralEnd) throw new ZipImportError('The ZIP directory is truncated.');

    const flags = readU16(bytes, cursor + 8);
    const compressionMethod = readU16(bytes, cursor + 10);
    const crc32 = readU32(bytes, cursor + 16);
    const compressedSize = readU32(bytes, cursor + 20);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const localHeaderOffset = readU32(bytes, cursor + 42);
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > centralEnd) throw new ZipImportError('A ZIP directory entry is truncated.');
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      cursor = next;
      continue;
    }

    const nameBytes = bytes.slice(nameStart, nameStart + nameLength);
    entries.push({
      name: decodeZipName(nameBytes, (flags & 0x800) !== 0),
      compressionMethod,
      compressedSize,
      uncompressedSize,
      crc32,
      localHeaderOffset,
      flags,
    });
    cursor = next;
  }
  if (entries.length === 0) throw new ZipImportError('The ZIP archive contains no usable files.');
  if (entries.length !== totalEntries) throw new ZipImportError('The ZIP directory is incomplete.');
  return entries;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (-(value & 1) & 0xedb88320);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function imageDimensions(info: ArtworkInfo, width: number, height: number): ArtworkInfo {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ArtworkValidationError('The artwork has invalid dimensions.');
  }
  if (width > 8192 || height > 8192 || width * height > MAX_ARTWORK_PIXELS) {
    throw new ArtworkValidationError('The artwork dimensions are too large.');
  }
  return { ...info, width, height };
}

function parseJpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  let cursor = 2;
  while (cursor + 3 < bytes.length) {
    if (bytes[cursor] !== 0xff) {
      cursor += 1;
      continue;
    }
    while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
    const marker = bytes[cursor++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (cursor + 2 > bytes.length) break;
    const segmentLength = (bytes[cursor] << 8) | bytes[cursor + 1];
    if (segmentLength < 2 || cursor + segmentLength > bytes.length) break;
    const isFrame = (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    );
    if (isFrame && segmentLength >= 7) {
      return {
        height: (bytes[cursor + 3] << 8) | bytes[cursor + 4],
        width: (bytes[cursor + 5] << 8) | bytes[cursor + 6],
      };
    }
    cursor += segmentLength;
  }
  throw new ArtworkValidationError('The JPEG artwork is corrupt or incomplete.');
}

function parseWebpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 30) throw new ArtworkValidationError('The WebP artwork is corrupt or incomplete.');
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === 'VP8X') {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return { width, height };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    const width = bytes[26] | (bytes[27] << 8);
    const height = bytes[28] | (bytes[29] << 8);
    return { width: width & 0x3fff, height: height & 0x3fff };
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  throw new ArtworkValidationError('The WebP artwork has an unsupported payload.');
}

/**
 * Validates a complete image by signature and dimensions.  MIME type alone
 * is intentionally not trusted because document providers can mislabel files.
 */
export function validateArtworkBytes(input: Uint8Array): ArtworkInfo {
  if (input.byteLength === 0) throw new ArtworkValidationError('The artwork file is empty.');
  if (input.byteLength > MAX_ARTWORK_BYTES) {
    throw new ArtworkValidationError('Artwork files must be 8 MB or smaller.');
  }

  const bytes = input;
  if (
    bytes.length >= 33 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    let chunkOffset = 8;
    let hasIhdr = false;
    let hasIdat = false;
    let hasIend = false;
    while (chunkOffset + 12 <= bytes.length) {
      const chunkLength = readBE32(bytes, chunkOffset);
      const chunkEnd = chunkOffset + 12 + chunkLength;
      if (chunkEnd > bytes.length) throw new ArtworkValidationError('The PNG artwork is truncated.');
      const type = String.fromCharCode(
        bytes[chunkOffset + 4],
        bytes[chunkOffset + 5],
        bytes[chunkOffset + 6],
        bytes[chunkOffset + 7],
      );
      const chunkData = bytes.slice(chunkOffset + 4, chunkOffset + 8 + chunkLength);
      if (crc32(chunkData) !== readBE32(bytes, chunkOffset + 8 + chunkLength)) {
        throw new ArtworkValidationError('The PNG artwork failed its integrity check.');
      }
      if (type === 'IHDR') {
        if (chunkOffset !== 8 || chunkLength !== 13) throw new ArtworkValidationError('The PNG artwork is corrupt.');
        hasIhdr = true;
      }
      if (type === 'IDAT' && chunkLength > 0) hasIdat = true;
      if (type === 'IEND' && chunkLength === 0) {
        hasIend = true;
        break;
      }
      chunkOffset = chunkEnd;
    }
    if (!hasIhdr || !hasIdat || !hasIend) {
      throw new ArtworkValidationError('The PNG artwork is corrupt or incomplete.');
    }
    const info = imageDimensions(
      { format: 'png', extension: 'png', mimeType: 'image/png' },
      readBE32(bytes, 16),
      readBE32(bytes, 20),
    );
    if (
      bytes[12] !== 0x49 ||
      bytes[13] !== 0x48 ||
      bytes[14] !== 0x44 ||
      bytes[15] !== 0x52
    ) throw new ArtworkValidationError('The PNG artwork is corrupt.');
    return info;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (bytes.length < 4 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      throw new ArtworkValidationError('The JPEG artwork is corrupt or incomplete.');
    }
    const dimensions = parseJpegDimensions(bytes);
    return imageDimensions(
      { format: 'jpeg', extension: 'jpeg', mimeType: 'image/jpeg' },
      dimensions.width,
      dimensions.height,
    );
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const riffSize = readU32(bytes, 4);
    if (riffSize + 8 > bytes.length) throw new ArtworkValidationError('The WebP artwork is truncated.');
    const dimensions = parseWebpDimensions(bytes);
    return dimensions
      ? imageDimensions({ format: 'webp', extension: 'webp', mimeType: 'image/webp' }, dimensions.width, dimensions.height)
      : { format: 'webp', extension: 'webp', mimeType: 'image/webp' };
  }
  if (
    bytes.length >= 10 &&
    ((bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61))
  ) {
    if (bytes[bytes.length - 1] !== 0x3b) throw new ArtworkValidationError('The GIF artwork is corrupt or incomplete.');
    return imageDimensions(
      { format: 'gif', extension: 'gif', mimeType: 'image/gif' },
      bytes[6] | (bytes[7] << 8),
      bytes[8] | (bytes[9] << 8),
    );
  }
  throw new ArtworkValidationError('Choose a PNG, JPEG, WebP, or GIF image.');
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 0x6000) {
    let binary = '';
    const end = Math.min(offset + 0x6000, bytes.length);
    for (let index = offset; index < end; index += 1) binary += String.fromCharCode(bytes[index]);
    if (typeof btoa === 'function') result += btoa(binary);
    else {
      for (let index = 0; index < binary.length; index += 3) {
        const a = binary.charCodeAt(index);
        const b = index + 1 < binary.length ? binary.charCodeAt(index + 1) : 0;
        const c = index + 2 < binary.length ? binary.charCodeAt(index + 2) : 0;
        result += BASE64_ALPHABET[a >> 2];
        result += BASE64_ALPHABET[((a & 3) << 4) | (b >> 4)];
        result += index + 1 < binary.length ? BASE64_ALPHABET[((b & 15) << 2) | (c >> 6)] : '=';
        result += index + 2 < binary.length ? BASE64_ALPHABET[c & 63] : '=';
      }
    }
  }
  return result;
}

export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, '');
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new ZipImportError('The selected file contains invalid binary data.');
  }
  if (typeof atob === 'function') {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((normalized.length * 3) / 4 - padding);
  let output = 0;
  for (let index = 0; index < normalized.length; index += 4) {
    const a = BASE64_ALPHABET.indexOf(normalized[index]);
    const b = BASE64_ALPHABET.indexOf(normalized[index + 1]);
    const c = BASE64_ALPHABET.indexOf(normalized[index + 2]);
    const d = BASE64_ALPHABET.indexOf(normalized[index + 3]);
    bytes[output++] = (a << 2) | (b >> 4);
    if (output < bytes.length) bytes[output++] = ((b & 15) << 4) | (c < 0 ? 0 : c >> 2);
    if (output < bytes.length) bytes[output++] = ((c & 3) << 6) | (d < 0 ? 0 : d);
  }
  return bytes;
}

/**
 * Returns an MD5 content hash without requiring a native crypto module.
 * Native file imports use Expo FileSystem's native MD5 when available, while
 * ZIP and web imports use this implementation so the same ROM gets the same
 * identity regardless of its source container.
 */
export function hashBytes(bytes: Uint8Array): string {
  const shift = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = Array.from({ length: 64 }, (_, index) => (
    Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0
  ));
  const bitLength = bytes.length * 8;
  const blockCount = Math.ceil((bytes.length + 9) / 64);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let block = 0; block < blockCount; block += 1) {
    const start = block * 64;
    const words = new Uint32Array(16);
    for (let index = 0; index < 64; index += 1) {
      const source = start + index;
      if (source < bytes.length) words[index >>> 2] |= bytes[source] << ((index & 3) * 8);
      else if (source === bytes.length) words[index >>> 2] |= 0x80 << ((index & 3) * 8);
    }
    if (block === blockCount - 1) {
      words[14] = bitLength >>> 0;
      words[15] = Math.floor(bitLength / 0x100000000) >>> 0;
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let functionValue: number;
      let wordIndex: number;
      if (index < 16) {
        functionValue = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        functionValue = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        functionValue = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        functionValue = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }
      const rotated = (a + functionValue + constants[index] + words[wordIndex]) >>> 0;
      const amount = shift[index];
      const left = ((rotated << amount) | (rotated >>> (32 - amount))) >>> 0;
      const next = (b + left) >>> 0;
      a = d;
      d = c;
      c = b;
      b = next;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const words = [a0, b0, c0, d0];
  return words.map((word) => (
    [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, word >>> 24]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  )).join('');
}

function artworkScore(entry: ZipEntry, romName: string): number {
  const lower = entry.name.toLowerCase().replace(/\\/g, '/');
  const file = basename(lower);
  const stem = file.replace(/\.(png|jpe?g|webp|gif)$/i, '');
  const romStem = romNameWithoutExtension(romName);
  let score = 0;
  if (stem === romStem) score += 120;
  if (stem.includes(romStem) || romStem.includes(stem)) score += 45;
  if (/(cover|box|artwork|boxart|front|title|jacket|sleeve)/i.test(stem)) score += 35;
  if (lower.split('/').length === 1) score += 12;
  if (entry.uncompressedSize <= MAX_ARTWORK_BYTES) score += 4;
  return score;
}

export function chooseArtworkCandidates(entries: ZipEntry[], romName: string): ZipEntry[] {
  return entries
    .filter((entry) => (
      !(entry.flags & 1) &&
      ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension(entry.name)) &&
      entry.uncompressedSize > 0 &&
      entry.uncompressedSize <= MAX_ARTWORK_BYTES
    ))
    .sort((left, right) => {
      const score = artworkScore(right, romName) - artworkScore(left, romName);
      return score || left.name.localeCompare(right.name);
    });
}

function chooseRomCandidates(entries: ZipEntry[]): ZipEntry[] {
  return entries
    .filter((entry) => (
      !(entry.flags & 1) &&
      ['gba', 'agb', 'bin'].includes(extension(entry.name)) &&
      entry.uncompressedSize >= 192 &&
      entry.uncompressedSize <= MAX_ROM_BYTES
    ))
    .sort((left, right) => {
      const leftGba = extension(left.name) === 'gba' ? 1 : 0;
      const rightGba = extension(right.name) === 'gba' ? 1 : 0;
      return rightGba - leftGba || right.uncompressedSize - left.uncompressedSize;
    });
}

class DeflateBitReader {
  private offset = 0;
  private bit = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      if (this.offset >= this.bytes.length) throw new ZipImportError('A compressed ZIP entry is truncated.');
      value |= ((this.bytes[this.offset] >>> this.bit) & 1) << index;
      this.bit += 1;
      if (this.bit === 8) {
        this.bit = 0;
        this.offset += 1;
      }
    }
    return value >>> 0;
  }

  align(): void {
    if (this.bit) {
      this.bit = 0;
      this.offset += 1;
    }
  }
}

interface DeflateHuffmanTable {
  byLength: Array<Map<number, number>>;
  maxLength: number;
}

function reverseBits(value: number, count: number): number {
  let result = 0;
  for (let index = 0; index < count; index += 1) {
    result = (result << 1) | (value & 1);
    value >>>= 1;
  }
  return result;
}

function makeDeflateHuffmanTable(lengths: number[]): DeflateHuffmanTable {
  const maxLength = Math.max(...lengths);
  if (maxLength <= 0 || maxLength > 15) throw new ZipImportError('A compressed ZIP entry has an invalid Huffman table.');
  const counts = new Uint16Array(maxLength + 1);
  for (const length of lengths) {
    if (length < 0 || length > 15) throw new ZipImportError('A compressed ZIP entry has an invalid Huffman code.');
    if (length) counts[length] += 1;
  }
  let slots = 1;
  for (let length = 1; length <= maxLength; length += 1) {
    slots = (slots << 1) - counts[length];
    if (slots < 0) throw new ZipImportError('A compressed ZIP entry has an oversubscribed Huffman table.');
  }
  const nextCode = new Uint16Array(maxLength + 1);
  let code = 0;
  for (let length = 1; length <= maxLength; length += 1) {
    code = (code + counts[length - 1]) << 1;
    nextCode[length] = code;
  }
  const byLength = Array.from({ length: maxLength + 1 }, () => new Map<number, number>());
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol];
    if (!length) continue;
    // Deflate transmits canonical codes least-significant bit first. The
    // decoder accumulates the first bit at the least-significant position,
    // so the lookup key is the reversed canonical code.
    const reversed = reverseBits(nextCode[length], length);
    nextCode[length] += 1;
    byLength[length].set(reversed, symbol);
  }
  return { byLength, maxLength };
}

function readDeflateSymbol(reader: DeflateBitReader, table: DeflateHuffmanTable): number {
  let code = 0;
  for (let length = 1; length <= table.maxLength; length += 1) {
    code |= reader.read(1) << (length - 1);
    const symbol = table.byLength[length].get(code);
    if (symbol !== undefined) return symbol;
  }
  throw new ZipImportError('A compressed ZIP entry contains an invalid Huffman code.');
}

const DEFLATE_LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const DEFLATE_LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DEFLATE_DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DEFLATE_DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

function fixedDeflateTables(): { literal: DeflateHuffmanTable; distance: DeflateHuffmanTable } {
  const literalLengths = new Array<number>(288).fill(0);
  for (let symbol = 0; symbol <= 143; symbol += 1) literalLengths[symbol] = 8;
  for (let symbol = 144; symbol <= 255; symbol += 1) literalLengths[symbol] = 9;
  for (let symbol = 256; symbol <= 279; symbol += 1) literalLengths[symbol] = 7;
  for (let symbol = 280; symbol <= 287; symbol += 1) literalLengths[symbol] = 8;
  return {
    literal: makeDeflateHuffmanTable(literalLengths),
    distance: makeDeflateHuffmanTable(new Array<number>(32).fill(5)),
  };
}

function dynamicDeflateTables(reader: DeflateBitReader): { literal: DeflateHuffmanTable; distance: DeflateHuffmanTable } {
  const literalCount = reader.read(5) + 257;
  const distanceCount = reader.read(5) + 1;
  const codeLengthCount = reader.read(4) + 4;
  if (literalCount > 286 || distanceCount > 32) throw new ZipImportError('A compressed ZIP entry has invalid table sizes.');
  const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const codeLengthLengths = new Array<number>(19).fill(0);
  for (let index = 0; index < codeLengthCount; index += 1) codeLengthLengths[order[index]] = reader.read(3);
  const codeLengthTable = makeDeflateHuffmanTable(codeLengthLengths);
  const allLengths: number[] = [];
  while (allLengths.length < literalCount + distanceCount) {
    const symbol = readDeflateSymbol(reader, codeLengthTable);
    if (symbol <= 15) {
      allLengths.push(symbol);
    } else if (symbol === 16) {
      if (!allLengths.length) throw new ZipImportError('A compressed ZIP entry repeats an empty code.');
      const repeat = reader.read(2) + 3;
      const previous = allLengths[allLengths.length - 1];
      for (let index = 0; index < repeat; index += 1) allLengths.push(previous);
    } else if (symbol === 17) {
      const repeat = reader.read(3) + 3;
      for (let index = 0; index < repeat; index += 1) allLengths.push(0);
    } else if (symbol === 18) {
      const repeat = reader.read(7) + 11;
      for (let index = 0; index < repeat; index += 1) allLengths.push(0);
    } else {
      throw new ZipImportError('A compressed ZIP entry contains an invalid code length.');
    }
    if (allLengths.length > literalCount + distanceCount) {
      throw new ZipImportError('A compressed ZIP entry has too many code lengths.');
    }
  }
  const literalLengths = allLengths.slice(0, literalCount);
  const distanceLengths = allLengths.slice(literalCount);
  if (!distanceLengths.some(Boolean)) throw new ZipImportError('A compressed ZIP entry has no distance codes.');
  return {
    literal: makeDeflateHuffmanTable(literalLengths),
    distance: makeDeflateHuffmanTable(distanceLengths),
  };
}

function inflateRawPure(bytes: Uint8Array, expectedSize: number): Uint8Array {
  const reader = new DeflateBitReader(bytes);
  const output = new Uint8Array(expectedSize);
  let outputLength = 0;
  let final = false;
  while (!final) {
    final = reader.read(1) === 1;
    const type = reader.read(2);
    if (type === 0) {
      reader.align();
      const length = reader.read(16);
      const inverseLength = reader.read(16);
      if ((length ^ inverseLength) !== 0xffff || outputLength + length > expectedSize) {
        throw new ZipImportError('A stored ZIP entry is corrupt.');
      }
      for (let index = 0; index < length; index += 1) output[outputLength++] = reader.read(8);
      continue;
    }
    if (type === 3) throw new ZipImportError('A compressed ZIP entry has an invalid block type.');
    const tables = type === 1 ? fixedDeflateTables() : dynamicDeflateTables(reader);
    while (true) {
      const symbol = readDeflateSymbol(reader, tables.literal);
      if (symbol < 256) {
        if (outputLength >= expectedSize) throw new ZipImportError('A compressed ZIP entry expands beyond its declared size.');
        output[outputLength++] = symbol;
        continue;
      }
      if (symbol === 256) break;
      if (symbol < 257 || symbol > 285) throw new ZipImportError('A compressed ZIP entry has an invalid length code.');
      const lengthIndex = symbol - 257;
      const length = DEFLATE_LENGTH_BASE[lengthIndex] + reader.read(DEFLATE_LENGTH_EXTRA[lengthIndex]);
      const distanceSymbol = readDeflateSymbol(reader, tables.distance);
      if (distanceSymbol < 0 || distanceSymbol >= DEFLATE_DISTANCE_BASE.length) {
        throw new ZipImportError('A compressed ZIP entry has an invalid distance code.');
      }
      const distance = DEFLATE_DISTANCE_BASE[distanceSymbol] + reader.read(DEFLATE_DISTANCE_EXTRA[distanceSymbol]);
      if (distance > outputLength || outputLength + length > expectedSize) {
        throw new ZipImportError('A compressed ZIP entry has an invalid back-reference.');
      }
      for (let index = 0; index < length; index += 1) {
        output[outputLength] = output[outputLength - distance];
        outputLength += 1;
      }
    }
  }
  if (outputLength !== expectedSize) throw new ZipImportError('A compressed ZIP entry has an unexpected size.');
  return output;
}

async function inflateRaw(bytes: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  const CompressionStreamCtor = (globalThis as typeof globalThis & {
    DecompressionStream?: new (format: string) => {
      writable: WritableStream<Uint8Array>;
      readable: ReadableStream<Uint8Array>;
    };
  }).DecompressionStream;
  if (!CompressionStreamCtor || typeof Response === 'undefined' || typeof ReadableStream === 'undefined') {
    return inflateRawPure(bytes, expectedSize);
  }
  try {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const stream = (input as unknown as {
      pipeThrough: (transform: unknown) => ReadableStream<Uint8Array>;
    }).pipeThrough(new CompressionStreamCtor('deflate-raw'));
    const output = await new Response(stream).arrayBuffer();
    const unpacked = new Uint8Array(output);
    return unpacked.length === expectedSize ? unpacked : inflateRawPure(bytes, expectedSize);
  } catch {
    return inflateRawPure(bytes, expectedSize);
  }
}

async function extractZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.compressedSize > bytes.length || entry.uncompressedSize > MAX_ARCHIVE_BYTES) {
    throw new ZipImportError('A ZIP entry declares an unsafe size.');
  }
  if (entry.localHeaderOffset + 30 > bytes.length || readU32(bytes, entry.localHeaderOffset) !== ZIP_LOCAL) {
    throw new ZipImportError('A ZIP entry has an invalid local header.');
  }
  const nameLength = readU16(bytes, entry.localHeaderOffset + 26);
  const extraLength = readU16(bytes, entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart > bytes.length || dataEnd > bytes.length) throw new ZipImportError('A ZIP entry is truncated.');
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new ZipImportError('A ZIP entry uses an unsupported compression method.');
  }
  const unpacked = entry.compressionMethod === 0
    ? bytes.slice(dataStart, dataEnd)
    : await inflateRaw(bytes.slice(dataStart, dataEnd), entry.uncompressedSize);
  if (unpacked.length !== entry.uncompressedSize || crc32(unpacked) !== entry.crc32) {
    throw new ZipImportError('A ZIP entry failed its integrity check.');
  }
  return unpacked;
}

interface ZipExtractionBudget {
  attempts: number;
  bytes: number;
}

function chargeZipExtraction(entry: ZipEntry, budget: ZipExtractionBudget): void {
  if (budget.attempts >= MAX_ZIP_CANDIDATE_ATTEMPTS) {
    throw new ZipImportError(`The ZIP archive has too many candidate extraction attempts (maximum ${MAX_ZIP_CANDIDATE_ATTEMPTS}).`);
  }
  if (
    entry.uncompressedSize > MAX_ZIP_EXTRACTED_BYTES ||
    budget.bytes > MAX_ZIP_EXTRACTED_BYTES - entry.uncompressedSize
  ) {
    throw new ZipImportError('The ZIP archive expands beyond the safe extraction limit.');
  }
  // Charge declared bytes before reading or validating the candidate. A
  // corrupt entry must not be a free decompression-bomb attempt.
  budget.attempts += 1;
  budget.bytes += entry.uncompressedSize;
}

/**
 * Imports a ZIP containing one or more ROMs and optional artwork. ROM
 * candidates and artwork candidates are tried independently, so one broken
 * thumbnail does not make an otherwise valid ROM unusable. Valid artwork is
 * returned as a bounded candidate list so the UI can ask the user which cover
 * to keep.
 */
export async function extractZipRomAndArtwork(bytes: Uint8Array, archiveName: string): Promise<ZipImportResult> {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new ZipImportError('The ZIP archive is too large (maximum 128 MB).');
  const entries = parseZipEntries(bytes);
  const romCandidates = chooseRomCandidates(entries);
  if (!romCandidates.length) throw new ZipImportError('The ZIP archive does not contain a GBA ROM up to 64 MB.');

  let rom: Uint8Array | null = null;
  let romName = '';
  const extractionBudget: ZipExtractionBudget = { attempts: 0, bytes: 0 };
  for (const candidate of romCandidates) {
    try {
      chargeZipExtraction(candidate, extractionBudget);
    } catch (error) {
      if (!rom) throw error;
      break;
    }
    try {
      const candidateBytes = await extractZipEntry(bytes, candidate);
      if (candidateBytes.length >= 192 && candidateBytes.length <= MAX_ROM_BYTES) {
        rom = candidateBytes;
        romName = basename(candidate.name);
        break;
      }
    } catch {
      // Try the next ROM candidate.  Archives often contain a README or a
      // stale ROM alongside the actual game.
    }
  }
  if (!rom) throw new ZipImportError('Every GBA ROM entry in the ZIP archive is corrupt.');

  const artworkCandidates = chooseArtworkCandidates(entries, romName || archiveName);
  const validArtworkCandidates: ZipArtwork[] = [];
  for (const candidate of artworkCandidates) {
    if (validArtworkCandidates.length >= MAX_ZIP_CANDIDATE_ATTEMPTS) break;
    try {
      chargeZipExtraction(candidate, extractionBudget);
    } catch {
      break;
    }
    try {
      const candidateBytes = await extractZipEntry(bytes, candidate);
      const info = validateArtworkBytes(candidateBytes);
      validArtworkCandidates.push({ bytes: candidateBytes, info, entryName: candidate.name });
    } catch {
      // A corrupt cover should not prevent the ROM itself from importing.
    }
  }
  return {
    rom,
    romName,
    artwork: validArtworkCandidates[0],
    artworkCandidates: validArtworkCandidates,
  };
}

/**
 * Converts an absolute/stale artwork path to the portable relative path
 * stored in AsyncStorage.  Only a basename is ever accepted, preventing a
 * malformed persisted value from escaping the artwork directory.
 */
export function portableArtworkPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const file = basename(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file)) return undefined;
  const ext = extension(file);
  if (!['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return undefined;
  return `${ARTWORK_DIRECTORY}${file}`;
}

export function resolveArtworkUri(
  value: string | undefined,
  documentDirectory?: string | null,
): string | undefined {
  const portable = portableArtworkPath(value);
  if (!portable || !documentDirectory) return undefined;
  return `${documentDirectory}${portable}`;
}
