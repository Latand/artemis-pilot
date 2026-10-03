import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const mobile=process.env.DEVICE==='mobile', out=resolve(process.env.ARTEMIS_EVIDENCE||`evidence/orbital-${mobile?'mobile':'desktop'}`);
await mkdir(out,{recursive:true});
const report={capturePolicy:'Steady desktop frames use 960×640 with unchanged production layers/particle budgets. Full-size key frame is captured separately. Deterministic frame sequences and real DOM control interactions are reported separately.',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mobile,checks:[],frames:[],errors:[]};
const check=(ok,name)=>{report.checks.push({name,pass:!!ok});assert(ok,name);};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'orbital-motion-qa',enforce:'pre',transform(source,id){
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 const marker='const firstFrameT0 = perfStart();';assert.equal(source.split(marker).length,2);
 return source.replace(marker,'G.t=0;G.paused=true;resetEphem();clock.getDelta=()=>window.__qaDt??1/60;'+marker).replace('renderer.setAnimationLoop(frame);','')+`\nwindow.__orbitalRenderOnly=()=>{renderFrame(false);renderer.getContext().finish();};const orbitalShaderPixel=new Uint8Array(4);window.__orbitalFrame=()=>{lastMobileFrame=-Infinity;const start=performance.now();frame();const cpuMs=performance.now()-start;const gl=renderer.getContext();gl.finish();const surfaceFixture=G.focus==='earth'&&cam.dist<100;if(surfaceFixture)gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,orbitalShaderPixel);return{ms:performance.now()-start,cpuMs,readbackSynchronized:surfaceFixture,frameNo,t:G.t,focus:G.focus,paused:G.paused,programs:renderer.info.programs.length,earthProgram:renderer.properties.get(earth.material).currentProgram?.id??null,cloudProgram:renderer.properties.get(clouds.material).currentProgram?.id??null,earthPrograms:[...renderer.properties.get(earth.material).programs?.values()||[]].map(p=>p.id).sort((a,b)=>a-b),cloudPrograms:[...renderer.properties.get(clouds.material).programs?.values()||[]].map(p=>p.id).sort((a,b)=>a-b),earthVariant:!!earth.material.defines?.SURFACE_ROTATION_EXPOSURE,cloudVariant:!!clouds.material.defines?.SURFACE_ROTATION_EXPOSURE};};`;
}}]});
await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:mobile?{width:430,height:932}:{width:960,height:640},isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1});page.setDefaultTimeout(180000);
 await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','observe');Date.now=()=>Date.UTC(2026,9,3,6);});
 page.on('pageerror',e=>{report.errors.push(e.stack||e.message);console.error('PAGE ERROR',e.stack||e.message);});page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=sun&hidehelp=1&compile=0&np=128`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__orbitalFrame);
 const frames=async(n)=>{for(let i=0;i<n;i++){const sample=await page.evaluate(()=>__orbitalFrame());if(sample.readbackSynchronized)(report.surfaceFrameTiming??=[]).push(sample);}};
 const setup=async(focus,dist,rate,settleFrames=2)=>{
  await page.evaluate(async({focus,dist,rate,mobile})=>{
   const {cam}=await import('/src/scene.js');const {setFocus}=await import('/src/input.js');
   setFocus(focus);cam.dist=dist;cam.distTarget=null;cam.yaw=3.54;cam.pitch=1.2;
   const time=await import('/src/timeCtl.js');time.setWarp(rate||1);time.setPaused(rate===0);__G.gr=false;__qaDt=mobile?1/30:1/60;
  },{focus,dist,rate,mobile});await frames(settleFrames);
 };
 const capture=async(name)=>{
  const info=await page.evaluate(async()=>{
   const {orbitalExposure}=await import('/src/render/orbitalExposure.js');const {visibleTrajectories:paths}=await import('/src/render/visibleTrajectories.js');const b=await import('/src/bodies.js');const {camera,renderer}=await import('/src/scene.js');const {K,PL}=await import('/src/constants.js');const e=__eph;
   const {lblE,lblM,lblS}=await import('/src/hud.js');const {viewportSize}=await import('/src/scene.js');
   const labelRows=[[lblE,b.earthG.position,-8],[lblM,b.moon.position,-8],[lblS,b.sunCore.position,-8],...b.plLabels.map((label,i)=>[label,b.plGroups[i].position,-8]),...b.moonLabels.map((label,i)=>[label,b.moonGroups[i].position,-7])];
   const labelChecks=labelRows.filter(([label])=>label.style.opacity==='1').map(([label,position,dy])=>{const p=position.clone().project(camera),x=Math.round((p.x*.5+.5)*viewportSize.w+10),y=Math.round((-p.y*.5+.5)*viewportSize.h+dy);const actual=label.style.transform.match(/translate\((-?\d+)px,\s*(-?\d+)px\)/);return{name:label.textContent,current:!!actual&&Number(actual[1])===x&&Number(actual[2])===y};});
   const hiddenLabelsImmediate=labelRows.filter(([label])=>label.style.opacity==='0').every(([label])=>Number(getComputedStyle(label).opacity)===0);
   const button=document.getElementById('motionPathsToggle'),buttonStyle=getComputedStyle(button);
   return {mode:__G.uiMode,hiddenLabelsImmediate,motionButton:{height:button.getBoundingClientRect().height,background:buttonStyle.backgroundColor},t:__G.t,rate:__G.warp,focus:__G.focus,focusTitle:document.getElementById('exploreObject').textContent,labelChecks,cloudDepth:{...b.clouds.material.userData.cloudDepthGuard,bias:b.clouds.material.polygonOffset,units:b.clouds.material.polygonOffsetUnits,factor:b.clouds.material.polygonOffsetFactor},surfaceActive:b.surfaceExposureState.active,surfaceTurns:{earth:b.earth.material.userData.surfaceRotationExposure?.turns.value,moon:b.moon.material.userData.surfaceRotationExposure?.turns.value},paths:{active:paths.active,faded:paths.faded,samples:paths.samples,ids:paths.ids,note:document.getElementById('motionPathsNote')?.textContent,layers:paths.layers.slice(0,paths.active).map(l=>({id:l.id,opacity:l.opacity,model:l.model,horizon:l.horizon,path:l.path.visible,arrow:l.arrow.visible,finite:l.positions.every(Number.isFinite)&&l.arrowPositions.every(Number.isFinite)}))},active:orbitalExposure.active,averaged:orbitalExposure.averaged,samples:orbitalExposure.samples,entries:orbitalExposure.entries.filter(e=>e.line.visible).map(e=>({key:e.key,blend:e.blend,averaged:e.averaged,finite:e.pos.every(Number.isFinite),width:e.line.material.linewidth})),earthMarker:{visible:b.earthG.visible&&b.earthBeacon.visible,opacity:b.earthBeacon.material.opacity,pixels:b.earthBeacon.scale.x* (await import('/src/scene.js')).viewportSize.pxScale/camera.position.distanceTo(b.earthG.position)},earthGuide:{visible:b.earthOrbitRing.visible,opacity:b.earthOrbitRing.material.opacity,centerError:b.earthOrbitRing.position.distanceTo(b.sunPos)},spinExact:b.plSurfaces.every((mesh,i)=>Math.abs(mesh.rotation.y-(PL[i].spin*__G.t)%(Math.PI*2))<1e-12),physicalPositionsExact:b.earthG.position.x===e.earthX*K&&b.moon.position.x===(e.earthX+e.moonX)*K&&b.plGroups.every((p,i)=>p.position.x===(e.earthX+e.plX[i])*K),noteVisible:document.getElementById('orbitalExposureNote')?.getClientRects().length>0,calls:renderer.info.render.calls,geometries:renderer.info.memory.geometries};
  });
  report.frames.push({name,...info});
  check(info.hiddenLabelsImmediate,`${name}: hidden local labels have no lingering opacity transition`);
  check(info.mode!=='observe'||(info.motionButton.height>=(mobile?44:32)&&info.motionButton.background!=='rgb(255, 255, 255)'),`${name}: motion toggle uses accessible Time Dock styling`);
  for(const e of info.entries){const id=typeof e.key==='number'?`planet:${e.key}`:e.key,layer=info.paths.layers.find(l=>l.id===id);check(!layer||layer.opacity<=1-e.blend+1e-6,`${name}: unresolved ${id} has no sharp strobing guide`);}
  check(info.paths.active<=10&&info.paths.samples<=330&&info.paths.layers.every(l=>l.finite&&(l.model!=="linear"||l.horizon<=60)),`${name}: bounded visible motion previews and honest linear horizon`);
  check(info.labelChecks.every(l=>l.current),`${name}: every visible near-body label matches this frame`);
  check(info.spinExact,`${name}: planet spin angles are current on every frame`);
  check(info.physicalPositionsExact,`${name}: all physical render positions remain exact`);
  check(info.entries.every(e=>e.finite)&&info.samples<=31*65,`${name}: finite bounded exposure buffers`);
  await page.screenshot({path:`${out}/${name}.png`,timeout:180000});
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('CAPTURE',name,info.active,info.averaged);
  return info;
 };
 const day=86400;
 await setup('sun',750000,0);const paused=await capture('00-paused-earth-orbit');
 check(paused.paths.active>0,'Paused Explore defaults to visible motion paths');
 // Real DOM interaction phase: no direct state assignments for these controls.
 const openedTimeSettings=!(await page.locator('#tdSpeed').isVisible());
 if(openedTimeSettings)await page.locator('#tdMore').click();
 await page.locator('#tdSpeed').selectOption(String(day));
 for(let i=0;i<8;i++)await page.locator('#tdStepUp').click();
 check(await page.evaluate(()=>__G.warp)===256*day,'Real day/s selection and Faster buttons reach 256 days/s');
 await page.locator('#tdPause').click();check(await page.evaluate(()=>!__G.paused),'Real Play control resumes');
 await frames(1);await page.locator('#tdRev').click();check(await page.evaluate(()=>__G.warp)===-256*day,'Real Reverse control changes direction');
 await page.locator('#tdPause').click();check(await page.evaluate(()=>__G.paused),'Real Pause control freezes playback');
 if(openedTimeSettings)await page.locator('#tdMore').click();
 await frames(1);await capture('00-real-controls-paused');
 report.interactions={speedSelection:true,play:true,reverse:true,pause:true,driver:'Real DOM events; rendered with the controlled frame clock.'};

 const shipPrediction=await page.evaluate(()=>__G.predict);
 await page.locator('#motionPathsToggle').click();await frames(1);
 check(await page.evaluate(async()=> (await import('/src/render/visibleTrajectories.js')).visibleTrajectories.active)===0&&await page.evaluate(()=>__G.predict)===shipPrediction,'Motion paths toggle leaves ship prediction unchanged');
 await page.locator('#motionPathsToggle').click();await frames(1);
 check(paused.earthMarker.visible&&paused.earthMarker.opacity>.8&&paused.earthMarker.pixels>=9,'Earth marker remains visible at Solar System scale');
 check(paused.earthGuide.visible&&paused.earthGuide.opacity>.45&&paused.earthGuide.centerError===0,'Earth orbit restored at Solar System scale');
 for(const [label,rate] of [['real',1],['day',day],['16-days',16*day]]){await setup('sun',750000,rate);await frames(3);await capture(`01-${label}`);}
 await setup('sun',750000,256*day);
 for(let i=0;i<8;i++){await frames(1);await capture(`02-256-days-${i}`);}
 check(report.frames.at(-1).active>0,'256 days/s activates continuous exposure');
 await setup('sun',750000,-256*day);for(let i=0;i<4;i++){await frames(1);await capture(`03-reverse-${i}`);}
 await page.evaluate(()=>{__G.paused=true;});await frames(1);const still=await capture('04-paused-again');await frames(2);
 const labelState=await page.evaluate(async()=>{
  const {hideLabel}=await import('/src/scene.js');const {plLabels}=await import('/src/bodies.js');
  const {applyOrbitalExposureMarkers}=await import('/src/render/orbitalExposure.js');
  const label=plLabels[0];hideLabel(label);
  const marker={material:{opacity:.5}};
  applyOrbitalExposureMarkers(marker,{earth:null,moon:null,planets:plLabels,moons:[]});
  return{hidden:label.style.opacity==='0',filter:label.style.filter,moonOpacity:marker.material.opacity};
 });
 check(labelState.hidden&&labelState.filter===''&&labelState.moonOpacity===.5,'Exposure preserves hidden label cache and restores the Moon beacon base on pause');
 check(still.active===0&&!still.noteVisible&&await page.evaluate(()=>__G.t)===still.t,'Pause clears approximate trails immediately and freezes exact time');
 await setup('earth',1500,256*day);for(let i=0;i<4;i++){await frames(1);await capture(`05-earth-moon-${i}`);}
 await setup(3,6500,256*day);for(let i=0;i<4;i++){await frames(1);await capture(`06-jupiter-moons-${i}`);}
 check(report.frames.at(-1).averaged>0,'Fast planetary moons become continuous orbit bands');
 await setup('moon',14,256*day,1);const firstMoon=await capture('07-transition-moon-first-frame');check(firstMoon.focusTitle.toLowerCase()==='moon','Moon selection updates HUD on the first real frame');for(let i=0;i<4;i++){await frames(1);await capture(`07-focused-moon-${i}`);}
 check(!report.frames.at(-1).entries.some(e=>e.key==='moon'),'Focused resolved Moon remains exact and legible');
 await setup('earth',60,256*day,1);const firstEarth=await capture('08-transition-earth-first-frame');check(firstEarth.focusTitle.toLowerCase()==='earth','Earth selection updates HUD on the first real frame');for(let i=0;i<4;i++){await frames(1);await capture(`08-focused-earth-${i}`);}
 check(!report.frames.at(-1).entries.some(e=>e.key==='earth'),'Focused resolved Earth remains exact and legible');
 check(report.frames.at(-1).surfaceActive>0&&report.frames.at(-1).surfaceTurns.earth===1,'256 days/s resolves Earth rotation as phase-independent longitude exposure');
 // Frozen layered ablation: retain exact epoch, camera, shader exposure and
 // production compositor; only the cloud shell visibility changes.
 const cloudFixture=await page.evaluate(async()=>{const b=await import('/src/bodies.js');const s=await import('/src/scene.js');const prep=(await import('/src/render/surfaceRotationExposure.js')).surfaceExposurePreparation;return{t:__G.t,cloudVisible:b.clouds.visible,near:s.camera.near,depthBits:s.renderer.getContext().getParameter(s.renderer.getContext().DEPTH_BITS),distance:s.camera.position.distanceTo(b.earthG.position),cloudTriangles:b.clouds.geometry.index.count/3,groundTriangles:b.earth.geometry.index.count/3,cloudRadius:b.clouds.geometry.parameters.radius,groundRadius:b.earth.geometry.parameters.radius,preparation:{...prep}};});
 report.earthCloudFixture=cloudFixture;
 check(cloudFixture.cloudVisible,'Frozen Earth ablation includes the loaded cloud layer');
 check(cloudFixture.cloudTriangles===(mobile?12096:13632),'Only the compact cloud shell receives containment-safe tessellation');
 check(cloudFixture.groundTriangles===(mobile?2976:13632)&&Math.abs(cloudFixture.cloudRadius-cloudFixture.groundRadius-.006)<1e-9,'Ground tessellation and physical six-kilometre cloud altitude are unchanged');
 await page.evaluate(async()=>{(await import('/src/bodies.js')).clouds.visible=false;__orbitalRenderOnly();});await capture('08-earth-cloud-layer-off');
 await page.evaluate(async visible=>{(await import('/src/bodies.js')).clouds.visible=visible;__orbitalRenderOnly();},cloudFixture.cloudVisible);await capture('08-earth-cloud-layer-restored');
 check(await page.evaluate(()=>__G.t)===cloudFixture.t,'Cloud ablation preserves the exact epoch');
 // Preserve the frozen diagnostic images even when the latency gate fails.
 check(cloudFixture.preparation.maxSliceMs<16,'Cold surface preparation slices stay below 16 ms on QA machine');
 await setup('earth',60,-256*day);await capture('08-earth-reverse');
 await page.evaluate(()=>{__G.paused=true;});await frames(1);const surfacePause=await capture('08-earth-paused');
 check(surfacePause.surfaceActive===0&&surfacePause.surfaceTurns.earth===0,'Pause restores exact surface texture immediately');
 check(report.frames.some(f=>f.focus==='earth'&&f.cloudDepth.enabled),'Full production Earth frames exercise the clear-footprint cloud bias');
 check(report.frames.every(f=>f.cloudDepth.bias===f.cloudDepth.enabled&&f.cloudDepth.factor===0&&f.cloudDepth.units===-2),'Cloud bias follows the conservative guard without slope amplification');
 const programBaseline=report.surfaceFrameTiming.at(-1),repeatStart=report.surfaceFrameTiming.length;
 for(let i=0;i<6;i++){await page.evaluate(paused=>{__G.paused=paused;},i%2===1);await frames(1);}
 const repeats=report.surfaceFrameTiming.slice(repeatStart);report.surfaceProgramReuse={programBaseline,repeats};
 check(repeats.every(s=>JSON.stringify(s.earthPrograms)===JSON.stringify(programBaseline.earthPrograms)&&JSON.stringify(s.cloudPrograms)===JSON.stringify(programBaseline.cloudPrograms)),'Repeated pause/resume reuses Earth/cloud cached programs without growth');
 check(new Set(repeats.map(s=>s.earthProgram)).size<=2&&new Set(repeats.map(s=>s.cloudProgram)).size<=2,'Earth and clouds use at most two cached exposure variants');

 await setup(3,350,256*day);await capture('08-jupiter-surface');
 await setup('earth',299195.7414,0);
 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js');cam.yaw=Math.atan2(-__eph.sunY,__eph.sunX);cam.pitch=Math.atan2(__eph.sunZ,Math.hypot(__eph.sunX,__eph.sunY));});await frames(1);
 const sunOccultation=await capture('08-earth-behind-sun');check(!sunOccultation.paths.ids.includes('earth'),'Occulted planet has no velocity arrow through Sun');
 await setup('moon',768.8,0);
 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js');cam.yaw=Math.atan2(__eph.moonY,-__eph.moonX);cam.pitch=Math.atan2(-__eph.moonZ,Math.hypot(__eph.moonX,__eph.moonY));});await frames(1);
 const moonOccultation=await capture('08-moon-behind-earth');check(!moonOccultation.paths.ids.includes('moon'),'Occulted moon has no velocity arrow through Earth');
 await setup('sun',750000,256*day);await page.evaluate(()=>{__G.gr=true;});await frames(3);await capture('09-river-on');
 await page.evaluate(()=>{__G.gr=false;});
 if(!mobile){
  await page.evaluate(async()=>{if(document.fullscreenElement)await document.exitFullscreen();});
  const cdp=await page.context().newCDPSession(page),windowInfo=await cdp.send('Browser.getWindowForTarget');
  report.fullSizeWindow={before:windowInfo.bounds.windowState};
  if(windowInfo.bounds.windowState!=='normal')await cdp.send('Browser.setWindowBounds',{windowId:windowInfo.windowId,bounds:{windowState:'normal'}});
  await cdp.detach();await page.setViewportSize({width:1280,height:820});await frames(1);await capture('09-full-size-key-frame');await page.setViewportSize({width:960,height:640});}
 if(process.env.VERIFY_COLOCATION==='1') {
  await setup('sun',2500000,0);
  await page.evaluate(async()=>{(await import('/src/uiMode.js')).setUiMode('pilot',false);__G.dead=false;__G.observerMode=false;__G.x=7000;__G.y=0;__G.z=0;});
  await frames(12);await capture('10-earth-ship-colocation');
  const overlap=await page.evaluate(async()=>{
   const {camera,viewportSize}=await import('/src/scene.js');const {earthG,earthBeacon}=await import('/src/bodies.js');const {shipG,dot}=await import('/src/ship.js');const {lblE}=await import('/src/hud.js');
   const earth=earthG.position.clone().project(camera),ship=shipG.position.clone().project(camera);
   return {earthVisible:earthG.visible&&earthBeacon.visible,earthLabel:Number(getComputedStyle(lblE).opacity),separationPx:Math.hypot((earth.x-ship.x)*viewportSize.w/2,(earth.y-ship.y)*viewportSize.h/2),shipMarkerPx:dot.material.sizeAttenuation===false?dot.scale.x*viewportSize.h/(2*Math.tan(camera.fov*Math.PI/360)):dot.scale.x*viewportSize.pxScale/camera.position.distanceTo(shipG.position)};
  });report.colocation=overlap;
  check(overlap.earthVisible&&overlap.earthLabel>.8&&overlap.separationPx<2&&overlap.shipMarkerPx<=7,'Earth remains named and visible beside a co-located compact ship marker');
 }
 const timings=[];for(let i=0;i<12;i++)timings.push(await page.evaluate(()=>__orbitalFrame()));report.timing=timings;
 // Sampling cost is measured separately from the software-rendered application.
 const cost=await page.evaluate(async()=>{
  const {updateOrbitalExposure,orbitalExposure}=await import('/src/render/orbitalExposure.js');const {camera,renderer}=await import('/src/scene.js');
  const before={...renderer.info.memory};const start=performance.now();for(let i=0;i<120;i++)updateOrbitalExposure(camera,256*86400/60,1/60);const elapsed=performance.now()-start;
  return {meanMs:elapsed/120,before,after:{...renderer.info.memory},samples:orbitalExposure.samples};
 });report.cost=cost;
 check(cost.meanMs<12,'Bounded exposure sampling averages under 12 ms on QA machine');
 check(JSON.stringify(cost.before)===JSON.stringify(cost.after),'Repeated updates do not allocate GPU resources');
 check(report.errors.length===0,'No JavaScript, shader or console errors');
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
