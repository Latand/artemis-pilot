import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/lens-invariants-capture.json',import.meta.url),'utf8'));
const source=readFileSync(new URL('../src/lensing.js',import.meta.url),'utf8');
const once=(text,from,to)=>{assert.equal(text.split(from).length,2,`Unique shader anchor: ${from}`);return text.replace(from,to);};
// Bind the numerical comparison to the whole production diff, including all
// texture calls, derivatives, guards and loop counts. Reversing just the cache
// must recover the immutable shader source that supplied the reference model.
const start=source.indexOf('            // The original pixel and lens geometry stay fixed');
const end=source.indexOf('            for (int iteration = 0; iteration < 3;',start);
assert(start>0&&end>start);
assert.equal(createHash('sha256').update(source.slice(start,end)).digest('hex'),
    '039d14edd3b540bd7f12684468a282e8208533d39c2d845dfe80b5f6f91da70b',
    'The cache itself has no extra sampling or unreviewed arithmetic');
let restored=source.slice(0,start)+source.slice(end);
assert.equal((restored.match(/if \(!lensEligible\[i\]\) continue;/g)||[]).length,2);
restored=restored.replaceAll('if (!lensEligible[i]) continue;','if (zv < uDist[i]) continue;');
restored=once(restored,'vec2 d = lensGeometry[i].xy;\n                    float r2 = lensGeometry[i].z;',
    'vec2 d = p - uC[i];\n                    float r2 = max(dot(d, d), 1e-9);');
restored=once(restored,'nextQ -= d * (uT2[i] * finiteSource / r2);',
    'nextQ -= d * (uT2[i] * finiteSource / r2);\n                    zBent = min(zBent, uDist[i]);');
restored=once(restored,'vec2 d = lensGeometry[i].xy;','vec2 d = p-uC[i];');
restored=once(restored,'verifiedQ -= d*(uT2[i]*finiteSource/lensGeometry[i].z);',
    'verifiedQ -= d*(uT2[i]*finiteSource/max(dot(d,d),1e-9));');
assert.equal(createHash('sha256').update(restored).digest('hex'),fixture.sourceLensingSha256,
    'Only the reviewed invariant cache may differ from exact48a9da40');
export const referenceLensSource=restored;
assert(source.includes('lensEligible[i] = !(zv < uDist[i]);'));
assert(source.includes('vec3(d, max(dot(d, d), 1e-9))'));
assert(source.includes('if (lensEligible[i]) zBent = min(zBent, uDist[i]);'));

// Explicit float32 operations preserve the shader's multiplication/division
// order. This is a CPU arithmetic oracle, not a GPU/FMA or derivative proof.
const f=Math.fround,add=(a,b)=>f(f(a)+f(b)),sub=(a,b)=>f(f(a)-f(b));
const mul=(a,b)=>f(f(a)*f(b)),div=(a,b)=>f(f(a)/f(b));
const max=(a,b)=>Math.max(f(a),f(b)),min=(a,b)=>Math.min(f(a),f(b));
const clamp=(a,lo,hi)=>min(max(a,lo),hi);
const finite=(distance,z)=>clamp(sub(1,div(distance,max(z,1e-9))),0,1);
const smooth=(a,b,x)=>{const t=clamp(div(sub(x,a),sub(b,a)),0,1);return mul(mul(t,t),sub(3,mul(2,t)));};
const geometry=(p,l,floor=1e-9)=>{
    const d=[sub(p[0],l.center[0]),sub(p[1],l.center[1])];
    return {d,r2:max(add(mul(d[0],d[0]),mul(d[1],d[1])),floor)};
};
const captured=fixture.nativeUniforms;
const capture={aspect:captured.uAspect,near:captured.uNear,far:captured.uFar,hasDepth:captured.uHasDepth,
    lenses:[{center:captured['uC[0]'],distance:captured['uDist[0]'],strength:captured['uT2[0]']}]};

// Both implementations obtain identical sampled depth/ring values through the
// recorded UVs. Discontinuous fields expose any changed intermediate lookup,
// eligibility or final residual; comparing only final colour could hide it.
function solve(input,sampler,cached,{iterations=3,radialFloor=1e-9,dynamicEligibility=false}={}){
    const {uv,aspect,near,far,hasDepth,lenses}=input;
    const p=[mul(sub(mul(uv[0],2),1),aspect),sub(mul(uv[1],2),1)];
    const trace=[];
    function sample(at,index){
        const {depth,ringDepth}=sampler(at,index);
        const dq=hasDepth?f(depth):f(1);
        let z=hasDepth&&dq<1?div(mul(near,far),sub(far,mul(dq,sub(far,near)))):f(1e30);
        z=min(z,ringDepth);
        trace.push({uv:at.slice(),depth:dq,ringDepth:f(ringDepth),sourceZ:z});
        return {dq,z};
    }
    const first=sample(uv.map(f),0),zv=first.z,dz=first.dq;
    let sourceZ=zv,dq=dz,zBent=f(1e30),q=p.slice();
    const terms=cached?lenses.map(l=>({...geometry(p,l,radialFloor),eligible:!(zv<f(l.distance))})):null;
    if(cached)for(let i=0;i<lenses.length;i++)if(terms[i].eligible)zBent=min(zBent,lenses[i].distance);
    for(let iteration=0;iteration<iterations;iteration++){
        const nextQ=p.slice();
        for(let i=0;i<lenses.length;i++){
            const l=lenses[i];
            if(dynamicEligibility?sourceZ<f(l.distance):cached?!terms[i].eligible:zv<f(l.distance))continue;
            const {d,r2}=cached?terms[i]:geometry(p,l,radialFloor);
            const scale=div(mul(l.strength,finite(l.distance,sourceZ)),r2);
            nextQ[0]=sub(nextQ[0],mul(d[0],scale));nextQ[1]=sub(nextQ[1],mul(d[1],scale));
            if(!cached)zBent=min(zBent,l.distance);
        }
        q=nextQ;
        if(hasDepth){
            const at=[clamp(add(mul(div(q[0],aspect),.5),.5),0,1),clamp(add(mul(q[1],.5),.5),0,1)];
            const sampled=sample(at,iteration+1);dq=sampled.dq;sourceZ=sampled.z;
        }
    }
    const verified=p.slice();
    for(let i=0;i<lenses.length;i++){
        const l=lenses[i];if(cached?!terms[i].eligible:zv<f(l.distance))continue;
        const {d,r2}=cached?terms[i]:geometry(p,l,radialFloor);
        const scale=div(mul(l.strength,finite(l.distance,sourceZ)),r2);
        verified[0]=sub(verified[0],mul(d[0],scale));verified[1]=sub(verified[1],mul(d[1],scale));
    }
    const delta=[sub(q[0],verified[0]),sub(q[1],verified[1])];
    const residual=f(Math.sqrt(add(mul(delta[0],delta[0]),mul(delta[1],delta[1]))));
    const rawUv=[add(mul(div(q[0],aspect),.5),.5),add(mul(q[1],.5),.5)];
    const border=min(min(rawUv[0],rawUv[1]),min(sub(1,rawUv[0]),sub(1,rawUv[1])));
    let supported=mul(smooth(0,.035,border),sub(1,smooth(.002,.01,residual)));
    if(hasDepth&&zBent<f(1e29)&&sourceZ<zBent)supported=f(0);
    return {q,verified,trace,zBent,sourceZ,dq,dz,residual,supported,outputDepth:supported>.5?dq:dz};
}

const fields=[
    ()=>({depth:1,ringDepth:1e30}),
    (uv)=>({depth:uv[0]<.5?.998:1,ringDepth:1e30}),
    (uv)=>({depth:uv[1]<.5?0:.999999,ringDepth:1e30}),
    (uv)=>({depth:.99997,ringDepth:Math.hypot(uv[0]-.5,uv[1]-.5)<.2?520:1e30}),
    (uv)=>({depth:1,ringDepth:Math.floor(uv[0]*128)%3===0?1e30:510}),
    (uv,index)=>({depth:[.99996,.99997,.99998,.9999999][index%4],ringDepth:uv[1]<.48?512:1e30}),
    (_uv,index)=>({depth:1,ringDepth:[1000,1100,1200,511.301][index%4]}),
];
let count=0,seed=0x25c0ffee;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
function check(input,sampler){
    const original=solve(input,sampler,false),candidate=solve(input,sampler,true);
    assert.deepEqual(candidate,original,`Full float32 trace parity case${count}`);
    for(const value of [candidate.residual,candidate.sourceZ,candidate.outputDepth,...candidate.q])assert(Number.isFinite(value));
    assert.equal(candidate.trace.length,input.hasDepth?4:1,'Three depth/ring lookups remain delivered');count++;
}
// Actual captured native uniforms, on-screen grid, exact lens center and both
// sides of the clamped near-singular radius. These are not actual captured
// depth textures: every field above is explicit synthetic data.
for(let y=0;y<=48;y++)for(let x=0;x<=32;x++)for(const sampler of fields)
    check({...capture,uv:[x/32,y/48]},sampler);
const c=capture.lenses[0].center;
for(const epsilon of [0,-1e-9,1e-9,-1e-7,1e-7,-1e-5,1e-5,-.000031622,.000031622])
    for(const sampler of fields)check({...capture,uv:[(c[0]+epsilon)/capture.aspect*.5+.5,(c[1]-epsilon)*.5+.5]},sampler);
// Zero through four lenses, nearly cancelling pairs, near/far depth ranges,
// both viewport edges, absent depth, and sources on either side of each lens.
for(let trial=0;trial<12000;trial++){
    const n=trial%5,aspect=[.2,capture.aspect,1,1.5,4][trial%5];
    const uv=[trial%17===0?0:trial%19===0?1:random(),trial%13===0?1:random()];
    const p=[(uv[0]*2-1)*aspect,uv[1]*2-1];
    const lenses=Array.from({length:n},(_,i)=>({center:trial%7===0?[p[0]+(i%2?1:-1)*1e-6,p[1]]:[(random()*2-1)*4,random()*2-1],
        distance:trial%11===0?511.3+i*1e-5:10**(random()*10-3),strength:.3025*random()}));
    check({uv,aspect,near:[.02,1e-5,100][trial%3],far:[1e4,189214608,1e12][trial%3],hasDepth:trial%9?1:0,lenses},fields[trial%fields.length]);
}
// Negative controls ensure that the comparisons can detect plausible unsafe
// alternatives rather than merely comparing two always-equivalent fixtures.
const nearInput={...capture,uv:[(c[0]+1e-6)/capture.aspect*.5+.5,c[1]*.5+.5]};
assert.notDeepEqual(solve(nearInput,fields[0],false),solve(nearInput,fields[0],true,{radialFloor:1e-6}));
const edgeInput={...capture,uv:[.6,.5]};
assert.notDeepEqual(solve(edgeInput,fields[6],false),solve(edgeInput,fields[6],true,{iterations:1}));
const crossing=(_uv,index)=>({depth:1,ringDepth:index===0?100:1000});
assert.notDeepEqual(solve(edgeInput,crossing,false),solve(edgeInput,crossing,true,{dynamicEligibility:true}));
console.log(JSON.stringify({test:'Lens invariant-cache float32 parity',cases:count,negativeControls:3,exactTraceParity:true,
    capturedRun:fixture.run,capturedUniforms:true,capturedDepthTextures:false,scope:'CPU float32 oracle and exact-source delta binding; GPU compilation/pixels/performance remain separate'}));
