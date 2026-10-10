import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync,writeFileSync,existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const mobile=process.env.DEVICE==='mobile',out=process.env.ARTEMIS_EVIDENCE||'evidence/warp';mkdirSync(out,{recursive:true});
const report={device:mobile?'mobile':'desktop',checks:[],errors:[],frames:[]};
const check=(ok,name)=>{report.checks.push({name,pass:!!ok});assert(ok,name);};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'warp-qa',enforce:'pre',transform(s,id){
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 return s.replace('const firstFrameT0 = perfStart();','clock.getDelta=()=>window.__qaDt||1/60;const firstFrameT0 = perfStart();').replace('renderer.setAnimationLoop(frame);','')+
 '\nwindow.__warpFrame=()=>{lastMobileFrame=-Infinity;frame();renderer.getContext().finish();const r=window.__river;return {t:G.t,x:G.x,y:G.y,z:G.z,v:[G.vx,G.vy,G.vz],gr:G.gr,bubble:{...WARP},'+
 'river:{visible:r.visible,radius:r.radius,presence:r.warpPresence,presentation:r.bubblePresentation,bubbleRadius:r.bubbleRadius,bubbleSpeed:r.bubbleSpeed,displayRate:r.displayRate,respawn:r.respawn,warpLines:r.warpVisible},focus:G.focus,'+
 'cam:{dist:cam.dist,toShip:camera.position.distanceTo(shipG.position)},craft:{visible:craft.visible,scale:craft.scale.x},'+
 'layers:["Alcubierre expansion and exotic-energy guide","Illustrative transition pulse front"].map(n=>scene.getObjectByName(n)).filter(Boolean).length,'+
 'driveGuide:!!shipG.getObjectByName("Fictional curvature drive envelope")?.visible,memory:{...renderer.info.memory},programs:renderer.info.programs.length};};';
}}]});await server.listen();
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:mobile?{width:430,height:932}:{width:1280,height:820},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(240000);
 page.on('pageerror',e=>report.errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('ERR_'))report.errors.push(m.text());});
 await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','pilot');});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?quality=low&focus=ship&dist=6&hidehelp=1&compile=0&tier1=0&realsky=0&galaxies=0&galaxyvol=0`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__warpFrame);
 const frame=()=>page.evaluate(()=>__warpFrame());
 const frames=async n=>{let s;for(let i=0;i<n;i++)s=await frame();return s;};
 const capture=async name=>{const s=await frames(6);await page.screenshot({path:`${out}/${name}.png`});report.frames.push({name,...s});return s;};
 // Start with the field lines OFF: engaging warp must turn them on, because
 // the bubble is drawn only through them.
 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js'),{shipG}=await import('/src/ship.js');__G.warp=1;__G.heading=0;__G.pitch=0;__G.hold=null;__G.gr=false;__warpFrame();cam.tgt.copy(shipG.position);cam.dist=6;cam.yaw=.85;cam.pitch=.36;});
 let s=await frames(4);check(!s.gr,'fixture starts with field lines off');
 if(mobile){await page.locator('#mMenuBtn').click();check(!await page.locator('#renderQualityControls').isVisible(),'flight sheet hides overlapping graphics control');}
 const button=page.locator('[data-bubble-drive]:visible').first();check(await button.isVisible(),'warp control accessible');await button.click();
 if(mobile)await page.locator('#mMenuClose').click();await page.evaluate(()=>document.activeElement?.blur());
 s=await frames(6);check(s.bubble.enabled&&s.bubble.speed===0,'real UI enables ready state');check(s.gr,'engaging warp turns the shared field lines on');
 check(s.layers===0,'no separate warp sphere or pulse-ring objects exist');
 await page.keyboard.down('w');s=await frames(35);await page.keyboard.up('w');
 check(s.bubble.speed>0&&s.river.bubbleSpeed>0,'held input ramps and the shared river receives the bubble');
 check(!s.driveGuide&&!s.river.warpLines,'curvature-drive envelope and its legacy guide stay hidden in warp');
 const readout=await page.evaluate(()=>document.getElementById(innerWidth<=760?'mVelL':'cVelL')?.textContent);
 check(readout===(mobile?'WARP':'WARP · BUBBLE'),'speed readout names the flown mode');
 await capture('01-ramp');
 // Real controls only: X raises the drive throttle, held Shift+W ramps.
 // Frames advance 0.06 s each (main.js caps a frame at 0.06 s) to keep
 // the software-GPU run short; this is not a frame-rate measurement.
 for(let i=0;i<9;i++)await page.keyboard.press('x');
 await page.evaluate(()=>{window.__qaDt=.06;});await page.keyboard.down('Shift');await page.keyboard.down('w');s=await frames(90);
 await page.keyboard.up('w');await page.keyboard.up('Shift');await page.evaluate(()=>{window.__qaDt=1/60;});s=await frames(4);
 const cruise=[];for(let i=0;i<12;i++)cruise.push(await frame());
 s=cruise.at(-1);
 check(s.bubble.speed>299792.458,'superluminal coordinate travel');check(Math.hypot(...s.v)<299792.458,'bubble speed is separate from local velocity');
 check(s.river.visible&&s.river.presence>.95,'shared field lines remain visible at superluminal speed');
 check(cruise.every(f=>f.river.respawn<.2),'cruise keeps its particles (no per-frame full respawn)');
 check(cruise.every(f=>Math.abs(f.river.radius/(f.cam.toShip*.45*2.1)-1)<.2),'sampled volume follows the bubble reach around the hull');
 const near=await page.evaluate(async()=>(await import('/src/river.js')).riverDebugBubbleSamples());
 check(near.finite&&near.near>=near.total*.08&&near.ahead>0&&near.behind>0,'the particle budget resolves the bubble, ahead and behind');
 check(s.river.displayRate>0&&s.river.displayRate<1,'uniform slow-motion replay is active and bounded');
 check(cruise.every(f=>Math.abs(f.cam.toShip-f.cam.dist)<f.cam.dist*.05)&&s.craft.visible,'camera holds the visible hull during transport');
 const gpu=await page.evaluate(async()=>(await import('/src/river.js')).riverDebugReadPositions(4));check(gpu.finite&&gpu.distinct>8,'GPU particle state stays finite and populated');
 await capture('02-superluminal-cruise');
 const heading=s.bubble.dx;await page.keyboard.down('a');const turn=await frames(4);await page.keyboard.up('a');
 check(turn.bubble.dy>0&&Math.abs(turn.bubble.dx-heading)<.05,'turn bends the bubble axis gradually');
 // Focus another body mid-flight (real F key): its river keeps no bubble
 // term and R stays at its last size while the ship flies on.
 const anchoredR=(await frame()).river.bubbleRadius;
 await page.keyboard.press('f');const away=[];for(let i=0;i<20;i++)away.push(await frame());
 check(away.at(-1).focus==='moon','F moves focus off the ship');
 check(away.every(f=>f.river.bubbleSpeed===0),'a view focused elsewhere carries no bubble term');
 check(away.every(f=>Math.abs(f.river.bubbleRadius-anchoredR)<=anchoredR*1e-9),'bubble radius stays at its last anchored size');
 for(let i=0;i<3;i++)await page.keyboard.press('f');s=await frames(10);check(s.focus==='ship'&&s.river.bubbleSpeed>0,'returning focus to the ship restores the bubble term');
 // Real S braking to rest: presentation channel equals eased presence every frame.
 const before=await frame();await page.evaluate(()=>{window.__qaDt=.06;});await page.keyboard.down('s');
 const brake=[];for(let i=0;i<200&&!(brake.length&&brake.at(-1).bubble.speed===0&&brake.at(-1).river.presence<.02);i++)brake.push(await frame());
 await page.keyboard.up('s');await page.evaluate(()=>{window.__qaDt=1/60;});
 check(brake.some(f=>f.bubble.speed>0)&&brake.at(-1).bubble.speed<before.bubble.speed,'actual S input brakes');
 check(brake.some(f=>f.bubble.speed===0),'S braking reaches rest');
 check(brake.every(f=>f.river.presentation===f.river.presence),'presentation follows eased presence through the stop (no one-frame step)');
 await capture('03-braking');
 await page.keyboard.down('w');s=await frames(25);await page.keyboard.up('w');check(s.bubble.speed>0,'re-ramp after rest');
 await page.evaluate(()=>{__G.paused=true;});const paused=await frames(2);s=await frames(4);check(s.x===paused.x&&s.y===paused.y&&s.z===paused.z&&s.bubble.speed===paused.bubble.speed,'pause freezes transport and ramp');
 await page.evaluate(()=>{__G.paused=false;});
 if(mobile)await page.locator('#mMenuBtn').click();await page.locator('[data-bubble-stop]:visible').first().click();if(mobile)await page.locator('#mMenuClose').click();
 s=await frames(2);check(s.bubble.speed===0&&s.river.bubbleSpeed===0,'visible emergency control collapses the bubble term');
 // Presentation eases out over ~0.6 s time constants; ~5 s later it is exactly off.
 await page.evaluate(()=>{window.__qaDt=.06;});s=await frames(85);await page.evaluate(()=>{window.__qaDt=1/60;});
 check(s.river.presence===0&&s.river.bubbleSpeed===0,'river returns to its natural presentation after the stop');
 // Background streaming may allocate meanwhile; one of three windows must
 // show six warp toggles with no new geometry, texture or program at all.
 let clean=false;
 for(let attempt=0;attempt<3&&!clean;attempt++){
  const base=await frame();
  for(let i=0;i<6;i++){await page.evaluate(()=>document.querySelector('[data-bubble-drive]').click());await frames(2);}
  s=await frame();clean=JSON.stringify(s.memory)===JSON.stringify(base.memory)&&s.programs===base.programs;
  if(!clean)report.frames.push({name:'toggle-window-drift',attempt,before:base.memory,after:s.memory,programs:[base.programs,s.programs]});
 }
 check(clean,'repeated toggle does not allocate render resources');
 await page.evaluate(()=>{if(document.querySelector('[data-bubble-drive]').getAttribute('aria-pressed')!=='true')document.querySelector('[data-bubble-drive]').click();});
 await page.keyboard.down('w');s=await frames(20);await page.keyboard.up('w');check(s.bubble.enabled&&s.bubble.speed>0,'ramp before reverse');
 await page.evaluate(()=>{__G.warp=-1;});s=await frames(2);check(s.bubble.speed===0,'reverse time disconnects bubble');
 await page.evaluate(async()=>{__G.warp=1;const {saveState,loadState}=await import('/src/saves.js');saveState();await loadState();});s=await frame();check(!s.bubble.enabled&&s.bubble.speed===0,'save load resumes without stale warp command');
 await capture('04-local-flight');
 // Far from home: ten light-years out, superluminal, with rebased river.
 // Fixture position only; the ramp itself is real input.
 await page.evaluate(()=>{__G.x=9.46e13;__G.y=1e12;__G.z=3e11;__G.vx=__G.vy=__G.vz=0;__G.focus='ship';document.querySelector('[data-bubble-drive]').click();window.__qaDt=.06;});
 await page.keyboard.down('Shift');await page.keyboard.down('w');s=await frames(90);await page.keyboard.up('w');await page.keyboard.up('Shift');
 await page.evaluate(()=>{window.__qaDt=1/60;});s=await frames(6);check(s.bubble.speed>299792.458,'far fixture ramps past c with real input');const far=await page.evaluate(async()=>(await import('/src/river.js')).riverDebugReadPositions(4));
 check(Number.isFinite(s.x)&&s.river.visible&&far.finite&&far.distinct>8,'far superluminal flight keeps finite, visible field lines');
 await capture('05-far-superluminal');
 // Every warp speed label fits its real HUD cell, unit included.
 const widths=mobile?[[430,932],[360,740]]:[[1280,820]];
 for(const [w,h] of widths){await page.setViewportSize({width:w,height:h});await frames(2);
  const fit=await page.evaluate(async id=>{const {warpSpeedLabel}=await import('/src/warpBubble.js');const el=document.getElementById(id);const prev=el.textContent,bad=[];
   for(let e=-2;e<=14.48;e+=.05){el.textContent=warpSpeedLabel(10**e);if(el.scrollWidth>el.clientWidth)bad.push(el.textContent);}el.textContent=prev;return bad;},mobile?'mVel':'cVel');
  check(fit.length===0,`speed labels fit at ${w}px: ${fit.slice(0,3).join(' | ')}`);}
 check(report.errors.length===0,'no browser or shader errors');
}finally{writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
