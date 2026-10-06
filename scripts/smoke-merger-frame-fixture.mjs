import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {mergerFrameHook,readMergerFrameNumber,mergerFramesDelivered,waitForMergerFrames} from './merger-frame-fixture.mjs';
for(const remote of [false,true]) for(const count of [4,8]) for(const skip of [0,1,60]) {
  let frame=10, polls=0;globalThis.window=remote?{__renderFrameGate:{get submitted(){return frame;}}}:{__mergerFrameNumber:()=>frame};
  const page={evaluate:async fn=>fn(),waitForFunction:async(fn,args,options)=>{
    assert.deepEqual(options,{timeout:180000,polling:'raf'});
    for(let i=0;i<count;i++) {
      for(let j=0;j<=skip;j++){assert.equal(fn(args),false);polls++;}
      frame++;
    }
    assert.equal(fn(args),true);
  }};
  assert.deepEqual(await waitForMergerFrames(page,count),{start:10,end:10+count,requestedFrames:count,producedFrames:count});
  assert.equal(polls,count*(skip+1));
}
for(const frame of [undefined,NaN,1.5,-1,9,13]) {globalThis.window={__mergerFrameNumber:()=>frame};assert.equal(mergerFramesDelivered({start:10,count:4}),false);}
globalThis.window={};await assert.rejects(waitForMergerFrames({evaluate:async fn=>fn()},4),/needs a local source counter/);
globalThis.window={__mergerFrameNumber:()=>0};
await assert.rejects(waitForMergerFrames({evaluate:async fn=>fn(),waitForFunction:async()=>{throw Error('Timeout180000ms');}},8),/Timeout180000ms/);
assert.equal(readMergerFrameNumber(),0);
delete globalThis.window;
const src=readFileSync(new URL('./smoke-merger.mjs',import.meta.url),'utf8');
assert(!src.includes('requestAnimationFrame'));
assert(src.includes('waitForMergerFrames(page,8)')&&src.includes('waitForMergerFrames(page,4)'));
assert(src.includes('t && t.ready && !t.error && t.visible > 0'));
assert(src.includes('timeout: 120000, polling: 250'));
assert(src.includes('sum.sampled * 0.05'));
const production=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
execFileSync(process.execPath,['--input-type=module','--check'],{input:production+mergerFrameHook});
console.log('Merger fixture:8/4 actual updates after epoch/worker readiness, unchanged debris/nonblank/deadline assertions, skipped/non-delivery/counter negatives pass.');
