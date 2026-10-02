// Actual application, materials, lighting, camera and UI; deterministic stepping only.
// BASE_ROOT=/path/to/baseline DEVICE=mobile ARTEMIS_EVIDENCE=/path node scripts/verify-ship-appearance.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(process.env.BASE_ROOT || '.');
const mobile = process.env.DEVICE === 'mobile';
const out = resolve(process.env.ARTEMIS_EVIDENCE || `evidence/ship-${mobile ? 'mobile' : 'desktop'}`);
await mkdir(out, { recursive: true });
const report = { revision: execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root,encoding:'utf8'}).trim(), mobile, omissions: [], errors: [], checks: [], frames: [] };
const check = (pass, name) => { report.checks.push({name,pass:!!pass}); assert(pass,name); };
const server = await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'ship-qa',enforce:'pre',transform(source,id){
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 const marker='const firstFrameT0 = perfStart();'; assert.equal(source.split(marker).length,2);
 return source.replace(marker,'G.t=0;G.paused=true;resetEphem();clock.getDelta=()=>1/60;'+marker).replace('renderer.setAnimationLoop(frame);','')+'\nwindow.__shipFrame=()=>{clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;frame();renderer.getContext().finish();};';
}}]});
await server.listen();
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage({viewport:mobile?{width:430,height:932}:{width:1280,height:820},isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1});page.setDefaultTimeout(180000);
 await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','pilot');Date.now=()=>Date.UTC(2026,9,2,12);});
 page.on('pageerror',e=>report.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=ship&dist=.12&hidehelp=1&compile=0`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__shipFrame);
 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js');const {shipG}=await import('/src/ship.js');__G.heading=0;__G.pitch=0;__G.hold=null;__shipFrame();cam.tgt.copy(shipG.position);});
 const frames=async(n=2)=>{for(let i=0;i<n;i++)await page.evaluate(()=>__shipFrame());};
 const capture=async(name,dist,yaw,pitch)=>{await page.evaluate(async({dist,yaw,pitch})=>{const {cam}=await import('/src/scene.js');const {shipG}=await import('/src/ship.js');cam.tgt.copy(shipG.position);cam.dist=dist;cam.distTarget=null;cam.yaw=yaw;cam.pitch=pitch;},{dist,yaw,pitch});await frames(2);await page.screenshot({path:`${out}/${name}.png`,timeout:180000});const state=await page.evaluate(async()=>{const {cam,camera,renderer,renderQuality}=await import('/src/scene.js');const {craft,shipG}=await import('/src/ship.js');let meshes=0,triangles=0,bytes=0;const geoms=new Set(),mats=new Set();craft.traverse(o=>{if(!o.isMesh)return;meshes++;mats.add(o.material);geoms.add(o.geometry);triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;});for(const g of geoms){bytes+=g.index?.array.byteLength||0;for(const a of Object.values(g.attributes))bytes+=a.array.byteLength;}return{cleanRender:document.body.classList.contains('mode-clean'),projectedCenter:shipG.position.clone().project(camera).toArray(),cam:{dist:cam.dist,yaw:cam.yaw,pitch:cam.pitch},visible:shipG.visible,scale:craft.scale.x,meshes,materials:mats.size,triangles,bytes,renderQuality:{...renderQuality},memory:{...renderer.info.memory}};});check(state.projectedCenter.every(Number.isFinite)&&Math.abs(state.projectedCenter[0])<.15&&Math.abs(state.projectedCenter[1])<.15&&Math.abs(state.projectedCenter[2])<1,`${name}: ship is visibly centered in the viewport`);report.frames.push({name,...state});await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('CAPTURE',name,state);};
 await capture('three-quarter',.12,.85,.36);
 await capture('underside',.12,-.85,.36);
 await capture('side',.12,-Math.PI/2,.05);
 await capture('rear',.12,Math.PI-.65,.28);
 await capture('flight-scale',2.6,.85,.36);
 await capture('close-inspection',.05,.85,.36);
 await page.evaluate(async()=> (await import('/src/cinematic.js')).setCleanRender(true));
 await capture('fitted-close-clean',mobile?.09:.065,.85,.36);
 await page.evaluate(async()=> (await import('/src/cinematic.js')).setCleanRender(false));
 const resources=await page.evaluate(async()=>{const {craft}=await import('/src/ship.js');return (()=>{const a=[];craft.traverse(o=>{if(o.isMesh)a.push([o.id,o.geometry.id,o.material.id]);});return a;})();});
 check(await page.evaluate(async()=> (await import('/src/ship.js')).shipG.visible),'Pilot exterior is visible');
 await page.keyboard.press('j');await frames();check(await page.evaluate(()=>__G.cabin),'Cockpit toggles on');check(await page.evaluate(async()=>!(await import('/src/ship.js')).shipG.visible),'Exterior is hidden in cockpit');
 await page.keyboard.press('j');await frames();check(await page.evaluate(async()=>!__G.cabin&&(await import('/src/ship.js')).shipG.visible),'Cockpit toggles back without losing exterior');
 await page.locator('[data-ui-mode="observe"]').click();await frames();check(await page.evaluate(async()=>!(await import('/src/ship.js')).shipG.visible),'Observe mode hides ship');
 await page.locator('[data-ui-mode="pilot"]').click();await frames();check(await page.evaluate(async()=> (await import('/src/ship.js')).shipG.visible),'Returning to pilot restores ship');
 for(let i=0;i<3;i++) {await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('j');await frames();await page.keyboard.press('j');await frames();}
 check(await page.evaluate(async resources=>{const {craft}=await import('/src/ship.js');const a=[];craft.traverse(o=>{if(o.isMesh)a.push([o.id,o.geometry.id,o.material.id]);});return JSON.stringify(a)===JSON.stringify(resources);},resources),'Repeated cockpit transitions reuse exact mesh, geometry and material resources');
 await page.evaluate(async()=>{document.activeElement?.blur();(await import('/src/input.js')).setFocus('ship');__G.paused=false;__G.warp=1;});await page.keyboard.down('w');await frames(2);
 check(await page.evaluate(async()=>{const {flame,exhaust}=await import('/src/ship.js');return flame.visible&&exhaust.visible&&__G.dvUsed>0;}),'Real W thrust activates existing flame, particles and physics');
 await capture('conventional-thrust',.12,.85,.36);
 await page.keyboard.up('w');await frames();check(await page.evaluate(async()=>!(await import('/src/ship.js')).flame.visible),'Releasing W turns off the flame');await page.evaluate(()=>{__G.paused=true;});
 const saved=await page.evaluate(async()=>{const saves=await import('/src/saves.js');const before={heading:__G.heading,pitch:__G.pitch,x:__G.x,y:__G.y,z:__G.z};const ok=saves.saveState();__G.heading+=.5;const loaded=await saves.loadState();__G.paused=true;return{ok,loaded,unchanged:Object.entries(before).every(([k,v])=>__G[k]===v)};});
 check(saved.ok&&saved.loaded&&saved.unchanged,'Quicksave/load round trip preserves the existing flight state');await frames();
 check(await page.evaluate(async resources=>{const {craft}=await import('/src/ship.js');const a=[];craft.traverse(o=>{if(o.isMesh)a.push([o.id,o.geometry.id,o.material.id]);});return JSON.stringify(a)===JSON.stringify(resources);},resources),'Quicksave/load does not rebuild exterior resources');
 check(report.errors.length===0,'No JavaScript, shader or console errors');
} finally { await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close(); }
