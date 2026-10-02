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
const report={synchronization:'Reused typed-array readPixels from the production canvas; finishMs is flush overhead only.',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mobile,fixture:'Paused world; prescribed HUD speed and real elapsed time drive the unchanged production presentation functions. Full-app physics equivalence tested separately.',errors:[],checks:[],frames:[]};
const check=(pass,name)=>{report.checks.push({name,pass:!!pass});assert(pass,name);};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'ship-motion-qa',enforce:'pre',transform(source,id){
 if(id.split('?')[0].endsWith('/src/river.js'))return source.replace('const FLOW_GLSL =','export const FLOW_GLSL =');
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 const marker='const firstFrameT0 = perfStart();';assert.equal(source.split(marker).length,2);
 return source.replace(marker,'G.t=0;G.paused=true;resetEphem();clock.getDelta=()=>window.__qaDt??.2;'+marker)
 .replace('G.dead || G.landed ? 0 : shipSpeed, rawDtR, G.paused,','window.__qaSpeed ?? (G.dead || G.landed ? 0 : shipSpeed), rawDtR, window.__qaMotionPause ?? G.paused,')
 .replace('renderer.setAnimationLoop(frame);','')+'\nconst motionReadbackPixel=new Uint8Array(4);\nwindow.__motionFrame=()=>{lastMobileFrame=-Infinity;const start=performance.now();frame();const submitted=performance.now();const gl=renderer.getContext();gl.finish();const flushed=performance.now();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,motionReadbackPixel);const finished=performance.now();return{submissionMs:submitted-start,finishMs:flushed-submitted,readbackMs:finished-flushed,totalMs:finished-start,frameNo};};';
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
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const ui=await page.evaluate(mobile=>{
   const selectors=mobile?['#mYawL','#mYawR','#mRcsL','#mRcsR','#mBoost','#mThrottle']:['#shipVisualControls button'];
   return selectors.map(selector=>{
    const e=document.querySelector(selector),s=getComputedStyle(e),r=e.getBoundingClientRect();
    let opacity=1,ancestorVisible=true;const ancestors=[];
    for(let a=e;a;a=a.parentElement){const c=getComputedStyle(a);opacity*=Number(c.opacity);ancestorVisible&&=c.display!=='none'&&c.visibility==='visible';ancestors.push({tag:a.tagName,id:a.id,opacity:c.opacity,display:c.display,visibility:c.visibility});}
    const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return{selector,display:s.display,visibility:s.visibility,effectiveOpacity:opacity,ancestorVisible,hit:e===hit||e.contains(hit),inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,rect:{x:r.x,y:r.y,width:r.width,height:r.height},classes:e.className,ancestors};
   });
  },mobile);
  await page.screenshot({animations:'disabled',path:`${out}/${name}.png`,timeout:180000});
  const state=await page.evaluate(async()=>{const {shipVisuals}=await import('/src/shipVisuals.js');const {river}=await import('/src/river.js');const {craft,shipG}=await import('/src/ship.js');const {camera,renderer}=await import('/src/scene.js');return{speed:window.__qaSpeed ?? Math.hypot(__G.vx,__G.vy,__G.vz),...shipVisuals.motion,enabled:shipVisuals.enabled,warpVisible:river.warpVisible,warpStrength:river.warpStrength,warpVertices:river.warpVertexCount,projected:shipG.position.clone().project(camera).toArray(),rotors:craft.userData.rotors.map(r=>r.rotation.y),memory:{...renderer.info.memory},drawCalls:renderer.info.render.calls,shipVisible:shipG.visible};});
  check(state.shipVisible&&state.projected.every(Number.isFinite)&&Math.abs(state.projected[0])<.1&&Math.abs(state.projected[1])<.1,`${name}: craft stays visible and centered`);
  report.frames.push({name,ui,...state});await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  check(ui.every(e=>e.ancestorVisible&&e.effectiveOpacity>.4&&e.inside&&e.hit&&e.rect.width>0&&e.rect.height>0),`${name}: actual flight controls stay visible, inside viewport and center-hit-testable`);
  console.log('CAPTURE',name,state);
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
 if(mobile)check(await page.evaluate(()=>{
  const r=document.getElementById('warpVisualNote').getBoundingClientRect();
  return ['mLeft','mThrottle','mWarpCtl','mTopBar','mZoomCtl'].every(id=>{const b=document.getElementById(id).getBoundingClientRect();return r.right<=b.left||r.left>=b.right||r.bottom<=b.top||r.top>=b.bottom;});
 }),'Mobile speculative annotation clears every flight-control cluster');

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
 // Chromium finish() only flushes. The reused typed-array readPixels above
 // synchronously fences the real canvas after production rendering.
 // Paired full-app frame-cost samples include that completion wait.
 // This is an overhead guard on the CI renderer, not a consumer FPS promise.
 const timing=async enabled=>{
  await page.evaluate(async enabled=>{(await import('/src/shipVisuals.js')).shipVisuals.enabled=enabled;},enabled);
  const frames=[];
  // A complete 48-frame cycle covers the existing 4/6/8/12/16-frame work
  // cadences equally in each mode. Both shaders were warmed above.
  const gpuStatus=()=>page.evaluate(async()=>{const {renderer}=await import('/src/scene.js');const gl=renderer.getContext();return{contextLost:gl.isContextLost(),error:gl.getError(),canvas:renderer.getRenderTarget()===null};});
  const gpuBefore=await gpuStatus();
  for(let i=0;i<48;i++)frames.push(await page.evaluate(()=>new Promise((resolve,reject)=>setTimeout(()=>{try{resolve(__motionFrame());}catch(e){reject(e);}},0))));
  const gpuAfter=await gpuStatus();
  report.timingGpuStatus??=[];report.timingGpuStatus.push({enabled,gpuBefore,gpuAfter});
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  assert.deepEqual(gpuBefore,{contextLost:false,error:0,canvas:true},'Timing begins on live, error-free visible canvas');
  assert.deepEqual(gpuAfter,{contextLost:false,error:0,canvas:true},'Timing readback completes on live, error-free visible canvas');
  assert(frames.every((f,i)=>i===0||f.frameNo===frames[i-1].frameNo+1),'Every timing sample executes a real frame');
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
 // The explicit warp opt-in and retained CPU geometry must survive a real
 // WebGL loss/restore through the newly merged production recovery path.
 await page.evaluate(async()=>{
  const {renderer,cam}=await import('/src/scene.js');const {shipG,craft}=await import('/src/ship.js');const {scene}=await import('/src/scene.js');const {shipVisuals}=await import('/src/shipVisuals.js');
  (await import('/src/input.js')).setFocus('ship');cam.tgt.copy(shipG.position);cam.dist=.14;cam.distTarget=null;cam.yaw=.85;cam.pitch=.36;
  __G.paused=true;shipVisuals.enabled=true;
  window.__shipLoss=renderer.getContext().getExtension('WEBGL_lose_context');if(!__shipLoss)throw Error('WEBGL_lose_context required for ship recovery QA');
  window.__warpResourceIds=()=>{const ids=[];craft.traverse(o=>{if(o.isMesh)ids.push(o.id,o.geometry.id,o.material.id);});const layer=scene.getObjectByName('Speculative local river samples');ids.push(layer.id,layer.geometry.id,layer.material.id);return JSON.stringify(ids);};
  window.__warpFlightSnapshot=()=>JSON.stringify(['t','x','y','z','vx','vy','vz','fuel','dvUsed','paused'].map(k=>__G[k]));
 });
 await frames(2);await capture('09-warp-before-context-loss');
 const recoveryBefore=await page.evaluate(async()=>({ids:__warpResourceIds(),flight:__warpFlightSnapshot(),phase:(await import('/src/shipVisuals.js')).shipVisuals.motion.angle}));
 await page.evaluate(()=>__shipLoss.loseContext());
 await page.waitForFunction(async()=>(await import('/src/scene.js')).renderContext.isLost());await frames(2);
 check(await page.evaluate(before=>__warpFlightSnapshot()===before.flight,recoveryBefore),'GPU loss holds the paused flight with warp opt-in active');
 await page.evaluate(()=>__shipLoss.restoreContext());
 await page.waitForFunction(async()=>{const s=await import('/src/scene.js');return !s.renderContext.isLost()&&!s.renderer.getContext().isContextLost();});
 await frames(3);await capture('10-warp-after-context-restore');
 const recoveryAfter=await page.evaluate(async()=>{
  const {renderer,scene}=await import('/src/scene.js');const {craft,shipG}=await import('/src/ship.js');const {shipVisuals}=await import('/src/shipVisuals.js');const {river,riverDebugReadPositions}=await import('/src/river.js');
  const layer=scene.getObjectByName('Speculative local river samples');let finite=true;craft.traverse(o=>{if(o.isMesh)finite&&=o.geometry.attributes.position.array.every(Number.isFinite);});finite&&=layer.geometry.attributes.position.array.every(Number.isFinite)&&layer.material.uniforms.uWarpFlow.value.toArray().every(Number.isFinite);
  const positions=riverDebugReadPositions();return{ids:__warpResourceIds(),flight:__warpFlightSnapshot(),phase:shipVisuals.motion.angle,enabled:shipVisuals.enabled,visible:shipG.visible&&layer.visible&&river.warpVisible,finite,calls:renderer.info.render.calls,canvas:renderer.getRenderTarget()===null,riverFinite:positions?.finite&&positions.nonZero>0&&positions.distinct>0,statusHidden:document.getElementById('renderContextStatus').hidden};
 });
 report.recovery={before:recoveryBefore,after:recoveryAfter};
 check(recoveryAfter.ids===recoveryBefore.ids&&recoveryAfter.flight===recoveryBefore.flight&&recoveryAfter.phase===recoveryBefore.phase,'Recovery retains ship/local-layer resource identities, paused phase and exact physical flight state');
 check(recoveryAfter.enabled&&recoveryAfter.visible&&recoveryAfter.finite&&recoveryAfter.calls>0&&recoveryAfter.canvas&&recoveryAfter.riverFinite&&recoveryAfter.statusHidden,'Active warp layer and ordinary river render finite geometry on the recovered visible canvas');
 if(mobile){
  await page.setViewportSize({width:844,height:390});
  await page.evaluate(async()=>{const {cam}=await import('/src/scene.js');const {shipG}=await import('/src/ship.js');(await import('/src/input.js')).setFocus('ship');cam.tgt.copy(shipG.position);cam.dist=.14;cam.distTarget=null;cam.yaw=.85;cam.pitch=.36;});
  await frames(2);await capture('11-landscape-controls');
  check(await page.evaluate(()=>{
   const r=document.getElementById('warpVisualNote').getBoundingClientRect();
   return ['mLeft','mThrottle','mWarpCtl','mTopBar','mZoomCtl'].every(id=>{const b=document.getElementById(id).getBoundingClientRect();return r.right<=b.left||r.left>=b.right||r.bottom<=b.top||r.top>=b.bottom;});
  }),'Landscape mobile annotation clears every flight-control cluster');
 }
 check(performancePassed,'Speculative visual adds at most 50% + 20ms full-app frame cost on CI renderer');
 check(report.errors.length===0,'No JavaScript, shader or console errors');
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
