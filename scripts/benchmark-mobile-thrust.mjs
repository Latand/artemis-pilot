// Read-only QA instrumentation: serial, balanced baseline/head comparison on
// one runner and browser. Typed-array readback fences completed GPU work.
// All simulation, rendering, materials and quality decisions stay production
// code; only frame pacing and metrics are controlled. Chromium finish() is
// only a flush: https://chromium.googlesource.com/chromium/src/third_party/+/master/blink/renderer/modules/webgl/webgl_rendering_context_base.cc#3557
import assert from 'node:assert/strict';
import { mobileThrustQualitySettings } from './mobile-thrust-fixtures.mjs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const baseRoot=resolve(process.env.BASE_ROOT||'');
assert(process.env.BASE_ROOT,'An exact baseline worktree is required');
const headRoot=resolve('.'), out=resolve(process.env.ARTEMIS_EVIDENCE||'evidence/thrust-comparison');
await mkdir(out,{recursive:true});
const propulsionModelsMatch=existsSync(resolve(baseRoot,'src/curvatureDrive.js'))===existsSync(resolve(headRoot,'src/curvatureDrive.js'));
const sha=root=>execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const report={propulsionModelsMatch,qualityPolicy:'Explicit High with DPR 1 matches the pre-adaptive mobile renderer; compare verified High budgets and actual per-frame GPU workloads, retaining raw quality telemetry.',initialization:'Exactly one paused production frame on both revisions, including the deferred-startup revision.',synchronization:'Reused typed-array readPixels from the production canvas; finishMs is flush overhead only.',baseline:sha(baseRoot),head:sha(headRoot),order:['base','head','head','base'],thrustWarmFrames:48,measuredFrames:48,runs:[],errors:[],limitations:['Sequential Chromium/SwiftShader CI comparison, not physical-device FPS.','No context loss is injected here; the unchanged 1,200-frame recovery/soak suite is a separate gate.','This diagnostic reports the OFF-path cost of the whole ship change, not an isolated causal estimate of draw calls.']};
let browser;
try {
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 for(const [index,variant] of report.order.entries()) {
  const root=variant==='base'?baseRoot:headRoot;
  const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'serial-thrust-timing',enforce:'pre',transform(source,id){
   if(!id.split('?')[0].endsWith('/src/main.js'))return;
   const start='const firstFrameT0 = perfStart();', loop='renderer.setAnimationLoop(frame);';
   assert.equal(source.split(start).length,2);assert.equal(source.split(loop).length,2);
   // Older revisions render once at startup; new responsive startup defers it.
   // This stopped-loop timing fixture needs exactly that same one paused frame.
   const startupFrame=source.includes(start+'\nframe();')?'':'\nframe();';
   return source.replace(start,'G.t=0;G.paused=true;G.warp=60;resetEphem();clock.getDelta=()=>1/30;'+start+startupFrame)
    .replace(loop,'')+`\nconst thrustReadbackPixel=new Uint8Array(4);\nwindow.__thrustFrameNo=()=>frameNo;\nwindow.__timedThrustFrame=()=>{lastMobileFrame=-Infinity;renderer.info.autoReset=false;renderer.info.reset();const start=performance.now();frame();const submitted=performance.now();const gl=renderer.getContext();gl.finish();const flushed=performance.now();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,thrustReadbackPixel);const finished=performance.now();const galaxy=galaxyVolumeStats();return{submissionMs:submitted-start,finishMs:flushed-submitted,readbackMs:finished-flushed,totalMs:finished-start,frameNo,camera:camera.position.toArray(),cameraTarget:cam.tgt.toArray(),calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,points:renderer.info.render.points,lines:renderer.info.render.lines,computeEvery:river.computeEvery||1,skippedCompute:!!river.skippedCompute,riverDrawCount:river.drawCount||0,sourceCount:river.sourceCount||0,texW:river.texW||0,quality:{...renderQuality},galaxyRenders:galaxy.renders,galaxyReady:galaxy.mapsReady&&galaxy.coverageReady,galaxyScale:galaxy.scale,galaxyResolution:galaxy.res,riverCount:river.count,buffer:[gl.drawingBufferWidth,gl.drawingBufferHeight],antialias:gl.getContextAttributes().antialias,bufferSamples:gl.getParameter(gl.SAMPLES)};};`;
  }}]});
  await server.listen();
  const context=await browser.newContext({viewport:{width:430,height:932},isMobile:true,hasTouch:true,deviceScaleFactor:3});
  try {
   const page=await context.newPage();page.setDefaultTimeout(180000);
   await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','pilot');Date.now=()=>Date.UTC(2026,9,2,12);let seed=0x41525445;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};});
   page.on('pageerror',e=>report.errors.push(`${index}/${variant}: ${e.stack||e.message}`));
   page.on('console',m=>{if(m.type()==='error')report.errors.push(`${index}/${variant}: ${m.text()}`);});
   await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
   await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?quality=high&dpr=1&focus=ship&dist=2.6&hidehelp=1&compile=0&perf=1`,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.__AP_READY&&window.__timedThrustFrame);
   const snapshot=()=>page.evaluate(async()=>{const {renderer,camera,cam,renderQuality}=await import('/src/scene.js');const {galaxyVolumeStats}=await import('/src/render/galaxyVolume.js');return{frameNo:window.__thrustFrameNo(),flight:Object.fromEntries(['t','x','y','z','vx','vy','vz','fuel','dvUsed','heading','pitch','paused'].map(k=>[k,__G[k]])),quality:{...renderQuality},camera:camera.position.toArray(),cameraTarget:cam.tgt.toArray(),distance:cam.dist,memory:{...renderer.info.memory},programs:renderer.info.programs.length,galaxy:galaxyVolumeStats()};});
   const step=()=>page.evaluate(()=>new Promise((resolve,reject)=>setTimeout(()=>{try{resolve(__timedThrustFrame());}catch(e){reject(e);}},0)));
   const gpuStatus=()=>page.evaluate(async()=>{const {renderer}=await import('/src/scene.js');const gl=renderer.getContext();return{contextLost:gl.isContextLost(),error:gl.getError(),canvas:renderer.getRenderTarget()===null};});
   const initial=await snapshot();
   const run={index,variant,initial,warmFrames:[],frames:[],coastFrames:[]};report.runs.push(run);
   await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
   assert.equal(initial.frameNo,1,'Exactly one paused production initialization frame');
   mobileThrustQualitySettings(initial.quality);
   await page.evaluate(async()=>{if(!(await import('/src/saves.js')).saveState())throw Error('Initial benchmark save failed');});
   // Compare the explicitly hidden guide path on both versions, independent
   // of their shipped default. This changes presentation only.
   await page.evaluate(async()=>{(await import('/src/shipVisuals.js')).shipVisuals.enabled=false;});
   assert(await page.evaluate(async()=>!(await import('/src/shipVisuals.js')).shipVisuals.enabled),'Guide is explicitly OFF for comparison');
   const track=await page.locator('#mThrTrack').boundingBox();assert(track);
   await page.mouse.move(track.x+track.width/2,track.y+track.height*.15);await page.mouse.down();
   await page.evaluate(()=>{__G.paused=false;});
   // Warm a full cadence cycle under actual propulsion input.
   for(let i=0;i<report.thrustWarmFrames;i++)run.warmFrames.push(await step());
   const measurementStart=await snapshot();run.measurementStart=measurementStart;
   await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
   assert(measurementStart.galaxy.mapsReady&&measurementStart.galaxy.coverageReady,'Galaxy resources warmed before comparison');
   const gpuBefore=await gpuStatus();run.gpuBefore=gpuBefore;
   const frames=run.frames;
   for(let i=0;i<report.measuredFrames;i++)frames.push(await step());
   const gpuAfter=await gpuStatus();run.gpuAfter=gpuAfter;
   await page.mouse.up();
   const final=await snapshot();run.final=final;
   assert(final.flight.dvUsed>initial.flight.dvUsed,'Actual mobile thrust was applied');
   assert(frames.every(f=>['submissionMs','finishMs','readbackMs','totalMs','calls','triangles','points','lines'].every(k=>Number.isFinite(f[k]))),'Finite render timing and counters');
   // Independent zero-command replay from the original state. Ballistic
   // flight is unchanged by the new actuator and must remain bit-identical
   // across versions, separately from intentionally different active flight.
   await page.evaluate(async()=>{await(await import('/src/saves.js')).loadState();__G.paused=true;__G.focus='free';__timedThrustFrame();await(await import('/src/saves.js')).loadState();__G.paused=false;});
   const coastFrames=run.coastFrames;for(let i=0;i<48;i++)coastFrames.push(await step());
   const coastFinal=await snapshot();run.coastFinal=coastFinal;
   assert(coastFinal.flight.dvUsed===initial.flight.dvUsed,'Coast replay consumes zero commanded delta-v');
   Object.assign(run,{final,gpuAfter,coastFinal,coastMeanMs:coastFrames.reduce((s,f)=>s+f.totalMs,0)/coastFrames.length,meanMs:frames.reduce((s,f)=>s+f.totalMs,0)/frames.length});
   await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
   assert.deepEqual(gpuBefore,{contextLost:false,error:0,canvas:true},'Warmup finishes on live, error-free canvas');
   assert.deepEqual(gpuAfter,{contextLost:false,error:0,canvas:true},'Measured readback finishes on live, error-free canvas');
   assert(frames.every((f,i)=>f.frameNo===(i===0?measurementStart.frameNo:frames[i-1].frameNo)+1),'Every sample runs a production frame, never a hidden/throttled no-op');
   console.log('COMPARISON',index,variant,report.runs.at(-1).meanMs,final.memory);
  } finally {await context.close();await server.close();}
 }
 const first=report.runs[0];
 const referenceBuffer=first.frames[0];
 assert(report.runs.every(r=>[...r.frames,...r.coastFrames].every(f=>
  JSON.stringify(f.buffer)===JSON.stringify(referenceBuffer.buffer)&&f.antialias===true&&f.bufferSamples===referenceBuffer.bufferSamples&&f.texW===96&&f.riverCount===96*96)),
 'Every timed frame has identical actual framebuffer/MSAA and full 96-squared mobile river allocation');
 assert(report.runs.every(r=>JSON.stringify(r.initial.flight)===JSON.stringify(first.initial.flight)),'Matched initial physical state');
 assert(report.runs.every(r=>JSON.stringify(r.coastFinal.flight)===JSON.stringify(first.coastFinal.flight)),'Drive-off ballistic replay is bit-identical across versions');
 assert(report.runs.every(r=>r.coastFrames.every((f,i)=>f.camera.every((v,k)=>Math.abs(v-first.coastFrames[i].camera[k])<1e-9)&&f.cameraTarget.every((v,k)=>Math.abs(v-first.coastFrames[i].cameraTarget[k])<1e-9)&&JSON.stringify(mobileThrustQualitySettings(f.quality))===JSON.stringify(mobileThrustQualitySettings(first.coastFrames[i].quality)))),'Coast timing matches camera, target and quality on every frame');
 const coastProfile=f=>JSON.stringify([f.computeEvery,f.skippedCompute,f.riverDrawCount,f.sourceCount,f.texW,f.riverCount,f.buffer,f.antialias,f.bufferSamples,f.galaxyReady,f.galaxyScale,f.galaxyResolution]);
 report.coastWorkComparisons=report.runs.map(r=>({variant:r.variant,index:r.index,matchedWorkFrames:r.coastFrames.filter((f,i)=>coastProfile(f)===coastProfile(first.coastFrames[i])).length}));
 report.coastWorkloadConfounded=report.coastWorkComparisons.some(r=>r.matchedWorkFrames!==48);
 // Repeated executions of each model must remain bit-identical. A deliberate
 // change from instantaneous thrust to an engaging field has different
 // physical endpoints; report it as a timing confound, never as mesh cost.
 for(const variant of ['base','head']) {
  const runs=report.runs.filter(r=>r.variant===variant), reference=runs[0];
  assert(runs.every(r=>JSON.stringify(r.measurementStart.flight)===JSON.stringify(reference.measurementStart.flight)),`${variant}: deterministic post-command warmup`);
  assert(runs.every(r=>JSON.stringify(r.final.flight)===JSON.stringify(reference.final.flight)),`${variant}: bit-identical repeated final command state`);
  assert(runs.every(r=>JSON.stringify(r.final.camera)===JSON.stringify(reference.final.camera)),`${variant}: repeated camera state`);
 }
 if(propulsionModelsMatch){
  assert(report.runs.every(r=>JSON.stringify(r.measurementStart.flight)===JSON.stringify(first.measurementStart.flight)),'Matched post-thrust-warmup physical state');
  assert(report.runs.every(r=>JSON.stringify(r.final.flight)===JSON.stringify(first.final.flight)),'Bit-identical final thrust state');
 } else {
  const head=report.runs.find(r=>r.variant==='head');
  report.intentionalModelDelta=Object.fromEntries(['x','y','z','vx','vy','vz','dvUsed'].map(k=>[k,head.final.flight[k]-first.final.flight[k]]));
  assert(Object.values(report.intentionalModelDelta).every(Number.isFinite),'Changed actuator endpoints stay finite');
 }
 assert(report.runs.every(r=>JSON.stringify(mobileThrustQualitySettings(r.initial.quality))===JSON.stringify(mobileThrustQualitySettings(first.initial.quality))&&JSON.stringify(mobileThrustQualitySettings(r.final.quality))===JSON.stringify(mobileThrustQualitySettings(first.final.quality))),'Matched production quality settings');
 assert(report.runs.every(r=>JSON.stringify(r.initial.camera)===JSON.stringify(first.initial.camera)), 'Matched initial production camera');
 if(propulsionModelsMatch)assert(report.runs.every(r=>JSON.stringify(r.final.camera)===JSON.stringify(first.final.camera)),'Matched final production camera');
 assert.equal(report.errors.length,0,'No browser/shader errors');
 const means=Object.fromEntries(['base','head'].map(v=>[v,report.runs.filter(r=>r.variant===v).reduce((s,r)=>s+r.meanMs,0)/2]));
 assert(means.head<=means.base*1.5+20,'Hidden-guide active flight retains the 50 percent + 20ms whole-app regression bound');
 const coastMeans=Object.fromEntries(['base','head'].map(v=>[v,report.runs.filter(r=>r.variant===v).reduce((s,r)=>s+r.coastMeanMs,0)/2]));
 report.coastPerformance={...coastMeans,limit:'head <= base * 1.5 + 20ms'};
 assert(coastMeans.head<=coastMeans.base*1.5+20,'Drive-off ballistic replay retains the 50 percent + 20ms whole-app regression bound');
 // Wall-clock refresh can change work even with identical physical endpoints.
 // Expose the mismatch instead of attributing an unconditional ratio to meshes.
 const profile=r=>{let prior=r.measurementStart.galaxy.renders;return r.frames.map(f=>{const delta=f.galaxyRenders-prior;prior=f.galaxyRenders;return JSON.stringify([mobileThrustQualitySettings(f.quality),f.computeEvery,f.skippedCompute,f.riverDrawCount,f.sourceCount,f.texW,f.riverCount,f.buffer,f.antialias,f.bufferSamples,delta,f.galaxyReady,f.galaxyScale,f.galaxyResolution]);});};
 const referenceProfile=profile(first);
 const workComparisons=report.runs.map(r=>({index:r.index,variant:r.variant,matchedWorkFrames:profile(r).filter((s,i)=>s===referenceProfile[i]).length,galaxyRenders:r.final.galaxy.renders-r.measurementStart.galaxy.renders}));
 const profileConfounded=workComparisons.some(r=>r.matchedWorkFrames!==report.measuredFrames);
 // The selected profile is not the whole renderer. Async catalog/body assets
 // may still add point draws or geometries even after galaxy maps are ready.
 const rendererWorkComparisons=report.runs.map(r=>({index:r.index,variant:r.variant,
  differingPointFrames:r.frames.filter((f,i)=>f.points!==first.frames[i].points).length,
  differingLineFrames:r.frames.filter((f,i)=>f.lines!==first.frames[i].lines).length,
  meanCallDelta:r.frames.reduce((s,f,i)=>s+f.calls-first.frames[i].calls,0)/r.frames.length,
  meanTriangleDelta:r.frames.reduce((s,f,i)=>s+f.triangles-first.frames[i].triangles,0)/r.frames.length,
  geometryGrowth:r.final.memory.geometries-r.measurementStart.memory.geometries,
  textureGrowth:r.final.memory.textures-r.measurementStart.memory.textures}));
 const rendererWorkConfounded=rendererWorkComparisons.some(r=>r.differingPointFrames||r.differingLineFrames||r.geometryGrowth||r.textureGrowth);
 const confounded=!propulsionModelsMatch||profileConfounded||rendererWorkConfounded;
 report.summary={...means,wholeAppOffPathRatio:means.head/means.base,deltaMs:means.head-means.base,workComparisons,rendererWorkComparisons,profileConfounded,rendererWorkConfounded,confounded,interpretation:confounded?'Propulsion model or renderer workload/resources differ; use only a qualified whole-app comparison, not isolated ship-model cost or a speedup claim.':'Recorded work profiles match; this is whole-app OFF-path timing, not isolated draw-call causality.'};
 console.log('BALANCED OFF-PATH COMPARISON',report.summary);
} catch(error) {report.failure=error.stack||String(error);throw error;} finally {await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser?.close();}
