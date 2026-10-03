import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const mobile=process.env.DEVICE==='mobile', out=resolve(process.env.ARTEMIS_EVIDENCE||`evidence/orbital-${mobile?'mobile':'desktop'}`);
await mkdir(out,{recursive:true});
const report={revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mobile,checks:[],frames:[],errors:[]};
const check=(ok,name)=>{report.checks.push({name,pass:!!ok});assert(ok,name);};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'orbital-motion-qa',enforce:'pre',transform(source,id){
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 const marker='const firstFrameT0 = perfStart();';assert.equal(source.split(marker).length,2);
 return source.replace(marker,'G.t=0;G.paused=true;resetEphem();clock.getDelta=()=>window.__qaDt??1/60;'+marker).replace('renderer.setAnimationLoop(frame);','')+`\nwindow.__orbitalFrame=()=>{lastMobileFrame=-Infinity;const start=performance.now();frame();const gl=renderer.getContext();gl.finish();return{ms:performance.now()-start,frameNo,t:G.t};};`;
}}]});
await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:mobile?{width:430,height:932}:{width:1280,height:820},isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1});page.setDefaultTimeout(180000);
 await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','observe');Date.now=()=>Date.UTC(2026,9,3,6);});
 page.on('pageerror',e=>report.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=sun&hidehelp=1&compile=0&np=128`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__orbitalFrame);
 const frames=async(n)=>{for(let i=0;i<n;i++)await page.evaluate(()=>__orbitalFrame());};
 const setup=async(focus,dist,rate)=>{
  await page.evaluate(async({focus,dist,rate})=>{
   const {cam}=await import('/src/scene.js');const {setFocus}=await import('/src/input.js');
   setFocus(focus);cam.dist=dist;cam.distTarget=null;cam.yaw=.4;cam.pitch=1.2;
   __G.gr=false;__G.warp=rate;__G.paused=rate===0;__qaDt=1/60;
  },{focus,dist,rate});await frames(2);
 };
 const capture=async(name)=>{
  const info=await page.evaluate(async()=>{
   const {orbitalExposure}=await import('/src/render/orbitalExposure.js');const b=await import('/src/bodies.js');const {camera,renderer}=await import('/src/scene.js');const {K}=await import('/src/constants.js');const e=__eph;
   return {t:__G.t,rate:__G.warp,focus:__G.focus,active:orbitalExposure.active,averaged:orbitalExposure.averaged,samples:orbitalExposure.samples,entries:orbitalExposure.entries.filter(e=>e.line.visible).map(e=>({key:e.key,blend:e.blend,averaged:e.averaged,finite:e.pos.every(Number.isFinite),width:e.line.material.linewidth})),earthMarker:{visible:b.earthG.visible&&b.earthBeacon.visible,opacity:b.earthBeacon.material.opacity,pixels:b.earthBeacon.scale.x* (await import('/src/scene.js')).viewportSize.pxScale/camera.position.distanceTo(b.earthG.position)},earthGuide:{visible:b.earthOrbitRing.visible,opacity:b.earthOrbitRing.material.opacity,centerError:b.earthOrbitRing.position.distanceTo(b.sunPos)},physicalPositionsExact:b.earthG.position.x===e.earthX*K&&b.moon.position.x===(e.earthX+e.moonX)*K&&b.plGroups.every((p,i)=>p.position.x===(e.earthX+e.plX[i])*K),noteVisible:document.getElementById('orbitalExposureNote')?.getClientRects().length>0,calls:renderer.info.render.calls,geometries:renderer.info.memory.geometries};
  });
  report.frames.push({name,...info});
  check(info.physicalPositionsExact,`${name}: all physical render positions remain exact`);
  check(info.entries.every(e=>e.finite)&&info.samples<=31*65,`${name}: finite bounded exposure buffers`);
  await page.screenshot({path:`${out}/${name}.png`,timeout:180000});
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('CAPTURE',name,info.active,info.averaged);
  return info;
 };
 const day=86400;
 await setup('sun',750000,0);const paused=await capture('00-paused-earth-orbit');
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
 await setup('moon',14,256*day);await capture('07-focused-moon');
 check(!report.frames.at(-1).entries.some(e=>e.key==='moon'),'Focused resolved Moon remains exact and legible');
 await setup('earth',60,256*day);await capture('08-focused-earth');
 check(!report.frames.at(-1).entries.some(e=>e.key==='earth'),'Focused resolved Earth remains exact and legible');
 await setup('sun',750000,256*day);await page.evaluate(()=>{__G.gr=true;});await frames(3);await capture('09-river-on');
 await page.evaluate(()=>{__G.gr=false;});
 if(process.env.VERIFY_COLOCATION==='1') {
  await setup('sun',2500000,0);
  await page.evaluate(async()=>{(await import('/src/uiMode.js')).setUiMode('pilot',false);__G.dead=false;__G.observerMode=false;__G.x=7000;__G.y=0;__G.z=0;});
  await frames(12);await capture('10-earth-ship-colocation');
  const overlap=await page.evaluate(async()=>{
   const {camera,viewportSize}=await import('/src/scene.js');const {earthG,earthBeacon}=await import('/src/bodies.js');const {shipG,dot}=await import('/src/ship.js');const {lblE}=await import('/src/hud.js');
   const earth=earthG.position.clone().project(camera),ship=shipG.position.clone().project(camera);
   return {earthVisible:earthG.visible&&earthBeacon.visible,earthLabel:Number(getComputedStyle(lblE).opacity),separationPx:Math.hypot((earth.x-ship.x)*viewportSize.w/2,(earth.y-ship.y)*viewportSize.h/2),shipMarkerPx:dot.scale.x*viewportSize.pxScale/camera.position.distanceTo(shipG.position)};
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
