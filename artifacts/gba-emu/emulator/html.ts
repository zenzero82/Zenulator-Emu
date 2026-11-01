// GBA Emulator HTML — self-contained WebView page
// Key feature: 64MB ROM support via extended address space mapping
// Standard GBA: ROM at 0x08000000-0x09FFFFFF (32MB)
// Extended:     ROM at 0x0A000000-0x0BFFFFFF maps second 32MB bank (not mirror)

import { BUILD_TAG } from './buildTag';

export const GBA_EMULATOR_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;font-family:monospace}
canvas{image-rendering:pixelated;image-rendering:crisp-edges;width:100%;height:100%;background:#1a1a2e}
#status{position:absolute;bottom:6px;left:50%;transform:translateX(-50%);max-width:92%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#9a9aa2;font-size:9px;background:rgba(0,0,0,.6);padding:2px 8px;border-radius:8px;pointer-events:none}
</style>
</head>
<body>
<canvas id="screen" width="240" height="160"></canvas>
<div id="status">Ready — awaiting ROM</div>
<script>
(function(){'use strict';
var SCREEN_W=240,SCREEN_H=160,CYCLES_PER_SCANLINE=1232,TOTAL_SCANLINES=228;
var ROM_32MB=0x2000000,ROM_64MB=0x4000000;

// Memory
var wram=new Uint8Array(0x40000),iwram=new Uint8Array(0x8000);
var io=new Uint8Array(0x400),pal=new Uint8Array(0x400);
var vram=new Uint8Array(0x18000),oam=new Uint8Array(0x400);
var sram=new Uint8Array(0x20000),rom=null;

// GBA multiplayer serial state. Link Play v1 implements SIO multiplayer
// mode (SIOCNT mode 2), the mode used by two-player cable battles/trades.
// Network transport lives in the React Native host; the core only exposes
// deterministic 16-bit transfers and never sees room or ROM data.
var linkConnected=false,linkPlayerId=0,linkOut=0xFFFF;
var linkBusy=false,linkError=false,linkTransferId=0,linkActiveId=-1;

// CPU
var r=new Int32Array(16),cpsr=0x1F;
var svcR14=0,svcSPSR=0;
var irqSPSR=0;
var MODE_SVC=0x13,MODE_IRQ=0x12,MODE_SYS=0x1F,MODE_USR=0x10;
// User and System modes share one physical register bank on real ARM7TDMI
// hardware (System mode is just "privileged User mode") — they must map to
// the SAME bank key here, or a mode excursion (e.g. an IRQ firing while in
// System mode) loses track of the interrupted mode's stack pointer and
// never restores it on return, corrupting the game's stack after the very
// first interrupt.
function bankKey(m){return(m===MODE_USR||m===MODE_SYS)?'us':m;}
var bankR13={},bankR14={};
bankR13[bankKey(MODE_SYS)]=0x03007F00;bankR14[bankKey(MODE_SYS)]=0;
bankR13[MODE_SVC]=0x03007FE0;bankR13[MODE_IRQ]=0x03007FA0;bankR14[MODE_SVC]=0;bankR14[MODE_IRQ]=0;
function doModeSwitch(newMode){
  var old=cpsr&0x1F;if(old===newMode)return;
  var oldKey=bankKey(old),newKey=bankKey(newMode);
  if(oldKey!==newKey){
    bankR13[oldKey]=r[13];bankR14[oldKey]=r[14];
    r[13]=bankR13[newKey];r[14]=bankR14[newKey];
  }
  cpsr=(cpsr&~0x1F)|newMode;
}
function curSPSR(){var m=cpsr&0x1F;return m===MODE_SVC?svcSPSR:m===MODE_IRQ?irqSPSR:cpsr;}
function setCurSPSR(v){var m=cpsr&0x1F;if(m===MODE_SVC)svcSPSR=v;else if(m===MODE_IRQ)irqSPSR=v;}

// Halted until an enabled interrupt fires (BIOS Halt / IntrWait / VBlankIntrWait)
var halted=false;
// When set (by IntrWait/VBlankIntrWait), the specific IF bit(s) the game is
// actually waiting for. checkIRQ()/doIrqReturn() still dispatch and run
// ANY enabled interrupt that arrives while halted (that's required so the
// dispatched handler can execute at all), but doIrqReturn() re-halts
// instead of letting the game resume if the awaited bit(s) aren't the ones
// that actually got serviced — see doIrqReturn().
var intrWaitFlags=null;

// Timers (0x04000100-0x0400010F)
var timerCounter=[0,0,0,0],timerReload=[0,0,0,0],timerPrescaleCnt=[0,0,0,0];
// Sound: Direct Sound A/B (timer-driven FIFO DMA — this is where m4a-engine
// music and most SFX come from). PSG channels 1-4 are not implemented.
// Each FIFO holds 32 bytes; the game's selected timer pops one signed 8-bit
// sample per overflow, and a drop to <=16 bytes triggers the special
// (timing-mode-3) DMA1/DMA2 refill of 4 words.
var fifoA=new Int8Array(32),fifoB=new Int8Array(32);
var fifoAHead=0,fifoALen=0,fifoBHead=0,fifoBLen=0;
var dsA=0,dsB=0; // current output samples (signed -128..127)
// Fixed-rate output sampler: capture the mixed output every 512 CPU cycles
// (16.78MHz/512 = 32768 Hz) into a ring. Play samples directly at the device
// rate. Emulator fast-forward speeds up both tempo and pitch, without any
// pitch-preserving time-stretch processing.
var AUDIO_RING=32768;
var audioCycleAcc=0,audioRingL=new Float32Array(AUDIO_RING),audioRingR=new Float32Array(AUDIO_RING);
var audioWrite=0,audioRead=0,audioCtx=null,audioNode=null;
var audioMuted=false,audioPaused=false;
var audioNativeActive=true,audioPageVisible=true,audioSilentPlayback=false;
var audioRecoveryTimers=[],audioRecoveryGeneration=0,audioSilentElement=null;
// PSG channels 1-4 (square 1/2, programmable wave, noise) per GBATEK.
// State is advanced from pushAudioSample in 512-cycle quanta (good enough
// resolution: the fastest audible square period is >200 cycles per duty
// step and the output is only observed at 32768 Hz anyway). The frame
// sequencer (length/envelope/sweep) ticks at 512 Hz = every 32768 cycles.
var psgOn=[false,false,false,false];
var DUTY_PAT=[0x01,0x81,0x87,0x7E]; // 12.5% / 25% / 50% / 75%
var sqDutyPos=[0,0],sqTimer=[0,0],sqEnv=[0,0],sqEnvT=[0,0],sqLen=[0,0];
var swpTimer=0,swpShadow=0,swpEnabled=false;
var wavPos=0,wavTimer=0,wavLen=0,wavSample=0;
// 32 bytes = two 16-byte banks; CPU access at 0x90-0x9F hits the bank NOT
// selected for playback (SOUND3CNT_L bit 6), per GBATEK.
var waveRam=new Uint8Array(32);
var noiLfsr=0x7FFF,noiTimer=0,noiEnv=0,noiEnvT=0,noiLen=0;
var psgFrameAcc=0,psgFrame=0,psgLastL=0,psgLastR=0;
function sqFreqOf(i){var b=i===0?0x64:0x6C;return io[b]|((io[b+1]&7)<<8);}
function sqPeriodOf(i){var p=(2048-sqFreqOf(i))*16;return p<64?64:p;}
function noiPeriod(){var v=io[0x7C],rr=v&7,s=(v>>>4)&0xF;return(rr===0?16:32*rr)<<(s+1);}
function sweepCalc(){
  var sr=io[0x60],sh=sr&7,d=swpShadow>>sh;
  return(sr&8)?swpShadow-d:swpShadow+d;
}
function psgTrigger(ch){
  if(ch===0||ch===1){
    var envB=io[ch===0?0x63:0x69];
    if(sqLen[ch]===0)sqLen[ch]=64-(io[ch===0?0x62:0x68]&63);
    sqTimer[ch]=sqPeriodOf(ch);sqDutyPos[ch]=0;
    sqEnv[ch]=envB>>>4;sqEnvT[ch]=envB&7;
    psgOn[ch]=(envB&0xF8)!==0; // DAC off keeps the channel dead
    if(ch===0){
      var sr=io[0x60],time=(sr>>>4)&7;
      swpShadow=sqFreqOf(0);swpTimer=time||8;swpEnabled=time!==0||(sr&7)!==0;
      if((sr&7)&&sweepCalc()>2047)psgOn[0]=false; // immediate overflow check
    }
  }else if(ch===2){
    if(wavLen===0)wavLen=256-io[0x72];
    wavPos=0;wavTimer=(2048-(io[0x74]|((io[0x75]&7)<<8)))*8;
    psgOn[2]=(io[0x70]&0x80)!==0; // bit 7 = channel 3 DAC/playback enable
  }else{
    var e=io[0x79];
    if(noiLen===0)noiLen=64-(io[0x78]&63);
    noiLfsr=0x7FFF;noiTimer=noiPeriod();noiEnv=e>>>4;noiEnvT=e&7;
    psgOn[3]=(e&0xF8)!==0;
  }
}
function psgSeq(){
  psgFrame=(psgFrame+1)&7;
  if((psgFrame&1)===0){ // length counters (256 Hz)
    if((io[0x65]&0x40)&&psgOn[0]&&sqLen[0]>0&&--sqLen[0]===0)psgOn[0]=false;
    if((io[0x6D]&0x40)&&psgOn[1]&&sqLen[1]>0&&--sqLen[1]===0)psgOn[1]=false;
    if((io[0x75]&0x40)&&psgOn[2]&&wavLen>0&&--wavLen===0)psgOn[2]=false;
    if((io[0x7D]&0x40)&&psgOn[3]&&noiLen>0&&--noiLen===0)psgOn[3]=false;
  }
  if(psgFrame===2||psgFrame===6){ // channel-1 sweep (128 Hz)
    var sr=io[0x60],time=(sr>>>4)&7;
    if(psgOn[0]&&swpEnabled&&time&&--swpTimer<=0){
      swpTimer=time;
      var nf=sweepCalc();
      if(nf>2047)psgOn[0]=false;
      else if(sr&7){
        swpShadow=nf;
        io[0x64]=nf&0xFF;io[0x65]=(io[0x65]&~7)|((nf>>>8)&7);
        if(sweepCalc()>2047)psgOn[0]=false;
      }
    }
  }
  if(psgFrame===7){ // envelopes (64 Hz)
    for(var i=0;i<2;i++){
      var e=io[i===0?0x63:0x69],per=e&7;
      if(psgOn[i]&&per&&--sqEnvT[i]<=0){
        sqEnvT[i]=per;
        if(e&8){if(sqEnv[i]<15)sqEnv[i]++;}else if(sqEnv[i]>0)sqEnv[i]--;
      }
    }
    var en=io[0x79],np=en&7;
    if(psgOn[3]&&np&&--noiEnvT<=0){
      noiEnvT=np;
      if(en&8){if(noiEnv<15)noiEnv++;}else if(noiEnv>0)noiEnv--;
    }
  }
}
function psgRun(c){
  psgFrameAcc+=c;
  while(psgFrameAcc>=32768){psgFrameAcc-=32768;psgSeq();}
  for(var i=0;i<2;i++){
    if(!psgOn[i])continue;
    var p=sqPeriodOf(i);
    sqTimer[i]-=c;
    while(sqTimer[i]<=0){sqTimer[i]+=p;sqDutyPos[i]=(sqDutyPos[i]+1)&7;}
  }
  if(psgOn[2]){
    var f=io[0x74]|((io[0x75]&7)<<8),wp=(2048-f)*8;if(wp<32)wp=32;
    var dim=io[0x70]&0x20,size=dim?64:32;
    wavTimer-=c;
    while(wavTimer<=0){wavTimer+=wp;wavPos=(wavPos+1)%size;}
    // Playback starts on the bank selected by bit 6; in 64-sample mode both
    // banks play through in sequence.
    var idx=dim?wavPos:((((io[0x70]>>>6)&1)*32+wavPos)&63);
    var b=waveRam[(idx>>>1)&31];
    wavSample=(idx&1)?(b&0xF):(b>>>4);
  }
  if(psgOn[3]){
    var np=noiPeriod();
    noiTimer-=c;
    while(noiTimer<=0){
      noiTimer+=np;
      var bit=(noiLfsr^(noiLfsr>>>1))&1;
      noiLfsr=(noiLfsr>>>1)|(bit<<14);
      if(io[0x7C]&8)noiLfsr=(noiLfsr&~0x40)|(bit<<6); // 7-bit width
    }
  }
}
function psgActiveBits(){return(psgOn[0]?1:0)|(psgOn[1]?2:0)|(psgOn[2]?4:0)|(psgOn[3]?8:0);}
function fifoPush(which,b){
  b=b<<24>>24;
  if(which===0){if(fifoALen>=32){fifoAHead=(fifoAHead+1)&31;fifoALen--;}fifoA[(fifoAHead+fifoALen)&31]=b;fifoALen++;}
  else{if(fifoBLen>=32){fifoBHead=(fifoBHead+1)&31;fifoBLen--;}fifoB[(fifoBHead+fifoBLen)&31]=b;fifoBLen++;}
}
function fifoRefillDMA(dadAddr){
  for(var d=1;d<=2;d++){
    var st=dma[d];
    if(!st.active||((st.activeCntH>>>12)&3)!==3||(st.dstReload>>>0)!==dadAddr)continue;
    var srcCtl=(st.activeCntH>>>7)&3,srcAddr=st.srcCur>>>0;
    for(var i=0;i<4;i++){
      w32(dadAddr,r32(srcAddr));
      if(srcCtl===0)srcAddr=(srcAddr+4)>>>0;else if(srcCtl===1)srcAddr=(srcAddr-4)>>>0;
    }
    st.srcCur=srcAddr;
    if(st.activeCntH&0x4000)setIF(8+d);
    // Honor DMA Repeat exactly like execDMA: a non-repeating special DMA
    // services ONE FIFO request, then disables itself.
    if(!((st.activeCntH>>>9)&1)){st.active=false;st.cntH&=~0x8000;io[st.base+0xA+1]&=~0x80;}
  }
}
function pushAudioSample(){
  psgRun(512);
  var l=0,rr=0;
  psgLastL=0;psgLastR=0;
  if(io[0x84]&0x80){
    var sh=io[0x82]|(io[0x83]<<8);
    var a=(dsA/128)*((sh&4)?1:0.5),b=(dsB/128)*((sh&8)?1:0.5);
    if(sh&0x200)l+=a;if(sh&0x100)rr+=a;
    if(sh&0x2000)l+=b;if(sh&0x1000)rr+=b;
    // PSG mix: SOUNDCNT_L panning/volume, SOUNDCNT_H bits 0-1 volume ratio.
    var cl=io[0x80]|(io[0x81]<<8);
    var d0=0,d1=0,d2=0,d3=0;
    if(psgOn[0])d0=((DUTY_PAT[(io[0x62]>>>6)&3]>>>sqDutyPos[0])&1)?sqEnv[0]:0;
    if(psgOn[1])d1=((DUTY_PAT[(io[0x68]>>>6)&3]>>>sqDutyPos[1])&1)?sqEnv[1]:0;
    if(psgOn[2]){
      // Volume code (SOUND3CNT_H bits 13-14): 0/100/50/25%, force-75% bit 15.
      if(io[0x73]&0x80)d2=(wavSample*3)>>>2;
      else{var vc=(io[0x73]>>>5)&3;d2=vc===0?0:vc===1?wavSample:vc===2?(wavSample>>>1):(wavSample>>>2);}
    }
    if(psgOn[3])d3=((~noiLfsr)&1)?noiEnv:0;
    var ratio=(sh&3)===0?0.25:(sh&3)===1?0.5:1;
    var pl=0,pr=0;
    if(cl&0x1000)pl+=d0;if(cl&0x0100)pr+=d0;
    if(cl&0x2000)pl+=d1;if(cl&0x0200)pr+=d1;
    if(cl&0x4000)pl+=d2;if(cl&0x0400)pr+=d2;
    if(cl&0x8000)pl+=d3;if(cl&0x0800)pr+=d3;
    pl=(pl/60)*((((cl>>>4)&7)+1)/8)*ratio;
    pr=(pr/60)*(((cl&7)+1)/8)*ratio;
    psgLastL=pl;psgLastR=pr;
    l+=pl;rr+=pr;
  }
  var i=audioWrite&(AUDIO_RING-1);
  audioRingL[i]=l*0.5;audioRingR[i]=rr*0.5;
  audioWrite++;
  // Continue mixer/diagnostic sampling while muted, but never queue old sound
  // to replay when the app returns to the foreground or is unmuted.
  if(!audioCanPlay())audioRead=audioWrite;
}
function initAudio(){
  if(audioCtx)return;
  try{
    var AC=window.AudioContext||window.webkitAudioContext;
    if(!AC)return;
    audioCtx=new AC();
    audioRead=audioWrite;
    audioNode=audioCtx.createScriptProcessor(1024,0,2);
    var outputStats=audioNode.outputStats={underruns:0,missingSamples:0,droppedSamples:0,callbacks:0,maxCallbackGapMs:0,lastCallbackMs:0};
    audioNode.onaudioprocess=function(ev){
      var L=ev.outputBuffer.getChannelData(0),R=ev.outputBuffer.getChannelData(1);
      if(!audioCanPlay()){
        L.fill(0);R.fill(0);audioRead=audioWrite;return;
      }
      // Original rate-based playback: no pitch compensation or overlap queue.
      var step=(32768*fastForward)/(audioCtx.sampleRate||32768);
      var callbackMs=audioCtx.currentTime*1000;
      if(outputStats.lastCallbackMs)outputStats.maxCallbackGapMs=Math.max(outputStats.maxCallbackGapMs,callbackMs-outputStats.lastCallbackMs);
      outputStats.lastCallbackMs=callbackMs;outputStats.callbacks++;
      // Bound queued wall-time, not a fixed sample count (which changes
      // duration in FF). Recover to ~40ms instead of replaying stale sound.
      var maxQueued=Math.max(L.length*step*2,32768*fastForward*0.08);
      if(audioWrite-audioRead>maxQueued){
        var nextRead=audioWrite-Math.max(L.length*step,32768*fastForward*0.04);
        outputStats.droppedSamples+=Math.floor(nextRead-audioRead);audioRead=nextRead;
      }
      var missing=0;
      for(var i=0;i<L.length;i++){
        if(audioRead<audioWrite){
          var idx=Math.floor(audioRead)&(AUDIO_RING-1);
          L[i]=audioRingL[idx];R[i]=audioRingR[idx];
          audioRead+=step;
        }else{
          // No synthetic held sample when the producer runs out.
          L[i]=0;R[i]=0;
          missing++;
        }
      }
      if(missing){outputStats.underruns++;outputStats.missingSamples+=missing;}
    };
    audioNode.connect(audioCtx.destination);
    audioCtx.onstatechange=function(){
      if(!audioCtx)return;
      if(!audioCanPlay()&&audioCtx.state==='running')syncAudioPlayback();
      else if(audioCtx.state==='interrupted'&&audioCanPlay())recoverAudio();
    };
    syncAudioPlayback();
  }catch(e){audioCtx=null;}
}
function audioCanPlay(){
  return !audioPaused&&!audioMuted&&audioNativeActive&&audioPageVisible;
}
function audioPromise(result){
  if(result&&result.catch)result.catch(function(e){console.warn('Audio operation failed',String(e));});
}
function cancelAudioRecovery(){
  audioRecoveryGeneration++;
  audioRecoveryTimers.forEach(function(id){clearTimeout(id);});
  audioRecoveryTimers=[];
}
function prepareSilentPlayback(){
  if(!audioSilentPlayback)return;
  // WebKit's playback session ignores the ringer switch, unlike ambient Web Audio.
  try{if(navigator.audioSession)navigator.audioSession.type='playback';}catch(e){
    console.warn('Playback session unavailable',String(e));
  }
  if(!audioSilentElement){
    // Older WebKit needs an active media element to select the playback route.
    // One second of digital silence; no downloaded media or microphone permission.
    var wav=new Uint8Array(8044),view=new DataView(wav.buffer);
    function text(at,s){for(var i=0;i<s.length;i++)wav[at+i]=s.charCodeAt(i);}
    text(0,'RIFF');view.setUint32(4,8036,true);text(8,'WAVE');text(12,'fmt ');
    view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,8000,true);view.setUint32(28,8000,true);
    view.setUint16(32,1,true);view.setUint16(34,8,true);text(36,'data');
    view.setUint32(40,8000,true);wav.fill(128,44);
    var bytes='';for(var j=0;j<wav.length;j++)bytes+=String.fromCharCode(wav[j]);
    audioSilentElement=new Audio('data:audio/wav;base64,'+btoa(bytes));
    audioSilentElement.loop=true;
    audioSilentElement.setAttribute('playsinline','');
  }
  audioPromise(audioSilentElement.play());
}
function tryResumeAudio(){
  if(!audioCtx||!audioCanPlay())return;
  try{
    prepareSilentPlayback();
    // iOS can report "interrupted", not just "suspended".
    if(audioCtx.state!=='running'&&audioCtx.state!=='closed')audioPromise(audioCtx.resume());
  }catch(e){console.warn('Audio resume failed',String(e));}
}
function recoverAudio(){
  cancelAudioRecovery();
  if(!audioCtx||!audioCanPlay())return;
  var generation=audioRecoveryGeneration,ctx=audioCtx,initialTime=ctx.currentTime;
  tryResumeAudio();
  [200,750,1500].forEach(function(delay){
    audioRecoveryTimers.push(setTimeout(function(){
      if(generation!==audioRecoveryGeneration||!audioCanPlay())return;
      if(delay===1500&&(ctx.state!=='running'||ctx.currentTime===initialTime)){
        // Replace only the audio output graph. CPU, ROM, saves and mixer state stay intact.
        ctx.onstatechange=null;
        if(audioNode){audioNode.onaudioprocess=null;audioNode.disconnect();}
        audioPromise(ctx.close());
        audioCtx=null;audioNode=null;
        audioRead=audioWrite;
        initAudio();
        // Bound the recovery to one rebuild; the next user interaction can retry.
        cancelAudioRecovery();
      }else tryResumeAudio();
    },delay));
  });
}
function syncAudioPlayback(){
  var blocked=!audioCanPlay();
  if(blocked){
    audioRead=audioWrite;
    cancelAudioRecovery();
    if(audioSilentElement)audioSilentElement.pause();
    try{if(audioCtx&&audioCtx.state==='running')audioPromise(audioCtx.suspend());}catch(e){
      console.warn('Audio suspend failed',String(e));
    }
  }else recoverAudio();
}
function setAudioPaused(paused){
  audioPaused=!!paused;
  syncAudioPlayback();
}
function setAudioMuted(muted){
  audioMuted=!!muted;
  syncAudioPlayback();
}
var TIMER_PRESCALE=[1,64,256,1024];

// DMA channels (0x040000B0-0x040000DF)
var dma=[];
// The memory-mapped SAD/DAD/CNT registers are programming snapshots. A
// transfer gets its own source, destination, count, control, and reload
// destination on the enable edge; later bus writes (including a deliberately
// awkward DMA target in the DMA register block) must not retarget it.
for(var _d=0;_d<4;_d++)dma.push({base:0xB0+_d*0xC,sad:0,dad:0,cntL:0,cntH:0,srcCur:0,dstCur:0,dstReload:0,countLatch:0,activeCntH:0,active:false});
// Lets the I/O register write path distinguish a CPU disabling a DMA from a
// DMA data beat which happens to cross DMAxCNT_H.
var dmaBusWrite=false;

// Cart save memory: type auto-detected from ROM header strings
var saveType='sram'; // 'sram' | 'flash64' | 'flash128' | 'eeprom'

// ---- Cartridge GPIO + Seiko S-3511A RTC (Pokemon RSE/FRLG boards) ----
// GPIO regs live in ROM space: 0xC4 data, 0xC6 direction, 0xC8 control.
// Reads return register values only while control bit0 (read enable) is set;
// otherwise the underlying ROM bytes are returned.
var gpioData=0,gpioDir=0,gpioReadEnable=0;
var rtcBits=0,rtcBitCount=0,rtcCmd=-1,rtcParamLeft=0;
var rtcOut=[],rtcOutBit=0,rtcSioOut=0,rtcPrevSCK=0;
var rtcControl=0x40; // 24-hour mode, power-failure flag CLEAR (battery OK)
function rtcResetMachine(){rtcBits=0;rtcBitCount=0;rtcCmd=-1;rtcParamLeft=0;rtcOut.length=0;rtcOutBit=0;rtcSioOut=0;}
function gpioReset(){gpioData=0;gpioDir=0;gpioReadEnable=0;rtcPrevSCK=0;rtcControl=0x40;rtcResetMachine();}
function bcd(n){return(((n/10)|0)<<4)|(n%10);}
function rtcTimeBytes(full){
  var d=new Date();
  var h=d.getHours(),pm=h>=12?0x80:0;
  // 12-hour mode (control bit6 clear): hours 0-11 with the AM/PM flag in
  // bit7; 24-hour mode keeps 0-23 (the flag still mirrors PM on real S-3511A).
  var hb=bcd((rtcControl&0x40)?h:(h%12))|pm;
  var t=[hb,bcd(d.getMinutes()),bcd(d.getSeconds())];
  if(!full)return t;
  return[bcd(d.getFullYear()%100),bcd(d.getMonth()+1),bcd(d.getDate()),bcd(d.getDay()),t[0],t[1],t[2]];
}
function rtcProcessByte(b){
  if(rtcCmd===-1){
    // Command byte: low nibble must be 6; some code sends it MSB-first.
    if((b&0x0F)!==6){var r=0;for(var i=0;i<8;i++)r|=((b>>>i)&1)<<(7-i);b=r;}
    if((b&0x0F)!==6){rtcResetMachine();return;}
    // Command numbers as RECEIVED LSB-first. The S-3511A datasheet numbers
    // (and pokeemerald's siirtc.c) are MSB-first, so they arrive bit-
    // reversed: reset=0, datetime=2, forceIRQ=3, control/status=4, time=6.
    var cmd=(b>>>4)&7,read=(b&0x80)!==0;
    rtcCmd=cmd;
    if(read){
      if(cmd===4)rtcOut=[rtcControl];
      else if(cmd===2)rtcOut=rtcTimeBytes(true);
      else if(cmd===6)rtcOut=rtcTimeBytes(false);
      else rtcOut=[];
      rtcOutBit=0;
    }else{
      if(cmd===0){rtcControl=0x40;rtcParamLeft=0;} // reset
      else if(cmd===4)rtcParamLeft=1;               // control write
      else if(cmd===2)rtcParamLeft=7;               // set date/time (ignored)
      else if(cmd===6)rtcParamLeft=3;               // set time (ignored)
      else rtcParamLeft=0;
    }
  }else if(rtcParamLeft>0){
    if(rtcCmd===4)rtcControl=b&0x7F; // power-failure flag not settable
    rtcParamLeft--;
  }
}
function gpioWriteData(v){
  // Only pins configured as outputs (dir=1) are driven by the GBA.
  var eff=(v&gpioDir)|(gpioData&~gpioDir&0x0F);
  var cs=(eff>>>2)&1,sck=eff&1,sio=(eff>>>1)&1;
  if(!cs){rtcResetMachine();}
  else if(sck&&!rtcPrevSCK){ // SCK rising edge
    if(rtcOut.length){ // read mode: shift out LSB-first per byte
      var byteIdx=(rtcOutBit>>>3);
      rtcSioOut=byteIdx<rtcOut.length?((rtcOut[byteIdx]>>>(rtcOutBit&7))&1):0;
      rtcOutBit++;
    }else{ // shift in
      rtcBits|=sio<<rtcBitCount;
      if(++rtcBitCount===8){var by=rtcBits;rtcBits=0;rtcBitCount=0;rtcProcessByte(by);}
    }
  }
  rtcPrevSCK=sck;
  gpioData=eff;
}
function gpioRead(off){
  if(off===0xC4){
    // Input pins (dir=0) read from the device; SIO carries RTC output.
    var inBits=(rtcSioOut<<1)&~gpioDir;
    return((gpioData&gpioDir)|inBits)&0x0F;
  }
  if(off===0xC6)return gpioDir&0x0F;
  if(off===0xC8)return gpioReadEnable&1;
  return 0;
}
var flashBank=0,flashCmdStage=0,flashIdMode=false,flashProgramMode=false;
var eepromData=new Uint8Array(0x2000);
var eepromMode='idle',eepromWriteBuf=[],eepromReadQueue=[],eepromCurAddr=0,eepromAddrBits=6;
// Battery-save persistence: any write into cart save memory (SRAM byte
// write, flash program/erase, EEPROM 64-bit commit) marks the save dirty;
// runFrame flushes dirty save memory to the native host about once per
// second (and on pagehide) as a checksummed base64 snapshot. The flush
// deliberately lives at the TOP of runFrame, before the running/stuck
// early-return, so a wedged core can never strand an unflushed save.
var batteryDirty=false,batterySaveCleared=false,lastBatteryFlushMs=0;

var scanline=0,scanlineCycles=0,hblankFlagged=false;
var fastForward=1; // multiplier of emulated clock time (also changes audio pitch)
// Explicit native-host handshake: do not change WKWebView or browser pacing.
var nativeHostPlatform='';
var keyinput=0x3FF;
var running=false,frameTimer=null,frameTimerTimeout=false;
// Bound time debt to four NORMAL-speed frames, scaled by the requested
// multiplier. A fixed four-frame cap silently limits 4x to 2x on 30 Hz
// WebViews (eight emulated frames are due per display callback there).
var GBA_CLOCK_HZ=16777216,FRAME_CYCLES=280896;
var MAX_PACING_CYCLES=FRAME_CYCLES*4,MAX_CALLBACK_MS=32;
// The old fixed 10ms normal cap throttled otherwise capable Android devices.
// Reserve time for input/presentation, adapt to throttled display callbacks,
// and allow partial-frame work even on high-refresh displays.
var MIN_CALLBACK_MS=14,UI_RESERVE_MS=2,MAX_FAST_CALLBACK_MS=48;
function frameWorkBudget(elapsed,factor){
  var normal=Math.min(MAX_CALLBACK_MS,Math.max(MIN_CALLBACK_MS,elapsed-UI_RESERVE_MS));
  return factor>1?Math.min(MAX_FAST_CALLBACK_MS,normal*factor):normal;
}
var pacingCycles=0,lastPacingMs=null;
function resetFramePacing(){pacingCycles=0;lastPacingMs=performance.now();}
var perfStats,perfPartialFrameMs=0;
function resetPerformance(){
  perfStats={started:performance.now(),frames:0,frameWorkMs:0,peakFrameWorkMs:0,
    renderSampleMs:0,renderSamples:0,presents:0,presentMs:0,skippedVideoFrames:0,mainThreadStalls:0,budgetYields:0};
  perfPartialFrameMs=0;
}
resetPerformance();
function performanceSnapshot(now){
  var p=perfStats,elapsed=Math.max(1,now-p.started),out=audioNode&&audioNode.outputStats;
  return {emulatedFps:emuFps,actualSpeed:emuFps/(GBA_CLOCK_HZ/FRAME_CYCLES),targetSpeed:fastForward,
    androidHost:nativeHostPlatform==='android'?1:0,androidFastContinuation:useAndroidFastTask()?1:0,
    presentedFps:p.presents*1000/elapsed,averageFrameWorkMs:p.frames?p.frameWorkMs/p.frames:0,
    peakFrameWorkMs:p.peakFrameWorkMs,averageSampledRenderMs:p.renderSamples?p.renderSampleMs/p.renderSamples:0,
    averagePresentMs:p.presents?p.presentMs/p.presents:0,skippedVideoFrames:p.skippedVideoFrames,
    mainThreadStalls:p.mainThreadStalls,budgetYields:p.budgetYields,
    audioUnderruns:out?out.underruns:0,audioMissingSamples:out?out.missingSamples:0,
    audioDroppedSamples:out?out.droppedSamples:0,audioMaxCallbackGapMs:out?out.maxCallbackGapMs:0,
    audioQueuedWallMs:Math.max(0,audioWrite-audioRead)/(32768*fastForward)*1000};
}
function interruptGameplay(){
  fastForward=1;audioRead=audioWrite;releaseSourceKeys(null);resetFramePacing();
  postDebug('gameplayInterrupted',{});
}
var fpsCount=0,fps=0,lastFpsMs=0;

var canvas=document.getElementById('screen');
var ctx=canvas.getContext('2d');
var imgData=ctx.createImageData(SCREEN_W,SCREEN_H);
var presentationData=ctx.createImageData(SCREEN_W,SCREEN_H);
var pixels=new Uint32Array(imgData.data.buffer);
var statusEl=document.getElementById('status');

// ── DIAGNOSTICS ───────────────────────────────────────────────────────────
// This section separates "the render loop is still ticking" from "the GBA
// core is actually making progress", and records enough evidence (a boot
// trace + a bounded event ring buffer) to name a concrete failure reason
// instead of guessing from a frozen frame. See DEBUG_EMULATOR_REPORT.md.
var instrCount=0,swiCount=0,dmaCount=0,irqCount=0,vblankCount=0,undefInstrCount=0;
// Most recent transfer whose destination was palette RAM (DMA or BIOS
// CpuSet/CpuFastSet HLE) — lets the GPU debug report dump the EWRAM source
// buffers to localize palette corruption to a specific pipeline stage.
var palWriteTrace=null;
// Snapshot the transfer's source data AT TRACE TIME (before the copy runs)
// — EWRAM staging buffers get reused between frames, so sampling them later
// at report time could falsely implicate or absolve the commit path.
// CPU-write watch on the game's faded palette staging buffer (pokeemerald
// gPlttBufferFaded, vanilla EWRAM address). Records the LAST few halfword/
// word stores into the first 0x40 bytes plus a code-byte window around the
// writing instruction so the routine can be disassembled offline.
var palWatchBase=0x2037B14,palWatchHits=[],PAL_WATCH_MAX=12;
function palWatchHit(addr,v,sz){
  // lastPC (set by recordStep) is the address of the instruction actually
  // executing this store — r[15] here is the pipelined PC (+8 ARM/+4 THUMB)
  // and would mislabel the writer for offline disassembly.
  // Window pc-96..pc+15: the observed blend loop's back-branch targets
  // pc-76, so this covers the ENTIRE loop body including the unfaded[i]
  // load in the loop head (the previous 32-byte window cut it off).
  var pcv=lastPC>>>0,code=[];
  for(var ci=-96;ci<16;ci++)code.push(r8((pcv+ci)>>>0).toString(16));
  if(palWatchHits.length>=PAL_WATCH_MAX)palWatchHits.shift();
  palWatchHits.push({a:(addr>>>0).toString(16),v:(v>>>0).toString(16),sz:sz,pc:pcv.toString(16),ins:(lastIns>>>0).toString(16),
    regs:[r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7],r[8],r[9],r[10],r[12]].map(function(x){return(x>>>0).toString(16);}).join('/'),
    thumb:(cpsr>>>5)&1,f:emuFrameCount,code:code.join(',')});
}
function tracePalWrite(via,src,count,w32f,fillf){
  var hw=function(base){var a=[];for(var i=0;i<8;i++)a.push((r16((base+i*2)>>>0)>>>0).toString(16));return a.join(',');};
  palWriteTrace={via:via,src:src>>>0,count:count,w32:!!w32f,fill:!!fillf,frame:emuFrameCount,srcHW:hw(src>>>0),srcMinus400:hw((src-0x400)>>>0)};
}
// BIOS-style 256-entry sine LUT in 8.8 fixed point (full circle = 256).
var biosSinLut=new Int16Array(256);
for(var bsI=0;bsI<256;bsI++)biosSinLut[bsI]=Math.round(Math.sin(bsI*Math.PI/128)*256);
function biosSin(i){return biosSinLut[i&0xFF];}
var lastIRQ=null,lastSWI=null,lastCompletedFrame=0,lastPC=0,lastIns=0,lastMode='ARM';
var instrSinceVBlank=0,STUCK_INSTR_THRESHOLD=1000000;
var PC_HISTORY_LEN=8,pcHistory=new Uint32Array(PC_HISTORY_LEN),pcHistoryIdx=0,pcHistoryCount=0;
// One bounded boot trace per reset, not perpetual sampled tracing. Keep the
// first TRACE_MAX samples; dense/jump histories and counters stay live afterward.
var traceLog=[],TRACE_MAX=1200,traceInstrCount=0,traceActive=true;
// Dense ring of the LAST 64 executed instructions (every step, not sampled).
// The sampled traceLog shows a slide already in progress but never the jump
// that started it; this ring captures the exact departure instruction.
var DENSE_N=64,densePC=new Uint32Array(DENSE_N),denseINS=new Uint32Array(DENSE_N),denseMODE=new Uint8Array(DENSE_N),denseIdx=0,denseCount=0;
// Ring of the last 32 control-flow DISCONTINUITIES (taken jumps). A slide
// through zero-filled memory executes thousands of sequential instructions
// and flushes the dense ring, but contains no jumps — so the one bad jump
// that STARTED the slide survives here. Identical back-to-back jumps (loop
// back-edges) are deduped into a count so a poll loop can't flood the ring.
var JUMP_N=32,jumpFrom=new Uint32Array(JUMP_N),jumpTo=new Uint32Array(JUMP_N),jumpCnt=new Uint32Array(JUMP_N),jumpIdx=0,jumpCount=0;
var prevStepPC=-1,prevStepSize=4;
function recordJump(from,to){
  var last=(jumpIdx-1+JUMP_N)&(JUMP_N-1);
  if(jumpCount>0&&jumpFrom[last]===(from>>>0)&&jumpTo[last]===(to>>>0)){jumpCnt[last]++;return;}
  jumpFrom[jumpIdx]=from>>>0;jumpTo[jumpIdx]=to>>>0;jumpCnt[jumpIdx]=1;
  jumpIdx=(jumpIdx+1)&(JUMP_N-1);if(jumpCount<JUMP_N)jumpCount++;
}
var recentEvents=[],RECENT_MAX=20;
var fbHashPrev=-1,fbHashRepeatCount=0,fbChangedEver=false;
var uiFrameCount=0,uiFps=0,lastUiFpsMs=0;
var emuFrameCount=0,emuFps=0,lastEmuFpsMs=0;
var ipsCount=0,ips=0,lastIpsMs=0;
var stuckReason=null,cpuErrorInfo=null;
var haltedIdleFrames=0,HALT_STARVE_FRAMES=300; // ~5s of halt with zero retired instructions
var displayEverEnabled=false,BLANK_SCREEN_FRAMES=300; // ~5s with display still blank/no layers

function pushRecent(ev){recentEvents.push(ev);if(recentEvents.length>RECENT_MAX)recentEvents.shift();}
function regionOf(addr){return addr>>>24;}
function recordStep(pc,ins,mode){
  instrCount++;ipsCount++;instrSinceVBlank++;
  lastPC=pc;lastIns=ins;lastMode=mode;
  pcHistory[pcHistoryIdx]=pc;pcHistoryIdx=(pcHistoryIdx+1)&7;
  if(pcHistoryCount<PC_HISTORY_LEN)pcHistoryCount++;
  densePC[denseIdx]=pc;denseINS[denseIdx]=ins;denseMODE[denseIdx]=(mode==='THUMB')?1:0;
  denseIdx=(denseIdx+1)&(DENSE_N-1);if(denseCount<DENSE_N)denseCount++;
  if(prevStepPC>=0&&((pc>>>0)!==((prevStepPC+prevStepSize)>>>0)))recordJump(prevStepPC,pc);
  prevStepPC=pc;prevStepSize=(mode==='THUMB')?2:4;
  if(traceActive){
    traceInstrCount++;
    // First 500 instructions in full, then every 1000th until the boot trace
    // is full. Stop sampling/allocation without stopping crash diagnostics.
    if(traceInstrCount<=500||traceInstrCount%1000===0){
      traceLog.push({n:traceInstrCount,pc:pc,ins:ins,mode:mode,cpsr:cpsr,sp:r[13],lr:r[14],
        scanline:scanline,cycle:instrCount,ime:io[0x208]&1,ie:io[0x200]|(io[0x201]<<8),
        iff:io[0x202]|(io[0x203]<<8),dispstat:io[4]|(io[5]<<8),vcount:scanline});
      if(traceLog.length>=TRACE_MAX)traceActive=false;
    }
  }
}
function fbHash(){
  // Cheap FNV-1a-style rolling hash over a stride of the framebuffer —
  // enough to detect "did the picture actually change" without hashing
  // all 38,400 pixels every single frame.
  var h=0x811c9dc5;
  for(var i=0;i<pixels.length;i+=23){h=Math.imul(h^pixels[i],16777619)>>>0;}
  return h>>>0;
}
function classifyStuck(){
  if(!rom)return null;
  var pc=r[15]>>>0,b=regionOf(pc);
  if(pc===0)return{category:'pc-zero',detail:'PC is 0x00000000'};
  var mapped=(b>=0x02&&b<=0x07)||(b>=0x08&&b<=0x0D);
  // Defense in depth: PC sitting just past the IRQ-return sentinel is a
  // legitimate one-iteration transient (bx-to-MAGIC handled by the next
  // doIrqReturn), never a wild jump — do not classify it as unmapped while
  // a dispatch context (or the underflow-recovery shadow) is still there to
  // unwind it. With neither, it IS dead — report as before.
  if(!mapped&&(pc===IRQ_RETURN_MAGIC||pc===((IRQ_RETURN_MAGIC+4)>>>0)||pc===((IRQ_RETURN_MAGIC+2)>>>0))
    &&(irqReturnStack.length>0||lastDispatchReturn!==null))return null;
  if(!mapped)return{category:'pc-unmapped',detail:'PC entered unmapped memory region (0x'+pc.toString(16)+')'};
  if((b===0x08||b===0x09||b===0x0A||b===0x0B)&&rom){
    // Bank-aware: 0x0A/0x0B is the second 32MB bank on extended (>32MB)
    // ROMs, a mirror otherwise — romMappedOff applies the same mapping r8
    // uses, so a runaway PC in the upper bank is caught too.
    var off=romMappedOff(pc);
    if(off>=rom.length)return{category:'pc-beyond-rom',detail:'PC beyond loaded ROM (mapped offset '+off.toString(16)+' >= '+rom.length.toString(16)+')'};
  }
  if(b===0x0E)return{category:'pc-in-save-memory',detail:'PC executing from save-memory space (0x'+pc.toString(16)+')'};
  if(pcHistoryCount>=PC_HISTORY_LEN&&instrSinceVBlank>500000){
    var uniq={};for(var i=0;i<pcHistory.length;i++)uniq[pcHistory[i]]=1;
    var n=Object.keys(uniq).length;
    // Same full-frame rule as pc-oscillating below: a plain 'b .' idle spin
    // (interrupts still ticking) legitimately sits on ONE address for the
    // ~140k instructions between VBlank resets, so anything under a frame's
    // worth of instructions is a guaranteed false positive.
    if(n===1&&instrSinceVBlank>500000)return{category:'pc-frozen',detail:'PC stuck unchanged at 0x'+pc.toString(16)};
    // Threshold must exceed a FULL FRAME of instructions with margin. At 2
    // cycles per instruction a frame retires ~140k instructions (280896
    // cycles), and a VCOUNT/DISPSTAT poll loop is exactly a tight 2-3 PC
    // oscillation that legitimately spins for most of a frame. The old 50k
    // cutoff killed real games mid-boot while they polled VCOUNT for a
    // specific scanline (false-positive pc-oscillating at scanline 81).
    if(n>1&&n<=3&&instrSinceVBlank>500000)return{category:'pc-oscillating',detail:'PC oscillating between '+n+' addresses with no VBlank progress for '+instrSinceVBlank+' instructions'};
  }
  if(instrSinceVBlank>STUCK_INSTR_THRESHOLD)return{category:'no-vblank',detail:'Over '+STUCK_INSTR_THRESHOLD+' instructions executed without reaching VBlank'};
  if(halted&&instrSinceVBlank>STUCK_INSTR_THRESHOLD)return{category:'halt-never-wakes',detail:'CPU has been HALTed for over '+STUCK_INSTR_THRESHOLD+' instruction-equivalents without an interrupt waking it'};
  return null;
}
// Bundle stamp: proves which OTA build produced a crash report, so stale
// reports from a pre-update bundle can't be mistaken for the current code.
var BUILD_TAG='${BUILD_TAG}';
function buildCrashReport(category,extra){
  // Include the tail of the boot instruction trace (compact hex form).
  // For early-boot crashes the departure point — the exact instruction
  // whose jump left mapped memory — is captured here, which recentEvents
  // alone cannot show. Kept small enough to share from the crash overlay.
  // Anchor the excerpt on the DEPARTURE: the first traced instruction whose
  // PC is outside mapped memory (the crash itself may fire hundreds of
  // nop-slide instructions later, so a plain tail would miss the real jump).
  // NOTE: region 0x00 (BIOS) is deliberately treated as invalid here — this
  // core HLEs all BIOS calls, so the PC legitimately never executes there;
  // a PC in 0x0-0x3FFF is precisely the null-pointer slide we want to catch.
  var firstBad=-1;
  for(var tj=0;tj<traceLog.length;tj++){
    var bb=regionOf(traceLog[tj].pc>>>0);
    var okRegion=(bb>=0x02&&bb<=0x07)||(bb>=0x08&&bb<=0x0D);
    if(!okRegion){firstBad=tj;break;}
  }
  var lo,hi;
  if(firstBad>=0){lo=Math.max(0,firstBad-24);hi=Math.min(traceLog.length,firstBad+8);}
  else{lo=Math.max(0,traceLog.length-32);hi=traceLog.length;}
  var tt=[];
  for(var ti=lo;ti<hi;ti++){
    var e=traceLog[ti];
    tt.push(e.n+':'+(e.pc>>>0).toString(16)+':'+(e.ins>>>0).toString(16)+':'+(e.mode==='THUMB'?'T':'A'));
  }
  // Full register file: for spin-loop reports the loop bounds live in
  // registers (base/end pointers, counters) — without them the trace shows
  // WHERE the loop is but not why its exit condition never fires.
  var regs={};
  for(var ri=0;ri<16;ri++)regs['r'+ri]='0x'+(r[ri]>>>0).toString(16);
  regs.cpsr='0x'+(cpsr>>>0).toString(16);
  // Hex window of code around PC (64 bytes before, 16 after) so the setup
  // instructions that computed those registers can be disassembled offline.
  var cw=null,cpc=(r[15]>>>0);
  if(rom&&regionOf(cpc)>=0x08){
    var ro=romMappedOff(cpc),ws=Math.max(0,ro-64),we=Math.min(rom.length,ro+16),hx='';
    for(var wi=ws;wi<we;wi++)hx+=('0'+rom[wi].toString(16)).slice(-2);
    cw={start:'0x'+ws.toString(16),hex:hx};
  }
  // Dense last-64-steps ring, oldest -> newest: 'pc:ins:T/A'.
  var ls=[];
  for(var di=0;di<denseCount;di++){
    var dj=(denseIdx-denseCount+di+DENSE_N)&(DENSE_N-1);
    ls.push((densePC[dj]>>>0).toString(16)+':'+(denseINS[dj]>>>0).toString(16)+':'+(denseMODE[dj]?'T':'A'));
  }
  // Jump ring, oldest -> newest: 'from>to' or 'from>to xN' for deduped loops.
  var js=[];
  for(var ji=0;ji<jumpCount;ji++){
    var jj=(jumpIdx-jumpCount+ji+JUMP_N)&(JUMP_N-1);
    js.push(jumpFrom[jj].toString(16)+'>'+jumpTo[jj].toString(16)+(jumpCnt[jj]>1?' x'+jumpCnt[jj]:''));
  }
  // Snapshot of IWRAM around the two slide landmarks (call target 0x392c and
  // the redirect point 0x428c) so the report shows what bytes actually live
  // there at crash time.
  var iwWin={};
  var winStarts=[[0x282c,0x94],[0x3920,0x40]];
  for(var wi=0;wi<winStarts.length;wi++){
    var ws=winStarts[wi][0],wl=winStarts[wi][1],hex='';
    for(var wb=0;wb<wl;wb++){var bv=iwram[ws+wb];hex+=(bv<16?'0':'')+bv.toString(16);}
    iwWin['0x300'+ws.toString(16)]=hex;
  }
  // Raw ROM bytes around addresses of interest so crash-time instructions
  // can be disassembled straight from the device report.
  var romWin={};
  if(rom){
    var romRanges=[[0x2d40,0xc0]];
    for(var ri=0;ri<romRanges.length;ri++){
      var rs=romRanges[ri][0],rl=romRanges[ri][1],rhex='';
      for(var rb=0;rb<rl&&rs+rb<rom.length;rb++){var rv=rom[rs+rb];rhex+=(rv<16?'0':'')+rv.toString(16);}
      romWin['0x'+(0x8000000+rs).toString(16)]=rhex;
    }
  }
  // Stack snapshot around the crash-time SP so the popped-garbage frame is visible.
  var spTop=(r[13]>>>0)&0x7FFF,stkHex='',stkBase=(spTop-0x40)&0x7FC0;
  for(var sb=0;sb<0x100;sb++){var sv=iwram[(stkBase+sb)&0x7FFF];stkHex+=(sv<16?'0':'')+sv.toString(16);}
  return{build:BUILD_TAG,jumps:js,saveType:saveType,iwramWindow:iwWin,romWindow:romWin,stackWindow:{base:'0x'+(0x3000000+stkBase).toString(16),hex:stkHex},lastSteps:ls,category:category,pc:'0x'+(r[15]>>>0).toString(16),lr:'0x'+(r[14]>>>0).toString(16),
    instruction:'0x'+(lastIns>>>0).toString(16),mode:lastMode,romAddress:rom?'0x'+romMappedOff(r[15]>>>0).toString(16):null,
    cycle:instrCount,frame:emuFrameCount,lastIRQ:lastIRQ,lastSWI:lastSWI,regs:regs,codeWindow:cw,
    recentEvents:recentEvents.slice(),trace:tt,extra:extra||null};
}

var CRC32_TABLE=(function(){
  var t=new Uint32Array(256);
  for(var n=0;n<256;n++){var c=n;for(var k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0;}
  return t;
})();
function crc32(bytes){
  var c=0xFFFFFFFF;
  for(var i=0;i<bytes.length;i++)c=CRC32_TABLE[(c^bytes[i])&0xFF]^(c>>>8);
  return(c^0xFFFFFFFF)>>>0;
}
function bytesToAscii(bytes,start,len){
  var s='';for(var i=0;i<len;i++){var b=bytes[start+i];s+=(b>=0x20&&b<0x7E)?String.fromCharCode(b):'';}
  return s;
}
// Verifies ROM loading integrity and header sanity (STEP 5 / STEP 6 of the
// debug pass) and reports it verbatim — never silently substitutes a guess
// for "did the ROM actually load correctly".
function validateRomHeader(bytes){
  var info={fileSize:bytes.length,fileSizeMB:(bytes.length/1048576).toFixed(2)};
  info.crc32='0x'+crc32(bytes).toString(16);
  if(bytes.length>=0xC0){
    info.title=bytesToAscii(bytes,0xA0,12);
    info.gameCode=bytesToAscii(bytes,0xAC,4);
    info.makerCode=bytesToAscii(bytes,0xB0,2);
    info.fixedByte0xB2='0x'+bytes[0xB2].toString(16)+(bytes[0xB2]===0x96?' (OK)':' (UNEXPECTED — real GBA BIOS would refuse to boot this)');
    var sum=0;for(var i=0xA0;i<=0xBC;i++)sum+=bytes[i];
    var expectedChecksum=(-(sum+0x19))&0xFF;
    info.headerChecksumStored='0x'+bytes[0xBD].toString(16);
    info.headerChecksumExpected='0x'+expectedChecksum.toString(16);
    info.headerChecksumOk=(bytes[0xBD]===expectedChecksum);
    info.entryInstruction='0x'+(bytes[0]|(bytes[1]<<8)|(bytes[2]<<16)|(bytes[3]<<24)).toString(16>>>0);
    info.entryIsARMBranch=((bytes[3]&0x0F)===0x0A||(bytes[3]===0xEA)); // top byte 0xEA/0xEB = B/BL cond=always
    info.nintendoLogoNote='not validated against reference bytes (reference logo omitted deliberately — see DEBUG_EMULATOR_REPORT.md)';
  }else{
    info.headerError='File is smaller than the 192-byte GBA header ('+bytes.length+' bytes) — cannot be a valid ROM';
  }
  info.mappingMode=bytes.length>ROM_32MB?'extended-64MB':'standard';
  console.log('[GBA] ROM header validation:',info);
  postDebug('romInfo',info);
  if(window.crypto&&window.crypto.subtle&&window.crypto.subtle.digest){
    window.crypto.subtle.digest('SHA-256',bytes.buffer?bytes.buffer:bytes).then(function(hashBuf){
      var hashArr=Array.from(new Uint8Array(hashBuf));
      var hex=hashArr.map(function(b){return b.toString(16).padStart(2,'0');}).join('');
      postDebug('romHash',{sha256:hex});
      console.log('[GBA] ROM SHA-256:',hex);
    }).catch(function(e){console.log('[GBA] SHA-256 unavailable:',e);});
  }
  return info;
}

// ── MEMORY ──────────────────────────────────────────────────────────────────

// Maps a cart-space address (0x08-0x0D regions) to its offset in the loaded
// ROM buffer, mirroring the exact mapping r8 applies: wait-state 0 is the
// first 32MB, wait-state 1 is the second 32MB bank on extended (>32MB) ROMs
// (mirror otherwise), wait-state 2 wraps modulo the full ROM length. Used by
// the crash diagnostics so upper-bank PCs report the right ROM bytes.
function romMappedOff(addr){
  var b=(addr>>>24),o=addr&0x1FFFFFF;
  if(!rom)return o;
  if((b===0x0A||b===0x0B)&&rom.length>ROM_32MB)return o+ROM_32MB;
  if(b===0x0C||b===0x0D)return o%rom.length;
  return o;
}

function r8(addr){
  addr>>>=0;
  switch(addr>>>24){
    case 0x00:return addr<0x4000?0:0xFF; // BIOS (stub)
    case 0x02:return wram[addr&0x3FFFF];
    case 0x03:return iwram[addr&0x7FFF];
    // I/O is a 1KB decode window, not a 1KB mirror repeated through the
    // entire 0x04 address region. In particular, 0x04000400 must not alias
    // DISPCNT at 0x04000000 when a malformed DMA pointer walks past I/O.
    case 0x04:return addr<0x04000400?ioR8(addr&0x3FF):0;
    case 0x05:return pal[addr&0x3FF];
    case 0x06:{var a=addr&0x1FFFF;if(a>=0x18000)a=0x10000+((a-0x10000)&0x7FFF);return vram[a];}
    case 0x07:return oam[addr&0x3FF];
    // ROM wait-state 0: first 32MB always
    case 0x08:case 0x09:
      if(!rom)return 0xFF;
      var off0=addr&0x1FFFFFF;
      if(gpioReadEnable&&off0>=0xC4&&off0<=0xC9)return(off0&1)?0:gpioRead(off0);
      return off0<rom.length?rom[off0]:0xFF;
    // ROM wait-state 1: second 32MB if 64MB ROM, else mirror
    case 0x0A:case 0x0B:
      if(!rom)return 0xFF;
      var off1=addr&0x1FFFFFF;
      if(rom.length>ROM_32MB){off1+=ROM_32MB;}  // 64MB: second bank
      return off1<rom.length?rom[off1]:0xFF;
    // ROM wait-state 2: wrap/mirror
    case 0x0C:case 0x0D:
      if(!rom)return 0xFF;
      return rom[(addr&0x1FFFFFF)%rom.length];
    case 0x0E:
      if(saveType==='flash64'||saveType==='flash128')return flashRead(addr);
      return sram[addr&0xFFFF];
    default:return 0xFF;
  }
}
// Decode ordinary memory once per aligned load, rather than once per byte.
// I/O, cartridge GPIO, flash and boundary reads keep the byte path and its
// side effects. Use the SAME cartridge mapper for CPU fetches and DMA.
function readMemory(addr,width){
  addr>>>=0;
  var mem=null,off=0,region=addr>>>24;
  switch(region){
    case 0x02:mem=wram;off=addr&0x3FFFF;break;
    case 0x03:mem=iwram;off=addr&0x7FFF;break;
    case 0x05:mem=pal;off=addr&0x3FF;break;
    case 0x06:mem=vram;off=addr&0x1FFFF;if(off>=0x18000)off=0x10000+((off-0x10000)&0x7FFF);break;
    case 0x07:mem=oam;off=addr&0x3FF;break;
    case 0x08:case 0x09:case 0x0A:case 0x0B:case 0x0C:case 0x0D:
      if(rom){
        off=romMappedOff(addr);
        if(!(region<=9&&gpioReadEnable&&off<=0xC9&&off+width>0xC4))mem=rom;
      }
      break;
  }
  if(mem&&off+width<=mem.length){
    var value=mem[off]|(mem[off+1]<<8);
    return width===2?value:(value|(mem[off+2]<<16)|(mem[off+3]<<24))>>>0;
  }
  if(width===2)return r8(addr)|(r8(addr+1)<<8);
  return(r8(addr)|(r8(addr+1)<<8)|(r8(addr+2)<<16)|(r8(addr+3)<<24))>>>0;
}
function r16(addr){return readMemory(addr&~1,2);}
function r32(addr){return readMemory(addr&~3,4);}
// ARM7TDMI unaligned LDR: load aligned word, rotate right by 8*(addr&3).
function ldrRot(addr){var v=r32(addr&~3),rot=(addr&3)<<3;return rot?((v>>>rot)|(v<<(32-rot)))>>>0:v;}
// ARM7TDMI unaligned LDRH: load aligned halfword, rotate right by 8 if addr bit0 set.
function ldrhRot(addr){var v=r16(addr&~1);return(addr&1)?(((v>>>8)|(v<<24))>>>0):v;}
// ARM7TDMI unaligned LDRSH degrades to LDRSB of the addressed byte.
function ldrshRot(addr){if(addr&1){var b=r8(addr);return(b&0x80)?(b|0xFFFFFF00)>>>0:b;}var hv=r16(addr);return(hv&0x8000)?(hv|0xFFFF0000)>>>0:hv;}
function w8(addr,v){
  addr>>>=0;v&=0xFF;
  switch(addr>>>24){
    case 0x02:wram[addr&0x3FFFF]=v;break;
    case 0x03:iwram[addr&0x7FFF]=v;break;
    case 0x04:if(addr<0x04000400)ioW8(addr&0x3FF,v);break;
    case 0x05:pal[addr&0x3FF]=v;break;
    case 0x06:{var a=addr&0x1FFFF;if(a>=0x18000)a=0x10000+((a-0x10000)&0x7FFF);vram[a]=v;break;}
    case 0x07:oam[addr&0x3FF]=v;break;
    case 0x08:case 0x09:{
      var goff=addr&0x1FFFFFF;
      if(goff===0xC4)gpioWriteData(v&0x0F);
      else if(goff===0xC6)gpioDir=v&0x0F;
      else if(goff===0xC8)gpioReadEnable=v&1;
      break;}
    case 0x0E:
      if(saveType==='flash64'||saveType==='flash128')flashWrite(addr,v);
      else{sram[addr&0xFFFF]=v;batteryDirty=true;}
      break;
  }
}
function w16(addr,v){addr&=~1;if(((addr-palWatchBase)>>>0)<0x40)palWatchHit(addr,v&0xFFFF,16);w8(addr,v&0xFF);w8(addr+1,(v>>>8)&0xFF);}
function w32(addr,v){addr&=~3;var vv=v>>>0;if(((addr-palWatchBase)>>>0)<0x40)palWatchHit(addr,vv,32);w8(addr,v&0xFF);w8(addr+1,(v>>>8)&0xFF);w8(addr+2,(v>>>16)&0xFF);w8(addr+3,(v>>>24)&0xFF);}

// Ring of recent I/O read offsets. When a game busy-spins at boot (white
// screen, no halt), the register it keeps polling is THE diagnostic clue;
// without this the stuck report shows a PC loop but not what it waits on.
var ioReadRing=new Uint16Array(32),ioReadRingPos=0;
function ioR8(off){
  ioReadRing[ioReadRingPos++&31]=off;
  if(off===0x006)return scanline&0xFF;
  if(off===0x007)return 0;
  // SOUNDCNT_X: bits 0-3 are the live per-channel PSG active flags.
  if(off===0x084)return(io[0x84]&0x80)|psgActiveBits();
  // Wave RAM reads hit the bank NOT selected for playback.
  if(off>=0x090&&off<=0x09F)return waveRam[(((io[0x70]&0x40)?0:16)+(off-0x90))&31];
  if(off===0x130)return keyinput&0xFF;
  if(off===0x131)return(keyinput>>>8)&0xFF;
  if(off===0x128)return linkSioLow();
  for(var t=0;t<4;t++){
    var lo=0x100+t*4;
    if(off===lo)return timerCounter[t]&0xFF;
    if(off===lo+1)return(timerCounter[t]>>>8)&0xFF;
  }
  return io[off];
}
function setByte4(obj,key,idx,v){obj[key]=((obj[key]&~(0xFF<<(idx*8)))|(v<<(idx*8)))>>>0;}
function timerPrevOn(t){return(io[0x100+t*4+2]&0x80)!==0;}

function linkIsMulti(){return(io[0x129]&0x30)===0x20;}
function linkSioLow(){
  if(!linkIsMulti())return io[0x128];
  var v=io[0x128]&3;
  // Multiplayer status: SD high means a cable peer is ready; SI high means
  // no peer. Player ID occupies bits 4-5, error bit 6, busy/start bit 7.
  v|=linkConnected?0x08:0x04;
  v|=(linkPlayerId&3)<<4;
  if(linkError)v|=0x40;
  if(linkBusy)v|=0x80;
  return v;
}
function linkWriteWord(off,v){
  io[off]=v&0xFF;io[off+1]=(v>>>8)&0xFF;
}
function linkRaiseSerialIRQ(){
  if(io[0x129]&0x40)io[0x202]|=0x80;
}
function linkFinish(id,words,failed){
  if(linkConnected&&id!==linkActiveId)return;
  for(var i=0;i<4;i++)linkWriteWord(0x120+i*2,(words[i]===undefined?0xFFFF:words[i])&0xFFFF);
  linkBusy=false;linkError=!!failed;linkActiveId=-1;
  resetFramePacing();
  linkRaiseSerialIRQ();
}
function linkStart(){
  if(!linkIsMulti())return;
  linkOut=io[0x12A]|(io[0x12B]<<8);
  // Player 1 is the multiplayer clock master. Start writes from a slave
  // are ignored until the master sends the transfer edge.
  if(linkConnected&&linkPlayerId!==0)return;
  if(!linkConnected){
    var empty=[0xFFFF,0xFFFF,0xFFFF,0xFFFF];
    empty[linkPlayerId&3]=linkOut;
    linkFinish(-1,empty,true);
    return;
  }
  linkBusy=true;linkError=false;linkActiveId=(++linkTransferId)&0x7FFFFFFF;
  postDebug('linkSerialStart',{id:linkActiveId,data:linkOut});
}
function linkSetSession(connected,playerId){
  resetFramePacing();
  linkConnected=!!connected;linkPlayerId=(playerId|0)&3;
  if(!linkConnected&&linkBusy)linkFinish(linkActiveId,[0xFFFF,0xFFFF,0xFFFF,0xFFFF],true);
  if(!linkConnected){linkBusy=false;linkActiveId=-1;}
}
function linkReceiveStart(id){
  if(!linkConnected||linkPlayerId===0||linkBusy)return;
  linkOut=io[0x12A]|(io[0x12B]<<8);
  linkBusy=true;linkError=false;linkActiveId=id|0;
  resetFramePacing();
  postDebug('linkSerialReply',{id:linkActiveId,data:linkOut});
}
function linkReceiveComplete(id,words){
  if(!Array.isArray(words)||words.length<2)return;
  var safe=[];
  for(var i=0;i<4;i++)safe[i]=((Number(words[i])||0)&0xFFFF);
  linkFinish(id|0,safe,false);
}
function linkAbort(){
  if(!linkBusy)return;
  linkFinish(linkActiveId,[0xFFFF,0xFFFF,0xFFFF,0xFFFF],true);
}

function ioW8(off,v){
  // IF: write-1-to-clear. Must be checked BEFORE the generic io[off]=v
  // assignment — the old order overwrote IF with the written value first,
  // then cleared those same bits, zeroing ALL pending flags (including ones
  // the game wasn't acknowledging), so a second pending interrupt was lost.
  if(off===0x202||off===0x203){io[off]&=~v;return;}
  // Direct Sound FIFO data ports: bytes feed the FIFOs, nothing is stored.
  if(off>=0xA0&&off<=0xA7){fifoPush(off<0xA4?0:1,v);return;}
  // SOUNDCNT_H high byte: bits 3/7 are write-only FIFO reset strobes.
  if(off===0x83){
    io[off]=v&0x77;
    // Reset strobes empty the FIFO -> an armed special DMA refills at once.
    if(v&0x08){fifoALen=0;fifoAHead=0;dsA=0;fifoRefillDMA(0x040000A0);}
    if(v&0x80){fifoBLen=0;fifoBHead=0;dsB=0;fifoRefillDMA(0x040000A4);}
    return;
  }
  // SOUNDCNT_X: only the master-enable bit is writable; bits 0-3 read back
  // from the live channel state (see ioR8). Master off silences the PSGs.
  if(off===0x84){
    io[0x84]=v&0x80;
    if(!(v&0x80)){psgOn[0]=psgOn[1]=psgOn[2]=psgOn[3]=false;}
    return;
  }
  // PSG control/trigger high bytes: bit 7 restarts the channel.
  if(off===0x65||off===0x6D||off===0x75||off===0x7D){
    io[off]=v;
    if(v&0x80)psgTrigger(off===0x65?0:off===0x6D?1:off===0x75?2:3);
    return;
  }
  // Channel DAC power-off kills the channel immediately (env=0, dir=down
  // for ch 1/2/4; playback bit 7 for ch 3).
  if(off===0x63||off===0x69||off===0x79){
    io[off]=v;
    if((v&0xF8)===0)psgOn[off===0x63?0:off===0x69?1:3]=false;
    return;
  }
  if(off===0x70){
    io[off]=v;
    if(!(v&0x80))psgOn[2]=false;
    return;
  }
  // Wave RAM writes land in the bank NOT selected for playback.
  if(off>=0x90&&off<=0x9F){
    waveRam[(((io[0x70]&0x40)?0:16)+(off-0x90))&31]=v;
    return;
  }
  // SIOCNT low byte: baud bits are writable in multiplayer mode; status
  // and player ID are supplied by linkSioLow. Writing start bit begins one
  // network transfer after SIOMLT_SEND has been prepared.
  if(off===0x128){
    io[off]=v&3;
    if((v&0x80)&&linkIsMulti()&&!linkBusy)linkStart();
    return;
  }
  if(off===0x129){io[off]=v&0x70;return;}
  // SIOMLT_SEND is the outgoing 16-bit word in multiplayer mode.
  if(off===0x12A||off===0x12B){
    io[off]=v;linkOut=io[0x12A]|(io[0x12B]<<8);return;
  }
  var previousIoByte=io[off];
  io[off]=v;
  for(var t=0;t<4;t++){
    var lo=0x100+t*4,hi=lo+2;
    if(off===lo){timerReload[t]=(timerReload[t]&0xFF00)|v;return;}
    if(off===lo+1){timerReload[t]=(timerReload[t]&0x00FF)|(v<<8);return;}
    if(off===hi){
      var wasOn=(previousIoByte&0x80)!==0;
      io[hi]=v;
      // Counting begins two clocks after the enable edge.
      if(!wasOn&&(v&0x80)){timerCounter[t]=timerReload[t];timerPrescaleCnt[t]=-2;}
      return;
    }
  }
  for(var d=0;d<4;d++){
    var st=dma[d],sadLo=st.base,dadLo=st.base+4,cntLLo=st.base+8,cntHLo=st.base+0xA;
    if(off>=sadLo&&off<sadLo+4){setByte4(st,'sad',off-sadLo,v);return;}
    if(off>=dadLo&&off<dadLo+4){setByte4(st,'dad',off-dadLo,v);return;}
    if(off===cntLLo){st.cntL=(st.cntL&0xFF00)|v;return;}
    if(off===cntLLo+1){st.cntL=(st.cntL&0x00FF)|(v<<8);return;}
    if(off===cntHLo)return;
    if(off===cntHLo+1){
      var wasEnabled=st.active;
      st.cntH=io[cntHLo]|(v<<8);
      var enable=(st.cntH&0x8000)!==0;
      if(enable&&!wasEnabled){
          // These values are deliberately separate from SAD/DAD/CNT. A
          // repeat transfer reloads the address captured HERE, not a
          // programming register which the transfer may later write through.
          st.srcCur=st.sad;st.dstCur=st.dad;st.dstReload=st.dad;
          st.countLatch=st.cntL;st.activeCntH=st.cntH;st.active=true;
          var timing=(st.activeCntH>>>12)&3;
        if(timing===0)execDMA(d);
        // A special-timing sound DMA with an already-low FIFO services the
        // pending request immediately, not at the next timer overflow.
        else if(timing===3&&(d===1||d===2)){
          var fda=st.dad>>>0;
          if(fda===0x040000A0&&fifoALen<=16)fifoRefillDMA(fda);
          else if(fda===0x040000A4&&fifoBLen<=16)fifoRefillDMA(fda);
        }
        // A running DMA's behavior is latched above. Clearing Enable still
        // stops it, but changing control bits while it remains enabled only
        // changes the programmed register snapshot for its next enable edge.
        } else if(!enable&&!dmaBusWrite){st.active=false;}
      return;
    }
  }
}

// ── PPU ─────────────────────────────────────────────────────────────────────

function rgb5(c){return(((c&0x1F)*527+23)>>6)&0xFF;}
function palColor(idx){
  var c=pal[idx*2]|(pal[idx*2+1]<<8);
  return(0xFF000000|(rgb5(c>>>10)<<16)|(rgb5(c>>>5)<<8)|rgb5(c))>>>0;
}

// Per-scanline layer buffers for priority-correct compositing with color
// effects. Each entry is a 15-bit BGR555 color, or -1 for transparent.
// Rendering each layer separately (instead of painting straight into the
// framebuffer back-to-front with a fixed BG order) is what makes BGCNT
// priority bits, OBJ-vs-BG priority, and BLDCNT alpha/fade effects
// implementable — the fixed-order painter ignored all three, which is
// exactly the class of glitch the Emerald-engine title screen shows
// (wrong layer stacking + missing fade-in/outs).
var lineBG=[new Int32Array(SCREEN_W),new Int32Array(SCREEN_W),new Int32Array(SCREEN_W),new Int32Array(SCREEN_W)];
var lineBGEn=[false,false,false,false],lineBGPr=[0,0,0,0];
var lineObj=new Int32Array(SCREEN_W),lineObjPr=new Uint8Array(SCREEN_W),lineObjSemi=new Uint8Array(SCREEN_W);
var lineObjWin=new Uint8Array(SCREEN_W);
// Window horizontal/vertical containment (GBATEK): X1/Y1 inclusive left/top,
// X2/Y2 exclusive right/bottom; an inverted range (start > end) wraps around
// the screen edge (region = v>=start OR v<end).
function winInRange(v,a,b){return a<=b?(v>=a&&v<b):(v>=a||v<b);}
// Horizontal mosaic pass: each pixel repeats the leftmost pixel of its
// h-wide screen-aligned block.
function mosaicHPass(buf,h){if(h<=1)return;for(var x=0;x<SCREEN_W;x++)buf[x]=buf[x-(x%h)];}
// NOTE on OBJ semantics (GBATEK "OBJ Priority"): hardware scans OAM in
// index order and the FIRST opaque sprite pixel wins per x — even if a
// higher-index sprite has a better (lower) priority attribute. The winner's
// priority attribute is then used against the BG layers (this is the origin
// of the well-known OBJ-vs-BG priority quirk on real hardware). After that
// resolution the OBJ layer is a single pixel per x, so blending never
// combines two sprites — a semi-transparent OBJ blends only with BG or
// backdrop below it. Keep it that way: "sorting sprites by priority first"
// or blending OBJ-under-OBJ is NOT what the console does.
function pal16(idx){return pal[idx*2]|(pal[idx*2+1]<<8);}
// DISPSTAT VCount coincidence: bit2 tracks (VCOUNT === compare value in
// bits 8-15) on every line change, and the VCount IRQ fires on a match when
// bit5 enables it. Called after each scanline increment AND after the
// rollover to 0 (checking only post-increment would make compare value 0
// unreachable).
function checkVCountMatch(){
  if(scanline===io[0x5]){
    io[0x4]|=0x04;
    if(io[0x4]&0x20)setIF(2);
  }else io[0x4]&=~0x04;
}

// Per-line latch of BG1HOFS as each line is actually rendered — HBlank DMA
// scanline effects rewrite it every line, so the single current IO value is
// useless for diagnosing raster waves. gpuProbe suppresses latching (and any
// other frame-state capture) when readGpu re-renders historical rows.
var bg1hofsLatch=new Int32Array(SCREEN_H);
var gpuProbe=false;
// Single-pixel compositor trace (probePixel message): captures the exact
// layer/window/blend decision for one (x,y) so on-device rendering bugs can
// be diagnosed without guessing which input (window ctl, semi flag, masks,
// eva/evb) suppressed or produced an effect.
var probeX=-1,probeTrace=null;
function renderLine(ln){
  var dispcnt=io[0]|(io[1]<<8);
  if(!gpuProbe&&ln<SCREEN_H)bg1hofsLatch[ln]=(io[0x14]|(io[0x15]<<8))&0x1FF;
  var mode=dispcnt&7;
  var base=ln*SCREEN_W;
  var x;
  for(x=0;x<4;x++)lineBGEn[x]=false;
  lineObj.fill(-1);lineObjWin.fill(0);
  // Fill BG layer buffers according to mode
  if(mode===0){
    for(var bg=0;bg<4;bg++)if((dispcnt>>>(8+bg))&1){lineBGEn[bg]=true;renderTextBG(ln,bg);}
  }else if(mode===1){
    if((dispcnt>>>8)&1){lineBGEn[0]=true;renderTextBG(ln,0);}
    if((dispcnt>>>9)&1){lineBGEn[1]=true;renderTextBG(ln,1);}
    if((dispcnt>>>10)&1){lineBGEn[2]=true;renderAffineBG(ln,2);}
  }else if(mode===2){
    if((dispcnt>>>10)&1){lineBGEn[2]=true;renderAffineBG(ln,2);}
    if((dispcnt>>>11)&1){lineBGEn[3]=true;renderAffineBG(ln,3);}
  }else if(mode===3){
    if((dispcnt>>>10)&1){lineBGEn[2]=true;lineBGPr[2]=io[0xC]&3;
      for(x=0;x<SCREEN_W;x++){var o3=(ln*SCREEN_W+x)*2;lineBG[2][x]=vram[o3]|(vram[o3+1]<<8);}}
  }else if(mode===4){
    if((dispcnt>>>10)&1){lineBGEn[2]=true;lineBGPr[2]=io[0xC]&3;
      var pg4=(dispcnt&0x10)?0xA000:0;
      for(x=0;x<SCREEN_W;x++){var pi=vram[pg4+ln*SCREEN_W+x];lineBG[2][x]=pi?pal16(pi):-1;}}
  }else if(mode===5){
    if((dispcnt>>>10)&1){lineBGEn[2]=true;lineBGPr[2]=io[0xC]&3;
      var pg5=(dispcnt&0x10)?0xA000:0;
      for(x=0;x<SCREEN_W;x++){
        if(ln>=128||x>=160){lineBG[2][x]=-1;continue;}
        var o5=pg5+(ln*160+x)*2;lineBG[2][x]=vram[o5]|(vram[o5+1]<<8);
      }}
  }
  if((dispcnt>>>12)&1)renderSprites(ln,mode>=3);

  // Composite with BLDCNT color effects, gated per-pixel by the window
  // layer-enable masks when any window is active (DISPCNT bits 13-15).
  var bldcnt=io[0x50]|(io[0x51]<<8);
  var effect=(bldcnt>>>6)&3;
  var firstMask=bldcnt&0x3F,secondMask=(bldcnt>>>8)&0x3F;
  var bldalpha=io[0x52]|(io[0x53]<<8);
  var eva=Math.min(bldalpha&0x1F,16),evb=Math.min((bldalpha>>>8)&0x1F,16);
  var evy=Math.min(io[0x54]&0x1F,16);
  var backdrop=pal16(0);
  // Windows. WINnH: io[+1]=X1 (left, incl), io[+0]=X2 (right, excl); WINnV
  // same for Y. WININ low byte = win0 controls, high = win1; WINOUT low =
  // outside, high = OBJ window. Control bits: 0-3 BG0-3, 4 OBJ, 5 effects.
  var win0on=(dispcnt>>>13)&1,win1on=(dispcnt>>>14)&1,objwinOn=(dispcnt>>>15)&1;
  var anyWin=(win0on|win1on|objwinOn)!==0;
  var win0y=win0on&&winInRange(ln,io[0x45],io[0x44]);
  var win1y=win1on&&winInRange(ln,io[0x47],io[0x46]);
  var win0in=io[0x48]&0x3F,win1in=io[0x49]&0x3F,winout=io[0x4A]&0x3F,objwinCtl=io[0x4B]&0x3F;
  // Priority and enable state are fixed for this scanline. Sort the enabled
  // BGs once (stable BG number tie-break), rather than scanning all four BGs
  // at each of four priorities for every pixel.
  var order=[0,1,2,3],bgCount=0;
  for(var bgId=0;bgId<4;bgId++)if(lineBGEn[bgId]){
    var pos=bgCount++;
    while(pos>0&&lineBGPr[order[pos-1]]>lineBGPr[bgId]){
      order[pos]=order[pos-1];pos--;
    }
    order[pos]=bgId;
  }
  for(x=0;x<SCREEN_W;x++){
    var ctl=0x3F;
    if(anyWin){
      // Window precedence (GBATEK): win0 > win1 > OBJ window > outside.
      if(win0y&&winInRange(x,io[0x41],io[0x40]))ctl=win0in;
      else if(win1y&&winInRange(x,io[0x43],io[0x42]))ctl=win1in;
      else if(objwinOn&&lineObjWin[x])ctl=objwinCtl;
      else ctl=winout;
    }
    // Find topmost and second color+layer (layer ids: 0-3 BG, 4 OBJ, 5 backdrop)
    var c1=-1,l1=5,c2=-1,l2=5,objUsed=lineObj[x]>=0&&((ctl>>>4)&1)!==0;
    for(var oi=0;oi<bgCount&&c2<0;oi++){
      var b=order[oi];
      // OBJ wins equal-priority ties against every BG. OAM has already
      // resolved overlapping sprites into the one OBJ pixel at this x.
      if(objUsed&&lineObjPr[x]<=lineBGPr[b]){
        if(c1<0){c1=lineObj[x];l1=4;}else {c2=lineObj[x];l2=4;}
        objUsed=false;
        if(c2>=0)break;
      }
      if(((ctl>>>b)&1)===0)continue;
      var cb=lineBG[b][x];
      if(cb<0)continue;
      if(c1<0){c1=cb;l1=b;}else {c2=cb;l2=b;}
    }
    if(objUsed&&c2<0){
      if(c1<0){c1=lineObj[x];l1=4;}else {c2=lineObj[x];l2=4;}
    }
    if(c1<0){c1=backdrop;l1=5;}
    else if(c2<0){c2=backdrop;l2=5;}
    var out=c1;
    // Window bit 5 gates the BLDCNT-selected effect only. The FORCED blend
    // of a semi-transparent OBJ happens regardless of the window's
    // effects-enable bit (hardware-verified; see PPU notes) — it needs only
    // a valid second-target layer below. Gating it on ctl bit 5 rendered
    // pokeemerald-style field shadows (semi OBJ over BG, WININ fx bit off)
    // as opaque black blobs.
    var fxOK=(ctl&0x20)!==0;
    var semiTop=(l1===4)&&lineObjSemi[x];
    if(semiTop&&((secondMask>>>l2)&1)){
      // Semi-transparent OBJ forces alpha blend with the layer below.
      out=blend555(c1,c2,eva,evb);
    }else if(fxOK&&((firstMask>>>l1)&1)){
      if(effect===1&&((secondMask>>>l2)&1))out=blend555(c1,c2,eva,evb);
      else if(effect===2)out=brighten555(c1,evy);
      else if(effect===3)out=darken555(c1,evy);
    }
    if(x===probeX)probeTrace={ctl:ctl,c1:c1,l1:l1,c2:c2,l2:l2,obj:lineObj[x],objPr:lineObjPr[x],semi:lineObjSemi[x],fxOK:fxOK,semiTop:semiTop,effect:effect,firstMask:firstMask,secondMask:secondMask,eva:eva,evb:evb,evy:evy,out:out};
    pixels[base+x]=(0xFF000000|(rgb5(out>>>10)<<16)|(rgb5(out>>>5)<<8)|rgb5(out))>>>0;
  }
}

function blend555(a,b,eva,evb){
  var r=Math.min(31,(((a&0x1F)*eva+(b&0x1F)*evb)>>4));
  var g=Math.min(31,((((a>>>5)&0x1F)*eva+((b>>>5)&0x1F)*evb)>>4));
  var bl=Math.min(31,((((a>>>10)&0x1F)*eva+((b>>>10)&0x1F)*evb)>>4));
  return r|(g<<5)|(bl<<10);
}
function brighten555(c,evy){
  var r=c&0x1F,g=(c>>>5)&0x1F,b=(c>>>10)&0x1F;
  r+=((31-r)*evy)>>4;g+=((31-g)*evy)>>4;b+=((31-b)*evy)>>4;
  return r|(g<<5)|(b<<10);
}
function darken555(c,evy){
  var r=c&0x1F,g=(c>>>5)&0x1F,b=(c>>>10)&0x1F;
  r-=(r*evy)>>4;g-=(g*evy)>>4;b-=(b*evy)>>4;
  return r|(g<<5)|(b<<10);
}

function tp4(tb,ti,px,py){var b=vram[tb+ti*32+py*4+(px>>1)];return px&1?b>>4:b&0xF;}
function tp8(tb,ti,px,py){return vram[tb+ti*64+py*8+px]||0;}

function renderTextBG(ln,bgNum){
  var bgcnt=io[0x8+bgNum*2]|(io[0x9+bgNum*2]<<8);
  lineBGPr[bgNum]=bgcnt&3;
  var buf=lineBG[bgNum];buf.fill(-1);
  // BG mosaic (BGCNT bit 6 + MOSAIC 0x4C): vertical = sample the top line of
  // the screen-aligned block; horizontal = smear pass after the line fills.
  var mosH=1;
  if((bgcnt>>6)&1){mosH=(io[0x4C]&0xF)+1;var mv=((io[0x4C]>>4)&0xF)+1;if(mv>1)ln-=ln%mv;}
  var hofs=(io[0x10+bgNum*4]|(io[0x11+bgNum*4]<<8))&0x1FF;
  var vofs=(io[0x12+bgNum*4]|(io[0x13+bgNum*4]<<8))&0x1FF;
  var cBase=((bgcnt>>2)&3)*0x4000;
  var sBase=((bgcnt>>8)&0x1F)*0x800;
  var is8=( bgcnt>>7)&1;
  var sz=(bgcnt>>14)&3;
  var mapW=(sz&1)?64:32,mapH=(sz&2)?64:32;
  var y=(ln+vofs)&(mapH*8-1);
  var tileY=y>>3,py=y&7;
  for(var x=0;x<SCREEN_W;x++){
    var sx=(x+hofs)&(mapW*8-1);
    var tileX=sx>>3,px=sx&7;
    var mOff=sBase;
    if(tileX>=32)mOff+=0x800;
    if(tileY>=32)mOff+=(mapW>32?0x1000:0x800);
    var eOff=mOff+((tileY&31)*32+(tileX&31))*2;
    var entry=vram[eOff]|(vram[eOff+1]<<8);
    var ti=entry&0x3FF,fH=(entry>>10)&1,fV=(entry>>11)&1,palIdx=(entry>>12)&0xF;
    var fpx=fH?7-px:px,fpy=fV?7-py:py;
    var ci;
    if(is8){ci=tp8(cBase,ti,fpx,fpy);if(ci)buf[x]=pal16(ci);}
    else{ci=tp4(cBase,ti,fpx,fpy);if(ci)buf[x]=pal16(palIdx*16+ci);}
  }
  mosaicHPass(buf,mosH);
}

function readFP16(off){var v=(io[off]|(io[off+1]<<8))<<16>>16;return v/256;}
function readFP32(off){return((io[off]|(io[off+1]<<8)|(io[off+2]<<16)|(io[off+3]<<24))|0)/256;}

function renderAffineBG(ln,bgNum){
  var bgcnt=io[0x8+bgNum*2]|(io[0x9+bgNum*2]<<8);
  lineBGPr[bgNum]=bgcnt&3;
  var buf=lineBG[bgNum];buf.fill(-1);
  var cBase=((bgcnt>>2)&3)*0x4000;
  var sBase=((bgcnt>>8)&0x1F)*0x800;
  var sz=(bgcnt>>14)&3,mapPx=[128,256,512,1024][sz],wrap=(bgcnt>>13)&1;
  var ioB=bgNum===2?0x20:0x30;
  var pa=readFP16(ioB),pb=readFP16(ioB+2),pc=readFP16(ioB+4),pd=readFP16(ioB+6);
  var refX=readFP32(ioB+8),refY=readFP32(ioB+12);
  var mosH=1;
  if((bgcnt>>6)&1){mosH=(io[0x4C]&0xF)+1;var mv=((io[0x4C]>>4)&0xF)+1;if(mv>1)ln-=ln%mv;}
  // Affine stepping (GBATEK): per-PIXEL the texture point advances by
  // pa (dx) and pc (dy); per-LINE the start point advances by pb (dmx) and
  // pd (dmy). So bgY+=pc inside the x loop below — including the
  // out-of-bounds skip path — is correct; only the line start uses pd.
  var bgX=refX+pb*ln,bgY=refY+pd*ln;
  for(var x=0;x<SCREEN_W;x++){
    var tx=Math.floor(bgX),ty=Math.floor(bgY);
    if(wrap){tx=((tx%mapPx)+mapPx)%mapPx;ty=((ty%mapPx)+mapPx)%mapPx;}
    else if(tx<0||tx>=mapPx||ty<0||ty>=mapPx){bgX+=pa;bgY+=pc;continue;}
    var ti=vram[sBase+(ty>>3)*(mapPx>>3)+(tx>>3)];
    var ci=tp8(cBase,ti,tx&7,ty&7);
    if(ci)buf[x]=pal16(ci);
    bgX+=pa;bgY+=pc;
  }
  mosaicHPass(buf,mosH);
}

var SPRITE_SIZES=[[[8,8],[16,16],[32,32],[64,64]],[[16,8],[32,8],[32,16],[64,32]],[[8,16],[8,32],[16,32],[32,64]]];
function renderSprites(ln,bitmap){
  var tBase=0x10000;
  var dispcnt=io[0]|(io[1]<<8),map1D=(dispcnt>>>6)&1;
  // Iterate high→low OAM index so lower indices overwrite (lower index is
  // on top on hardware). Priority vs. BGs is resolved in the compositor.
  for(var i=127;i>=0;i--){
    var a0=oam[i*8]|(oam[i*8+1]<<8),a1=oam[i*8+2]|(oam[i*8+3]<<8),a2=oam[i*8+4]|(oam[i*8+5]<<8);
    var affine=(a0>>>8)&1;
    if(!affine&&((a0>>>9)&1))continue; // OBJ disable flag (non-affine only)
    var mode=(a0>>>10)&3;
    if(mode===3)continue; // prohibited
    var objY=a0&0xFF;if(objY>=160)objY-=256;
    var shape=(a0>>>14)&3,sz=(a1>>>14)&3;
    if(shape===3)continue;
    var dims=SPRITE_SIZES[shape][sz],objW=dims[0],objH=dims[1];
    // Affine double-size flag expands the clipping field to 2x (the sprite
    // itself stays objW x objH; the extra field keeps rotated corners visible).
    var dbl=affine?((a0>>>9)&1):0;
    var fieldW=objW<<dbl,fieldH=objH<<dbl;
    var sln=ln-objY;if(sln<0||sln>=fieldH)continue;
    var objX=a1&0x1FF;if(objX>=240)objX-=512;
    var ti=a2&0x3FF,palIdx=(a2>>>12)&0xF,is8=(a0>>>13)&1,prio=(a2>>>10)&3,semi=mode===1?1:0;
    // Tile addressing: OAM tile numbers are always in 32-byte units. An 8bpp
    // tile consumes 2 units. Row stride: 1D mapping = tiles-per-row of THIS
    // sprite; 2D mapping = 32 units (the 256-px-wide charblock layout).
    var upt=is8?2:1,tW=objW>>3;
    var stride=map1D?tW*upt:32;
    // GBATEK: 256-color OBJs ignore the low bit of the tile number (tiles
    // are addressed in even 32-byte units).
    if(is8)ti&=~1;
    // In bitmap modes tiles 0-511 overlap the framebuffer; hardware ignores them.
    if(bitmap&&ti<512)continue;
    var pa=256,pb=0,pc=0,pd=256;
    if(affine){
      var g=((a1>>>9)&0x1F)*32;
      pa=(oam[g+6]|(oam[g+7]<<8))<<16>>16;pb=(oam[g+14]|(oam[g+15]<<8))<<16>>16;
      pc=(oam[g+22]|(oam[g+23]<<8))<<16>>16;pd=(oam[g+30]|(oam[g+31]<<8))<<16>>16;
    }
    var fH=affine?0:(a1>>>12)&1,fV=affine?0:(a1>>>13)&1;
    // OBJ mosaic (attr0 bit 12 + MOSAIC 0x4D nibbles): sample the top-left
    // pixel of the SCREEN-aligned mosaic block (grid anchored at screen 0,0,
    // not at the sprite corner — GBATEK).
    var mosH=1,mosV=1;
    if((a0>>>12)&1){mosH=(io[0x4D]&0xF)+1;mosV=((io[0x4D]>>4)&0xF)+1;}
    // If the screen-aligned block's source line falls above the sprite,
    // hardware samples outside the object = transparent: skip the line.
    var slnE=sln;
    if(mosV>1){slnE=(ln-(ln%mosV))-objY;if(slnE<0)continue;}
    // Affine texture mapping (GBATEK): screen point relative to field center
    // maps through the 8.8 matrix to a texture point relative to sprite
    // center. Step per screen pixel is (pa,pc).
    var cx=fieldW>>1,ly=slnE-(fieldH>>1);
    var txf=pa*(-cx)+pb*ly+(objW<<7),tyf=pc*(-cx)+pd*ly+(objH<<7);
    for(var sx=0;sx<fieldW;sx++,txf+=pa,tyf+=pc){
      var scrX=objX+sx;if(scrX<0||scrX>=SCREEN_W)continue;
      // Block source left of the sprite = outside the object = transparent.
      var sxE=sx;
      if(mosH>1){sxE=sx-(scrX%mosH);if(sxE<0)continue;}
      var tx,ty;
      if(affine){
        if(sxE!==sx){tx=(pa*(sxE-cx)+pb*ly+(objW<<7))>>8;ty=(pc*(sxE-cx)+pd*ly+(objH<<7))>>8;}
        else{tx=txf>>8;ty=tyf>>8;}
        if(tx<0||tx>=objW||ty<0||ty>=objH)continue;
      }else{
        tx=fH?objW-1-sxE:sxE;ty=fV?objH-1-slnE:slnE;
      }
      var addr=tBase+((ti+(ty>>3)*stride+(tx>>3)*upt)&0x3FF)*32+(is8?(ty&7)*8+(tx&7):(ty&7)*4+((tx&7)>>1));
      var ci=vram[addr]||0;
      if(!is8)ci=(tx&1)?ci>>4:ci&0xF;
      if(!ci)continue;
      // OBJ-window sprites contribute to the window mask, never to pixels.
      if(mode===2){lineObjWin[scrX]=1;continue;}
      // Iterating high→low OAM index so a later (lower-index) write simply
      // overwrites: lowest OAM index wins regardless of priority attribute,
      // matching hardware's OAM-order resolution (see NOTE above).
      lineObj[scrX]=is8?pal16(256+ci):pal16(256+palIdx*16+ci);
      lineObjPr[scrX]=prio;lineObjSemi[scrX]=semi;
    }
  }
}

// ── CPU ─────────────────────────────────────────────────────────────────────

function condOK(c){
  var N=(cpsr>>>31)&1,Z=(cpsr>>>30)&1,C=(cpsr>>>29)&1,V=(cpsr>>>28)&1;
  switch(c){
    case 0:return Z===1;case 1:return Z===0;case 2:return C===1;case 3:return C===0;
    case 4:return N===1;case 5:return N===0;case 6:return V===1;case 7:return V===0;
    case 8:return C===1&&Z===0;case 9:return C===0||Z===1;
    case 10:return N===V;case 11:return N!==V;
    case 12:return Z===0&&N===V;case 13:return Z===1||N!==V;
    case 14:return true;case 15:return false;
  }
  return false;
}
function setF(n,z,c,v){cpsr=(cpsr&0x0FFFFFFF)|(n<<31)|(z<<30)|(c<<29)|(v<<28);}

function shft(type,val,amt){
  val>>>=0;if(amt===0)return{v:val,c:(cpsr>>>29)&1};
  var carry=0;
  switch(type){
    case 0:carry=amt<=32?(val>>>(32-amt))&1:0;val=amt>=32?0:val<<amt;break;
    case 1:carry=amt<=32?(val>>>(amt-1))&1:0;val=amt>=32?0:val>>>amt;break;
    case 2:carry=amt<32?(val>>>(amt-1))&1:(val>>>31)&1;val=amt>=32?val>>31:val>>amt;break;
    case 3:amt=amt&31||32;carry=(val>>>(amt-1))&1;val=(val>>>amt)|(val<<(32-amt));break;
  }
  return{v:val>>>0,c:carry};
}

// ARM immediate-shift-amount 0 is special-cased per type in the encoding:
// LSL #0 is identity, but LSR #0 / ASR #0 actually mean #32, and ROR #0
// means RRX (rotate right through carry by one). Passing the raw 0 through
// shft() silently made all three behave as identity — the mirror image of
// the THUMB lsl-number-0 bug.
function armImmShift(type,val,amt){
  val>>>=0;
  if(amt===0){
    if(type===0)return{v:val,c:(cpsr>>>29)&1};
    if(type===1)return{v:0,c:(val>>>31)&1};             // LSR #32
    if(type===2)return{v:(val>>31)>>>0,c:(val>>>31)&1};  // ASR #32
    var cin=(cpsr>>>29)&1;                               // ROR #0 = RRX
    return{v:((val>>>1)|(cin<<31))>>>0,c:val&1};
  }
  return shft(type,val,amt);
}

function setReg(rd,v){
  if(rd===15)r[15]=((cpsr&0x20)?(v&~1)+2:(v&~3)+4);
  else r[rd]=v;
}

// ARM7 fetches two instructions ahead. Keep those fetched words separate
// from memory so a store cannot retroactively change an in-flight opcode.
var armFetchPC=-1,armFetch0=0,armFetch1=0,armInstructionCycles=2;
function stepARM(){
  var pc=r[15]-4,ins;
  if(armFetchPC===pc){
    ins=armFetch0;armFetch0=armFetch1;armFetch1=r32(pc+8);
  }else{
    ins=r32(pc);armFetch0=r32(pc+4);armFetch1=r32(pc+8);
  }
  armFetchPC=pc+4;
  // IWRAM has a single-cycle 32-bit instruction bus. Retain the existing
  // approximation elsewhere; ROM wait-state/prefetch timing is separate.
  var internalARM=(pc>>>24)===3;
  armInstructionCycles=internalARM?1:2;
  if(internalARM&&condOK(ins>>>28)){
    if((ins&0x0E000000)===0x0A000000||
       (ins&0x0FFFFFF0)===0x012FFF10)armInstructionCycles=3;
    else if((ins&0x0C000000)===0x04000000||
            (ins&0x0E000090)===0x00000090){
      armInstructionCycles=(ins&0x00100000)?3:2;
    }else if((ins&0x0E000000)===0x08000000){
      var transferCount=0;
      for(var ci=0;ci<16;ci++)transferCount+=(ins>>>ci)&1;
      armInstructionCycles=Math.max(1,transferCount)+((ins&0x00100000)?2:1);
    }else if((ins&0x0C000000)===0&&!(ins&0x02000000)&&(ins&0x10)){
      armInstructionCycles=2;
    }
  }
  // Branch/exception instructions refill even when their target happens
  // to equal the next sequential address.
  if(condOK(ins>>>28)&&(
    (ins&0x0E000000)===0x0A000000||
    (ins&0x0FFFFFF0)===0x012FFF10||
    (ins&0x0F000000)===0x0F000000||
    (((ins>>>12)&15)===15&&(
      ((ins&0x0C100000)===0x04100000)||
      ((ins&0x0C000000)===0&&(ins&0x0E000090)!==0x00000090&&
       (((ins>>>21)&15)<8||((ins>>>21)&15)>11))
    ))||
    ((ins&0x0E100000)===0x08100000&&(ins&0x8000))
  ))armFetchPC=-1;
  r[15]+=4;
  recordStep(pc,ins,'ARM');
  if(!condOK(ins>>>28))return;

  // BX
  if((ins&0x0FFFFFF0)===0x012FFF10){
    var rn=r[ins&0xF];
    if(rn&1){cpsr|=0x20;r[15]=(rn&~1)+2;}else{cpsr&=~0x20;r[15]=(rn&~3)+4;}
    return;
  }
  // Branch
  if((ins&0x0E000000)===0x0A000000){
    if((ins>>>24)&1)r[14]=r[15]-4;
    var off=ins&0xFFFFFF;if(off&0x800000)off|=0xFF000000;
    // Target = pc+8+off. r[15] holds pc+8 here, but the fetch convention is
    // r[15] = nextPC+4 (stepARM fetches at r[15]-4), so add 4 more — exactly
    // like BX does. Omitting it made every ARM B/BL land 4 bytes short,
    // executing literal-pool words and skipping subroutine entry points.
    r[15]=(r[15]+((off<<2)|0)+4)>>>0;
    return;
  }
  // MUL
  if((ins&0x0FC000F0)===0x00000090){
    var s=(ins>>>20)&1,rd=(ins>>>16)&0xF,rn2=(ins>>>12)&0xF,rs=(ins>>>8)&0xF,rm=ins&0xF;
    var res=Math.imul(r[rm],r[rs])|0;
    if((ins>>>21)&1)res=(res+r[rn2])|0;
    r[rd]=res>>>=0;
    if(s)setF((res>>>31)&1,res===0?1:0,(cpsr>>>29)&1,(cpsr>>>28)&1);
    return;
  }
  // MULL
  if((ins&0x0F8000F0)===0x00800090){
    var sign=(ins>>>22)&1,a=(ins>>>21)&1,s=(ins>>>20)&1;
    var rdHi=(ins>>>16)&0xF,rdLo=(ins>>>12)&0xF,rs=(ins>>>8)&0xF,rm=ins&0xF;
    var res2;
    if(sign)res2=BigInt(r[rm]|0)*BigInt(r[rs]|0);
    else res2=BigInt(r[rm]>>>0)*BigInt(r[rs]>>>0);
    if(a)res2+=BigInt(r[rdHi]>>>0)*BigInt(0x100000000)+BigInt(r[rdLo]>>>0);
    r[rdLo]=Number(res2&BigInt(0xFFFFFFFF))>>>0;
    r[rdHi]=Number((res2>>BigInt(32))&BigInt(0xFFFFFFFF))>>>0;
    return;
  }
  // Halfword transfer — mask must NOT include bit 22 (0x400000): that bit
  // selects immediate vs register offset, and both forms are valid. The old
  // mask 0x0E400090 required bit22=0, so every immediate-offset strh/ldrh
  // (the form compilers emit for I/O register writes: DISPCNT, DISPSTAT,
  // IE, IME...) fell through to dataProc and executed as a garbage ALU op.
  // Games "ran" but none of their halfword I/O configuration ever landed —
  // no interrupts enabled, display never configured: the white-screen hang.
  if((ins&0x0E000090)===0x00000090&&((ins&0x60)!==0)){
    halfwordARM(ins);return;
  }
  // SWP
  if((ins&0x0FB00FF0)===0x01000090){
    var rn2=(ins>>>16)&0xF,rd=(ins>>>12)&0xF,rm=ins&0xF;
    var addr=r[rn2]>>>0;
    if((ins>>>22)&1){var old=r8(addr);w8(addr,r[rm]&0xFF);setReg(rd,old);}
    else{var old=ldrRot(addr);w32(addr&~3,r[rm]>>>0);setReg(rd,old);}
    return;
  }
  // MRS
  if((ins&0x0FBF0FFF)===0x010F0000){
    var rdM=(ins>>>12)&0xF,useSPSR_M=(ins>>>22)&1;
    setReg(rdM,useSPSR_M?curSPSR():cpsr);return;
  }
  // MSR
  if((ins&0x0DB0F000)===0x0120F000){
    var useSPSR_S=(ins>>>22)&1,isImm_S=(ins>>>25)&1,fieldMask=(ins>>>16)&0xF;
    var val;
    if(isImm_S){var imm=ins&0xFF,rot=((ins>>>8)&0xF)*2;val=rot?((imm>>>rot)|(imm<<(32-rot)))>>>0:imm;}
    else val=r[ins&0xF]>>>0;
    var byteMask=0;
    if(fieldMask&1)byteMask|=0x000000FF;
    if(fieldMask&2)byteMask|=0x0000FF00;
    if(fieldMask&4)byteMask|=0x00FF0000;
    if(fieldMask&8)byteMask|=0xFF000000;
    if(useSPSR_S){setCurSPSR((curSPSR()&~byteMask)|(val&byteMask));}
    else{
      var newCpsr=(cpsr&~byteMask)|(val&byteMask);
      if((byteMask&0xFF)&&(newCpsr&0x1F)!==(cpsr&0x1F))doModeSwitch(newCpsr&0x1F);
      cpsr=newCpsr;
    }
    return;
  }
  // Data processing
  if((ins&0x0C000000)===0x00000000){dataProc(ins);return;}
  // SDT
  if((ins&0x0C000000)===0x04000000){sdt(ins);return;}
  // BDT
  if((ins&0x0E000000)===0x08000000){bdt(ins);return;}
  // SWI — in ARM mode the BIOS function number lives in bits 16-23 of the
  // 24-bit comment field (swi 0x0B0000 is CpuSet), NOT the low byte. Passing
  // the raw comment and masking with 0xFF turned EVERY ARM-mode BIOS call
  // into function 0: devkitARM-style crt0s CpuSet-copy code/data at boot and
  // then jump through a copied pointer, so the silent no-op meant a jump to
  // address 0 followed by a nop-slide through zeroed memory — the real cause
  // of the recurring "PC entered unmapped memory region (0xf90)" crash.
  if((ins&0x0F000000)===0x0F000000){doSWI((ins>>>16)&0xFF);return;}
  // No known ARM encoding matched (e.g. coprocessor space). Record it
  // explicitly instead of silently treating it as a NOP — a silently
  // skipped instruction can corrupt downstream state without ever
  // surfacing as a visible hang.
  undefInstrCount++;
  pushRecent({t:'undef-arm',pc:'0x'+pc.toString(16),ins:'0x'+(ins>>>0).toString(16),n:instrCount});
}

function dataProc(ins){
  var op=(ins>>>21)&0xF,s=(ins>>>20)&1,rn=(ins>>>16)&0xF,rd=(ins>>>12)&0xF;
  var isImm=(ins>>>25)&1;
  var op2,carry;
  if(isImm){
    var imm=ins&0xFF,rot=((ins>>>8)&0xF)*2;
    op2=rot?((imm>>>rot)|(imm<<(32-rot)))>>>0:imm;
    carry=rot?(op2>>>31)&1:(cpsr>>>29)&1;
  } else {
    var rm=ins&0xF,type=(ins>>>5)&3;
    var sh;
    if((ins>>>4)&1)sh=shft(type,r[rm],r[(ins>>>8)&0xF]&0xFF);
    else sh=armImmShift(type,r[rm],(ins>>>7)&0x1F);
    op2=sh.v;carry=sh.c;
  }
  var rnv=r[rn]>>>0,res=0,wr=true;
  var N,Z,C=carry,V=(cpsr>>>28)&1;
  switch(op){
    case 0:res=rnv&op2;break;
    case 1:res=rnv^op2;break;
    case 2:{res=(rnv-op2)>>>0;C=rnv>=op2?1:0;V=(((rnv^op2)&(rnv^res))>>>31)&1;break;}
    case 3:{res=(op2-rnv)>>>0;C=op2>=rnv?1:0;V=(((op2^rnv)&(op2^res))>>>31)&1;break;}
    case 4:{var r64=rnv+op2;res=r64>>>0;C=r64>0xFFFFFFFF?1:0;V=(((~(rnv^op2))&(rnv^res))>>>31)&1;break;}
    case 5:{var cin=(cpsr>>>29)&1,r64=rnv+op2+cin;res=r64>>>0;C=r64>0xFFFFFFFF?1:0;V=(((~(rnv^op2))&(rnv^res))>>>31)&1;break;}
    case 6:{var cin=(cpsr>>>29)&1;res=(rnv-op2-(1-cin))>>>0;C=(rnv>>>0)>=(op2>>>0)+(1-cin)?1:0;V=(((rnv^op2)&(rnv^res))>>>31)&1;break;}
    case 7:{var cin=(cpsr>>>29)&1;res=(op2-rnv-(1-cin))>>>0;C=(op2>>>0)>=(rnv>>>0)+(1-cin)?1:0;V=(((op2^rnv)&(op2^res))>>>31)&1;break;}
    case 8:res=rnv&op2;wr=false;break;
    case 9:res=rnv^op2;wr=false;break;
    case 10:{res=(rnv-op2)>>>0;C=rnv>=op2?1:0;V=(((rnv^op2)&(rnv^res))>>>31)&1;wr=false;break;}
    case 11:{var r64=rnv+op2;res=r64>>>0;C=r64>0xFFFFFFFF?1:0;V=(((~(rnv^op2))&(rnv^res))>>>31)&1;wr=false;break;}
    case 12:res=rnv|op2;break;
    case 13:res=op2;break;
    case 14:res=rnv&~op2;break;
    case 15:res=~op2>>>0;break;
  }
  res>>>=0;N=(res>>>31)&1;Z=res===0?1:0;
  if(wr&&rd===15&&s){
    // Exception return idiom (e.g. SUBS PC,LR,#4): restore CPSR from SPSR
    var restored=curSPSR();
    doModeSwitch(restored&0x1F);
    cpsr=restored;
    r[15]=((cpsr&0x20)?(res&~1)+2:(res&~3)+4)>>>0;
    return;
  }
  if(s)setF(N,Z,C,V);
  if(wr)setReg(rd,res);
}

function sdt(ins){
  var load=(ins>>>20)&1,w=(ins>>>21)&1,byte=(ins>>>22)&1,u=(ins>>>23)&1,pre=(ins>>>24)&1;
  var isImm=!((ins>>>25)&1),rn=(ins>>>16)&0xF,rd=(ins>>>12)&0xF;
  var off;
  if(isImm)off=ins&0xFFF;
  else{var rm=ins&0xF,type=(ins>>>5)&3,amt=(ins>>>7)&0x1F;off=armImmShift(type,r[rm],amt).v;}
  var addr=r[rn]>>>0;
  if(pre)addr=u?(addr+off)>>>0:(addr-off)>>>0;
  if(load){if(byte)setReg(rd,r8(addr));else setReg(rd,ldrRot(addr));}
  else{if(byte)w8(addr,(r[rd]+(rd===15?4:0))&0xFF);else w32(addr&~3,(r[rd]+(rd===15?4:0))>>>0);}
  if(!pre)addr=u?(addr+off)>>>0:(addr-off)>>>0;
  if(w||!pre)r[rn]=addr;
}

function bdt(ins){
  var load=(ins>>>20)&1,w=(ins>>>21)&1,s=(ins>>>22)&1,u=(ins>>>23)&1,pre=(ins>>>24)&1;
  var rn=(ins>>>16)&0xF,list=ins&0xFFFF;
  var pcInList=(list>>>15)&1;
  var cnt=0;for(var i=0;i<16;i++)if((list>>>i)&1)cnt++;
  var base=r[rn]>>>0;
  // ARM7TDMI empty-list quirk: transfers PC (STM stores pc+12-equivalent,
  // LDM loads into PC) and the writeback delta is 0x40, not 0.
  if(cnt===0){
    var eaddr=u?(pre?(base+4)>>>0:base):(pre?(base-0x40)>>>0:(base-0x3C)>>>0);
    if(load){var lv=r32(eaddr&~3)>>>0;r[15]=((cpsr&0x20)?(lv&~1)+2:(lv&~3)+4)>>>0;}
    else w32(eaddr&~3,(r[15]+4)>>>0);
    if(w)r[rn]=u?(base+0x40)>>>0:(base-0x40)>>>0;
    return;
  }
  // Note: base-register-in-list sequencing is simplified — writeback happens
  // after all transfers. STM storing the base always stores the original
  // value; the architecturally in-between forms are unpredictable on real
  // hardware anyway and no compiler emits them.
  var startAddr=u?base:(base-cnt*4)>>>0;
  var addr=startAddr;
  // Rewriting a decrementing transfer as an ascending one flips the
  // pre/post sense: DB ≡ IA from base-cnt*4 (post-step), DA ≡ IB from
  // base-cnt*4 (pre-step). Using the raw pre bit made STMDB (push) store
  // every register one slot too high, so the matching LDMIA (pop) restored
  // lr from the r3 slot — returning through garbage (the build-19 crash).
  var stepPre=u?pre:!pre;
  // S-bit + PC-in-list on a load (e.g. "LDMFD SP!,{R0-R12,PC}^") is the
  // standard ARM interrupt/exception-return epilogue: it must restore CPSR
  // from SPSR and switch modes, or the CPU stays stuck in IRQ/SVC mode with
  // interrupts masked forever, even though PC came back to the right place.
  var exceptionReturn=s&&load&&pcInList;
  var rawPC=0;
  for(var i=0;i<16;i++){
    if(!((list>>>i)&1))continue;
    if(stepPre)addr=(addr+4)>>>0;
    if(load){
      if(i===15&&exceptionReturn)rawPC=r32(addr&~3)>>>0;
      else setReg(i,r32(addr&~3));
    }else w32(addr&~3,(r[i]+(i===15?4:0))>>>0);
    if(!stepPre)addr=(addr+4)>>>0;
  }
  if(w)r[rn]=u?(base+cnt*4)>>>0:(base-cnt*4)>>>0;
  if(exceptionReturn){
    var restored=curSPSR();
    doModeSwitch(restored&0x1F);
    cpsr=restored;
    r[15]=((cpsr&0x20)?(rawPC&~1)+2:(rawPC&~3)+4)>>>0;
  }
}

function halfwordARM(ins){
  var load=(ins>>>20)&1,w=(ins>>>21)&1,s=(ins>>>6)&1,h=(ins>>>5)&1;
  var u=(ins>>>23)&1,pre=(ins>>>24)&1,rn=(ins>>>16)&0xF,rd=(ins>>>12)&0xF;
  var off=(ins>>>22)&1?(((ins>>4)&0xF0)|(ins&0xF)):(r[ins&0xF]>>>0);
  var addr=r[rn]>>>0;
  if(pre)addr=u?(addr+off):(addr-off);addr>>>=0;
  if(load){
    if(!h&&!s)setReg(rd,r8(addr));
    else if(h&&!s)setReg(rd,ldrhRot(addr));
    else if(!h&&s)setReg(rd,(r8(addr)<<24)>>24);
    else setReg(rd,ldrshRot(addr));
  }else{
    if(h)w16(addr&~1,r[rd]&0xFFFF);else w8(addr,r[rd]&0xFF);
  }
  if(!pre)addr=u?(addr+off):(addr-off);
  if(w||!pre)r[rn]=addr>>>0;
}

function doSWI(code){
  // Return address is the instruction after the SWI. During execute,
  // r[15]=pc+8 in ARM (return pc+4 = r[15]-4) but r[15]=pc+4 in THUMB
  // (return pc+2 = r[15]-2). Using -4 unconditionally made THUMB SWIs
  // resume at the SWI itself and re-execute forever.
  svcR14=(cpsr&0x20)?(r[15]-2)>>>0:(r[15]-4)>>>0;svcSPSR=cpsr;
  cpsr=(cpsr&~0x3F)|MODE_SVC|0x80;cpsr&=~0x20;
  r[15]=0x08+4; // jump past SWI vector
  swiCount++;
  lastSWI={code:'0x'+(code&0xFF).toString(16),cycle:instrCount,frame:emuFrameCount};
  pushRecent({t:'swi',code:'0x'+(code&0xFF).toString(16),n:instrCount});
  biosCall(code&0xFF);
}

function biosCall(n){
  switch(n){
    case 0x00:{ // SoftReset: clear top of IWRAM, reset ALL banked stacks, restart.
      var flag=iwram[0x7FFA]; // 0x03007FFA: 0=ROM entry, nonzero=EWRAM entry
      for(var i0=0x7E00;i0<0x8000;i0++)iwram[i0]=0;
      // Re-establish every banked sp/lr directly (BIOS contract) instead of
      // going through doModeSwitch, which would first save the caller's
      // pre-reset registers into the SVC bank.
      bankR13[bankKey(MODE_SYS)]=0x03007F00;bankR14[bankKey(MODE_SYS)]=0;
      bankR13[MODE_SVC]=0x03007FE0;bankR14[MODE_SVC]=0;
      bankR13[MODE_IRQ]=0x03007FA0;bankR14[MODE_IRQ]=0;
      cpsr=(cpsr&~0x3F)|MODE_SYS; // ARM state, SYS mode, IRQs enabled
      r[13]=0x03007F00;r[14]=0;
      svcSPSR=0;irqSPSR=0;svcR14=0;
      irqReturnStack.length=0;
      r[15]=((flag?0x02000000:0x08000000)+4)>>>0;
      halted=false;intrWaitFlags=null;
      return; // does NOT return to the caller — skip the epilogue
    }
    case 0x01:{ // RegisterRamReset(flags in r0)
      var fl=r[0]&0xFF;
      if(fl&0x01)wram.fill(0);
      if(fl&0x02){for(var i2=0;i2<0x7E00;i2++)iwram[i2]=0;} // excludes last 0x200 (stack/vector area)
      if(fl&0x04)pal.fill(0);
      if(fl&0x08)vram.fill(0);
      if(fl&0x10)oam.fill(0);
      // I/O-register resets (bits 5-7) intentionally skipped: registers
      // already boot zeroed in this core. BUT (GBATEK): RegisterRamReset
      // ALWAYS sets DISPCNT to 0x0080 (forced blank), regardless of flags.
      // pokeemerald-family gpu_regs.c relies on this: SetGpuReg only writes
      // DISPSTAT immediately while VCOUNT is in VBlank or forced blank is
      // set — otherwise it buffers the write for the VBlank interrupt to
      // flush. Without forced blank at boot, the DISPSTAT VBlank-IRQ-enable
      // write is deferred forever, no IRQ ever fires, and the first
      // VBlankIntrWait halts for good (the frame-304 halt-never-wakes).
      io[0x0]=0x80;io[0x1]=0;
      break;
    }
    case 0x04:{ // IntrWait(clearOld, flags): wake ONLY once the specific
      // requested flag(s) are set in IF — not on the first interrupt of
      // any kind. Real games (esp. ones mixing VBlank with Timer/Serial
      // interrupts for audio) rely on this; waking early on an unrelated
      // source and resuming game code before the awaited condition is
      // real corrupts game state in ways that only surface much later as
      // an unrelated-looking crash — see intrWaitFlags below.
      var f=r[1]&0xFFFF;
      if(r[0]===0){io[0x202]&=~(f&0xFF);io[0x203]&=~((f>>>8)&0xFF);}
      intrWaitFlags=f;halted=true;break;
    }
    case 0x05: // VBlankIntrWait === IntrWait(1, 1)
      io[0x202]&=~1;intrWaitFlags=1;halted=true;break;
    case 0x06:if(r[1]){var a=r[0]|0,b=r[1]|0;r[0]=(a/b)|0;r[1]=a%b;r[3]=Math.abs(r[0]);}break;
    case 0x08:r[0]=Math.sqrt(r[0]>>>0)|0;break;
    case 0x0B:{var src=r[0]>>>0,dst=r[1]>>>0,cnt=r[2]>>>0;
      var fill=(cnt>>24)&1,w32f=(cnt>>26)&1,count=cnt&0x1FFFFF;
      if((dst>>>24)===0x05)tracePalWrite('cpuset'+(w32f?'32':'16'),src,count,w32f,fill);
      for(var i=0;i<count;i++){
        if(w32f)w32(dst+i*4,fill?r32(src):r32(src+i*4));
        else w16(dst+i*2,fill?r16(src):r16(src+i*2));
      }break;}
    case 0x0C:{var src=r[0]>>>0,dst=r[1]>>>0,cnt=r[2]>>>0;
      var fill=(cnt>>24)&1,count=cnt&0x1FFFFF;
      if((dst>>>24)===0x05)tracePalWrite('cpufastset',src,count,true,fill);
      for(var i=0;i<count;i++)w32(dst+i*4,fill?r32(src):r32(src+i*4));break;}
    case 0x0E:{ // BgAffineSet: src=20-byte units, dst=16-byte BG affine sets
      var src=r[0]>>>0,dst=r[1]>>>0,n=r[2]>>>0;
      while(n-->0){
        var ox=r32(src)|0,oy=r32(src+4)|0;                     // origin, 19.8
        var cx=(r16(src+8)<<16)>>16,cy=(r16(src+10)<<16)>>16;  // display center
        var sx=(r16(src+12)<<16)>>16,sy=(r16(src+14)<<16)>>16; // scale, 8.8
        var t8=(r16(src+16)>>>8)&0xFF;                         // angle, top byte
        var si=biosSin(t8),co=biosSin((t8+0x40)&0xFF);         // 8.8 fixed
        // BIOS-style fixed-point: 8.8*8.8 product, arithmetic >>8 (rounds
        // toward -infinity, matching the BIOS shift).
        var pa=(sx*co)>>8,pb=(-sx*si)>>8,pc=(sy*si)>>8,pd=(sy*co)>>8;
        w16(dst,pa&0xFFFF);w16(dst+2,pb&0xFFFF);w16(dst+4,pc&0xFFFF);w16(dst+6,pd&0xFFFF);
        w32(dst+8,(ox-(pa*cx+pb*cy))|0);   // start X/Y so the display center
        w32(dst+12,(oy-(pc*cx+pd*cy))|0);  // lands on the source origin
        src+=20;dst+=16;
      }break;}
    case 0x0F:{ // ObjAffineSet: src=6-byte units (s16 sx, s16 sy, u16 alpha
      // — NO padding); r3 = byte offset between pa/pb/pc/pd (8 -> OAM)
      var src=r[0]>>>0,dst=r[1]>>>0,n=r[2]>>>0,ofs=r[3]>>>0;
      while(n-->0){
        var sx=(r16(src)<<16)>>16,sy=(r16(src+2)<<16)>>16;     // 8.8 scale
        var t8=(r16(src+4)>>>8)&0xFF;
        var si=biosSin(t8),co=biosSin((t8+0x40)&0xFF);
        w16(dst,((sx*co)>>8)&0xFFFF);
        w16(dst+ofs,((-sx*si)>>8)&0xFFFF);
        w16(dst+ofs*2,((sy*si)>>8)&0xFFFF);
        w16(dst+ofs*3,((sy*co)>>8)&0xFFFF);
        src+=6;dst+=ofs*4;
      }break;}
    case 0x11:case 0x12:lz77(r[0]>>>0,r[1]>>>0);break;
    case 0x14:case 0x15:rl(r[0]>>>0,r[1]>>>0);break;
    default:break;
  }
  cpsr=svcSPSR;r[15]=svcR14+((cpsr&0x20)?2:4);
}

function lz77(src,dst){
  var header=r32(src);var dlen=(header>>>8)&0xFFFFFF;src+=4;
  var end=dst+dlen;
  while(dst<end){
    var flags=r8(src++);
    for(var b=7;b>=0&&dst<end;b--){
      if((flags>>>b)&1){
        var d=(r8(src++)<<8)|r8(src++);
        var len=((d>>12)&0xF)+3,disp=(d&0xFFF)+1;
        for(var j=0;j<len&&dst<end;j++){w8(dst,r8(dst-disp));dst++;}
      }else{w8(dst++,r8(src++));}
    }
  }
}

function rl(src,dst){
  var header=r32(src);var dlen=(header>>>8)&0xFFFFFF;src+=4;
  var end=dst+dlen;
  while(dst<end){
    var b=r8(src++);
    if(b&0x80){var len=(b&0x7F)+3,val=r8(src++);for(var i=0;i<len&&dst<end;i++)w8(dst++,val);}
    else{var len=(b&0x7F)+1;for(var i=0;i<len&&dst<end;i++)w8(dst++,r8(src++));}
  }
}

// ── THUMB ────────────────────────────────────────────────────────────────────

function stepTHUMB(){
  armFetchPC=-1;
  var pc=r[15]-2,ins=r16(pc)>>>0;r[15]+=2;
  recordStep(pc,ins,'THUMB');
  thumb(ins,pc);
}

function thumb(ins,_pc){
  var t5=ins>>>11;
  // Format 19: Long branch
  // BL prefix base is pc+4, which is exactly r[15] here (stepTHUMB leaves
  // r[15]=pc+4 during execute). Using r[15]-2 lands every BL 2 bytes short.
  if(t5===0x1E){var off=ins&0x7FF;if(off&0x400)off|=0xFFFFF800;r[14]=(r[15]+(off<<12))>>>0;return;}
  if(t5===0x1F){var a=(r[14]+((ins&0x7FF)<<1))>>>0;r[14]=(r[15]-2)|1;r[15]=a+2;return;}
  // Unconditional branch
  if(t5===0x1C){var off=ins&0x7FF;if(off&0x400)off|=0xFFFFF800;r[15]+=(off<<1)+2;return;}
  var t8=ins>>>8;
  // Format 16: Conditional branch / SWI
  if((ins>>>12)===0xD){
    var cond=(ins>>>8)&0xF;
    if(cond===0xF){doSWI(ins&0xFF);return;}
    if(!condOK(cond))return;
    var off=ins&0xFF;if(off&0x80)off|=0xFFFFFF00;r[15]+=(off<<1)+2;return;
  }
  // Format 15: LDMIA/STMIA
  if((ins>>>12)===0xC){
    var load=(ins>>>11)&1,rb=(ins>>>8)&7,list=ins&0xFF,addr=r[rb]>>>0;
    for(var i=0;i<8;i++){if(!((list>>>i)&1))continue;if(load)r[i]=r32(addr&~3);else w32(addr&~3,r[i]);addr+=4;}
    r[rb]=addr;return;
  }
  // Format 14: PUSH/POP (only 0xB4/B5/BC/BD - bits 10-9 must be 10;
  // 0xB0xx is Format 13 SP-adjust and must NOT fall in here)
  if((ins&0xF600)===0xB400){
    var load=(ins>>>11)&1,extra=(ins>>>8)&1,list=ins&0xFF;
    if(!load){if(extra){r[13]-=4;w32(r[13]&~3,r[14]);}for(var i=7;i>=0;i--)if((list>>>i)&1){r[13]-=4;w32(r[13]&~3,r[i]);}}
    else{for(var i=0;i<8;i++)if((list>>>i)&1){r[i]=r32(r[13]&~3);r[13]+=4;}if(extra){r[15]=(r32(r[13]&~3)&~1)+2;r[13]+=4;}}
    return;
  }
  // Format 13: SP adjust
  if(t8===0xB0){var s=(ins>>>7)&1,off=(ins&0x7F)*4;r[13]=s?(r[13]-off)>>>0:(r[13]+off)>>>0;return;}
  // Format 12: Load address
  if((ins>>>12)===0xA){var sp=(ins>>>11)&1,rd=(ins>>>8)&7,off=(ins&0xFF)*4;r[rd]=sp?(r[13]+off)>>>0:((r[15]&~3)+off)>>>0;return;}
  // Format 11: SP-relative load/store
  if((ins>>>12)===9){var load=(ins>>>11)&1,rd=(ins>>>8)&7,off=(ins&0xFF)*4,addr=(r[13]+off)>>>0;if(load)r[rd]=ldrRot(addr);else w32(addr&~3,r[rd]>>>0);return;}
  // Format 10: Load/store halfword
  if((ins>>>12)===8){var load=(ins>>>11)&1,off=((ins>>>6)&0x1F)*2,rb=(ins>>>3)&7,rd=ins&7,addr=(r[rb]+off)>>>0;if(load)r[rd]=ldrhRot(addr);else w16(addr&~1,r[rd]&0xFFFF);return;}
  // Format 9: Load/store immediate offset
  if((ins>>>13)===3){
    var load=(ins>>>11)&1,byte=(ins>>>12)&1,off=(ins>>>6)&0x1F,rb=(ins>>>3)&7,rd=ins&7;
    var addr=(r[rb]+(byte?off:off*4))>>>0;
    if(load){r[rd]=byte?r8(addr):ldrRot(addr);}else{if(byte)w8(addr,r[rd]&0xFF);else w32(addr&~3,r[rd]>>>0);}return;
  }
  // Format 7/8: Register offset load/store.
  // bit9=0 -> Format 7 (bits 11:10): 00 str, 01 strb, 10 ldr(WORD), 11 ldrb
  // bit9=1 -> Format 8 (bits 11:10): 00 strh, 01 ldsb, 10 ldrh, 11 ldsh
  if((ins>>>12)===5){
    var ro=(ins>>>6)&7,rb=(ins>>>3)&7,rd=ins&7,op=(ins>>>10)&3;
    var addr=(r[rb]+r[ro])>>>0;
    if((ins>>>9)&1){
      if(op===0)w16(addr&~1,r[rd]&0xFFFF);
      else if(op===1){var b=r8(addr);r[rd]=(b&0x80)?(b|0xFFFFFF00)>>>0:b;}
      else if(op===2)r[rd]=ldrhRot(addr);
      else r[rd]=ldrshRot(addr);
    }else{
      if(op===0)w32(addr&~3,r[rd]>>>0);
      else if(op===1)w8(addr,r[rd]&0xFF);
      else if(op===2)r[rd]=ldrRot(addr);
      else r[rd]=r8(addr);
    }
    return;
  }
  // Format 6: PC-relative load (0x48-0x4F)
  if((ins>>>11)===0x09){var rd=(ins>>>8)&7,off=(ins&0xFF)<<2;r[rd]=r32(((r[15])&~3)+off);return;}
  // Format 5: Hi reg ops / BX
  if((ins>>>10)===0x11){
    var op=(ins>>>8)&3,h1=(ins>>>7)&1,h2=(ins>>>6)&1;
    var rs=((ins>>>3)&7)+(h2?8:0),rd=(ins&7)+(h1?8:0);
    switch(op){
      case 0:{var sum=(r[rd]+r[rs])>>>0;if(rd===15)setReg(15,sum);else r[rd]=sum;break;}
      case 1:{var v=(r[rd]-r[rs])>>>0;setF((v>>>31)&1,v===0?1:0,(r[rd]>>>0)>=(r[rs]>>>0)?1:0,(((r[rd]^r[rs])&(r[rd]^v))>>>31)&1);return;}
      case 2:setReg(rd,r[rs]);break;
      case 3:{var a=r[rs];if(a&1){cpsr|=0x20;r[15]=(a&~1)+2;}else{cpsr&=~0x20;r[15]=(a&~3)+4;}return;}
    }return;
  }
  // Format 4: ALU ops
  if((ins>>>10)===0x10){
    var op=(ins>>>6)&0xF,rs=(ins>>>3)&7,rd=ins&7,rdv=r[rd]>>>0,rsv=r[rs]>>>0;
    var C=(cpsr>>>29)&1,V=(cpsr>>>28)&1,res;
    switch(op){
      case 0:res=rdv&rsv;break;case 1:res=rdv^rsv;break;
      // Register-specified shifts use the LOW BYTE of rs, not rs&31: a
      // shift by 0 leaves value and carry untouched, 32 and above have
      // defined results (0 / sign fill) that shft() computes from the full
      // amount. The old rs&31-or-32 masking mangled both ends: shift-by-0
      // became shift-by-32 (zeroing the value) and shift-by-33+ wrapped.
      case 2:{var sh=shft(0,rdv,rsv&0xFF);res=sh.v;C=sh.c;break;}
      case 3:{var sh=shft(1,rdv,rsv&0xFF);res=sh.v;C=sh.c;break;}
      case 4:{var sh=shft(2,rdv,rsv&0xFF);res=sh.v;C=sh.c;break;}
      case 5:{var r64=rdv+rsv+C;res=r64>>>0;C=r64>0xFFFFFFFF?1:0;V=(((~(rdv^rsv))&(rdv^res))>>>31)&1;break;}
      case 6:{res=(rdv-rsv-(1-C))>>>0;C=(rdv>>>0)>=(rsv>>>0)+(1-C)?1:0;V=(((rdv^rsv)&(rdv^res))>>>31)&1;break;}
      case 7:{var sh=shft(3,rdv,rsv&0xFF);res=sh.v;C=sh.c;break;}
      case 8:res=rdv&rsv;setF((res>>>31)&1,res===0?1:0,C,V);return;
      case 9:{res=(0-rsv)>>>0;C=rsv===0?1:0;V=(rsv===0x80000000)?1:0;r[rd]=res;setF((res>>>31)&1,res===0?1:0,C,V);return;}
      case 10:{res=(rdv-rsv)>>>0;C=rdv>=rsv?1:0;V=(((rdv^rsv)&(rdv^res))>>>31)&1;setF((res>>>31)&1,res===0?1:0,C,V);return;}
      case 11:{var r64=rdv+rsv;res=r64>>>0;C=r64>0xFFFFFFFF?1:0;V=(((~(rdv^rsv))&(rdv^res))>>>31)&1;setF((res>>>31)&1,res===0?1:0,C,V);return;}
      case 12:res=rdv|rsv;break;case 13:res=Math.imul(rdv,rsv)>>>0;setF((res>>>31)&1,res===0?1:0,0,0);r[rd]=res;return;
      case 14:res=rdv&~rsv;break;case 15:res=~rsv>>>0;break;
    }
    res>>>=0;r[rd]=res;setF((res>>>31)&1,res===0?1:0,C,V);return;
  }
  // Format 1/2: Shifted register / Add-Sub
  if((ins>>>13)===0){
    var op=(ins>>>11)&3,off=(ins>>>6)&0x1F,rs=(ins>>>3)&7,rd=ins&7;
    if(op===3){
      var isImm=(ins>>>10)&1,sub=(ins>>>9)&1,op2=isImm?((ins>>>6)&7):r[(ins>>>6)&7];
      var rsv=r[rs]>>>0,res,C,V;
      if(sub){res=(rsv-op2)>>>0;C=rsv>=op2?1:0;V=(((rsv^op2)&(rsv^res))>>>31)&1;}
      else{var r64=rsv+op2;res=r64>>>0;C=r64>0xFFFFFFFF?1:0;V=(((~(rsv^op2))&(rsv^res))>>>31)&1;}
      r[rd]=res;setF((res>>>31)&1,res===0?1:0,C,V);return;
    }
    // Shift-amount 0 semantics differ per type: LSL #0 is a plain register
    // move (value AND carry untouched), while LSR #0 / ASR #0 encode #32.
    // The old blanket off-or-32 conversion turned every THUMB movs rd,rs
    // (encoded as lsls rd,rs,#0) into a shift-by-32 that ZEROED the
    // destination — boot copy loops computed end pointers from a zeroed
    // size register and spun forever (the white-screen-after-boot bug).
    var sh=shft(op===0?0:op===1?1:2,r[rs],(off===0&&op!==0)?32:off);
    r[rd]=sh.v;setF((sh.v>>>31)&1,sh.v===0?1:0,sh.c,(cpsr>>>28)&1);return;
  }
  // Format 3: Immediate
  if((ins>>>13)===1){
    var op=(ins>>>11)&3,rd=(ins>>>8)&7,imm=ins&0xFF,rdv=r[rd]>>>0,res,C,V;
    switch(op){
      case 0:r[rd]=imm;setF(0,imm===0?1:0,(cpsr>>>29)&1,(cpsr>>>28)&1);return;
      case 1:{res=(rdv-imm)>>>0;C=rdv>=imm?1:0;V=(((rdv^imm)&(rdv^res))>>>31)&1;setF((res>>>31)&1,res===0?1:0,C,V);return;}
      case 2:{var r64=rdv+imm;res=r64>>>0;C=r64>0xFFFFFFFF?1:0;V=(((~(rdv^imm))&(rdv^res))>>>31)&1;r[rd]=res;setF((res>>>31)&1,res===0?1:0,C,V);return;}
      case 3:{res=(rdv-imm)>>>0;C=rdv>=imm?1:0;V=(((rdv^imm)&(rdv^res))>>>31)&1;r[rd]=res;setF((res>>>31)&1,res===0?1:0,C,V);return;}
    }return;
  }
  // No known THUMB encoding matched — record it rather than silently
  // treating it as a NOP (see the ARM-side comment in stepARM).
  undefInstrCount++;
  pushRecent({t:'undef-thumb',pc:'0x'+(_pc>>>0).toString(16),ins:'0x'+(ins>>>0).toString(16),n:instrCount});
}

// ── INTERRUPTS / TIMERS / DMA / SAVE MEMORY ──────────────────────────────────

function setIF(bit){var off=0x202+(bit>>3);io[off]|=(1<<(bit&7));}

// ── IRQ DISPATCH (HLE) ───────────────────────────────────────────────────────
// Real hardware, on IRQ, jumps to a small BIOS-supplied trampoline at
// 0x00000018 which loads the game's registered handler pointer from IWRAM
// (the pointer lives at 0x03007FFC, mirrored through to 0x03FFFFFC) calls
// it, then performs the actual 'SUBS PC,LR,#4' exception return once the
// handler returns via 'BX LR'/'MOV PC,LR'.
//
// This core's BIOS region is an unimplemented stub — r8() returns 0 for
// every address below 0x4000 (see the 'case 0x00:' comment) — so there is
// no real trampoline code at 0x18. Before this fix, checkIRQ jumped PC
// there anyway; since that memory is all zeros, the CPU decoded an
// unbroken stream of 'AND R0,R0,R0' no-ops and walked straight into
// unmapped memory, permanently losing the game's own execution thread.
// This reproduced exactly as: emuFps/vblankCount ticking normally (VBlank
// IRQs keep firing on schedule) while instrCount/PC froze — a stuck CPU
// that *looks* like a healthy 60fps loop from the outside. See the
// pc-unmapped boot trace captured against fixtures/test-rom.gba in
// DEBUG_EMULATOR_REPORT.md.
//
// Fix: HLE the trampoline directly in JS. Dispatch to the registered
// handler pointer ourselves, and intercept the handler's return address
// (a sentinel PC value, IRQ_RETURN_MAGIC, put in LR before dispatch) to
// perform the final SUBS-style CPSR/mode restore — see doIrqReturn(),
// called from runFrame right before each instruction fetch.
var IRQ_HANDLER_PTR_ADDR=0x03FFFFFC;
var IRQ_RETURN_MAGIC=0xFFFFFFF0;
// A STACK, not a single slot: real commercial games (pokeemerald and other
// agbcc/devkitARM-crt0 titles are the norm, not the exception) re-enable
// IME and clear the CPSR I-bit from *inside* their interrupt dispatcher to
// allow a higher-priority interrupt (e.g. a Timer IRQ driving audio) to
// nest inside a lower-priority one (e.g. VBlank) that's still running. If
// checkIRQ() fires again before the first dispatch's doIrqReturn() has run,
// a single pendingIrqReturn variable gets clobbered by the inner call —
// permanently losing the outer handler's return address/SPSR. The outer
// handler's eventual 'BX LR' then returns via garbage state instead of
// unwinding to where it was actually interrupted, producing exactly the
// "PC entered unmapped memory region" crashes seen on real games (the
// synthetic single-IRQ-source test fixture never exercises nested IRQs,
// so it didn't catch this). Use a proper LIFO stack so each nested level
// gets its own return context, popped in the right order by doIrqReturn().
var irqReturnStack=[];
var lastDispatchReturn=null,irqUnderflowReported=false;

function checkIRQ(){
  var ie=io[0x200]|(io[0x201]<<8),iff=io[0x202]|(io[0x203]<<8);
  var pending=ie&iff;
  if(pending&&halted)halted=false;
  if(!pending||!(io[0x208]&1)||(cpsr&0x80))return;
  armFetchPC=-1;
  var previousIrqSPSR=irqSPSR;
  var wasThumb=(cpsr&0x20)!==0;
  var lr=wasThumb?(r[15]+2)>>>0:r[15]>>>0;
  var spsrVal=cpsr;
  doModeSwitch(MODE_IRQ);
  irqSPSR=spsrVal;
  cpsr=(cpsr|0x80)&~0x20;
  irqCount++;
  lastIRQ={pending:pending,ie:ie,cycle:instrCount,frame:emuFrameCount,scanline:scanline};
  pushRecent({t:'irq',pending:'0x'+pending.toString(16),n:instrCount,frame:emuFrameCount});

  var handlerPtr=r32(IRQ_HANDLER_PTR_ADDR)>>>0;
  var region=handlerPtr>>>24;
  var handlerLooksValid=handlerPtr!==0&&((region>=0x02&&region<=0x07)||(region>=0x08&&region<=0x0D));
  if(handlerLooksValid){
    // The BIOS really pushes these six words onto the IRQ stack. Games
    // with cooperative threads can inspect/replace this frame, including
    // the return address. A JS-only register snapshot hides that contract.
    var biosFrame=(r[13]-24)>>>0;
    w32(biosFrame,r[0]);w32(biosFrame+4,r[1]);
    w32(biosFrame+8,r[2]);w32(biosFrame+12,r[3]);
    w32(biosFrame+16,r[12]);w32(biosFrame+20,lr);
    r[13]=biosFrame;
    irqReturnStack.push({lr:lr,spsr:spsrVal,pending:pending,prevIrqSPSR:previousIrqSPSR});
    // Shadow of the outermost dispatch's return address — the recovery
    // target if the context stack ever underflows (see doIrqReturn).
    if(irqReturnStack.length===1)lastDispatchReturn=lr;
    // Real BIOS also enters the handler with r0 = REG_BASE (0x04000000).
    r[0]=0x04000000;
    // Dispatch in IRQ mode, exactly like the real BIOS. Do NOT pre-switch
    // to System mode here: devkitARM/pokeemerald-style IntrMain handlers
    // perform their own mode dance — push registers on the IRQ stack at
    // entry, msr to System mode to run C-level work on the big sys stack,
    // then msr BACK to IRQ mode and pop before returning. If we start them
    // in System mode, their entry pushes go to the sys stack but the final
    // pops read the untouched IRQ stack, producing a garbage return
    // address and a PC slide into zero-filled IWRAM (seen on-device as
    // 'pc-unmapped' right after the first VBlank IRQ). Trivial handlers
    // that just ack-and-return run fine on the 96-byte sp_irq stack
    // (0x3007FA0), same as real hardware. The MAGIC lr lands in lr_irq,
    // which IntrMain preserves across its mode switches via its own stack.
    r[14]=IRQ_RETURN_MAGIC;
    var thumbHandler=(handlerPtr&1)!==0;
    if(thumbHandler)cpsr|=0x20;else cpsr&=~0x20;
    // checkIRQ() and the instruction step run in the SAME runFrame loop
    // iteration (see the original 'r[15]=0x18+4' convention this mirrors),
    // so the target needs only stepARM/THUMB's own fetch decrement (-4/-2)
    // added back, NOT the full branch-pipeline lookahead (+8/+4) — using
    // the latter skips the handler's first instruction entirely and
    // desyncs PC by one instruction on every single dispatch, which
    // manifests as an infinite IRQ-reentry loop (see DEBUG_EMULATOR_REPORT.md).
    r[15]=(thumbHandler?(handlerPtr&~1)+2:(handlerPtr&~3)+4)>>>0;
  }else{
    // No handler registered yet (e.g. very early boot, before the game's
    // crt0/SetInterruptHandler runs): acknowledge the flags ourselves so a
    // spurious early interrupt doesn't stay pending forever and re-enter
    // this branch every instruction, and return immediately as if a
    // trivial handler ran.
    io[0x202]&=~(pending&0xFF);io[0x203]&=~((pending>>>8)&0xFF);
    var retTarget=(lr-4)>>>0;
    doModeSwitch(spsrVal&0x1F);
    cpsr=spsrVal;
    r[15]=((cpsr&0x20)?(retTarget&~1)+2:(retTarget&~3)+4)>>>0;
  }
}

function doIrqReturn(){
  armFetchPC=-1;
  if(irqReturnStack.length===0){
    // A bx-to-MAGIC with no JS-side context means the tracking stack and
    // the game's memory-side IRQ stack desynced (e.g. an earlier wild jump
    // near MAGIC was silently absorbed as a return, or a dispatch/return
    // imbalance we haven't found). Previously this parked the PC at
    // MAGIC+4 and the core died with 'pc-unmapped 0xfffffff4'. Recover
    // instead: at IntrMain's tail the game has ALREADY restored r0-r3 and
    // spsr_irq from its own stack, so the only state we must supply is the
    // resume PC (shadowed at the outermost dispatch) and CPSR (the
    // game-maintained spsr_irq). Report once so device logs still show it.
    if(lastDispatchReturn!==null){
      var rlr=lastDispatchReturn,rspsr=irqSPSR;
      lastDispatchReturn=null;
      if(!irqUnderflowReported){
        irqUnderflowReported=true;
        pushRecent({t:'irq-underflow-recovered',n:instrCount});
        postDebug('cpuStuck',buildCrashReport('irq-return-underflow-recovered',
          {resume:'0x'+(rlr>>>0).toString(16),spsr:'0x'+(rspsr>>>0).toString(16)}));
      }
      var rt=(rlr-4)>>>0;
      doModeSwitch(rspsr&0x1F);
      cpsr=rspsr;
      r[15]=((cpsr&0x20)?(rt&~1)+2:(rt&~3)+4)>>>0;
      if(intrWaitFlags!==null)halted=true; // re-park a pending IntrWait safely
      return;
    }
    r[15]=(IRQ_RETURN_MAGIC+4)>>>0;return; // no shadow either — old defensive path
  }
  var ctx=irqReturnStack.pop();
  // Emulate BIOS LDMFD SP!,{r0-r3,r12,lr}; SUBS PC,lr,#4.
  // Both the memory frame and SPSR may have been changed by the handler
  // to resume a different thread. Never overwrite those changes with a
  // snapshot captured at dispatch.
  var biosFrame=r[13]>>>0;
  var lr=r32(biosFrame+20)>>>0,spsr=irqSPSR;
  r[0]=r32(biosFrame);r[1]=r32(biosFrame+4);
  r[2]=r32(biosFrame+8);r[3]=r32(biosFrame+12);r[12]=r32(biosFrame+16);
  r[14]=lr;
  r[13]=(biosFrame+24)>>>0;
  irqSPSR=ctx.prevIrqSPSR; // un-clobber the outer dispatch's banked SPSR
  var retTarget=(lr-4)>>>0;
  doModeSwitch(spsr&0x1F);
  cpsr=spsr;
  r[15]=((cpsr&0x20)?(retTarget&~1)+2:(retTarget&~3)+4)>>>0;
  pushRecent({t:'irq-return',n:instrCount});
  // Only the outermost return (stack now empty) actually lands back on the
  // game's real interrupted PC — a nested return just unwinds to an
  // intermediate handler still running. That's the only point where an
  // IntrWait/VBlankIntrWait wake condition can be judged: if the game was
  // waiting for a specific IF bit and the source we just serviced (as
  // captured in ctx.pending at dispatch time, NOT the current IF register
  // — the handler's own ack has likely already cleared that bit by now,
  // so re-reading IF here would get the sense of the check backwards) had
  // nothing to do with it, park it again instead of letting it resume on
  // the wrong signal (see intrWaitFlags).
  if(irqReturnStack.length===0&&intrWaitFlags!==null){
    if(ctx.pending&intrWaitFlags)intrWaitFlags=null;else halted=true;
  }
}

// A halted CPU has no instructions between hardware edges. Clock timers can
// advance arithmetically until their first overflow; cascade timers only move
// at their parent's overflow and therefore do not add an earlier boundary.
function nextTimerOverflowCycles(){
  var next=Infinity;
  for(var t=0;t<4;t++){
    var control=io[0x102+t*4];
    if(!(control&0x80)||(t>0&&(control&4)))continue;
    next=Math.min(next,(0x10000-timerCounter[t])*TIMER_PRESCALE[control&3]-timerPrescaleCnt[t]);
  }
  return next;
}
function tickTimers(cycles,idleBatch){
  if(idleBatch&&cycles>2){
    // The scheduler proved there is no event before the final two-cycle
    // quantum. Advance ALL quiet counters first, so a FIFO DMA at the edge
    // sees the other timers at the same phase as the original loop.
    var quiet=cycles-2;
    audioCycleAcc+=quiet;
    for(var q=0;q<4;q++){
      var control=io[0x102+q*4];
      if(!(control&0x80)||(q>0&&(control&4)))continue;
      var divisor=TIMER_PRESCALE[control&3];
      var total=timerPrescaleCnt[q]+quiet;
      var ticks=Math.max(0,Math.floor(total/divisor));
      timerCounter[q]+=ticks;
      timerPrescaleCnt[q]=total-ticks*divisor;
    }
    cycles=2;
  }
  audioCycleAcc+=cycles;
  while(audioCycleAcc>=512){audioCycleAcc-=512;pushAudioSample();}
  for(var t=0;t<4;t++){
    var cntH=io[0x100+t*4+2];
    if(!(cntH&0x80))continue;
    if((cntH&0x4)&&t>0)continue; // cascade timers advance only via overflow, not the clock
    timerPrescaleCnt[t]+=cycles;
    var presc=TIMER_PRESCALE[cntH&3];
    while(timerPrescaleCnt[t]>=presc){
      // Ordinary counter increments have no side effects. Stop at overflow:
      // that edge can cascade, request DMA/IRQ, or rewrite timer registers.
      var increments=Math.floor(timerPrescaleCnt[t]/presc);
      var untilOverflow=0x10000-timerCounter[t];
      if(increments<untilOverflow){
        timerCounter[t]+=increments;
        timerPrescaleCnt[t]-=increments*presc;
        break;
      }
      timerPrescaleCnt[t]-=untilOverflow*presc;
      timerCounter[t]=0xFFFF;
      timerOverflowStep(t);
    }
  }
}
function timerOverflowStep(t){
  timerCounter[t]=(timerCounter[t]+1)&0xFFFF;
  if(timerCounter[t]===0){
    timerCounter[t]=timerReload[t];
    // Direct Sound: the selected timer's overflow pops one FIFO sample; a
    // FIFO at <=16 bytes requests the special DMA1/2 refill (4 words).
    // NOT gated on SOUNDCNT_X master enable — that only mutes the mixer
    // output; the FIFO state machine keeps draining on hardware.
    if(t<2){
      var sh=io[0x82]|(io[0x83]<<8);
      if(((sh>>>10)&1)===t){
        if(fifoALen>0){dsA=fifoA[fifoAHead];fifoAHead=(fifoAHead+1)&31;fifoALen--;}
        if(fifoALen<=16)fifoRefillDMA(0x040000A0);
      }
      if(((sh>>>14)&1)===t){
        if(fifoBLen>0){dsB=fifoB[fifoBHead];fifoBHead=(fifoBHead+1)&31;fifoBLen--;}
        if(fifoBLen<=16)fifoRefillDMA(0x040000A4);
      }
    }
    if(io[0x100+t*4+2]&0x40)setIF(3+t);
    if(t<3){
      var nextCntH=io[0x100+(t+1)*4+2];
      if((nextCntH&0x80)&&(nextCntH&0x4))timerOverflowStep(t+1);
    }
  }
}

function triggerDMA(timing){
  for(var d=0;d<4;d++){var st=dma[d];if(st.active&&((st.activeCntH>>>12)&3)===timing)execDMA(d);}
}
function execDMA(d){
  var st=dma[d],cntH=st.activeCntH;
  var word32=(cntH>>>10)&1,destCtl=(cntH>>>5)&3,srcCtl=(cntH>>>7)&3,repeat=(cntH>>>9)&1;
  var maxCount=d===3?0x10000:0x4000;
  var count=st.countLatch&(maxCount-1);if(count===0)count=maxCount;
  // Palette-write provenance for the GPU debug report: remember where the
  // most recent transfer into palette RAM sourced its data so readGpu can
  // dump the EWRAM staging buffers and localize halfword corruption.
  if(((st.dstCur>>>24)&0xFF)===0x05)tracePalWrite('dma'+d,st.srcCur,count,word32,false);
  var step=word32?4:2;
  var srcAddr=st.srcCur>>>0,dstAddr=st.dstCur>>>0,actualSrc=srcAddr,actualDst=dstAddr;
  var programmedSrc=st.sad>>>0,programmedDst=st.dad>>>0;
  var dstIsEeprom=saveType==='eeprom'&&(dstAddr>>>24)===0x0D;
  var srcIsEeprom=saveType==='eeprom'&&(srcAddr>>>24)===0x0D;
  if(dstIsEeprom&&count>1){eepromAddrBits=count>30?(count-67):(count-3);eepromMode='idle';eepromWriteBuf=[];}
  dmaBusWrite=true;
  try{
    for(var i=0;i<count;i++){
      if(dstIsEeprom){var bit=(word32?r32(srcAddr):r16(srcAddr))&1;eepromWriteBit(bit);}
      else if(srcIsEeprom){var bit2=eepromReadBit();if(word32)w32(dstAddr,bit2);else w16(dstAddr,bit2);}
      else{if(word32)w32(dstAddr,r32(srcAddr));else w16(dstAddr,r16(srcAddr));}
      if(srcCtl===0)srcAddr=(srcAddr+step)>>>0;else if(srcCtl===1)srcAddr=(srcAddr-step)>>>0;
      // Destination control 2 is fixed. Treating every value other than
      // decrement as increment makes a perfectly normal fixed-address DMA
      // (notably a repeated HBlank write to one I/O register) walk through
      // the entire I/O block. Once it reaches DMAxSAD/DAD/CNT and IE/IME,
      // the transfer rewrites its own programming state and can leave a
      // BIOS IntrWait parked with IE=IME=0. Control 3 increments during the
      // transfer and is reloaded below only when Repeat is set.
      if(destCtl===1)dstAddr=(dstAddr-step)>>>0;
      else if(destCtl===0||destCtl===3)dstAddr=(dstAddr+step)>>>0;
    }
  }finally{dmaBusWrite=false;}
  st.srcCur=srcAddr;st.dstCur=dstAddr;
  if(cntH&0x4000)setIF(8+d);
  if(repeat&&destCtl===3)st.dstCur=st.dstReload;
  if(!repeat){st.active=false;st.cntH&=~0x8000;io[st.base+0xA+1]&=~0x80;}
  dmaCount++;
  // src/dst name the actual pointer used for THIS transfer. Keep both
  // before/after programmed-register snapshots alongside them: this
  // distinguishes a live DMA pointer fault from a game (or a self-targeted
  // transfer) rewriting SAD/DAD while the latched transfer remains valid.
  pushRecent({t:'dma',ch:d,src:'0x'+actualSrc.toString(16),dst:'0x'+actualDst.toString(16),
    programmedSrc:'0x'+programmedSrc.toString(16),programmedDst:'0x'+programmedDst.toString(16),
    programmedSrcAfter:'0x'+(st.sad>>>0).toString(16),programmedDstAfter:'0x'+(st.dad>>>0).toString(16),
    actualSrcAfter:'0x'+(st.srcCur>>>0).toString(16),actualDstAfter:'0x'+(st.dstCur>>>0).toString(16),
    count:count,word32:!!word32,n:instrCount,frame:emuFrameCount});
}

// FLASH (Macronix-style 64KB/128KB save chips)
function flashRead(addr){
  var off=addr&0xFFFF;
  if(flashIdMode&&off<2){
    var idb=saveType==='flash128'?(off===0?0xC2:0x09):(off===0?0x32:0x1A);
    return idb;
  }
  var bankOff=flashBank?0x10000:0;
  return sram[bankOff+off];
}
function flashWrite(addr,v){
  var off=addr&0xFFFF;
  if(flashProgramMode){var bankOff=flashBank?0x10000:0;sram[bankOff+off]=v;flashProgramMode=false;batteryDirty=true;return;}
  if(flashCmdStage===3){flashBank=v&1;flashCmdStage=0;return;}
  if(flashCmdStage===0&&off===0x5555&&v===0xAA){flashCmdStage=1;return;}
  if(flashCmdStage===1&&off===0x2AAA&&v===0x55){flashCmdStage=2;return;}
  if(flashCmdStage===2){
    flashCmdStage=0;
    if(v===0x90)flashIdMode=true;
    else if(v===0xF0)flashIdMode=false;
    else if(v===0xA0)flashProgramMode=true;
    else if(v===0xB0)flashCmdStage=3;
    else if(v===0x80)flashCmdStage=4;
    return;
  }
  if(flashCmdStage===4&&off===0x5555&&v===0xAA){flashCmdStage=5;return;}
  if(flashCmdStage===5&&off===0x2AAA&&v===0x55){flashCmdStage=6;return;}
  if(flashCmdStage===6){
    flashCmdStage=0;
    if(v===0x10){sram.fill(0xFF);batteryDirty=true;}
    else if(v===0x30){var bankOff=flashBank?0x10000:0,sect=off&0xF000;for(var i=0;i<0x1000;i++)sram[bankOff+sect+i]=0xFF;batteryDirty=true;}
    return;
  }
}

// EEPROM (512B/8KB serial save chips, accessed only via DMA bit-stream)
function eepromWriteBit(bit){
  eepromWriteBuf.push(bit&1);
  if(eepromMode==='idle'){
    if(eepromWriteBuf.length===2){
      var op=(eepromWriteBuf[0]<<1)|eepromWriteBuf[1];eepromWriteBuf=[];
      eepromMode=op===2?'writeAddr':op===3?'readAddr':'idle';
    }
    return;
  }
  if(eepromMode==='writeAddr'||eepromMode==='readAddr'){
    if(eepromWriteBuf.length>=eepromAddrBits){
      var addr=0;for(var i=0;i<eepromAddrBits;i++)addr=(addr<<1)|eepromWriteBuf[i];
      eepromCurAddr=addr;eepromWriteBuf=[];
      if(eepromMode==='writeAddr')eepromMode='writeData';
      else{eepromMode='idle';eepromReadQueue=eepromBuildReadQueue(eepromCurAddr);}
    }
    return;
  }
  if(eepromMode==='writeData'){
    if(eepromWriteBuf.length>=64){
      var bits=eepromWriteBuf.splice(0,64);
      for(var b=0;b<8;b++){
        var byte=0;for(var i=0;i<8;i++)byte=(byte<<1)|bits[b*8+i];
        eepromData[(eepromCurAddr*8+b)&0x1FFF]=byte;batteryDirty=true;
      }
      eepromMode='idle';eepromWriteBuf=[];
    }
    return;
  }
}
function eepromBuildReadQueue(addr){
  var q=[0,0,0,0];
  for(var b=0;b<8;b++){
    var byte=eepromData[(addr*8+b)&0x1FFF];
    for(var i=7;i>=0;i--)q.push((byte>>>i)&1);
  }
  return q;
}
function eepromReadBit(){return eepromReadQueue.length?eepromReadQueue.shift():1;}

function romContains(str){
  if(!rom)return false;
  var bytes=[];for(var i=0;i<str.length;i++)bytes.push(str.charCodeAt(i));
  var n=bytes.length,len=rom.length;
  for(var i=0;i<=len-n;i++){
    if(rom[i]!==bytes[0])continue;
    var ok=true;
    for(var j=1;j<n;j++){if(rom[i+j]!==bytes[j]){ok=false;break;}}
    if(ok)return true;
  }
  return false;
}
// ── BATTERY-SAVE SNAPSHOT / RESTORE ─────────────────────────────────────────
// A battery save is a small JSON envelope: version, saveType, base64 data
// (EEPROM buffer for eeprom carts, the shared sram buffer for everything
// else) and an additive checksum. The checksum lets the load path tell
// "file corrupted / truncated" apart from "no save yet" and report it
// loudly instead of silently starting the game with a blank save.
function batteryChecksum(buf){var s=0;for(var i=0;i<buf.length;i++)s=(s+buf[i])>>>0;return s;}
function buildBatterySave(){
  var buf=saveType==='eeprom'?eepromData:sram;
  return JSON.stringify({v:1,saveType:saveType,len:buf.length,checksum:batteryChecksum(buf),data:safeB64(buf)});
}
// Returns null on success, or a human-readable error string on corruption.
function applyBatterySave(text){
  var s;
  try{s=JSON.parse(text);}catch(e){return'save file is not valid JSON: '+String(e&&e.message||e);}
  if(!s||typeof s.data!=='string')return'save file missing data field';
  var bytes;
  try{bytes=Uint8Array.from(atob(s.data),function(c){return c.charCodeAt(0);});}
  catch(e){return'save file base64 decode failed: '+String(e&&e.message||e);}
  if(typeof s.len==='number'&&bytes.length!==s.len)
    return'save file truncated: expected '+s.len+' bytes, got '+bytes.length;
  if(typeof s.checksum==='number'&&batteryChecksum(bytes)!==s.checksum)
    return'save file checksum mismatch (data corrupted)';
  var target=s.saveType==='eeprom'?eepromData:sram;
  if(bytes.length>target.length)
    return'save file too large for '+String(s.saveType)+' buffer ('+bytes.length+' bytes)';
  target.set(bytes);
  batteryDirty=false;batterySaveCleared=false;
  return null;
}
function flushBatterySave(force,requestId){
  if(batterySaveCleared&&!batteryDirty)return;
  if(!batteryDirty&&!force)return;
  batteryDirty=false;batterySaveCleared=false;
  postDebug('batterySave',{save:buildBatterySave(),saveType:saveType,requestId:requestId});
}

function detectSaveType(){
  flashBank=0;flashCmdStage=0;flashIdMode=false;flashProgramMode=false;
  eepromMode='idle';eepromWriteBuf=[];eepromReadQueue=[];eepromAddrBits=6;
  if(!rom){saveType='sram';return;}
  if(romContains('EEPROM_V'))saveType='eeprom';
  else if(romContains('FLASH1M_V'))saveType='flash128';
  else if(romContains('FLASH512_V')||romContains('FLASH_V'))saveType='flash64';
  else saveType='sram';
}

// ── MAIN LOOP ────────────────────────────────────────────────────────────────

function resetGBA(){
  armFetchPC=-1;
  resetFramePacing();
  resetPerformance();
  wram.fill(0);iwram.fill(0);io.fill(0);pal.fill(0);vram.fill(0);oam.fill(0);
  linkOut=0xFFFF;linkBusy=false;linkError=false;linkActiveId=-1;
  r.fill(0);
  r[13]=0x03007F00;r[14]=0x08000000;r[15]=0x08000004;
  cpsr=0x1F;
  bankR13[bankKey(MODE_SYS)]=0x03007F00;bankR14[bankKey(MODE_SYS)]=0;
  bankR13[MODE_SVC]=0x03007FE0;bankR13[MODE_IRQ]=0x03007FA0;bankR14[MODE_SVC]=0;bankR14[MODE_IRQ]=0;
  halted=false;
  timerCounter=[0,0,0,0];timerReload=[0,0,0,0];timerPrescaleCnt=[0,0,0,0];
  fifoALen=0;fifoAHead=0;fifoBLen=0;fifoBHead=0;dsA=0;dsB=0;audioCycleAcc=0;
  // A reset must not replay samples queued by the previous ROM/session.
  audioWrite=0;audioRead=0;audioRingL.fill(0);audioRingR.fill(0);
  psgOn=[false,false,false,false];sqDutyPos=[0,0];sqTimer=[0,0];sqEnv=[0,0];sqEnvT=[0,0];sqLen=[0,0];
  swpTimer=0;swpShadow=0;swpEnabled=false;
  wavPos=0;wavTimer=0;wavLen=0;wavSample=0;waveRam.fill(0);
  noiLfsr=0x7FFF;noiTimer=0;noiEnv=0;noiEnvT=0;noiLen=0;
  psgFrameAcc=0;psgFrame=0;psgLastL=0;psgLastR=0;
  for(var d=0;d<4;d++){dma[d].active=false;dma[d].sad=0;dma[d].dad=0;dma[d].cntL=0;dma[d].cntH=0;dma[d].srcCur=0;dma[d].dstCur=0;dma[d].dstReload=0;dma[d].countLatch=0;dma[d].activeCntH=0;}
  dmaBusWrite=false;
  detectSaveType();
  io[0x130]=0xFF;io[0x131]=0x03;
  scanline=0;scanlineCycles=0;hblankFlagged=false;
  running=true;
  fpsCount=0;fps=0;lastFpsMs=performance.now();
  // Reset all diagnostics for the new ROM session so a boot trace always
  // starts from instruction zero of THIS boot, not a stale previous run.
  // Rearm bounded boot sampling even if the previous boot trace completed.
  instrCount=0;swiCount=0;dmaCount=0;irqCount=0;vblankCount=0;undefInstrCount=0;
  palWriteTrace=null;palWatchHits.length=0;gpioReset();
  haltedIdleFrames=0;displayEverEnabled=false;
  lastIRQ=null;lastSWI=null;lastCompletedFrame=0;instrSinceVBlank=0;
  pcHistory.fill(0);pcHistoryIdx=0;pcHistoryCount=0;traceLog=[];traceInstrCount=0;traceActive=true;recentEvents=[];
  denseIdx=0;denseCount=0;jumpIdx=0;jumpCount=0;prevStepPC=-1;prevStepSize=4;
  fbHashPrev=-1;fbHashRepeatCount=0;fbChangedEver=false;
  uiFrameCount=0;uiFps=0;lastUiFpsMs=performance.now();
  emuFrameCount=0;emuFps=0;lastEmuFpsMs=performance.now();
  ipsCount=0;ips=0;lastIpsMs=performance.now();
  stuckReason=null;cpuErrorInfo=null;
  irqReturnStack=[];intrWaitFlags=null;
  scheduleFrame();
}

function scheduleFrame(){
  if(frameTimer){if(frameTimerTimeout)clearTimeout(frameTimer);else cancelAnimationFrame(frameTimer);}
  var background=!audioNativeActive||!audioPageVisible;
  frameTimerTimeout=background||useAndroidFastTask();
  frameTimer=frameTimerTimeout?setTimeout(runFrame,background?1000:0):requestAnimationFrame(runFrame);
}

function useAndroidFastTask(){
  // A saturated FF burst on Android may miss a display deadline. Waiting
  // for another Choreographer/rAF tick then discards usable CPU time.
  // Yield through a task only while there is real outstanding FF work.
  // Each burst retains the existing wall-time cap; never spin while paused,
  // link-blocked, backgrounded or stopped. No raster/hardware work is skipped.
  return nativeHostPlatform==='android'&&audioNativeActive&&audioPageVisible&&fastForward>1&&pacingCycles>0&&
    running&&!!rom&&!stuckReason&&!cpuErrorInfo&&!(linkConnected&&linkBusy);
}

function postDebug(type,payload){
  if(!window.ReactNativeWebView)return;
  try{window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({type:type},payload)));}catch(e){}
}

function runFrame(){
  // UI FPS counts requestAnimationFrame callbacks — how often the render
  // loop itself ticks. This is deliberately tracked separately from
  // emuFps (below), which only increments when the GBA core reaches a
  // real VBlank. If the core is stuck, uiFps keeps climbing while emuFps
  // and instrCount go flat — that gap IS the "fake 60 FPS" symptom.
  uiFrameCount++;
  var nowUi=performance.now();
  if(nowUi-lastUiFpsMs>=1000){uiFps=uiFrameCount;uiFrameCount=0;lastUiFpsMs=nowUi;}

  // Flush dirty battery-save memory about once per second. This runs
  // BEFORE the running/stuck early-return below on purpose: a core that
  // wedges right after the game commits a save must still flush it.
  if(batteryDirty&&nowUi-lastBatteryFlushMs>=1000){lastBatteryFlushMs=nowUi;flushBatterySave(false);}

  // Physical GBAs have independent CPU clocks; the cable synchronizes each
  // 16-bit serial exchange, not the consoles' global frame/CPU state. Pause
  // this CPU only while its SIO transfer is active so it cannot observe
  // completion before the peer word arrives. UI and networking stay live.
  if(linkConnected&&linkBusy){resetFramePacing();scheduleFrame();return;}

  if(!audioNativeActive||!audioPageVisible||!running||!rom||stuckReason||cpuErrorInfo){resetFramePacing();scheduleFrame();return;}
  // Accumulate emulated CPU cycles from actual elapsed time, not display
  // refresh rate. Preserve fractional cycles across callbacks (120 Hz needs
  // two callbacks per GBA frame); drop excess debt rather than chasing a
  // backgrounded tab indefinitely. No pitch preservation in fast-forward.
  if(lastPacingMs===null)lastPacingMs=nowUi;
  var elapsed=Math.max(0,nowUi-lastPacingMs);
  if(elapsed>100)perfStats.mainThreadStalls++;
  lastPacingMs=nowUi;
  pacingCycles=Math.min(MAX_PACING_CYCLES*fastForward,pacingCycles+
    Math.min(elapsed,1000)*GBA_CLOCK_HZ*fastForward/1000);
  var TARGET=pacingCycles,fc=0,workStart=nowUi,workChecks=0,lastClassifiedInstr=-1;
  var callbackBudget=frameWorkBudget(elapsed,fastForward);
  // ImageData is filled line by line. Once a frame completes, copy it before
  // the next frame starts overwriting rows; present only the latest complete
  // snapshot, once, when this callback yields.
  var completedImage=false,completedFrames=0,segmentStart=workStart;
  try{
    while(fc<TARGET){
      checkIRQ();
      var cycles=2,timerIdleBatch=false;
      var atIrqReturn=((cpsr&0x20)?(r[15]-2)>>>0:(r[15]-4)>>>0)===IRQ_RETURN_MAGIC;
      if(atIrqReturn)doIrqReturn();
      else if(!halted){
        if(cpsr&0x20)stepTHUMB();else{stepARM();cycles=armInstructionCycles;}
        // If that instruction just returned to the MAGIC sentinel (IntrMain
        // tail bx lr), unwind the dispatch NOW, in the same iteration.
        // Leaving PC parked on the sentinel until the next iteration opened
        // two failure windows: (1) the every-1024-instructions stuck
        // classifier could run first and kill the core as 'pc-unmapped
        // 0xfffffff4' (a 1-in-1024 race per IRQ return — the on-device
        // frame-427 crash: its cycle count was exactly divisible by 1024);
        // (2) checkIRQ could dispatch a nested IRQ while PC sat on the
        // sentinel, pushing a return context whose lr points at MAGIC
        // itself and corrupting the unwind.
        if(((cpsr&0x20)?(r[15]-2)>>>0:(r[15]-4)>>>0)===IRQ_RETURN_MAGIC)doIrqReturn();
      }else{
        // Only batch a CPU that was already idle after IRQ/sentinel handling.
        // A SWI or IRQ-return instruction that JUST set halted still costs 2
        // cycles above. Stop at the earliest clock-timer overflow, including
        // those feeding cascades, FIFO DMA and IRQs. No guest instruction or
        // hardware event is skipped while the CPU waits.
        // Stop on every hardware boundary, retaining the original 2-cycle
        // grid and its final-budget overshoot for odd/fractional targets.
        timerIdleBatch=true;
        cycles=Math.max(2,Math.ceil(Math.min(TARGET-fc,512-audioCycleAcc,nextTimerOverflowCycles(),
          hblankFlagged?CYCLES_PER_SCANLINE-scanlineCycles:960-scanlineCycles,
          CYCLES_PER_SCANLINE-scanlineCycles,2048-(workChecks&0x3FF)*2)/2)*2);
        // Count the same 2-cycle quanta as the instruction path below, so
        // batching cannot postpone the existing wall-time budget check.
        workChecks+=(cycles>>>1)-1;
      }
      tickTimers(cycles,timerIdleBatch&&cycles>2);
      fc+=cycles;scanlineCycles+=cycles;
      // A SIOCNT start write can happen inside the instruction above.
      // Stop in this same loop iteration, immediately after accounting for
      // that instruction's cycles, rather than running the rest of a frame.
      if(linkConnected&&linkBusy){resetFramePacing();break;}

      // Detect and report a stuck core immediately, mid-frame — do not
      // wait for the frame (or the deceptive VBlank-driven FPS counter)
      // to keep ticking while the CPU has stopped making real progress.
      if((instrCount&0x3FF)===0&&instrCount!==lastClassifiedInstr){
        lastClassifiedInstr=instrCount;
        var stuck=classifyStuck();
        if(stuck){
          stuckReason=stuck;
          var report=buildCrashReport(stuck.category,stuck.detail);
          statusEl.style.display='';statusEl.textContent='STUCK: '+stuck.detail;
          postDebug('cpuStuck',report);
          console.error('[GBA] CPU stuck:',stuck.detail,report);
          break;
        }
      }

      // HBlank starts 960 cycles into each scanline (240px * 4cyc). Real
      // games rely on the HBlank DISPSTAT status bit, the HBlank IRQ, and
      // HBlank-timed DMA (DMA timing 2) for raster effects — without them
      // per-scanline effects (wavy backgrounds, palette sweeps) glitch.
      if(!hblankFlagged&&scanlineCycles>=960){
        hblankFlagged=true;
        // Render the visible line BEFORE HBlank side effects: on hardware
        // the line is drawn during active display, so an HBlank DMA (e.g.
        // per-scanline scroll/palette raster effects) must only affect the
        // NEXT line, not the one just finished.
        if(scanline<SCREEN_H){
          // Sample one full raster frame in 60, not every hot scanline.
          if(vblankCount%60===0){
            var renderStart=performance.now();renderLine(scanline);
            perfStats.renderSampleMs+=performance.now()-renderStart;
            if(scanline===SCREEN_H-1)perfStats.renderSamples++;
          }else renderLine(scanline);
        }
        io[0x4]|=0x02;                       // DISPSTAT HBlank status
        if(io[0x4]&0x10)setIF(1);            // HBlank IRQ if enabled
        if(scanline<SCREEN_H)triggerDMA(2);  // HBlank DMA, visible lines only
      }
      if(scanlineCycles>=CYCLES_PER_SCANLINE){
        scanlineCycles-=CYCLES_PER_SCANLINE;
        hblankFlagged=false;
        io[0x4]&=~0x02;                      // HBlank status ends at line start
        scanline++;io[0x6]=scanline&0xFF;
        // VCount coincidence: DISPSTAT bit2 tracks (VCOUNT === LYC) every
        // line; the VCount IRQ (IF bit 2) fires on match when DISPSTAT bit5
        // is set. Pokémon-engine games drive raster effects and even game
        // logic off VCount IRQs (IE bit 2) — this was entirely missing.
        checkVCountMatch();
        if(scanline===SCREEN_H){
          // Halted-starvation detector: a CPU parked in IntrWait/Halt retires
          // zero instructions, so instrSinceVBlank never grows and the normal
          // classifyStuck() thresholds can never fire — a permanent white
          // screen was invisible to diagnostics. Count consecutive frames
          // with no retired instructions while halted and report explicitly,
          // including the wait mask and interrupt state needed to see WHY
          // the wake never comes.
          if(halted&&instrSinceVBlank===0){
            haltedIdleFrames++;
            if(haltedIdleFrames===HALT_STARVE_FRAMES&&!stuckReason){
              stuckReason={category:'halt-never-wakes',detail:'CPU halted for '+HALT_STARVE_FRAMES+' frames with no interrupt wake'};
              var hrep=buildCrashReport('halt-never-wakes',{intrWaitFlags:intrWaitFlags,
                ie:io[0x200]|(io[0x201]<<8),iff:io[0x202]|(io[0x203]<<8),ime:io[0x208]&1,
                dispstat:io[4]|(io[5]<<8),handlerPtr:'0x'+(r32(IRQ_HANDLER_PTR_ADDR)>>>0).toString(16)});
              statusEl.style.display='';statusEl.textContent='STUCK: halted, no interrupt ever wakes the CPU';
              postDebug('cpuStuck',hrep);
              console.error('[GBA] CPU stuck: halt-never-wakes',hrep);
              break;
            }
          }else haltedIdleFrames=0;
          // Busy-spin white-screen detector: the CPU is executing (so the
          // pc-frozen and halted-starvation detectors stay silent) but after
          // ~5s the display was never taken out of forced blank / never had
          // any BG or OBJ layer enabled — nothing can ever be drawn. Report
          // once (do not stop the core — the game might still recover) with
          // the poll clue: DISPCNT/DISPSTAT/interrupt state plus the ring of
          // recent I/O read offsets, which names the register being polled.
          if(!displayEverEnabled){
            var dcnt=io[0]|(io[1]<<8);
            if(!(dcnt&0x80)&&(dcnt&0x1F00))displayEverEnabled=true;
            else if(vblankCount===BLANK_SCREEN_FRAMES&&!stuckReason){
              var ioReads={};
              for(var qi=0;qi<32;qi++){var ro='0x'+(0x4000000+ioReadRing[qi]).toString(16);ioReads[ro]=(ioReads[ro]||0)+1;}
              var brep=buildCrashReport('display-never-enabled',{dispcnt:'0x'+dcnt.toString(16),
                dispstat:io[4]|(io[5]<<8),ie:io[0x200]|(io[0x201]<<8),iff:io[0x202]|(io[0x203]<<8),
                ime:io[0x208]&1,halted:halted,intrWaitFlags:intrWaitFlags,recentIoReads:ioReads,
                handlerPtr:'0x'+(r32(IRQ_HANDLER_PTR_ADDR)>>>0).toString(16)});
              statusEl.style.display='';statusEl.textContent='DIAG: display never enabled after '+BLANK_SCREEN_FRAMES+' frames (see report)';
              postDebug('cpuStuck',brep);
              console.error('[GBA] display never enabled',brep);
            }
          }
          io[0x4]|=0x01; // DISPSTAT VBlank status bit — games poll this too
          if(io[0x4]&0x08)io[0x202]|=0x01; // VBlank IRQ only if DISPSTAT enables it
          triggerDMA(1);
          presentationData.data.set(imgData.data);completedImage=true;completedFrames++;
          vblankCount++;emuFrameCount++;lastCompletedFrame=emuFrameCount;
          instrSinceVBlank=0;
          var h=fbHash();
          if(h!==fbHashPrev){fbChangedEver=true;fbHashRepeatCount=0;}else fbHashRepeatCount++;
          fbHashPrev=h;
          fpsCount++;
          var now=performance.now();
          var frameWork=perfPartialFrameMs+now-segmentStart;
          perfStats.frames++;perfStats.frameWorkMs+=frameWork;
          perfStats.peakFrameWorkMs=Math.max(perfStats.peakFrameWorkMs,frameWork);
          perfPartialFrameMs=0;segmentStart=now;
          var secondTicked=false;
          if(now-lastFpsMs>=1000){fps=fpsCount;fpsCount=0;lastFpsMs=now;}
          if(now-lastEmuFpsMs>=1000){
            emuFps=(vblankCount-_prevVblankSample)*1000/(now-lastEmuFpsMs);_prevVblankSample=vblankCount;lastEmuFpsMs=now;secondTicked=true;
          }
          if(now-lastIpsMs>=1000){ips=ipsCount;ipsCount=0;lastIpsMs=now;}
          // Hide the per-frame stats readout during normal play — the UI should
    // look like a consumer product, not a debug screen. The banner re-shows
    // itself for loading progress, STUCK states, and CPU errors.
    statusEl.style.display='none';
          if(secondTicked){
            postDebug('debugStats',{performance:performanceSnapshot(now),uiFps:uiFps,emuFps:emuFps,ips:ips,instrCount:instrCount,pc:'0x'+(r[15]>>>0).toString(16),
              scanline:scanline,lastCompletedFrame:lastCompletedFrame,vblankCount:vblankCount,irqCount:irqCount,
              swiCount:swiCount,dmaCount:dmaCount,undefInstrCount:undefInstrCount,fbChangedEver:fbChangedEver,
              fbHashRepeatCount:fbHashRepeatCount,saveType:saveType});
          }
        }
        if(scanline>=TOTAL_SCANLINES){
          scanline=0;io[0x6]=0;io[0x4]&=~3;
          // Re-evaluate coincidence for line 0 too — checking only after the
          // increment above means a compare value of 0 would never match.
          checkVCountMatch();
        }
      }
      // Checking the clock on every instruction is expensive on WebViews.
      // At most ~2048 emulated cycles elapse between checks, even in HALT.
      if((++workChecks&0x3FF)===0&&performance.now()-workStart>=callbackBudget){perfStats.budgetYields++;break;}
    }
  }catch(e){
    cpuErrorInfo=buildCrashReport('exception',String(e&&e.message||e));
    statusEl.style.display='';statusEl.textContent='CPU error: '+(e&&e.message||e)+' @ PC 0x'+(r[15]>>>0).toString(16);
    postDebug('cpuError',cpuErrorInfo);
    console.error('[GBA] CPU error:',e,cpuErrorInfo);
  }
  perfPartialFrameMs+=performance.now()-segmentStart;
  if(completedImage){
    var presentStart=performance.now();ctx.putImageData(presentationData,0,0);
    perfStats.presentMs+=performance.now()-presentStart;perfStats.presents++;
    perfStats.skippedVideoFrames+=Math.max(0,completedFrames-1);
  }
  if((linkConnected&&linkBusy)||stuckReason||cpuErrorInfo)resetFramePacing();
  else pacingCycles=Math.max(0,pacingCycles-fc);
  scheduleFrame();
}
var _prevVblankSample=0;

// ── INPUT ────────────────────────────────────────────────────────────────────
var KEY_MAP={a:0,b:1,select:2,start:3,right:4,left:5,up:6,down:7,r:8,l:9};
function setKey(k,press){
  if(!(k in KEY_MAP))return;
  var bit=1<<KEY_MAP[k];
  if(press)keyinput&=~bit;else keyinput|=bit;
  io[0x130]=keyinput&0xFF;io[0x131]=(keyinput>>>8)&0xFF;
}
// Several sources (host touch/native input, in-page keyboard, Gamepad API)
// may hold the same GBA key. The key stays pressed until the LAST holder
// releases it; a vanished source (blur, disconnect) releases only its own.
var _keyHolders={};
function setSourceKey(src,k,press){
  if(!(k in KEY_MAP))return;
  var h=_keyHolders[k]||(_keyHolders[k]={}),n,was=false,is=false;
  for(n in h){was=true;break;}
  if(press)h[src]=1;else delete h[src];
  for(n in h){is=true;break;}
  if(was!==is)setKey(k,is);
}
function releaseSourceKeys(prefix){
  for(var k in _keyHolders){
    for(var s in _keyHolders[k]){
      if(prefix===null||s===prefix||s.indexOf(prefix+':')===0)setSourceKey(s,k,false);
    }
  }
}
// Saved bindings (see library/inputMapping.ts). Physical input -> action.
var _kbMap={ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',KeyZ:'b',KeyX:'a',KeyA:'l',KeyS:'r',Enter:'start',ShiftLeft:'select',ShiftRight:'select',KeyF:'speed'};
var _padMap={'0':'a','1':'b','4':'l','5':'r','8':'select','9':'start','12':'up','13':'down','14':'left','15':'right','7':'speed'};
var _kbInCore=false;
var _inputEnabled=true; // host disables while its menu / modals are open
function _requestSpeedCycle(){
  window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'requestSpeedCycle'}));
}
function _editableTarget(t){
  return t&&t.closest&&t.closest('a[href], button, input, textarea, select, [contenteditable="true"]');
}
document.addEventListener&&document.addEventListener('keydown',function(e){
  if(!_kbInCore||!_inputEnabled||e.altKey||e.ctrlKey||e.metaKey||_editableTarget(e.target))return;
  var action=_kbMap[e.code];if(!action)return;
  e.preventDefault();
  if(e.repeat)return;
  if(action==='speed'){_requestSpeedCycle();return;}
  setSourceKey('kb:'+e.code,action,true);
},true);
document.addEventListener&&document.addEventListener('keyup',function(e){
  if(!_kbInCore)return;
  var held=false;
  for(var k in _keyHolders){if(_keyHolders[k]['kb:'+e.code]){held=true;setSourceKey('kb:'+e.code,k,false);}}
  if(held)e.preventDefault();
},true);
window.addEventListener('blur',function(){releaseSourceKeys('kb');});

// ── CHUNK ROM LOADING ────────────────────────────────────────────────────────
var _romChunks=null,_romTotal=0,_romReceived=0;
function startRomLoad(total){_romChunks=new Array(total);_romTotal=total;_romReceived=0;}
function receiveRomChunk(index,data){
  _romChunks[index]=data;_romReceived++;
  statusEl.style.display='';statusEl.textContent='Loading… '+_romReceived+'/'+_romTotal;
  if(_romReceived===_romTotal){
    statusEl.textContent='Decoding…';
    setTimeout(function(){
      var b64=_romChunks.join('');_romChunks=null;
      var bin=atob(b64),len=bin.length;
      rom=new Uint8Array(len);
      for(var i=0;i<len;i++)rom[i]=bin.charCodeAt(i);
      rom=trimPaddedRom(rom);len=rom.length;
      var mb=(len/1048576).toFixed(2),is64=len>ROM_32MB;
      statusEl.textContent='Loaded '+mb+'MB'+(is64?' [64MB Extended]':'');
      validateRomHeader(rom);
      resetGBA();
      window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'romLoaded',size:len,sizeMB:mb,is64MB:is64}));
    },0);
  }
}

// ── PADDED-ROM TRIM ──────────────────────────────────────────────────────────
// Some ROM files are padded out to 64MB with uniform 0xFF (or 0x00) filler even
// though all real data lives in the first 32MB. Such games address the cart
// through the 0x0A/0x0B wait-state mirror and expect it to mirror the first
// 32MB — but our extended-64MB mapping (rom.length>32MB) would serve them the
// filler instead, so a graphics decompressor reading via 0x0A/0x0B gets 0xFF
// soup (seen as a flat green 0xa3a3 screen). If EVERY byte past 32MB equals
// the same 0x00/0xFF filler, trim to 32MB so standard mirror mapping applies.
// Genuine 64MB hacks have real data up top and are left untouched.
function trimPaddedRom(r){
  if(r.length<=ROM_32MB)return r;
  var fill=r[ROM_32MB];
  if(fill!==0x00&&fill!==0xFF)return r;
  for(var i=ROM_32MB;i<r.length;i++)if(r[i]!==fill)return r;
  return r.subarray(0,ROM_32MB);
}

// ── SAFE BASE64 (avoids apply stack overflow on large buffers) ───────────────
function safeB64(buf){
  var CHUNK=0x8000,s='';
  for(var i=0;i<buf.length;i+=CHUNK)
    s+=String.fromCharCode.apply(null,buf.subarray(i,Math.min(i+CHUNK,buf.length)));
  return btoa(s);
}

// ── LOCAL RESOURCE LOADING ──────────────────────────────────────────────────
// Android's WebView exposes file:// resources to XMLHttpRequest, while its
// document-targeted native message event does not bubble to window. Keep all
// file access here so ROMs, saves, and states use the same strict checks.
function resourceHasData(value){
  if(typeof value==='string')return value.length>0;
  return !!(value&&typeof value.byteLength==='number'&&value.byteLength>0);
}
function loadLocalResource(uri,responseType){
  var isFile=typeof uri==='string'&&uri.slice(0,7).toLowerCase()==='file://';
  if(isFile){
    return new Promise(function(resolve,reject){
      var xhr;
      try{
        xhr=new window.XMLHttpRequest();
        xhr.open('GET',uri,true);
        xhr.responseType=responseType;
        xhr.timeout=30000;
        xhr.onload=function(){
          var status=xhr.status||0;
          var value=responseType==='text'?
            (typeof xhr.responseText==='string'&&xhr.responseText.length>0?
              xhr.responseText:xhr.response):xhr.response;
          if(!((status>=200&&status<300)||(status===0&&resourceHasData(value))))
            return reject(new Error('resource request failed (HTTP '+status+')'));
          if(!resourceHasData(value))return reject(new Error('resource response was empty'));
          resolve(value);
        };
        xhr.onerror=function(){reject(new Error('resource request failed'));};
        xhr.ontimeout=function(){reject(new Error('resource request timed out'));};
        xhr.send();
      }catch(e){reject(e);}
    });
  }
  var controller=null,timer=null;
  try{
    if(typeof window.AbortController==='function')controller=new window.AbortController();
  }catch(e){controller=null;}
  var options=controller?{signal:controller.signal}:undefined;
  var request;
  try{request=fetch(uri,options);}catch(e){return Promise.reject(e);}
  var timeout=new Promise(function(resolve,reject){
    timer=setTimeout(function(){
      if(controller)try{controller.abort();}catch(e){}
      reject(new Error('resource request timed out'));
    },30000);
  });
  return Promise.race([request.then(function(resp){
    var status=resp.status||0;
    if(!(status>=200&&status<300))throw new Error('resource request failed (HTTP '+status+')');
    return responseType==='text'?resp.text():resp.arrayBuffer();
  }).then(function(value){
    if(!resourceHasData(value))throw new Error('resource response was empty');
    return value;
  }),timeout]).then(function(value){
    clearTimeout(timer);return value;
  },function(error){
    clearTimeout(timer);throw error;
  });
}

// ── MESSAGES ─────────────────────────────────────────────────────────────────
// RNCWebView's Android native event targets document and does not bubble;
// capture is required here, while window-targeted iOS/web messages still run
// through this same single listener without a duplicate fallback.
window.addEventListener('message',function(e){
  var data;try{data=JSON.parse(e.data);}catch{return;}
  if(data.type==='romStart'){initAudio();startRomLoad(data.total);return;}
  if(data.type==='romChunk'){receiveRomChunk(data.index,data.data);return;}
  if(data.type==='setInputMap'){
    if(data.keyboard&&typeof data.keyboard==='object')_kbMap=data.keyboard;
    if(data.gamepad&&typeof data.gamepad==='object')_padMap=data.gamepad;
    _kbInCore=!!data.keyboardInCore;
    // Bindings changed under held inputs: release so nothing stays latched.
    releaseSourceKeys('kb');releaseSourceKeys('pad');
    for(var gk in _gpState)_gpState[gk]=0;
    return;
  }
  if(data.type==='setInputEnabled'){
    _inputEnabled=!!data.enabled;
    if(!_inputEnabled){releaseSourceKeys('kb');releaseSourceKeys('pad');}
    // Re-baseline: buttons still held when re-enabled must be pressed again.
    var nowPads=navigator.getGamepads?navigator.getGamepads():[];
    _gpState={};
    for(var pi=0;pi<nowPads.length;pi++){var np=nowPads[pi];if(np&&np.connected){for(var bi=0;bi<np.buttons.length&&bi<32;bi++)_gpState['b'+bi]=_btn(np,bi);break;}}
    return;
  }
  if(data.type==='releaseAllKeys'){releaseSourceKeys(null);for(var rk in _gpState)_gpState[rk]=0;return;}
  if(data.type==='keydown'){
    setSourceKey('host',data.key,true);
    if(audioCtx&&(audioCtx.state!=='running'||(audioSilentElement&&audioSilentElement.paused)))recoverAudio();
    return;
  }
  if(data.type==='keyup'){setSourceKey('host',data.key,false);return;}
  if(data.type==='nativeAudioState'){
    audioNativeActive=!!data.active;
    audioSilentPlayback=!!data.silentPlayback;
    // Native foreground is authoritative: WKWebView can miss visibility events.
    audioPageVisible=audioNativeActive;
    if(!audioNativeActive)interruptGameplay();
    resetFramePacing();
    syncAudioPlayback();scheduleFrame();return;
  }
  if(data.type==='reset'){interruptGameplay();if(rom)resetGBA();return;}
  if(data.type==='getPerformance'){postDebug('performanceReport',performanceSnapshot(performance.now()));return;}
  if(data.type==='pauseAudio'){resetFramePacing();setAudioPaused(true);return;}
  if(data.type==='resumeAudio'){resetFramePacing();setAudioPaused(false);return;}
  if(data.type==='setAudioMuted'){setAudioMuted(!!data.muted);return;}
  if(data.type==='saveState'){
    var state={r:Array.from(r),cpsr:cpsr,scanline:scanline,scanlineCycles:scanlineCycles,
      wram:safeB64(wram),iwram:safeB64(iwram),io:safeB64(io),pal:safeB64(pal),
      vram:safeB64(vram),oam:safeB64(oam),sram:safeB64(sram),
      eeprom:safeB64(eepromData),saveType:saveType,
      armPipeline:[armFetchPC,armFetch0,armFetch1]};
    window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'saveState',state:JSON.stringify(state)}));
    return;
  }
  if(data.type==='loadState'){applyState(data.state);return;}
  if(data.type==='loadRomFile'){initAudio();loadRomFromUri(data.uri,data.saveUri);return;}
  // Inline battery-save apply (web fallback + tests). Corruption is
  // reported as a saveError message, never swallowed.
  if(data.type==='loadSave'){
    var saveErr=applyBatterySave(data.save);
    if(saveErr)postDebug('saveError',{message:saveErr,stage:'loadSave'});
    return;
  }
  // Web backup restore can intentionally contain no battery save. Clear the
  // live cart memory too, otherwise a later lifecycle flush can resurrect the
  // stale bytes that were just removed from IndexedDB.
  if(data.type==='clearSave'){
    sram.fill(0);eepromData.fill(0);batteryDirty=false;batterySaveCleared=true;
    return;
  }
  // Native path: the save file lives on disk next to the ROM.
  if(data.type==='loadSaveFile'){
    loadLocalResource(data.uri,'text').then(function(text){
      var err=applyBatterySave(text);
      if(err)postDebug('saveError',{message:err,stage:'loadSaveFile'});
    }).catch(function(e){postDebug('saveError',{message:'save file read failed: '+String(e&&e.message||e),stage:'loadSaveFile'});});
    return;
  }
  if(data.type==='flushSave'){flushBatterySave(true,data.requestId);return;}
  if(data.type==='setLinkSession'){
    linkSetSession(!!data.connected,data.playerId|0);return;
  }
  if(data.type==='linkRemoteStart'){
    linkReceiveStart(data.id|0);return;
  }
  if(data.type==='linkRemoteComplete'){
    linkReceiveComplete(data.id|0,data.words);return;
  }
  if(data.type==='linkRemoteAbort'){
    linkAbort();return;
  }
  if(data.type==='loadStateFile'){
    loadLocalResource(data.uri,'text').then(function(text){applyState(text);})
      .catch(function(e){console.error('Load state file failed:',e);});
    return;
  }
  if(data.type==='getDiag'){
    postDebug('diag',{instrCount:instrCount,swiCount:swiCount,dmaCount:dmaCount,irqCount:irqCount,
      vblankCount:vblankCount,undefInstrCount:undefInstrCount,lastIRQ:lastIRQ,lastSWI:lastSWI,
      lastCompletedFrame:lastCompletedFrame,pc:'0x'+(r[15]>>>0).toString(16),scanline:scanline,
      halted:halted,stuckReason:stuckReason,cpuErrorInfo:cpuErrorInfo,saveType:saveType,
      fbChangedEver:fbChangedEver,recentEvents:recentEvents});
    return;
  }
  if(data.type==='getBootTrace'){postDebug('bootTrace',{events:traceLog,traceActive:traceActive,undefInstrCount:undefInstrCount});return;}
  if(data.type==='readMem32'){postDebug('mem32',{addr:data.addr,value:r32(data.addr>>>0)});return;}
  // Read back one rendered framebuffer row (ARGB values) — lets PPU unit
  // tests assert real compositor output instead of reimplementing it.
  if(data.type==='readPixelRow'){
    var pr_y=data.y|0,pr_row=[];
    for(var pr_x=0;pr_x<SCREEN_W;pr_x++)pr_row.push(pixels[pr_y*SCREEN_W+pr_x]>>>0);
    postDebug('pixelRow',{y:pr_y,row:pr_row});return;
  }
  if(data.type==='writeMem8'){w8(data.addr>>>0,data.value&0xFF);return;}
  if(data.type==='setFastForward'){
    fastForward=Math.max(1,Math.min(4,data.factor|0));
    resetFramePacing();
    if(nativeHostPlatform==='android')scheduleFrame();
    return;
  }
  if(data.type==='setHostPlatform'){
    nativeHostPlatform=data.platform==='android'?'android':data.platform==='ios'?'ios':'';
    return;
  }
  if(data.type==='probePixel'){
    var ppx=data.x|0,ppy=data.y|0;
    if(ppx<0||ppx>=SCREEN_W||ppy<0||ppy>=SCREEN_H){
      window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'pixelTrace',x:ppx,y:ppy,error:'out of range'}));
      return;
    }
    gpuProbe=true;probeX=ppx;probeTrace=null;
    var ppSave=pixels.slice(ppy*SCREEN_W,(ppy+1)*SCREEN_W);
    try{
      renderLine(ppy);
    }finally{
      pixels.set(ppSave,ppy*SCREEN_W);
      probeX=-1;gpuProbe=false;
    }
    window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'pixelTrace',x:ppx,y:ppy,trace:probeTrace}));
    return;
  }
  if(data.type==='readGpu'){
    // On-device GPU state snapshot for diagnosing rendering differences vs
    // reference emulators: raw register values plus per-layer opaque pixel
    // counts on sample rows (which layer is actually painting the screen).
    var hx=function(off){return'0x'+((io[off]|(io[off+1]<<8))>>>0).toString(16);};
    var rows={};
    var sampleRows=[10,40,80,120,150];
    gpuProbe=true;
    for(var ri=0;ri<sampleRows.length;ri++){
      var ln=sampleRows[ri];
      // The probe re-renders with CURRENT register state, which under
      // per-line HBlank raster effects differs from what was on screen —
      // save and restore the framebuffer row so the probe stays invisible.
      var saveRow=pixels.slice(ln*SCREEN_W,(ln+1)*SCREEN_W);
      renderLine(ln);
      var counts={obj:0,bg1hofsAtRender:bg1hofsLatch[ln]};
      for(var b=0;b<4;b++){
        if(!lineBGEn[b])continue;
        var n=0;for(var xx=0;xx<SCREEN_W;xx++)if(lineBG[b][xx]>=0)n++;
        counts['bg'+b]=n+' pr'+lineBGPr[b];
      }
      for(var xo=0;xo<SCREEN_W;xo++)if(lineObj[xo]>=0)counts.obj++;
      // Raw fetch samples: what map entries and tile data the layers are
      // actually reading on this row, so decode bugs are visible directly.
      var bgc0=io[0x08]|(io[0x09]<<8);
      var s0=((bgc0>>8)&0x1F)*0x800,c0=((bgc0>>2)&3)*0x4000;
      var v0=(io[0x12]|(io[0x13]<<8))&0x1FF;
      var ty0=(((ln+v0)&0xFF)>>3);
      var ents=[];
      for(var e0=0;e0<6;e0++){var eo=s0+(ty0*32+e0)*2;ents.push((vram[eo]|(vram[eo+1]<<8)).toString(16));}
      counts.bg0map=ents.join(',');
      var t0=(vram[s0+ty0*64]|(vram[s0+ty0*64+1]<<8))&0x3FF;
      var tsum=0;for(var tb0=0;tb0<32;tb0++)tsum+=vram[c0+t0*32+tb0];
      counts.bg0tile0sum=tsum;
      // Raw first 16 bytes of the tile the row's first map entry references —
      // reveals whether VRAM tile data carries the same halfword-doubling
      // corruption seen in palette RAM.
      var trb=[];for(var tb1=0;tb1<16;tb1++)trb.push(vram[c0+t0*32+tb1].toString(16));
      counts.bg0refTile=trb.join(',');
      var bgc2=io[0x0C]|(io[0x0D]<<8);
      var s2=((bgc2>>8)&0x1F)*0x800;
      var m2=[];
      for(var e2=0;e2<12;e2++)m2.push(vram[s2+(ln>>3)*32+e2].toString(16));
      counts.bg2map=m2.join(',');
      pixels.set(saveRow,ln*SCREEN_W);
      rows['y'+ln]=counts;
    }
    gpuProbe=false;
    postDebug('gpuReport',{
      category:'gpu report',
      dispcnt:hx(0x00),bg0cnt:hx(0x08),bg1cnt:hx(0x0A),bg2cnt:hx(0x0C),bg3cnt:hx(0x0E),
      bg1hofs:hx(0x14),bg1vofs:hx(0x16),
      bg2pa:hx(0x20),bg2pb:hx(0x22),bg2pc:hx(0x24),bg2pd:hx(0x26),
      bg2x:'0x'+(((io[0x28]|(io[0x29]<<8)|(io[0x2A]<<16)|(io[0x2B]<<24))|0)>>>0).toString(16),
      bg2y:'0x'+(((io[0x2C]|(io[0x2D]<<8)|(io[0x2E]<<16)|(io[0x2F]<<24))|0)>>>0).toString(16),
      winin:hx(0x48),winout:hx(0x4A),win0h:hx(0x40),win0v:hx(0x44),win1h:hx(0x42),win1v:hx(0x46),
      bldcnt:hx(0x50),bldalpha:hx(0x52),bldy:hx(0x54),mosaic:hx(0x4C),
      backdrop:'0x'+(pal[0]|(pal[1]<<8)).toString(16),
      bg0hofs:hx(0x10),bg0vofs:hx(0x12),
      // BG palette row 0 + OBJ palette row 0 (first 8 entries each) — wrong
      // palette data shows up here immediately.
      palBG0:(function(){var p=[];for(var i=0;i<8;i++)p.push((pal[i*2]|(pal[i*2+1]<<8)).toString(16));return p.join(',');})(),
      palOBJ0:(function(){var p=[];for(var i=0;i<8;i++)p.push((pal[512+i*2]|(pal[512+i*2+1]<<8)).toString(16));return p.join(',');})(),
      // Provenance of the last write into palette RAM plus dumps of the
      // EWRAM staging buffers: srcHW = 8 halfwords at the transfer source
      // (gPlttBufferFaded when pokeemerald-style), srcMinus400 = 8 halfwords
      // 0x400 bytes earlier (gPlttBufferUnfaded sits directly before Faded).
      // If BOTH show doubled pairs the corruption is CPU-side (load path);
      // if only palette RAM does, the commit transfer itself is at fault.
      palTrace:(function(){
        if(!palWriteTrace)return 'none';
        var t=palWriteTrace;
        return t.via+(t.fill?' FILL':'')+' src=0x'+t.src.toString(16)+' n='+t.count+(t.w32?' 32bit':' 16bit')+' f='+t.frame+' | srcHW='+t.srcHW+' | srcMinus400='+t.srcMinus400;
      })(),
      // Byte sums per 16KB VRAM charblock — distinguishes "never loaded"
      // (sum 0) from "loaded but decoded wrong".
      // Last CPU/HLE stores into the watched faded-buffer window, each with
      // pc, value, size, ARM/THUMB state and 32 code bytes around pc
      // (pc-16..pc+15) for offline disassembly of the writing routine.
      palWrites:(function(){
        if(!palWatchHits.length)return 'none';
        return palWatchHits.map(function(h){return h.a+'<='+h.v+'('+h.sz+(h.thumb?'T':'A')+') pc='+h.pc+' ins='+h.ins+' r0-10,12='+h.regs+' f='+h.f+' ['+h.code+']';}).join(' ; ');
      })(),
      vramSums:[0,1,2,3,4,5].map(function(b){var s=0;for(var i=b*0x4000;i<(b+1)*0x4000;i++)s=(s+vram[i])&0xFFFFFF;return s.toString(16);}).join(','),
      // First 12 OAM entries (attr0,attr1,attr2) — reveals the text-banner
      // sprites' size/mode/tile so their fetch path can be replayed locally.
      oam:(function(){var o=[];for(var i=0;i<12;i++){o.push([(oam[i*8]|(oam[i*8+1]<<8)).toString(16),(oam[i*8+2]|(oam[i*8+3]<<8)).toString(16),(oam[i*8+4]|(oam[i*8+5]<<8)).toString(16)].join('/'));}return o.join(' ');})(),
      // Probe what the memory bus ACTUALLY returns at any cart-space
      // addresses sitting in the registers of the most recent watched
      // palette-buffer write. This answers "is that repeated garbage value
      // really what we serve from the (possibly upper-bank) ROM address the
      // game was reading?" without needing the ROM file offline. Each entry:
      // 'addr@mappedOff=16 bytes via r8'.
      cartProbe:(function(){
        if(!palWatchHits.length||!rom)return 'none';
        var h=palWatchHits[palWatchHits.length-1],out=[],seen={};
        var vals=String(h.regs).split('/');
        for(var vi=0;vi<vals.length&&out.length<6;vi++){
          var av=parseInt(vals[vi],16)>>>0,rg=av>>>24;
          if(rg<0x08||rg>0x0D)continue;
          var base=(av&~1)>>>0;if(seen[base])continue;seen[base]=1;
          var hxs='';for(var pb=0;pb<16;pb++)hxs+=('0'+r8(base+pb).toString(16)).slice(-2);
          out.push(vals[vi]+'@'+romMappedOff(base).toString(16)+'='+hxs);
        }
        return out.length?out.join(' ; '):'none';
      })(),
      build:BUILD_TAG,romLen:rom?'0x'+rom.length.toString(16):null,
      rows:rows,frame:emuFrameCount
    });
    return;
  }
  // Audio pipeline introspection for tests: current DS samples, FIFO fill,
  // fixed-rate sampler output, and direct playback queue/rate.
  if(data.type==='readAudio'){
    var az=0,ai0=audioWrite>AUDIO_RING?AUDIO_RING:audioWrite;
    for(var azi=0;azi<ai0;azi++)if(audioRingL[azi]!==0)az++;
    postDebug('audioState',{dsA:dsA,dsB:dsB,fifoALen:fifoALen,fifoBLen:fifoBLen,audioWrite:audioWrite,
      fifoAHead:fifoAHead,fifoAData:Array.from(fifoA),
      psgActive:psgActiveBits(),psgL:psgLastL,psgR:psgLastR,
      sqEnv:[sqEnv[0],sqEnv[1]],wavSample:wavSample,ringNonZeroL:az,
      audioSpeed:fastForward,audioTargetSpeed:fastForward,
      audioQueuedInput:Math.max(0,audioWrite-audioRead),audioQueuedOutput:0,
      audioMuted:audioMuted||audioPaused});
    return;
  }
},true);
// iOS fallback: if the AudioContext started suspended despite the WebView's
// autoplay allowance, any in-WebView touch unblocks it.
document.addEventListener&&document.addEventListener('touchstart',function(){
  if(audioCtx&&audioCtx.state!=='running')recoverAudio();
},true);

// Last-ditch flush when the WebView is being torn down or backgrounded —
// a force-quit right after an in-game save must not lose the last write.
window.addEventListener('pagehide',function(){
  resetFramePacing();
  flushBatterySave(false);
  audioPageVisible=false;syncAudioPlayback();
});
window.addEventListener('pageshow',function(){
  resetFramePacing();
  audioPageVisible=true;syncAudioPlayback();
});
document.addEventListener&&document.addEventListener('visibilitychange',function(){
  resetFramePacing();
  if(document.visibilityState==='hidden'){
    flushBatterySave(false);
    audioPageVisible=false;
    interruptGameplay();
  }else audioPageVisible=true;
  syncAudioPlayback();
  scheduleFrame();
});

function applyState(stateJson){
  try{
    armFetchPC=-1;
    var s=JSON.parse(stateJson);
    if(Array.isArray(s.armPipeline)&&s.armPipeline.length===3&&
       s.armPipeline.every(function(v){return Number.isInteger(v);})){
      armFetchPC=s.armPipeline[0];armFetch0=s.armPipeline[1];armFetch1=s.armPipeline[2];
    }
    for(var i=0;i<16;i++)r[i]=s.r[i];
    cpsr=s.cpsr;scanline=s.scanline;scanlineCycles=s.scanlineCycles;
    function dec(b){return Uint8Array.from(atob(b),function(c){return c.charCodeAt(0);});}
    wram.set(dec(s.wram));iwram.set(dec(s.iwram));io.set(dec(s.io));
    pal.set(dec(s.pal));vram.set(dec(s.vram));oam.set(dec(s.oam));sram.set(dec(s.sram));
    if(s.eeprom)eepromData.set(dec(s.eeprom));
    if(s.saveType)saveType=s.saveType;
    resetFramePacing();
  }catch(e){console.error('Load state failed:',e);}
}

// Load the ROM directly from a local file:// URI — this never puts the ROM
// bytes on the React Native bridge at all. The bridge (used for the chunked
// romStart/romChunk messages below, kept only as a web fallback) has a hard
// size ceiling: pushing tens of MB through a native WebView command has caused
// real native crashes.
function loadRomFromUri(uri,saveUri){
  statusEl.style.display='';statusEl.textContent='Loading ROM…';
  // Read both files before changing the running core. In particular, never
  // reset a new ROM until its requested save has been read and validated.
  loadLocalResource(uri,'arraybuffer').then(function(buf){
    var nextRom=trimPaddedRom(new Uint8Array(buf));
    if(!nextRom.length)throw new Error('ROM response was empty');
    var commitStarted=false;
    var oldRom,oldSaveType,oldSram,oldEeprom,oldBatteryDirty,oldSaveCleared;
    var oldRunning,oldHadFrame;
    var saveRequest=saveUri?loadLocalResource(saveUri,'text'):Promise.resolve(null);
    return saveRequest.then(function(saveText){
      // Snapshot immediately before the commit. The save read above may take
      // time while the current session continues writing newer progress; a
      // snapshot made before that read could roll those writes back on error.
      oldRom=rom;oldSaveType=saveType;
      oldSram=new Uint8Array(sram);oldEeprom=new Uint8Array(eepromData);
      oldBatteryDirty=batteryDirty;oldSaveCleared=batterySaveCleared;
      oldRunning=running;oldHadFrame=!!frameTimer;
      commitStarted=true;
      // Stop the old session only once every requested resource is available.
      if(frameTimer){cancelAnimationFrame(frameTimer);frameTimer=null;}
      running=false;
      resetFramePacing();
      rom=nextRom;
      detectSaveType();
      if(saveText!==null){
        var saveErr=applyBatterySave(saveText);
        if(saveErr){
          var saveFailure=new Error(saveErr);
          saveFailure.saveFailure=true;
          throw saveFailure;
        }
      }
      var mb=(rom.length/1048576).toFixed(2),is64=rom.length>ROM_32MB;
      validateRomHeader(rom);
      statusEl.textContent='Loaded '+mb+'MB'+(is64?' [64MB Extended]':'');
      resetGBA();
      window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'romLoaded',size:rom.length,sizeMB:mb,is64MB:is64}));
    },function(e){
      if(!e||typeof e!=='object')e=new Error(String(e));
      e.saveFailure=true;throw e;
    }).catch(function(e){
      // A failed save must not leave a partially applied cart or a candidate
      // ROM running. Restore the previous memory and report both layers.
      if(commitStarted){
        rom=oldRom;saveType=oldSaveType;sram.set(oldSram);eepromData.set(oldEeprom);
        batteryDirty=oldBatteryDirty;batterySaveCleared=oldSaveCleared;
        if(rom)detectSaveType();
        running=oldRunning;
        resetFramePacing();
        if(oldRunning&&oldHadFrame)scheduleFrame();
        else frameTimer=null;
      }
      if(e&&e.saveFailure){
        postDebug('saveError',{message:String(e.message||e),stage:'romBoot'});
        throw e;
      }
      throw e;
    });
  }).catch(function(e){
    var message=String(e&&e.message||e);
    statusEl.textContent='ROM load failed: '+message;
    if(e&&e.saveFailure)postDebug('romError',{message:'ROM load aborted: '+message});
    else window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'romError',message:message}));
  });
}

// ── GAMEPAD API (MFi / Bluetooth controllers) ────────────────────────────────
// Works on iOS 14.5+ via WKWebView's Gamepad API support.
// Maps standard gamepad layout → GBA buttons.
var _gpState={};
var _gpPolling=false;

function _btn(gp,idx){return gp.buttons[idx]&&gp.buttons[idx].pressed?1:0;}

function _pollGamepad(){
  var gamepads=navigator.getGamepads?navigator.getGamepads():[];
  var gp=null;
  for(var i=0;i<gamepads.length;i++){if(gamepads[i]&&gamepads[i].connected){gp=gamepads[i];break;}}
  if(gp){
    // Saved bindings over the W3C standard layout; left stick also drives the D-pad.
    var now={};
    for(var b=0;b<gp.buttons.length&&b<32;b++)now['b'+b]=_btn(gp,b);
    var ax0=gp.axes[0]||0,ax1=gp.axes[1]||0;
    now.sl=ax0<-0.5?1:0;now.sr=ax0>0.5?1:0;now.su=ax1<-0.5?1:0;now.sd=ax1>0.5?1:0;
    for(var id in now){
      if(!_inputEnabled){_gpState[id]=now[id];continue;}
      if(now[id]===(_gpState[id]|0))continue;
      _gpState[id]=now[id];
      var action=id.charAt(0)==='b'?_padMap[id.slice(1)]:({sl:'left',sr:'right',su:'up',sd:'down'})[id];
      if(!action)continue;
      if(action==='speed'){if(now[id])_requestSpeedCycle();continue;}
      setSourceKey('pad:'+id,action,now[id]===1);
    }
  }
  if(_gpPolling)requestAnimationFrame(_pollGamepad);
}

window.addEventListener('gamepadconnected',function(e){
  statusEl.textContent='Controller: '+e.gamepad.id.slice(0,36);
  if(!_gpPolling){_gpPolling=true;_pollGamepad();}
});
window.addEventListener('gamepaddisconnected',function(){
  var any=false,list=navigator.getGamepads?navigator.getGamepads():[];
  for(var i=0;i<list.length;i++)if(list[i]&&list[i].connected)any=true;
  if(!any)_gpPolling=false;
  statusEl.textContent='Controller disconnected';
  // Release every controller-held key so nothing stays latched.
  releaseSourceKeys('pad');_gpState={};
});

// Signal readiness to the native host
statusEl.textContent='GBA Emulator ready — load a ROM';
window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}));
})();
</script>
</body>
</html>`;
