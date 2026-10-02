// Real application render with controlled presentation inputs for matched frames.
// World is paused only in the image sequence; production ring and river shaders,
// materials, UI, lights, camera and source fields are used without substitutions.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const mobile=process.env.DEVICE==='mobile';
const out=resolve(process.env.ARTEMIS_EVIDENCE||`evidence/motion-${mobile?'mobile':'desktop'}`);
await mkdir(out,{recursive:true});
const report={revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mobile,fixture:'Paused world; prescribed HUD speed and real elapsed time drive the unchanged production presentation functions. Full-app physics equivalence tested separately.',errors:[],checks:[],frames:[]};
const check=(pass,name)=>{report.checks.push({name,pass:!!pass});assert(pass,name);};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'ship-motion-qa',enforce:'pre',transform(source,id){
 if(id.split('?')[0].endsWith('/src/river.js'))return source.replace('const FLOW_GLSL =','export const FLOW_GLSL =');
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 const marker='const firstFrameT0 = perfStart();';assert.equal(source.split(marker).length,2);
 return source.replace(marker,'G.t=0;G.paused=true;resetEphem();clock.getDelta=()=>window.__qaDt??.2;'+marker)
 .replace('G.dead || G.landed ? 0 : shipSpeed, rawDtR, G.paused,','window.__qaSpeed ?? (G.dead || G.landed ? 0 : shipSpeed), rawDtR, window.__qaMotionPause ?? G.paused,')
 .replace('renderer.setAnimationLoop(frame);','')+'\nwindow.__motionFrame=()=>{lastMobileFrame=-Infinity;const start=performance.now();frame();const submitted=performance.now();renderer.getContext().finish();return{submissionMs:submitted-start,finishMs:performance.now()-submitted,totalMs:performance.now()-start};};';
}}]});
await server.listen();const browser=await chromium.launch({args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:mobile?{width:430,height:932}:{width:1280,height:820},isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1});page.setDefaultTimeout(180000);
 await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','pilot');Date.now=()=>Date.UTC(2026,9,2,12);});
 page.on('pageerror',e=>report.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=ship&dist=.14&hidehelp=1&compile=0`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__motionFrame);
 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js');const {shipG}=await import('/src/ship.js');__G.heading=0;__G.pitch=0;__G.hold=null;__qaSpeed=0;__qaMotionPause=false;__motionFrame();cam.tgt.copy(shipG.position);cam.dist=.14;cam.yaw=.85;cam.pitch=.36;});
 const frames=async(n)=>{for(let i=0;i<n;i++)await page.evaluate(()=>__motionFrame());};
 const capture=async(name)=>{
  await page.screenshot({path:`${out}/${name}.png`,timeout:180000});
  const state=await page.evaluate(async()=>{const {shipVisuals}=await import('/src/shipVisuals.js');const {river}=await import('/src/river.js');const {craft,shipG}=await import('/src/ship.js');const {camera,renderer}=await import('/src/scene.js');return{speed:__qaSpeed,...shipVisuals.motion,enabled:shipVisuals.enabled,warpVisible:river.warpVisible,warpStrength:river.warpStrength,warpVertices:river.warpVertexCount,projected:shipG.position.clone().project(camera).toArray(),rotors:craft.userData.rotors.map(r=>r.rotation.y),memory:{...renderer.info.memory},drawCalls:renderer.info.render.calls,shipVisible:shipG.visible};});
  check(state.shipVisible&&state.projected.every(Number.isFinite)&&Math.abs(state.projected[0])<.1&&Math.abs(state.projected[1])<.1,`${name}: craft stays visible and centered`);
  report.frames.push({name,...state});await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('CAPTURE',name,state);
 };
 await frames(2);await capture('00-stopped-off');
 if(!mobile)check(await page.evaluate(()=>{
  const r=document.getElementById('shipVisualControls').getBoundingClientRect();
  return ['navBall','hudTR','timeDock'].every(id=>{const b=document.getElementById(id).getBoundingClientRect();return r.right<=b.left||r.left>=b.right||r.bottom<=b.top||r.top>=b.bottom;});
 }),'Desktop warp control clears attitude, objectives and time panels');

 check(await page.locator('[data-warp-visual]').first().getAttribute('aria-pressed')==='false','Warp is opt-in and defaults off');
 await page.evaluate(()=>{__qaSpeed=30;});await frames(5);await capture('01-accelerating-off');
 await page.evaluate(()=>{__qaSpeed=120;});await frames(10);await capture('02-cruise-off');
 const toggle=async()=>{if(mobile){await page.locator('#mMenuBtn').click();await page.locator('#mWarpVisual').click();await page.locator('#mMenuClose').click();}else await page.locator('[data-warp-visual]').first().click();};
 await toggle();await frames(5);await capture('03-cruise-on');
 check(report.frames.at(-1).warpVisible&&report.frames.at(-1).warpStrength>.8,'Local speculative river samples render while moving');
 for(let i=0;i<3;i++){await frames(2);await capture(`04-spin-${i}`);}
 check(report.frames.at(-1).angle!==report.frames.at(-2).angle,'Matched-time screenshots show ring angle changes');
 await page.evaluate(()=>{__qaMotionPause=true;});const frozen=await page.evaluate(async()=>JSON.stringify((await import('/src/shipVisuals.js')).shipVisuals.motion));await frames(3);await capture('05-paused');
 check(await page.evaluate(async frozen=>JSON.stringify((await import('/src/shipVisuals.js')).shipVisuals.motion)===frozen,frozen),'Pause freezes phase, rate and level');
 await page.evaluate(()=>{__qaMotionPause=false;__qaSpeed=8;});await frames(10);await capture('06-braking');
 await page.evaluate(()=>{__qaSpeed=0;});await frames(65);await capture('07-stopped-on');
 check(report.frames.at(-1).rate===0&&!report.frames.at(-1).warpVisible,'Stopping settles rings and local distortion to zero');
 await page.evaluate(()=>{__qaSpeed=120;});await frames(15);await toggle();await frames(1);await capture('08-warp-off-again');
 check(!report.frames.at(-1).warpVisible&&report.frames.at(-1).warpStrength===0,'Off immediately removes every speculative river contribution');
 // Snapshot fixed resources after both shaders have compiled; repeated toggles
 // must not rebuild meshes, buffers, materials or programs.
 const resources=await page.evaluate(async()=>{const {renderer}=await import('/src/scene.js');return{...renderer.info.memory,programs:renderer.info.programs.length};});
 for(let i=0;i<4;i++){await toggle();await frames(1);}
 check(await page.evaluate(async r=>{const {renderer}=await import('/src/scene.js');return JSON.stringify({...renderer.info.memory,programs:renderer.info.programs.length})===JSON.stringify(r);},resources),'Repeated on/off toggles keep geometry, textures and programs fixed');
 // Compare the one CPU display sample to the production river GLSL on GPU.
 // The test-only Vite export exposes the unchanged shader string.
 const parity=await page.evaluate(async()=> (await import('/scripts/ship-flow-parity-browser.js')).verifyShipFlowParity());
 report.flowParity=parity;check(parity.every(p=>Number.isFinite(p.error)&&p.error<1e-4),'CPU local display sample matches production river GLSL within 1e-4');
 // Paired full-app frame-cost samples (includes render and GPU completion).
 // This is an overhead guard on the CI renderer, not a consumer FPS promise.
 const timing=async enabled=>{
  await page.evaluate(async enabled=>{(await import('/src/shipVisuals.js')).shipVisuals.enabled=enabled;},enabled);
  const frames=[];
  // A complete 48-frame cycle covers the existing 4/6/8/12/16-frame work
  // cadences equally in each mode. Both shaders were warmed above.
  for(let i=0;i<48;i++)frames.push(await page.evaluate(()=>__motionFrame()));
  const samples=frames.map(f=>f.totalMs);
  return {frames,samples,mean:samples.reduce((a,b)=>a+b,0)/samples.length};
 };
 const timingOff=await timing(false),timingOn=await timing(true);
 report.performance={off:timingOff,on:timingOn};
 const performancePassed=timingOn.mean<=timingOff.mean*1.5+20;
 // Paired, real unpaused simulation replay from one quicksave. No presentation
 // input overrides; same advance/ephemerides/prediction code on both routes.
 await page.evaluate(async()=>{delete window.__qaSpeed;delete window.__qaMotionPause;__qaDt=1/60;__G.paused=true;__G.warp=1;await (await import('/src/saves.js')).saveState();});
 const replay=async(enabled)=>{
  await page.evaluate(()=>document.activeElement?.blur());
  await page.evaluate(async enabled=>{await(await import('/src/saves.js')).loadState();(await import('/src/shipVisuals.js')).shipVisuals.enabled=enabled;__G.warp=1;__G.paused=false;},enabled);
  const before=await page.evaluate(()=>__G.dvUsed);
  await page.keyboard.down('w');await frames(12);
  check(await page.evaluate(async before=>{const {flame,exhaust}=await import('/src/ship.js');return __G.dvUsed>before&&flame.visible&&exhaust.visible;},before),`Warp ${enabled?'on':'off'} replay actually applies W thrust and renders exhaust`);
  await page.keyboard.up('w');
  return page.evaluate(()=>Object.fromEntries(['t','tau','x','y','z','vx','vy','vz','heading','pitch','fuel','dvUsed','dead'].map(k=>[k,__G[k]])));
 };
 const off=await replay(false),on=await replay(true);report.physics={off,on};check(JSON.stringify(off)===JSON.stringify(on),'Real W-thrust physics is bit-identical with warp on/off');
 await page.evaluate(async()=>{__G.paused=true;(await import('/src/shipVisuals.js')).shipVisuals.enabled=false;});
 await toggle();await frames(1);
 await page.locator('[data-ui-mode="direct"]').click();await frames(2);
 check(await page.evaluate(async()=>getComputedStyle(document.getElementById('shipVisualControls')).display==='none'&&getComputedStyle(document.getElementById('warpVisualNote')).display==='none'&&!(await import('/src/river.js')).river.warpVisible),'Create mode hides the warp control, annotation and speculative field');
 await page.locator('[data-ui-mode="pilot"]').click();await frames(2);
 check(await page.locator(mobile?'#mWarpVisual':'#shipVisualControls button').getAttribute('aria-pressed')==='true','Returning to Pilot retains the explicit opt-in');
 check(performancePassed,'Speculative visual adds at most 50% + 20ms full-app frame cost on CI renderer');
 check(report.errors.length===0,'No JavaScript, shader or console errors');
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
