// Exact-source paired diagnostic. Same-input controller traces are reported
// separately; timed rendering replays identical broad observer matrices.
// Baseline has no foreign provider/targets, so object content is not identical.
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
const qaReadback = new Uint8Array(4), qaTimers = new Map(); let qaSequence=0;
window.__collectTravelTimers = () => {
 const gl=renderer.getContext(), ext=gl.getExtension('EXT_disjoint_timer_query_webgl2'), completed=[];
 if(!ext)return completed;
 const disjoint=gl.getParameter(ext.GPU_DISJOINT_EXT);
 for(const [id,timer] of qaTimers){
  if(disjoint||gl.getQueryParameter(timer,gl.QUERY_RESULT_AVAILABLE)){
   completed.push({id,status:disjoint?'disjoint':'available',gpuElapsedMs:disjoint?null:gl.getQueryParameter(timer,gl.QUERY_RESULT)/1e6});
   gl.deleteQuery(timer);qaTimers.delete(id);
  }
 }
 return completed;
};
window.__pairedTravelFrame = () => {
 // Poll only queries issued in a previous browser task. Same-task polling is
 // prohibited by WebGL availability rules even after finish/readPixels.
 const completedTimers=window.__collectTravelTimers();
 clock.getDelta=()=>1/30;lastMobileFrame=-Infinity;PERF.last=Object.create(null);
 const gl=renderer.getContext(), ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
 const id=++qaSequence, timer=ext?gl.createQuery():null;
 if(timer)gl.beginQuery(ext.TIME_ELAPSED_EXT,timer);
 const start=performance.now();frame();const submissionMs=performance.now()-start;
 if(timer){gl.endQuery(ext.TIME_ELAPSED_EXT);qaTimers.set(id,timer);}
 const finishStart=performance.now();gl.finish();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,qaReadback);
 const readbackMs=performance.now()-finishStart;
 return {id,submissionMs,readbackMs,totalMs:performance.now()-start,gpuTimerStatus:ext?'pending':'unsupported',gpuElapsedMs:null,completedTimers,
  stages:Object.fromEntries(Object.entries(PERF.last).map(([k,v])=>[k,v.ms])),renderInfo:{...PERF.renderInfo},camera:camera.position.toArray(),quaternion:camera.quaternion.toArray(),frameNo};
};`;
}
for (const root of [base, head]) {
    const code = await readFile(resolve(root, 'src/main.js'), 'utf8');
    execFileSync(process.execPath, ['--input-type=module','--check'], {input:transform(code,'/src/main.js')});
}
if(process.argv.includes('--validate')){console.log('matched travel hooks validated for exact baseline and candidate');process.exit(0);}
await mkdir(out,{recursive:true});
const revision = root => execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const report = {
    version:2,baseline:revision(base),head:revision(head),query,viewport:{width:1100,height:760},workload,orders,warmup,samples,
    absoluteTargetMs:50,absoluteTargetPass:false,
    acceptance:'Diagnostic only. Same-native-input traces may diverge; timed rendering asserts equal broad camera matrices. Foreign object content and candidate local precision refinement differ by design.',
    timingMeaning:'submissionMs includes browser/driver blocking, not pure JS compute. Readback establishes completion. GPU queries are polled in later browser tasks; unsupported, disjoint and unresolved states remain explicit.',
    errors:[],controllerTraces:[],trials:[],poseComparisons:[],
};
const save = () => writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));
const servers=[],contexts=[],pages={},sampleRefs=new Map(),referencePoses=new Map();
function timers(variant, completed) {
    for(const timer of completed){const frame=sampleRefs.get(variant+':'+timer.id);if(frame){frame.gpuTimerStatus=timer.status;frame.gpuElapsedMs=timer.gpuElapsedMs;}}
}
async function prepare(page, fixture, variant) {
    await page.evaluate(({fixture,variant})=>{
        const {scene,state,E,A}=qa;state.setSimTime(fixture.time);state.G.paused=true;state.G.focus='free';
        if(variant==='B'&&fixture.sourceFocus.startsWith('proc:')){A.pinProceduralStarById(fixture.sourceFocus.slice(5),fixture.time);E.getExploredSystem(fixture.sourceFocus,null,fixture.time);}
        if(variant==='B'&&fixture.sourceFocus.startsWith('system:'))E.getExploredSystem(fixture.sourceFocus,null,fixture.time);
    },{fixture,variant});
    await pose(page, fixture, variant, 0);
}
async function pose(page, fixture, variant, step) {
    await page.evaluate(({fixture,variant,step})=>{
        const {scene,THREE}=qa, cam=scene.cam;
        const forward=new THREE.Vector3(-Math.cos(fixture.pitch)*Math.cos(fixture.yaw),-Math.sin(fixture.pitch),-Math.cos(fixture.pitch)*Math.sin(fixture.yaw));
        const shift=forward.multiplyScalar(fixture.distance*.65/30*step);
        const anchor=fixture.anchor?{origin:new THREE.Vector3().fromArray(fixture.anchor.origin),offset:new THREE.Vector3().fromArray(fixture.anchor.offset).add(shift)}:null;
        cam.tgt.copy(anchor?anchor.origin.clone().add(anchor.offset):new THREE.Vector3().fromArray(fixture.target).add(shift));
        cam.preciseTarget=variant==='B'?anchor:null;
        cam.dist=fixture.distance;cam.distTarget=null;cam.yaw=fixture.yaw;cam.pitch=fixture.pitch;qa.state.G.focus='free';scene.applyCamera();
    },{fixture,variant,step});
}
const browser=await chromium.launch({args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
try {
    for(const [variant,root] of [['A',base],['B',head]]){
        const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'paired-travel',enforce:'pre',transform}]});await server.listen();servers.push(server);
        const context=await browser.newContext({viewport:report.viewport,deviceScaleFactor:1});contexts.push(context);
        await context.addInitScript(()=>{Date.now=()=>Date.UTC(2026,9,3,8,45,9);localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','observe');localStorage.removeItem('ap_cam');});
        const page=await context.newPage();pages[variant]=page;page.setDefaultTimeout(180000);
        page.on('pageerror',e=>report.errors.push({variant,message:e.stack||e.message}));
        page.on('console',m=>{if(m.type()==='error'&&/shader|webgl|THREE/i.test(m.text()))report.errors.push({variant,message:m.text()});});
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${query}`,{waitUntil:'domcontentloaded'});
        await page.waitForFunction(()=>window.__AP_READY&&window.__pairedTravelFrame);
        await page.evaluate(async()=>{
            const [scene,state,E,A,P,THREE,controls]=await Promise.all([import('/src/scene.js'),import('/src/state.js'),import('/src/universe/exploredSystem.js'),import('/src/universe/activeStars.js'),import('/src/universe/planetarySystem.js'),import('/node_modules/three/build/three.module.js'),import('/src/explorerUI.js')]);
            window.qa={scene,state,E,A,P,THREE,controls};state.G.paused=true;state.G.cosmicOverview=false;
        });
    }
    // Controller-only tracing preserves native key handling without pretending
    // precision-fix trajectories are identical. This is outside timed rendering.
    for(const fixture of workload.fixtures){
        const traces={fixture:fixture.name,A:[],B:[]};report.controllerTraces.push(traces);
        for(const variant of ['A','B']){
            const page=pages[variant];await page.bringToFront();await prepare(page,fixture,variant);
            await page.locator('#exploreObject').click();await page.keyboard.down('w');
            for(let i=0;i<samples;i++)traces[variant].push(await page.evaluate(()=>{
                qa.controls.moveExplorerCamera(1/30);qa.scene.applyCamera();
                const a=qa.scene.cam.preciseTarget,o=qa.scene.camera.userData.preciseOrbit;
                return {camera:qa.scene.camera.position.toArray(),logical:a?{origin:a.origin.toArray(),offset:a.offset.clone().add(o.offset).toArray()}:null};
            }));
            await page.keyboard.up('w');
        }
        traces.maxBroadDivergenceScene=Math.max(...traces.A.map((a,i)=>Math.hypot(...a.camera.map((v,j)=>v-traces.B[i].camera[j]))));
        traces.approxPixelDivergence=traces.maxBroadDivergenceScene/fixture.distance*760/(2*Math.tan(48*Math.PI/360));
        traces.pixelTolerance=.01;traces.observerMatched=traces.approxPixelDivergence<=traces.pixelTolerance;
    }
    for(const fixture of workload.fixtures)for(const order of orders)for(const variant of order){
        const page=pages[variant];await page.bringToFront();await prepare(page,fixture,variant);
        const trial={fixture:fixture.name,order,variant,mode:'exact-broad-pose-replay',transition:[],frames:[]};report.trials.push(trial);
        for(let i=0;i<warmup+samples;i++){
            await pose(page,fixture,variant,i);
            const frame=await page.evaluate(()=>window.__pairedTravelFrame());
            timers(variant,frame.completedTimers);delete frame.completedTimers;sampleRefs.set(variant+':'+frame.id,frame);
            (i<warmup?trial.transition:trial.frames).push(frame);
            const key=fixture.name+':'+i, ref=referencePoses.get(key);
            if(!ref)referencePoses.set(key,frame);
            else report.poseComparisons.push({fixture:fixture.name,step:i,variant,positionDifferenceScene:Math.hypot(...frame.camera.map((v,j)=>v-ref.camera[j])),quaternionDifference:Math.max(...frame.quaternion.map((v,j)=>Math.abs(v-ref.quaternion[j])))});
        }
        timers(variant,await page.evaluate(()=>window.__collectTravelTimers()));await save();
        console.log(fixture.name,order,variant,trial.frames.map(f=>f.submissionMs.toFixed(1)).join(','));
    }
    // A later task is required for each last query. Keep unresolved status if
    // a completed readback still cannot produce an undisjoint timing result.
    for(const variant of ['A','B']){await pages[variant].waitForTimeout(100);timers(variant,await pages[variant].evaluate(()=>window.__collectTravelTimers()));}
    for(const frame of sampleRefs.values())if(frame.gpuTimerStatus==='pending')frame.gpuTimerStatus='unresolved';
    assert.deepEqual(report.errors,[],'Both exact sources run without page/shader errors');
    report.poseReplayMatched=report.poseComparisons.every(p=>p.positionDifferenceScene===0&&p.quaternionDifference<1e-12);
    assert(report.poseReplayMatched,'Timed broad camera matrices must match; a divergent input trace is not a matched render workload');
    const quantile=(rows,q)=>[...rows].sort((a,b)=>a-b)[Math.min(rows.length-1,Math.floor(rows.length*q))];
    const summary=frames=>({n:frames.length,p50Ms:quantile(frames.map(f=>f.submissionMs),.5),p95Ms:quantile(frames.map(f=>f.submissionMs),.95),maxMs:Math.max(...frames.map(f=>f.submissionMs)),maxCompletionMs:Math.max(...frames.map(f=>f.totalMs)),over50:frames.filter(f=>f.submissionMs>50).length,
        stages:Object.fromEntries([...new Set(frames.flatMap(f=>Object.keys(f.stages)))].map(key=>[key,{p95:quantile(frames.map(f=>f.stages[key]||0),.95),max:Math.max(...frames.map(f=>f.stages[key]||0))}]))});
    report.summary=Object.fromEntries(['A','B'].map(v=>[v,summary(report.trials.filter(t=>t.variant===v).flatMap(t=>[...t.transition,...t.frames]))]));
    report.absoluteTargetPass=report.summary.B.maxCompletionMs<=50;
    report.relativeSubmissionRatio=report.summary.B.p95Ms/report.summary.A.p95Ms;
    report.largestCandidateFrames=report.trials.filter(t=>t.variant==='B').flatMap(t=>[...t.transition,...t.frames].map(f=>({fixture:t.fixture,...f}))).sort((a,b)=>b.submissionMs-a.submissionMs).slice(0,12);
    report.gpuTimerStates=Object.fromEntries(['available','unsupported','disjoint','unresolved'].map(status=>[status,[...sampleRefs.values()].filter(f=>f.gpuTimerStatus===status).length]));
    report.completed=true;await save();
} catch(error){report.failure=error.stack;await save();throw error;}
finally{for(const context of contexts)await context.close();await browser.close();for(const server of servers)await server.close();}
