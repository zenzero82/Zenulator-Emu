/*
 * Artwork is deliberately kept outside the ROM payload. GBA cartridges do
 * not have a standard cover-art area, so only an image explicitly supplied by
 * the user or found beside a ROM in a ZIP archive is used.
 *
 * This module also contains the small ZIP reader used for ROM-hack imports.
 * It only reads the central directory, extracts the one ROM and a bounded
 * number of image candidates, and never writes archive paths to disk.
 */

export const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;
export const MAX_ARTWORK_DIMENSION = 8192;
export const MAX_ARTWORK_PIXELS = 16_000_000;
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 256;
export const MAX_ARCHIVE_ARTWORK_CANDIDATES = 8;
export const MAX_ARCHIVE_ARTWORK_BYTES = 16 * 1024 * 1024;
export const MAX_ROM_BYTES = 64 * 1024 * 1024;
export const MIN_ROM_BYTES = 192;

export type ArtworkMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export type ArtworkSource = 'user' | 'zip';

export interface ArtworkReference {
  mimeType: ArtworkMimeType;
  byteLength: number;
  fileName: string;
  source: ArtworkSource;
  width?: number;
  height?: number;
}

export interface GameArtwork extends ArtworkReference {
  id: string;
  data: ArrayBuffer;
}

export interface ArtworkCandidate extends GameArtwork {
  path: string;
  score: number;
}

export interface RomImportPayload {
  rom: ArrayBuffer;
  fileName: string;
  artworkCandidates: ArtworkCandidate[];
  warnings: string[];
}

const IMAGE_BY_EXTENSION: Record<string, ArtworkMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1].toLowerCase() : '';
}

export function isCompanionArtwork(romName: string, imageName: string): boolean {
  if (!/\.(png|jpe?g|webp|gif)$/i.test(imageName)) return false;
  const stem = romName.replace(/\.[^.]+$/, '').toLowerCase();
  const imageStem = imageName.replace(/\.[^.]+$/, '').toLowerCase();
  return [stem, `${stem}.cover`, `${stem}-cover`, `${stem}_cover`, `${stem} cover`].includes(imageStem);
}

function artworkMimeForName(name: string): ArtworkMimeType | null {
  return IMAGE_BY_EXTENSION[extensionOf(name)] ?? null;
}

export function isArtworkMimeType(value: unknown): value is ArtworkMimeType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif';
}

function readUint24(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}

function inspectPng(data: Uint8Array): { width: number; height: number } | null {
  if (
    data.byteLength < 33 ||
    ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => data[index] === value)
  ) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || width > MAX_ARTWORK_DIMENSION || height > MAX_ARTWORK_DIMENSION) return null;
  // An IHDR-only payload is not a complete image. Requiring IEND also avoids
  // accepting a crafted header as a usable cover.
  let hasIend = false;
  let hasIdat = false;
  for (let offset = 8; offset + 12 <= data.length;) {
    const length = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    if (length > data.length - offset - 12) return null;
    if (type === 0x49454e44 && length === 0) hasIend = true;
    if (type === 0x49444154 && length > 0) hasIdat = true;
    offset += length + 12;
  }
  return hasIend && hasIdat ? { width, height } : null;
}

function inspectGif(data: Uint8Array): { width: number; height: number } | null {
  if (data.byteLength < 14) return null;
  const signature = new TextDecoder().decode(data.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  const width = data[6] | (data[7] << 8);
  const height = data[8] | (data[9] << 8);
  if (!width || !height || width > MAX_ARTWORK_DIMENSION || height > MAX_ARTWORK_DIMENSION) return null;
  return data[data.length - 1] === 0x3b ? { width, height } : null;
}

function inspectWebp(data: Uint8Array): { width: number; height: number } | null {
  if (data.byteLength < 30 || new TextDecoder().decode(data.subarray(0, 4)) !== 'RIFF' ||
      new TextDecoder().decode(data.subarray(8, 12)) !== 'WEBP') return null;
  const chunk = new TextDecoder().decode(data.subarray(12, 16));
  let width = 0;
  let height = 0;
  if (chunk === 'VP8X' && data.length >= 30) {
    width = 1 + readUint24(data, 24);
    height = 1 + readUint24(data, 27);
  } else if (chunk === 'VP8 ' && data.length >= 30) {
    // A lossy VP8 frame starts with a three-byte frame tag followed by a
    // start code and a 16-bit little-endian width/height.
    const start = data.indexOf(0x9d, 20);
    if (start >= 0 && start + 7 < data.length && data[start + 1] === 0x01 && data[start + 2] === 0x2a) {
      width = data[start + 3] | (data[start + 4] << 8);
      height = data[start + 5] | (data[start + 6] << 8);
    }
  } else if (chunk === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
    const bits = data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24);
    width = 1 + (bits & 0x3fff);
    height = 1 + ((bits >>> 14) & 0x3fff);
  }
  return width > 0 && height > 0 && width <= MAX_ARTWORK_DIMENSION && height <= MAX_ARTWORK_DIMENSION
    ? { width, height }
    : null;
}

function inspectJpeg(data: Uint8Array): { width: number; height: number } | null {
  if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  let sawEnd = false;
  while (offset + 1 < data.length) {
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    if (offset >= data.length) break;
    const marker = data[offset++];
    if (marker === 0xd9) {
      sawEnd = true;
      break;
    }
    if (marker === 0xda) {
      // Entropy data can contain arbitrary marker-like bytes. Find the EOI
      // while respecting byte stuffing, then finish validation.
      for (let cursor = offset + 2; cursor + 1 < data.length; cursor += 1) {
        if (data[cursor] === 0xff && data[cursor + 1] === 0xd9) {
          sawEnd = true;
          break;
        }
      }
      break;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= data.length) return null;
    const length = (data[offset] << 8) | data[offset + 1];
    if (length < 2 || offset + length > data.length) return null;
    const isFrame = (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isFrame && length >= 7) {
      const height = (data[offset + 3] << 8) | data[offset + 4];
      const width = (data[offset + 5] << 8) | data[offset + 6];
      if (!width || !height || width > MAX_ARTWORK_DIMENSION || height > MAX_ARTWORK_DIMENSION) return null;
      if (sawEnd) return { width, height };
      // Continue through the scan to verify the EOI marker.
      offset += length;
      continue;
    }
    offset += length;
  }
  if (!sawEnd) return null;
  // Dimensions are found in the frame marker before EOI. A second lightweight
  // pass keeps the common progressive/JPEG-with-metadata case straightforward.
  offset = 2;
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1];
    const length = (data[offset + 2] << 8) | data[offset + 3];
    const isFrame = (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isFrame && offset + 9 < data.length && length >= 7) {
      const height = (data[offset + 5] << 8) | data[offset + 6];
      const width = (data[offset + 7] << 8) | data[offset + 8];
      return width > 0 && height > 0 && width <= MAX_ARTWORK_DIMENSION && height <= MAX_ARTWORK_DIMENSION
        ? { width, height }
        : null;
    }
    if (length < 2) break;
    offset += length + 2;
  }
  return null;
}

export function inspectArtworkBytes(data: ArrayBuffer, mimeType?: ArtworkMimeType): { mimeType: ArtworkMimeType; width: number; height: number } {
  if (data.byteLength === 0 || data.byteLength > MAX_ARTWORK_BYTES) {
    throw new Error(`Artwork must be no larger than ${Math.round(MAX_ARTWORK_BYTES / (1024 * 1024))} MB.`);
  }
  const bytes = new Uint8Array(data);
  const detected: Array<[ArtworkMimeType, { width: number; height: number } | null]> = [
    ['image/png', inspectPng(bytes)],
    ['image/jpeg', inspectJpeg(bytes)],
    ['image/webp', inspectWebp(bytes)],
    ['image/gif', inspectGif(bytes)],
  ];
  const match = detected.find(([kind, dimensions]) => dimensions && (!mimeType || mimeType === kind));
  if (!match || !match[1]) throw new Error('The artwork image is corrupt or uses an unsupported format.');
  if (match[1].width * match[1].height > MAX_ARTWORK_PIXELS) {
    throw new Error('Artwork dimensions exceed the 16 million pixel safety limit.');
  }
  return { mimeType: match[0], ...match[1] };
}

export async function validateArtworkBytes(
  data: ArrayBuffer,
  mimeType?: ArtworkMimeType,
): Promise<{ mimeType: ArtworkMimeType; width: number; height: number }> {
  const inspected = inspectArtworkBytes(data, mimeType);
  // Structural checks above keep validation available in workers and tests.
  // When the browser decoder is available, also reject images with malformed
  // pixel streams that happen to contain plausible headers.
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(new Blob([data], { type: inspected.mimeType }));
    try {
      if (
        bitmap.width !== inspected.width ||
        bitmap.height !== inspected.height ||
        bitmap.width > MAX_ARTWORK_DIMENSION ||
        bitmap.height > MAX_ARTWORK_DIMENSION
      ) throw new Error('The artwork image is corrupt or uses an unsupported format.');
    } finally {
      bitmap.close();
    }
  }
  return inspected;
}

export function artworkReference(artwork: GameArtwork): ArtworkReference {
  return {
    mimeType: artwork.mimeType,
    byteLength: artwork.data.byteLength,
    fileName: artwork.fileName,
    source: artwork.source,
    ...(artwork.width ? { width: artwork.width } : {}),
    ...(artwork.height ? { height: artwork.height } : {}),
  };
}

export async function artworkFromFile(file: File, source: ArtworkSource = 'user'): Promise<GameArtwork> {
  if (file.size > MAX_ARTWORK_BYTES) {
    throw new Error(`Artwork must be no larger than ${Math.round(MAX_ARTWORK_BYTES / (1024 * 1024))} MB.`);
  }
  const data = await file.arrayBuffer();
  const requested = isArtworkMimeType(file.type) ? file.type : artworkMimeForName(file.name) ?? undefined;
  const inspected = await validateArtworkBytes(data, requested);
  return {
    id: '',
    data,
    mimeType: inspected.mimeType,
    byteLength: data.byteLength,
    fileName: file.name.replace(/[\\/]/g, '_').slice(-160) || 'cover',
    source,
    width: inspected.width,
    height: inspected.height,
  };
}

function safeArchivePath(name: string): string | null {
  if (!name || name.length > 240 || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name)) return null;
  const parts = name.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return name;
}

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  crc32: number;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) return offset;
  }
  throw new Error('The ZIP archive is missing a central directory.');
}

function readZipEntries(buffer: ArrayBuffer): ZipEntry[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const end = findEndOfCentralDirectory(bytes);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) throw new Error('Multi-disk ZIP archives are not supported.');
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (!count || count > MAX_ARCHIVE_ENTRIES || centralOffset + centralSize > bytes.length) throw new Error('The ZIP archive is malformed or contains too many files.');
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('The ZIP central directory is malformed.');
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    if (
      (flags & 0x1) !== 0 ||
      (compressionMethod !== 0 && compressionMethod !== 8) ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) throw new Error('The ZIP archive uses encryption, ZIP64, or an unsupported compression method.');
    const nameStart = offset + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > bytes.length) throw new Error('The ZIP central directory is truncated.');
    const name = safeArchivePath(decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)));
    if (name) entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset, crc32 });
    offset = next;
  }
  return entries;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateRaw(data: Uint8Array, expectedSize: number): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot safely open deflated ZIP archives.');
  const compressed = new ArrayBuffer(data.byteLength);
  new Uint8Array(compressed).set(data);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > expectedSize || total > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new Error('The ZIP entry expands beyond the safe size limit.');
    }
    chunks.push(result.value);
  }
  if (total !== expectedSize) throw new Error('The ZIP entry is truncated or corrupt.');
  const output = new Uint8Array(new ArrayBuffer(total)) as Uint8Array<ArrayBuffer>;
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

async function readZipEntry(buffer: ArrayBuffer, entry: ZipEntry, limit: number): Promise<ArrayBuffer> {
  if (entry.uncompressedSize > limit || entry.compressedSize > buffer.byteLength) throw new Error('The ZIP entry is too large.');
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) throw new Error('The ZIP local header is malformed.');
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start < 0 || end > bytes.length) throw new Error('The ZIP entry is truncated.');
  const compressed = bytes.subarray(start, end);
  const output = entry.compressionMethod === 0
    ? compressed.slice()
    : await inflateRaw(compressed, entry.uncompressedSize);
  if (output.byteLength !== entry.uncompressedSize || crc32(output) !== entry.crc32) throw new Error('The ZIP entry failed its integrity check.');
  const result = new ArrayBuffer(output.byteLength);
  new Uint8Array(result).set(output);
  return result;
}

function artworkScore(path: string, width: number, height: number): number {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  const value = `${path.toLowerCase()} ${name}`;
  let score = 0;
  if (/(cover|box.?art|box|front|artwork|cartridge)/.test(value)) score += 100;
  if (/(title|promo|poster)/.test(value)) score += 60;
  if (/(thumbnail|thumb|preview)/.test(value)) score += 35;
  if (/(screenshot|screen|icon|logo|sprite|tile|banner)/.test(value)) score -= 30;
  if (width >= 256 && height >= 256) score += 20;
  if (width < 96 || height < 96) score -= 100;
  return score;
}

export async function readRomImport(file: File): Promise<RomImportPayload> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('The ROM import is too large to open safely.');
  const buffer = await file.arrayBuffer();
  if (!file.name.toLowerCase().endsWith('.zip')) {
    if (buffer.byteLength < MIN_ROM_BYTES || buffer.byteLength > MAX_ROM_BYTES) throw new Error('Choose a valid GBA ROM up to 64 MB.');
    return { rom: buffer, fileName: file.name, artworkCandidates: [], warnings: [] };
  }

  const entries = readZipEntries(buffer);
  const romEntries = entries.filter((entry) => extensionOf(entry.name) === 'gba');
  if (romEntries.length === 0) throw new Error('This ZIP does not contain a .gba ROM.');
  const romEntry = romEntries
    .filter((entry) => entry.uncompressedSize >= MIN_ROM_BYTES && entry.uncompressedSize <= MAX_ROM_BYTES)
    .sort((left, right) => right.uncompressedSize - left.uncompressedSize)[0];
  if (!romEntry) throw new Error('The ZIP does not contain a valid GBA ROM up to 64 MB.');
  const rom = await readZipEntry(buffer, romEntry, MAX_ROM_BYTES);
  const candidates: ArtworkCandidate[] = [];
  const warnings: string[] = [];
  let artworkBytes = 0;
  let artworkAttempts = 0;
  const imageEntries = entries
    .filter((entry) => artworkMimeForName(entry.name) !== null)
    .sort((left, right) => artworkScore(right.name, 512, 512) - artworkScore(left.name, 512, 512) || left.name.localeCompare(right.name));
  for (const entry of imageEntries) {
    if (artworkAttempts >= MAX_ARCHIVE_ARTWORK_CANDIDATES) break;
    // Reserve both the attempt and the central-directory declaration before
    // opening the entry. Corrupt images must consume the same bounded budget
    // as valid images; otherwise an archive can hide unbounded work behind
    // repeated failed decodes.
    artworkAttempts += 1;
    artworkBytes += entry.uncompressedSize;
    const mimeType = artworkMimeForName(entry.name)!;
    if (entry.uncompressedSize > MAX_ARTWORK_BYTES || artworkBytes > MAX_ARCHIVE_ARTWORK_BYTES) {
      warnings.push(`${entry.name} was skipped because it is too large.`);
      continue;
    }
    try {
      const data = await readZipEntry(buffer, entry, MAX_ARTWORK_BYTES);
      // A valid ZIP entry cannot expand beyond its declared size, but charge
      // actual bytes as well should a future reader support a streaming
      // descriptor with an inaccurate declaration.
      if (data.byteLength > entry.uncompressedSize) artworkBytes += data.byteLength - entry.uncompressedSize;
      const inspected = await validateArtworkBytes(data, mimeType);
      candidates.push({
        id: '',
        data,
        mimeType: inspected.mimeType,
        byteLength: data.byteLength,
        fileName: entry.name.split('/').pop() || 'cover',
        source: 'zip',
        width: inspected.width,
        height: inspected.height,
        path: entry.name,
        score: artworkScore(entry.name, inspected.width, inspected.height),
      });
    } catch {
      warnings.push(`${entry.name} was skipped because it is corrupt or unsupported.`);
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return { rom, fileName: romEntry.name.split('/').pop() || file.name, artworkCandidates: candidates, warnings };
}