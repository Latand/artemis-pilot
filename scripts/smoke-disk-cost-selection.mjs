// Pure Node tests: no browser or renderer context is created.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {WebGLIndexedBufferRenderer} from 'three/src/renderers/webgl/WebGLIndexedBufferRenderer.js';
import {WebGLBufferRenderer} from 'three/src/renderers/webgl/WebGLBufferRenderer.js';
import {makeSelectionObserver,assertCostSelectionProof,SELECTION_POLICY} from './disk-cost-selection-native.mjs';
import {adaptSelectionBenchmark,SELECTION_PINS,digest} from './disk-cost-selection-contract.mjs';
const source=readFileSync(new URL('./smoke-native-disk-proof.mjs',import.meta.url),'utf8');
let mockSource=source.slice(source.indexOf('function mock('),source.indexOf('\nconst good=mock()'));
assert(mockSource.startsWith('function mock('));assert.equal(mockSource.split('restores:state.restores,losses:').length,2);
mockSource=mockSource.replace('restores:state.restores,losses:','frameNo:state.frameNo,restores:state.restores,losses:');
mockSource=mockSource.replace('state.compiles++;uniforms.uDiskUnclipped.value=', 'state.compiles++;gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT);uniforms.uDiskUnclipped.value=');
mockSource=mockSource.replace("getShaderPrecisionFormat:()=>options.lowFormat?{precision:10,rangeMin:14,rangeMax:14}:format,","getShaderPrecisionFormat:()=>{state.precisionReads=(state.precisionReads||0)+1;return options.lowFormat?{precision:10,rangeMin:14,rangeMax:14}:format;},");
mockSource=mockSource.replace('const original={before:','const original={precision:gl.getShaderPrecisionFormat,before:');
mockSource=mockSource.replace('assert.equal(material.onBeforeRender,original.before);','assert.equal(gl.getShaderPrecisionFormat,original.precision);assert.equal(material.onBeforeRender,original.before);');
const mock=new Function('assert','vm','installNativeDiskFastPathProof',mockSource+';return mock;')(assert,vm,makeSelectionObserver());
function evidence({ineligible=false,precision='highp',compileSettled=false,NativeRenderer=WebGLIndexedBufferRenderer}={}){
 const x=mock({ineligible});x.observer.label({kind:'cost-warmup',fixture:'saturn-hole-near'});
 for(let i=1;i<=120;i++){x.state.frameNo=i;x.draw({compile:i===1,precision,count:i<=8?0:6,flag:ineligible||precision!=='highp'?0:1,NativeRenderer});}
 const before=x.observer.drain();x.observer.label({kind:'cost-settled',fixture:'saturn-hole-near'});const samples=[];
 for(let i=121;i<=124;i++){x.state.frameNo=i;x.draw({compile:compileSettled&&i===121,precision,flag:ineligible||precision!=='highp'?0:1,NativeRenderer});samples.push({frameNo:i});}
 const settled=x.observer.drain(),stopped=x.observer.stop();x.restored();
 assert.equal(x.state.calls.length,124,'Observation adds no native submission');
 assert.equal(before.unobserved.length,112);assert.equal(before.skipped.length,8);
 assert.equal(before.draws.length,0);assert.equal(before.programs.length,0);
 assert.equal(Object.keys(before.queryCounts).length,0);assert.equal(x.state.precisionReads,compileSettled?3:2,'Only production compile and settled reflection precision queries');
 return {before,settled,stopped,startFrame:120,samples};
}
for(const NativeRenderer of [WebGLIndexedBufferRenderer,WebGLBufferRenderer]){
 assert.equal(assertCostSelectionProof(evidence({NativeRenderer})).classification,'all-fast');
 assert.equal(assertCostSelectionProof(evidence({NativeRenderer,ineligible:true})).classification,'all-fallback');
 assert.equal(assertCostSelectionProof(evidence({NativeRenderer,precision:'mediump'})).classification,'all-fallback');
 assert.equal(assertCostSelectionProof(evidence({NativeRenderer,compileSettled:true})).classification,'mixed');
}
const original=evidence();let negatives=0;
for(const [name,change]of [
 ['missing fourth native draw',e=>e.settled.draws.pop()],
 ['wrong settled frame',e=>e.settled.draws[0].lifecycle.frameNo=120],
 ['extra settled delivery',e=>e.samples.push({frameNo:125})],
 ['missing settled delivery',e=>e.samples.pop()],
 ['stale native flag',e=>e.settled.draws[0].uniforms.uDiskUnclipped=0],
 ['wrong native precision',e=>e.settled.draws[0].program.storageQualified=false],
 ['CPU reset absent',e=>e.before.compiles[0].resetFlag=1],
 ['compile arm mismatch',e=>e.before.compiles[0].armId=2],
 ['zero-count GPU proof invented',e=>e.before.skipped[0].nativeUniformsObserved=true],
 ['warmup GPU proof invented',e=>e.before.unobserved[0].nativeUniformsObserved=true],
 ['warmup native queries',e=>e.before.queryCounts.getUniform=1],
 ['warmup shader reflection',e=>e.before.programs.push({})],
 ['missing warmup native call',e=>e.before.unobserved.pop()],
 ['noninteger warmup count',e=>e.before.unobserved[0].count=6.5],
 ['noninteger warmup compile serial',e=>e.before.unobserved[0].compileSerialAtDraw=1.5],
 ['duplicate native submission',e=>e.settled.draws[0].submissionId--],
 ['wrong fixture',e=>e.settled.draws[0].label.fixture='other'],
 ['disk is disabled',e=>e.settled.draws[0].uniforms.uDiskOn=0],
 ['unpaused scene',e=>e.settled.draws[0].lifecycle.paused=false],
 ['nonzero time',e=>e.settled.draws[0].lifecycle.t=1],
 ['native context lost',e=>e.settled.draws[0].contextLost=true],
 ['cleanup omitted',e=>e.stopped.hooksRestored=false],
 ]){const changed=structuredClone(original);change(changed);assert.throws(()=>assertCostSelectionProof(changed),undefined,name);negatives++;}
const root=resolve(new URL('..',import.meta.url).pathname),native=execFileSync('git',['show',SELECTION_PINS.benchmarkReference+':'+SELECTION_PINS.benchmarkPath],{cwd:root,encoding:'utf8'});
const transformed=adaptSelectionBenchmark(native,root);
assert.equal(digest(native),SELECTION_PINS.benchmarkSha256);
assert(!transformed.includes('for (const [trialIndex, order]')&&!transformed.includes('report.longTaskBudget =')&&!transformed.includes('Profiler.start'));
assert.equal(transformed.split('await frames(page, warmupFrames)').length,2);
assert.equal(transformed.split('const settledSamples=await frames(page,4)').length,2);
assert(transformed.includes('await page.waitForFunction(() => { const s = pairedQA.surfaces.pairedSurfaceQueue(); return !s.pending && !s.inFlight; });'));
const frameStart='async function frame(page) {',frameEnd='async function state(page) {';
const unchangedFrame=s=>s.slice(s.indexOf(frameStart),s.indexOf(frameEnd));assert.equal(unchangedFrame(transformed),unchangedFrame(native),'Native delivery, finish/readback and frame accounting unchanged');
assert.throws(()=>adaptSelectionBenchmark(native+'\n',root));negatives++;
const dir=mkdtempSync(join(tmpdir(),'selection-smoke-'));
try{const file=join(dir,'effective.mjs');writeFileSync(file,transformed);execFileSync(process.execPath,['--check',file]);}finally{rmSync(dir,{recursive:true,force:true});}
assert.deepEqual([SELECTION_POLICY.addedFrames,SELECTION_POLICY.acceptanceFrames],[0,0]);
console.log(`Cost selection CPU smoke passed:8 native-mock mode cases,${negatives} negatives, immutable frame helper and120+4 prefix; no browser/GPU execution.`);
// Child-process caps are exercised using owned, short-lived Node fixtures only.
const {runSelectionProcess}=await import('./disk-selection-process.mjs');
const options={cwd:root,env:process.env,deadlineMs:1000,cleanupMs:20,stdio:'ignore'};
const ok=await runSelectionProcess(process.execPath,['-e','process.exit(0)'],options);
assert(ok.code===0&&ok.childExited&&!ok.timedOut&&!ok.signalErrors.length);
const failed=await runSelectionProcess(process.execPath,['-e','process.exit(7)'],options);assert.equal(failed.code,7);
let journaled=0;
const timed=await runSelectionProcess(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},100)'],{...options,deadlineMs:200,onTimeout:()=>journaled++});
assert(timed.timedOut&&timed.childExited&&timed.signal==='SIGKILL'&&journaled===1);
const absent=await runSelectionProcess('/definitely-missing-disk-selection-executable',[],options);assert(absent.error&&absent.childExited);
console.log('Selection supervisor smoke passed: successful/failed child, missing executable, timeout journal and mandatory process-group hard stop. No browser executed.');
const {finalizeDiskProbe}=await import('./disk-plane-finalize.mjs');
const {closeNativeDiskResources}=await import('./native-disk-proof.mjs');
const finalStart=transformed.lastIndexOf('    await finalizeDiskProbe('),finalEnd=transformed.indexOf('\n}',finalStart);
assert(finalStart>0&&finalEnd>finalStart);const finalBody=transformed.slice(finalStart,finalEnd);
for(const hasOriginal of [false,true])for(const mode of ['stop','stop-hang','browser','server','cache']){
 const calls={stop:0,browser:0,server:0,cache:0},report={completed:true,errors:[]},originalError=hasOriginal?Error('original fixture failure'):undefined;
 const context={report,assert,selectionOriginalError:originalError,finalizeDiskProbe,
  closeNativeDiskResources:(stop,close)=>closeNativeDiskResources(stop,close,{stopMs:5,closeMs:5}),
  stopSelection:async()=>{calls.stop++;if(mode==='stop-hang')await new Promise(()=>{});if(mode==='stop')throw Error('stop');},
  browser:{close:async()=>{calls.browser++;if(mode==='browser')throw Error('browser');}},
  servers:[{close:async()=>{calls.server++;if(mode==='server')throw Error('server');}},{close:async()=>{calls.server++;}}],
  caches:['owned-test-cache'],rm:async()=>{calls.cache++;if(mode==='cache')throw Error('cache');},save:async()=>{},AggregateError};
 await assert.rejects(vm.runInNewContext(`(async()=>{${finalBody}})()`,context),e=>hasOriginal?e===originalError:true);
 assert.equal(report.completed,false);assert.deepEqual(calls,{stop:1,browser:1,server:2,cache:1});
}
const {explainDiskEligibility}=await import('./disk-cost-selection-contract.mjs');
const holeSource=readFileSync(new URL('../src/holeOptics.js',import.meta.url),'utf8');
assert.equal(explainDiskEligibility(holeSource,null).reason,'input-shape');
assert.equal(explainDiskEligibility(holeSource,{}).reason,'viewport-bounds');
assert.equal(explainDiskEligibility(holeSource,{viewportWidth:430,viewportHeight:932}).reason,'numeric-shape-range');
assert.throws(()=>explainDiskEligibility(holeSource+'\n',{}));
console.log('Exact generated finalizer:10 failure cases retain independent stop/browser/server/cache attempts and original error. Tagged eligibility explanation is source-pinned and cannot change the Boolean.');
const THREE=await import('three');let explained=0;
for(const test of JSON.parse(readFileSync(new URL('./fixtures/disk-fast-path-captured.json',import.meta.url),'utf8')).cases){
 const p=test.captured,c=test.reconstructedCamera,cam=new THREE.PerspectiveCamera(c.fov,p.viewportWidth/p.viewportHeight,p.near,p.far);
 const cp=Math.cos(c.pitch),offset=new THREE.Vector3(c.distance*cp*Math.cos(c.yaw),c.distance*Math.sin(c.pitch),c.distance*cp*Math.sin(c.yaw));
 cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(offset,new THREE.Vector3(),cam.up));cam.updateMatrixWorld(true);
 const v=cam.matrixWorldInverse.elements,input={...p,rotation:new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().extractRotation(cam.matrixWorld)).elements,
  inverseProjection:cam.projectionMatrixInverse.elements,viewDepth:[-v[2],-v[6],-v[10]]};
 assert.equal(explainDiskEligibility(holeSource,input).eligible,test.expectedEligible);explained++;
}
assert.equal(explained,20);
const processDir=mkdtempSync(join(tmpdir(),'selection-group-')),pidFile=join(processDir,'grandchild.pid');
try{
 const script=`const {spawn}=require('node:child_process'),fs=require('node:fs');
 const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},100)'],{stdio:'ignore'});
 fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},100);`;
 const group=await runSelectionProcess(process.execPath,['-e',script],{...options,deadlineMs:400,cleanupMs:30});
 assert(group.timedOut&&group.childExited&&group.code===0,'Immediate child exits before mandatory descendant kill');
 const pid=Number(readFileSync(pidFile,'utf8'));
 try{const state=readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1][0];assert.equal(state,'Z','Descendant is dead, possibly awaiting OS reaping');}
 catch(error){if(error.code!=='ENOENT')throw error;}
}finally{rmSync(processDir,{recursive:true,force:true});}
console.log('All20 pinned physical-input eligibility explanations agree; descendant hard-stop remains active after immediate-child exit.');
// The pinned Playwright launcher uses detached:true. Keep an unrelated owned
// control alive, and prove cleanup reaches only the registered detached tree.
const {spawn}=await import('node:child_process');
const detachedDir=mkdtempSync(join(tmpdir(),'selection-detached-')),detachedPidFile=join(detachedDir,'child.pid');
const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{detached:true,stdio:'ignore'});
let detachedPid;
try{
 const childCode=`const {spawn}=require('node:child_process'),fs=require('node:fs');
 const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},100)'],{detached:true,stdio:'ignore'});
 fs.writeFileSync(${JSON.stringify(detachedPidFile)},String(child.pid));child.unref();process.on('SIGTERM',()=>{});setInterval(()=>{},100);`;
 const result=await runSelectionProcess(process.execPath,['-e',childCode],{...options,deadlineMs:400,cleanupMs:30});
 detachedPid=Number(readFileSync(detachedPidFile,'utf8'));
 assert(result.timedOut&&result.childExited&&!result.ownership.remaining.length&&!result.signalErrors.length);
 assert(result.ownership.sessions.some(s=>s.pid===detachedPid),'Detached session is registered');
 assert(result.ownership.signals.some(s=>s.group===detachedPid&&s.signal==='SIGKILL'),'Detached session receives its owned hard stop');
 try{assert.equal(readFileSync(`/proc/${detachedPid}/stat`,'utf8').split(') ')[1][0],'Z');}catch(error){if(error.code!=='ENOENT')throw error;}
 process.kill(unrelated.pid,0);assert.notEqual(readFileSync(`/proc/${unrelated.pid}/stat`,'utf8').split(') ')[1][0],'Z');
 assert(!result.ownership.signals.some(s=>s.group===unrelated.pid),'Unrelated control group is never signaled');
}finally{
 for(const pid of [detachedPid,unrelated.pid])if(pid)try{process.kill(-pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
 rmSync(detachedDir,{recursive:true,force:true});
}
console.log('Detached-session regression passed; unrelated control process remains alive and unsignaled.');
// Execute the exact generated completion block with otherwise valid evidence.
const completionMarker='        assert.deepEqual(scenario.before.A.maps, scenario.before.B.maps, `${fixture.name}: matched preloaded maps`);';
const completionStart=transformed.indexOf(completionMarker)+completionMarker.length;
const completionEnd=transformed.indexOf('\n    }\n    console.log(JSON.stringify({diagnosticOnly:true',completionStart);
assert(completionStart>=completionMarker.length&&completionEnd>completionStart);
const completion=transformed.slice(completionStart,completionEnd);
for(const message of ['Retained pageerror','THREE.WebGLProgram: Shader Error']){
 const report={errors:[{label:'B',message}],selectionNative:evidence(),pages:{A:{initial:{workload:{frameNo:0}}},B:{initial:{workload:{frameNo:0}}}}};
 const scenario={warmup:{},before:{}};
 for(const label of ['A','B']){scenario.warmup[label]=Array.from({length:124},(_,i)=>({frameNo:i+1}));scenario.before[label]={workload:{frameNo:124},paused:true,t:0,optics:{lensEnabled:true,lensCount:1,saturnMap:2048}};}
 await assert.rejects(vm.runInNewContext(`(async()=>{${completion}})()`,{report,scenario,assert,assertCostSelectionProof,save:async()=>{}}),/Retained application\/shader errors/);
 assert.notEqual(report.completed,true);
}
// Exact abort-aware atomic writer plus exact generated save, with controlled IO.
const finalizerSource=readFileSync(new URL('./disk-plane-finalize.mjs',import.meta.url),'utf8');
const atomicSource=finalizerSource.slice(finalizerSource.indexOf('export async function atomicDiskReport'),finalizerSource.indexOf('export async function finalizeDiskProbe')).replace('export async function','async function');
const saveStart=transformed.indexOf('const save = async (options={})'),saveEnd=transformed.indexOf('\nlet selectionOriginalError',saveStart);
assert(saveStart>0&&saveEnd>saveStart);const exactSave=transformed.slice(saveStart,saveEnd);
function saveFixture({delayWrite=0}={}){
 const files=new Map(),paths=[],report={completed:true,errors:[]};let writes=0,release;
 const context={report,selectionReportPath:'/owned/selection-report.json',process:{pid:123},
  writeFile:async(path,bytes)=>{paths.push(path);if(++writes===delayWrite)await new Promise(r=>release=r);files.set(path,bytes);},
  renameSync:(a,b)=>{assert(files.has(a));files.set(b,files.get(a));files.delete(a);},unlink:async p=>files.delete(p)};
 vm.runInNewContext(`let writeSequence=0;${atomicSource}\n${exactSave}\nglobalThis.actualSave=save;`,context);
 return{report,files,paths,save:context.actualSave,release:()=>release()};
}
const late=saveFixture({delayWrite:2});
await assert.rejects(finalizeDiskProbe({report:late.report,verifySources:async()=>{},flush:late.save,closeBrowser:async()=>{},closeServer:async()=>{},timeoutMs:10}),/finalization failed/);
assert.equal(JSON.parse(late.files.get('/owned/selection-report.json')).completed,false);
late.release();await new Promise(r=>setTimeout(r,5));
assert.equal(JSON.parse(late.files.get('/owned/selection-report.json')).completed,false,'Aborted late success never overwrites failure');
assert.equal(new Set(late.paths).size,late.paths.length,'Each atomic write has its own temporary path');
for(const lateError of [false,true]){
 const x=saveFixture(),context={report:x.report,selectionOriginalError:undefined,assert,finalizeDiskProbe,closeNativeDiskResources,
  stopSelection:async()=>{},browser:{close:async()=>{if(lateError)x.report.errors.push({message:'Late browser-close shader error'});}},servers:[],caches:[],rm:async()=>{},save:x.save,AggregateError};
 const closing=vm.runInNewContext(`(async()=>{${finalBody}})()`,context);
 if(lateError)await assert.rejects(closing,/finalization failed/);else await closing;
 assert.equal(x.report.completed,!lateError);assert.equal(JSON.parse(x.files.get('/owned/selection-report.json')).completed,!lateError);
}
assert(transformed.includes('executablePath: process.env.CHROMIUM_PATH || undefined,'),'Preserve the original default headless selection; wrapper clears the override');
assert(!transformed.includes('executablePath: chromium.executablePath()'));
const versionStart=transformed.indexOf('    report.browser = await browser.version();');
const versionEnd=transformed.indexOf('\n    for (const [label, tree]',versionStart);assert(versionEnd>versionStart);
const versionBlock=transformed.slice(versionStart,versionEnd);
for(const version of ['153.0.8010.12','152.0.0.0']){
 const report={},operation=vm.runInNewContext(`(async()=>{${versionBlock}})()`,{report,browser:{version:async()=>version},assert,chromium:{executablePath:()=>'/managed/1243/chrome'}});
 if(version.startsWith('153.')){await operation;assert.equal(report.browser,version);}else await assert.rejects(operation,/Actual launched Chromium/);
}
console.log('Review regressions pass: retained page/shader errors, late browser-close errors, late timed-out atomic success, unique temporary files and actual Chromium version binding.');
const normalDir=mkdtempSync(join(tmpdir(),'selection-orphan-')),normalPidFile=join(normalDir,'child.pid');let normalPid;
try{
 const script=`const {spawn}=require('node:child_process'),fs=require('node:fs');
 const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},100)'],{detached:true,stdio:'ignore'});
 fs.writeFileSync(${JSON.stringify(normalPidFile)},String(child.pid));child.unref();process.exit(0);`;
 const result=await runSelectionProcess(process.execPath,['-e',script],{...options,cleanupMs:30});
 normalPid=Number(readFileSync(normalPidFile,'utf8'));
 assert(result.unexpectedDescendants&&!result.timedOut&&result.code===0&&result.ownership.remaining.length===0,'Normal parent exit still cleans registered detached descendants and disqualifies completion');
 try{assert.equal(readFileSync(`/proc/${normalPid}/stat`,'utf8').split(') ')[1][0],'Z');}catch(error){if(error.code!=='ENOENT')throw error;}
}finally{if(normalPid)try{process.kill(-normalPid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}rmSync(normalDir,{recursive:true,force:true});}
const wrapper=readFileSync(new URL('./observe-disk-cost-selection.mjs',import.meta.url),'utf8');
const envStart=wrapper.indexOf(' const env={'),envEnd=wrapper.indexOf('\n execFileSync(process.execPath',envStart);assert(envStart>0&&envEnd>envStart);
const envContext={process:{env:{CHROMIUM_PATH:'/unapproved/chrome'}},baseline:'/pinned/main',P:SELECTION_PINS,report:{}};
vm.runInNewContext(wrapper.slice(envStart,envEnd)+'\nglobalThis.childEnv=env;',envContext);
assert.equal(envContext.childEnv.CHROMIUM_PATH,undefined);assert.equal(envContext.report.executableOverrideRemoved,true);
console.log('Normal-exit detached cleanup and inherited executable-override removal pass.');
// Journal damage must report failure without losing direct root ownership or
// valid detached registrations preceding the bad/capped tail.
for(const mode of ['malformed','cap'])for(const detached of [false,true]){
 const dir=mkdtempSync(join(tmpdir(),'selection-journal-error-')),pidFile=join(dir,'child.pid'),ready=join(dir,'ready');let rootPid,childPid;
 try{
  const damage=mode==='cap'?"fs.appendFileSync(process.env.ARTEMIS_DISK_PROCESS_JOURNAL,' '.repeat(1024*1024));":"fs.appendFileSync(process.env.ARTEMIS_DISK_PROCESS_JOURNAL,'broken-json\\nnull\\n');";
  const childCode=`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');process.on('SIGTERM',()=>{});setInterval(()=>{},100);`;
  const script=`const fs=require('node:fs'),{spawn}=require('node:child_process');
   ${detached?`const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();
    const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(wait);${damage}}},5);`:damage}
   process.on('SIGTERM',()=>{});setInterval(()=>{},100);`;
  const result=await runSelectionProcess(process.execPath,['-e',script],{...options,deadlineMs:500,cleanupMs:30,journalPath:join(dir,'owned.jsonl')});rootPid=result.pid;
  assert(result.timedOut&&result.childExited&&result.signalErrors.length>0&&result.ownership.registered>=1&&result.ownership.remaining.length===0);
  assert(result.ownership.signals.some(x=>x.session===rootPid&&x.signal==='SIGKILL'),'Root cleanup is independent of journal parsing');
  if(detached){childPid=Number(readFileSync(pidFile,'utf8'));assert(result.ownership.sessions.some(x=>x.pid===childPid));assert(result.ownership.signals.some(x=>x.session===childPid&&x.signal==='SIGKILL'),'Valid detached prefix survives journal error');}
  for(const pid of [rootPid,childPid].filter(Boolean))try{assert.equal(readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1][0],'Z');}catch(error){if(error.code!=='ENOENT')throw error;}
 }finally{for(const pid of [rootPid,childPid].filter(Boolean))try{process.kill(-pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}rmSync(dir,{recursive:true,force:true});}
}
const {createRequire}=await import('node:module'),{managedHeadlessRuntime,verifyHeadlessLaunch}=await import('./disk-cost-selection-contract.mjs');
const require=createRequire(import.meta.url),managed=managedHeadlessRuntime(require);
const full=require(resolve(require.resolve('playwright-core/package.json'),'../lib/coreBundle.js')).registry.registry.findExecutable('chromium');
assert.equal(managed.name,'chromium-headless-shell');assert.equal(managed.version,full.browserVersion);assert.notEqual(managed.executablePath,full.executablePath());
const observed=path=>({executables:[{pid:10,start:'1',commandPath:path,processImage:path}]});
assert(verifyHeadlessLaunch(observed(managed.executablePath),managed.executablePath).actualPathVerified);
assert.throws(()=>verifyHeadlessLaunch(observed(full.executablePath()),managed.executablePath),/managed headless-shell/,'Same version cannot excuse full-browser family drift');
assert.throws(()=>verifyHeadlessLaunch({executables:[{pid:10,start:'1',commandPath:managed.executablePath,processImage:full.executablePath()}]},managed.executablePath));
assert.throws(()=>verifyHeadlessLaunch({executables:[]},managed.executablePath));
assert.throws(()=>verifyHeadlessLaunch({executables:[...observed(managed.executablePath).executables,...observed(managed.executablePath).executables]},managed.executablePath));
console.log('Second review regressions pass: four malformed/capped root+detached cleanup cases, unchanged default launch, same-version full-browser rejection and actual process-image family proof.');
// Admission itself must reject before invoking spawn if a record cannot remain
// in the supervisor's readable prefix. Exercise the exact preload with a stub.
const ownedSource=readFileSync(new URL('./disk-selection-owned.cjs',import.meta.url),'utf8');
for(const mode of ['cap','partial']){
 const dir=mkdtempSync(join(tmpdir(),'selection-admission-stub-')),journal=join(dir,'owned.jsonl');writeFileSync(journal,'');let spawns=0;
 try{
  const fs=require('node:fs'),stub={spawn:()=>{spawns++;throw Error('Original spawn must not be called');}},module={exports:{}};
  vm.runInNewContext(ownedSource,{module,require:name=>name==='node:fs'?fs:name==='node:child_process'?stub:{syncBuiltinESMExports(){}},
   process:{pid:process.pid,ppid:process.ppid,env:{ARTEMIS_DISK_PROCESS_JOURNAL:journal},on(){},hrtime:process.hrtime},Buffer,SharedArrayBuffer,Int32Array,Atomics});
  fs.appendFileSync(journal,mode==='cap'?' '.repeat(1024*1024):'partial-row');
  assert.throws(()=>stub.spawn(process.execPath,['-e','process.exit(0)'],{detached:true}),/admission/);
  assert.equal(spawns,0,'Capacity/boundary failure precedes the original spawn');
 }finally{rmSync(dir,{recursive:true,force:true});}
}
for(const mode of ['cap','partial']){
 const dir=mkdtempSync(join(tmpdir(),'selection-admission-live-')),resultFile=join(dir,'admission.json');
 try{
  const damage=mode==='cap'?"const row=fs.readFileSync(process.env.ARTEMIS_DISK_PROCESS_JOURNAL,'utf8').split('\\n')[0]+'\\n';fs.appendFileSync(process.env.ARTEMIS_DISK_PROCESS_JOURNAL,row.repeat(Math.ceil(1024*1024/row.length)));":"fs.appendFileSync(process.env.ARTEMIS_DISK_PROCESS_JOURNAL,'partial-row');";
  const script=`const fs=require('node:fs'),{spawn}=require('node:child_process');${damage}
   let result;try{const child=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{detached:true,stdio:'ignore'});result={accepted:true,pid:child.pid};child.unref();}catch(error){result={accepted:false,message:String(error)};}
   fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(result));process.on('SIGTERM',()=>{});setInterval(()=>{},100);`;
  const result=await runSelectionProcess(process.execPath,['-e',script],{...options,deadlineMs:350,cleanupMs:30});
  const admission=JSON.parse(readFileSync(resultFile,'utf8'));assert.equal(admission.accepted,false);assert.match(admission.message,/admission/);
  assert(result.timedOut&&result.childExited&&result.ownership.remaining.length===0);assert.equal(result.ownership.sessions.length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
}
// Two already registered writers contend for the last reservable slot. Their
// accepted rows must fit the bounded prefix, and at most one fork is admitted.
const raceDir=mkdtempSync(join(tmpdir(),'selection-admission-race-'));
try{
 const worker=id=>`const fs=require('node:fs'),{spawn}=require('node:child_process');
 fs.writeFileSync(${JSON.stringify(join(raceDir,'ready-'))}+${id},'ready');
 const waiting=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(join(raceDir,'go'))}))return;clearInterval(waiting);
 let result;try{const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},100)'],{detached:true,stdio:'ignore'});child.unref();result={accepted:true,pid:child.pid};}catch(error){result={accepted:false,error:String(error)};}
 fs.writeFileSync(${JSON.stringify(join(raceDir,'result-'))}+${id},JSON.stringify(result));},5);
 process.on('SIGTERM',()=>{});setInterval(()=>{},100);`;
 const rootScript=`const fs=require('node:fs'),{spawn}=require('node:child_process');
 ${[0,1].map(i=>`spawn(process.execPath,['-e',${JSON.stringify(worker(i))}],{stdio:'ignore'});`).join('\n')}
 const waiting=setInterval(()=>{if(![0,1].every(i=>fs.existsSync(${JSON.stringify(join(raceDir,'ready-'))}+i)))return;clearInterval(waiting);
 const file=process.env.ARTEMIS_DISK_PROCESS_JOURNAL,target=1024*1024-64*1024,size=fs.statSync(file).size;
 fs.appendFileSync(file,' '.repeat(target-size-1)+'\\n');fs.writeFileSync(${JSON.stringify(join(raceDir,'go'))},'go');
 const done=setInterval(()=>{if([0,1].every(i=>fs.existsSync(${JSON.stringify(join(raceDir,'result-'))}+i))){clearInterval(done);process.exit(0);}},5);},5);`;
 const result=await runSelectionProcess(process.execPath,['-e',rootScript],{...options,deadlineMs:3000,cleanupMs:30});
 const admissions=[0,1].map(i=>JSON.parse(readFileSync(join(raceDir,'result-'+i),'utf8')));
 assert.equal(admissions.filter(x=>x.accepted).length,1,'Serialized admission permits only the available reserved slot');
 const admitted=admissions.find(x=>x.accepted);assert(result.ownership.sessions.some(x=>x.pid===admitted.pid));
 assert(result.unexpectedDescendants&&result.childExited&&result.ownership.remaining.length===0);
 assert(admissions.filter(x=>!x.accepted).every(x=>/admission capacity/.test(x.error)));
}finally{rmSync(raceDir,{recursive:true,force:true});}
console.log('Admission regressions pass: capacity/partial-tail rejection before any spawn, real overflow-before-spawn containment, and serialized concurrent last-slot admission.');
