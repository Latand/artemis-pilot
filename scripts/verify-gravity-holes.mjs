// Real application controls, production flow shaders, and a deterministic clock.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {mkdir,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
// Explicit frame() calls intentionally bypass live RAF admission. The caller
// resets the phase pacer and must prove that one real render was produced;
// a synchronous pixel readback owns GPU serialization for this small fixture.
const HOLE_FRAME_HOOK = `
const holeQAReadback = new Uint8Array(4);
window.__holeFrame = () => {
 const gl = renderer.getContext();
 if (renderContext.isLost() || gl.isContextLost()) throw Error('Force fixture requires a healthy render context');
 const before = renderSubmissionSerial;
 clock.getDelta = () => 1/60;
 lastMobileFrame = -Infinity;
 frame();
 if (renderSubmissionSerial !== before + 1) throw Error('Force fixture did not produce exactly one render');
 if (renderContext.isLost() || gl.isContextLost()) throw Error('Force fixture lost context during render');
 gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,holeQAReadback);
 if (renderContext.isLost() || gl.isContextLost()) throw Error('Force fixture lost context during readback');
 if (gl.getError() !== gl.NO_ERROR) throw Error('Force fixture readback has a WebGL error');
 return { before, after: renderSubmissionSerial, pixel: Array.from(holeQAReadback) };
};
`;
function transformHoleMain(source) {
 const marker='const firstFrameT0 = perfStart();',loop='renderer.setAnimationLoop(frame);';
 assert.equal(source.split(marker).length,2,'Exact startup fixture seam');
 assert.equal(source.split(loop).length,2,'Exactly one live loop is disabled');
 return source.replace(marker,'G.t=0;G.paused=true;G.gr=true;grB=1;resetEphem();clock.getDelta=()=>1/60;'+marker)
  .replace(loop,'')+HOLE_FRAME_HOOK;
}
if(process.argv.includes('--validate')){
 const main=readFileSync(new URL('../src/main.js',import.meta.url),'utf8'),transformed=transformHoleMain(main);
 assert(!transformed.includes('renderer.setAnimationLoop(frame);'));
 execFileSync(process.execPath,['--check','--input-type=module'],{input:transformed});
 const start=main.indexOf('function frame() {'),end=main.indexOf('function frameStep() {',start);
 assert(start>=0&&end>start,'Actual production frame wrapper is available');
 const wrapper=main.slice(start,end);
 function fixture(mode='healthy'){
  const events=[],buffers=[],gl={lost:mode==='lost-before',NO_ERROR:0,RGBA:0x1908,UNSIGNED_BYTE:0x1401,
   isContextLost(){return this.lost;},getError(){return mode==='gl-error'?0x0502:0;},
   finish(){throw Error('Do not substitute a blind finish for an observed frame');},
   readPixels(x,y,w,h,format,type,buffer){
    assert.deepEqual([x,y,w,h,format,type],[0,0,1,1,this.RGBA,this.UNSIGNED_BYTE]);assert.equal(buffer.byteLength,4);
    buffers.push(buffer);events.push('readback');buffer.set([17,23,41,255]);if(mode==='lost-read')this.lost=true;
   }};
  const c={window:{},clock:{getDelta:()=>0},lastMobileFrame:100,renderSubmissionSerial:7,renderer:{getContext:()=>gl},
   renderContext:{isLost:()=>gl.lost},VR:{active:false},performance:{now:()=>100},
   document:{hidden:false,getElementById:()=>({style:{display:'none'}})},
   renderFrameGate:{stats:{stalled:true},ready(){throw Error('Explicit QA call must not poll live admission');},submitted(){throw Error('Explicit QA call owns completion');}}};
  c.frameStep=()=>{events.push('frame');assert.equal(c.lastMobileFrame,-Infinity);assert.equal(c.clock.getDelta(),1/60);
   if(mode==='render-error')throw Error('Original render error');
   if(mode!=='no-frame')c.renderSubmissionSerial+=mode==='double-frame'?2:1;
   if(mode==='lost-frame')gl.lost=true;
  };
  vm.createContext(c);vm.runInContext(wrapper+HOLE_FRAME_HOOK,c);
  return {c,events,buffers,run:()=>c.window.__holeFrame()};
 }
 const healthy=fixture();
 for(let i=0;i<3;i++){const result=healthy.run();assert.equal(result.before,7+i);assert.equal(result.after,8+i);assert.deepEqual([...result.pixel],[17,23,41,255]);}
 assert.deepEqual(healthy.events,['frame','readback','frame','readback','frame','readback']);
 assert(healthy.buffers.every(buffer=>buffer===healthy.buffers[0]),'Readback reuses one typed array');
 for(const mode of ['no-frame','double-frame','lost-before','lost-frame','lost-read','gl-error','render-error']){
  const f=fixture(mode);assert.throws(f.run,mode==='render-error'?/Original render error/:/Force fixture/);
  if(['no-frame','double-frame','lost-before','lost-frame','render-error'].includes(mode))assert.equal(f.buffers.length,0);
 }
 assert.throws(()=>transformHoleMain(main.replace('renderer.setAnimationLoop(frame);','')),/live loop/);
 assert.throws(()=>transformHoleMain(main.replace('const firstFrameT0 = perfStart();','')),/startup fixture seam/);
 console.log('Gravity-hole fixture: actual explicit wrapper, exact render count, reused completed readback, no-frame/double-frame/context-loss/GL-error negatives and deferred-startup transform passed. No GPU execution claimed.');
 process.exit(0);
}
const device=process.env.DEVICE||'desktop',mobile=device!=='desktop',out=process.env.ARTEMIS_EVIDENCE||'evidence/gravity-inspector';
await mkdir(out,{recursive:true});
const report={revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),device,checks:[],producedFrames:[],errors:[],omissions:['AT-HYG streaming','procedural resolved field','HYG background'],scope:'Software Chromium behavioral verification, not a hardware performance benchmark'};
const check=(ok,name)=>{report.checks.push({name,pass:!!ok});assert(ok,name);console.log('PASS',name);};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'hole-explanation-qa',enforce:'pre',transform(source,id){
 if(id.split('?')[0].endsWith('/src/river.js'))return source+'\nexport function holeQAUniforms(){return bodyVals.slice(3+PL.length,3+PL.length+BH.n).map(v=>v.toArray());}';
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 return transformHoleMain(source);
}}]});await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:device==='landscape'?{width:568,height:320}:mobile?{width:430,height:932}:{width:1100,height:760},isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1});page.setDefaultTimeout(120000);
 await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');Date.now=()=>Date.UTC(2026,9,6,10);});
 page.on('pageerror',e=>report.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error'&&/THREE|Shader|GL_INVALID/.test(m.text()))report.errors.push(m.text());});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=earth&dist=25&hidehelp=1&tier1=0&field=0&realsky=0&bloom=0&compile=0`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__holeFrame);
 const frame=async()=>{const produced=await page.evaluate(()=>__holeFrame());report.producedFrames.push(produced);return produced;};
 await page.evaluate(async()=>{
  const {G,WORLD}=await import('/src/state.js'),{addBlackHole}=await import('/src/blackholes.js'),{cam}=await import('/src/scene.js');
  WORLD.earthDestroyed=WORLD.moonDestroyed=WORLD.sunDestroyed=true;WORLD.plDestroyed.fill(true);G.darkMatter=G.darkEnergy=false;
  addBlackHole(1e8,1e8,3000,2,3,true,null,0,0,1e6,4);
  addBlackHole(1.02e8,1.01e8,6000,-3,1,true,null,0,0,2e6,-2);
  addBlackHole(.99e8,1.03e8,9000,1,-2,true,null,0,0,-1e6,3);
  G.focus='bh:0';G.gr=true;G.paused=true;cam.dist=6000;cam.distTarget=null;cam.yaw=-.4;cam.pitch=.72;
 });await frame();await frame();
 const inspect=()=>page.evaluate(async()=>{
  const s=(await import('/src/gravityInspection.js')).getLocalGravityInspection(__G.focus);
  const paths=[...document.querySelectorAll('#gravityContributionVectors>g')].filter(g=>g.style.display!=='none').map(g=>({id:g.dataset.sourceId,a:JSON.parse(g.dataset.acceleration),d:g.querySelector('path').getAttribute('d')}));
  return {s,paths,net:JSON.parse(document.querySelector('#gravityNetVector>path').dataset.acceleration),weights:(await import('/src/river.js')).holeQAUniforms().map(v=>v[3]),obs:Array.from(__BH.obsT).slice(0,__BH.n)};
 });
 const a=await inspect();
 check(await page.locator('#gravityInspector').evaluate(e=>!e.open),'Explanation works with Gravity collapsed');
 check(a.paths.length===2&&a.paths.every(p=>p.id!=='bh:0'),'Both other-hole scene directions are drawn; self is absent');
 const unobscured=expected=>page.evaluate(expected=>{
  const cues=[...document.querySelectorAll('.gravityForceCue')].filter(e=>!e.hidden);
  return cues.length===expected&&cues.every(e=>{
   const r=e.getBoundingClientRect(),label=e.firstElementChild.getBoundingClientRect();
   if(!(r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&e.scrollWidth<=e.clientWidth+1&&label.left>=r.left&&label.right<=r.right))return false;
   return [[r.left+4,r.top+4],[r.right-4,r.top+4],[r.left+4,r.bottom-4],[r.right-4,r.bottom-4],[(r.left+r.right)/2,(r.top+r.bottom)/2]]
    .every(([x,y])=>e.contains(document.elementFromPoint(x,y)));
  });
 },expected);
 check(await unobscured(3),'Full contributor and net labels and directions are unclipped and unobscured');
 check(a.paths.every(p=>JSON.stringify(p.a)===JSON.stringify(a.s.contributions.find(r=>r.id===p.id).acceleration)),'Contribution arrows use exact solver vectors');
 check(a.net.every((v,i)=>Math.abs(v-a.s.net[i])<1e-12*Math.max(1,Math.abs(v))),'Net arrow includes the complete solver ledger');
 check(await page.evaluate(()=>__river.sourceCount>=3+__BH.n),'Full ambient source inventory remains present');
 await page.screenshot({path:`${out}/${device}-three-hole-forces.png`,timeout:180000});
 await page.evaluate(async()=>{const {addBlackHole}=await import('/src/blackholes.js');for(let i=0;i<3;i++)addBlackHole(1.04e8+i*1e6,.97e8-i*1e6,12000+i*1000,0,0,true,null,0,0,(i+3)*1e6);});await frame();
 check(await unobscured(6),'Six-hole maximum keeps all five partner cues and the net fully readable');
 await page.screenshot({path:`${out}/${device}-six-hole-forces.png`,timeout:180000});
 await page.evaluate(async()=>{const {removeHoleData}=await import('/src/bhEncounters.js');while(__BH.n>3)removeHoleData(__BH.n-1);});await frame();
 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js');cam.yaw+=.7;cam.pitch=.35;cam.dist=3000;cam.distTarget=null;});await frame();
 const b=await inspect();
 check(JSON.stringify(a.s)===JSON.stringify(b.s)&&JSON.stringify(a.weights)===JSON.stringify(b.weights),'Paused camera changes preserve solver vectors and GPU gravitational weights');
 check(a.paths.some((p,i)=>p.d!==b.paths[i]?.d),'Camera changes reproject explanatory directions');
 await page.evaluate(async()=>{const {advanceBodiesOnly}=await import('/src/physics.js');advanceBodiesOnly(.01);});await frame();
 const moved=await inspect();check(JSON.stringify(moved.s.position)!==JSON.stringify(b.s.position)&&JSON.stringify(moved.paths[0].a)!==JSON.stringify(b.paths[0].a),'Moving holes refresh explanatory origins and contributions while collapsed');
 for(const focus of ['bh:0','bh:2']){
  check(await page.evaluate(async focus=>{const {saveState,loadState}=await import('/src/saves.js');__G.focus=focus;if(!saveState())return false;__G.focus='ship';return await loadState()&&__G.focus===focus&&__BH.n===3;},focus),`Quickload restores ${focus} while replacing an existing hole inventory`);
 }await page.evaluate(()=>{__G.focus='bh:0';});await frame();
 await page.locator('#gravityInspector>summary').click();await frame();
 check((await page.locator('.gravityModel').first().innerText()).includes('qualitative field'),'Panel distinguishes actual acceleration from qualitative Time Pulses');
 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js'),{LY_KM,K}=await import('/src/constants.js');cam.dist=3e4*LY_KM*K;cam.distTarget=null;});await frame();
 check(await page.locator('.gravityScope').innerText()==='Local'&&await page.evaluate(()=>__G.focus==='bh:0'),'Scale change retains selected-hole force scope and identity');
 await page.evaluate(async()=>{
  const {cam}=await import('/src/scene.js'),{mergeByDistance}=await import('/src/bhEncounters.js');cam.dist=6000;cam.distTarget=null;
  __G.focus='bh:1';__BH.x[1]=__BH.x[0]+100;__BH.y[1]=__BH.y[0];__BH.z[1]=__BH.z[0];mergeByDistance(__G.t);
 });await frame();
 const merged=await inspect();check(await page.evaluate(()=>__BH.n===2&&__G.focus==='bh:0'),'Selected absorbed hole follows the merger survivor');
 check(merged.paths.length===1&&merged.paths[0].id==='bh:1','Merger removes stale contribution identity and redraws the remaining partner');
 await page.screenshot({path:`${out}/${device}-merged-hole-forces.png`,timeout:180000});
 await page.locator('#gravityInspector>summary').click();await frame();
 await page.evaluate(()=>{__G.gr=false;});await frame();
 check(await page.locator('#gravityNetVector').evaluate(e=>e.style.display==='none'),'Closing Gravity and disabling flow hides the automatic explanation');
 check(report.errors.length===0,'No runtime or shader errors');
}finally{await writeFile(`${out}/${device}-holes-report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
