import assert from 'node:assert/strict';
import { Vector4 } from 'three';
import { bindContextLifecycle, readRenderScissor } from '../src/render/contextLifecycle.js';
let lost=false, box=[2,3,640,480], holds=0, restores=0;
const canvas=new EventTarget(), gl={isContextLost:()=>lost,SCISSOR_BOX:1,getParameter:()=>box};
const renderer={domElement:canvas,getContext:()=>gl};
const context=bindContextLifecycle(renderer,{onLost:()=>holds++,onRestored:()=>restores++});
assert.equal(context.isLost(),false);
const vector=new Vector4();assert.equal(readRenderScissor(renderer,vector),true);assert.deepEqual(vector.toArray(),box);
lost=true;
assert.equal(context.isLost(),true);assert.equal(holds,1,'Poll catches loss before native event');
assert.equal(readRenderScissor(renderer,vector),false);
const event=new Event('webglcontextlost',{cancelable:true});canvas.dispatchEvent(event);
assert(event.defaultPrevented,'Restoration is explicitly permitted');assert.equal(holds,1,'Event does not reset flight twice');
lost=false;assert.equal(context.isLost(),true,'Stay held until native restoration has rebuilt renderer resources');
canvas.dispatchEvent(new Event('webglcontextrestored'));assert.equal(context.isLost(),false);assert.equal(restores,1);
box=null;assert.equal(readRenderScissor(renderer,vector),false,'Mid-query loss never feeds null into Vector4.fromArray');assert.deepEqual(vector.toArray(),[2,3,640,480]);
for(let i=0;i<3;i++){lost=true;canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));lost=false;canvas.dispatchEvent(new Event('webglcontextrestored'));}
assert.equal(holds,4);assert.equal(restores,4);assert.equal(context.losses,4);assert.equal(context.restores,4);
console.log('PASS: context loss polling/event ordering, null GL query race, repeated recovery');
// Exercise the installed Three scheduler, not a lookalike event loop: an
// exception before WebGLAnimation's final requestAnimationFrame kills it.
const { WebGLAnimation } = await import('../node_modules/three/src/renderers/webgl/WebGLAnimation.js');
function schedulerHarness(callback) {
    let pending=null, requests=0;
    const animation=WebGLAnimation();
    animation.setContext({requestAnimationFrame(fn){pending=fn;return ++requests;},cancelAnimationFrame(){pending=null;}});
    animation.setAnimationLoop(callback);animation.start();
    return { tick(){const fn=pending;pending=null;fn(0,null);},hasNext:()=>!!pending,requests:()=>requests };
}
const baseline=schedulerHarness(()=>new Vector4().fromArray(null));
assert.throws(()=>baseline.tick(),TypeError);assert.equal(baseline.hasNext(),false,'Baseline null-GL-query exception permanently stops Three frame scheduling');
const guarded=schedulerHarness(()=>{if(!readRenderScissor(renderer,vector))return;});
guarded.tick();assert.equal(guarded.hasNext(),true,'Lost-context query guard preserves the next animation frame');
console.log('PASS: installed Three scheduler reproduces baseline stop and guard survives');
