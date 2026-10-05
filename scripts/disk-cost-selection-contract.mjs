import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {adaptDiskBenchmark} from './disk-plane-source-contract.mjs';
export const SELECTION_PINS=Object.freeze({baseline:'6179f23661591bb4dee89a0bf8e686233e1ba280',candidate:'a21d5d137659d81193a196414e31c8c0012718ff',
    candidateTree:'f42680b76e3750ccc9465f9b44165c82e28197de',sourceTree:'9eed5a6094daf8cce6424dd18be3e786a3f0fbb4',
    benchmarkReference:'48a9da40a05b28cfd0d125b6107a771999fb784d',benchmarkPath:'scripts/benchmark-explored-systems.mjs',
    benchmarkSha256:'f5a1f31989c2e074ccd947875a3032ccde6d19f3712b2c9178b38093d8dae5cb',
    effectiveBenchmarkSha256:'4c030af1649a0fb74bfcda7ebfdcb4915e4af24a57e22807ba1b68d7b050457b',
    nativeProofSha256:'105ba1be6f59ae83076e012d7cbea36ce037486c09ee0bc4d1b9914757b3de00',
    coreBundleSha256:'549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171',
    maxProcessMs:12*60*1000,cleanupMs:20000,device:'mobile',bloom:'0',
    criticalThreeSourceHashes:{'src/renderers/WebGLRenderer.js':'8237c77a19ca3bbea3ca0bbe11ea00a1f381ae9a36d44080d20c4de16416b788',
        'src/renderers/webgl/WebGLPrograms.js':'6d9873295f6c039ffc6b06e2710ad8aa92256069e432f46e01853d28addc19d4',
        'src/renderers/webgl/WebGLProgram.js':'730cfc32c611aa12c87453b676373d8405e7807698de5b8c2533af1748ae9cd3'}});
export const digest=s=>createHash('sha256').update(s).digest('hex');
export function managedHeadlessRuntime(require){
    const path=resolve(dirname(require.resolve('playwright-core/package.json')),'lib/coreBundle.js');
    assert.equal(digest(readFileSync(path)),SELECTION_PINS.coreBundleSha256,'Exact Playwright registry implementation');
    const entry=require(path).registry.registry.findExecutable('chromium-headless-shell');
    assert.equal(entry.name,'chromium-headless-shell');assert.equal(String(entry.revision),'1243');
    assert.equal(entry.browserVersion,'153.0.8010.12');
    return{name:entry.name,revision:String(entry.revision),version:entry.browserVersion,executablePath:entry.executablePath(),coreBundleSha256:SELECTION_PINS.coreBundleSha256};
}
export function verifyHeadlessLaunch(ownership,expectedPath){
    assert(Array.isArray(ownership?.executables),'Owned executable-image observations required');
    const matches=ownership.executables.filter(x=>x.commandPath===expectedPath&&x.processImage===expectedPath);
    assert.equal(matches.length,1,'Exactly one actual managed headless-shell process is required');
    return{...matches[0],family:'chromium-headless-shell',actualPathVerified:true};
}

// Explanation only. The native observer evaluates the unchanged production
// Boolean; this tagged copy never participates in rendering or acceptance.
export function explainDiskEligibility(source,input){
    assert.equal(digest(source),'2b703acd2a03e7cd40b8b9e76b7f95ac61659e7e7e9de53da109949fa5e58bbc');
    const start=source.indexOf('export function diskSupportUnclipped('),end=source.indexOf('\nexport function makeHoleOptics',start);
    let helper=source.slice(start,end).replace('export function','function');
    const guards=['input-shape','viewport-bounds','numeric-shape-range','symmetric-projection','helper-lane-extent','orthonormal-basis','support-angular-depth-interior'];
    let index=0;helper=helper.replace(/return false;/g,()=>`return {eligible:false,reason:${JSON.stringify(guards[index++])}};`);
    assert.equal(index,guards.length);
    helper=once(helper,'return Number.isFinite(first) && Number.isFinite(last) && first>2*near && last<far/2;',
        "const eligible=Number.isFinite(first) && Number.isFinite(last) && first>2*near && last<far/2; return {eligible,reason:eligible?'proved-interior':'near-far-interior',first,last,near,far};");
    const result=new Function(helper+';return diskSupportUnclipped;')()(input);
    const original=new Function(source.slice(start,end).replace('export function','function')+';return diskSupportUnclipped;')()(input);
    assert.equal(result.eligible,original,'Explanation cannot change the production proof result');return result;
}
function once(s,from,to){assert.equal(s.split(from).length,2,`Immutable selection marker: ${from}`);return s.replace(from,to);}
export function adaptSelectionBenchmark(original,adapterRoot){
    assert.equal(digest(original),SELECTION_PINS.benchmarkSha256);
    let s=adaptDiskBenchmark(original);assert.equal(digest(s),SELECTION_PINS.effectiveBenchmarkSha256);
    assert.equal(digest(readFileSync(resolve(adapterRoot,'scripts/native-disk-proof.mjs'))),SELECTION_PINS.nativeProofSha256);
    const url=p=>JSON.stringify(pathToFileURL(resolve(adapterRoot,'scripts',p)).href);
    s=`import {makeSelectionObserver,assertCostSelectionProof,SELECTION_POLICY} from ${url('disk-cost-selection-native.mjs')};\nimport {finalizeDiskProbe,initializeDiskReport,atomicDiskReport} from ${url('disk-plane-finalize.mjs')};\nimport {closeNativeDiskResources,boundedNativeOperation} from ${url('native-disk-proof.mjs')};\n`+s;
    s=once(s,"const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\\n');",`Object.assign(report,{diagnosticOnly:true,completed:false,selectionPolicy:SELECTION_POLICY,acceptanceFrames:0,
        authority:'Native mode-selection observation in the unchanged active-cost fixture; no acceptance windows',
        method:'Original serial timer-task frames,120 warmup plus existing four settled frames per revision',
        gate:'No performance acceptance. Complete native observations, unchanged source/fixture and bounded cleanup only',
        fixedDiagnosticExperiment:'Stop after the four original settled frames; no trials, attribution frames or profiler',
        timingInterpretation:'Stored warmup/settlement durations are observation bookkeeping and must not be used as a cost result.'});
const selectionReportPath=resolve(out,'selection-report.json');
await initializeDiskReport(selectionReportPath,report);
const save = async (options={}) => {
    const wantedComplete=report.completed;
    if(report.errors.length)report.completed=false;
    await atomicDiskReport(selectionReportPath,report,options);
    if(wantedComplete && report.errors.length){
        report.completed=false;await atomicDiskReport(selectionReportPath,report,options);
        throw Error('Retained application/shader error prevents completion');
    }
};
let selectionOriginalError,stopSelectionPromise;
const stopSelection = () => stopSelectionPromise ||= boundedNativeOperation('cost-selection-stop',async signal=>{
    const stopped=await pages.B?.evaluate(()=>window.__costSelectionObserver?.stop()||null);
    signal.throwIfAborted();if(stopped && report.selectionNative)report.selectionNative.stopped=stopped;
});`);
    s=once(s,'    report.browser = await browser.version();',`    report.browser = await browser.version();
    assert.equal(report.browser,'153.0.8010.12','Actual launched Chromium must match the pinned runtime');`);
    const warmup='            scenario.warmup[label] = await frames(page, warmupFrames);';
    s=once(s,warmup,`            if(label==='B') {
                await page.evaluate(makeSelectionObserver());
                await page.evaluate(async()=>{
                    const q=pairedQA,holes=q.optics.bh.BH_META;
                    if(holes.length!==1)throw Error('Exactly one placed cost-fixture hole required');
                    const hole=await import('/src/holeOptics.js');
                    window.__costSelectionObserver=window.__createNativeDiskFastPathProof(q.scene.renderer,holes[0].optics.disk,
                        hole.diskSupportUnclipped,()=>({frameNo:__pairedWorkload().frameNo,paused:q.G.paused,t:q.G.t}));
                    __costSelectionObserver.label({kind:'cost-warmup',fixture:'saturn-hole-near'});
                });
            }
`+warmup);
    s=once(s,'            scenario.warmup[label].push(...await frames(page, 4));',`            if(label==='B')report.selectionNative=await page.evaluate(()=>{
                const before=__costSelectionObserver.drain(),startFrame=__pairedWorkload().frameNo;
                __costSelectionObserver.label({kind:'cost-settled',fixture:'saturn-hole-near'});
                return{before,startFrame};
            });
            if(label==='B')assert.equal(report.selectionNative.startFrame,scenario.warmup[label].at(-1).frameNo,'Readiness wait adds no app frame');
            const settledSamples=await frames(page,4);scenario.warmup[label].push(...settledSamples);
            scenario.settledGpuStatus ||= {};
            scenario.settledGpuStatus[label]=await page.evaluate(()=>{const gl=pairedQA.scene.renderer.getContext();return{contextLost:gl.isContextLost(),error:gl.getError()};});
            assert.deepEqual(scenario.settledGpuStatus[label],{contextLost:false,error:0});
            if(label==='B'){
                report.selectionNative.settled=await page.evaluate(()=>__costSelectionObserver.drain());
                report.selectionNative.samples=settledSamples;
                await stopSelection();await save();
            }`);
    const start='        for (const [trialIndex, order] of orders.entries()) {';
    const end="} catch (error) {\n    report.errors.push";
    assert.equal(s.split(start).length,2);assert.equal(s.split(end).length,2);
    const a=s.indexOf(start),b=s.indexOf(end,a);assert(b>a);
    s=s.slice(0,a)+`        for(const label of ['A','B']){
            assert.equal(scenario.warmup[label].length,124);
            const initialFrame=report.pages[label].initial.workload.frameNo;
            assert(scenario.warmup[label].every((sample,i)=>sample.frameNo===initialFrame+i+1),'Exactly124 native frame deliveries after startup');
            assert.equal(scenario.before[label].workload.frameNo,initialFrame+124,'No hidden frame after settlement');
            assert.equal(scenario.before[label].paused,true);assert.equal(scenario.before[label].t,0);
            assert.equal(scenario.before[label].optics.lensEnabled,true);assert.equal(scenario.before[label].optics.lensCount,1);
            assert.equal(scenario.before[label].optics.saturnMap,2048);
        }
        report.selectionResult=assertCostSelectionProof(report.selectionNative);
        assert.equal(report.errors.length,0,'Retained application/shader errors reject diagnostic completion');
        report.completed=true;await save();
    }
    console.log(JSON.stringify({diagnosticOnly:true,completed:report.completed,selection:report.selectionResult},null,2));
`+s.slice(b);
    s=once(s,'    report.errors.push({ message: error.stack || String(error) }); report.passed = false;',
        '    selectionOriginalError=error;report.completed=false;report.errors.push({ message: error.stack || String(error) }); report.passed = false;');
    s=once(s,`    await save(); await browser?.close(); for (const server of servers) await server.close();
    for (const cache of caches) await rm(cache, { recursive: true, force: true });`,
`    await finalizeDiskProbe({report,hadOriginalError:!!selectionOriginalError,originalError:selectionOriginalError,
        verifySources:async()=>{assert.equal(report.errors.length,0,'Retained application/shader errors reject cleanup completion');},flush:save,
        closeBrowser:()=>closeNativeDiskResources(stopSelection,()=>browser?.close()),
        closeServer:async()=>{
            const outcomes=await Promise.allSettled(servers.map(server=>server.close()));
            for(const cache of caches){try{await rm(cache,{recursive:true,force:true});}catch(error){outcomes.push({status:'rejected',reason:error});}}
            const failures=outcomes.filter(x=>x.status==='rejected');if(failures.length)throw new AggregateError(failures.map(x=>x.reason),'Selection server/cache cleanup');
        }});`);
    assert(!s.includes('for (const [trialIndex, order]')&&!s.includes('report.longTaskBudget =')&&!s.includes('Profiler.start'));
    return s;
}
