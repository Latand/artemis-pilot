// Actual application rendering; deterministic display clock and production
// integrator samples. Omits catalog backgrounds, not black-hole renderers.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const FRAME_HOOK = `
const trailQAReadback = new Uint8Array(4);
window.__trailReadback = () => {
 const gl=renderer.getContext();
 if(renderContext.isLost()||gl.isContextLost())throw Error('Trail fixture lost render context');
 gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,trailQAReadback);
 if(renderContext.isLost()||gl.isContextLost()||gl.getError()!==gl.NO_ERROR)throw Error('Trail fixture readback failed');
 return Array.from(trailQAReadback);
};
window.__trailFrame=()=>{
 if(renderContext.isLost()||renderer.getContext().isContextLost())throw Error('Trail fixture requires a healthy context');
 const before=renderSubmissionSerial;clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;frame();
 if(renderSubmissionSerial!==before+1)throw Error('Trail fixture did not produce exactly one render');
 return {before,after:renderSubmissionSerial,pixel:window.__trailReadback()};
};`;
function transformMain(source){
 const marker='const firstFrameT0 = perfStart();',loop='renderer.setAnimationLoop(frame);';
 assert.equal(source.split(marker).length,2);assert.equal(source.split(loop).length,2);
 return source.replace(marker,'G.t=0;G.paused=true;resetEphem();clock.getDelta=()=>1/60;'+marker).replace(loop,'')+FRAME_HOOK;
}
if(process.argv.includes('--validate')){
 const source=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
 execFileSync(process.execPath,['--check','--input-type=module'],{input:transformMain(source)});
 const wrapper=source.slice(source.indexOf('function frame() {'),source.indexOf('function frameStep() {'));
 for(const mode of ['healthy','no-frame','double-frame','lost','gl-error']){
  const gl={NO_ERROR:0,RGBA:6408,UNSIGNED_BYTE:5121,isContextLost:()=>mode==='lost',getError:()=>mode==='gl-error'?1282:0,readPixels(_x,_y,_w,_h,_f,_t,a){a.set([1,2,3,255]);}};
  const c={window:{},renderer:{getContext:()=>gl},renderContext:{isLost:()=>mode==='lost'},VR:{active:false},renderSubmissionSerial:7,clock:{},lastMobileFrame:0};
  c.frameStep=()=>{c.renderSubmissionSerial+=mode==='no-frame'?0:mode==='double-frame'?2:1;};vm.createContext(c);vm.runInContext(wrapper+FRAME_HOOK,c);
  if(mode==='healthy')assert.deepEqual(JSON.parse(JSON.stringify(c.window.__trailFrame())),{before:7,after:8,pixel:[1,2,3,255]});else assert.throws(()=>c.window.__trailFrame(),/Trail fixture/);
 }
 console.log('PASS trail fixture proves one explicit production frame and completed readback, rejecting skipped/doubled/lost/error draws');process.exit(0);
}
const mobile=process.env.DEVICE==='mobile',device=mobile?'mobile':'desktop',out=process.env.ARTEMIS_EVIDENCE||'evidence/black-hole-trails';
await mkdir(out,{recursive:true});
const report={revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),device,checks:[],producedFrames:[],errors:[],scope:'Software Chromium behavioral and appearance verification; no hardware performance claim',omissions:['AT-HYG streaming','procedural resolved field','HYG background','bloom']};
function check(ok,name){report.checks.push({name,pass:!!ok});assert(ok,name);console.log('PASS',name);}
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'hole-trails-fixture',enforce:'pre',transform(source,id){
 if(id.split('?')[0].endsWith('/src/render/blackHoleTrails.js'))return source.replace('now = performance.now() / 1000','now = window.__trailWall ?? performance.now() / 1000');
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 return transformMain(source);
}}]});await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:mobile?{width:430,height:932}:{width:1100,height:760},isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1});page.setDefaultTimeout(180000);
 await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');window.__trailWall=0;});
 page.on('pageerror',e=>report.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error'&&/THREE|Shader|GL_INVALID/.test(m.text()))report.errors.push(m.text());});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=earth&dist=25&hidehelp=1&tier1=0&field=0&realsky=0&bloom=0&compile=0&quality=high`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__trailFrame);
 const frame=async()=>{const result=await page.evaluate(()=>__trailFrame());report.producedFrames.push(result);return result;};
 const status=()=>page.evaluate(async()=>{const {BH_META}=await import('/src/blackholes.js');return BH_META.map(m=>({count:m.trail?.path.history.count,segments:m.trail?.mesh.geometry.instanceCount,visible:m.trail?.mesh.visible,lifetime:m.trail?.path.lifetime,head:Array.from(m.trail?.path.history.head||[]),points:Array.from(m.trail?.path.history.points||[])}));});
 await page.evaluate(async()=>{
  const {G,WORLD}=await import('/src/state.js'),{addBlackHole}=await import('/src/blackholes.js'),{cam}=await import('/src/scene.js'),{eph}=await import('/src/ephemeris.js');
  WORLD.earthDestroyed=WORLD.moonDestroyed=WORLD.sunDestroyed=true;WORLD.plDestroyed.fill(true);G.darkMatter=G.darkEnergy=G.gr=false;
  const {TRAIL_FIXTURE:f}=await import('/scripts/black-hole-trail-fixture.mjs');
  for(const [x,y,z,rs,vx,vy,vz] of f.holes)addBlackHole(x,y,rs,vx-eph.earthVx,vy-eph.earthVy,true,null,0,0,z,vz);
  G.focus='bh:0';G.paused=true;G.warp=1;Object.assign(cam,f.camera);cam.distTarget=null;
 });await frame();await frame();
 check((await status()).every(s=>!s.visible),'New stationary history starts without an invented tail');
 await page.evaluate(async()=>{
  const {G,BH}=await import('/src/state.js'),{cam,applyCamera,camera}=await import('/src/scene.js'),{advanceBodiesOnly}=await import('/src/physics.js'),{updateBHVisuals}=await import('/src/blackholes.js'),{eph}=await import('/src/ephemeris.js'),{K}=await import('/src/constants.js');
  const {TRAIL_FIXTURE:f}=await import('/scripts/black-hole-trail-fixture.mjs');
  G.paused=false;
  for(let i=0;i<f.steps;i++){window.__trailWall+=f.step;advanceBodiesOnly(f.step);cam.tgt.set((eph.earthX+BH.x[0])*K,BH.z[0]*K,-(eph.earthY+BH.y[0])*K);applyCamera();camera.updateMatrixWorld();updateBHVisuals(1/12,eph.earthX*K,-eph.earthY*K);}
  G.paused=true;
 });await frame();
 const moving=await status();report.moving=moving.map(({points,...s})=>s);
 check(moving.length===3&&moving.every(s=>s.visible&&s.segments>1&&s.count<=256),'All three physical histories render, including unselected holes');
 check(moving.every(s=>s.lifetime>10),'Slow motion uses longer retention');
 check(await page.evaluate(async()=>{const {BH_META}=await import('/src/blackholes.js'),{camera}=await import('/src/scene.js');return BH_META.every(m=>{const p=m.g.position.clone().project(camera);return Math.abs(p.x)<.8&&Math.abs(p.y)<.8&&p.z<1;});}),'All three holes are inside the desktop/mobile camera view');
 await page.screenshot({path:`${out}/${device}-three-slow-holes.png`,timeout:180000});
 for(const quality of ['low','minimal']){
  await page.evaluate(async quality=>(await import('/src/scene.js')).setQualityMode(quality),quality);await frame();
  const low=await status();check(low.every((s,i)=>s.visible&&JSON.stringify(s.points)===JSON.stringify(moving[i].points)),`${quality} quality preserves every measured trail`);
  await page.screenshot({path:`${out}/${device}-${quality}-trails.png`,timeout:180000});
 }
 await page.evaluate(async()=>(await import('/src/scene.js')).setQualityMode('high'));await frame();

 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js');cam.yaw+=.4;cam.dist*=.8;window.__trailWall+=600;});await frame();
 const paused=await status();
 check(moving.every((s,i)=>JSON.stringify(s.points)===JSON.stringify(paused[i].points)&&s.count===paused[i].count),'Paused orbit / zoom / elapsed wall time preserve actual history');
 await page.screenshot({path:`${out}/${device}-paused-camera.png`,timeout:180000});
 await page.evaluate(async()=>{
  const {BH_META}=await import('/src/blackholes.js'),{holeRoot}=await import('/src/holeOptics.js');
  window.__trailDraws=[];
  for(const m of BH_META)m.trail.mesh.onBeforeRender=(_renderer,root)=>window.__trailDraws.push(root===holeRoot);
  await import('/src/lensing.js');
 });await frame();await frame();
 check(await page.evaluate(async()=>{
  const {lensingPass}=await import('/src/lensing.js');return lensingPass.enabled&&window.__trailDraws.length>0&&window.__trailDraws.every(Boolean);
 }),'Lens-enabled direct rendering keeps measured tails in the unbent hole pass');
 await page.screenshot({path:`${out}/${device}-lensed-trails.png`,timeout:180000});
 // Combined release guard: the live measured histories and actual river
 // must both submit on one completed frame, in their different lens passes.
 await page.evaluate(async()=>{
  const {G}=await import('/src/state.js'),{scene}=await import('/src/scene.js');
  const lines=[];scene.traverse(o=>{if(o.isLineSegments&&o.geometry?.attributes.ref)lines.push(o);});
  if(lines.length!==1)throw Error('Expected exactly one production river line object');
  const line=lines[0],old=line.onBeforeRender;window.__coexistenceRiverDraws=0;window.__trailDraws=[];
  line.onBeforeRender=function(...args){old.apply(this,args);window.__coexistenceRiverDraws++;};
  window.__restoreCoexistence=()=>{line.onBeforeRender=old;G.gr=false;};G.gr=true;
 });await frame();await frame();
 const coexistence=await page.evaluate(async()=>{
  const {renderer}=await import('/src/scene.js'),{river}=await import('/src/river.js'),{lensingPass}=await import('/src/lensing.js');
  window.__coexistenceRiverDraws=0;window.__trailDraws=[];
  const produced=window.__trailFrame();
  return {produced,riverVisible:river.visible,riverDraws:window.__coexistenceRiverDraws,
   unbentTrailDraws:window.__trailDraws.slice(),lensing:lensingPass.enabled,png:renderer.domElement.toDataURL('image/png')};
 });report.producedFrames.push(coexistence.produced);
 await writeFile(`${out}/${device}-trails-with-river.png`,Buffer.from(coexistence.png.split(',')[1],'base64'));delete coexistence.png;report.coexistence=coexistence;
 check(coexistence.lensing&&coexistence.riverVisible&&coexistence.riverDraws>0&&coexistence.unbentTrailDraws.length>=3&&coexistence.unbentTrailDraws.every(Boolean),'Same completed lens-enabled frame draws the river and all three unbent measured trails');
 const withRiver=await status();check(withRiver.every((s,i)=>s.visible&&JSON.stringify(s.points)===JSON.stringify(paused[i].points)),'Toggling river ink cannot mutate measured trail histories');
 await page.evaluate(()=>window.__restoreCoexistence());await frame();
 await page.evaluate(async()=>{
  const s=await import('/src/scene.js'),lens=await import('/src/lensing.js');
  await s.ensurePostProcessing(lens.lensingPass);s.bloomPass.enabled=true;
  window.__trailDraws=[];lens.updateLensing(s.camera,s.camera.aspect);s.composer.render();window.__trailReadback();
 });
 check(await page.evaluate(()=>window.__trailDraws.length>0&&window.__trailDraws.every(Boolean)),'Bloom composer also renders trails only in the unbent hole pass');
 await page.screenshot({path:`${out}/${device}-bloom-lensed-trails.png`,timeout:180000});
 await page.evaluate(async()=>{const {BH_META}=await import('/src/blackholes.js');for(const m of BH_META)m.trail.mesh.onBeforeRender=()=>{};});

 await page.evaluate(async()=>{const {G}=await import('/src/state.js'),{saveState,loadState}=await import('/src/saves.js');saveState();await loadState();G.paused=true;});await frame();
 check((await status()).every(s=>!s.visible&&s.count<=1),'Quickload discards ephemeral paths instead of joining restored states');
 await page.evaluate(async()=>{
  const {G,BH}=await import('/src/state.js'),{cam,applyCamera,camera}=await import('/src/scene.js'),{advanceBodiesOnly}=await import('/src/physics.js'),{updateBHVisuals}=await import('/src/blackholes.js'),{eph}=await import('/src/ephemeris.js'),{K}=await import('/src/constants.js');G.paused=false;
  for(let i=0;i<24;i++){window.__trailWall+=1/12;advanceBodiesOnly(1/12);cam.tgt.set((eph.earthX+BH.x[0])*K,BH.z[0]*K,-(eph.earthY+BH.y[0])*K);applyCamera();camera.updateMatrixWorld();updateBHVisuals(1/12,eph.earthX*K,-eph.earthY*K);}G.paused=true;
 });await frame();
 const preRemove=await status();await page.evaluate(async()=>{const {removeHoleData}=await import('/src/bhEncounters.js');removeHoleData(1);});await frame();
 const removed=await status();check(removed.length===2&&JSON.stringify(removed[1].points)===JSON.stringify(preRemove[2].points),'Removal compacts identity without swapping surviving histories');
 await page.evaluate(async()=>{const {BH,G}=await import('/src/state.js'),{mergeByDistance}=await import('/src/bhEncounters.js');BH.x[1]=BH.x[0]+.001;BH.y[1]=BH.y[0];BH.z[1]=BH.z[0];mergeByDistance(G.t);});await frame();
 check((await status()).length===1&&!(await status())[0].visible,'Merger disposes old tails and seeds a fresh survivor');
 await page.evaluate(async()=>{const {G}=await import('/src/state.js');G.warp=-1;});await frame();check((await status()).every(s=>!s.visible&&s.count===0),'Reverse clears history while paused');
 await page.evaluate(async()=>{const {clearBlackHoles}=await import('/src/blackholes.js');clearBlackHoles();});await frame();
 check(await page.evaluate(async()=>!(await import('/src/holeOptics.js')).holeRoot.children.some(o=>o.name==='blackHole.recentMotion')),'Clear releases every trail object');
 check(report.errors.length===0,'No runtime / shader errors');
}finally{await writeFile(`${out}/${device}-report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
