// Cartridge GPIO + S-3511A RTC (Pokemon Emerald "battery has run dry" fix).
//
// Emerald probes the RTC through GPIO regs mapped into ROM space
// (0x80000C4 data / 0xC6 direction / 0xC8 read-enable). It reads the status
// register and treats bit7 (power failure) as "internal battery has run
// dry"; it also requires 24-hour mode (bit6) and a ticking clock. This test
// bit-bangs the real protocol: command 0x96 (status read) then 0xE6 (time
// read), sampling SIO on each SCK rising edge, and checks status==0x40 and
// plausible BCD time. It also checks GPIO regs are invisible (ROM bytes)
// while read-enable is clear.
const test = require('node:test');
const assert = require('node:assert');
const { bootCoreInteractive } = require('../fixtures/run-core.js');

test('S-3511A RTC: status reads 0x40 (battery OK, 24h), time reads BCD', async () => {
  const rom = Buffer.alloc(0x1000);
  const ins = [];
  const MOV_R3 = (imm) => ins.push(0xE3A03000 | imm);
  const STRB_R3_R4 = (off) => ins.push(0xE5C43000 | off); // strb r3,[r4,#off]
  const LDRB_R3_R4 = () => ins.push(0xE5D43000);          // ldrb r3,[r4]
  let outIdx = 0;
  const STORE_SAMPLE = () => ins.push(0xE5C53000 | outIdx++); // strb r3,[r5,#idx]

  const gpio = (v) => { MOV_R3(v); STRB_R3_R4(0); };
  const sendByte = (b) => {
    for (let i = 0; i < 8; i++) {
      const d = ((b >>> i) & 1) << 1;
      gpio(4 | d);     // CS=1, SCK=0, data
      gpio(5 | d);     // SCK rising edge: RTC samples SIO
    }
  };
  const readBits = (n) => {
    for (let i = 0; i < n; i++) {
      gpio(4);                 // SCK low
      gpio(5);                 // SCK rising: RTC drives next bit
      LDRB_R3_R4();            // sample data reg (SIO = bit1)
      STORE_SAMPLE();
    }
  };
  const command = (cmd, nReadBits) => {
    gpio(0);                          // CS low: reset machine
    MOV_R3(7); STRB_R3_R4(2);         // dir: SCK/SIO/CS outputs
    gpio(4);                          // CS high, SCK low
    sendByte(cmd);
    MOV_R3(5); STRB_R3_R4(2);         // dir: SIO now input
    readBits(nReadBits);
    gpio(0);                          // CS low
  };

  // Before read-enable: 0xC4 must read as ROM contents, not GPIO.
  LDRB_R3_R4(); STORE_SAMPLE();
  MOV_R3(1); STRB_R3_R4(4);           // read enable
  const romByteIdx = 0;               // sample slot 0
  command(0xC6, 8);                   // status read (cmd4 LSB-first = MSB-first cmd1)
  command(0xE6, 24);                  // time read: hh mm ss, LSB-first
  // Control write selecting 12-hour mode (bit6 clear), then re-read time.
  gpio(0);
  MOV_R3(7); STRB_R3_R4(2);
  gpio(4);
  sendByte(0x46);                     // cmd4 write (control)
  sendByte(0x00);                     // control = 0: 12-hour mode
  gpio(0);
  command(0xE6, 24);                  // time read again (12-hour hours)
  ins.push(0xEAFFFFFE);               // b .

  // Program lives at 0x200: while GPIO read-enable is set, ROM reads (incl.
  // instruction fetches!) at 0xC4-0xC9 return the GPIO registers, so code
  // must not overlap that window (real carts have the same property).
  const w32 = (a, v) => rom.writeUInt32LE(v >>> 0, a);
  w32(0x00, 0xEA00007E);                      // b 0x200
  const base = 0x200;
  const litBase = base + 8 + ins.length * 4;
  w32(base, 0xE59F4000 | (litBase - base - 8));     // ldr r4,[pc,#..] -> 0x080000C4
  w32(base + 4, 0xE59F5000 | (litBase - base - 8)); // ldr r5,[pc,#..] -> 0x02000000
  ins.forEach((v, i) => w32(base + 8 + i * 4, v));
  w32(litBase, 0x080000C4);
  w32(litBase + 4, 0x02000000);
  rom[0xC4] = 0x5A;                            // ROM byte under the GPIO window

  const { send, posted, rafQueue, advanceTime } = await bootCoreInteractive(rom);
  for (let i = 0; i < 20 && rafQueue.length; i++) { const e = rafQueue.shift(); advanceTime(17); e.fn(); }

  const samples = [];
  for (let a = 0x02000000; a < 0x02000000 + outIdx; a += 4) {
    send({ type: 'readMem32', addr: a });
    const msgs = posted.filter(m => m.type === 'mem32');
    const w = ((msgs[msgs.length - 1].payload || msgs[msgs.length - 1]).value) >>> 0;
    for (let b = 0; b < 4; b++) samples.push((w >>> (b * 8)) & 0xFF);
  }
  const byteFromBits = (start) => {
    let v = 0;
    for (let i = 0; i < 8; i++) v |= ((samples[start + i] >>> 1) & 1) << i;
    return v;
  };

  assert.strictEqual(samples[romByteIdx], 0x5A, 'GPIO regs must be hidden (ROM visible) until read-enable is set');
  const status = byteFromBits(1);
  assert.strictEqual(status & 0x80, 0, 'power-failure flag set: game will say the battery has run dry');
  assert.strictEqual(status & 0x40, 0x40, '24-hour mode bit must be set');
  const hh = byteFromBits(9), mm = byteFromBits(17), ss = byteFromBits(25);
  const bcdOk = (v, max) => (v & 0xF) <= 9 && ((v >>> 4) & 0xF) <= 9 && ((v >>> 4) * 10 + (v & 0xF)) < max;
  assert.ok(bcdOk(hh & 0x3F, 24), 'hours not valid BCD: 0x' + hh.toString(16));
  assert.ok(bcdOk(mm, 60), 'minutes not valid BCD: 0x' + mm.toString(16));
  assert.ok(bcdOk(ss & 0x7F, 60), 'seconds not valid BCD: 0x' + ss.toString(16));
  // After control write with bit6 clear: 12-hour hours (0-11), PM in bit7.
  const hh12 = byteFromBits(33);
  assert.ok(bcdOk(hh12 & 0x3F, 12), '12-hour mode hours must be BCD 0-11: 0x' + hh12.toString(16));
  const h24 = ((hh & 0x3F) >>> 4) * 10 + (hh & 0xF);
  assert.strictEqual((hh12 >>> 7) & 1, h24 >= 12 ? 1 : 0, 'AM/PM flag mismatch');
});
