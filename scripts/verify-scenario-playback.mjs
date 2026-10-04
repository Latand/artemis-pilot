import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out=resolve(process.argv[2]||'/tmp/artemis-scenario-qa');await mkdir(out,{recursive:true});
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const errors=[], report=[];
try {
 for(const [label,width,height] of [['desktop',1366,900],['mobile',430,932],['mobile-compact',390,700],['mobile-landscape',932,430]].filter(row=>!process.env.DEVICE||row[0].startsWith(process.env.DEVICE))) {
  const page=await browser.newPage({viewport:{width,height},isMobile:label.startsWith('mobile'),hasTouch:label.startsWith('mobile')});
  page.on('pageerror',e=>errors.push(label+': '+e.message));
  page.on('console',m=>{if(m.type()==='error'&&/THREE|WebGL|shader/i.test(m.text()))errors.push(label+': '+m.text());});
  await page.addInitScript(()=>{HTMLElement.prototype.requestFullscreen=()=>Promise.resolve();});
  await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
  await page.route('**/src/main.js',async route=>{
   const response=await route.fetch();const body=(await response.text()).replace('renderer.setAnimationLoop(frame);','window.__scenarioFrame = dt => { clock.getDelta = () => dt; lastMobileFrame = -Infinity; frame(); }; renderer.setAnimationLoop(frame);');await route.fulfill({response,body});
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?galaxyvol=0&field=0&galaxies=0&tier1=0&realsky=0&np=96`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__AP_READY,null,{timeout:60000});
  await page.locator('#introEnter').click();
  await page.evaluate(()=>{window.__gl.renderer.setAnimationLoop(null);window.__G.paused=true;window.__G.warp=123;});
  const saved=await page.evaluate(()=>JSON.parse(JSON.stringify({log:window.__discoveryLog.serializeLog(),objectives:document.getElementById('objList').innerHTML,g:window.__G,cam:{yaw:window.__cam.yaw,pitch:window.__cam.pitch,dist:window.__cam.dist,tgt:window.__cam.tgt.toArray()}})));
  // Menu and initial selection are actual button interactions.
  await page.evaluate(async()=>{(await import('/src/scenarios.js')).toggleScenarioMenu();});
  await page.locator('[data-scenario="slingshot"]').click();
  assert.equal(await page.locator('#spToggle').textContent(),'Start flight');
  await page.evaluate(()=>window.__scenarioFrame(1/30));
  assert.equal(await page.evaluate(()=>window.__G.t),0,'selection awaits explicit start');
  assert.deepEqual(await page.evaluate(()=>window.__discoveryLog.serializeLog()),saved.log,'ready frame awards no discoveries');
  assert.equal(await page.locator('#objList').innerHTML(),saved.objectives,'ready frame awards no achievements');
  await page.screenshot({path:resolve(out,`${label}-00-ready.png`)});
  const untouched=await page.evaluate(()=>[window.__G.x,window.__G.y,window.__G.z,window.__G.vx,window.__G.vy,window.__G.vz]);
  const grabPoint=await page.evaluate(async()=>{
    const {shipG}=await import('/src/ship.js');const {camera,renderer}=await import('/src/scene.js');const p=shipG.position.clone().project(camera);const r=renderer.domElement.getBoundingClientRect();
    window.__G.uiMode='pilot';return{x:r.left+(p.x+1)*r.width/2,y:r.top+(1-p.y)*r.height/2,yaw:window.__cam.yaw,pitch:window.__cam.pitch};
  });
  // A deliberate hold over the visible hull must remain a camera gesture.
  await page.mouse.move(grabPoint.x,grabPoint.y);await page.mouse.down();await page.waitForTimeout(400);await page.mouse.move(grabPoint.x+48,grabPoint.y+20);await page.mouse.up();
  assert.deepEqual(await page.evaluate(()=>[window.__G.x,window.__G.y,window.__G.z,window.__G.vx,window.__G.vy,window.__G.vz]),untouched,'guided ship cannot be grabbed or thrown');
  await page.evaluate(({yaw,pitch})=>{window.__cam.yaw=yaw;window.__cam.pitch=pitch;window.__G.uiMode='observe';},grabPoint);

  await page.locator('#spToggle').click();
  const frames=[];
  for(let k=0;k<=600;k++) {
   const sample=await page.evaluate(async k=>{
    if(k>0)window.__scenarioFrame(.1);
    if(k%10) return null;
    const {shipG,craft}=await import('/src/ship.js');const {plGroups}=await import('/src/bodies.js');
    const {eph}=await import('/src/ephemeris.js');const {PL}=await import('/src/constants.js');
    const {river}=await import('/src/river.js');
    const {camera,renderer}=await import('/src/scene.js');
    const p=shipG.position.clone().project(camera),j=plGroups[3].position.clone().project(camera);
    return {k,naturalFlow:{enabled:window.__G.gr,visible:river.visible,gain:river.presentationGain,depthTest:river.presentationDepthTest,count:river.count,drawCount:river.drawCount},t:window.__G.t,warp:window.__G.warp,paused:window.__G.paused,shipVisible:shipG.visible,scale:craft.scale.x,ship:[p.x,p.y,p.z],jupiter:[j.x,j.y,j.z],distanceRj:Math.hypot(window.__G.x-eph.plX[3],window.__G.y-eph.plY[3],window.__G.z-eph.plZ[3])/PL[3].R,panel:(()=>{const r=document.getElementById('scenarioPlayback').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})(),drawCalls:renderer.info.render.calls};
   },k);
   if(sample){frames.push(sample);assert.ok(sample.naturalFlow.enabled&&sample.naturalFlow.visible,'natural gravity field remains enabled');assert.equal(sample.naturalFlow.gain,.22,'guided display gain is bounded and stable');assert.equal(sample.naturalFlow.depthTest,true,'natural flow respects opaque subjects');assert.ok(sample.naturalFlow.count>0&&sample.naturalFlow.drawCount>0,'natural particle population retained');assert.ok(sample.shipVisible,'ship visible throughout');assert.ok(Math.abs(sample.ship[0])<.9&&Math.abs(sample.ship[1])<.9,'ship inside frame');assert.ok(Math.abs(sample.jupiter[0])<.9&&Math.abs(sample.jupiter[1])<.9,'Jupiter inside frame');for(const point of [sample.ship,sample.jupiter]){const x=(1+point[0])*width/2,y=(1-point[1])*height/2,p=sample.panel;assert.ok(x<p.x-30||x>p.x+p.width+30||y<p.y-30||y>p.y+p.height+30,'guided controls leave the subjects unobscured');}}
   if([150,240,300,360,450,600].includes(k)) await page.screenshot({path:resolve(out,`${label}-${String(k/10).padStart(2,'0')}-flight.png`)});
   if(k===80){
    await page.locator('#spToggle').click();const pausedT=await page.evaluate(()=>window.__G.t);await page.evaluate(()=>window.__scenarioFrame(.1));assert.equal(await page.evaluate(()=>window.__G.t),pausedT,'pause holds clock');await page.locator('#spToggle').click();
   }
  }
  assert.equal(await page.locator('#spPhase').textContent(),'Encounter complete');
  assert.ok(await page.evaluate(()=>window.__G.paused),'completion holds');
  await page.locator('#spRestart').click();assert.equal(await page.evaluate(()=>window.__G.t),0);assert.equal(await page.locator('#spToggle').textContent(),'Start flight');
  await page.evaluate(async()=>{
   const {renderer}=await import('/src/scene.js');const r=renderer.domElement.getBoundingClientRect();
   renderer.domElement.dispatchEvent(new PointerEvent('pointerdown',{pointerId:91,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,bubbles:true}));
  });
  await page.locator('#spExit').click();
  await page.evaluate(()=>{
   window.dispatchEvent(new PointerEvent('pointermove',{pointerId:91,clientX:200,clientY:200,button:0}));
   window.dispatchEvent(new PointerEvent('pointerup',{pointerId:91,clientX:200,clientY:200,button:0}));
  });
  const restored=await page.evaluate(()=>({log:window.__discoveryLog.serializeLog(),objectives:document.getElementById('objList').innerHTML,g:window.__G,cam:{yaw:window.__cam.yaw,pitch:window.__cam.pitch,dist:window.__cam.dist,tgt:window.__cam.tgt.toArray()}}));
  for(const key of ['t','x','y','z','vx','vy','vz','warp','paused','focus','uiMode','cabin','predict','gr'])assert.deepEqual(restored.g[key],saved.g[key],`restored ${key}`);
  assert.deepEqual(restored.cam,saved.cam,'restored camera');
  assert.deepEqual(restored.log,saved.log,'no permanent excursion discoveries or records');assert.equal(restored.objectives,saved.objectives,'no permanent excursion achievements');
  await page.evaluate(()=>window.__scenarioFrame(0));
  await page.evaluate(async()=>{const {river}=await import('/src/river.js');if(river.presentationGain!==1)throw Error('Exit must restore natural-flow display gain even when the field is hidden');});
  const bounds=await page.locator('#scenarioPlayback').evaluate(el=>({hidden:el.hidden,width:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(bounds.hidden&&bounds.width===bounds.viewport,'hidden panel and no horizontal overflow');
  report.push({label,frames,restored:true});await page.close();
 }
 assert.deepEqual(errors,[]);await writeFile(resolve(out,'report.json'),JSON.stringify({report,errors},null,2));console.log(JSON.stringify({pass:true,viewports:report.map(x=>x.label),frames:report.map(x=>x.frames.length),errors}));
} finally {await browser.close();await server.close();}
