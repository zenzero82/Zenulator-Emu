'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCoreScript } = require('../fixtures/extract-core');
const { makeSandbox } = require('../fixtures/run-core');

function boot() {
  const host = makeSandbox();
  const source = extractCoreScript().replace(/\}\)\(\);\s*$/, `
    window.cpuTest = {
      boot:function(){rom=new Uint8Array(512);resetGBA();},
      run:function(code){return eval(code);}
    };
  })();`);
  const names = Object.keys(host.sandbox);
  new Function(...names, source)(...names.map(n => host.sandbox[n]));
  host.sandbox.window.cpuTest.boot();
  return { cpu: host.sandbox.window.cpuTest, host };
}

test('ARM self-modification preserves two prefetched opcodes until a branch refill', () => {
  const { cpu } = boot();
  const result = cpu.run(`
    var base=0x03001000;
    // Constructed hardware test, independent of any commercial ROM.
    var code=[0xE1A0100E,0xE3A00000,0xE28FE008,0xE51F0010,
      0xE58E0000,0xE3A000FF,0xE3A000FF,0xE12FFF11];
    code.forEach(function(v,i){w32(base+i*4,v);});
    cpsr=0x1F;r[15]=base+4;r[14]=base+0x100;
    for(var i=0;i<8;i++)stepARM();
    var first=r[0];
    var changed=r32(base+24);
    // BX refills: the overwritten opcode is visible on the next entry.
    r[15]=base+24+4;stepARM();
    [first,changed,r[0]];
  `);
  assert.deepEqual(result, [255, 0xE3A00000, 0]);
});

test('Timer enable reloads from TMxCNT_L and applies a two-clock startup delay', () => {
  const { cpu } = boot();
  const result = cpu.run(`
    w16(0x04000100,0x1234);w16(0x04000102,0x80);
    var enabled=timerCounter[0];
    tickTimers(1);var first=timerCounter[0];
    tickTimers(1);var second=timerCounter[0];
    tickTimers(1);var third=timerCounter[0];
    w16(0x04000102,0);w16(0x04000100,0x5678);w16(0x04000102,0x80);
    [enabled,first,second,third,timerCounter[0]];
  `);
  assert.deepEqual(result, [0x1234, 0x1234, 0x1234, 0x1235, 0x5678]);
});

test('STR PC is not a branch, but a branch to the next address refills prefetch', () => {
  const { cpu } = boot();
  assert.equal(cpu.run(`
    var base=0x03001000;
    [0xE3A00000,0xE584F000,0xE3A00007].forEach(function(v,i){w32(base+i*4,v);});
    cpsr=0x1F;r[15]=base+4;r[4]=base+8;
    stepARM();stepARM();stepARM();r[0];
  `), 7);
  assert.equal(cpu.run(`
    resetGBA();var base=0x03001000;
    [0xE5840000,0xEAFFFFFF,0xE3A00007].forEach(function(v,i){w32(base+i*4,v);});
    cpsr=0x1F;r[15]=base+4;r[4]=base+8;r[0]=0xE3A00009;
    stepARM();stepARM();stepARM();r[0];
  `), 9);
});

test('IWRAM ARM loop produces 4096 clocks at all timer addresses and prescalers', () => {
  const { cpu } = boot();
  for (let timer = 0; timer < 4; timer++) {
    for (let prescaler = 0; prescaler < 4; prescaler++) {
      const result = cpu.run(`
        resetGBA();
        var base=0x03001000;
        // Enable timer, run 1024 SUBS/BNE pairs, then sample the counter.
        var code=[0xE5841000,0xE2522001,0x1AFFFFFD,
          0xE1A00000,0xE1A00000,0xE1D400B0,0xEAFFFFFE];
        code.forEach(function(v,i){w32(base+i*4,v);});
        cpsr=0x1F;r[15]=base+4;r[4]=0x04000100+${timer}*4;
        r[1]=(0x80+${prescaler})<<16;r[2]=1024;
        for(var i=0;i<2052;i++){stepARM();tickTimers(armInstructionCycles);}
        r[0];
      `);
      assert.equal(result, [4096, 64, 16, 4][prescaler],
        `timer ${timer}, prescaler ${prescaler}`);
    }
  }
});

test('Save states preserve prefetched words and older states remain loadable', () => {
  const { cpu, host } = boot();
  cpu.run(`cpsr=0x1F;r[15]=0x03001004;w32(0x03001000,0xE1A00000);
    w32(0x03001004,0xE3A00007);stepARM();w32(0x03001004,0xE3A00009);`);
  host.listeners.message[0]({ data: JSON.stringify({ type: 'saveState' }) });
  const saved = host.posted.find(m => m.type === 'saveState').state;
  cpu.run(`applyState(${JSON.stringify(saved)});stepARM();`);
  assert.equal(cpu.run('r[0]'), 7);
  const legacy = JSON.parse(saved);
  delete legacy.armPipeline;
  cpu.run(`applyState(${JSON.stringify(JSON.stringify(legacy))});stepARM();`);
  assert.equal(cpu.run('r[0]'), 9);
});

test('PC writes align to the current ISA and BX aligns to the target ISA', () => {
  const { cpu } = boot();
  assert.deepEqual(cpu.run(`
    cpsr=0x3F;r[15]=0x03001002;r[14]=0x08000101;
    w16(0x03001000,0x46F7);stepTHUMB();var movPC=r[15]>>>0;
    r[15]=0x03001002;r[0]=1;w16(0x03001000,0x4487);
    stepTHUMB();var addPC=r[15]>>>0;
    r[15]=0x03001002;r[0]=0x08000202;w16(0x03001000,0x4700);
    stepTHUMB();var bxPC=r[15]>>>0;
    setReg(15,0x08000302);
    [movPC,addPC,bxPC,r[15]>>>0,cpsr&0x20];
  `), [0x08000102, 0x03001006, 0x08000204, 0x08000304, 0]);
});
