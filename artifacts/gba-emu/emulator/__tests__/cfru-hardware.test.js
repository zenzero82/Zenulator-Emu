'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCoreScript } = require('../fixtures/extract-core');
const { makeSandbox } = require('../fixtures/run-core');

// Hardware-contract tests, not certification of an arbitrary compiled CFRU ROM.
function hardware() {
  const host = makeSandbox();
  const source = extractCoreScript().replace(/\}\)\(\);\s*$/, `
    window.hardware = {
      boot:function(bytes){rom=new Uint8Array(bytes);resetGBA();},
      read:function(a){return r8(a);},
      write:function(a,v){w8(a,v);},
      write16:function(a,v){w16(a,v);},
      battery:function(){return Array.from(sram);},
      type:function(){return saveType;}
    };
  })();`);
  const RealDate = Date;
  host.sandbox.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [2026, 9, 30, 15, 42, 17])); }
  };
  const names = Object.keys(host.sandbox);
  new Function(...names, source)(...names.map(n => host.sandbox[n]));
  const core = host.sandbox.window.hardware;
  const rom = Buffer.alloc(0x1000);
  rom.writeUInt32LE(0xeafffffe, 0);
  rom.write('FLASH1M_V103', 0x200);
  core.boot(rom);
  return core;
}

test('CFRU SiiRtc: MSB-first commands, repeated halfword edges, status and full date', () => {
  const core = hardware();
  const data = v => core.write16(0x080000c4, v);
  const dir = v => core.write16(0x080000c6, v);
  core.write16(0x080000c8, 1);
  function start(command) {
    // Mirrors src/siirtc.c: clock starts high, command bits MSB-first.
    data(1); data(5); dir(7);
    for (let bit = 7; bit >= 0; bit--) {
      const v = 4 | (((command >>> bit) & 1) << 1);
      data(v); data(v); data(v); data(v | 1);
    }
  }
  function read(command, count) {
    start(command); dir(5);
    const bytes = [];
    for (let i = 0; i < count; i++) {
      let value = 0;
      for (let bit = 0; bit < 8; bit++) {
        for (let hold = 0; hold < 5; hold++) data(4);
        data(5);
        value |= ((core.read(0x080000c4) >>> 1) & 1) << bit;
      }
      bytes.push(value);
    }
    data(1); data(1);
    return bytes;
  }
  assert.deepEqual(read(0x63, 1), [0x40], 'RTC probe: battery OK, 24-hour mode');
  assert.deepEqual(read(0x67, 3), [0x95, 0x42, 0x17]);
  assert.deepEqual(read(0x65, 7), [0x26, 0x10, 0x30, 0x05, 0x95, 0x42, 0x17]);
  // CFRU masks the PM flag from the hour before validating BCD.
  assert.equal(read(0x65, 7)[4] & 0x7f, 0x15);
});

test('CFRU Flash 1M: sectors 30/31 survive bank switching and isolated sector erase', () => {
  const core = hardware();
  assert.equal(core.type(), 'flash128');
  const write = (off, v) => core.write(0x0e000000 + off, v);
  const command = v => { write(0x5555, 0xaa); write(0x2aaa, 0x55); write(0x5555, v); };
  const bank = v => { command(0xb0); write(0, v); };
  const program = (off, v) => { command(0xa0); write(off, v); };
  bank(0); program(0xe000, 0x19);
  bank(1);
  // Fill the entire expanded sectors, including their footers.
  for (let off = 0xe000; off <= 0xffff; off++) program(off, (off * 13 + 7) & 0xff);
  bank(0);
  assert.equal(core.read(0x0e00e000), 0x19, 'upper bank must not overwrite lower bank');
  bank(1);
  for (const off of [0xe000, 0xefff, 0xf000, 0xffff])
    assert.equal(core.read(0x0e000000 + off), (off * 13 + 7) & 0xff);
  command(0x80); write(0x5555, 0xaa); write(0x2aaa, 0x55); write(0xe000, 0x30);
  const bytes = core.battery();
  assert.equal(bytes.length, 131072);
  assert.equal(bytes[0xe000], 0x19);
  assert.ok(bytes.slice(0x1e000, 0x1f000).every(v => v === 0xff));
  for (let off = 0xf000; off <= 0xffff; off++)
    assert.equal(bytes[0x10000 + off], (off * 13 + 7) & 0xff);
});
