// Real main.js / canvas. Chromium receives native two-contact touch events;
// WebKit checks layout/lifecycle and labels injected pointer tests explicitly.
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(process.argv[2]||'.'), out=resolve(process.argv[3]||'evidence/mobile');
const engine=process.env.BROWSER||'chromium', baseline=process.env.BASELINE==='1';
await mkdir(out,{recursive:true});
const report={engine,baseline,checks:[],errors:[],frames:[],diagnostics:[],limitations:['Desktop browser engines and software GPU, not a physical iPhone or iOS GPU driver.']};
const save=()=>writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
const check=(ok,name,data)=>{report.checks.push({name,pass:!!ok,...(data===undefined?{}:{data})});if(!ok)throw new Error(name);};
const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{
 name:'mobile-frozen-epoch',enforce:'pre',transform(source,id){
  if(!id.replaceAll('\\','/').endsWith('/src/main.js'))return;
  const marker='const firstFrameT0 = perfStart();';assert.equal(source.split(marker).length,2);
  return source.replace(marker,'G.t=0;G.paused=true;resetEphem();\n'+marker)+'\nwindow.__mobileFrame=frame;';
 }
}]});await server.listen();
const browser=await (engine==='webkit'?webkit:chromium).launch(engine==='chromium'?{executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{env:{...process.env,LIBGL_ALWAYS_SOFTWARE:'1'}});
const context=await browser.newContext({viewport:{width:430,height:932},deviceScaleFactor:3,hasTouch:true,isMobile:true});
await context.addInitScript(()=>{Date.now=()=>Date.UTC(2026,8,27,12);localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_intro_seen','1');});
const page=await context.newPage();page.setDefaultTimeout(180000);
page.on('pageerror',e=>report.errors.push(e.message));
page.on('console',m=>{if(m.type()==='error'&&/Shader Error|GL_INVALID|INVALID_OPERATION/.test(m.text()))report.errors.push(m.text());});
const url=`http://127.0.0.1:${server.httpServer.address().port}/?hidehelp=1&tier1=0&focus=earth&dist=25&river=0&lens=0`;
const capture=async name=>{
 await page.screenshot({path:`${out}/${name}.png`});
 const state=await page.evaluate(()=>({t:__G.t,ship:[__G.x,__G.y,__G.z],focus:__G.focus,cam:{position:mobileScene.camera.position.toArray(),quaternion:mobileScene.camera.quaternion.toArray(),distance:__cam.dist},dpr:mobileScene.renderer.getPixelRatio(),size:[mobileScene.renderer.domElement.width,mobileScene.renderer.domElement.height],diagnostics:window.__mobileDiagnostics?.()}));
 report.frames.push({name,...state});await save();console.log('CAPTURE',engine,baseline?'before':'after',name);
};
const nextFrame=async(n=1)=>{
 const frame=await page.evaluate(()=>window.__mobileDiagnostics?.().frames||0);
 if(!baseline)await page.waitForFunction(({frame,n})=>__mobileDiagnostics().frames>=frame+n,{frame,n});
 else await page.waitForTimeout(1000);
};
try{
 await page.goto(url,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__mobileFrame);
 await page.evaluate(async()=>{window.mobileScene=await import('/src/scene.js');window.mobileState=await import('/src/state.js');window.mobileTime=await import('/src/timeCtl.js');const r=mobileScene.renderer,read=r.readRenderTargetPixels.bind(r);window.__syncMeterReads=0;r.readRenderTargetPixels=(...args)=>{__syncMeterReads++;return read(...args);};});
 await page.waitForFunction(()=>window.__volStatus?.().mapsReady);
 report.browser=await browser.version();report.runtime=await page.evaluate(()=>{const gl=mobileScene.renderer.getContext(),e=gl.getExtension('WEBGL_debug_renderer_info');return {renderer:e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),userAgent:navigator.userAgent,deviceDpr:devicePixelRatio};});
 for(const [w,h] of [[430,932],[390,844],[320,568],[932,430]]){
  await page.setViewportSize({width:w,height:h});await page.waitForTimeout(400);await nextFrame();
  await capture(`default-${w}x${h}`);
  if(!baseline){
   const b=await page.evaluate(()=>{const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width,height:r.height,left:r.left,right:r.right};};return {bar:box('touchBar'),dock:box('timeDock'),overflow:document.documentElement.scrollWidth>innerWidth+1,panels:[...document.querySelectorAll('.touch-sheet-active')].length,diag:__mobileDiagnostics()};});
   check(!b.overflow&&b.bar.left>=0&&b.dock.right<=w+1&&b.dock.bottom<=h+1,`${w}x${h}: bounds/no horizontal overflow`,b);
   check(b.panels===0&&b.bar.height<=52&&b.dock.height<=90,`${w}x${h}: no permanently expanded panels`);
   if(h>w)check(b.dock.top-b.bar.bottom>=h*.68,`${w}x${h}: at least 68% uninterrupted central height`);
   check(b.diag.canvas[0]*b.diag.canvas[1]<=600000&&b.diag.dpr<=1.15,`${w}x${h}: DPR3 device stays within canvas budget`);
  }
 }
 if(baseline){await capture('baseline-final');report.completed=true;}
 else{
  await page.setViewportSize({width:430,height:932});await page.waitForTimeout(400);await nextFrame();
  await page.locator('#explorePanelToggle').click();await capture('object-sheet');
  check(await page.locator('#exploreFacts').isVisible(),'Object facts available without a persistent sidebar');
  await page.keyboard.press('Escape');check(await page.locator('#explorePanelToggle').evaluate(e=>document.activeElement===e),'Escape restores focus');
  await page.locator('#tdMore').click();await capture('time-sheet');await page.locator('#tdSpeed').selectOption('3600');
  check(await page.evaluate(()=>__G.warp===3600),'Existing time selector remains functional');
  await page.keyboard.press('Escape');const paused=await page.evaluate(()=>__G.paused);await page.locator('#tdPause').click();
  check(await page.evaluate(()=>__G.paused)!==paused,'Pause toggles directly from collapsed time strip');await page.locator('#tdPause').click();
  await page.locator('#touchSearch').click();await capture('search-sheet');check(await page.locator('#navPanel').isVisible(),'Navigator is reachable');await page.locator('#navClose').click();
  await page.locator('#touchMenuToggle').click();await capture('menu-sheet');
  await page.locator('#touchEvents').click();await capture('events-sheet');await page.locator('#evClose').click();
  await page.locator('#touchMenuToggle').click();await page.locator('#exploreMoveToggle').click();await capture('explore-thumb-controls');
  const beforeMove=await page.evaluate(()=>({tgt:__cam.tgt.toArray(),ship:[__G.x,__G.y,__G.z]}));
  const stick=await page.locator('#touchStick').boundingBox();await page.mouse.move(stick.x+stick.width*.1,stick.y+stick.height*.5);await page.mouse.down();await nextFrame(2);await page.mouse.up();
  const afterMove=await page.evaluate(()=>({tgt:__cam.tgt.toArray(),ship:[__G.x,__G.y,__G.z],keys:[...mobileState.keys]}));
  check(JSON.stringify(beforeMove.tgt)!==JSON.stringify(afterMove.tgt),'Thumb pad moves the camera');check(JSON.stringify(beforeMove.ship)===JSON.stringify(afterMove.ship),'Explore thumb pad never moves the ship');check(afterMove.keys.length===0,'Thumb release stops movement');
  await page.locator('#touchMenuToggle').click();await page.locator('#exploreMoveToggle').click();
  // Stable Safe level prevents quality-downshift resizes from confounding
  // the pinch/resize-event allocation test. Auto startup was tested above.
  await page.locator('#touchMenuToggle').click();await page.locator('#touchGraphics').selectOption('safe');await page.keyboard.press('Escape');await page.waitForTimeout(400);await nextFrame(2);
  await page.evaluate(()=>{__G.focus='earth';__cam.dist=25;__cam.distTarget=null;});await nextFrame();
  const before=await page.evaluate(()=>({dist:__cam.dist,focus:__G.focus,ship:[__G.x,__G.y,__G.z],diag:__mobileDiagnostics()}));
  if(engine==='chromium'){
   const cdp=await context.newCDPSession(page);
   const touch=(type,pts)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:pts.map(([id,x,y])=>({id,x,y,radiusX:3,radiusY:3,force:1}))});
   for(let cycle=0;cycle<8;cycle++){
    await touch('touchStart',[[1,160,360],[2,270,360]]);
    for(let i=1;i<=8;i++)await touch('touchMove',[[1,160-i*4,360],[2,270+i*4,360]]);
    await touch('touchEnd',[]);await nextFrame();
    await touch('touchStart',[[1,128,360],[2,302,360]]);
    for(let i=1;i<=8;i++)await touch('touchMove',[[1,128+i*4,360],[2,302-i*4,360]]);
    await touch('touchEnd',[]);await nextFrame();
   }
   report.gestureDelivery='Native Chromium CDP touch contacts, 16 pinches / 128 move batches.';
   await touch('touchStart',[[1,160,360],[2,270,360]]);await touch('touchMove',[[1,130,360],[2,300,360]]);await touch('touchEnd',[]);await nextFrame();
  }else{
   // WebKit has no CDP multi-contact injector. Test the Pointer Events path
   // without pretending the events originated from an actual touch device.
   await page.evaluate(()=>{const c=mobileScene.renderer.domElement,e=(type,id,x,y)=>c.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:'touch',clientX:x,clientY:y,bubbles:true,cancelable:true}));e('pointerdown',101,160,360);e('pointerdown',102,270,360);e('pointermove',101,130,360);e('pointermove',102,300,360);mobileScene.flushCameraGestures();e('pointerup',101,130,360);e('pointerup',102,300,360);});await nextFrame();
   report.gestureDelivery='Injected WebKit Pointer Events; not a native iOS multi-touch test.';
  }
  const after=await page.evaluate(()=>({dist:__cam.dist,focus:__G.focus,ship:[__G.x,__G.y,__G.z],diag:__mobileDiagnostics()}));
  check(Number.isFinite(after.dist)&&after.dist>0&&after.dist<before.dist,'Pinch changes camera distance with finite bounded state',{before:before.dist,after:after.dist});
  check(after.focus===before.focus,'Symmetric pinch does not detach object focus');check(JSON.stringify(after.ship)===JSON.stringify(before.ship),'Pinch does not move the ship');
  check(after.diag.resizes===before.diag.resizes,'Camera pinch does not reallocate the canvas');
  check(after.diag.volume.targetBytes<=2000000,'Safe mobile galaxy targets remain bounded');
  await capture('after-pinch-stress');
  const resizeBefore=after.diag.resizes;
  await page.evaluate(()=>{for(let i=0;i<100;i++){window.dispatchEvent(new Event('resize'));window.visualViewport?.dispatchEvent(new Event('resize'));}});await page.waitForTimeout(400);await nextFrame();
  check(await page.evaluate(()=>__mobileDiagnostics().resizes)===resizeBefore,'Repeated unchanged window/visualViewport events do not resize buffers');
  check(await page.evaluate(()=>__syncMeterReads)===0,'Mobile exposure has no synchronous readRenderTargetPixels calls');
  check(await page.evaluate(()=>__volStatus().asyncMeter.reads)>0,'Asynchronous exposure readback actually completes');
  // Pilot: steering and throttle are different owners, with immediate release.
  await page.locator('#touchMenuToggle').click();await page.locator('[data-ui-mode="pilot"]').click();await capture('pilot-controls');
  check(await page.locator('#mThrTrack').isVisible()&&await page.locator('#touchStick').isVisible(),'Pilot has separate reachable steering and throttle');
  const track=await page.locator('#mThrTrack').boundingBox();await page.mouse.move(track.x+track.width/2,track.y+12);await page.mouse.down();
  check(await page.evaluate(()=>mobileState.keys.has('KeyW')),'Throttle has its own press owner');
  await page.evaluate(()=>{document.getElementById('mThrKnob').dispatchEvent(new PointerEvent('pointermove',{pointerId:998,pointerType:'touch',clientY:10000,bubbles:true}));});
  check(await page.evaluate(()=>mobileState.keys.has('KeyW')&&!mobileState.keys.has('KeyS')),'An unrelated contact cannot reverse the throttle');await page.mouse.up();
  check(await page.evaluate(()=>!mobileState.keys.has('KeyW')&&!mobileState.keys.has('KeyS')),'Throttle release returns to coast');
  const stop=await page.evaluate(async()=>{const s=await import('/src/mobile/renderSession.js');mobileState.keys.add('KeyW');window.dispatchEvent(new Event('pagehide'));return {keys:[...mobileState.keys],paused:__G.paused};});
  check(stop.keys.length===0&&stop.paused,'Leaving the page stops input and pauses simulation');
  await page.locator('#touchMenuToggle').click();await page.locator('[data-ui-mode="observe"]').click();
  // Inject delayed fence completion (not a fake hardware speed measurement).
  await page.waitForFunction(()=>__mobileDiagnostics().gpuPending);
  const held=await page.evaluate(()=>{const gl=mobileScene.renderer.getContext();window.__savedWait=gl.clientWaitSync.bind(gl);gl.clientWaitSync=()=>gl.TIMEOUT_EXPIRED;return __mobileDiagnostics().frames;});
  await page.waitForTimeout(1800);await page.locator('#touchMenuToggle').click();
  check(await page.locator('#touchMenu').isVisible(),'DOM controls stay usable while a frame fence is delayed');
  check(await page.evaluate(()=>__mobileDiagnostics().frames)===held,'Delayed GPU fence prevents new frame submissions');
  await page.evaluate(()=>{mobileScene.renderer.getContext().clientWaitSync=__savedWait;});
  await page.locator('#touchGraphicsReset').click();await page.keyboard.press('Escape');await nextFrame();
  // Three controlled context losses. Physics is preserved; render contents
  // must be reconstructed, not treated as valid history after restoration.
  for(let cycle=0;cycle<3;cycle++){
   const saved=await page.evaluate(()=>{mobileScene.renderer.setAnimationLoop(null);window.__lossExtension=mobileScene.renderer.getContext().getExtension('WEBGL_lose_context');if(!__lossExtension)return null;const a={t:__G.t,ship:[__G.x,__G.y,__G.z],losses:__mobileDiagnostics().contextLosses,invalidations:__volStatus().invalidations};__lossExtension.loseContext();return a;});
   check(!!saved,'WEBGL_lose_context available for actual restoration test');
   await page.waitForFunction(n=>__mobileDiagnostics().contextLosses>n,saved.losses);
   check(await page.locator('#renderRecovery').isVisible(),'Context loss has visible recovery status');
   await page.waitForTimeout(150);await page.evaluate(()=>__lossExtension.restoreContext());await page.waitForFunction(()=>__mobileDiagnostics().state==='ready');
   const restored=await page.evaluate(()=>({t:__G.t,ship:[__G.x,__G.y,__G.z],paused:__G.paused,invalidations:__volStatus().invalidations,diag:__mobileDiagnostics()}));
   check(restored.t===saved.t&&JSON.stringify(restored.ship)===JSON.stringify(saved.ship)&&restored.paused,`Recovery ${cycle+1}: physics preserved and paused`);
   check(restored.invalidations>saved.invalidations,`Recovery ${cycle+1}: cached radiance invalidated`);
   await page.evaluate(()=>mobileScene.renderer.setAnimationLoop(__mobileFrame));await nextFrame(2);await capture(`restored-${cycle+1}`);
   const diag=await page.evaluate(()=>__mobileDiagnostics());check(diag.volume.targetBytes<=2000000,`Recovery ${cycle+1}: target residency remains bounded`);report.diagnostics.push(diag);
  }
  // A recovery preference must survive a normal reload; no destructive
  // automatic refresh/restart is used by the runtime itself.
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>__AP_READY&&window.__mobileDiagnostics);
  check(await page.evaluate(()=>__mobileDiagnostics().mode)==='safe','Safe recovery preference survives reload');
  report.completed=true;
 }
 check(report.errors.length===0,'No unexpected JavaScript/GL errors',report.errors);
}catch(error){report.failure=String(error.stack||error);try{await page.screenshot({path:`${out}/failure.png`});report.failureState=await page.evaluate(()=>({diag:window.__mobileDiagnostics?.(),classes:document.body.className,ready:window.__AP_READY}));}catch{}throw error;}
finally{await save();await browser.close();await server.close();}
