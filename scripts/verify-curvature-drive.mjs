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
 .replace('renderer.setAnimationLoop(frame);','')+'\nwindow.__driveFrame=()=>{lastMobileFrame=-Infinity;frame();};';
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
 await page.keyboard.down('e');await frames(45);s=await capture('04-lateral-field');check(s.drive.ay>.0017&&s.visual.dz<-.99,'lateral command redirects actual field');await page.keyboard.up('e');
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
 await page.keyboard.up('w');await page.evaluate(()=>{__G.warp=1;});await frames(1);
 const save=await page.evaluate(async()=>{const {saveState,loadState}=await import('/src/saves.js');const {DRIVE,stepDrive}=await import('/src/curvatureDrive.js');saveState();const saved=JSON.parse(localStorage.getItem('artemis.quicksave.v1'));stepDrive(DRIVE,.006,0,0,.1);await loadState();return{version:saved.v,zero:DRIVE.magnitude===0,throttle:__G.throttle===saved.g.throttle};});check(save.version===11&&save.zero&&save.throttle,'legacy-format quicksave keeps budget/settings and clears held drive');
 // Keep the independent GPU parity check from the pre-drive river fixture.
 const parity=await page.evaluate(async()=> (await import('/scripts/ship-flow-parity-browser.js')).verifyShipFlowParity());
 report.flowParity=parity;check(parity.every(p=>Number.isFinite(p.error)&&p.error<1e-4),'local display sample matches production river GLSL');
 // Planetary overview: Earth and the ship are practically co-located.
 await page.evaluate(async()=>{__G.paused=true;__G.gr=true;const {cam}=await import('/src/scene.js');cam.dist=20000;__G.focus='sun';});await frames(24);
 s=await state();const markerPx=await page.evaluate(async()=>{const {dot}=await import('/src/ship.js'),{camera,viewportSize}=await import('/src/scene.js');return dot.scale.x*viewportSize.h/(2*Math.tan(camera.fov*Math.PI/360));});
 check(Math.abs(markerPx-6)<1e-6&&!s.hullVisible,'system overview uses bounded 6px marker instead of a luminous hull');
 if(!mobile)check(await page.evaluate(()=>+getComputedStyle(document.getElementById('lblE')).opacity>0),'Earth label survives co-located ship marker');
 await page.screenshot({path:`${out}/07-system-overview.png`,animations:'disabled'});report.frames.push({name:'07-system-overview',...s,markerPx});
 // Resource observations and readable labels are independent of screen size.
 check(await page.evaluate(()=>document.querySelector('[data-warp-note]').textContent.includes('FICTIONAL')),'scientific scope remains explicit');
 if(!mobile)await verifyShipHudLayout(page,{check,out,frames,report});
 check(report.errors.length===0,'no page or shader errors');
 console.log('Curvature full-app PASS',report.checks.length,'checks',out);
} finally {await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
