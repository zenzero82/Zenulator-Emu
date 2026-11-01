// Online Link Play core contract. This drives two independent instances of
// the real emulator core and acts as the relay between their bridge messages:
// player 1 starts, player 2 replies, then both receive the same four SIO words.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootCoreInteractive } = require('../fixtures/run-core');

const TEST_ROM = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'test-rom.gba'));
const IO = 0x04000000;

function lastOfType(handle, type) {
  return handle.posted.filter((item) => item.type === type).pop() || null;
}

function write16(handle, address, value) {
  handle.send({ type: 'writeMem8', addr: address, value: value & 0xff });
  handle.send({ type: 'writeMem8', addr: address + 1, value: (value >>> 8) & 0xff });
}

function read32(handle, address) {
  const before = handle.posted.length;
  handle.send({ type: 'readMem32', addr: address });
  const result = handle.posted.slice(before).find((item) => item.type === 'mem32');
  assert.ok(result, `readMem32 response expected at 0x${address.toString(16)}`);
  return result.value >>> 0;
}

function pump(handle, ticks) {
  for (let i = 0; i < ticks; i++) {
    handle.advanceTime(16);
    const due = handle.rafQueue.slice();
    handle.rafQueue.length = 0;
    due.forEach((entry) => entry.fn());
  }
}

function buildSerialBoundaryRom() {
  const rom = Buffer.alloc(0x400);
  rom.writeUInt32LE(0xea00002e, 0); // branch to 0x080000c0
  rom[0xb2] = 0x96;
  let pc = 0xc0;
  let literal = 0x300;
  const literals = new Map();
  const emit = (word) => { rom.writeUInt32LE(word >>> 0, pc); pc += 4; };
  const literalAddress = (value) => {
    if (!literals.has(value)) {
      literals.set(value, literal);
      rom.writeUInt32LE(value >>> 0, literal);
      literal += 4;
    }
    return literals.get(value);
  };
  const ldr = (rd, value) => {
    const target = literalAddress(value);
    const offset = target - (pc + 8);
    emit(0xe59f0000 | (rd << 12) | offset);
  };
  const str = (rd, rn) => emit(0xe5800000 | (rn << 16) | (rd << 12));
  const strh = (rd, rn) => emit(0xe1c000b0 | (rn << 16) | (rd << 12));
  const strb = (rd, rn) => emit(0xe5c00000 | (rn << 16) | (rd << 12));

  ldr(0, IO + 0x128); ldr(1, 0x6000); strh(1, 0); // multiplayer + serial IRQ
  ldr(0, IO + 0x12a); ldr(1, 0x1234); strh(1, 0); // outgoing link word
  ldr(0, IO + 0x128); emit(0xe3a01080); strb(1, 0); // start edge
  ldr(0, 0x02000000); ldr(1, 0xfeedbeef); str(1, 0); // must wait until completion
  emit(0xeafffffe); // spin
  return rom;
}

test('CPU stops at the exact SIOCNT start boundary until the relay completes', async () => {
  const host = await bootCoreInteractive(buildSerialBoundaryRom());
  host.send({ type: 'setLinkSession', connected: true, playerId: 0 });

  pump(host, 1);
  const start = lastOfType(host, 'linkSerialStart');
  host.send({ type: 'getDiag' });
  const startDiag = lastOfType(host, 'diag');
  assert.ok(start, `ROM must reach the multiplayer start write: ${JSON.stringify(startDiag)}`);
  assert.equal(start.data, 0x1234);
  assert.equal(read32(host, 0x02000000), 0, 'instruction after SIO start has not executed');

  const beforeDiag = host.posted.length;
  host.send({ type: 'getDiag' });
  const before = host.posted.slice(beforeDiag).find((item) => item.type === 'diag').instrCount;
  pump(host, 3);
  const afterDiag = host.posted.length;
  host.send({ type: 'getDiag' });
  const after = host.posted.slice(afterDiag).find((item) => item.type === 'diag').instrCount;
  assert.equal(after, before, 'no CPU instructions retire while the cable word is in flight');

  host.send({
    type: 'linkRemoteComplete',
    id: start.id,
    words: [0x1234, 0xabcd, 0xffff, 0xffff],
  });
  pump(host, 1);
  assert.equal(read32(host, 0x02000000), 0xfeedbeef, 'CPU resumes after completion');
});

test('multiplayer SIO exchanges two 16-bit words and raises serial IRQ on both peers', async () => {
  const host = await bootCoreInteractive(TEST_ROM);
  const guest = await bootCoreInteractive(TEST_ROM);

  host.send({ type: 'setLinkSession', connected: true, playerId: 0 });
  guest.send({ type: 'setLinkSession', connected: true, playerId: 1 });

  // Mode 2 (multiplayer) + serial IRQ enable.
  write16(host, IO + 0x128, 0x6000);
  write16(guest, IO + 0x128, 0x6000);
  write16(host, IO + 0x12a, 0x1234);
  write16(guest, IO + 0x12a, 0xabcd);

  // Master start edge.
  host.send({ type: 'writeMem8', addr: IO + 0x128, value: 0x80 });
  const start = lastOfType(host, 'linkSerialStart');
  assert.ok(start, 'player 1 must post a serial start');
  assert.equal(start.data, 0x1234);
  assert.equal(read32(host, IO + 0x128) & 0x80, 0x80, 'master busy while relay is pending');

  // Relay start to player 2; it returns its prepared SIOMLT_SEND value.
  guest.send({ type: 'linkRemoteStart', id: start.id });
  const reply = lastOfType(guest, 'linkSerialReply');
  assert.ok(reply, 'player 2 must post a serial reply');
  assert.equal(reply.id, start.id);
  assert.equal(reply.data, 0xabcd);

  const words = [start.data, reply.data, 0xffff, 0xffff];
  host.send({ type: 'linkRemoteComplete', id: start.id, words });
  guest.send({ type: 'linkRemoteComplete', id: start.id, words });

  // SIOMULTI0/1 are little-endian at 0x120/0x122.
  assert.equal(read32(host, IO + 0x120), 0xabcd1234);
  assert.equal(read32(guest, IO + 0x120), 0xabcd1234);
  assert.equal(read32(host, IO + 0x128) & 0x80, 0, 'master busy clears');
  assert.equal(read32(guest, IO + 0x128) & 0x80, 0, 'guest busy clears');

  // Serial is IF bit 7. Both peers enabled SIO IRQ through SIOCNT bit 14.
  assert.equal((read32(host, IO + 0x200) >>> 16) & 0x80, 0x80);
  assert.equal((read32(guest, IO + 0x200) >>> 16) & 0x80, 0x80);
});

test('player 2 cannot originate a multiplayer transfer', async () => {
  const guest = await bootCoreInteractive(TEST_ROM);
  guest.send({ type: 'setLinkSession', connected: true, playerId: 1 });
  write16(guest, IO + 0x128, 0x2000);
  write16(guest, IO + 0x12a, 0xbeef);
  guest.send({ type: 'writeMem8', addr: IO + 0x128, value: 0x80 });
  assert.equal(lastOfType(guest, 'linkSerialStart'), null);
});