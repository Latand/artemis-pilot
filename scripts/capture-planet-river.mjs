// Matched full-app screenshots and completed-frame timings, run in CI.
// No production debug hooks or query modes are introduced.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(process.argv[2] || '.'), out = resolve(process.argv[3] || 'evidence/planet-river');
const baseline = process.env.BASELINE === '1', mobile = process.env.MOBILE === '1';
await mkdir(out, { recursive: true });
const report = { baseline, mobile, epoch: '2026-09-30T12:00:00Z', comparison: 'Matched cameras and epoch; dynamic river phases are qualitative, not pixel-identical', errors: [], frames: [], timings: [] };
const server = await createServer({root, logLevel:'error', server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{
 name:'planet-river-capture',enforce:'pre',transform(source,id){
  if(!id.replaceAll('\\','/').endsWith('/src/main.js'))return;
  const marker='const firstFrameT0 = perfStart();';
  assert.equal(source.split(marker).length,2);
  return source.replace(marker,'G.t = 0; G.paused = true; G.gr = false; resetEphem();\n'+marker)
   .replace('const riverWarmed = warmRiverCompute();', 'const riverWarmed = false;')
   .replace('const rawDtR = clock.getDelta();','const rawDtR = 1 / 60;')
   +'\nwindow.__planetCaptureFrame=frame;window.__planetCaptureRiver=v=>{grB=v;};';
 }}]});await server.listen();
const browser=await chromium.launch({args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const context=await browser.newContext({viewport:mobile?{width:390,height:600}:{width:900,height:600},deviceScaleFactor:1,hasTouch:mobile,isMobile:mobile});
 await context.addInitScript(()=>{Date.now=()=>Date.UTC(2026,8,30,12);localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_intro_seen','1');});
 const page=await context.newPage();page.setDefaultTimeout(180000);
 page.on('pageerror',e=>report.errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error'&&/Shader|WebGL|GL_INVALID/.test(m.text()))report.errors.push(m.text());});
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?hidehelp=1&dpr=1&tier1=0&galadapt=0&realsky=0&focus=sun&dist=13000000&pitch=.78&yaw=.7&lens=0`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__planetCaptureFrame);
 await page.evaluate(async()=>{
  const s=await import('/src/scene.js'),b=await import('/src/bodies.js'),r=await import('/src/river.js');
  const {WORLD}=await import('/src/state.js');
  s.renderer.setAnimationLoop(null);__G.paused=true;__G.predict=false;__G.gr=false;__planetCaptureRiver(0);
  window.capture={s,b,r,WORLD};
 });
 // Let the background worker finish before the first costly river shader compile.
 await page.waitForFunction(()=>window.__volStatus?.().mapsReady||window.__volStatus?.().mapError);
 report.startupVolume=await page.evaluate(()=>window.__volStatus());
 assert.ok(report.startupVolume.mapsReady,report.startupVolume.mapError||'full galaxy maps missing');
 await page.setViewportSize(mobile?{width:390,height:844}:{width:1280,height:800});
 report.browser=await browser.version();
 report.renderer=await page.evaluate(()=>{const gl=capture.s.renderer.getContext(),e=gl.getExtension('WEBGL_debug_renderer_info');return e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)});
 async function frames(n=8){for(let i=0;i<n;i++)await page.evaluate(()=>{__planetCaptureFrame();capture.s.renderer.getContext().finish()});}
 async function view(state){
  if(mobile && state.focus==='sun' && state.dist>=1e7)state={...state,dist:state.dist*2};
  await page.evaluate(state=>{
  const {s,b}=capture;__G.focus=state.focus;__G.gr=state.river!==false;__planetCaptureRiver(__G.gr?1:0);
  s.cam.dist=state.dist;s.cam.distTarget=null;s.cam.yaw=.7;s.cam.pitch=.78;
  s.cam.tgt.copy(state.focus==='sun'?b.sunPos:state.focus==='earth'?b.earthG.position:b.plGroups[state.focus].position);
 },state);await frames(3);}
 async function shot(name){
  const state=await page.evaluate(()=>{
   __planetCaptureFrame();const {s,b,r}=capture;s.renderer.getContext().finish();
   return {png:s.renderer.domElement.toDataURL('image/png'),time:__G.t,focus:__G.focus,camera:s.camera.position.toArray(),quaternion:s.camera.quaternion.toArray(),size:[s.renderer.domElement.width,s.renderer.domElement.height],dpr:s.renderer.getPixelRatio(),mobile:s.renderQuality.mobile,river:{...r.river},markers:b.plGlows.map(m=>({visible:m.visible,opacity:m.material.opacity,scale:m.scale.x})),earthMarker:b.earthMarker?{visible:b.earthMarker.visible,opacity:b.earthMarker.material.opacity}:null};
  });
  assert.equal(state.time,0,'matched capture epoch');
  await writeFile(`${out}/${name}-canvas.png`,Buffer.from(state.png.split(',')[1],'base64'));delete state.png;
  await page.screenshot({path:`${out}/${name}.png`});
  report.frames.push({name,...state});console.log('CAPTURE',name);
 }
 for(const state of [
  {name:'solar-system',focus:'sun',dist:1.3e7},
  {name:'inner-planets',focus:'sun',dist:7e5},
  {name:'mars-transition',focus:2,dist:900},
  {name:'mars-close',focus:2,dist:14},
  {name:'earth-close',focus:'earth',dist:25},
 ]){await view(state);await shot(state.name);}
 // Zoom in and back out through the surface handoff, without recreating markers.
 if(!baseline){
  const samples=[];
  for(const dist of [12000,4000,2000,1200,900,650,450,200,40,450,900,2000,12000]){
   await view({focus:2,dist});samples.push(await page.evaluate(()=>({dist:capture.s.cam.dist,opacity:capture.b.plGlows[2].material.opacity,visible:capture.b.plGlows[2].visible,scale:capture.b.plGlows[2].scale.x})));}
  assert.ok(samples[0].opacity>.8&&samples[8].opacity===0,'marker hands off to resolved sphere');
  assert.ok(Math.abs(samples[0].opacity-samples.at(-1).opacity)<1e-6,'returning to same zoom restores marker');
  report.zoom=samples;
  await page.evaluate(()=>{capture.WORLD.plDestroyed[2]=true});await frames(2);
  assert.equal(await page.evaluate(()=>capture.b.plGlows[2].visible),false,'destroyed planet has no marker');
  await page.evaluate(()=>{capture.WORLD.plDestroyed[2]=false});
 }
 await view({focus:'sun',dist:1.3e7});await shot('solar-return');
 // Paired on/off cost, synchronization included. This is not isolated GPU time.
 // Keep both orders and raw samples: SwiftShader noise makes FPS promises invalid.
 await page.setViewportSize(mobile?{width:390,height:600}:{width:800,height:500});
 report.timingViewport=page.viewportSize();
 for(const enabled of [false,true,true,false]){
  await view({focus:'sun',dist:1.3e7,river:enabled});await frames(2);
  const samples=[];for(let i=0;i<6;i++)samples.push(await page.evaluate(()=>{let t=performance.now();__planetCaptureFrame();capture.s.renderer.getContext().finish();return performance.now()-t}));
  report.timings.push({river:enabled,completedFrameMs:samples});
 }

 await page.setViewportSize(mobile?{width:390,height:844}:{width:1280,height:800});
 // Verify retinal-density rendering without shrinking the CSS-space marker.
 await view({focus:'sun',dist:1.3e7});
 const lowDprScale=await page.evaluate(()=>capture.b.plGlows[5].scale.x);
 await page.evaluate(()=>capture.s.renderer.setPixelRatio(2));
 await shot('solar-system-dpr2');
 assert.equal(await page.evaluate(()=>capture.s.renderer.getPixelRatio()),2);
 assert.ok(Math.abs(await page.evaluate(()=>capture.b.plGlows[5].scale.x)-lowDprScale)<1e-6);
 await page.evaluate(()=>capture.s.renderer.setPixelRatio(1));
 if(!baseline){
  // An actual foreground globe must hide the marker; moving it in front must
  // change the same central pixels. Render the fixed scene without simulation.
  await view({focus:'earth',dist:25,river:false});
  report.occlusion=await page.evaluate(async()=>{
   const {makePlanetMarker}=await import('/src/planetMarker.js');
   const {s,b}=capture,gl=s.renderer.getContext();
   const marker=makePlanetMarker(0xff3333);marker.material.opacity=1;marker.scale.setScalar(1);
   const direction=s.camera.position.clone().sub(b.earthG.position).normalize();
   const read=()=>{s.renderSceneTiered(s.renderer,s.scene,s.camera);gl.finish();const out=new Uint8Array(15*15*4);gl.readPixels(Math.floor(gl.drawingBufferWidth/2)-7,Math.floor(gl.drawingBufferHeight/2)-7,15,15,gl.RGBA,gl.UNSIGNED_BYTE,out);return out;};
   const clean=read();marker.position.copy(b.earthG.position).addScaledVector(direction,-20);s.scene.add(marker);const behind=read();
   marker.position.copy(b.earthG.position).addScaledVector(direction,15);const front=read();
   s.scene.remove(marker);marker.material.dispose();
   return {hidden:clean.every((v,i)=>v===behind[i]),visibleInFront:clean.some((v,i)=>Math.abs(v-front[i])>4)};
  });
  assert.ok(report.occlusion.hidden&&report.occlusion.visibleInFront,'planet globe occludes a guide behind it');
  // Exercise real high-warp delivery and mobile's every-other-frame compute,
  // including a moving camera origin while dispatch is skipped.
  await view({focus:'sun',dist:1.3e7});
  await page.evaluate(()=>{__G.focus='free';__G.warp=1e5;__G.paused=false});
  report.highWarp=[];
  for(let i=0;i<10;i++){
   report.highWarp.push(await page.evaluate(()=>{
    const {s,r}=capture;s.cam.tgt.x+=100;s.cam.tgt.y+=40;s.cam.tgt.z-=70;
    __planetCaptureFrame();s.renderer.getContext().finish();
    return {time:__G.t,skipped:r.river.skippedCompute,every:r.river.computeEvery,...r.riverDebugReadPositions(1)};
   }));
  }
  assert.ok(report.highWarp.at(-1).time>0,'high-warp simulation advances');
  assert.ok(report.highWarp.every(row=>row.finite&&row.distinct>0),'live GPU positions remain finite and distinct');
  if(mobile)assert.ok(report.highWarp.some(row=>row.skipped),'mobile skipped-compute path exercised');
  for(const row of report.highWarp)for(const [index,axis] of ['x','y','z'].entries())
   assert.ok(Math.abs(row.drawCenterShift[index]-(row.center[axis]-row.textureOrigin[axis]))<.01,'draw shift matches the texture origin');
 }
 assert.equal(report.errors.length,0,report.errors.join('\n'));
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
