import assert from 'node:assert/strict';
import { validatePreparationFrame,validatePrefix,validateFence,settlementReadyWithinDeadline } from './river-radiance-preparation-qa.mjs';
import { validateVolumeProgress,volumeRefinementReady,validateRefinementAdvance } from './river-radiance-volume-progress.mjs';

export async function prepareFullView({pages,record,viewport,budget,save,activate,readiness}){
  const size=[viewport.width,viewport.height];
  async function progress(label){return pages[label].evaluate(()=>pairedQA.volume.pairedVolumeProgress());}
  async function pair(target,deadline=Infinity){
    for(const label of['A','B'])await budget.run(async()=>{
      await activate(pages[label]);const start=performance.now();
      const sample=await pages[label].evaluate(()=>new Promise((resolve,reject)=>requestAnimationFrame(()=>{
        try{resolve(__pairedFrame(false));}catch(error){reject(error);}
      })));
      sample.roundTripMs=performance.now()-start;sample.protocolAndSchedulingMs=Math.max(0,sample.roundTripMs-sample.frameAndFinishMs);
      target[label].push(sample);save();validatePreparationFrame(sample);
      sample.volumeProgress=await progress(label);save();validateVolumeProgress(sample.volumeProgress,size);
    },`native preparation frame ${label}`,deadline);
  }
  async function fence(label,stage){
    await budget.run(async()=>{
      await activate(pages[label]);
      const value=await pages[label].evaluate(()=>{
        const gl=pairedQA.scene.renderer.getContext(),pixel=new Uint8Array(4),before=__pairedWorkload().frameNo,start=performance.now();
        gl.finish();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        return{before,after:__pairedWorkload().frameNo,durationMs:performance.now()-start,pixel:Array.from(pixel),
          contextLost:gl.isContextLost(),error:gl.getError(),defaultFramebuffer:gl.getParameter(gl.FRAMEBUFFER_BINDING)===null};
      });record.fences.push({label,stage,...value});save();validateFence(value);
    },`${stage} GPU fence ${label}`);
  }
  const readBoth=async()=>({A:await pages.A.evaluate(readiness),B:await pages.B.evaluate(readiness)});
  for(let i=0;i<120;i++){
    await pair(record.prefix);
    const status=await budget.run(readBoth,'catalog prefix readiness');
    for(const label of['A','B']){record.prefix[label].at(-1).readiness=status[label];validatePrefix(status[label].catalogPrefix,i+1);}save();
  }
  const assetStart=performance.now(),assetDeadline=assetStart+300000;
  while(true){
    const ready=await budget.run(readBoth,'post-prefix asset readiness',assetDeadline);
    record.assets.readiness.push(ready);record.assets.elapsedMs=performance.now()-assetStart;save();
    for(const label of['A','B'])validatePrefix(ready[label].catalogPrefix,120);
    if(settlementReadyWithinDeadline(ready,record.assets.elapsedMs,300000))break;
    // The same independent asset deadline also bounds frames, not just polling.
    await pair(record.assets,assetDeadline);
  }
  for(const label of['A','B'])await fence(label,'settled');
  // Preserve the proven native preparation history. These are not the separate
  // 120 synchronous acceptance warmup frames that follow completed preparation.
  for(let i=0;i<120;i++)await pair(record.nativeWarmup);
  for(const label of['A','B'])await fence(label,'native-warm');
  record.refinement.before=await budget.run(async()=>({A:await progress('A'),B:await progress('B')}),'refinement checkpoint');save();
  const previous={...record.refinement.before},last=Object.fromEntries(['A','B'].map(label=>[label,previous[label].observedAtMs]));
  record.refinement.maxAdditionalFrames=Math.ceil(size[1]/2)+60;
  while(!['A','B'].every(label=>volumeRefinementReady(previous[label],size))){
    assert(record.refinement.A.length<record.refinement.maxAdditionalFrames,'Native full-row refinement frame allowance exhausted');
    await pair(record.refinement);
    for(const label of['A','B']){
      const next=record.refinement[label].at(-1).volumeProgress;
      last[label]=validateRefinementAdvance(previous[label],next,last[label],size);previous[label]=next;
      const prefix=await budget.run(()=>pages[label].evaluate(()=>({updates:__pairedTier1Updates,remaining:__pairedTier1Remaining})),`held prefix ${label}`);
      validatePrefix(prefix,120);
    }
  }
  record.refinement.after=structuredClone(previous);save();
  for(const label of['A','B'])await fence(label,'refined');
  record.complete=true;save();validateFullPreparation(record,size);
  return previous;
}

export function validateFullPreparation(record,size){
  assert(record.complete);assert.equal(record.refinement.maxAdditionalFrames,Math.ceil(size[1]/2)+60);
  assert(record.refinement.A.length<=record.refinement.maxAdditionalFrames);
  const stages=['prefix','assets','nativeWarmup','refinement'];
  for(const label of['A','B']){
    assert.equal(record.prefix[label].length,120);assert.equal(record.nativeWarmup[label].length,120);
    const all=stages.flatMap(stage=>record[stage][label]);
    assert.equal(all[0].frameNo,2);
    for(let i=0;i<all.length;i++){validatePreparationFrame(all[i]);validateVolumeProgress(all[i].volumeProgress,size);assert.equal(all[i].frameNo,i+2);}
    for(const[i,frame]of record.prefix[label].entries())validatePrefix(frame.readiness.catalogPrefix,i+1);
    let previous=record.refinement.before[label],last=previous.observedAtMs;
    const withoutTime=({observedAtMs,...state})=>state;
    assert.deepEqual(withoutTime(previous),withoutTime(record.nativeWarmup[label].at(-1).volumeProgress),'Checkpoint must identify the last native-warm frame state');
    for(const frame of record.refinement[label]){last=validateRefinementAdvance(previous,frame.volumeProgress,last,size);previous=frame.volumeProgress;}
    assert.deepEqual(record.refinement.after[label],previous);assert(volumeRefinementReady(previous,size));
  }
  for(const stage of stages){
    assert.equal(record[stage].A.length,record[stage].B.length);
    for(let i=0;i<record[stage].A.length;i++){
      const a=record[stage].A[i],b=record[stage].B[i];assert.equal(a.frameNo,b.frameNo);assert.deepEqual(a.river,b.river);assert.deepEqual(a.quality,b.quality);
    }
  }
  assert(record.assets.readiness.length>0);
  assert(settlementReadyWithinDeadline(record.assets.readiness.at(-1),record.assets.elapsedMs,300000));
  for(const ready of record.assets.readiness)for(const label of['A','B'])validatePrefix(ready[label].catalogPrefix,120);
  assert.deepEqual(record.fences.map(f=>[f.label,f.stage]),[['A','settled'],['B','settled'],['A','native-warm'],['B','native-warm'],['A','refined'],['B','refined']]);
  for(const f of record.fences){
    validateFence(f);
    const expected=121+record.assets[f.label].length+(f.stage==='settled'?0:120)+(f.stage==='refined'?record.refinement[f.label].length:0);
    assert.equal(f.before,expected,'A GPU fence must describe its exact preparation boundary');
  }
}
