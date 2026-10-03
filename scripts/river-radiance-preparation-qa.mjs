import assert from 'node:assert/strict';
import { protocol } from './river-radiance-paired-protocol.mjs';
export function validatePreparationFrame(sample){
  assert.equal(sample.gpuSynchronized,false,'Preparation must be explicitly marked unsynchronized');
  assert.equal(sample.finishMs,0);assert.equal(sample.readbackMs,0);
  assert(Number.isInteger(sample.frameNo)&&sample.cpuMs>0&&Number.isFinite(sample.cpuMs));
  assert(sample.river.enabled&&sample.river.visible);
  assert.deepEqual(sample.gpu,{contextLost:false,losses:0,restores:0,error:0,defaultFramebuffer:true});
}
export function validatePrefix(prefix,delivered){
  assert(Number.isInteger(delivered)&&delivered>=0&&delivered<=protocol.catalogSetupUpdates);
  assert.deepEqual(prefix,{updates:delivered,remaining:protocol.catalogSetupUpdates-delivered},'Exact normal catalog prefix is mandatory');
}
export function settlementReadyWithinDeadline(ready,elapsedMs,budgetMs){
  assert(Number.isFinite(elapsedMs)&&elapsedMs>=0&&Number.isFinite(budgetMs)&&budgetMs>0);
  assert(elapsedMs<budgetMs,'Five-minute asset settlement deadline expired after the complete fixed prefix');
  return ready.A.ready&&ready.B.ready;
}
export function validateFence(fence){
  assert(Number.isInteger(fence.before)&&fence.before===fence.after,'Fence must not hide another delivered frame');
  assert(Number.isFinite(fence.durationMs)&&fence.durationMs>=0);
  assert.equal(fence.contextLost,false);assert.equal(fence.error,0);assert.equal(fence.defaultFramebuffer,true);
  assert(Array.isArray(fence.pixel)&&fence.pixel.length===4&&fence.pixel.every(x=>Number.isInteger(x)&&x>=0&&x<=255));
}
