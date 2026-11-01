'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCoreScript } = require('../fixtures/extract-core');
const { makeSandbox } = require('../fixtures/run-core');

function boot() {
  const host = makeSandbox();
  const source = extractCoreScript().replace(/\}\)\(\);\s*$/, `
    window.irqTest = {
      run:function(code){return eval(code);}
    };
  })();`);
  const names = Object.keys(host.sandbox);
  new Function(...names, source)(...names.map(n => host.sandbox[n]));
  const cpu = host.sandbox.window.irqTest;
  cpu.run(`rom=new Uint8Array(512);resetGBA();
    w32(0x03FFFFFC,0x03001000);
    io[0x200]=1;io[0x202]=1;io[0x208]=1;
    cpsr=0x3F;r[15]=0x08000102;r[14]=0;
    r[0]=11;r[1]=22;r[2]=33;r[3]=44;r[12]=55;`);
  return cpu;
}

test('IRQ entry materializes the BIOS six-word frame on the IRQ stack', () => {
  const cpu = boot();
  assert.deepEqual(cpu.run(`
    checkIRQ();
    [r[13]>>>0,r32(r[13]),r32(r[13]+4),r32(r[13]+8),
      r32(r[13]+12),r32(r[13]+16),r32(r[13]+20),r[14]>>>0];
  `), [0x03007F88, 11, 22, 33, 44, 55, 0x08000104, 0xFFFFFFF0]);
});

test('IRQ return restores edits made to the physical frame and live SPSR', () => {
  const cpu = boot();
  assert.deepEqual(cpu.run(`
    checkIRQ();var sp=r[13]>>>0;
    [101,102,103,104,112,0x08000204].forEach(function(v,i){w32(sp+i*4,v);});
    setCurSPSR(0xA000001F);doIrqReturn();
    [r[0],r[1],r[2],r[3],r[12],r[15]>>>0,cpsr>>>0,
      bankR13[MODE_IRQ]>>>0,bankR14[MODE_IRQ]>>>0];
  `), [101, 102, 103, 104, 112, 0x08000204, 0xA000001F, 0x03007FA0, 0x08000204]);
});

test('Returning from nested IRQ preserves the outer banked SPSR and stacks', () => {
  const cpu = boot();
  assert.deepEqual(cpu.run(`
    irqSPSR=0x12345678;checkIRQ();
    var outerSP=r[13]>>>0;
    cpsr&=~0x80;r[15]=0x03001044;checkIRQ();
    var innerSP=r[13]>>>0;
    doIrqReturn();var restoredSPSR=irqSPSR>>>0;
    doIrqReturn();
    [outerSP,innerSP,restoredSPSR,irqSPSR>>>0,cpsr>>>0,
      bankR13[MODE_IRQ]>>>0,r[15]>>>0,irqReturnStack.length];
  `), [0x03007F88, 0x03007F70, 0x3F, 0x12345678, 0x3F,
    0x03007FA0, 0x08000102, 0]);
});

test('Normal IRQ return restores original registers and caller stacks', () => {
  const cpu = boot();
  assert.deepEqual(cpu.run(`
    var callerSP=r[13]>>>0,callerLR=r[14]>>>0;checkIRQ();
    r[0]=r[1]=r[2]=r[3]=r[12]=0;doIrqReturn();
    [r[0],r[1],r[2],r[3],r[12],r[13]>>>0,r[14]>>>0,
      callerSP,callerLR,r[15]>>>0,cpsr>>>0];
  `), [11, 22, 33, 44, 55, 0x03007F00, 0,
    0x03007F00, 0, 0x08000102, 0x3F]);
});
