// Presentation policy only. Never selects or changes the simulator's forces.
import { LY_KM } from './constants.js';
export const GALAXY_INSPECT_ENTER_KM=20000*LY_KM;
export const GALAXY_INSPECT_LEAVE_KM=14000*LY_KM;
export function isPlacedHoleFocus(focus) { return typeof focus==='string' && /^bh:\d+$/.test(focus); }
export function gravityContext(distanceKm,previous='local',focus=null) {
    // Zoom may change the ambient illustration, never which forces explain
    // the selected placed hole. Its live solver remains local at every scale.
    if(isPlacedHoleFocus(focus))return 'local';
    if(previous==='galaxy')return distanceKm<GALAXY_INSPECT_LEAVE_KM?'local':'galaxy';
    return distanceKm>GALAXY_INSPECT_ENTER_KM?'galaxy':'local';
}
export function holeContributionVectors(snapshot,focus) {
    if(!snapshot?.supported||!isPlacedHoleFocus(focus))return [];
    // All other placed holes (at most five), not a nearest/visible subset.
    // The solver owns self exclusion, causal mass history and the pair law.
    return snapshot.contributions.filter(row=>row.kind==='black-hole'&&row.id!==focus&&
        row.acceleration?.length===3&&row.acceleration.every(Number.isFinite)&&Math.hypot(...row.acceleration)>0);
}
export function sumAcceleration(rows,out=[0,0,0]) {
    out.fill(0);for(const row of rows)for(let i=0;i<3;i++)out[i]+=row.acceleration[i];return out;
}
export function strongestContributions(rows,previous=[],limit=3) {
    const finite=rows.filter(r=>r.acceleration?.length===3&&r.acceleration.every(Number.isFinite));
    const candidates=finite.filter(r=>r.kind!=='frame'&&r.kind!=='correction').map(row=>({...row,magnitude:Math.hypot(...row.acceleration)})).filter(r=>r.magnitude>0);
    candidates.sort((a,b)=>b.magnitude-a.magnitude||String(a.id).localeCompare(String(b.id)));
    const byId=new Map(candidates.map(r=>[r.id,r]));
    let kept=previous.map(id=>byId.get(id)).filter(Boolean).slice(0,limit);
    for(const row of candidates){
        if(kept.some(k=>k.id===row.id))continue;
        if(kept.length<limit){kept.push(row);continue;}
        let weakest=0;for(let i=1;i<kept.length;i++)if(kept[i].magnitude<kept[weakest].magnitude)weakest=i;
        if(row.magnitude>kept[weakest].magnitude*1.15)kept[weakest]=row;
    }
    // Adjacent ranks only swap when they have separated materially. Near-ties
    // retain their visual slot instead of flickering while the clock advances.
    for(let pass=0;pass<kept.length;pass++)for(let i=0;i<kept.length-1;i++)
        if(kept[i+1].magnitude>kept[i].magnitude*1.15)[kept[i],kept[i+1]]=[kept[i+1],kept[i]];
    const ids=new Set(kept.map(r=>r.id)),rest=finite.filter(r=>!ids.has(r.id));
    return {top:kept,others:sumAcceleration(rest),othersCount:rest.length,ids:kept.map(r=>r.id),net:sumAcceleration(finite)};
}
export function accelerationLabel(kmS2) {
    const ms2=kmS2*1000;
    if(!Number.isFinite(ms2))return 'Unavailable';
    if(ms2===0)return '0 m/s²';
    return (ms2>=.001&&ms2<1000?ms2.toPrecision(3):ms2.toExponential(2))+' m/s²';
}
