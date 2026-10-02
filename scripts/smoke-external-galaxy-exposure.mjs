// Exercise the actual production meter functions with an isolated catalog;
// no renderer/DOM or alternate exposure implementation is used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { galaxyScreenBounds, galaxyVisibleColumnWeight, galaxyInteriorMeterBoost } from '../src/render/galaxyResolved.js';
const source=readFileSync(new URL('../src/render/galaxyPopulationRender.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('function galaxyPeak('),source.indexOf('// --- Per frame'));
const exposure={gain:1,n:12000,sample:null,seen:null,serial:0,auto:1,brightFrac:.002,target:.9,resolvedPx:30,resolvedSpan:30,resolvedHeadroom:1.2};
const makeState=local=>{
    const delta=Float32Array.from([.75,.1,-.15]);
    const shape=Float32Array.of(0,0,1,.12);
    const c={shape,center:[0,0,0],count:1,gid:Int32Array.of(0),unit:new Float32Array(3),delta,phot:Float32Array.of(-21.2,.85,6.1,.28),t:Float32Array.of(204)};
    const mesh={userData:{lg:local,source:c,maxScaleKpc:6.1,maxDeltaMpc:Math.hypot(...delta)},geometry:{attributes:{aShape:{array:shape},aDelta:{array:delta},aPhot:{array:c.phot},aT:{array:c.t}}}};
    return {catalog:{count:1,pos:delta,MV:Float32Array.of(-21.2),hKpc:Float32Array.of(6.1),unit:Int32Array.of(local?0:1),localGroupUnit:0},
        chunks:[mesh],lg:local?{mesh,rides:Uint8Array.of(1)}:null,shared:{uAObs:{value:1}},lcData:new Float32Array(512)};
};
const view=(direction)=>new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().lookAt(new THREE.Vector3(),new THREE.Vector3(...direction),new THREE.Vector3(0,1,0))).transpose();
for(const local of [true,false]){
    const state=makeState(local),exp={...exposure},n=12512;
    const meter=Function('state','EXPOSURE','galaxyScreenBounds','galaxyVisibleColumnWeight','galaxyInteriorMeterBoost','galaxyVolumeMeter','LC_N','CHI_MAX_MPC','_mPeak','_mFoot','_mFootOwn','_mW','_mIdx',
        `${functions}\nreturn meterExposure;`)(state,exp,galaxyScreenBounds,galaxyVisibleColumnWeight,galaxyInteriorMeterBoost,()=>({live:false,opacity:0}),512,2500,
        new Float64Array(n),new Float64Array(n),new Float64Array(n),new Float64Array(n),new Uint32Array(n));
    const center=[...state.catalog.pos];
    const eye=center.map((x,i)=>x+(i===2?.0000001:0)); // 0.326 light-years
    const front=meter(eye,view([0,0,-1]),575,.67,.45,768*512);
    const away=meter(eye,view([0,0,1]),575,.67,.45,768*512);
    const exact=meter(center,view([1,0,0]),575,.67,.45,768*512);
    const exposureFloor=Number(source.match(/const EXPOSURE =[^\n]*min: ([\d.e-]+)/)[1]);
    assert(exposureFloor<front,'The display floor must permit the requested core exposure');
    assert(Number.isFinite(front)&&front>0);assert(Math.abs(away/front-1)<1e-9);assert(Math.abs(exact/front-1)<1e-9);
    const middle=center.map((x,i)=>x+(i===2?.00305:0));
    const middleFront=meter(middle,view([0,0,-1]),575,.67,.45,768*512);
    const middleAway=meter(middle,view([0,0,1]),575,.67,.45,768*512);
    assert(Number.isFinite(middleFront)&&Number.isFinite(middleAway)&&middleFront>0&&middleAway>0);
    console.log(`PASS ${local?'Local Group':'non-Local-Group'} surrounding light meters identically toward/away/at exact center`);
    // The independent review's two-source control: a hidden thin disk must
    // leave the visible background at exactly its disk-disabled exposure.
    state.catalog={...state.catalog,count:2,pos:Float32Array.from([...center,center[0],center[1],center[2]+10]),
        MV:Float32Array.of(-21.2,-19),hKpc:Float32Array.of(6.1,3),unit:Int32Array.of(local?0:1,2)};
    exp.sample=null;
    for(const height of [2,3.2,7.9,8]){
        const observer=center.map((x,i)=>x+(i===2?height*.0061:0));
        const actual=meter(observer,view([0,0,1]),575,.67,.45,768*512);
        const oldLG=state.lg,oldChunks=state.chunks;state.lg=null;state.chunks=[];
        const control=meter(observer,view([0,0,1]),575,.67,.45,768*512);
        state.lg=oldLG;state.chunks=oldChunks;
        assert.equal(actual,control,'A hidden galaxy must not dim the visible background');
    }
    const transition=height=>meter(center.map((x,i)=>x+(i===2?height*.0061:0)),view([0,0,1]),575,.67,.45,768*512);
    const before=transition(.5996),after=transition(.5997);
    assert(Math.abs(after/before-1)<.005,'A sub-parsec coverage change must not switch the field percentile');
    let previous=transition(.1),maxStep=1;
    for(let step=101;step<=1300;step++){
        const current=transition(step*.001);maxStep=Math.max(maxStep,current/previous,previous/current);previous=current;
    }
    assert(maxStep<1.25,`Visible-column fade must be continuous across coverage thresholds: ${maxStep}`);
    console.log(`PASS ${local?'Local Group':'non-Local-Group'} hidden disk and continuous metering fade (${maxStep.toFixed(4)} maximum adjacent ratio)`);

}

assert(galaxyInteriorMeterBoost(0,.12,.28)>15);
assert.equal(galaxyInteriorMeterBoost(1,.12,.28),1);
assert.equal(galaxyInteriorMeterBoost(4,.12,.28),1);
assert(Math.abs(galaxyInteriorMeterBoost(.999999,.12,.28)-1)<1e-8);
console.log('PASS finite smooth core exposure headroom without changing exterior metering');

assert.equal(galaxyVisibleColumnWeight([0,0,2],[0,0,1],1,.12,.28,[1.4,2.2,0,0]),0);
assert.equal(galaxyVisibleColumnWeight([0,0,3.2],[0,0,1],1,.12,.28,[1.4,2.2,0,0]),0);
assert(galaxyVisibleColumnWeight([0,0,1.8],[0,1,0],1,.12,.28,[1.4,2.2,0,0])>.9);
console.log('PASS hidden thin disks cannot meter the field; genuinely surrounding material stays active');
