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
 'river:{visible:r.visible,radius:r.radius,presence:r.warpPresence,presentation:r.bubblePresentation,view:r.warpView,chart:shipVisuals.bubble.chart,bubbleRadius:r.bubbleRadius,bubbleSpeed:r.bubbleSpeed,displayRate:r.displayRate,respawn:r.respawn,warpLines:r.warpVisible},focus:G.focus,'+
 'cam:{dist:cam.dist,toShip:camera.position.distanceTo(shipG.position)},bubbleR:shipVisuals.bubble.radius,craft:{visible:craft.visible,scale:craft.scale.x,hullAlpha:shipPresentation(camera.position.distanceTo(shipG.position),craft.scale.x,camera.fov,viewportSize.h).hullAlpha,markerAlpha:shipPresentation(camera.position.distanceTo(shipG.position),craft.scale.x,camera.fov,viewportSize.h).markerAlpha},'+
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
 // Focus switch near home (real keys): ramp to ~300 c, where the camera
 // still glides between bodies, focus the Moon with F, then return.
 for(let i=0;i<9;i++)await page.keyboard.press('x');
 await page.evaluate(()=>{window.__qaDt=.06;});await page.keyboard.down('Shift');await page.keyboard.down('w');
 for(let i=0;i<120&&s.bubble.speed<299792.458*300;i++)s=await frame();
 await page.keyboard.up('w');await page.keyboard.up('Shift');await page.evaluate(()=>{window.__qaDt=1/60;});s=await frames(20);
 check(s.bubble.speed>299792.458*100,'real input reaches the focus-test cruise');
 const anchoredR=s.bubbleR;
 await page.keyboard.press('f');const away=[];for(let i=0;i<90;i++)away.push(await frame());
 check(away.at(-1).focus==='moon','F moves focus off the ship');
 check(away.every(f=>f.river.bubbleSpeed===0),'a view focused elsewhere carries no bubble term');
 check(away.every(f=>Math.abs(f.bubbleR-anchoredR)<=anchoredR*1e-9),'bubble radius stays at its last anchored size');
 for(let i=0;i<3;i++)await page.keyboard.press('f');
 // While the camera glides back, R and the sampled volume stay at the
 // anchored scale (they read the orbit distance), so the field returns at once.
 const back=[];for(let i=0;i<150;i++)back.push(await frame());
 s=back.at(-1);check(s.focus==='ship'&&s.river.bubbleSpeed>0,'returning focus to the ship restores the bubble term');
 check(back.some(f=>Math.abs(f.cam.toShip-f.cam.dist)>f.cam.dist*.5),'the return really glides (camera away from the hull at first)');
 report.focusReturn=back.filter((f,i)=>i<20||i%10===0).map((f,i)=>({R:+f.bubbleR.toPrecision(4),camDist:+f.cam.dist.toPrecision(4),toShip:+f.cam.toShip.toPrecision(4),river:+f.river.radius.toPrecision(4),focus:f.focus}));
 report.focusAway=away.filter((f,i)=>i%15===0).map(f=>({R:+f.bubbleR.toPrecision(4),camDist:+f.cam.dist.toPrecision(4),toShip:+f.cam.toShip.toPrecision(4),focus:f.focus}));
 // R eases from its frozen size to the new zoom target; it must never inflate
 // with the gliding camera's distance to the hull.
 check(back.every(f=>f.bubbleR<=2*Math.max(.45*f.cam.dist,anchoredR)&&f.bubbleR>=.5*Math.min(.45*f.cam.dist,anchoredR)),'bubble radius never inflates while the camera glides back');
 const arrived=back.findIndex(f=>Math.abs(f.cam.toShip-f.cam.dist)<f.cam.dist*.05);
 check(arrived>=0&&back.slice(Math.min(back.length-1,arrived+30)).every(f=>Math.abs(f.river.radius/(f.bubbleR*2.1)-1)<.5&&f.bubbleR<=2*.45*f.cam.dist&&f.bubbleR>=.5*.45*f.cam.dist),'R and river volume settle within 0.5 s of the camera arriving');
 await page.evaluate(()=>document.querySelector('[data-bubble-stop]:not([disabled])')?.click());s=await frames(4);
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
 check(cruise.every(f=>Math.abs(f.river.radius/(f.cam.toShip*Math.max(.45*2.1,1.15))-1)<.2),'sampled volume follows the bubble reach around the hull (camera inside)');
 const near=await page.evaluate(async()=>(await import('/src/river.js')).riverDebugBubbleSamples());
 check(near.finite&&near.near>=near.total*.08&&near.ahead>0&&near.behind>0,'the particle budget resolves the bubble, ahead and behind');
 check(s.river.displayRate>0&&s.river.displayRate<1,'uniform slow-motion replay is active and bounded');
 check(cruise.every(f=>Math.abs(f.cam.toShip-f.cam.dist)<f.cam.dist*.05)&&s.craft.visible,'camera holds the visible hull during transport');
 const gpu=await page.evaluate(async()=>(await import('/src/river.js')).riverDebugReadPositions(4));check(gpu.finite&&gpu.distinct>8,'GPU particle state stays finite and populated');
 check(cruise.every(f=>f.river.chart===1&&f.river.presentation===f.river.view&&f.river.view===f.river.presence*f.river.chart),'close view draws the ship chart at full presentation');
 // Marker transport (GPU state, two computes apart): markers stream back
 // along the axis, slow through the front wall and nearly rest at the hull.
 const pos=async()=>page.evaluate(async()=>{const g=(await import('/src/river.js')).riverDebugBubbleSamples(true);return {p:g.positions,axis:g.axis.slice(0,3),R:g.bubbleRadius};});
 const a0=await pos();await frames(2);const a1=await pos();
 const ax=a0.axis,bins={far:[],wall:[],hull:[]};let streamBack=0,moved=0;
 for(let i=0;i<a0.p.length;i++){const p=a0.p[i],q=a1.p[i];if(!p||!q)continue;const d=[q[0]-p[0],q[1]-p[1],q[2]-p[2]],dl=Math.hypot(...d);if(dl>.4)continue;
  const r=Math.hypot(...p),along=(p[0]*ax[0]+p[1]*ax[1]+p[2]*ax[2]);if(dl>1e-6){moved++;if(d[0]*ax[0]+d[1]*ax[1]+d[2]*ax[2]<0)streamBack++;}
  if(along>0&&r>1.6&&r<2.05)bins.far.push(dl);else if(along>.5*r&&r>.6&&r<1.1)bins.wall.push(dl);else if(r<.35)bins.hull.push(dl);}
 const med=a=>{const b=[...a].sort((x,y)=>x-y);return b[b.length>>1]||0;};
 report.markerTransport={far:med(bins.far),wall:med(bins.wall),hull:med(bins.hull),counts:[bins.far.length,bins.wall.length,bins.hull.length],backFraction:streamBack/Math.max(1,moved)};
 check(bins.far.length>5&&bins.wall.length>5&&bins.hull.length>2,'marker bins are populated');
 check(streamBack/Math.max(1,moved)>.9,'markers stream back past the hull (ship chart)');
 check(med(bins.wall)<.8*med(bins.far)&&med(bins.hull)<.35*med(bins.far),'markers slow through the front wall and nearly rest at the hull');
 await capture('02-superluminal-cruise');
 // Real wheel zoom to a system view and back: bounded hull and marker far
 // out, rest chart for the river, the readable hull again close in.
 const startDist=s.cam.dist;
 // Wheel over the canvas itself (mobile overlays cover parts of it).
 const [wx,wy]=await page.evaluate(()=>{for(const [fx,fy] of [[.5,.3],[.5,.45],[.3,.35],[.7,.35],[.5,.6]]){const x=innerWidth*fx,y=innerHeight*fy;if(document.elementFromPoint(x,y)?.tagName==='CANVAS')return [x,y];}return [innerWidth/2,innerHeight/3];});
 // Parked at an intermediate zoom the drawn stream stays within its designed
 // speed (0.3-1.2 R/s times the chart weight) at 60 and at 30 fps.
 await page.mouse.move(wx,wy);let steps=0;for(;steps<30;steps++){await page.mouse.wheel(0,250);s=await frame();if(s.river.chart<.7)break;}
 s=await frames(60);
 const streamSpeed=async dt=>{await page.evaluate(dt=>{window.__qaDt=dt;},dt);await frames(4);const p0=await pos();await frames(6);const p1=await pos();
  // positions are in bubble radii at each readback; compare in scene units over the first R
  const d=[];for(let i=0;i<p0.p.length;i++){const a=p0.p[i],b=p1.p[i];if(!a||!b||Math.hypot(...a)<1.6)continue;const k=p1.R/p0.R,dl=Math.hypot(b[0]*k-a[0],b[1]*k-a[1],b[2]*k-a[2]);if(dl<.6)d.push(dl);}
  d.sort((x,y)=>x-y);await page.evaluate(()=>{window.__qaDt=1/60;});return {speed:(d[d.length>>1]||0)/(6*dt),n:d.length};};
 const s60=await streamSpeed(1/60),s30=await streamSpeed(1/30);report.parkedStream={camDist:s.cam.dist,chart:s.river.chart,s60,s30};
 check(s.river.chart>.05&&s.river.chart<.95,'parked zoom is between the two charts');
 check(s60.n>5&&s30.n>5&&s60.speed<=1.3&&s30.speed<=1.3&&Math.abs(s60.speed/s30.speed-1)<.25,'between charts the stream stays in its designed range at 60 and 30 fps');
 const outFrames=[];for(let i=steps+1;i<40;i++){await page.mouse.wheel(0,250);outFrames.push(await frame());}
 check(outFrames.every(f=>!(f.river.presence>0)||f.river.radius>=f.cam.toShip),'the camera stays inside the sampled volume on every zoom-out frame');
 s=await frames(20);
 { // after the chart drops, samples spread over the grown volume (no cluster at the hull)
  const g=await page.evaluate(async()=>{const g=(await import('/src/river.js')).riverDebugBubbleSamples(true);return {p:g.positions,R:g.bubbleRadius,radius:g.radius,ambient:g.ambient};});
  const inside=g.p.filter(q=>q&&Math.hypot(...q)<30).length,expected=g.ambient*Math.pow(30*g.R/g.radius,3);
  report.zoomDensity={inside,expected,ambient:g.ambient};
  check(inside<=Math.max(2*expected,3),'zoomed out, sample density near the hull stays near uniform');
 }
 report.zoomOut={cam:s.cam,craft:s.craft,chart:s.river.chart,view:s.river.view,speed:s.bubble.speed};
 check(s.cam.dist>1e4&&s.craft.scale<=2.4+1e-9&&s.craft.markerAlpha>.5,'zoomed out, the hull is bounded and hands over to the marker');
 check(s.river.chart<.05&&s.river.view<.05,'zoomed out, the river returns to the rest chart');
 await capture('02b-system-view');
 for(let i=0;i<40;i++){await page.mouse.wheel(0,-250);await frame();}
 s=await frames(30);report.zoomIn={cam:s.cam,craft:s.craft,chart:s.river.chart,view:s.river.view,presence:s.river.presence};
 check(Math.abs(s.cam.dist/startDist-1)<.05&&s.river.chart>.99&&s.craft.hullAlpha>.99,'zooming back in restores the ship chart and the readable hull');
 const heading=s.bubble.dx;await page.keyboard.down('a');const turn=await frames(4);await page.keyboard.up('a');
 check(turn.bubble.dy>0&&Math.abs(turn.bubble.dx-heading)<.05,'turn bends the bubble axis gradually');
 // Real S braking to rest: presentation channel equals eased presence every frame.
 const before=await frame();await page.evaluate(()=>{window.__qaDt=.06;});await page.keyboard.down('s');
 const brake=[];for(let i=0;i<200&&!(brake.length&&brake.at(-1).bubble.speed===0&&brake.at(-1).river.presence<.02);i++)brake.push(await frame());
 await page.keyboard.up('s');await page.evaluate(()=>{window.__qaDt=1/60;});
 check(brake.some(f=>f.bubble.speed>0)&&brake.at(-1).bubble.speed<before.bubble.speed,'actual S input brakes');
 check(brake.some(f=>f.bubble.speed===0),'S braking reaches rest');
 check(brake.every(f=>f.river.presentation===f.river.view&&f.river.view===f.river.presence*f.river.chart),'presentation follows eased presence through the stop (no one-frame step)');
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
