import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(process.argv[2]||'.'),out=resolve(process.argv[3]||'evidence/navigation/app');
const baseline=process.env.BASELINE==='1', suite=process.env.SUITE||'mobile';
await mkdir(out,{recursive:true});
const report={suite,baseline,errors:[],frames:[],checks:[]};
const check=(pass,name)=>{report.checks.push({name,pass});if(!pass&&!baseline)throw new Error(name);};
const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{
 name:'navigation-capture-only',enforce:'pre',transform(source,id){
  if(!id.replaceAll('\\','/').endsWith('/src/main.js'))return;
  const marker='const firstFrameT0 = perfStart();';assert.equal(source.split(marker).length,2);
  return source.replace(marker,'G.t = 0; G.paused = true; resetEphem();\n'+marker)+'\nwindow.__reviewFrame = frame;';
 }
}]});await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const context=await browser.newContext({viewport:{width:suite==='mobile'?390:800,height:suite==='mobile'?844:500},deviceScaleFactor:1,hasTouch:suite==='mobile',isMobile:suite==='mobile'});
 await context.addInitScript(()=>{Date.now=()=>Date.UTC(2026,8,13,12);localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_intro_seen','1');});
 const page=await context.newPage();page.setDefaultTimeout(180000);
 page.on('pageerror',e=>report.errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error'&&/Shader|WebGL|GL_INVALID/.test(m.text()))report.errors.push(m.text());});
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?hidehelp=1&tier1=0&galadapt=0&focus=earth&dist=25&river=0&lens=0`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__reviewFrame);
 await page.evaluate(async()=>{const s=await import('/src/scene.js');s.renderer.setAnimationLoop(null);__G.paused=true;__G.gr=false;__G.predict=false;window.reviewScene=s;});
 await page.waitForFunction(()=>window.__volStatus?.().mapsReady&&window.__galaxyStatus?.().ready);
 const frames=async(n=3)=>{for(let i=0;i<n;i++){await page.evaluate(()=>{__reviewFrame();reviewScene.renderer.getContext().finish();});await page.waitForTimeout(50);}};
 const capture=async(name,canvas=false)=>{
  await frames();
  const state=await page.evaluate(()=>({t:__G.t,focus:__G.focus,camera:reviewScene.camera.position.toArray(),quaternion:reviewScene.camera.quaternion.toArray(),projection:reviewScene.camera.projectionMatrix.toArray(),dpr:reviewScene.renderer.getPixelRatio(),size:[reviewScene.renderer.domElement.width,reviewScene.renderer.domElement.height],tides:window.__tidesStatus?.(),galaxies:window.__galaxyStatus?.()}));
  if(canvas){const png=await page.evaluate(()=>{__reviewFrame();return reviewScene.renderer.domElement.toDataURL('image/png');});await writeFile(`${out}/${name}.png`,Buffer.from(png.split(',')[1],'base64'));}
  else await page.screenshot({path:`${out}/${name}.png`});
  report.frames.push({name,...state});await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('CAPTURE',suite,name);
 };
 if(suite==='mobile'){
  for(const [w,h] of [[390,844],[320,568],[500,850],[844,390]]){
   await page.setViewportSize({width:w,height:h});await page.waitForTimeout(100);await capture(`compact-${w}x${h}`);
   const bounds=await page.evaluate(()=>{
    const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
    const panel=rect('explorePanel'),dock=rect('timeDock'),bar=rect('exploreBar');
    return {panel,dock,bar,overflow:document.documentElement.scrollWidth>innerWidth+1,free:Math.max(0,dock.y-panel.bottom),detailClosed:document.getElementById('explorePanelBody')?.hidden,timeClosed:document.getElementById('tdOptions')?.hidden};
   });
   check(!bounds.overflow,`${w}x${h}: no document horizontal overflow`);
   check(bounds.panel.x>=0&&bounds.panel.right<=w+1&&bounds.dock.right<=w+1&&bounds.dock.bottom<=h+1,`${w}x${h}: panels remain inside viewport`);
   check(bounds.detailClosed&&bounds.timeClosed,`${w}x${h}: details and time settings collapsed initially`);
   if(h>w)check(bounds.free>=h*.3,`${w}x${h}: at least 30% uninterrupted central scene`);
  }
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100);await frames();
  if(!baseline){
   await page.locator('#explorePanelToggle').click();await page.locator('#exploreInfo>summary').click();await capture('compact-details');
   check(await page.locator('#exploreFacts').isVisible(),'Object facts remain accessible');
   await page.keyboard.press('Escape');check(await page.locator('#explorePanelToggle').evaluate(e=>e===document.activeElement),'Escape restores details trigger focus');
   await page.locator('#tdMore').click();await capture('compact-time-settings');
   await page.locator('#tdSpeed').selectOption('3600');check(await page.evaluate(()=>Math.abs(__G.warp)===3600),'Time selector controls existing simulation clock');
   await page.locator('#tdMore').click();
   const paused=await page.evaluate(()=>__G.paused);await page.locator('#tdPause').click();check(await page.evaluate(()=>__G.paused)!==paused,'Pause remains directly usable');await page.locator('#tdPause').click();
   await page.locator('#exploreMoveToggle').click();await capture('compact-camera-controls');
   const before=await page.evaluate(()=>({tgt:__cam.tgt.toArray(),ship:[__G.x,__G.y,__G.z]}));
   const move=page.locator('[data-camera-move=left]'),r=await move.boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await frames(2);await page.mouse.up();
   const after=await page.evaluate(()=>({tgt:__cam.tgt.toArray(),ship:[__G.x,__G.y,__G.z]}));
   check(JSON.stringify(before.tgt)!==JSON.stringify(after.tgt),'Compact movement changes camera target');check(JSON.stringify(before.ship)===JSON.stringify(after.ship),'Compact movement does not move the ship');
   await page.locator('#exploreMoveToggle').click();
   const cdp=await context.newCDPSession(page),startDist=await page.evaluate(()=>__cam.dist);
   const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y])=>({id,x,y,radiusX:4,radiusY:4,force:1}))});
   await touch('touchStart',[[1,150,420],[2,240,420]]);await touch('touchMove',[[1,120,420],[2,270,420]]);await touch('touchEnd',[]);
   check(await page.evaluate(d=>Number.isFinite(__cam.dist)&&__cam.dist>0&&__cam.dist<d,startDist),'Two-finger pinch changes distance without invalid camera state');
   await page.locator('#exploreSearch').click();await capture('compact-search');await page.locator('#navClose').click();
   await page.locator('#exploreEvents').click();await capture('compact-events');await page.locator('#evClose').click();
  }
 }else{
  await page.evaluate(async()=>{
   const appearance=await import('/src/render/stellarAppearance.js');const pop=await import('/src/render/galaxyPopulationRender.js');const vol=await import('/src/render/galaxyVolume.js');
   for(const obj of [appearance.stellarExposure,appearance.extragalacticExposure])Object.defineProperty(obj,'value',{configurable:true,get:()=>.35,set(){}});
   const u=pop.galaxySharedUniforms();Object.defineProperty(u.uGainExposure,'value',{configurable:true,get:()=>vol.galaxyDisplayGain(reviewScene.viewportSize.pxScale)*.35,set(){}});
   __G.focus='free';__G.darkEnergy=false;__G.darkMatter=false;reviewScene.camera.fov=48;reviewScene.camera.updateProjectionMatrix();
  });
  for(const gyr of [0,3.9,4.4,8,13.6]){
   await page.evaluate(t=>{__G.t=t*1e9*31557600;},gyr);await frames(2);
   if(gyr>1)await page.waitForFunction(()=>window.__tidesStatus().ready||window.__tidesStatus().error);
   await page.evaluate(async()=>{
    const {galacticCenterScene}=await import('/src/universe/starfield.js'),{andromedaOffsetMpc}=await import('/src/universe/localGroupOrbit.js');
    const {galacticToWorld}=await import('/src/universe/coords.js'),{MPC_KM,K}=await import('/src/constants.js');
    const g=galacticCenterScene(),m=[0,0,0];andromedaOffsetMpc(__G.t,m);const k=MPC_KM*K;
    __cam.tgt.set(g[0]+m[0]*k*.5,g[1]+m[2]*k*.5,g[2]-m[1]*k*.5);
    __cam.dist=(Math.hypot(...m)+.055)*k*1.6;__cam.distTarget=null;
    const n=galacticToWorld([.25,-.25,1]);const l=Math.hypot(...n);__cam.pitch=Math.asin(n[2]/l);__cam.yaw=Math.atan2(-n[1],n[0]);
   });
   await frames(10);await capture(`merger-${gyr}`,true);
   const tides=await page.evaluate(()=>window.__tidesStatus());check(!tides.error,`Merger ${gyr}: no worker failure`);
   if(gyr>=3.9)check(tides.ready&&tides.visible>0,`Merger ${gyr}: actual simulated tidal particles contribute`);
  }
 }
 check(report.errors.length===0,'No JavaScript or shader errors');
 if(report.errors.length)throw new Error(report.errors.join('\n')); 
} finally {await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
