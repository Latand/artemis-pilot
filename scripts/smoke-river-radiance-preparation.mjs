import assert from 'node:assert/strict';
import { validateSample } from './river-radiance-paired-protocol.mjs';
import { validatePreparationFrame,validatePrefix,validateFence,settlementReadyWithinDeadline } from './river-radiance-preparation-qa.mjs';
const sample={frameNo:1,cpuMs:3,finishMs:0,readbackMs:0,gpuSynchronized:false,river:{enabled:true,visible:true},gpu:{contextLost:false,losses:0,restores:0,error:0,defaultFramebuffer:true}};
validatePreparationFrame(sample);assert.throws(()=>validateSample(sample));
for(const mutate of[x=>x.gpuSynchronized=true,x=>x.readbackMs=1,x=>x.finishMs=1,x=>x.gpu.losses=1,x=>x.gpu.defaultFramebuffer=false,x=>x.river.visible=false]){
  const bad=structuredClone(sample);mutate(bad);assert.throws(()=>validatePreparationFrame(bad));
}
validatePrefix({updates:120,remaining:0},120);validatePrefix({updates:9,remaining:111},9);
for(const[prefix,n]of[[{updates:119,remaining:0},120],[{updates:120,remaining:1},120],[{updates:121,remaining:0},121],[{updates:8,remaining:112},9]])assert.throws(()=>validatePrefix(prefix,n));
const fence={before:120,after:120,durationMs:12,pixel:[0,0,0,255],contextLost:false,error:0,defaultFramebuffer:true};validateFence(fence);
const ready={A:{ready:true},B:{ready:true}},pending={A:{ready:true},B:{ready:false}};
assert(settlementReadyWithinDeadline(ready,299999,300000));
assert.equal(settlementReadyWithinDeadline(pending,299999,300000),false);
for(const elapsed of[300000,300001,NaN])for(const state of[ready,pending])assert.throws(()=>settlementReadyWithinDeadline(state,elapsed,300000));
for(const mutate of[x=>x.after++,x=>x.contextLost=true,x=>x.error=1282,x=>x.defaultFramebuffer=false,x=>x.pixel=[],x=>x.durationMs=NaN]){
  const bad=structuredClone(fence);mutate(bad);assert.throws(()=>validateFence(bad));
}
console.log('Preparation controls reject incomplete prefixes, unhealthy fences and unsynchronized acceptance samples');
