import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sourceSampleInkGain as gain, SPARSE_SOURCE_SAMPLES, OWNED_SAMPLE_FRACTION } from '../src/riverRadianceMath.js';

for(const count of [0,1,32,64,127,128])assert.equal(gain(count,1),1,'sparse samples keep their full ink');
for(const [count,reference]of [[100,200],[500,500],[1000,2000]])assert.equal(gain(count,reference),1,'sampling reductions are never dimmed');
for(const value of [NaN,Infinity,-Infinity]){assert.equal(gain(value,10),1);assert.equal(gain(1000,value),1);}
for(const reference of [0,1,76.41153028181971,512,7000]){
    let last=1;
    for(let count=1;count<=20000;count+=7){
        const value=gain(count,reference);
        assert(Number.isFinite(value)&&value>0&&value<=1&&value<=last);
        assert(count*value<=Math.max(reference,SPARSE_SOURCE_SAMPLES)+1e-9,'dense aggregate ink stays bounded');
        last=value;
    }
    const boundary=Math.max(reference,SPARSE_SOURCE_SAMPLES);
    assert(Math.abs(gain(boundary-1e-6,reference)-gain(boundary+1e-6,reference))<1e-7,'gain is continuous at the sparse boundary');
}
const proxima=15376*OWNED_SAMPLE_FRACTION;
assert(Math.abs(gain(proxima,76.41153028181971)-128/proxima)<1e-15);

const source=readFileSync(new URL('../src/river.js',import.meta.url),'utf8');
const baseline=execFileSync('git',['show','09863eedda25eef36d79e9cf88daa4ff3e377875:src/river.js'],{encoding:'utf8'});
function literal(text,name){const m=text.match(new RegExp('const '+name+' = /\\* glsl \\*/`([\\s\\S]*?)`;'));assert(m,name);return m[1];}
function fn(text,name){const start=text.indexOf(name);assert(start>=0);let i=text.indexOf('{',start),depth=1,end=i+1;for(;depth;end++){if(text[end]==='{')depth++;if(text[end]==='}')depth--;}return text.slice(start,end);}
assert.equal(literal(source,'COMPUTE_FRAG'),literal(baseline,'COMPUTE_FRAG'),'advection, spawn, owner assignment and recycling are byte-identical');
assert.equal(fn(literal(source,'FLOW_GLSL'),'vec3 flowField'),fn(literal(baseline,'FLOW_GLSL'),'vec3 flowField'),'physical field function is byte-identical');
assert(source.includes('hash13(vec3(vUv * 601.1, 3.3)) < 0.68'),'the original owned population fraction is unchanged');
const vertex=literal(source,'LINE_VERT');
assert.equal((vertex.match(/vColor \*= uHalo\[own\]\.w/g)||[]).length,1);
assert(vertex.indexOf('vColor *= uHalo[own].w')>vertex.indexOf('vColor = currents'),'all line/dot styles receive one final gain');
assert(vertex.includes('if (own >= 0 && own < uSinkNB) vColor *= uHalo[own].w'),'ambient samples stay unchanged');
const computeBranch=fn(source,'if (shouldCompute)');
assert(computeBranch.indexOf('renderedOwnerShares[i] =')>computeBranch.indexOf('const sw = rtA'),'owner shares commit only after the GPU texture swap');
assert.equal((source.match(/renderedOwnerShares\[i\] =/g)||[]).length,1,'skipped compute frames cannot replace ownership shares');
console.log('Owner-radiance bounds, sparse identity, style scope, field/advection and cadence invariants passed');
