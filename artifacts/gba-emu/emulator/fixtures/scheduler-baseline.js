// Test/benchmark oracle: restore ONLY the pre-batching two-cycle scheduler.
// All CPU, IRQ, audio, timer, DMA and render code remains the shipped core.
'use strict';
const assert = require('node:assert/strict');

function originalTwoCycleScheduler(source) {
  const marker = source.indexOf('// Only batch a CPU that was already idle');
  const start = source.lastIndexOf('      }else', marker);
  const end = source.indexOf('      // A SIOCNT start write', start);
  assert.ok(start > 0 && end > start, 'halted scheduler anchors must exist');
  source = source.slice(0, start) + `      }
      tickTimers(cycles);
      fc+=cycles;scanlineCycles+=cycles;
` + source.slice(end);
  assert.ok(source.includes('      var cycles=2'), 'cycle declaration anchor must exist');
  return source;
}

function originalTimerTicks(source) {
  const start = source.indexOf('function tickTimers(');
  const end = source.indexOf('function timerOverflowStep(', start);
  assert.ok(start > 0 && end > start);
  return source.slice(0, start) + `function tickTimers(cycles){
  audioCycleAcc+=cycles;
  while(audioCycleAcc>=512){audioCycleAcc-=512;pushAudioSample();}
  for(var t=0;t<4;t++){
    var cntH=io[0x100+t*4+2];
    if(!(cntH&0x80))continue;
    if((cntH&0x4)&&t>0)continue;
    timerPrescaleCnt[t]+=cycles;
    var presc=TIMER_PRESCALE[cntH&3];
    while(timerPrescaleCnt[t]>=presc){timerPrescaleCnt[t]-=presc;timerOverflowStep(t);}
  }
}
` + source.slice(end);
}
function phaseOneBaseline(source) {
  const marker = source.indexOf('// Only batch a CPU that was already idle');
  const start = source.lastIndexOf('      }else{', marker);
  assert.ok(start > 0 && source.includes(',nextTimerOverflowCycles()'), 'Phase 2 scheduler anchors must match');
  source = source.slice(0, start) +
    source.slice(start).replace('      }else{', '      }else if(!((io[0x102]|io[0x106]|io[0x10A]|io[0x10E])&0x80)){');
  return originalTimerTicks(source.replace(',nextTimerOverflowCycles()', ''));
}
module.exports = { originalTwoCycleScheduler, originalTimerTicks, phaseOneBaseline };