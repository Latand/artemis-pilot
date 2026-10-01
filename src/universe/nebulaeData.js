import { gasWorldState, invalidateGasDynamics } from "./gasDynamics.js";
import { K, MU_S, LY_KM } from "../constants.js";
import { normalizeFormation, gasStateAt, formationDuration, prepareGas, serializeGasFormation, gasKnownBirth, GAS_STEPS_PER_FRAME } from "./gasFormation.js";

export const NEBULA_RADIUS_PRESETS_LY = [1, 4, 10];
export const NEBULA_RADIUS_PRESETS_KM = NEBULA_RADIUS_PRESETS_LY.map(ly => ly * 9.4607e12);
export const NEBULA_ARCHETYPES = ["EMISSION", "REFLECTION", "PLANETARY"];
export const NEB_MAX = 4;
export const NEBULAE = [];
let revision=0;
export function nebulaRevision(){return revision;}

export function nebulaArchetypeName(index) {
    return NEBULA_ARCHETYPES[Math.max(0, Math.min(NEBULA_ARCHETYPES.length - 1, index | 0))];
}

export function nebulaArchetypeIndex(nameOrIndex) {
    if (Number.isFinite(Number(nameOrIndex))) {
        return Math.max(0, Math.min(NEBULA_ARCHETYPES.length - 1, Number(nameOrIndex) | 0));
    }
    const idx = NEBULA_ARCHETYPES.indexOf(String(nameOrIndex || "").toUpperCase());
    return idx >= 0 ? idx : 0;
}

export function nebulaRadiusKmFromPreset(index) {
    return NEBULA_RADIUS_PRESETS_KM[Math.max(0, Math.min(NEBULA_RADIUS_PRESETS_KM.length - 1, index | 0))];
}

export function nebulaRadiusLy(radiusKm) {
    return radiusKm / 9.4607e12;
}

export function addNebulaRecord(record) {
    if (!record || typeof record !== "object") return -1;
    if (NEBULAE.length >= NEB_MAX) return -1;
    if (![record.xKm, record.yKm, record.zKm, record.radiusKm].every(Number.isFinite) || !(record.radiusKm > 0)) return -1;
    const archetype = nebulaArchetypeIndex(record.archetype);
    const row = {
        xKm: Number(record.xKm) || 0,
        yKm: Number(record.yKm) || 0,
        zKm: Number(record.zKm) || 0,
        radiusKm: Number(record.radiusKm) || NEBULA_RADIUS_PRESETS_KM[1],
        archetype,
        seed: Number(record.seed) >>> 0,
        ...(normalizeFormation(record.formation) ? { formation: normalizeFormation(record.formation) } : {}),
    };
    if (row.formation && (!(formationDuration(row) > 0) || !Number.isFinite(formationDuration(row)))) return -1;
    if (row.formation && NEBULAE.some(n => n.formation && formationId(n) === formationId(row))) return -1;
    NEBULAE.push(row);revision++;
    return NEBULAE.length - 1;
}

export function removeNebulaRecord(i) {
    if (i < 0 || i >= NEBULAE.length) return false;
    NEBULAE.splice(i, 1);revision++;
    return true;
}

export function clearNebulaRecords() {
    NEBULAE.length = 0;revision++;
}

export function serializeNebulae(simT = 0) {
    return NEBULAE.map(n => [n.xKm, n.yKm, n.zKm, n.radiusKm, nebulaArchetypeIndex(n.archetype), n.seed >>> 0, ...(n.formation ? [serializeGasFormation(n,simT)] : [])]);
}

export function restoreNebulaRecords(rows = []) {
    clearNebulaRecords();
    for (const row of Array.isArray(rows) ? rows : []) {
        if (NEBULAE.length >= NEB_MAX) break;
        if (!Array.isArray(row) || row.length < 6) continue;
        addNebulaRecord({
            xKm: row[0], yKm: row[1], zKm: row[2],
            radiusKm: row[3], archetype: row[4], seed: row[5], formation: row[6],
        });
    }
    return NEBULAE.length;
}

// Stars are views of their source records, never appended to the catalogue.
// Stable identities survive save/load; bounded by the same NEB_MAX slots.
const formedCache = new WeakMap();
function formationId(n) { return "formed:" + [n.seed, n.formation.v, n.formation.bornAtSec, n.formation.massSolar, n.formation.temperatureK, n.formation.radialVelocity, n.radiusKm, n.xKm, n.yKm, n.zKm].join(":"); }
export function formedStarForNebula(i, simT, includeBoundary = true) {
    const n=NEBULAE[i];if(!n?.formation)return null;
    const s=gasStateAt(n,simT);if(!s.born||!s.ready||(!includeBoundary&&simT<=s.sinkBornAtSec))return null;
    let star=formedCache.get(n);
    if(!star){star={id:formationId(n),name:"PROTOSTAR "+(i+1),formedStar:true,gasSink:true,nebulaIndex:i,
        catalog:"numerical-sph-sink",estimated:true,kind:"protostar",color:0xffcc88};formedCache.set(n,star);}
    const origin=gasWorldState(n,simT);
    const x=origin.x+s.sinkPosition[0]*n.radiusKm,y=origin.y+s.sinkPosition[1]*n.radiusKm,z=origin.z+s.sinkPosition[2]*n.radiusKm;
    const track=s.stellar, mass=track.massSolar;
    Object.assign(star,{nebulaIndex:i,x,y,z,vx:origin.vx+s.sinkVelocity[0]*s.unitVelocityKmS,vy:origin.vy+s.sinkVelocity[1]*s.unitVelocityKmS,vz:origin.vz+s.sinkVelocity[2]*s.unitVelocityKmS,dLy:Math.hypot(x,y,z)/LY_KM,mass,mu:MU_S*mass,
        name:track.phase.toUpperCase()+" "+(i+1),kind:track.kind,gasSink:!s.assembled,
        R:track.radiusKm,softeningKm:s.assembled?0:s.softeningKm,
        sinkRadiusKm:s.sinkRadiusKm,lumSolar:track.luminositySolar,tempK:track.temperatureK,
        color:track.color,cls:track.cls,phase:track.phase,stellarAgeSec:track.ageSec,
        bh:track.kind==='BH',rs:track.kind==='BH'?track.radiusKm:0,
        pulsar:track.kind==='NS',ejectedMassSolar:track.ejectedMassSolar,
        flowC:.001*Math.sqrt(2*MU_S*mass/1000),flowSink:track.radiusKm*K});
    return star;
}
export function formedStarsAt(simT, includeBoundary = true) {
    const stars = [];
    for (let i = 0; i < NEBULAE.length; i++) {
        const star = formedStarForNebula(i, simT, includeBoundary);
        if (star) stars.push(star);
    }
    return stars;
}
export function nextFormationBoundary(t, requested) {
    let next = t + requested, split = false;
    for (const n of NEBULAE) {
        if (!n.formation) continue;
        const age=gasKnownBirth(n);
        if(age===null)continue;
        const birth = n.formation.bornAtSec + age;
        // Reverse at the boundary samples just before birth before integrating.
        if (requested > 0 && birth > t && birth < next) { next = birth; split = true; }
        if (requested < 0 && birth < t && birth > next) { next = birth; split = true; }
    }
    // Preserve sub-ULP requested deltas for the compensated simulation clock.
    return split ? next - t : requested;
}
export function clearFormingNebulaRecords() {
    for (let i = NEBULAE.length - 1; i >= 0; i--) if (NEBULAE[i].formation) { NEBULAE.splice(i, 1); revision++; }
}

// Four total numerical steps per rendered frame, divided fairly across clouds.
// Rewind is checkpoint replay; a replay in flight holds the shared clock.
export function prepareGasAdvance(t,requested) {
    const clouds=NEBULAE.filter(n=>n.formation);
    if(!clouds.length)return{advance:requested,limited:false,reason:"",steps:0};
    const target=t+requested;let budget=GAS_STEPS_PER_FRAME,advance=requested,steps=0,limited=false,replay=false;
    for(let i=0;i<clouds.length;i++){
        const share=Math.floor(budget/(clouds.length-i));
        const r=prepareGas(clouds[i],target,share,t);budget-=r.steps;steps+=r.steps;
        if(!r.ready){
            limited=true;
            if(requested<0){advance=0;replay=true;}
            else advance=Math.min(advance,Math.max(0,r.coveredSec-t));
        }
    }
    invalidateGasDynamics();
    return{advance,limited,steps,reason:replay?"replaying gas checkpoints":limited?"gas gravity and pressure step budget":""};
}
export function preparePausedGas(t) {return prepareGasAdvance(t,0);}
