import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectArtworkBytes,
  isCompanionArtwork,
  MAX_ARCHIVE_ARTWORK_CANDIDATES,
  MAX_ARCHIVE_ARTWORK_BYTES,
  MAX_ARTWORK_PIXELS,
  readRomImport,
  type ArtworkMimeType,
} from '@/lib/artwork';

test('matching companion covers are recognized without assigning unrelated images', () => {
  for (const image of ['Game.png', 'GAME.jpg', 'Game.cover.webp', 'Game-cover.gif', 'Game_cover.jpeg', 'Game cover.png']) {
    assert.equal(isCompanionArtwork('Game.gba', image), true, image);
  }
  for (const image of ['Other.png', 'Game.gba', 'cover.png', 'Game.png.exe', 'Game 2.png']) {
    assert.equal(isCompanionArtwork('Game.gba', image), false, image);
  }
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width = 320, height = 240): Uint8Array {
  const output: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, body: number[]) => {
    const typeBytes = Array.from(new TextEncoder().encode(type));
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, body.length, false);
    output.push(...size, ...typeBytes, ...body);
    const checksum = new Uint8Array(4);
    new DataView(checksum.buffer).setUint32(0, crc32(new Uint8Array([...typeBytes, ...body])), false);
    output.push(...checksum);
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  header[8] = 8;
  header[9] = 2;
  chunk('IHDR', Array.from(header));
  chunk('IDAT', [0]);
  chunk('IEND', []);
  return new Uint8Array(output);
}

function zip(entries: Array<{ name: string; data: Uint8Array; declaredSize?: number }>): ArrayBuffer {
  const local: number[] = [];
  const central: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const checksum = crc32(entry.data);
    const localHeader = new ArrayBuffer(30);
    const localView = new DataView(localHeader);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    local.push(...new Uint8Array(localHeader), ...name);
    for (const byte of entry.data) local.push(byte);

    const centralHeader = new ArrayBuffer(46);
    const centralView = new DataView(centralHeader);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.declaredSize ?? entry.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.push(...new Uint8Array(centralHeader), ...name);
    offset += 30 + name.length + entry.data.length;
  }
  const endOffset = local.length;
  const end = new ArrayBuffer(22);
  const endView = new DataView(end);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, endOffset, true);
  const output = new Uint8Array(local.length + central.length + 22);
  output.set(local, 0);
  output.set(central, local.length);
  output.set(new Uint8Array(end), local.length + central.length);
  return output.buffer;
}

function archiveFile(buffer: ArrayBuffer): File {
  return {
    name: 'rom-hack.zip',
    size: buffer.byteLength,
    arrayBuffer: async () => buffer,
  } as File;
}

test('rejects corrupt artwork instead of persisting an image header', () => {
  assert.throws(
    () => inspectArtworkBytes(new TextEncoder().encode('not an image').buffer),
    /corrupt|unsupported/i,
  );
  assert.throws(
    () => inspectArtworkBytes(png().slice(0, -12).buffer),
    /corrupt|unsupported/i,
  );
  assert.throws(
    () => inspectArtworkBytes(png(5000, 4000).buffer),
    /16 million pixel/i,
  );
  assert.equal(MAX_ARTWORK_PIXELS, 16_000_000);
});

test('imports ROM-hack artwork candidates while leaving standalone ROMs without embedded art', async () => {
  const rom = new Uint8Array(192);
  const standalone = { name: 'plain.gba', size: rom.byteLength, arrayBuffer: async () => rom.buffer } as File;
  assert.deepEqual((await readRomImport(standalone)).artworkCandidates, []);

  const archive = zip([
    { name: 'hack.gba', data: rom },
    { name: 'art/cover.png', data: png() },
    { name: 'art/title.png', data: png(640, 480) },
  ]);
  const result = await readRomImport(archiveFile(archive));
  assert.equal(result.rom.byteLength, 192);
  assert.equal(result.artworkCandidates.length, 2);
  assert.equal(result.artworkCandidates[0].source, 'zip');
  assert.equal(result.artworkCandidates[0].mimeType satisfies ArtworkMimeType, 'image/png');
});

test('skips an oversized image in a ZIP without blocking the ROM import', async () => {
  const rom = new Uint8Array(192);
  const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
  const archive = zip([
    { name: 'hack.gba', data: rom },
    { name: 'cover.png', data: oversized },
  ]);
  const result = await readRomImport(archiveFile(archive));
  assert.equal(result.rom.byteLength, 192);
  assert.equal(result.artworkCandidates.length, 0);
  assert.match(result.warnings[0], /too large/i);
});

test('charges corrupt ZIP image attempts and declared bytes before decompression', async () => {
  const rom = new Uint8Array(192);
  const declaredSize = Math.floor(MAX_ARCHIVE_ARTWORK_BYTES / 3);
  const corrupt = new Uint8Array([0x00]);
  const entries = Array.from({ length: MAX_ARCHIVE_ARTWORK_CANDIDATES }, (_, index) => ({
    name: `cover-${String(index).padStart(2, '0')}.png`,
    data: corrupt,
    declaredSize,
  }));
  entries.push({ name: 'cover-valid.png', data: png(), declaredSize: png().byteLength });
  const result = await readRomImport(archiveFile(zip([
    { name: 'hack.gba', data: rom },
    ...entries,
  ])));
  assert.equal(result.artworkCandidates.length, 0, 'the valid image after failed attempts is not decompressed');
  assert.equal(result.warnings.length, MAX_ARCHIVE_ARTWORK_CANDIDATES);
});