// Run the real capture helper with a default-framebuffer lifecycle double.
// Any await after drawing clears this simulated non-preserved backbuffer.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./verify-river-coverage.mjs',import.meta.url),'utf8');
const start=source.indexOf(' const setViewportStable=async size=>{');
const end=source.indexOf(' check(await page.evaluate(async mobile=>',start);
assert(start>0&&end>start);
const helper=source.slice(start,end);
assert.equal(helper.split("await import('/src/scene.js')").length,3);
async function run(mobile,mode,code=helper){
 const captureViewport=mobile?{width:430,height:932}:{width:960,height:640};
 const viewport=mobile?{width:215,height:466}:{width:768,height:512};
 const events=[],writes=[],report={};let pending,ratio=.5,alive=false;
 const scene={viewportSize:{w:viewport.width,h:viewport.height},renderQuality:{mobile:mode==='wrong-tier'?!mobile:mobile},cvHost:{clientWidth:viewport.width,clientHeight:viewport.height},camera:{aspect:viewport.width/viewport.height}};
 const gl={RGBA:6408,UNSIGNED_BYTE:5121,get drawingBufferWidth(){return mode==='wrong-size'?1:scene.viewportSize.w*ratio;},get drawingBufferHeight(){return scene.viewportSize.h*ratio;},readPixels(x,y,w,h,f,t,data){if(alive&&mode!=='blank')for(let i=0;i<20;i+=4)data[i]=255;}};
 const canvas={width:Math.floor(viewport.width*ratio),height:Math.floor(viewport.height*ratio),toDataURL(type){assert.equal(type,'image/png');assert(alive,'PNG must be copied before the task yields');events.push('copy');return 'data:image/png;base64,'+Buffer.from('preserved pixels').toString('base64');}};
 scene.renderer={getContext:()=>gl,getPixelRatio:()=>ratio,domElement:canvas};
 const poll=(fn,size)=>{const result=fn(size);assert(!result||typeof result.then!=='function','waitForFunction predicate must return synchronously, never a Promise');return result;};
 const page={async setViewportSize(size){pending=size;scene.cvHost.clientWidth=size.width;scene.cvHost.clientHeight=size.height;events.push('resize');},async waitForFunction(fn,size){
  assert.equal(poll(fn,size),false,'stale production viewport cannot settle');
  scene.viewportSize.w=pending.width;scene.viewportSize.h=pending.height;
  assert.equal(poll(fn,size),false,'stale camera/buffer cannot settle');
  scene.camera.aspect=pending.width/pending.height;
  canvas.width=Math.floor(pending.width*ratio);canvas.height=Math.floor(pending.height*ratio);
  assert.equal(poll(fn,size),true);events.push('stable');
 },async evaluate(fn){return fn();},async screenshot(opts){events.push('ui');assert(opts.path.endsWith('-ui.png'));}};
 const window={__coverageDpr:value=>{ratio=value;canvas.width=Math.floor(scene.viewportSize.w*ratio);canvas.height=Math.floor(scene.viewportSize.h*ratio);events.push('dpr:'+value);},__coverageFrame:()=>{assert.deepEqual(events.slice(-2),['stable','dpr:1']);alive=true;queueMicrotask(()=>{alive=false;});events.push('draw');}};
 const context=vm.createContext({page,window,__scene:scene,report,mobile,captureViewport,viewport,out:'/fixture',check:assert,Uint8Array,Buffer,Promise,writeFile:async(path,bytes)=>{writes.push({path,text:bytes.toString()});}});
 const fn=vm.runInContext(code.replaceAll("await import('/src/scene.js')",'await Promise.resolve(globalThis.__scene)')+'\nscreenshot',context);
 await fn('test');
 assert.equal(report.captures[0].litPixels,5);assert.equal(report.captures[0].png,undefined,'PNG bytes do not bloat JSON report');
 assert.deepEqual(writes,[{path:'/fixture/test.png',text:'preserved pixels'}]);assert(events.indexOf('copy')<events.indexOf('ui'));
 assert.equal(ratio,.5);assert.deepEqual({...scene.viewportSize},{w:viewport.width,h:viewport.height});
}
for(const mobile of [false,true]){
 await run(mobile,'valid');
 for(const mode of ['blank','wrong-size','wrong-tier'])await assert.rejects(run(mobile,mode));
 const scene="   const s=await import('/src/scene.js'),gl=s.renderer.getContext();\n";
 const draw='   window.__coverageDpr(1);window.__coverageFrame();\n';
 assert.equal(helper.split(scene).length,2);assert.equal(helper.split(draw).length,2);
 const lateImport=helper.replace(scene,'').replace(draw,draw+scene);
 await assert.rejects(run(mobile,'valid',lateImport),'The former draw-then-await ordering must fail');
 const asyncPredicate=helper.replace('page.waitForFunction(size=>{','page.waitForFunction(async size=>{');
 assert.notEqual(asyncPredicate,helper);
 await assert.rejects(run(mobile,'valid',asyncPredicate),/must return synchronously/,'Async polling must fail instead of concealing the browser race');
}
assert(source.includes('const modes=baseline?[0]:[0,3852,-3852];'));
assert(source.includes('const length=baseline?120:400;'));
console.log('River capture: synchronous viewport polling, camera/buffer settlement, default-buffer read/PNG, restoration, blank/size/quality rejection, async mutations and all1200 frames pass');
