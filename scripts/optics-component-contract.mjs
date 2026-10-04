// Local diagnostic only. No performance acceptance gate is defined here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export const BASE = 'ab51029827cf9324eb737673e46c49ab74aa1718';
export const HEAD = '48a9da40a05b28cfd0d125b6107a771999fb784d';
export const TREE = '117adc60b590e235eeb345eb1079a5f7a2ed6232';
export const PLAN_SHA256 = 'b933f4750decc85573fe44461b497dbef1c6126e04915d5f4a685669106a75fe';
export const VARIANTS = Object.freeze([
    { label: 'A', revision: BASE, iterations: 'native', ring: 'native-absent', disk: 'native' },
    { label: 'B', revision: HEAD, iterations: 3, ring: 'native', disk: 'normalized' },
    { label: 'C', revision: HEAD, iterations: 3, ring: 'off-at-lens-draw', disk: 'normalized' },
    { label: 'D', revision: HEAD, iterations: 1, ring: 'off-at-lens-draw', disk: 'normalized' },
    { label: 'E', revision: HEAD, iterations: 1, ring: 'native', disk: 'normalized' },
    { label: 'F', revision: HEAD, iterations: 3, ring: 'native', disk: 'exact-main-support' },
].map(Object.freeze));
export const ORDERS = Object.freeze(['ABCDEF', 'FEDCBA']);
export const CAP_MS = 20 * 60 * 1000;
export const WARMUP = 120, SETTLED = 4, SAMPLES = 10;
export const FIXTURE = Object.freeze({ name: 'saturn-hole-near', focus: 'free', distance: 600, yaw: Math.PI / 2, pitch: .48 });
export const VIEWPORT = Object.freeze({ width: 430, height: 932 });
export const QUERY = Object.freeze({ focus: 'earth', dist: '25', hidehelp: '1', dpr: '1', tier1: '0', realsky: '0', field: '0',
    galaxyvol: '0', galaxies: '0', galaxy: '0', river: '0', bloom: '0', compile: '0', galadapt: '0', earthnight: '1', clouds: '1', moonmap: '1' });
export const DENSE = Object.freeze([.0008,.0007,.00065,.0006,.00055,.0005,.0004,0,-.0004,-.0005,-.00055,-.0006,-.00065,-.0007,-.0008]);
export const RING_CONTRASTS = Object.freeze([Object.freeze(['B','C']), Object.freeze(['E','D'])]);
export const sha = value => createHash('sha256').update(value).digest('hex');
export function once(source, token, replacement) {
    assert.equal(source.split(token).length, 2, `Native component hook must occur exactly once: ${token}`);
    return source.replace(token, replacement);
}
export function supportBlock(source) {
    const startToken = '        if (uDiskOn > 0.5 && abs(rd.z) > 1e-7) {';
    const endToken = '                // Near-side emission may stand in front of the angular shadow.';
    assert.equal(source.split(startToken).length, 2); assert.equal(source.split(endToken).length, 2);
    const start = source.indexOf(startToken), end = source.indexOf(endToken, start);
    assert(end > start); return source.slice(start, end);
}
// Installed identically for all six variants, including A with no ring uniform.
// No WebGL program/uniform introspection is performed on the measured branch.
export function lensBoundary(renderer, uniforms, draw, ringOff, path) {
    const state = window.__componentState;
    if (!state) throw new Error('Missing component delivery state');
    const uniform = uniforms.uRingPresent;
    const captured = uniform ? uniform.value : null;
    if (ringOff && uniform) uniform.value = 0;
    const trace = { path, captured, requested: uniform ? uniform.value : null, restored: null, gpu: [] };
    const gl = renderer.getContext(), originals = [];
    try {
        if (state.inspect) {
            if (state.phase !== 'post-timing') throw new Error('Introspection before both timing orders');
            for (const key of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
                if (typeof gl[key] !== 'function') continue;
                const original = gl[key]; originals.push([key, original]);
                gl[key] = function (...args) {
                    // Three uploads the material uniforms before reaching this
                    // actual GL draw. Reading before renderer.render is invalid.
                    const program = gl.getParameter(gl.CURRENT_PROGRAM);
                    const location = program && gl.getUniformLocation(program, 'uRingPresent');
                    const shaders = program ? gl.getAttachedShaders(program).map(shader => ({
                        type: gl.getShaderParameter(shader, gl.SHADER_TYPE), source: gl.getShaderSource(shader),
                        compiled: gl.getShaderParameter(shader, gl.COMPILE_STATUS), log: gl.getShaderInfoLog(shader),
                    })) : [];
                    const values={};
                    for(const name of ['uN','uHasDepth','uNear','uFar','uDist[0]','uC[0]','uT2[0]','uAspect','uViewToRing','uRingMapTransform','uRingRadii']){
                        const loc=program&&gl.getUniformLocation(program,name),value=loc===null?null:gl.getUniform(program,loc);
                        values[name]=ArrayBuffer.isView(value)?Array.from(value):value;
                    }
                    let nativeTexture=null;
                    const sampler=program&&gl.getUniformLocation(program,'uRingMap');
                    if(sampler!==null){
                        const oldActive=gl.getParameter(gl.ACTIVE_TEXTURE),unit=gl.getUniform(program,sampler);
                        try{
                            gl.activeTexture(gl.TEXTURE0+unit);
                            const ext=gl.getExtension('EXT_texture_filter_anisotropic');
                            nativeTexture={unit,bound:!!gl.getParameter(gl.TEXTURE_BINDING_2D),
                                minFilter:gl.getTexParameter(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER),magFilter:gl.getTexParameter(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER),
                                wrapS:gl.getTexParameter(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S),wrapT:gl.getTexParameter(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T),
                                anisotropy:ext?gl.getTexParameter(gl.TEXTURE_2D,ext.TEXTURE_MAX_ANISOTROPY_EXT):null};
                        }finally{gl.activeTexture(oldActive);}
                    }
                    trace.gpu.push({ key, args, values, nativeTexture, ring: location === null ? null : gl.getUniform(program, location),
                        linked: !!program && gl.getProgramParameter(program, gl.LINK_STATUS),
                        log: program ? gl.getProgramInfoLog(program) : 'No current program', shaders });
                    return original.apply(this, args);
                };
            }
        }
        return draw();
    } finally {
        for (const [key, original] of originals) gl[key] = original;
        if (uniform) uniform.value = captured;
        trace.restored = uniform ? uniform.value : null;
        state.lensDraws.push(trace);
    }
}

function nativePrelude() {
    return `
G.t=0;G.paused=true;G.warp=1;resetEphem();clock.getDelta=()=>1/60;
const componentPixel = new Uint8Array(4);
window.__componentState = {phase:'startup',inspect:false,serial:0,ledger:[],lensDraws:[]};
window.__componentEnsureLensing=ensureLensingModule;
window.__componentPixelFrame=()=>{if(window.__componentState.phase!=='post-timing')throw new Error('Pixel frame before timing complete');lastMobileFrame=-Infinity;frameNo=11;frame();};
window.__componentDeliver=(phase)=>{
    const s=window.__componentState;s.phase=phase;s.lensDraws=[];
    clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;
    const before=frameNo,start=performance.now();frame();const cpuMs=performance.now()-start;
    const gl=renderer.getContext(),f=performance.now();gl.finish();const finishMs=performance.now()-f;
    const r=performance.now();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,componentPixel);
    const readbackMs=performance.now()-r;
    const entry={serial:++s.serial,phase,beforeFrameNo:before,frameNo,cpuMs,finishMs,readbackMs,
        frameAndFinishMs:performance.now()-start,lensDraws:s.lensDraws};
    s.ledger.push(entry);return entry;
};
window.__componentWorkload=()=>({frameNo,beltCursor,kuiperCursor,nearVisualReady,
    nearFieldCadence:cam.dist>LY_SCENE*.2?'cosmic':'every-frame',mobile:renderQuality.mobile,
    loadShed:renderQuality.loadShed,warp:G.warp,gr:G.gr,uiMode:G.uiMode,
    minor:Object.fromEntries(['belt','kuiper','curated','oort'].map(k=>[k,{capacity:minorRenderers[k].capacity,
        elementCount:minorSwarms[k].length/6,first:Array.from(minorSwarms[k].slice(0,12)),last:Array.from(minorSwarms[k].slice(-12))}]))});
`;
}
export function transformSource(source, path, variant, mainDisk) {
    assert(VARIANTS.some(v => v === variant), 'Only the six frozen variants are supported');
    if (path === 'src/render/catalogStars.js') return once(source, 'const start = () => loadTier0();',
        'const start = () => {}; // QA: matched unrelated background HYG omission.');
    if (path === 'src/render/bodySurfaceMaterial.js') return source + '\nexport const componentSurfaceQueue=()=>({pending:pending.size,inFlight:!!inFlight});\n';
    if (path === 'src/main.js') {
        // Every existing startup delivery remains present and is accounted.
        assert.equal((source.match(/\bframe\(\);/g) || []).length, 1, 'Native startup delivery inventory changed');
        source = once(source, 'const firstFrameT0 = perfStart();', nativePrelude() + '\nconst firstFrameT0 = perfStart();');
        source = once(source, '\nframe();\nperfEnd("startup.firstFrame", firstFrameT0);',
            '\nwindow.__componentDeliver("startup");\nperfEnd("startup.firstFrame", firstFrameT0);');
        return once(source, 'renderer.setAnimationLoop(frame);', '// QA: only explicitly accounted serial native deliveries.');
    }
    if (path === 'src/lensing.js') {
        if (variant.iterations === 1) source = once(source,
            'for (int iteration = 0; iteration < 3; iteration++) {',
            'for (int iteration = 0; iteration < 1; iteration++) {');
        const off = variant.ring === 'off-at-lens-draw';
        source = once(source, '    lensQuad.render(rendererArg);',
            `    componentLensBoundary(rendererArg, u, () => lensQuad.render(rendererArg), ${off}, 'direct');`);
        source = once(source, '        super.render(rendererArg, writeBuffer, readBuffer, deltaTime, maskActive);',
            `        componentLensBoundary(rendererArg, u, () => super.render(rendererArg, writeBuffer, readBuffer, deltaTime, maskActive), ${off}, 'composer');`);
        return source + '\nconst componentLensBoundary = ' + lensBoundary.toString() + ';\n';
    }
    if (path === 'src/holeOptics.js' && variant.disk === 'exact-main-support') {
        const before = supportBlock(source), after = supportBlock(mainDisk);
        assert(after.includes('float hit = -ro.z/rd.z;') && !after.includes('coverage'), 'Exact-main support required');
        return once(source, before, after);
    }
    return source;
}
export const HOOK_PATHS = Object.freeze(['src/main.js','src/lensing.js','src/holeOptics.js','src/render/catalogStars.js','src/render/bodySurfaceMaterial.js']);
// Vite serves production assets and imports scripts from its pinned config.
// Also protect implicit config/env/package inputs, including ignored files.
// Root node_modules and evidence are deliberately outside this path set;
// nested dependencies or evidence under src/public/scripts remain protected.
export const PROTECTED_INPUT_PATHS = Object.freeze([
    'src', 'public', 'scripts', 'index.html', 'package.json',
    ...['.env*','*.config.*','.*rc','.*rc.*','tsconfig*.json','jsconfig*.json',
        'bun.lock','bun.lockb','package-lock.json','npm-shrinkwrap.json','yarn.lock',
        'pnpm-lock.yaml','pnpm-workspace.yaml','.pnp.*','.config/**',
        'browserslist'].map(path => `:(top,glob)${path}`),
]);
export function assertNoExtraInputs(root, committedNames) {
    // Deliberately omit --exclude-standard: ignored .env.local and generated
    // served inputs affect execution just as ordinary untracked files do.
    // Include the index too: staging an extra file cannot make it immutable.
    const found = execFileSync('git',['ls-files','-z','--cached','--others','--',...PROTECTED_INPUT_PATHS],
        {cwd:root,encoding:'utf8',maxBuffer:32*1024*1024}).split('\0').filter(Boolean);
    const committed = new Set(committedNames);
    const extras = [...new Set(found)].filter(path => !committed.has(path)).sort();
    assert.deepEqual(extras,[],`Unpinned served/build/config inputs: ${extras.join(', ')}`);
    return {paths:PROTECTED_INPUT_PATHS,extraInputs:extras,includesIgnored:true,includesStaged:true};
}
export async function inspectRoot(root, revision) {
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
    assert.equal(await realpath(root), await realpath(git(['rev-parse','--show-toplevel'])), 'Exact worktree root required');
    assert.equal(git(['rev-parse','HEAD']), revision, 'Source worktree must stay at the immutable declared revision');
    const tree = git(['rev-parse', `${revision}^{tree}`]);
    if (revision === HEAD) assert.equal(tree, TREE);
    const entries = execFileSync('git',['ls-tree','-rz',revision],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean).map(line=>{const [meta,path]=line.split('\t');return {path,blob:meta.split(' ')[2]};});
    const names = entries.map(e=>e.path);
    const protectedInputs = assertNoExtraInputs(root,names);
    const hashes = {}, sources = {};
    for (const {path,blob} of entries) {
        const actual = await readFile(resolve(root,path));
        const actualBlob = createHash('sha1').update(`blob ${actual.length}\0`).update(actual).digest('hex');
        assert.equal(actualBlob,blob, `Modified immutable source/build input: ${path}`);
        hashes[path] = sha(actual);
        if (HOOK_PATHS.includes(path)) sources[path] = actual.toString();
    }
    const ring = 'src/render/ringSamplingDepth.js';
    const absent = revision === BASE;
    assert.equal(names.includes(ring), !absent, 'Native missing-ring provenance changed');
    if (absent) {
        try { await readFile(resolve(root,ring)); assert.fail('An untracked synthetic baseline ring is forbidden'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return { revision, tree, hashes, protectedInputs, sourceFingerprint:sha(JSON.stringify(hashes)), sources,
        absenceProof: absent ? { path:ring,commit:revision,tree } : null };
}
export function validateTrace(trace, variant, gpu = false) {
    assert.equal(trace.path,'direct','This experiment is mobile/direct only');
    const expected = variant.label === 'A' ? null : variant.ring === 'off-at-lens-draw' ? 0 : 1;
    assert.equal(trace.captured,variant.label === 'A' ? null : 1,'Real ring capture must precede the control');
    assert.equal(trace.requested,expected); assert.equal(trace.restored,trace.captured,'Ring restoration is mandatory');
    if (gpu) {
        assert.equal(trace.gpu.length,1,'Exactly one actual GL lens draw must be witnessed');
        assert.equal(trace.gpu[0].ring,expected,'Actual uploaded GL uniform must match');
        assert.equal(trace.gpu[0].linked,true); assert.equal(trace.gpu[0].shaders.length,2);
        for (const shader of trace.gpu[0].shaders) assert(shader.compiled && shader.source.length > 100,'Native shader compilation required');
    } else assert.equal(trace.gpu.length,0,'Extra GL introspection is forbidden while timing');
}
export function validateLedger(ledger, variant, complete = true) {
    let serial = 0, previous;
    for (const entry of ledger) {
        assert(['startup','warmup','settlement','settled','measure-1','measure-2'].includes(entry.phase),'Unexpected delivery phase in timing ledger');
        assert.equal(entry.serial,++serial,'No omitted or duplicate deliveries');
        if (previous !== undefined) assert.equal(entry.beforeFrameNo,previous,'No unaccounted native frame');
        assert.equal(entry.frameNo,entry.beforeFrameNo+1,'No hidden/throttled/context-loss no-op');
        previous=entry.frameNo;
        for (const k of ['cpuMs','finishMs','readbackMs','frameAndFinishMs']) assert(Number.isFinite(entry[k])&&entry[k]>=0,`Missing ${k}`);
        if (entry.phase==='startup') {
            assert.equal(entry.roundTripMs,null,'Startup is native; no per-frame protocol roundtrip exists');
            assert.equal(entry.roundTripScope,'navigation-envelope');
        } else assert(Number.isFinite(entry.roundTripMs)&&entry.roundTripMs>=entry.frameAndFinishMs,'Per-delivery protocol timing required');
        if (['warmup','settled','measure-1','measure-2'].includes(entry.phase)) {
            assert.equal(entry.lensDraws.length,1,'Native lens pass must really execute');
            validateTrace(entry.lensDraws[0],variant);
        }
    }
    if (complete) {
        const count=phase=>ledger.filter(e=>e.phase===phase).length;
        assert(count('startup')>=1); assert.equal(count('warmup'),WARMUP); assert.equal(count('settled'),SETTLED);
        assert.equal(count('measure-1'),SAMPLES); assert.equal(count('measure-2'),SAMPLES);
        const phases=ledger.map(e=>e.phase);
        const first=phases.indexOf('measure-1'), second=phases.indexOf('measure-2');
        assert(phases.slice(first).every(p=>p==='measure-1'||p==='measure-2'),'No new preparation or inspection after measurement starts');
        assert(first>phases.lastIndexOf('settled')&&second>phases.lastIndexOf('measure-1'));
        assert(!phases.slice(first,second).some(p=>p==='warmup'||p==='settled'||p==='startup'),'No rewarm/reload between orders');
    }
}
export function summarize(values) {
    assert(values.length>0); const sorted=[...values].sort((a,b)=>a-b);
    return { count:values.length,min:sorted[0],p50:sorted[Math.ceil(values.length*.5)-1],p95:sorted[Math.ceil(values.length*.95)-1],
        max:sorted.at(-1),mean:values.reduce((a,b)=>a+b,0)/values.length };
}
export function attribute(blocks) {
    assert.deepEqual(blocks.map(b=>b.label).join(''),ORDERS.join(''),'Both opposite global orders are mandatory');
    const metrics=['cpuMs','finishMs','readbackMs','frameAndFinishMs','roundTripMs'];
    const byOrder=ORDERS.map((order,index)=>({order,index:index+1,variants:Object.fromEntries([...order].map(label=>{
        const b=blocks[index*6+order.indexOf(label)];assert.equal(b.samples.length,SAMPLES);
        return [label,Object.fromEntries(metrics.map(k=>[k,summarize(b.samples.map(s=>s[k]))]))];
    }))}));
    const drift=Object.fromEntries(metrics.map(k=>[k,Math.max(...VARIANTS.map(v=>Math.abs(byOrder[0].variants[v.label][k].mean-byOrder[1].variants[v.label][k].mean)))]));
    const driftP95=Object.fromEntries(metrics.map(k=>[k,Math.max(...VARIANTS.map(v=>Math.abs(byOrder[0].variants[v.label][k].p95-byOrder[1].variants[v.label][k].p95)))]));
    for (const order of byOrder) {
        const v=order.variants, delta=(a,b)=>Object.fromEntries(metrics.map(k=>[k,v[a][k].mean-v[b][k].mean]));
        order.estimates={annulusAt3:delta('B','C'),iterationsWithoutRing:delta('C','D'),iterationsWithRing:delta('B','E'),diskSupport:delta('B','F'),anchorOnly:delta('B','A')};
        const p95Delta=(a,b)=>Object.fromEntries(metrics.map(k=>[k,v[a][k].p95-v[b][k].p95]));
        order.p95Estimates={annulusAt3:p95Delta('B','C'),iterationsWithoutRing:p95Delta('C','D'),iterationsWithRing:p95Delta('B','E'),diskSupport:p95Delta('B','F'),anchorOnly:p95Delta('B','A')};
        order.p95Interaction=Object.fromEntries(metrics.map(k=>[k,order.p95Estimates.iterationsWithRing[k]-order.p95Estimates.iterationsWithoutRing[k]]));
        order.interaction=Object.fromEntries(metrics.map(k=>[k,order.estimates.iterationsWithRing[k]-order.estimates.iterationsWithoutRing[k]]));
    }
    const names=['annulusAt3','iterationsWithoutRing','iterationsWithRing','diskSupport'];
    const ranking=order=>[...names].sort((a,b)=>order.estimates[b].frameAndFinishMs-order.estimates[a].frameAndFinishMs);
    const meanRankingsAgree=JSON.stringify(ranking(byOrder[0]))===JSON.stringify(ranking(byOrder[1]));
    const p95Ranking=order=>[...names].sort((a,b)=>order.p95Estimates[b].frameAndFinishMs-order.p95Estimates[a].frameAndFinishMs);
    const p95RankingsAgree=JSON.stringify(p95Ranking(byOrder[0]))===JSON.stringify(p95Ranking(byOrder[1]));
    const rankingsAgree=meanRankingsAgree&&p95RankingsAgree;
    const conclusions=Object.fromEntries(names.map(name=>{
        const values=byOrder.map(o=>o.estimates[name].frameAndFinishMs);
        const sameSign=values.every(x=>x>0)||values.every(x=>x<0);
        const exceedsDrift=values.every(x=>Math.abs(x)>drift.frameAndFinishMs);
        const p95Values=byOrder.map(o=>o.p95Estimates[name].frameAndFinishMs);
        const p95SameSign=p95Values.every(x=>x>0)||p95Values.every(x=>x<0);
        const p95ExceedsDrift=p95Values.every(x=>Math.abs(x)>driftP95.frameAndFinishMs);
        const summariesAgree=values.every((x,i)=>Math.sign(x)===Math.sign(p95Values[i]));
        return [name,{values,p95Values,observedDriftSpanMs:drift.frameAndFinishMs,observedP95DriftSpanMs:driftP95.frameAndFinishMs,
            status:sameSign&&exceedsDrift&&p95SameSign&&p95ExceedsDrift&&summariesAgree&&rankingsAgree?'direction-resolved-diagnostic':'inconclusive'}];
    }));
    return {byOrder,drift,driftP95,meanRankingsAgree,p95RankingsAgree,rankingsAgree,conclusions,acceptance:null,
        caution:'Ten-frame diagnostic blocks only. No acceptance verdict or five-percent pass claim. Ring-off retains CPU capture; components are non-additive. Conflicting rankings or drift-sized deltas are inconclusive.'};
}

export const KEY_IMAGES = Object.freeze([
    ['saturn-near-lens',.48,'production'],['saturn-near-lens',.48,'no-ring-depth-no-tides'],
    ['saturn-near-lens',.48,'no-tides'],['disk-crossing',0,'production'],
    ['saturn-near-lens',-.48,'production'],['saturn-foreground-lens',0,'production'],
    ['disk-crossing',-.0006,'production'],['disk-crossing',.0006,'production'],
].map(Object.freeze));
export function pixelCases(label) {
    const coarse=[.48,.08,.005,0,-.005,-.08,-.48];
    if(label==='B') return ['saturn-near-lens','saturn-foreground-lens','disk-crossing'].flatMap(scenario=>
        (scenario==='disk-crossing'?[...new Set([...coarse,...DENSE])]:scenario==='saturn-foreground-lens'?[.48,0,-.48]:coarse).map(pitch=>({scenario,pitch})));
    const unique=new Map(KEY_IMAGES.map(([scenario,pitch])=>[`${scenario}/${pitch}`,{scenario,pitch}]));
    if(label==='F')for(const pitch of DENSE)unique.set(`disk-crossing/${pitch}`,{scenario:'disk-crossing',pitch});
    return [...unique.values()];
}
export function extractPixelProbe(source) {
    const start='const result=await page.evaluate(',end='},{scenario,pitch});';
    assert.equal(source.split(start).length,2);assert.equal(source.split(end).length,2);
    let result=source.slice(source.indexOf(start)+start.length,source.indexOf(end)+1);
    // Only permit A's native absence, and preserve pixels for the two specified
    // independent ring contrasts. The existing fixture's draw/state logic stays
    // exact, including its explicitly labelled capture-suppression ablation.
    result=once(result,'qa.ring.beginRingSamplingDepth();','qa.ring?.beginRingSamplingDepth();');
    result=once(result,'qa.ring.ringSamplingUniforms.uRingPresent.value','qa.ring ? qa.ring.ringSamplingUniforms.uRingPresent.value : null');
    result=once(result,'return{images:',`return{contrastBytes:scenario==='saturn-near-lens'&&pitch===.48?{production:Array.from(production.bytes),'no-tides':Array.from(noTides.bytes)}:null,images:`);
    return result;
}
export function checkPixelCase(result,label,scenario) {
    assert.equal(result.glError,0,'Live error-free pixel context');
    assert(result.state.meshSourceError<1e-6,'Drawn hole and physical lens positions match');
    assert(result.state.lensDepthError<.01,'Lens depth matches drawn hole');
    assert.equal(result.state.diskOn,1,'Quasar disk remains enabled');
    if (scenario.startsWith('saturn-')) {
        const expected=label==='A'?null:1;
        assert.equal(result.state.ringProxyNoTides,expected,'Native proxy restored after independent lens override');
        assert.equal(result.state.ringProxyAblated,label==='A'?null:0,'Untimed capture-suppression ablation keeps its original label');
        assert.equal(result.state.edgeRadiusNoTides,null);assert.equal(result.metrics.edgeDepthChanged,0);
    }
    if(scenario==='saturn-foreground-lens') {
        assert(result.state.physicalLensDepth>result.state.bodyDepth+500);
        assert(result.metrics.opaquePixels>50);
        // All ablated results are retained, but only unmodified B is subject to
        // the original correctness gate. This is never a relaxed PR52 gate.
        if(label==='B')assert.equal(result.metrics.opaqueChanged,0,'Original same-target foreground gate');
    }
}
export function crossingResult(cases) {
    const disk=cases.filter(c=>c.scenario==='disk-crossing');
    const crossing=disk.filter(c=>DENSE.includes(c.pitch)).sort((a,b)=>b.pitch-a.pitch);
    assert.equal(crossing.length,DENSE.length,'Every dense crossing sample must be present');
    const outer=crossing.filter(c=>Math.abs(c.pitch)===.0008).map(c=>c.metrics.diskLight);
    const bounded=crossing.every(c=>c.metrics.diskLight<=Math.max(...outer)*1.25&&c.metrics.diskLight>=Math.min(...outer)*.75);
    const continuous=crossing.every((c,i)=>!i||Math.abs(c.metrics.diskLight-crossing[i-1].metrics.diskLight)<=Math.max(...outer)*.2);
    const exact=disk.find(c=>c.pitch===0),near=disk.filter(c=>Math.abs(c.pitch)===.005);
    const noDropout=near.length?exact.metrics.diskPixels>near.reduce((s,c)=>s+c.metrics.diskPixels,0)/near.length*.5:null;
    return {outer,bounded,continuous,noDropout,passed:bounded&&continuous&&noDropout!==false,normalizedBounds:[.75,1.25],adjacentMaximum:.20};
}

function backgroundWork(background) {
    // Exclude only elapsed costs, historical counters and generation IDs.
    // Keep settings derived from timing when they change actual work/quality
    // (for example volume draft/refine budgets and history readiness).
    const {buildMs,...galaxy}=background.galaxy;
    const {mapsMs,renders,invalidations,...volume}=background.volume;
    const {ms:tidesMs,linearPass,linearFrame,...tides}=background.tides;
    const withoutRenders=value=>{if(value===null)return null;const {renders,...rest}=value;return rest;};
    const {ms:fieldMs,gen,builds,cached,...field}=background.field;
    return {galaxy,volume,tides:{...tides,linearPass:withoutRenders(linearPass),linearFrame:withoutRenders(linearFrame)},
        field,surfaceQueue:background.surfaceQueue};
}
function gpuCounts(resources) {
    const {programs,...counts}=resources;
    assert(Array.isArray(programs),'Native program inventory required');
    for(const key of ['geometries','textures'])assert(Number.isSafeInteger(counts[key])&&counts[key]>=0,`Native GPU ${key} count required`);
    return {...counts,programs:programs.length};
}
export function assertMatchedState(a,b) {
    for(const key of ['focus','t','paused','seed','epoch','workload','camera','ship','maps','quality','optics'])assert.deepEqual(a[key],b[key],`Matched ${key} across all variants`);
    assert.deepEqual(a.ring,b.ring,'Native ring texture, filters, anisotropy, affine matrix and material must match');
    for(const state of [a,b])for(const key of ['objects','geometries','materials'])
        assert(Number.isSafeInteger(state.sceneObjects[key])&&state.sceneObjects[key]>=0,`Native scene ${key} count required`);
    assert.deepEqual(a.sceneObjects,b.sceneObjects,'Matched CPU scene object/geometry/material counts');
    assert.deepEqual(gpuCounts(a.resources),gpuCounts(b.resources),'Matched GPU resource/program counts; page-local IDs are excluded');
    assert.deepEqual(backgroundWork(a.background),backgroundWork(b.background),'Matched relevant background work, quality and readiness');
}
export function assertStableState(before,after) {
    for(const key of ['identity','focus','t','paused','seed','epoch','camera','ship','maps','quality','optics','ring','resources','sceneObjects'])
        assert.deepEqual(after[key],before[key],`No ${key} change, recompile or context replacement through either order`);
    assert.equal(after.identity.generation,0);assert.equal(after.identity.contextLost,false);
    assert.deepEqual(after.background.surfaceQueue,{pending:0,inFlight:false});
    const workload=x=>{const {frameNo,beltCursor,kuiperCursor,...rest}=x;return rest;};
    assert.deepEqual(workload(after.workload),workload(before.workload),'Steady native workload/cadence/quality must remain identical');
}
