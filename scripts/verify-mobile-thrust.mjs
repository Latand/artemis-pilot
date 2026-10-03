// Actual app and renderer. Controlled GPU loss reproduces a recovery failure;
// it does not claim to reproduce the physical iPhone GPU/thermal trigger.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root=resolve(process.env.BASE_ROOT||'.'), before=!!process.env.BASE_ROOT;
// Later PR baselines already contain recovery. Keep the legacy negative
// reproduction only for exact source trees that predate the lifecycle module.
const expectBrokenRecovery=before&&!existsSync(resolve(root,'src/render/contextLifecycle.js'));
const driveLabel=existsSync(resolve(root,'src/curvatureDrive.js'))?'FIELD':'BURN';
const out=resolve(process.env.ARTEMIS_EVIDENCE||'evidence/mobile-thrust');
const suite=process.env.THRUST_SUITE||'all';
assert(['all','recovery','soak'].includes(suite),'Known mobile QA suite');
await mkdir(out,{recursive:true});
const report={revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),before,expectBrokenRecovery,suite,errors:[],checks:[],samples:[],limitations:['Chromium/SwiftShader mobile viewport; not physical iPhone Safari.','GPU loss is explicitly injected; original device trigger is unknown.']};
const check=(ok,name)=>{report.checks.push({name,pass:!!ok});assert(ok,name);};
const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'mobile-thrust-qa',enforce:'pre',transform(s,id){if(!id.split('?')[0].endsWith('/src/main.js'))return;
 const first='const firstFrameT0 = perfStart();';assert.equal(s.split(first).length,2);
 return s.replace(first,'G.t=0;G.paused=false;G.warp=60;resetEphem();clock.getDelta=()=>1/30;'+first)
 .replace('function frame() {','function frame() { window.__frameStarts=(window.__frameStarts||0)+1;')
 .replaceAll('    finishFramePerf(frameT0,','    window.__frameSuccess=(window.__frameSuccess||0)+1;\n    finishFramePerf(frameT0,')
 +'\nwindow.__thrustStep=()=>{lastMobileFrame=-Infinity;frame();};window.__thrustStop=()=>renderer.setAnimationLoop(null);window.__thrustStart=()=>renderer.setAnimationLoop(frame);';
}}]});
await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:430,height:932},isMobile:true,hasTouch:true,deviceScaleFactor:3});page.setDefaultTimeout(180000);
 await page.addInitScript(()=>{localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','pilot');localStorage.setItem('qa_preserve_save','untouched');Date.now=()=>Date.UTC(2026,9,2,12);});
 page.on('pageerror',e=>report.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=ship&dist=2.6&hidehelp=1&compile=0&perf=1`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__frameSuccess>=4);
 await page.evaluate(async()=>{(await import('/src/saves.js')).saveState();window.__savedBytes=localStorage.getItem('artemis.quicksave.v1');(await import('/src/audio.js')).initAudio();});
 const capture=async name=>{await page.screenshot({path:`${out}/${name}.png`,timeout:180000});};
 const state=()=>page.evaluate(async()=>{const {renderer,camera,cam,renderQuality}=await import('/src/scene.js');const {stellarExposure}=await import('/src/render/stellarAppearance.js');const {galaxyVolumeStats}=await import('/src/render/galaxyVolume.js');return{frames:window.__frameStarts,success:window.__frameSuccess,t:__G.t,x:__G.x,y:__G.y,z:__G.z,vx:__G.vx,vy:__G.vy,vz:__G.vz,dv:__G.dvUsed,paused:__G.paused,dead:__G.dead,contextLost:renderer.getContext().isContextLost(),near:camera.near,far:camera.far,cam:camera.position.toArray(),dist:cam.dist,exposure:stellarExposure.value,quality:{...renderQuality},memory:{...renderer.info.memory},galaxy:galaxyVolumeStats(),mode:document.querySelector('#mMode')?.textContent,throttle:document.querySelector('#mThrCap')?.textContent};});
 const track=await page.locator('#mThrTrack').boundingBox();assert(track);
 await page.mouse.move(track.x+track.width/2,track.y+track.height*.15);await page.mouse.down();
 await page.waitForFunction(label=>__G.dvUsed>0&&document.querySelector('#mMode')?.textContent===label,driveLabel);
 report.samples.push({name:'thrust-before-loss',...await state()});await capture('01-thrust-before-loss');
 await page.evaluate(async()=>{const {renderer}=await import('/src/scene.js');window.__loss=renderer.getContext().getExtension('WEBGL_lose_context');if(!window.__loss)throw Error('WEBGL_lose_context unavailable');window.__loss.loseContext();});
 await page.waitForTimeout(1600);await page.mouse.up();
 report.samples.push({name:'during-loss',...await state()});await capture('02-context-lost');
 const held=await state();await page.waitForTimeout(500);const heldLater=await state();
 if(!expectBrokenRecovery){check(heldLater.t===held.t,'Flight time is held while GPU context is lost');check(heldLater.mode==='HOLD','HUD explicitly reports the held flight');check(await page.evaluate(async()=>(await import('/src/audio.js')).thrustGain?.gain.value===0),'Propulsion feedback stops during the GPU outage');check(await page.locator('#renderContextStatus').isVisible(),'Recovery status is visible instead of unexplained black world');}
 await page.evaluate(()=>window.__loss.restoreContext());
 await page.waitForFunction(async()=>!(await import('/src/scene.js')).renderer.getContext().isContextLost());
 await page.waitForTimeout(2200);const restored=await state();report.samples.push({name:'after-restore',...restored});await capture('03-context-restored');
 if(expectBrokenRecovery){check(report.errors.some(e=>/null/.test(e)&&/fromArray|galaxyVolume/.test(e)),'Baseline reproduces null WebGL query exception');check(restored.success===held.success,'Baseline animation loop stays stopped after GPU restoration');}
 else {
  check(await page.evaluate(async()=>{const p=(await import('/src/river.js')).riverDebugReadPositions();return p?.finite&&p.nonZero>0&&p.distinct>0;}),'Cosmetic river GPU positions are rebuilt after restore');
  check(await page.evaluate(()=>localStorage.getItem('artemis.quicksave.v1')===window.__savedBytes&&window.__savedBytes?.length>100),'Recovery leaves stored quicksave bytes unchanged');
  check(restored.success>held.success,'Animation loop renders after context restoration');check(restored.t>held.t,'Flight resumes after context restoration');check(restored.mode==='COAST','Lost throttle is released on recovery');check(!(await page.locator('#renderContextStatus').isVisible()),'Recovery status clears after restoration');
  if(suite!=='recovery') {
  // Continue actual app frames through forty seconds / forty simulation minutes.
  await page.evaluate(()=>__thrustStop());await page.mouse.move(track.x+track.width/2,track.y+track.height*.15);await page.mouse.down();
  for(let i=0;i<1200;i++){
   await page.evaluate(()=>__thrustStep());
   if((i+1)%120===0){const s=await state();report.samples.push({name:`sustained-thrust-${i+1}`,...s});check([s.t,s.x,s.y,s.z,s.vx,s.vy,s.vz,s.near,s.far,s.exposure,...s.cam].every(Number.isFinite)&&s.near>0&&s.far>s.near&&!s.contextLost,`Frame${i+1}: finite scene and live WebGL`);await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('THRUST',i+1,s.t,s.memory);}
  }
  await capture('04-sustained-thrust');await page.mouse.up();await page.evaluate(()=>__thrustStep());await capture('05-released-throttle');
  check(await page.evaluate(()=>localStorage.getItem('qa_preserve_save')==='untouched'),'Unrelated saved data is preserved');
  }
  if(suite!=='soak') {
  await page.evaluate(()=>__thrustStop());
  // A second loss while already paused must not unpause or lose the state.
  await page.evaluate(()=>{__G.paused=true;window.__pausedTime=__G.t;window.__loss.loseContext();});await page.waitForTimeout(300);await page.evaluate(()=>__thrustStep());
  await page.evaluate(()=>window.__loss.restoreContext());await page.waitForFunction(async()=>!(await import('/src/scene.js')).renderer.getContext().isContextLost());await page.evaluate(()=>__thrustStep());
  check(await page.evaluate(()=>__G.paused&&__G.t===window.__pausedTime),'Repeated GPU recovery preserves an already-paused flight');await capture('06-paused-recovery');
  // Loss occurs *inside* an offscreen compute render and throws before it
  // returns: test scheduler + target cleanup, not just inter-frame events.
  await page.evaluate(async()=>{const {renderer}=await import('/src/scene.js');__G.paused=false;window.__faultBefore=window.__frameSuccess;const original=renderer.render;renderer.render=function(...args){if(this.getRenderTarget()){renderer.render=original;window.__midFrameInjected=true;window.__loss.loseContext();throw Error('Injected mid-render GPU loss');}return original.apply(this,args);};__thrustStart();});
  await page.waitForFunction(()=>window.__midFrameInjected);await page.waitForTimeout(300);await page.evaluate(()=>window.__loss.restoreContext());await page.waitForFunction(()=>window.__frameSuccess>window.__faultBefore+2);
  check(await page.evaluate(async()=>(await import('/src/scene.js')).renderer.getRenderTarget()===null),'Mid-render exception recovers onto the visible canvas');await capture('07-mid-frame-recovery');
  // Mobile normally gates bloom; exercise its optional composer as well.
  await page.evaluate(async()=>{const s=await import('/src/scene.js');await s.ensurePostProcessing();s.composer.render();});
  check(report.errors.length===0,'Healthy optional bloom/composer path still renders');
  }
  check(report.errors.length===0,'No page/shader errors through thrust and GPU recovery');
 }
} finally {await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
