import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyShipHudLayout } from './verify-ship-hud-layout.mjs';
const mobile=process.env.DEVICE==='mobile';
const out=resolve(process.env.ARTEMIS_EVIDENCE||`evidence/curvature-${mobile?'mobile':'desktop'}`);
await mkdir(out,{recursive:true});
const report={revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mobile,fixture:'Full app at fixed 1/60 real frame cadence, live physics and production pilot commands. No overrides of drive or visual state.',checks:[],errors:[],frames:[]};
const check=(pass,name)=>{report.checks.push({pass:!!pass,name});assert(pass,name);};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'drive-qa',enforce:'pre',transform(source,id){
 if(id.split('?')[0].endsWith('/src/river.js'))return source.replace('const FLOW_GLSL =','export const FLOW_GLSL =');
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 return source.replace('const firstFrameT0 = perfStart();','clock.getDelta=()=>1/60;'+ 'const firstFrameT0 = perfStart();')
 .replace('renderer.setAnimationLoop(frame);','')+'\nconst driveReadbackPixel=new Uint8Array(4);window.__driveFrame=()=>{lastMobileFrame=-Infinity;const start=performance.now();frame();const submitted=performance.now();const gl=renderer.getContext();gl.finish();const flushed=performance.now();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,driveReadbackPixel);return{frameNo,submissionMs:submitted-start,finishMs:flushed-submitted,totalMs:performance.now()-start,warpVisible:river.warpVisible,warpStrength:river.warpStrength,fieldVisible:shipG.getObjectByName("Fictional curvature drive envelope")?.visible===true,driveLevel:DRIVE.level,quality:{...renderQuality},camera:camera.position.toArray(),target:cam.tgt.toArray(),computeEvery:river.computeEvery||1,skippedCompute:!!river.skippedCompute,riverDrawCount:river.drawCount||0,sourceCount:river.sourceCount||0,texW:river.texW||0};};';
}}]});
await server.listen();
const executablePath=process.env.PLAYWRIGHT_EXECUTABLE_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage({viewport:mobile?{width:430,height:932}:{width:1280,height:820},isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1});page.setDefaultTimeout(180000);
 await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','pilot');Date.now=()=>Date.UTC(2026,9,2,12);});
 page.on('pageerror',e=>report.errors.push(e.stack||e.message));
 page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('ERR_'))report.errors.push(m.text());});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=ship&dist=.14&hidehelp=1&compile=0&tier1=0&field=0&realsky=0&galaxies=0&galaxyvol=0`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__driveFrame);
 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js');const {shipG}=await import('/src/ship.js');__G.heading=0;__G.pitch=0;__G.hold=null;__G.warp=1;__G.paused=false;__driveFrame();cam.tgt.copy(shipG.position);cam.dist=.14;cam.yaw=.85;cam.pitch=.36;});
 const frames=async n=>{for(let i=0;i<n;i++)await page.evaluate(()=>__driveFrame());};
 const state=()=>page.evaluate(async()=>{
  const {DRIVE}=await import('/src/curvatureDrive.js'),{shipVisuals}=await import('/src/shipVisuals.js'),{craft,shipG,dot,flame,exhaust}=await import('/src/ship.js'),{camera,renderer}=await import('/src/scene.js'),{thrustGain}=await import('/src/audio.js');
  return {drive:{...DRIVE},visual:{...shipVisuals,motion:{...shipVisuals.motion}},shipVisible:shipG.visible,hullVisible:craft.visible,marker:{scale:dot.scale.x,opacity:dot.material.opacity},projected:shipG.position.clone().project(camera).toArray(),flame:flame.visible,exhaust:exhaust.visible,gain:thrustGain?.gain.value??0,t:__G.t,velocity:[__G.vx,__G.vy,__G.vz],memory:{...renderer.info.memory},programs:renderer.info.programs.length};
 });
 const capture=async name=>{await frames(2);await page.screenshot({path:`${out}/${name}.png`,animations:'disabled'});const s=await state();report.frames.push({name,...s});check(s.shipVisible&&Math.abs(s.projected[0])<.15&&Math.abs(s.projected[1])<.15,`${name}: hull visible and centred`);check(!s.flame&&!s.exhaust,`${name}: no combustion plume`);return s;};
 await frames(12);let s=await capture('00-ballistic-coast');check(s.drive.magnitude===0&&!s.visual.fieldVisible,'passive orbital speed does not engage drive');check(s.visual.enabled,'guide defaults on');
 // Real keyboard event, production input and physics update.
 await page.keyboard.down('w');await frames(45);s=await capture('01-forward-field');check(s.drive.ax>.0058&&s.visual.fieldVisible&&s.visual.dx>.99,'forward command supplies forward field and envelope');check(s.gain>0&&s.gain<.019,'quiet tonal feedback is bounded');
 const angle=s.visual.motion.angle;await frames(5);s=await capture('01b-field-motion');check(s.visual.motion.angle!==angle,'consecutive live frames animate the engaged field');
 const t=s.t,velocity=s.velocity;await frames(10);s=await state();check(s.t>t&&s.velocity.some((v,i)=>v!==velocity[i]),'live simulation advances while field accelerates');
 await page.keyboard.up('w');await frames(1);s=await capture('02-released-coast');check(s.drive.magnitude===0&&!s.visual.fieldVisible,'release immediately restores exact ballistic command');
 await page.keyboard.down('s');await frames(45);s=await capture('03-reverse-field');check(s.drive.ax<-.0058&&s.visual.dx<-.99,'reverse command reverses actual gradient and visible bow');await page.keyboard.up('s');
 await page.keyboard.down('e');await frames(45);s=await capture('04-lateral-field');check(s.drive.ay>.0017&&s.visual.dz<-.99,'lateral command redirects actual field');check(await page.evaluate(()=>getComputedStyle(document.getElementById('logPanel')).display==='none'),'lateral E does not open the expedition log');await page.keyboard.up('e');
 await page.keyboard.down('Shift');await page.keyboard.down('l');await page.keyboard.down('l');await page.keyboard.up('l');await page.keyboard.up('Shift');await frames(1);
 check(await page.evaluate(async()=>getComputedStyle(document.getElementById('logPanel')).display!=='none'&&(await import('/src/curvatureDrive.js')).DRIVE.magnitude===0),'held/repeated Shift+L opens the log once without lateral acceleration');
 await page.locator('#logClose').click();await page.evaluate(()=>document.activeElement?.blur());
 await page.keyboard.down('w');await frames(30);await page.evaluate(()=>{__G.gr=false;});s=await capture('05-river-off');check(s.visual.fieldVisible,'ship-local envelope works with natural river hidden');
 const toggle=async()=>{if(mobile){await page.locator('#mMenuBtn').click();await page.locator('#mWarpVisual').click();await page.locator('#mMenuClose').click();}else await page.locator('[data-warp-visual]').first().click();};
 // DOM click avoids menu key-capture changing the held-command fixture.
 await page.evaluate(()=>document.querySelector('[data-warp-visual]').click());await frames(6);s=await capture('06-guide-hidden');check(s.drive.magnitude>.0058&&!s.visual.fieldVisible,'hiding guide does not disable propulsion');
 await page.evaluate(()=>document.querySelector('[data-warp-visual]').click());await frames(6);s=await state();check(s.visual.fieldVisible,'guide restores without reload');
 const mem=s.memory,programs=s.programs;
 for(let i=0;i<6;i++){await page.evaluate(()=>document.querySelector('[data-warp-visual]').click());await frames(2);}
 s=await state();check(JSON.stringify(s.memory)===JSON.stringify(mem)&&s.programs===programs,'repeated guide toggles allocate no resources');
 await page.keyboard.press('m');await frames(90);s=await state();check(s.gain<1e-7,'mute silences field feedback');
 await page.evaluate(()=>{__G.paused=true;});await frames(2);s=await state();check(s.drive.magnitude===0,'pause disconnects acceleration');
 await page.evaluate(()=>{__G.paused=false;__G.warp=-1;});await frames(2);s=await state();check(s.drive.magnitude===0,'reverse time disconnects acceleration');
 await page.keyboard.up('w');await page.evaluate(()=>{__G.warp=1;__G.gr=true;});await frames(48);
 // Exercise visible controls through the actual UI after releasing inputs.
 await toggle();await frames(2);check(!(await state()).visual.enabled,'actual menu/control toggles the guide off');
 await toggle();await frames(2);check((await state()).visual.enabled,'actual menu/control restores the guide');
 await page.evaluate(()=>document.activeElement?.blur());
 const mobileLayout=async name=>{
  const layout=await page.evaluate(()=>{
   const read=id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();let opacity=1,visible=true;for(let a=e;a;a=a.parentElement){const s=getComputedStyle(a);opacity*=Number(s.opacity);visible&&=s.display!=='none'&&s.visibility==='visible';}const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{id,visible:visible&&opacity>.4,hit:hit===e||e.contains(hit),inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}};};
   return{controls:['mYawL','mYawR','mRcsL','mRcsR','mBoost','mThrottle'].map(read),note:read('warpVisualNote'),clusters:['mLeft','mThrottle','mWarpCtl','mTopBar','mZoomCtl'].map(read),desktopNote:document.getElementById('dWarpVisualNote').getClientRects().length};
  });
  const separate=(a,b)=>a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom;
  check(layout.controls.every(c=>c.visible&&c.hit&&c.inside),`${name}: actual mobile controls visible, inside and hit-testable`);
  check(layout.note.visible&&layout.note.inside&&!layout.desktopNote&&layout.clusters.every(c=>separate(c.rect,layout.note.rect)),`${name}: guide annotation clears all flight-control clusters`);
  report.mobileLayouts??=[];report.mobileLayouts.push({name,...layout});await page.screenshot({path:`${out}/${name}.png`,animations:'disabled'});
 };
 if(mobile)await mobileLayout('08-portrait-controls');
 const save=await page.evaluate(async()=>{const {saveState,loadState}=await import('/src/saves.js');const {DRIVE,stepDrive}=await import('/src/curvatureDrive.js');saveState();const saved=JSON.parse(localStorage.getItem('artemis.quicksave.v1'));stepDrive(DRIVE,.006,0,0,.1);await loadState();return{version:saved.v,zero:DRIVE.magnitude===0,throttle:__G.throttle===saved.g.throttle};});check(save.version===11&&save.zero&&save.throttle,'legacy-format quicksave keeps budget/settings and clears held drive');
 // Paired actual-input replay from exactly one saved physical state. Both
 // shaders are warm. Keep the existing 48-frame / 50% + 20ms cost guard.
 const replay=async enabled=>{
  // A paused public free-camera frame clears rigid-follow history, then a
  // second load restores the exact saved focus/camera/physics. Otherwise the
  // previous replay's camPrevTgt would add a stale camera-only displacement.
  await page.evaluate(async enabled=>{document.activeElement?.blur();await(await import('/src/saves.js')).loadState();__G.paused=true;__G.focus='free';__driveFrame();await(await import('/src/saves.js')).loadState();__G.paused=false;__G.warp=1;(await import('/src/shipVisuals.js')).shipVisuals.enabled=enabled;},enabled);
  await page.keyboard.down('w');await frames(48);const samples=[];
  for(let i=0;i<48;i++)samples.push(await page.evaluate(()=>new Promise((resolve,reject)=>setTimeout(()=>{try{resolve(__driveFrame());}catch(e){reject(e);}},0))));
  await page.keyboard.up('w');
  const end=await page.evaluate(async()=>{const {renderer}=await import('/src/scene.js'),gl=renderer.getContext();return{flight:Object.fromEntries(['t','x','y','z','vx','vy','vz','fuel','dvUsed','heading','pitch'].map(k=>[k,__G[k]])),gpu:{contextLost:gl.isContextLost(),error:gl.getError(),canvas:renderer.getRenderTarget()===null},memory:{...renderer.info.memory}};});
  check(samples.every((f,i)=>Number.isFinite(f.totalMs)&&(i===0||f.frameNo===samples[i-1].frameNo+1)),'every timing sample completes one production frame');
  check(!end.gpu.contextLost&&end.gpu.error===0&&end.gpu.canvas,'timing ends on live error-free visible canvas');
  check(samples.every(f=>f.driveLevel>.99&&f.fieldVisible===enabled&&f.warpVisible===enabled&&(!enabled||f.warpStrength>.99)),'every steady-field timing frame renders the intended envelope and production river guide state');
  return{samples,end,mean:samples.reduce((v,s)=>v+s.totalMs,0)/samples.length};
 };
 const guideOff=await replay(false),guideOn=await replay(true);
 report.performance={guideOff,guideOn,limit:'on <= off * 1.5 + 20 ms; whole-app completed GPU work, not device FPS'};
 check(JSON.stringify(guideOff.end.flight)===JSON.stringify(guideOn.end.flight),'hiding the field guide preserves bit-identical active flight');
 check(guideOn.samples.every((f,i)=>JSON.stringify(f.quality)===JSON.stringify(guideOff.samples[i].quality)),'paired timing keeps exact quality settings');
 check(guideOn.samples.every((f,i)=>f.camera.every((v,k)=>Math.abs(v-guideOff.samples[i].camera[k])<1e-9)&&f.target.every((v,k)=>Math.abs(v-guideOff.samples[i].target[k])<1e-9)),'paired timing keeps the same camera and target');
 const profile=f=>JSON.stringify([f.computeEvery,f.skippedCompute,f.riverDrawCount,f.sourceCount,f.texW]);
 report.performance.matchedWorkFrames=guideOn.samples.filter((f,i)=>profile(f)===profile(guideOff.samples[i])).length;
 report.performance.workloadConfounded=report.performance.matchedWorkFrames!==48;
 check(guideOn.mean<=guideOff.mean*1.5+20,'field guide retains the existing 50 percent + 20ms completed-frame overhead bound');
 await frames(1);
 // Keep the independent GPU parity check from the pre-drive river fixture.
 const parity=await page.evaluate(async()=> (await import('/scripts/ship-flow-parity-browser.js')).verifyShipFlowParity());
 report.flowParity=parity;check(parity.every(p=>Number.isFinite(p.error)&&p.error<1e-4),'local display sample matches production river GLSL');
 // The new field geometry must survive GPU recovery, then engage again from
 // fresh pilot input. Recovery deliberately releases the held controls.
 await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.down('w');await frames(48);
 const recovery=()=>page.evaluate(async()=>{const {renderer,scene}=await import('/src/scene.js'),{craft,shipG}=await import('/src/ship.js'),{shipVisuals}=await import('/src/shipVisuals.js'),{river,riverDebugReadPositions}=await import('/src/river.js');const field=shipG.getObjectByName('Fictional curvature drive envelope'),layer=scene.getObjectByName('Commanded curvature field river guide');const ids=[];craft.traverse(o=>{if(o.isMesh)ids.push(o.id,o.geometry.id,o.material.id);});for(const o of [field,layer])ids.push(o.id,o.geometry.id,o.material.id);const positions=riverDebugReadPositions();return{ids,flight:JSON.stringify(['t','x','y','z','vx','vy','vz','fuel','dvUsed','paused'].map(k=>__G[k])),field:field.visible,layer:layer.visible&&river.warpVisible,finite:[field,layer].every(o=>o.geometry.attributes.position.array.every(Number.isFinite)),riverFinite:positions?.finite&&positions.nonZero>0&&positions.distinct>0,canvas:renderer.getRenderTarget()===null,enabled:shipVisuals.enabled};});
 const beforeRecovery=await recovery();check(beforeRecovery.field&&beforeRecovery.layer,'both coupled field layers render before GPU loss');
 await page.evaluate(async()=>{const {renderer}=await import('/src/scene.js');window.__driveLoss=renderer.getContext().getExtension('WEBGL_lose_context');if(!__driveLoss)throw Error('GPU loss extension required');__driveLoss.loseContext();});
 await page.waitForFunction(async()=>(await import('/src/scene.js')).renderContext.isLost());await frames(2);
 check(await page.evaluate(before=>JSON.stringify(['t','x','y','z','vx','vy','vz','fuel','dvUsed','paused'].map(k=>__G[k]))===before,beforeRecovery.flight),'GPU loss holds exact physical flight');
 await page.keyboard.up('w');await page.evaluate(()=>__driveLoss.restoreContext());
 await page.waitForFunction(async()=>{const s=await import('/src/scene.js');return !s.renderContext.isLost()&&!s.renderer.getContext().isContextLost();});await frames(3);
 check((await state()).drive.magnitude===0,'GPU recovery leaves propulsion safely disengaged');
 await page.keyboard.down('w');await frames(48);const afterRecovery=await recovery();
 report.recovery={before:beforeRecovery,after:afterRecovery};
 check(JSON.stringify(beforeRecovery.ids)===JSON.stringify(afterRecovery.ids),'recovery preserves hull, envelope and river-guide resource identities');
 check(afterRecovery.field&&afterRecovery.layer&&afterRecovery.finite&&afterRecovery.riverFinite&&afterRecovery.canvas&&afterRecovery.enabled,'fresh command renders both recovered field layers and finite natural river');
 await capture('09-field-after-recovery');await page.keyboard.up('w');
 await page.locator('[data-ui-mode="direct"]').click();await frames(2);
 check(await page.evaluate(()=>['shipVisualControls','dWarpVisualNote','warpVisualNote'].every(id=>document.getElementById(id).getClientRects().length===0)),'Create hides field controls and annotations');
 await page.locator('[data-ui-mode="pilot"]').click();await frames(2);check((await state()).visual.enabled,'returning to Pilot keeps guide enabled');
 if(mobile){await page.setViewportSize({width:844,height:390});await frames(3);await mobileLayout('10-landscape-controls');await page.setViewportSize({width:430,height:932});await frames(3);}
 // Planetary overview: Earth and the ship are practically co-located.
 await page.evaluate(async()=>{__G.paused=true;__G.gr=true;const {cam}=await import('/src/scene.js');(await import('/src/input.js')).setFocus('sun');cam.dist=2500000;cam.distTarget=null;cam.yaw=.4;cam.pitch=1.2;});await frames(24);
 s=await state();const markerPx=await page.evaluate(async()=>{const {dot}=await import('/src/ship.js'),{camera,viewportSize}=await import('/src/scene.js');return dot.scale.x*viewportSize.h/(2*Math.tan(camera.fov*Math.PI/360));});
 await page.screenshot({path:`${out}/07-system-overview.png`,animations:'disabled'});report.frames.push({name:'07-system-overview',...s,markerPx});
 check(Math.abs(markerPx-6)<1e-6&&!s.hullVisible,'system overview uses bounded 6px marker instead of a luminous hull');
 if(!mobile)check(await page.evaluate(()=>+getComputedStyle(document.getElementById('lblE')).opacity>0),'Earth label survives co-located ship marker');
 // Resource observations and readable labels are independent of screen size.
 check(await page.evaluate(()=>document.querySelector('[data-warp-note]').textContent.includes('FICTIONAL')),'scientific scope remains explicit');
 if(!mobile)await verifyShipHudLayout(page,{check,out,frames,report});
 check(report.errors.length===0,'no page or shader errors');
 console.log('Curvature full-app PASS',report.checks.length,'checks',out);
} finally {await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
