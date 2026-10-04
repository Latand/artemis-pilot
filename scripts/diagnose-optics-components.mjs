#!/usr/bin/env node
// Deliberately separate from benchmark-explored-systems.mjs and PR52 gates.
// --validate is browser-free. --run is for a separately authorized execution.
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { BASE, HEAD, TREE, PLAN_SHA256, VARIANTS, ORDERS, CAP_MS, WARMUP, SETTLED, SAMPLES, FIXTURE, VIEWPORT, QUERY,
    sha, HOOK_PATHS, transformSource, inspectRoot, validateTrace, validateLedger, attribute, KEY_IMAGES,
    RING_CONTRASTS, pixelCases, extractPixelProbe, checkPixelCase, crossingResult, assertMatchedState, assertStableState } from './optics-component-contract.mjs';
import { initializePage, configureFixture, readState, inspectNativePrograms, preparePixelFixture } from './optics-component-browser.mjs';

const self=fileURLToPath(import.meta.url),qaRoot=resolve(dirname(self),'..');
const baselineRoot=resolve(process.env.BASE_ROOT||''),candidateRoot=resolve(process.env.CANDIDATE_ROOT||'');
assert(process.env.BASE_ROOT&&process.env.CANDIDATE_ROOT,'BASE_ROOT and CANDIDATE_ROOT must name the two exact immutable worktrees');
assert(process.argv.includes('--validate')||process.argv.includes('--run')||process.argv.includes('--worker'),
    'Use --validate for local source/hook checks; execution needs a separately authorized --run');
const out=resolve(process.env.ARTEMIS_EVIDENCE||'evidence/optics-components');
const browserArgs=['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'];
async function preflight() {
    const roots={A:await inspectRoot(baselineRoot,BASE),B:await inspectRoot(candidateRoot,HEAD)};
    const transforms={};
    for(const v of VARIANTS){
        transforms[v.label]={};const source=roots[v.label==='A'?'A':'B'];
        for(const path of HOOK_PATHS){
            const transformed=transformSource(source.sources[path],path,v,roots.A.sources['src/holeOptics.js']);
            execFileSync(process.execPath,['--input-type=module','--check'],{input:transformed});
            transforms[v.label][path]={original:sha(source.sources[path]),effective:sha(transformed)};
        }
    }
    const pixelProbe=await readFile(resolve(candidateRoot,'scripts/probe-optics-partial-release.mjs'),'utf8');
    const pixelFunction=extractPixelProbe(pixelProbe);
    execFileSync(process.execPath,['--input-type=module','--check'],{input:`(${pixelFunction})`});
    const {sources:as,...a}=roots.A,{sources:bs,...b}=roots.B;
    const harnessFiles=['scripts/diagnose-optics-components.mjs','scripts/optics-component-contract.mjs','scripts/optics-component-browser.mjs','scripts/smoke-optics-components.mjs','docs/optics-component-diagnostic.md'];
    const harnessHashes={};for(const path of harnessFiles)harnessHashes[path]=sha(await readFile(resolve(qaRoot,path)));
    const provenance={roots:{A:a,B:b},transforms,harnessHashes,harnessFingerprint:sha(JSON.stringify(harnessHashes)),
        harnessCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:qaRoot,encoding:'utf8'}).trim(),
        harnessTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:qaRoot,encoding:'utf8'}).trim(),
        planSha256:PLAN_SHA256,pixelProbe:{source:sha(pixelProbe),effectiveFunction:sha(pixelFunction)},
        build:{kind:'Vite test-server transforms; no production build substitute',lockHashes:Object.fromEntries(Object.entries(b.hashes).filter(([path])=>/^(bun\.lock|bun\.lockb|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path))),
            effectiveShaders:'Recorded from actual native GL programs only AFTER both timing orders; unverified until execution'}};
    return {roots,provenance,pixelFunction};
}

if(process.argv.includes('--validate')){
    const {provenance}=await preflight();
    await mkdir(out,{recursive:true});await writeFile(resolve(out,'validation.json'),JSON.stringify({status:'source-and-native-hooks-valid',browserExecuted:false,
        variants:VARIANTS,orders:ORDERS,warmupFramesPerVariant:WARMUP,settledFramesPerVariant:SETTLED,measuredFrames:120,hardCapMs:CAP_MS,
        minimumPreparationFrames:744,startup:'Additional native deliveries, all retained; startup protocol roundtrip is null with navigation envelope',
        acceptance:null,provenance},null,2)+'\n');
    console.log(JSON.stringify({status:'source-and-native-hooks-valid',browserExecuted:false,variants:VARIANTS.map(v=>v.label),orders:ORDERS,
        evidence:resolve(out,'validation.json'),harnessFingerprint:provenance.harnessFingerprint}));
}else if(process.argv.includes('--worker')){
    assert(typeof process.send==='function','Workers require the hard-cap supervisor IPC; never run directly');
    await worker();
}else{
    await supervise();
}

async function supervise(){
    await mkdir(out,{recursive:true});
    // Refuse to overwrite/reuse an experiment: no automatic retry or pooling.
    const journal=resolve(out,'events.jsonl');
    const {openSync,closeSync}=await import('node:fs');closeSync(openSync(journal,'wx'));
    const report={version:1,diagnosticOnly:true,acceptance:null,status:'running',started:new Date().toISOString(),hardCapMs:CAP_MS,
        variants:VARIANTS,orders:ORDERS,warmupFramesPerVariant:WARMUP,settledFramesPerVariant:SETTLED,samplesPerBlock:SAMPLES,
        fixture:FIXTURE,query:QUERY,viewport:VIEWPORT,deviceScaleFactor:1,mobile:true,bloom:false,
        pages:{},ledgers:Object.fromEntries(VARIANTS.map(v=>[v.label,[]])),blocks:[],postTiming:{},events:[],errors:[],
        futureFixedPointEvidenceComplete:false,limits:'CI software-renderer diagnostic. Thin edges remain open. No PR52 acceptance verdict.'};
    const save=()=>writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');save();
    const child=fork(self,['--worker'],{cwd:qaRoot,env:{...process.env,ARTEMIS_EVIDENCE:out},detached:true,stdio:['ignore','inherit','inherit','ipc']});
    let terminal=false;
    const stop=()=>{try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')report.errors.push(String(e));}};
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{terminal=true;report.status='interrupted-partial';report.errors.push(`Supervisor received ${signal}; no retry`);report.finished=new Date().toISOString();save();stop();process.exit(1);});
    const timer=setTimeout(()=>{
        terminal=true;report.status='hard-cap-partial';report.finished=new Date().toISOString();
        report.errors.push('Twenty-minute hard cap. Partial journal and completed samples retained. No automatic retry.');
        save();stop();process.exitCode=1;
    },CAP_MS);
    child.on('message',message=>{
        if(terminal)return;
        const {sequence,event}=message;
        appendFileSync(journal,JSON.stringify({sequence,...event})+'\n');
        if(event.type==='frame')report.ledgers[event.label].push(event.sample);
        else if(event.type==='block')report.blocks.push(event.block);
        else if(event.type==='page')report.pages[event.label]={...report.pages[event.label],...event.value};
        else if(event.type==='provenance')report.provenance=event.value;
        else if(event.type==='post')report.postTiming[event.key]=event.value;
        else if(event.type==='error')report.errors.push(event.value);
        else if(event.type==='complete'){
            report.status='complete-diagnostic';report.attribution=event.value;report.finished=new Date().toISOString();
        }else report.events.push(event);
        // Persist before acknowledgement: completed samples survive a hard kill.
        if(!['frame','delivery-start'].includes(event.type))save();child.send({ack:sequence});
    });
    await new Promise(resolveDone=>child.once('exit',(code,signal)=>{
        clearTimeout(timer);
        if(!terminal){terminal=true;if(code!==0||report.status!=='complete-diagnostic'){
            report.status='failed-partial';report.errors.push(`Worker exited ${code}, signal ${signal}`);process.exitCode=1;
        }report.finished=new Date().toISOString();save();stop();}
        resolveDone();
    }));
    console.log(JSON.stringify({status:report.status,acceptance:null,report:resolve(out,'report.json')}));
}
async function worker(){
    let sequence=0;
    process.once('disconnect',()=>{try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(1);}});
    const waiting=new Map();process.on('message',m=>{const f=waiting.get(m.ack);if(f){waiting.delete(m.ack);f();}});
    const emit=event=>new Promise((resolveAck,reject)=>{
        const id=++sequence;waiting.set(id,resolveAck);process.send({sequence:id,event},error=>{if(error){waiting.delete(id);reject(error);}});
    });
    let browser;const servers=[],caches=[],pages={},ledger=Object.fromEntries(VARIANTS.map(v=>[v.label,[]])),blocks=[];
    const errors=[],served={},responses={};
    try{
        const {roots,provenance,pixelFunction}=await preflight();await emit({type:'provenance',value:provenance});
        const [{chromium},{createServer}]=await Promise.all([import('playwright'),import('vite')]);
        const {transformCelestialSource}=await import(pathToFileURL(resolve(candidateRoot,'scripts/celestial-detail-fixtures.mjs')).href);
        const {verifyDeferredEdgeFixture}=await import(pathToFileURL(resolve(candidateRoot,'scripts/optics-deferred-edge-fixture.mjs')).href);
        async function serverFor(v,pixel=false){
            const root=v.label==='A'?baselineRoot:candidateRoot,mode=pixel?'pixels':'timing',key=`${v.label}/${mode}`;
            served[key]={};responses[key]={};const cacheDir=await mkdtemp(resolve(os.tmpdir(),'optics-components-'));caches.push(cacheDir);
            const server=await createServer({root,cacheDir,...(pixel?{configFile:false}:{}),logLevel:'error',
                server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{
                    name:'optics-components-source',enforce:'pre',
                    configureServer(server){
                        // Hash the exact response bytes supplied by Vite,
                        // including optimized dependencies and static assets.
                        server.middlewares.use((request,response,next)=>{
                            const hash=createHash('sha256');let bytes=0;
                            const write=response.write,end=response.end;
                            const add=(chunk,encoding)=>{if(typeof chunk==='string'||Buffer.isBuffer(chunk)){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,typeof encoding==='string'?encoding:undefined);hash.update(b);bytes+=b.length;}};
                            response.write=function(chunk,encoding,...rest){add(chunk,encoding);return write.call(this,chunk,encoding,...rest);};
                            response.end=function(chunk,encoding,...rest){
                                add(chunk,encoding);const value={sha256:hash.digest('hex'),bytes,status:response.statusCode,contentType:response.getHeader('content-type')||null};
                                const url=request.url;
                                if(response.statusCode===200&&responses[key][url]?.status===200&&responses[key][url].sha256!==value.sha256)
                                    errors.push({label:key,message:`Served build response changed: ${url}`});
                                // Preserve every response, including 304/errors, without
                                // replacing the full response-body hash with an empty one.
                                (responses[key][url] ||= {deliveries:[]}).deliveries.push(value);
                                if(value.status===200)Object.assign(responses[key][url],value);
                                return end.call(this,chunk,encoding,...rest);
                            };next();
                        });
                    },
                    resolveId(id){if(pixel&&id==='virtual:galaxy-preview')return '\0component-no-preview';},
                    load(id){if(id==='\0component-no-preview')return 'export default null;';},
                    transform(source,id){
                        const path=relative(root,id.split('?')[0]).replaceAll('\\','/');
                        if(pixel){
                            if(path==='src/lensing.js'||path==='src/holeOptics.js')return transformSource(source,path,v,roots.A.sources['src/holeOptics.js']);
                            return transformCelestialSource(source,id);
                        }
                        return HOOK_PATHS.includes(path)?transformSource(source,path,v,roots.A.sources['src/holeOptics.js']):null;
                    },
                },{name:'optics-components-module-hashes',enforce:'post',transform(source,id){
                    served[key][relative(root,id).replaceAll('\\','/')]=sha(source);return null;
                }}]});
            await server.listen();servers.push(server);return server;
        }
        async function activate(page){const t=performance.now();await page.bringToFront();await page.waitForFunction(()=>!document.hidden);return performance.now()-t;}
        function watch(page,label){
            page.on('pageerror',e=>errors.push({label,message:e.stack||String(e)}));
            page.on('console',m=>{if(m.type()==='error'&&/THREE|Shader|GL_INVALID|WebGL/i.test(m.text()))errors.push({label,message:m.text()});});
            page.on('crash',()=>errors.push({label,message:'Page crashed'}));
        }
        const guardErrors=()=>assert.deepEqual(errors,[],'Native application/shader errors invalidate evidence');
        async function deliver(page,label,phase){
            await emit({type:'delivery-start',label,phase});
            const start=performance.now();
            const sample=await page.evaluate(phase=>new Promise((yes,no)=>setTimeout(()=>{
                try{yes(__componentDeliver(phase));}catch(e){no(e);}
            },0)),phase);
            sample.roundTripMs=performance.now()-start;sample.protocolAndSchedulingMs=Math.max(0,sample.roundTripMs-sample.frameAndFinishMs);
            ledger[label].push(sample);await emit({type:'frame',label,sample});
            validateLedger(ledger[label],VARIANTS.find(v=>v.label===label),false);guardErrors();return sample;
        }
        async function gpuGuard(page){
            const status=await page.evaluate(()=>{const gl=componentQA.scene.renderer.getContext();return {contextLost:gl.isContextLost(),error:gl.getError()};});
            assert.deepEqual(status,{contextLost:false,error:0},'Native live-GL/error guard');return status;
        }
        browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:browserArgs});
        await emit({type:'environment',browser:await browser.version(),browserArgs,hardware:{platform:os.platform(),release:os.release(),arch:os.arch(),
            logicalCPUs:os.cpus().length,cpuModels:[...new Set(os.cpus().map(c=>c.model))],totalMemoryBytes:os.totalmem(),node:process.version}});
        for(const v of VARIANTS){
            const label=v.label,server=await serverFor(v),context=await browser.newContext({viewport:VIEWPORT,deviceScaleFactor:1,isMobile:true,hasTouch:true});
            await context.addInitScript(()=>{
                Date.now=()=>Date.UTC(2026,9,1,12);localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','observe');localStorage.setItem('ap_perf','0');
                window.__componentLongTasks=[];
                if(PerformanceObserver.supportedEntryTypes.includes('longtask')){
                    window.__componentObserver=new PerformanceObserver(list=>{for(const e of list.getEntries())__componentLongTasks.push({startTime:e.startTime,duration:e.duration});});
                    __componentObserver.observe({type:'longtask',buffered:true});
                }
            });
            const page=await context.newPage();pages[label]=page;page.setDefaultTimeout(120000);watch(page,label);
            await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
            await activate(page);await emit({type:'navigation-start',label});const navStart=performance.now();
            await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?${new URLSearchParams(QUERY)}`,{waitUntil:'domcontentloaded'});
            await page.waitForFunction(()=>window.__AP_READY&&window.__componentDeliver);
            const navigationEnvelopeMs=performance.now()-navStart;
            const startup=await page.evaluate(()=>__componentState.ledger);
            for(const entry of startup){
                const sample={...entry,roundTripMs:null,roundTripScope:'navigation-envelope',navigationEnvelopeMs,
                    roundTripReason:'Native startup executes during module navigation; per-frame Node transport timing does not exist.'};
                ledger[label].push(sample);await emit({type:'frame',label,sample});
            }
            validateLedger(ledger[label],v,false);
            const info=await page.evaluate(initializePage,label);assert.equal(info.mobile,true);assert.equal(info.longTaskSupported,true);
            if(label!=='A')assert.equal(info.gpu,pages.A.__gpu);page.__gpu=info.gpu;
            // Preserve the original one-time observer/readiness guard, untimed.
            const probe=await page.evaluate(()=>new Promise(resolveProbe=>setTimeout(()=>{const start=performance.now();while(performance.now()-start<80){}resolveProbe({start,end:performance.now()});},0)));
            await page.waitForFunction(p=>{
                for(const e of __componentObserver.takeRecords())__componentLongTasks.push({startTime:e.startTime,duration:e.duration});
                return __componentLongTasks.some(e=>Math.min(e.startTime+e.duration,p.end)-Math.max(e.startTime,p.start)>=70);
            },probe,{timeout:10000});
            await page.evaluate(()=>{__componentObserver.takeRecords();__componentLongTasks.length=0;});
            const initial=await page.evaluate(readState);assert.deepEqual(initial.maps,{night:1,clouds:1,moon:true});
            await emit({type:'page',label,value:{...info,navigationEnvelopeMs,observerProbe:probe,initial}});
            await page.evaluate(configureFixture,FIXTURE);
            for(let i=0;i<WARMUP;i++)await deliver(page,label,'warmup');
            const waitStart=performance.now();await emit({type:'settlement-wait-start',label});
            await page.waitForFunction(()=>{const s=componentQA.surfaces.componentSurfaceQueue();return !s.pending&&!s.inFlight;});
            await emit({type:'settlement-wait-end',label,elapsedMs:performance.now()-waitStart,nativeDeliveries:0,
                explanation:'Native preparation waits for the complete surface queue; this wait itself executes no application frame.'});
            for(let i=0;i<SETTLED;i++)await deliver(page,label,'settled');
            const before=await page.evaluate(readState);page.__before=before;
            assert(before.optics.lensEnabled&&before.optics.lensCount>0&&before.optics.saturnMap>0);
            assert.equal(before.t,0);assert.equal(before.paused,true);assert.equal(before.quality.bloom,false);
            assert.equal(before.quality.width,430);assert.equal(before.quality.height,932);assert.equal(before.quality.dpr,1);
            assert.equal(before.workload.nearVisualReady,true);await gpuGuard(page);guardErrors();
            await emit({type:'page',label,value:{before,activeWorkers:page.workers().map(w=>w.url())}});
        }
        for(const v of VARIANTS.slice(1))assertMatchedState(pages.A.__before,pages[v.label].__before);
        await emit({type:'timing-start',preparationFrames:Object.values(ledger).reduce((n,l)=>n+l.length,0)});
        for(const [orderIndex,order]of ORDERS.entries())for(const label of order){
            const page=pages[label],activationMs=await activate(page);assertStableState(page.__before,await page.evaluate(readState));
            const startTime=await page.evaluate(()=>performance.now()),samples=[];
            for(let i=0;i<SAMPLES;i++)samples.push(await deliver(page,label,`measure-${orderIndex+1}`));
            const endTime=await page.evaluate(()=>performance.now());
            const status=await gpuGuard(page),after=await page.evaluate(readState);assertStableState(page.__before,after);guardErrors();
            const block={order:orderIndex+1,label,activationMs,startTime,endTime,samples,gpuStatus:status,after,loadAverage:os.loadavg()};
            blocks.push(block);await emit({type:'block',block});
        }
        for(const v of VARIANTS)validateLedger(ledger[v.label],v);
        assert.equal(blocks.flatMap(b=>b.samples).length,120);
        await emit({type:'timing-complete',measuredFrames:120});
        // Nothing above this boundary performs extra program/uniform inspection,
        // screenshots, pixel probes, reloads or second-order warmup.
        for(const v of VARIANTS){
            const page=pages[v.label];await activate(page);
            const nativeLedger=await page.evaluate(()=>__componentState.ledger.map(e=>({serial:e.serial,frameNo:e.frameNo,phase:e.phase})));
            assert.deepEqual(nativeLedger,ledger[v.label].map(e=>({serial:e.serial,frameNo:e.frameNo,phase:e.phase})),'Browser and supervisor delivery ledgers agree exactly');
            const longTasks=await page.evaluate(()=>[...__componentLongTasks,...__componentObserver.takeRecords().map(e=>({startTime:e.startTime,duration:e.duration}))]);
            await emit({type:'post',key:`${v.label}-longTasks`,value:{allEntries:longTasks,acceptance:null}});
            await page.evaluate(()=>{__componentState.phase='post-timing';__componentState.inspect=true;});
            const inspected=await page.evaluate(()=>new Promise((yes,no)=>setTimeout(()=>{try{yes(__componentDeliver('post-timing'));}catch(e){no(e);}},0)));
            await page.evaluate(()=>{__componentState.inspect=false;});
            assert.equal(inspected.lensDraws.length,1);validateTrace(inspected.lensDraws[0],v,true);
            const programs=await page.evaluate(inspectNativePrograms);
            assert.equal(programs.contextLost,false);assert.equal(programs.error,0);
            for(const p of programs.programs){assert(p.linked);for(const s of p.shaders){assert(s.compiled);s.sha256=sha(s.source);}}
            for(const s of inspected.lensDraws[0].gpu[0].shaders)s.sha256=sha(s.source);
            assert(inspected.lensDraws[0].gpu[0].shaders.some(s=>s.source.includes(programs.materialFragment)), 'Actual active program must contain the native effective lens fragment');
            programs.materialFragmentSha256=sha(programs.materialFragment);
            const nativeTexture=inspected.lensDraws[0].gpu[0].nativeTexture;
            if(v.label==='A')assert.equal(nativeTexture,null);
            else{
                assert(nativeTexture.bound);
                for(const key of ['minFilter','magFilter','wrapS','wrapT']){
                    // Three enums differ from GL enums. Retain both identities;
                    // cross-variant equality is checked below using actual GL.
                    assert(Number.isFinite(nativeTexture[key]));
                }
                if(pages.B.__nativeTexture)assert.deepEqual(nativeTexture,pages.B.__nativeTexture,'Actual native texture sampling settings match');
                if(v.label==='B')pages.B.__nativeTexture=nativeTexture;
            }
            await emit({type:'post',key:`${v.label}-nativePrograms`,value:{inspectionDelivery:inspected,...programs}});
        }
        await emit({type:'post',key:'timing-build',value:{modules:structuredClone(served),responses:structuredClone(responses),sha256:sha(JSON.stringify({served,responses})),scope:'Vite post-plugin module hashes; native effective shaders recorded separately'}});
        // Separate contexts retain the existing pixel fixture's original
        // Oct-3 epoch, 390x700 viewport, source/depth/TDE assertions and labels.
        const pixelResults={},contrasts={};
        const probeFunction=Function(`return (${pixelFunction});`)();
        for(const v of VARIANTS){
            const label=v.label,server=await serverFor(v,true),context=await browser.newContext({viewport:{width:390,height:700},deviceScaleFactor:1,isMobile:true,hasTouch:true});
            await context.addInitScript(()=>{
                Date.now=()=>Date.UTC(2026,9,3,12);localStorage.clear();localStorage.setItem('ap_introSeen','1');window.__qaBloom=false;
                window.__componentState={phase:'post-timing',inspect:false,lensDraws:[]};
            });
            const page=await context.newPage();page.setDefaultTimeout(180000);watch(page,`${label}/pixels`);
            await page.route(/fonts\.(googleapis|gstatic)\.com/,r=>r.fulfill({contentType:'text/css',body:''}));
            await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=saturn&dist=600&bloom=0&river=0&field=0&realsky=0&tier1=0&galaxies=0&galaxyvol=0&galaxy=0&compile=0&hidehelp=1`,{waitUntil:'domcontentloaded'});
            await page.waitForFunction(()=>window.__AP_READY&&window.__celestialFrame);
            await page.evaluate(label=>{window.componentQA={label};window.__componentEnsureLensing=window.__celestialEnsureLensing;},label);
            const metadata=await page.evaluate(preparePixelFixture);assert.equal(metadata.epoch,Date.UTC(2026,9,3,12));
            assert.deepEqual(metadata.viewport,{width:390,height:700});
            const directory=resolve(out,'pixels',label);await mkdir(directory,{recursive:true});
            await emit({type:'post',key:`${label}-pixelMetadata`,value:{...metadata,variant:v,sourceRevision:v.revision,
                originalProbeSourceHash:provenance.pixelProbe.source,effectiveProbeHash:provenance.pixelProbe.effectiveFunction,
                ringControl:'C/D normal draws override after real capture. The separately labelled no-ring-depth-no-tides image intentionally suppresses capture, exactly as the existing pixel probe.'}});
            if(label==='B'){
                const deferred=await verifyDeferredEdgeFixture(page);
                for(const[name,png]of Object.entries(deferred.images))await writeFile(resolve(directory,`depth-fixture-${name}.png`),Buffer.from(png.split(',')[1],'base64'));
                delete deferred.images;await emit({type:'post',key:'B-deferred-edge-fixture',value:deferred});
            }
            const cases=[];let keyCount=0;
            for(const fixture of pixelCases(label)){
                await emit({type:'pixel-case-start',label,...fixture});
                const result=await page.evaluate(probeFunction,fixture);
                for(const[scenario,pitch,kind]of KEY_IMAGES)if(scenario===fixture.scenario&&pitch===fixture.pitch){
                    assert(result.images[kind]);const bytes=Buffer.from(result.images[kind].split(',')[1],'base64');
                    const file=`${scenario}-${pitch}-${kind}.png`;await writeFile(resolve(directory,file),bytes);keyCount++;
                    await emit({type:'pixel-image',label,file:`pixels/${label}/${file}`,sha256:sha(bytes),...fixture,kind});
                }
                if(result.contrastBytes&&['B','C','D','E'].includes(label))contrasts[label]=result.contrastBytes;
                delete result.images;delete result.contrastBytes;cases.push({...fixture,...result});
                await emit({type:'post',key:`${label}-pixel-${fixture.scenario}-${fixture.pitch}`,value:result});
                checkPixelCase(result,label,fixture.scenario);guardErrors();
            }
            assert.equal(keyCount,8);if(label==='B')assert.equal(cases.length,31);
            pixelResults[label]={cases,keyImages:keyCount};
            if(label==='B'||label==='F'){
                pixelResults[label].crossing=crossingResult(cases);
                if(label==='B')assert.equal(pixelResults[label].crossing.passed,true,'Unmodified candidate keeps all existing crossing bounds');
                if(label==='F')assert.equal(pixelResults[label].crossing.passed,false,'Exact-main disk control must expose its known crossing defect');
            }
            await emit({type:'post',key:`${label}-pixelSummary`,value:pixelResults[label]});await context.close();
        }
        const ringContrasts=[];
        for(const[a,b]of RING_CONTRASTS)for(const kind of ['production','no-tides']){
            const x=contrasts[a][kind],y=contrasts[b][kind];assert.equal(x.length,y.length);let changedPixels=0,maxChannelDelta=0,absoluteChannelSum=0;
            for(let i=0;i<x.length;i+=4){let changed=false;for(let c=0;c<3;c++){const d=Math.abs(x[i+c]-y[i+c]);changed ||= d>0;maxChannelDelta=Math.max(maxChannelDelta,d);absoluteChannelSum+=d;}changedPixels+=Number(changed);}
            ringContrasts.push({a,b,kind,scenario:'saturn-near-lens',pitch:.48,changedPixels,maxChannelDelta,absoluteChannelSum,
                interpretation:'Only ring-query presence differs; normalized disk and lens-iteration count are identical within this pair.'});
        }
        await emit({type:'post',key:'ring-only-pixel-contrasts',value:ringContrasts});
        await emit({type:'post',key:'all-build-inputs',value:{modules:served,responses,sha256:sha(JSON.stringify({served,responses}))}});
        // Recheck immutable files after serving and prove acceptance scripts and
        // production sources were never rewritten by any test-server transform.
        const finalA=await inspectRoot(baselineRoot,BASE),finalB=await inspectRoot(candidateRoot,HEAD);
        assert.equal(finalA.sourceFingerprint,provenance.roots.A.sourceFingerprint);assert.equal(finalB.sourceFingerprint,provenance.roots.B.sourceFingerprint);
        guardErrors();await emit({type:'complete',value:attribute(blocks)});
    }catch(error){
        await emit({type:'error',value:error.stack||String(error)});process.exitCode=1;
        for(const error of errors)await emit({type:'error',value:error});
    }finally{
        await browser?.close();for(const server of servers)await server.close();for(const cache of caches)await rm(cache,{recursive:true,force:true});
        process.removeAllListeners('disconnect');process.disconnect();
    }
}
