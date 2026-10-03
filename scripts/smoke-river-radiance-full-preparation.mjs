import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareFullView,validateFullPreparation } from './river-radiance-full-preparation.mjs';
const readiness=()=>null;
function fakePage(size,mutate){
 let frameNo=1;
 const volume=()=>{
  const row=Math.min(137+2*Math.max(0,frameNo-5),137+2*Math.ceil((size[1]-137)/2));
  const final=5+Math.ceil((size[1]-137)/2);
  const v={fullSize:size,enabled:true,opacity:1,refineRow:frameNo<4?0:frameNo===4?125:row,mix:frameNo>final?1:0,
   historyReady:frameNo>final,historySaved:frameNo>final,historyUsed:frameNo>final+1,dirty:false,observedAtMs:frameNo*100,
   invalidations:2,mapRevision:1,model:{time:123,frameSimSec:0,magLimit:9,lastKey:[1,2]},
   counters:{draftPasses:3,refinePasses:Math.max(0,Math.min(frameNo,final)-3),historySaves:frameNo>final?1:0,dirtyReasons:{targets:2}}};
  mutate?.(v,frameNo);return v;
 };
 return {async evaluate(fn){
  const text=fn.toString();
  if(fn===readiness)return {ready:frameNo>=121,catalogPrefix:{updates:Math.min(frameNo-1,120),remaining:Math.max(0,121-frameNo)}};
  if(text.includes('requestAnimationFrame')){
   frameNo++;return {frameNo,cpuMs:1,frameAndFinishMs:1,finishMs:0,readbackMs:0,gpuSynchronized:false,
    gpu:{contextLost:false,losses:0,restores:0,error:0,defaultFramebuffer:true},river:{enabled:true,visible:true,count:size[0]===430?9216:15376},quality:{dpr:1}};
  }
  if(text.includes('pairedVolumeProgress'))return structuredClone(volume());
  if(text.includes('gl.finish'))return {before:frameNo,after:frameNo,durationMs:1,pixel:[0,0,0,0],contextLost:false,error:0,defaultFramebuffer:true};
  if(text.includes('__pairedTier1Updates'))return {updates:120,remaining:0};
  throw Error('Unknown fake-page hook: '+text);
 }};
}
async function run(size,mutate){
 const record={prefix:{A:[],B:[]},assets:{A:[],B:[],readiness:[]},nativeWarmup:{A:[],B:[]},refinement:{A:[],B:[]},fences:[],complete:false};
 let lastSave,error;
 try{await prepareFullView({pages:{A:fakePage(size,mutate),B:fakePage(size)},record,viewport:{width:size[0],height:size[1]},
  budget:{run:async operation=>operation()},save:()=>{lastSave=structuredClone(record);},activate:async()=>{},readiness});}
 catch(e){error=e;}
 return{record,saves:[lastSave],error};
}
for(const size of[[1200,800],[430,932]]){
 const {record,error}=await run(size);assert.equal(error,undefined);validateFullPreparation(record,size);
 assert.equal(record.refinement.after.A.historyUsed,true);assert.equal(record.refinement.after.A.fullSize[0],size[0]);
 for(const mutate of[
  r=>r.prefix.A.pop(),r=>r.nativeWarmup.B.pop(),r=>r.assets.elapsedMs=300000,r=>r.refinement.after.A.historyUsed=false,
  r=>r.refinement.A[0].volumeProgress.counters.dirtyReasons.contextReset=1,r=>r.refinement.A[0].frameNo++,
  r=>r.fences[0].after++,r=>r.refinement.maxAdditionalFrames++,r=>r.refinement.before.A.model.time++,
 ]){const broken=structuredClone(record);mutate(broken);assert.throws(()=>validateFullPreparation(broken,size));}
}
for(const mutate of[(v,n)=>{if(n===242)v.refineRow=609;},(v,n)=>{if(n>=242)v.counters.dirtyReasons.contextReset=1;},(v,n)=>{if(n>=338)v.historyUsed=false;}]){
 const result=await run([1200,800],mutate);assert(result.error);assert(result.record.refinement.A.length>0);
 assert(result.saves.at(-1).refinement.A.length>0,'Failed delivered native frames are durable before progress validation');
}
// Replay the actual accepted desktop proof when local evidence is available.
try{
 const proof=JSON.parse(readFileSync('evidence/run-37140303408/report.json'));
 const record={complete:proof.preparationComplete,prefix:proof.prefix,assets:{...proof.settlement,elapsedMs:proof.settlementMs},nativeWarmup:proof.warmup,
  refinement:proof.refinement,fences:proof.fences.map(f=>({...f,stage:f.stage==='warm'?'native-warm':f.stage}))};
 validateFullPreparation(record,[1200,800]);console.log('Accepted 998184eb browser proof replays through full preparation validator');
}catch(error){if(error.code!=='ENOENT')throw error;}
console.log('Full preparation desktop/mobile loops preserve exact prefixes, native progression, used history, fences and failed-frame evidence');
