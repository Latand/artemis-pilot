// Exact-source paired diagnostic: identical recorded camera workload, clock,
// native WASD input, viewport and software renderer. Baseline has no foreign
// provider/targets, so this is deliberately NOT identical object content.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const args = process.argv.slice(2).filter(value => !value.startsWith('--'));
const head = resolve(args[0] || '.'), base = resolve(process.env.BASE_ROOT || '');
assert(process.env.BASE_ROOT, 'BASE_ROOT must identify an exact baseline worktree');
const out = resolve(args[1] || 'evidence/galaxy-travel-paired');
const workload = JSON.parse(await readFile(new URL('./galaxy-travel-timing-fixtures.json', import.meta.url), 'utf8'));
const orders = ['ABBA', 'BAAB'], warmup = 4, samples = 12;
const query = '?tier1=0&river=0&bloom=0&compile=0&hidehelp=1&dpr=1&perf=1&galadapt=0';
function transform(source, id) {
    if (!id.replaceAll('\\','/').endsWith('/src/main.js')) return;
    assert(source.includes('renderer.setAnimationLoop(frame);'));
    return source.replace('renderer.setAnimationLoop(frame);', '') + `
const qaReadback = new Uint8Array(4);
window.__pairedTravelFrame = () => {
 clock.getDelta=()=>1/30;lastMobileFrame=-Infinity;PERF.last=Object.create(null);
 const gl=renderer.getContext(), ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
 const timer=ext ? gl.createQuery() : null;
 if(timer)gl.beginQuery(ext.TIME_ELAPSED_EXT,timer);
 const start=performance.now();frame();const submissionMs=performance.now()-start;
 if(timer)gl.endQuery(ext.TIME_ELAPSED_EXT);
 const finishStart=performance.now();gl.finish();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,qaReadback);
 const readbackMs=performance.now()-finishStart;
 let gpuElapsedMs=null;
 if(timer){if(gl.getQueryParameter(timer,gl.QUERY_RESULT_AVAILABLE)&&!gl.getParameter(ext.GPU_DISJOINT_EXT))gpuElapsedMs=gl.getQueryParameter(timer,gl.QUERY_RESULT)/1e6;gl.deleteQuery(timer);}
 return {submissionMs,readbackMs,totalMs:performance.now()-start,gpuTimerSupported:!!ext,gpuElapsedMs,
  stages:Object.fromEntries(Object.entries(PERF.last).map(([k,v])=>[k,v.ms])),renderInfo:{...PERF.renderInfo},camera:camera.position.toArray(),frameNo};
};`;
}
for (const root of [base, head]) {
    const code = await readFile(resolve(root, 'src/main.js'), 'utf8');
    execFileSync(process.execPath, ['--input-type=module','--check'], {input:transform(code,'/src/main.js')});
}
if(process.argv.includes('--validate')){console.log('matched travel hooks validated for exact baseline and candidate');process.exit(0);}
await mkdir(out,{recursive:true});
const revision = root => execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const report = {version:1,baseline:revision(base),head:revision(head),query,viewport:{width:1100,height:760},workload,orders,warmup,samples,
 absoluteTargetMs:50,absoluteTargetPass:false,acceptance:'Diagnostic only; functional route, final images and absolute transition target remain separate gates.',
 timingMeaning:'submissionMs includes browser/driver blocking, not pure JS compute; readbackMs establishes GPU completion. gpuElapsedMs is only populated when an undisjoint hardware timer query is available.',
 errors:[],trials:[]};
const save = () => writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));
const servers=[],contexts=[],pages={};
const browser=await chromium.launch({args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
try {
 for(const [variant,root] of [['A',base],['B',head]]){
  const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'paired-travel',enforce:'pre',transform}]});await server.listen();servers.push(server);
  const context=await browser.newContext({viewport:report.viewport,deviceScaleFactor:1});contexts.push(context);
  await context.addInitScript(()=>{Date.now=()=>Date.UTC(2026,9,3,8,45,9);localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','observe');localStorage.removeItem('ap_cam');});
  const page=await context.newPage();pages[variant]=page;page.setDefaultTimeout(180000);
  page.on('pageerror',e=>report.errors.push({variant,message:e.stack||e.message}));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${query}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__AP_READY&&window.__pairedTravelFrame);
  await page.evaluate(async()=>{
   const [scene,state,E,A,P,THREE]=await Promise.all([import('/src/scene.js'),import('/src/state.js'),import('/src/universe/exploredSystem.js'),import('/src/universe/activeStars.js'),import('/src/universe/planetarySystem.js'),import('/node_modules/three/build/three.module.js')]);
   window.qa={scene,state,E,A,P,THREE};state.G.paused=true;state.G.cosmicOverview=false;
  });
 }
 for(const fixture of workload.fixtures)for(const order of orders)for(const variant of order){
  const page=pages[variant];await page.bringToFront();
  await page.evaluate(({fixture,variant})=>{
   const {scene,state,E,A,P,THREE}=qa;state.setSimTime(fixture.time);state.G.paused=true;state.G.focus='free';
   scene.cam.dist=fixture.distance;scene.cam.distTarget=null;scene.cam.yaw=fixture.yaw;scene.cam.pitch=fixture.pitch;scene.cam.tgt.fromArray(fixture.target);
   scene.cam.preciseTarget=fixture.anchor?{origin:new THREE.Vector3().fromArray(fixture.anchor.origin),offset:new THREE.Vector3().fromArray(fixture.anchor.offset)}:null;
   if(variant==='B'&&fixture.sourceFocus.startsWith('proc:')){A.pinProceduralStarById(fixture.sourceFocus.slice(5),fixture.time);E.getExploredSystem(fixture.sourceFocus,null,fixture.time);}
   if(variant==='B'&&fixture.sourceFocus.startsWith('system:'))E.getExploredSystem(fixture.sourceFocus,null,fixture.time);
   scene.applyCamera();
  },{fixture,variant});
  const trial={fixture:fixture.name,order,variant,transition:[],frames:[]};report.trials.push(trial);
  for(let i=0;i<warmup;i++)trial.transition.push(await page.evaluate(()=>window.__pairedTravelFrame()));
  // Both revisions receive the same real native control, with no UI button retaining focus.
  await page.locator('#exploreObject').click();await page.keyboard.down('w');
  for(let i=0;i<samples;i++)trial.frames.push(await page.evaluate(()=>window.__pairedTravelFrame()));
  await page.keyboard.up('w');await save();
  console.log(fixture.name,order,variant,trial.frames.map(f=>f.submissionMs.toFixed(1)).join(','));
 }
 assert.deepEqual(report.errors,[],'Both exact sources run without page errors');
 const quantile=(rows,q)=>[...rows].sort((a,b)=>a-b)[Math.min(rows.length-1,Math.floor(rows.length*q))];
 const summary=frames=>({n:frames.length,p50Ms:quantile(frames.map(f=>f.submissionMs),.5),p95Ms:quantile(frames.map(f=>f.submissionMs),.95),
  maxMs:Math.max(...frames.map(f=>f.submissionMs)),maxCompletionMs:Math.max(...frames.map(f=>f.totalMs)),over50:frames.filter(f=>f.submissionMs>50).length,
  stages:Object.fromEntries([...new Set(frames.flatMap(f=>Object.keys(f.stages)))].map(key=>[key,{p95:quantile(frames.map(f=>f.stages[key]||0),.95),max:Math.max(...frames.map(f=>f.stages[key]||0))}]))});
 report.summary=Object.fromEntries(['A','B'].map(v=>[v,summary(report.trials.filter(t=>t.variant===v).flatMap(t=>[...t.transition,...t.frames]))]));
 report.absoluteTargetPass=report.summary.B.maxCompletionMs<=50;
 report.relativeSubmissionRatio=report.summary.B.p95Ms/report.summary.A.p95Ms;
 report.largestCandidateFrames=report.trials.filter(t=>t.variant==='B').flatMap(t=>[...t.transition,...t.frames].map(f=>({fixture:t.fixture,...f}))).sort((a,b)=>b.submissionMs-a.submissionMs).slice(0,12);
 report.completed=true;await save();
} catch(error){report.failure=error.stack;await save();throw error;}
finally{for(const context of contexts)await context.close();await browser.close();for(const server of servers)await server.close();}
