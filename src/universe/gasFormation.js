// Numerical gas histories: SPH states, bounded delivery, and checkpoint replay.
// No radius/mass/stage is prescribed as a function of elapsed time.
import { SEC_YEAR, WARPS } from "../constants.js";
import { createGasSph, stepGasSph, gasSphNextDt, snapshotGasSph, restoreGasSph, gasSphDiagnostics } from "./gasSph.js";

export const GAS_RADIUS_KM = .045 * 9.4607e12;
export const GAS_MASSES = [.3, 1, 3];
export const GAS_TEMPERATURES = [10, 30, 200];
export const GAS_MODEL_VERSION = 2;
export const GAS_STEPS_PER_FRAME = 4;
const CHECKPOINT_LIMIT = 32, CHECKPOINT_STRIDE = 12, HISTORY_LIMIT = 24;
const runtimes = new WeakMap(), diagnostics = new WeakMap();

export function normalizeFormation(value) {
    if (!value || ![1, GAS_MODEL_VERSION].includes(value.v) || !Number.isFinite(value.bornAtSec) || !GAS_MASSES.includes(value.massSolar)) return null;
    const f = { v:GAS_MODEL_VERSION, bornAtSec:value.bornAtSec, massSolar:value.massSolar,
        temperatureK:GAS_TEMPERATURES.includes(value.temperatureK) ? value.temperatureK : 10,
        radialVelocity:value.radialVelocity === 3 ? 3 : 0, particleCount:96 };
    // The previous draft's timed sources migrate to initial numerical sources;
    // its inferred star or collapse progress is deliberately never imported.
    if (value.v === GAS_MODEL_VERSION && value.checkpoint) f.checkpoint = value.checkpoint;
    return f;
}
function initialState(record) {
    return createGasSph({massSolar:record.formation.massSolar,radiusKm:record.radiusKm,
        temperatureK:record.formation.temperatureK,radialVelocity:record.formation.radialVelocity,
        particleCount:96,seed:record.seed});
}
function compatible(s, record) {
    const c=s.config,f=record.formation;
    return c.massSolar===f.massSolar && c.radiusKm===record.radiusKm && c.temperatureK===f.temperatureK &&
        c.radialVelocity===f.radialVelocity && c.seed===record.seed && s.count===96;
}
function runtime(record) {
    let r=runtimes.get(record);if(r)return r;
    const state=initialState(record), initial=snapshotGasSph(state);
    r={state,initial,history:[initial],held:[],terminal:null,checkpoints:[initial],replaying:false,limited:false,knownBirth:null,lastSteps:0};
    const saved=record.formation.checkpoint;
    if(saved){
        try {
            const current=restoreGasSph(saved.current), previous=restoreGasSph(saved.previous);
            if(!compatible(current,record)||!compatible(previous,record)||previous.ageSec>current.ageSec)throw Error('Gas checkpoint source mismatch');
            r.state=current;r.history=[snapshotGasSph(previous),snapshotGasSph(current)];
            r.checkpoints.push(r.history[0],r.history[1]);r.knownBirth=current.sink.formedAtSec;
        } catch { /* Invalid checkpoints never replace a valid seeded source. */ }
    }
    runtimes.set(record,r);return r;
}
function summary(s) {
    let d=diagnostics.get(s);if(!d){d=gasSphDiagnostics(s);diagnostics.set(s,d);}return d;
}
function cacheSnapshot(r,s) {
    r.history.push(s);
    if(r.history.length>HISTORY_LIMIT)r.history.shift();
    if(s.steps % CHECKPOINT_STRIDE===0){
        r.checkpoints.push(s);
        // Retain the release checkpoint and a bounded rolling history.
        if(r.checkpoints.length>CHECKPOINT_LIMIT)r.checkpoints.splice(1,1);
    }
    if(s.sink.formedAtSec!==null)r.knownBirth=s.sink.formedAtSec;
}
function pairAt(r,age) {
    let a=null,b=null;
    for(const s of [...r.history,...r.held]){
        if(s.ageSec<=age && (!a||s.ageSec>a.ageSec))a=s;
        if(s.ageSec>=age && (!b||s.ageSec<b.ageSec))b=s;
    }
    if(!a)return null;
    if(!b && age>a.ageSec)return null;
    b ||= a;
    // A held old-world sample cannot bridge a missing replay interval.
    // Only consecutive canonical steps or an exactly force-free sink coast
    // define a valid interpolation bracket.
    const exact=a.ageSec===b.ageSec;
    const adjacent=b.steps===a.steps+1;
    const coast=b.steps===a.steps&&a.active.every(v=>v===0)&&b.active.every(v=>v===0);
    return exact||adjacent||coast?{a,b}:null;
}
function relativeAge(r,record,simT){
    const born=record.formation.bornAtSec;
    // Exact representable absolute sample boundaries must select that sample,
    // even when subtracting a deep-time release epoch loses low bits.
    for(const s of [...r.history,...r.held])if(born+s.ageSec===simT)return s.ageSec;
    return Math.max(0,simT-born);
}
/** Prepare canonical numerical samples around target; never truncate a solver
 * step to a render-frame target. A failed budget reports the reached horizon. */
export function prepareGas(record, simT, maxSteps=GAS_STEPS_PER_FRAME, fromSimT=simT) {
    const r=runtime(record), age=relativeAge(r,record,simT);
    r.lastSteps=0;r.limited=false;
    const fromAge=relativeAge(r,record,fromSimT),oldPair=pairAt(r,fromAge);
    if(oldPair)r.held=[oldPair.a,oldPair.b];
    if(age===0){r.replaying=false;return{ready:true,coveredSec:simT,steps:0};}
    if(pairAt(r,age)){r.replaying=false;return{ready:true,coveredSec:simT,steps:0};}
    if(age<r.state.ageSec){
        let cp=r.initial;
        for(const s of r.checkpoints)if(s.ageSec<=age&&s.ageSec>=cp.ageSec)cp=s;
        r.state=restoreGasSph(cp);r.history=[cp];r.replaying=true;
    }
    const ahead=r.state.ageSec-fromAge;
    const stepSec=gasSphNextDt(r.state)*r.state.unitTimeSec;
    // A fast cloud must not run arbitrarily far ahead of slower clouds while
    // the shared universe clock is limited by their work budget.
    const allow=ahead>stepSec*1.01&&simT>fromSimT?0:maxSteps;
    const budget=Math.max(0,Math.min(GAS_STEPS_PER_FRAME,Math.floor(allow)));
    if(!r.terminal && summary(r.history[r.history.length-1]).activeCount===0)r.terminal=r.history[r.history.length-1];
    if(r.terminal&&fromAge>=r.terminal.ageSec&&age>=r.terminal.ageSec){
        const a=r.terminal;r.state=restoreGasSph(a);
        const dt=(age-a.ageSec)/a.unitTimeSec;
        for(let k=0;k<3;k++)r.state.sink.position[k]=a.sink.position[k]+a.sink.velocity[k]*dt;
        r.state.time=age/a.unitTimeSec;r.state.ageSec=age;
        r.history=[a,snapshotGasSph(r.state)];r.replaying=false;
        return{ready:true,coveredSec:simT,steps:0};
    }
    while(r.state.ageSec<age&&r.lastSteps<budget){
        if(!stepGasSph(r.state))break;
        r.lastSteps++;cacheSnapshot(r,snapshotGasSph(r.state));
    }
    const ready=!!pairAt(r,age);
    r.limited=!ready;r.replaying=r.replaying&&!ready;
    return{ready,coveredSec:record.formation.bornAtSec+r.state.ageSec,steps:r.lastSteps,status:r.state.status};
}
export function gasNumericalView(record,simT) {
    const r=runtime(record),age=relativeAge(r,record,simT);
    const pair=age===0?{a:r.initial,b:r.initial}:pairAt(r,age);
    let fallback=r.initial;
    for(const s of [...r.history,...r.held,...r.checkpoints])if(s.ageSec<=age&&s.ageSec>=fallback.ageSec)fallback=s;
    const a=pair?.a||fallback,b=pair?.b||a;
    const blend=b.ageSec>a.ageSec?Math.max(0,Math.min(1,(age-a.ageSec)/(b.ageSec-a.ageSec))):0;
    return{a,b,blend,ready:simT<record.formation.bornAtSec||!!pair,replaying:r.replaying,limited:r.limited,ageSec:age};
}
export function gasStateAt(record,simT,out={}) {
    if(!record?.formation)return null;
    const view=gasNumericalView(record,simT),s=view.a,d=summary(s),init=summary(runtime(record).initial);
    const present=Number.isFinite(simT)&&simT>=record.formation.bornAtSec;
    const born=present&&d.sinkMass>0;
    const contracting=d.rmsRadius<init.rmsRadius*.9;
    const phase=!present?'Before release':!view.ready?(view.replaying?'Replaying checkpoints':'Computing gas state'):s.status==='resolution-limit'?'Resolution limit':
        born?'Protostellar core':d.rmsRadius>init.rmsRadius*1.15?'Dispersing gas':contracting?'Collapsing gas':'Gas cloud';
    return Object.assign(out,{present,born,phase,ready:view.ready,replaying:view.replaying,limited:view.limited,
        progress:present?d.sinkMass:0,ageSec:view.ageSec,computedAgeSec:s.ageSec,
        radiusKm:Math.max(s.sinkRadius,d.maxRadius)*record.radiusKm,
        sinkRadiusKm:s.sinkRadius*record.radiusKm,softeningKm:s.softening*record.radiusKm,
        sinkPosition:s.sink.position,sinkVelocity:s.sink.velocity,unitVelocityKmS:s.unitVelocityKmS,
        totalMassSolar:record.formation.massSolar,gasMassSolar:present?d.gasMassSolar:0,
        coreMassSolar:present?d.sinkMassSolar:0,temperatureK:d.temperatureK,
        densityContrast:d.densityContrast,peakDensityKgM3:d.peakDensityKgM3,virialRatio:d.virialRatio,
        sinkBornAtSec:s.sink.formedAtSec===null?null:record.formation.bornAtSec+s.sink.formedAtSec,
        steps:s.steps,activeCount:d.activeCount,particleCount:s.count,diagnostics:d});
}
export function gasCharacteristicTime(record) { return runtime(record).initial.unitTimeSec*Math.PI/Math.sqrt(8); }
// Compatibility name is a characteristic free-fall estimate ONLY, never a
// scheduled birth, phase threshold, shrinkage function or mass-transfer law.
export const formationDuration=gasCharacteristicTime;
export function gasWatchWarp(_span,feasible=Infinity){return WARPS.includes(1000*SEC_YEAR)&&feasible>=1000*SEC_YEAR?1000*SEC_YEAR:0;}
export function serializeGasFormation(record,simT) {
    const f=record.formation,view=gasNumericalView(record,simT);
    return{v:GAS_MODEL_VERSION,bornAtSec:f.bornAtSec,massSolar:f.massSolar,temperatureK:f.temperatureK,
        radialVelocity:f.radialVelocity,particleCount:96,checkpoint:{previous:view.a,current:view.b}};
}
export function gasKnownBirth(record) { return runtime(record).knownBirth; }
export function gasRuntimeStats(record){const r=runtime(record);return{history:r.history.length,checkpoints:r.checkpoints.length,steps:r.lastSteps,replaying:r.replaying,limited:r.limited};}
