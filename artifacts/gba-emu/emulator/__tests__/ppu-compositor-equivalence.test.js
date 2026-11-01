'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCoreScript } = require('../fixtures/extract-core');
const { makeSandbox } = require('../fixtures/run-core');

// Frozen pre-optimization layer selector, including OBJ before equal-priority
// BGs and selection of the second layer. The rest of BOTH cores is the actual
// extracted shipped script (windows, effects, layer generation, probe).
const oldSelector = `  // BG draw order at equal priority: lower BG number on top.
  var order=[0,1,2,3];
  for(x=0;x<SCREEN_W;x++){
    var ctl=0x3F;
    if(anyWin){
      if(win0y&&winInRange(x,io[0x41],io[0x40]))ctl=win0in;
      else if(win1y&&winInRange(x,io[0x43],io[0x42]))ctl=win1in;
      else if(objwinOn&&lineObjWin[x])ctl=objwinCtl;
      else ctl=winout;
    }
    var c1=-1,l1=5,c2=-1,l2=5,objUsed=lineObj[x]>=0&&((ctl>>>4)&1)!==0;
    for(var pr=0;pr<4&&c2<0;pr++){
      if(objUsed&&lineObjPr[x]===pr){
        if(c1<0){c1=lineObj[x];l1=4;}else if(c2<0){c2=lineObj[x];l2=4;}
        objUsed=false;
        if(c2>=0)break;
      }
      for(var oi=0;oi<4;oi++){
        var b=order[oi];
        if(!lineBGEn[b]||lineBGPr[b]!==pr||((ctl>>>b)&1)===0)continue;
        var cb=lineBG[b][x];
        if(cb<0)continue;
        if(c1<0){c1=cb;l1=b;}else if(c2<0){c2=cb;l2=b;break;}
      }
    }
`;

function buildCore(script) {
  const host = makeSandbox();
  const names = Object.keys(host.sandbox);
  const hooked = script.replace(/\}\)\(\);\s*$/, `
    window.compareLine=function(t){
      io.set(t.io);pal.set(t.pal);vram.set(t.vram);
      renderTextBG=renderAffineBG=function(ln,b){
        lineBGPr[b]=t.pr[b];lineBG[b].set(t.bg[b]);
      };
      renderSprites=function(){
        lineObj.set(t.obj);lineObjPr.set(t.objPr);
        lineObjSemi.set(t.semi);lineObjWin.set(t.objWin);
      };
      probeX=t.probe;probeTrace=null;gpuProbe=true;
      renderLine(t.ln);
      return {row:Array.from(pixels.slice(t.ln*SCREEN_W,(t.ln+1)*SCREEN_W)),
        trace:probeTrace};
    };
  })();`);
  new Function(...names, hooked)(...names.map((name) => host.sandbox[name]));
  return host.sandbox.window.compareLine;
}

test('randomized compositor states match the baseline pixels and GPU probe', () => {
  const source = extractCoreScript();
  const start = source.indexOf('  // Priority and enable state are fixed for this scanline.');
  const end = source.indexOf('    if(c1<0){c1=backdrop;l1=5;}', start);
  assert.ok(start > 0 && end > start, 'compositor selector anchors');
  const baseline = buildCore(source.slice(0, start) + oldSelector + source.slice(end));
  const current = buildCore(source);
  let seed = 0x2d61c3af;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 160; i++) {
    const io = new Uint8Array(0x400), pal = new Uint8Array(0x400), vram = new Uint8Array(0x18000);
    for (let j = 0; j < io.length; j++) io[j] = rnd() & 255;
    for (let j = 0; j < pal.length; j++) pal[j] = rnd() & 255;
    // Mode 0-2 use randomized layer buffers, bitmap modes exercise actual VRAM.
    const mode = i % 6;
    io[0] = (io[0] & 0xF0) | mode;
    io[1] = rnd() & 255;
    const bg = Array.from({ length: 4 }, () => Array.from({ length: 240 }, () =>
      (rnd() & 3) === 0 ? -1 : (rnd() & 0x7FFF)));
    const t = { io, pal, vram, bg, pr: Array.from({ length: 4 }, () => rnd() & 3),
      obj: Array.from({ length: 240 }, () => (rnd() & 3) === 0 ? -1 : rnd() & 0x7FFF),
      objPr: Array.from({ length: 240 }, () => rnd() & 3),
      semi: Array.from({ length: 240 }, () => rnd() & 1),
      objWin: Array.from({ length: 240 }, () => rnd() & 1),
      ln: rnd() % 160, probe: rnd() % 240 };
    for (let j = 0; j < vram.length; j++) vram[j] = rnd() & 255;
    assert.deepEqual(current(t), baseline(t), `random compositor case ${i}`);
  }
});