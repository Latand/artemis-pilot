import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { radianceDeviceTargets,validateVolumeProgress } from './river-radiance-volume-progress.mjs';
import { prepareFullView,validateFullPreparation } from './river-radiance-full-preparation.mjs';
import { nativeFieldSnapshot } from './river-radiance-native-settlement.mjs';
import { syntheticNativeFieldSnapshot } from './smoke-river-radiance-native-settlement.mjs';
const failed=JSON.parse(readFileSync(new URL('./fixtures/radiance-mobile-target-4f79de1c.json',import.meta.url)));
assert.equal(failed.runId,37145710093);assert.equal(failed.artifactId,11282255109);
assert.deepEqual(failed.viewport,{width:430,height:932});assert.equal(failed.sample.quality.dpr,1);
assert.equal(failed.sample.river.count,9216);assert.match(failed.failure,/215/);
validateVolumeProgress(failed.sample.volumeProgress,radianceDeviceTargets(true).volume);
assert.throws(()=>validateVolumeProgress(failed.sample.volumeProgress,[430,932]),'Retain the exact old failure as a negative control');
for(const revision of['09863eedda25eef36d79e9cf88daa4ff3e377875','2c9b5bcf2f542728d76cf1350007297db2678f34']){
 const source=execFileSync('git',['show',`${revision}:src/render/galaxyVolume.js`],{encoding:'utf8'});
 const body=source.slice(source.indexOf('function ensureTargets(renderer) {'),source.indexOf('\nconst _size =',source.indexOf('function ensureTargets(renderer) {')));
 assert(body.startsWith('function ensureTargets(renderer) {'));
 for(const mobile of[false,true]){
  const expected=radianceDeviceTargets(mobile),sandbox={renderQuality:{mobile},RES_FORCED:0,_size:{},state:{scale:.25,invalidations:0},meter:{},
   targetSizeChanged:()=>true,sizeTarget:(_rt,width,height)=>({width,height}),
   renderer:{getDrawingBufferSize:()=>({x:expected.canvas[0],y:expected.canvas[1]}),capabilities:{maxTextureSize:4096}}};
  vm.runInNewContext(body+';ensureTargets(renderer);',sandbox);
  assert.deepEqual([sandbox.state.rtFull.width,sandbox.state.rtFull.height],expected.volume,'QA target must match execution of the exact production target policy');
 }
}
const readiness=()=>null;
function fakePage(size,mutate,nativePending=false){
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
  if(fn===nativeFieldSnapshot)return nativePending?syntheticNativeFieldSnapshot({frameNo,builtCount:Math.min(89,frameNo-90),idleUpdates:Math.max(0,frameNo-179),staging:frameNo<179,mLim:frameNo<179?9:7.25,stars:frameNo<179?250001:38715}):syntheticNativeFieldSnapshot({frameNo,idleUpdates:Math.max(3,frameNo-118)});
  if(fn===readiness)return {ready:frameNo>=(nativePending?182:121),assetReady:frameNo>=121,catalogPrefix:{updates:Math.min(frameNo-1,120),remaining:Math.max(0,121-frameNo)}};
  if(text.includes('requestAnimationFrame')){
   frameNo++;return {frameNo,cpuMs:1,frameAndFinishMs:1,finishMs:0,readbackMs:0,gpuSynchronized:false,
    gpu:{contextLost:false,losses:0,restores:0,error:0,defaultFramebuffer:true},river:{enabled:true,visible:true,count:size[0]===215?9216:15376},quality:{dpr:1}};
  }
  if(text.includes('pairedVolumeProgress'))return structuredClone(volume());
  if(text.includes('gl.finish'))return {before:frameNo,after:frameNo,durationMs:1,pixel:[0,0,0,0],contextLost:false,error:0,defaultFramebuffer:true};
  if(text.includes('__pairedTier1Updates'))return {updates:120,remaining:0};
  throw Error('Unknown fake-page hook: '+text);
 }};
}
async function run(canvas,mutate,nativePending=false){
 const mobile=canvas[0]===430,size=radianceDeviceTargets(mobile).volume;
 const record={prefix:{A:[],B:[]},assets:{A:[],B:[],readiness:[]},nativeField:{A:[],B:[],complete:false},nativeWarmup:{A:[],B:[]},refinement:{A:[],B:[]},fences:[],complete:false};
 let lastSave,error;
 try{await prepareFullView({pages:{A:fakePage(size,mutate,nativePending),B:fakePage(size,undefined,nativePending)},record,viewport:{width:canvas[0],height:canvas[1]},mobile,
  budget:{run:async operation=>operation()},save:()=>{lastSave=structuredClone(record);},activate:async()=>{},readiness});}
 catch(e){error=e;}
 return{record,saves:[lastSave],error};
}
for(const canvas of[[1200,800],[430,932]]){
 const size=radianceDeviceTargets(canvas[0]===430).volume;
 const {record,error}=await run(canvas);assert.equal(error,undefined);validateFullPreparation(record,size);
 assert.equal(record.refinement.after.A.historyUsed,true);assert.equal(record.refinement.after.A.fullSize[0],size[0]);
 for(const mutate of[
  r=>r.prefix.A.pop(),r=>r.nativeWarmup.B.pop(),r=>r.assets.elapsedMs=300000,r=>r.refinement.after.A.historyUsed=false,
  r=>(r.refinement.A[0]?.volumeProgress??r.refinement.after.A).counters.dirtyReasons.contextReset=1,r=>(r.refinement.A[0]??r.nativeWarmup.A[0]).frameNo++,
  r=>r.fences[0].after++,r=>r.refinement.maxAdditionalFrames++,r=>r.refinement.before.A.model.time++,
  r=>r.prefix.A[0].volumeProgress.fullSize=[size[0]+1,size[1]],r=>r.prefix.A[0].volumeProgress.fullSize=[size[0],size[1]-1],
 ]){const broken=structuredClone(record);mutate(broken);assert.throws(()=>validateFullPreparation(broken,size));}
}
for(const mutate of[(v,n)=>{if(n===242)v.refineRow=609;},(v,n)=>{if(n>=242)v.counters.dirtyReasons.contextReset=1;},(v,n)=>{if(n>=338)v.historyUsed=false;}]){
 const result=await run([1200,800],mutate);assert(result.error);assert(result.record.refinement.A.length>0);
 assert(result.saves.at(-1).refinement.A.length>0,'Failed delivered native frames are durable before progress validation');
}
const native=await run([430,932],undefined,true);assert.equal(native.error,undefined);
assert.equal(native.record.assets.A.length,0);assert.equal(native.record.nativeField.A.length,61);
assert.equal(native.record.nativeField.after.A.frameNo,182);
// Replay the actual accepted desktop proof when local evidence is available.
try{
 const proof=JSON.parse(readFileSync('evidence/run-37140303408/report.json'));
 const record={complete:proof.preparationComplete,prefix:proof.prefix,assets:{...proof.settlement,elapsedMs:proof.settlementMs},nativeWarmup:proof.warmup,
  refinement:proof.refinement,fences:proof.fences.map(f=>({...f,stage:f.stage==='warm'?'native-warm':f.stage}))};
 validateFullPreparation(record,[1200,800],{legacy:true});console.log('Accepted 998184eb browser proof replays through full preparation validator');
}catch(error){if(error.code!=='ENOENT')throw error;}
console.log('Full preparation desktop/mobile loops preserve exact prefixes, native progression, used history, fences and failed-frame evidence');
