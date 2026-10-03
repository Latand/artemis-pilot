import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { volumeProgressTransform,volumeRefinementReady,validateRefinementAdvance } from './river-radiance-volume-progress.mjs';
import { protocol } from './river-radiance-paired-protocol.mjs';
const partial={fullSize:[1200,800],enabled:true,opacity:1,refineRow:609,mix:0,historyReady:false,historySaved:false,historyUsed:false,dirty:false,
  observedAtMs:1000,invalidations:2,mapRevision:1,model:{time:123,frameSimSec:0,magLimit:9,lastKey:[1,2,3]},
  counters:{draftPasses:2,refinePasses:238,historySaves:0,dirtyReasons:{targets:2}}};
const next=structuredClone(partial);next.refineRow+=2;next.counters.refinePasses++;next.observedAtMs=2000;
assert.equal(validateRefinementAdvance(partial,next,1000),2000);assert.equal(volumeRefinementReady(partial),false);
const ready=structuredClone(next);Object.assign(ready,{refineRow:800,mix:1,historyReady:true,historySaved:true,historyUsed:true});ready.counters.historySaves=1;
assert(volumeRefinementReady(ready));
for(const mutate of[x=>x.refineRow=799,x=>x.mix=.99,x=>x.historyReady=false,x=>x.historySaved=false,x=>x.historyUsed=false,x=>x.dirty=true,x=>x.counters.historySaves=0]){
  const bad=structuredClone(ready);mutate(bad);assert(!volumeRefinementReady(bad));
}
for(const mutate of[x=>x.refineRow=609,x=>x.refineRow=608,x=>x.counters.refinePasses--,x=>x.counters.draftPasses++,
  x=>x.counters.dirtyReasons.viewOrModelKey=1,x=>x.invalidations++,x=>x.mapRevision++,x=>x.model.time++,x=>x.model.frameSimSec=1,
  x=>x.fullSize=[600,400],x=>x.dirty=true,x=>x.observedAtMs=500]){
  const bad=structuredClone(next);mutate(bad);assert.throws(()=>validateRefinementAdvance(partial,bad,1000));
}
const blending=structuredClone(ready);Object.assign(blending,{mix:.5,historyReady:false,historySaved:false,historyUsed:false});
const stalled=structuredClone(blending);stalled.observedAtMs=7000;
assert.throws(()=>validateRefinementAdvance(blending,stalled,2000));
const blendAdvance=structuredClone(stalled);blendAdvance.mix=.6;
assert.equal(validateRefinementAdvance(blending,blendAdvance,2000),7000);
const heldReady=structuredClone(ready);heldReady.observedAtMs=20000;
assert.equal(validateRefinementAdvance(ready,heldReady,2000),20000,'Completed side may wait while the paired side finishes');
const justSaved=structuredClone(ready);justSaved.historyUsed=false;
assert(!volumeRefinementReady(justSaved),'The history-save frame cannot end refinement before history is actually used');
assert.equal(validateRefinementAdvance(justSaved,heldReady,2000),20000,'The first history-use frame counts as progress even after a slow native frame');
const savedButUnused=structuredClone(justSaved);savedButUnused.observedAtMs=7000;
assert.throws(()=>validateRefinementAdvance(justSaved,savedButUnused,2000),'Saved history that is never used must still fail the stall guard');

// Execute the actual checkpoint/cost-loop source with deterministic frame data.
// This catches reordered persistence and aliases, not just helper behavior.
const probe=readFileSync('scripts/probe-river-radiance-preparation.mjs','utf8');
const start='  report.refinement.after=',end='  report.after={A:await snapshot';
assert.equal(probe.split(start).length,2);assert.equal(probe.split(end).length,2);
const costSection=probe.slice(probe.indexOf(start),probe.indexOf(end));
const runCostSection=new (Object.getPrototypeOf(async function(){}).constructor)(
  'report','previous','lastProgressAt','pages','fence','snapshot','assertHealthyState','assertMatchedState','save','deliver','volumeProgress',
  'assert','volumeRefinementReady','validateRefinementAdvance',costSection);
async function costCase(mutate){
  const initial={A:structuredClone(ready),B:structuredClone(ready)},previous={...initial};
  const expected=structuredClone(initial),report={refinement:{},cost:{A:[],B:[]},limits:{costFramesPerRevision:2}},persisted=[];
  const frames={A:0,B:0},samples={};
  const save=async()=>persisted.push(structuredClone(report));
  let failure;
  try{
    await runCostSection(report,previous,{A:2000,B:2000},{A:'A',B:'B'},async()=>{},async()=>({}),()=>{},()=>{},save,
      async(label,synchronized)=>{assert.equal(synchronized,true);return {frameNo:++frames[label]};},
      async label=>{const value=structuredClone(ready);value.observedAtMs+=frames[label]*1000;
        if(label==='A'&&frames[label]===1)mutate?.(value);samples[label]=value;return value;},
      assert,volumeRefinementReady,validateRefinementAdvance);
  }catch(error){failure=error;}
  assert.deepEqual(report.refinement.after,expected,'Refinement checkpoint must remain unchanged as cost-loop state advances');
  assert.notEqual(report.refinement.after,previous);
  initial.A.counters.historySaves++;
  assert.deepEqual(report.refinement.after,expected,'Refinement checkpoint must be a deep copy of nested progress state');
  return {report,persisted,samples,failure};
}
const completed=await costCase();assert.equal(completed.failure,undefined);
assert.deepEqual(Object.fromEntries(Object.entries(completed.report.cost).map(([key,rows])=>[key,rows.length])),{A:2,B:2});
for(const mutate of[x=>x.historyUsed=false,x=>x.counters.dirtyReasons.contextReset=1]){
  const failed=await costCase(mutate);assert(failed.failure,'Broken readiness or progress must fail the actual cost loop');
  assert.equal(failed.report.cost.A.length,1);assert.equal(failed.report.cost.B.length,0);
  assert.deepEqual(failed.persisted.at(-1).cost.A[0].volumeProgress,failed.samples.A,
    'The exact failing sample must be persisted before readiness/progress rejects it');
}
for(const source of[execFileSync('git',['show',`${protocol.baseline}:src/render/galaxyVolume.js`],{encoding:'utf8'}),readFileSync('src/render/galaxyVolume.js','utf8')]){
  const result=volumeProgressTransform(source,'/src/render/galaxyVolume.js');
  execFileSync(process.execPath,['--input-type=module','--check'],{input:result});
  let stripped=result.split('\nconst pairedVolumeCounters=')[0];
  for(const reason of['maps','mapBlend','targets'])stripped=stripped.replace(`pairedVolumeDirty('${reason}'); `,'');
  for(const reason of['fineBand','viewOrModelKey','magnitudeLimit','enabled','contextReset'])stripped=stripped.replace(` pairedVolumeDirty('${reason}');`,'');
  stripped=stripped.replace('pairedVolumeCounters.draftPasses++; ','').replace(' pairedVolumeCounters.refinePasses++;','').replace(' pairedVolumeCounters.historySaves++;','');
  assert.equal(stripped,source,'Removing observational counters restores every original production byte');
  assert.throws(()=>volumeProgressTransform(source.replace('state.refineRow += n;','state.refineRow += 1;'),'/src/render/galaxyVolume.js'));
}
console.log('Volume proof requires used history, preserves independent checkpoints and failed samples, rejects stalled/reset rows; instrumentation strips to exact production source');
