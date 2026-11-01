'use strict';

// DMA keeps separate internal transfer pointers from the memory-mapped
// programming registers. This matters when a DMA target crosses its own
// register block: the current transfer must retain the values latched on the
// enable edge, rather than following the bytes it has just written.
const test = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

function blankRom() {
  const rom = Buffer.alloc(0x400);
  rom.writeUInt32LE(0xEAFFFFFE, 0); // b . — keep the synthetic CPU mapped
  rom[0xB2] = 0x96;
  return rom;
}

function write8(send, addr, value) {
  send({ type: 'writeMem8', addr, value });
}

function write32(send, addr, value) {
  for (let i = 0; i < 4; i++) write8(send, addr + i, value >>> (i * 8));
}

function read32(send, posted, addr) {
  const first = posted.length;
  send({ type: 'readMem32', addr });
  const message = posted.slice(first).find((m) => m.type === 'mem32');
  assert.ok(message, 'core did not answer readMem32');
  return message.value >>> 0;
}

test('unmapped 0x04000400 I/O does not mirror display registers', async () => {
  const { send, posted } = await bootCoreInteractive(blankRom());

  write8(send, 0x04000000, 0x12);
  write8(send, 0x04000001, 0x34);
  write8(send, 0x04000400, 0xAB);
  write8(send, 0x04000401, 0xCD);

  assert.strictEqual(read32(send, posted, 0x04000000) & 0xFFFF, 0x3412,
    'unmapped I/O alias overwrote DISPCNT');
});

test('HBlank DMA reload uses its enable-edge destination latch after self-register writes', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(blankRom());

  // First HBlank overwrites DMA0DAD with 0x56781234. A second HBlank must
  // still target the enable-edge destination (0x040000B4), overwriting it
  // with the next zero-filled source words. Before the latch fix it instead
  // followed the now-corrupted programmed DAD into unmapped memory.
  write32(send, 0x02000000, 0x56781234);
  write32(send, 0x040000B0, 0x02000000); // DMA0SAD
  write32(send, 0x040000B4, 0x040000B4); // DMA0DAD targets itself
  write8(send, 0x040000B8, 2);           // two halfwords
  write8(send, 0x040000B9, 0);
  write8(send, 0x040000BA, 0x60);        // destination reload
  write8(send, 0x040000BB, 0xA2);        // repeat + HBlank timing + enable

  const frame = rafQueue.shift();
  assert.ok(frame, 'core did not schedule a frame');
  advanceTime(17);
  frame.fn();

  assert.strictEqual(read32(send, posted, 0x040000B4), 0,
    'repeat DMA followed a DAD register value it overwrote mid-transfer');
});

test('DMA data crossing DMAxCNT_H cannot disable its already-latched repeat transfer', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(blankRom());

  // The second halfword lands on DMA0CNT_H with bit 15 clear. That is data,
  // not a CPU request to disable the running channel: HBlank requests must
  // continue using the enable-edge timing/repeat configuration.
  write32(send, 0x02000000, 0x56781234);
  write32(send, 0x040000B0, 0x02000000);
  write32(send, 0x040000B4, 0x040000B8); // CNT_L then CNT_H
  write8(send, 0x040000B8, 2);
  write8(send, 0x040000B9, 0);
  write8(send, 0x040000BA, 0x60);
  write8(send, 0x040000BB, 0xA2);

  const frame = rafQueue.shift();
  assert.ok(frame, 'core did not schedule a frame');
  advanceTime(17);
  frame.fn();
  const first = posted.length;
  send({ type: 'getDiag' });
  const diag = posted.slice(first).find((m) => m.type === 'diag');

  assert.ok(diag.dmaCount > 1,
    'DMA data write to CNT_H disabled the active repeat transfer');
  const event = diag.recentEvents.find((e) => e.t === 'dma' && e.ch === 0);
  assert.ok(event, 'DMA diagnostic event missing');
  assert.strictEqual(event.dst, '0x40000b8', 'event did not report the actual transfer destination');
  assert.ok('programmedDst' in event && 'programmedDstAfter' in event &&
    'actualDstAfter' in event, 'event omitted DMA programmed/actual pointer snapshots');
});

test('repeating DMA destination control 2 stays fixed instead of walking through I/O', async () => {
  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(blankRom());

  // DMA0 repeatedly writes one halfword to BG1HOFS. Destination control 2 is
  // fixed; before this regression fix the generic "not decrement" path
  // incremented it every HBlank, eventually reaching the DMA registers and
  // IE/IME. That is the same self-corruption pattern seen in the Shadow
  // Realm halt report.
  write32(send, 0x02000000, 0x12345678);
  write32(send, 0x040000B0, 0x02000000); // DMA0SAD
  write32(send, 0x040000B4, 0x04000014); // DMA0DAD = BG1HOFS
  write8(send, 0x040000B8, 1);           // one halfword per HBlank
  write8(send, 0x040000B9, 0);
  write8(send, 0x040000BA, 0x40);        // destination control = fixed
  write8(send, 0x040000BB, 0xA2);        // repeat + HBlank timing + enable

  const frame = rafQueue.shift();
  assert.ok(frame, 'core did not schedule a frame');
  advanceTime(17);
  frame.fn();

  const first = posted.length;
  send({ type: 'getDiag' });
  const diag = posted.slice(first).find((m) => m.type === 'diag');
  assert.ok(diag && diag.dmaCount > 1, 'fixed DMA did not repeat across HBlanks');
  const events = diag.recentEvents.filter((e) => e.t === 'dma' && e.ch === 0);
  assert.ok(events.length > 1, 'DMA diagnostic ring did not retain repeated transfers');
  assert.ok(events.every((e) => e.dst === '0x4000014' && e.actualDstAfter === '0x4000014'),
    'fixed destination DMA pointer drifted through the I/O block');
  assert.strictEqual(read32(send, posted, 0x040000B4), 0x04000014,
    'fixed DMA destination was overwritten by pointer drift');
});
