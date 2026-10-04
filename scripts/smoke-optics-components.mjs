// Browser-free positive and adversarial contracts for the component diagnostic.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE,HEAD,TREE,VARIANTS,ORDERS,CAP_MS,WARMUP,SETTLED,SAMPLES,HOOK_PATHS,
    transformSource,supportBlock,lensBoundary,validateTrace,validateLedger,attribute,sha,once,
    extractPixelProbe,pixelCases,KEY_IMAGES,RING_CONTRASTS,checkPixelCase,crossingResult,DENSE,inspectRoot,assertMatchedState,assertStableState,assertNoExtraInputs } from './optics-component-contract.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const git=(rev,path)=>execFileSync('git',['show',`${rev}:${path}`],{cwd:root,encoding:'utf8'});
const candidate=Object.fromEntries(HOOK_PATHS.map(p=>[p,git(HEAD,p)]));
const baseline=Object.fromEntries(HOOK_PATHS.map(p=>[p,git(BASE,p)]));
const v=label=>VARIANTS.find(v=>v.label===label);
let controls=0;
function rejects(name,fn){assert.throws(fn,undefined,name);controls++;}
assert.equal(execFileSync('git',['rev-parse',`${HEAD}^{tree}`],{cwd:root,encoding:'utf8'}).trim(),TREE);
assert.equal(CAP_MS,1200000);assert.equal(WARMUP,120);assert.equal(SETTLED,4);assert.equal(SAMPLES,10);
assert.deepEqual(ORDERS,['ABCDEF','FEDCBA']);assert.equal(VARIANTS.length,6);
rejects('Frozen variant cannot change',()=>{VARIANTS[2].ring='native';});
rejects('No custom seventh variant',()=>transformSource(candidate['src/lensing.js'],'src/lensing.js',{label:'G'},baseline['src/holeOptics.js']));
for(const variant of VARIANTS)for(const path of HOOK_PATHS){
    const source=(variant.label==='A'?baseline:candidate)[path];
    const result=transformSource(source,path,variant,baseline['src/holeOptics.js']);
    execFileSync(process.execPath,['--input-type=module','--check'],{input:result});
}
for(const variant of [v('D'),v('E')]){
    const original=candidate['src/lensing.js'],transformed=transformSource(original,'src/lensing.js',variant,baseline['src/holeOptics.js']);
    for(const guard of ['float finiteSource = clamp(1.0 - uDist[i] / max(sourceZ, 1e-9)','vec2 verifiedQ = p;',
        'float coherenceWeight = 1.0-smoothstep(.002,.01,length(q-verifiedQ));','if (zv < uDist[i]) continue;',
        'float border = min(min(rawUv.x,rawUv.y),min(1.0-rawUv.x,1.0-rawUv.y));','gl_FragDepthEXT = supported > .5 ? dq : dz;',
        'if (uHasDepth == 1 && zBent < 1e29 && sourceZ < zBent)'])assert(transformed.includes(guard));
    assert.equal(transformed.slice(transformed.indexOf('fragmentShader:'),transformed.indexOf('lensingPass.enabled = false;')),
        original.slice(original.indexOf('fragmentShader:'),original.indexOf('lensingPass.enabled = false;')).replace('iteration < 3','iteration < 1'),
        'Only the iteration bound changes in the full fragment, including all final guards');
}
const lens=candidate['src/lensing.js'];
for(const token of ['    lensQuad.render(rendererArg);','        super.render(rendererArg, writeBuffer, readBuffer, deltaTime, maskActive);']){
    rejects('Missing native draw marker',()=>transformSource(lens.replace(token,''),'src/lensing.js',v('C'),baseline['src/holeOptics.js']));
    rejects('Duplicate native draw marker',()=>transformSource(lens+token,'src/lensing.js',v('C'),baseline['src/holeOptics.js']));
}
rejects('Missing iteration marker',()=>transformSource(lens.replace('iteration < 3','iteration < 9'),'src/lensing.js',v('D'),baseline['src/holeOptics.js']));
rejects('Extra native delivery',()=>transformSource(candidate['src/main.js']+'\nframe();','src/main.js',v('B'),baseline['src/holeOptics.js']));
rejects('Missing animation-loop hook',()=>transformSource(candidate['src/main.js'].replace('renderer.setAnimationLoop(frame);',''),'src/main.js',v('B'),baseline['src/holeOptics.js']));
const disk=transformSource(candidate['src/holeOptics.js'],'src/holeOptics.js',v('F'),baseline['src/holeOptics.js']);
assert.equal(supportBlock(disk),supportBlock(baseline['src/holeOptics.js']));
assert.equal(disk.replace(supportBlock(disk),'BLOCK'),candidate['src/holeOptics.js'].replace(supportBlock(candidate['src/holeOptics.js']),'BLOCK'),'All non-support disk shader, emission, depth, blend, noise and draw code remains exact');
rejects('Wrong main block',()=>transformSource(candidate['src/holeOptics.js'],'src/holeOptics.js',v('F'),candidate['src/holeOptics.js']));
rejects('Missing support marker',()=>supportBlock('void main(){}'));
// Mock only the WebGL contract; these are not shader/pixel/performance results.
function boundary(off,{captured=1,inspect=false,phase='measure-1',throws=false,uploaded}={}){
    let gpuValue=uploaded??captured,glCalls=0,draws=0;
    const gl={CURRENT_PROGRAM:1,SHADER_TYPE:2,COMPILE_STATUS:3,LINK_STATUS:4,
        getParameter(){glCalls++;return {};},getUniformLocation(p,name){glCalls++;return name==='uRingPresent'?'ring':null;},
        getUniform(){glCalls++;return gpuValue;},getAttachedShaders(){glCalls++;return [1,2];},
        getShaderParameter(s,p){glCalls++;return p===3?true:s;},getShaderInfoLog(){glCalls++;return '';},
        getShaderSource(){glCalls++;return 'valid native source '.repeat(20);},getProgramParameter(){glCalls++;return true;},getProgramInfoLog(){glCalls++;return '';},
        drawArrays(){draws++;}};
    const state={phase,inspect,lensDraws:[]};global.window={__componentState:state};
    const uniforms=captured===null?{}:{uRingPresent:{value:captured}};
    let error;
    try{lensBoundary({getContext:()=>gl},uniforms,()=>{
        gpuValue=uploaded??uniforms.uRingPresent?.value??null;gl.drawArrays(4,0,3);if(throws)throw new Error('draw failed');
    },off,'direct');}catch(e){error=e;}
    delete global.window;return {trace:state.lensDraws[0],restored:uniforms.uRingPresent?.value??null,glCalls,draws,error};
}
for(const label of ['A','B','C','D','E','F']){
    const variant=v(label),off=variant.ring==='off-at-lens-draw';
    const measured=boundary(off,{captured:label==='A'?null:1});assert.equal(measured.glCalls,0);assert.equal(measured.draws,1);validateTrace(measured.trace,variant);
    const inspected=boundary(off,{captured:label==='A'?null:1,inspect:true,phase:'post-timing'});assert(inspected.glCalls>0);validateTrace(inspected.trace,variant,true);
}
const failedDraw=boundary(true,{throws:true});assert(failedDraw.error);assert.equal(failedDraw.restored,1);
const failedInspection=boundary(true,{inspect:true});assert.match(failedInspection.error.message,/before both timing/);assert.equal(failedInspection.restored,1);controls++;
rejects('Pre-world off cannot replace real capture',()=>validateTrace(boundary(true,{captured:0}).trace,v('C')));
rejects('JavaScript request without actual GL upload fails',()=>validateTrace(boundary(true,{inspect:true,phase:'post-timing',uploaded:1}).trace,v('C'),true));
rejects('Restoration is required',()=>validateTrace({...boundary(true).trace,restored:0},v('C')));
rejects('Native program witness required',()=>validateTrace(boundary(true).trace,v('C'),true));
rejects('Introspection cannot contaminate measurements',()=>validateTrace(boundary(true,{inspect:true,phase:'post-timing'}).trace,v('C')));
rejects('No silent compositor switch',()=>validateTrace({...boundary(false).trace,path:'composer'},v('B')));
function ledger(label='B'){
    const phases=['startup',...Array(120).fill('warmup'),...Array(4).fill('settled'),...Array(10).fill('measure-1'),...Array(10).fill('measure-2')];
    return phases.map((phase,i)=>({serial:i+1,phase,beforeFrameNo:i,frameNo:i+1,cpuMs:2,finishMs:0,readbackMs:98,frameAndFinishMs:100,
        roundTripMs:phase==='startup'?null:101,...(phase==='startup'?{roundTripScope:'navigation-envelope'}:{}),
        lensDraws:phase==='startup'?[]:[boundary(v(label).ring==='off-at-lens-draw',{captured:label==='A'?null:1}).trace]}));
}
for(const variant of VARIANTS)validateLedger(ledger(variant.label),variant);
for(const[name,mutate]of[
    ['omitted startup',x=>x.shift()],['duplicate serial',x=>x[2].serial=1],['hidden/noop frame',x=>x[2].frameNo--],
    ['unaccounted delivery',x=>x[2].beforeFrameNo--],['warmup shortened',x=>x[120].phase='settlement'],
    ['settled shortened',x=>x[124].phase='settlement'],['measurement removed',x=>x.pop()],
    ['missing CPU',x=>delete x[5].cpuMs],['missing finish',x=>delete x[5].finishMs],['missing readback',x=>delete x[5].readbackMs],
    ['missing roundtrip',x=>delete x[5].roundTripMs],['invented startup transport',x=>x[0].roundTripMs=101],
    ['rewarm between orders',x=>x[130].phase='warmup'],['inspection between orders',x=>x[130].phase='post-timing'],
    ['ring draw skipped',x=>x[125].lensDraws=[]]]){
    const x=ledger();mutate(x);rejects(name,()=>validateLedger(x,v('B')));
}
const syntheticBlocks=values=>ORDERS.flatMap((order,i)=>[...order].map(label=>({label,samples:Array.from({length:10},()=>({cpuMs:2,finishMs:0,readbackMs:values[i][label]-2,frameAndFinishMs:values[i][label],roundTripMs:values[i][label]+1}))})));
const values={A:100,B:200,C:150,D:140,E:170,F:190};
let report=attribute(syntheticBlocks([values,values]));assert.equal(report.acceptance,null);assert.equal(report.conclusions.annulusAt3.status,'direction-resolved-diagnostic');
report=attribute(syntheticBlocks([values,{...values,C:220}]));assert.equal(report.conclusions.annulusAt3.status,'inconclusive');
report=attribute(syntheticBlocks([values,Object.fromEntries(Object.entries(values).map(([k,x])=>[k,x+60]))]));assert(Object.values(report.conclusions).every(c=>c.status==='inconclusive'));
report=attribute(syntheticBlocks([values,{...values,C:180,E:130}]));assert.equal(report.rankingsAgree,false);assert(Object.values(report.conclusions).every(c=>c.status==='inconclusive'));
rejects('No pooling missing opposite order',()=>attribute(syntheticBlocks([values,values]).slice(0,6)));
const wrongOrder=syntheticBlocks([values,values]);wrongOrder[6].label='A';rejects('No replacement order',()=>attribute(wrongOrder));
const pixelSource=git(HEAD,'scripts/probe-optics-partial-release.mjs'),probe=extractPixelProbe(pixelSource);
execFileSync(process.execPath,['--input-type=module','--check'],{input:`(${probe})`});
assert(probe.includes('qa.enc.syncHoleScene()'));assert(probe.includes('identity-reference'));assert(probe.includes('qa.ring?.beginRingSamplingDepth()'));
assert.equal(pixelCases('B').length,31);assert.equal(KEY_IMAGES.length,8);assert.deepEqual(RING_CONTRASTS,[['B','C'],['E','D']]);
rejects('Pixel source shape drift',()=>extractPixelProbe(pixelSource.replace('const result=await page.evaluate(','const result=await elsewhere(')));
const valid={glError:0,state:{meshSourceError:0,lensDepthError:0,diskOn:1,ringProxyNoTides:1,ringProxyAblated:0,edgeRadiusNoTides:null,physicalLensDepth:1000,bodyDepth:100},metrics:{edgeDepthChanged:0,opaquePixels:60,opaqueChanged:0}};
checkPixelCase(valid,'B','saturn-foreground-lens');
for(const[name,mutate]of[['GL error',x=>x.glError=1280],['wrong source depth',x=>x.state.lensDepthError=1],['TDE/source mismatch',x=>x.state.meshSourceError=1],['disk hidden',x=>x.state.diskOn=0],['opaque regression',x=>x.metrics.opaqueChanged=1],['capture missing',x=>x.state.ringProxyNoTides=0]]){
    const x=structuredClone(valid);mutate(x);rejects(name,()=>checkPixelCase(x,'B','saturn-foreground-lens'));
}
checkPixelCase({...valid,state:{...valid.state,ringProxyNoTides:null,ringProxyAblated:null}},'A','saturn-foreground-lens');
const crossings=DENSE.map(pitch=>({scenario:'disk-crossing',pitch,metrics:{diskLight:100,diskPixels:100}}));
assert.equal(crossingResult(crossings).passed,true);
for(const value of [0,126]){const bad=structuredClone(crossings);bad[7].metrics.diskLight=value;assert.equal(crossingResult(bad).passed,false);controls++;}
const jump=structuredClone(crossings);jump[7].metrics.diskLight=124;assert.equal(crossingResult(jump).continuous,false);controls++;
rejects('No incomplete dense sweep',()=>crossingResult(crossings.slice(1)));
// Identity mismatches must abort instead of silently producing attribution.
const state={identity:{token:'fixed',generation:0,contextLost:false},focus:'free',t:0,paused:true,seed:3,epoch:1,
    workload:{frameNo:125,beltCursor:1,kuiperCursor:1,mobile:true,loadShed:1,nearFieldCadence:'every-frame',minor:{belt:{capacity:10}}},
    camera:{distance:600,pitch:.48},ship:[1,2,3],maps:{night:1},quality:{dpr:1,mobile:true,bloom:false},optics:{lensCount:1,uniforms:{uDist:[100]}},
    ring:{map:{minFilter:9987,magFilter:9729,anisotropy:8},modelViewMatrix:[1,2,3]},resources:{programs:[1,2],textures:4,geometries:6},sceneObjects:{objects:10,geometries:6,materials:5},
    background:{galaxy:{enabled:false,ready:true,galaxies:0,visibleChunks:0,buildMs:10},
        volume:{enabled:false,res:[430,932],targetBytes:100,historyReady:false,mapsMs:10,renders:3,invalidations:1,budget:{draft:1,refine:1}},
        tides:{started:false,ready:false,visible:0,particles:0,ms:10,linearPass:{size:null,bytes:0,renders:0},linearFrame:{requested:false,width:0,height:0,colorBytes:0,renders:0}},
        field:{enabled:false,stars:0,meshes:0,budget:350000,epochs:[],staging:false,idle:true,ms:10,gen:1,builds:1,cached:0},
        surfaceQueue:{pending:0,inFlight:false}}};
assertMatchedState(state,state);assertStableState(state,state);
for(const[name,mutate]of[
    ['camera drift',x=>x.camera.pitch=0],['paused world advanced',x=>x.t=1],['lens changed',x=>x.optics.uniforms.uDist[0]=101],
    ['quality changed',x=>x.quality.dpr=.5],['nearest-only texture substituted',x=>x.ring.map.minFilter=9728],
    ['anisotropy changed',x=>x.ring.map.anisotropy=1],['TDE affine changed',x=>x.ring.modelViewMatrix[0]=2],
    ['workload changed',x=>x.workload.minor.belt.capacity=1]]){
    const changed=structuredClone(state);mutate(changed);rejects(name,()=>assertMatchedState(state,changed));rejects(name+' within page',()=>assertStableState(state,changed));
}
for(const[name,mutate]of[
    ['page replaced',x=>x.identity.token='new'],['context recreated',x=>x.identity.generation=1],['context lost',x=>x.identity.contextLost=true],
    ['shader recompiled',x=>x.resources.programs=[1,3]],['resources allocated',x=>x.resources.textures=5],['queue not settled',x=>x.background.surfaceQueue.inFlight=true]]){
    const changed=structuredClone(state);mutate(changed);rejects(name,()=>assertStableState(state,changed));
}
for(const[name,mutate]of[['shader compile failed',x=>x.gpu[0].shaders[0].compiled=false],['program link failed',x=>x.gpu[0].linked=false],['extra lens GL draw',x=>x.gpu.push(x.gpu[0])]]){
    const x=boundary(false,{inspect:true,phase:'post-timing'}).trace;mutate(x);rejects(name,()=>validateTrace(x,v('B'),true));
}
// Cross-page counts must match even when both pages are internally stable.
for(const[name,mutate]of[
    ['CPU scene objects',x=>x.sceneObjects.objects++],['CPU scene geometry',x=>x.sceneObjects.geometries++],
    ['CPU scene materials',x=>x.sceneObjects.materials++],['GPU geometries',x=>x.resources.geometries++],
    ['GPU textures',x=>x.resources.textures++],['GPU programs',x=>x.resources.programs.push(3)],
    ['galaxy background enabled',x=>x.background.galaxy.enabled=true],['galaxy visible chunks',x=>x.background.galaxy.visibleChunks++],
    ['volume target allocation',x=>x.background.volume.targetBytes++],['volume quality budget',x=>x.background.volume.budget.draft=.5],
    ['volume history work',x=>x.background.volume.historyReady=true],['tidal background particles',x=>x.background.tides.particles++],
    ['tidal render pass allocation',x=>x.background.tides.linearPass.bytes=100],['linear background frame',x=>x.background.tides.linearFrame.requested=true],
    ['field background stars',x=>x.background.field.stars++],['field staging workload',x=>x.background.field.staging=true]]){
    const changed=structuredClone(state);mutate(changed);
    assertStableState(state,state);assertStableState(changed,changed);
    rejects(`Individually stable pages differ in ${name}`,()=>assertMatchedState(state,changed));
}
const independentPage=structuredClone(state);independentPage.identity.token='another-page';independentPage.resources.programs=[41,42];
independentPage.background.galaxy.buildMs=99;independentPage.background.volume.mapsMs=99;
independentPage.background.volume.renders=9;independentPage.background.volume.invalidations=9;
independentPage.background.tides.ms=99;independentPage.background.tides.linearPass.renders=9;independentPage.background.tides.linearFrame.renders=9;
Object.assign(independentPage.background.field,{ms:99,gen:9,builds:9,cached:9});
assertMatchedState(state,independentPage);
rejects('Same-count program replacement remains forbidden within one page',()=>assertStableState(state,independentPage));
// Exercise the actual Git ignored/untracked/index enumeration on local files.
// No production worktree, browser, server, or benchmark is touched.
const extraRoot=await mkdtemp(resolve(tmpdir(),'component-extra-inputs-'));
try{
    execFileSync('git',['init','--quiet',extraRoot]);
    await writeFile(resolve(extraRoot,'.gitignore'),'*.local\nnode_modules/\nevidence/\nsrc/generated/\n');
    await writeFile(resolve(extraRoot,'package.json'),'{}\n');
    execFileSync('git',['add','.gitignore','package.json'],{cwd:extraRoot});
    const committed=['.gitignore','package.json'];
    for(const path of ['node_modules/example/.env.local','evidence/report.json']){
        await mkdir(dirname(resolve(extraRoot,path)),{recursive:true});await writeFile(resolve(extraRoot,path),'allowed outside protected inputs');
    }
    assertNoExtraInputs(extraRoot,committed);
    for(const path of ['.env.local','.env.development.local','src/untracked-component.js','public/untracked-ring.png',
        'scripts/untracked-plugin.mjs','src/generated/ignored-input.js','postcss.config.cjs','.postcssrc.json','tsconfig.node.json','.npmrc','.config/postcssrc']){
        await mkdir(dirname(resolve(extraRoot,path)),{recursive:true});await writeFile(resolve(extraRoot,path),'unexpected input');
        if(path==='.env.local')assert.equal(spawnSync('git',['check-ignore','--quiet',path],{cwd:extraRoot}).status,0,'The reproduced env control must actually be ignored');
        rejects(`Extra ignored/untracked served/config input: ${path}`,()=>assertNoExtraInputs(extraRoot,committed));
        await rm(resolve(extraRoot,path));
    }
    await writeFile(resolve(extraRoot,'vite.config.mjs'),'export default {};');
    execFileSync('git',['add','vite.config.mjs'],{cwd:extraRoot});
    rejects('Staging an implicit config cannot bypass source provenance',()=>assertNoExtraInputs(extraRoot,committed));
}finally{await rm(extraRoot,{recursive:true,force:true});}
// Integration control: reproduce the ignored-env failure against a disposable
// exact-main worktree, not the shared immutable baseline used by the runner.
const nativeRoot=await mkdtemp(resolve(tmpdir(),'component-native-provenance-'));
let nativeAdded=false;
try{
    execFileSync('git',['worktree','add','--detach',nativeRoot,BASE],{cwd:root,stdio:'pipe'});nativeAdded=true;
    const clean=await inspectRoot(nativeRoot,BASE);assert.equal(clean.protectedInputs.includesIgnored,true);
    for(const path of ['.env.local','public/untracked-ring.png','postcss.config.cjs']){
        await writeFile(resolve(nativeRoot,path),'unexpected native-root input');
        await assert.rejects(()=>inspectRoot(nativeRoot,BASE),/Unpinned served\/build\/config inputs/);controls++;
        await rm(resolve(nativeRoot,path));
    }
    const tracked=resolve(nativeRoot,'src/lensing.js'),original=await readFile(tracked);
    await writeFile(tracked,Buffer.concat([original,Buffer.from('\n// uncommitted tracked source change\n')]));
    await assert.rejects(()=>inspectRoot(nativeRoot,BASE),/Modified immutable source\/build input: src\/lensing.js/);controls++;
    await writeFile(tracked,original);
}finally{
    if(nativeAdded)execFileSync('git',['worktree','remove','--force',nativeRoot],{cwd:root,stdio:'pipe'});
    else await rm(nativeRoot,{recursive:true,force:true});
}
// Integrity of all pre-existing production and acceptance files, rather than a
// hand-picked subset. New dedicated files are the only permitted difference.
const names=execFileSync('git',['ls-tree','-r','--name-only',HEAD],{cwd:root,encoding:'utf8'}).trim().split('\n');
for(const path of names){
    if(!(path.startsWith('src/')||path.startsWith('scripts/')||path.startsWith('.github/workflows/')))continue;
    assert.equal(sha(await readFile(resolve(root,path))),sha(execFileSync('git',['show',`${HEAD}:${path}`],{cwd:root,maxBuffer:16*1024*1024})),`Existing production/acceptance file changed: ${path}`);
}
// The command must reject missing/wrong source provenance before importing any
// browser package. No browser, server, benchmark or external call is made here.
const badRoot=await mkdtemp(resolve(tmpdir(),'component-provenance-'));
try{
    const result=spawnSync(process.execPath,[resolve(root,'scripts/diagnose-optics-components.mjs'),'--validate'],{
        cwd:root,encoding:'utf8',env:{...process.env,BASE_ROOT:badRoot,CANDIDATE_ROOT:root,ARTEMIS_EVIDENCE:resolve(badRoot,'out')}});
    assert.notEqual(result.status,0);assert(!result.stderr.includes('playwright'));controls++;
}finally{await rm(badRoot,{recursive:true,force:true});}
console.log(JSON.stringify({status:'passed',negativeControls:controls,browserExecuted:false,productionAndAcceptanceFiles:'byte-identical',
    nativeGL:'Mock boundary contract only; actual native compile/uniform/pixel checks require separate authorized execution'}));
