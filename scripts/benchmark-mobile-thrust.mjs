// Read-only QA instrumentation: serial, balanced baseline/head comparison on
// one runner and browser. All simulation, rendering, materials and quality
// decisions stay production code; only frame pacing and metrics are controlled.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const baseRoot=resolve(process.env.BASE_ROOT||'');
assert(process.env.BASE_ROOT,'An exact baseline worktree is required');
const headRoot=resolve('.'), out=resolve(process.env.ARTEMIS_EVIDENCE||'evidence/thrust-comparison');
await mkdir(out,{recursive:true});
const sha=root=>execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const report={baseline:sha(baseRoot),head:sha(headRoot),order:['base','head','head','base'],thrustWarmFrames:48,measuredFrames:48,runs:[],errors:[],limitations:['Sequential Chromium/SwiftShader CI comparison, not physical-device FPS.','No context loss is injected here; the unchanged 1,200-frame recovery/soak suite is a separate gate.','This diagnostic reports the OFF-path cost of the whole ship change, not an isolated causal estimate of draw calls.']};
const browser=await chromium.launch({args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 for(const [index,variant] of report.order.entries()) {
  const root=variant==='base'?baseRoot:headRoot;
  const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'serial-thrust-timing',enforce:'pre',transform(source,id){
   if(!id.split('?')[0].endsWith('/src/main.js'))return;
   const start='const firstFrameT0 = perfStart();', loop='renderer.setAnimationLoop(frame);';
   assert.equal(source.split(start).length,2);assert.equal(source.split(loop).length,2);
   return source.replace(start,'G.t=0;G.paused=true;G.warp=60;resetEphem();clock.getDelta=()=>1/30;'+start)
    .replace(loop,'')+`\nwindow.__timedThrustFrame=()=>{lastMobileFrame=-Infinity;renderer.info.autoReset=false;renderer.info.reset();const start=performance.now();frame();const submitted=performance.now();renderer.getContext().finish();const finished=performance.now();const galaxy=galaxyVolumeStats();return{submissionMs:submitted-start,finishMs:finished-submitted,totalMs:finished-start,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,points:renderer.info.render.points,lines:renderer.info.render.lines,computeEvery:river.computeEvery||1,skippedCompute:!!river.skippedCompute,riverDrawCount:river.drawCount||0,sourceCount:river.sourceCount||0,texW:river.texW||0,quality:{...renderQuality},galaxyRenders:galaxy.renders,galaxyReady:galaxy.mapsReady&&galaxy.coverageReady,galaxyScale:galaxy.scale};};`;
  }}]});
  await server.listen();
  const context=await browser.newContext({viewport:{width:430,height:932},isMobile:true,hasTouch:true,deviceScaleFactor:3});
  try {
   const page=await context.newPage();page.setDefaultTimeout(180000);
   await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','pilot');Date.now=()=>Date.UTC(2026,9,2,12);let seed=0x41525445;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};});
   page.on('pageerror',e=>report.errors.push(`${index}/${variant}: ${e.stack||e.message}`));
   page.on('console',m=>{if(m.type()==='error')report.errors.push(`${index}/${variant}: ${m.text()}`);});
   await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
   await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=ship&dist=2.6&hidehelp=1&compile=0&perf=1`,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.__AP_READY&&window.__timedThrustFrame);
   const snapshot=()=>page.evaluate(async()=>{const {renderer,camera,cam,renderQuality}=await import('/src/scene.js');const {galaxyVolumeStats}=await import('/src/render/galaxyVolume.js');return{flight:Object.fromEntries(['t','x','y','z','vx','vy','vz','fuel','dvUsed','heading','pitch','paused'].map(k=>[k,__G[k]])),quality:{...renderQuality},camera:camera.position.toArray(),cameraTarget:cam.tgt.toArray(),distance:cam.dist,memory:{...renderer.info.memory},programs:renderer.info.programs.length,galaxy:galaxyVolumeStats()};});
   const initial=await snapshot();
   if(variant==='head')assert(await page.evaluate(async()=>!(await import('/src/shipVisuals.js')).shipVisuals.enabled),'Head visual remains OFF');
   const track=await page.locator('#mThrTrack').boundingBox();assert(track);
   await page.mouse.move(track.x+track.width/2,track.y+track.height*.15);await page.mouse.down();
   await page.evaluate(()=>{__G.paused=false;});
   // Warm a full cadence cycle, including exhaust/flame, under actual thrust.
   for(let i=0;i<report.thrustWarmFrames;i++)await page.evaluate(()=>__timedThrustFrame());
   const measurementStart=await snapshot();
   assert(measurementStart.galaxy.mapsReady&&measurementStart.galaxy.coverageReady,'Galaxy resources warmed before comparison');
   const frames=[];
   for(let i=0;i<report.measuredFrames;i++)frames.push(await page.evaluate(()=>__timedThrustFrame()));
   await page.mouse.up();
   const final=await snapshot();
   assert(final.flight.dvUsed>initial.flight.dvUsed,'Actual mobile thrust was applied');
   assert(frames.every(f=>['submissionMs','finishMs','totalMs','calls','triangles','points','lines'].every(k=>Number.isFinite(f[k]))),'Finite render timing and counters');
   report.runs.push({index,variant,initial,measurementStart,final,frames,meanMs:frames.reduce((s,f)=>s+f.totalMs,0)/frames.length});
   await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
   console.log('COMPARISON',index,variant,report.runs.at(-1).meanMs,final.memory);
  } finally {await context.close();await server.close();}
 }
 const first=report.runs[0];
 assert(report.runs.every(r=>JSON.stringify(r.initial.flight)===JSON.stringify(first.initial.flight)),'Matched initial physical state');
 assert(report.runs.every(r=>JSON.stringify(r.measurementStart.flight)===JSON.stringify(first.measurementStart.flight)),'Matched post-thrust-warmup physical state');
 assert(report.runs.every(r=>JSON.stringify(r.final.flight)===JSON.stringify(first.final.flight)),'Bit-identical final thrust state');
 assert(report.runs.every(r=>JSON.stringify(r.initial.quality)===JSON.stringify(first.initial.quality)&&JSON.stringify(r.final.quality)===JSON.stringify(first.final.quality)),'Matched production quality settings');
 assert(report.runs.every(r=>JSON.stringify(r.initial.camera)===JSON.stringify(first.initial.camera)&&JSON.stringify(r.final.camera)===JSON.stringify(first.final.camera)),'Matched production camera');
 assert.equal(report.errors.length,0,'No browser/shader errors');
 const means=Object.fromEntries(['base','head'].map(v=>[v,report.runs.filter(r=>r.variant===v).reduce((s,r)=>s+r.meanMs,0)/2]));
 // Wall-clock refresh can change work even with identical physical endpoints.
 // Expose the mismatch instead of attributing an unconditional ratio to meshes.
 const profile=r=>{let prior=r.measurementStart.galaxy.renders;return r.frames.map(f=>{const delta=f.galaxyRenders-prior;prior=f.galaxyRenders;return JSON.stringify([f.quality,f.computeEvery,f.skippedCompute,f.riverDrawCount,f.sourceCount,f.texW,delta,f.galaxyReady,f.galaxyScale]);});};
 const referenceProfile=profile(first);
 const workComparisons=report.runs.map(r=>({index:r.index,variant:r.variant,matchedWorkFrames:profile(r).filter((s,i)=>s===referenceProfile[i]).length,galaxyRenders:r.final.galaxy.renders-r.measurementStart.galaxy.renders}));
 const confounded=workComparisons.some(r=>r.matchedWorkFrames!==report.measuredFrames);
 report.summary={...means,wholeAppOffPathRatio:means.head/means.base,deltaMs:means.head-means.base,workComparisons,confounded,interpretation:confounded?'Adaptive work differs; do not treat this ratio as isolated ship-model cost.':'Recorded work profiles match; this is whole-app OFF-path timing, not isolated draw-call causality.'};
 console.log('BALANCED OFF-PATH COMPARISON',report.summary);
} finally {await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();}
