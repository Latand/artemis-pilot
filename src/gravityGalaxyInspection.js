// A view estimate, never fed back into world dynamics. Galaxies replace their
// unresolved stellar members here; local stars are not added to their mass.
import { K, MU_S, PC_KM } from './constants.js';
import { G } from './state.js';
import { camera, cam } from './scene.js';
import { galaxyFlowSources, galaxyPopulationStatus } from './render/galaxyPopulationRender.js';
import { galacticCenterScene } from './universe/starfield.js';

let sampledAt=-Infinity,cached=[],lastScale=0,lastEpoch=NaN,lastHalo=null;
const origin={x:0,y:0,z:0};
export function getGalaxyGravityInspection() {
    const gc=galacticCenterScene();origin.x=gc[0];origin.y=gc[1];origin.z=gc[2];
    // Keep the Local Group within the illustrative source horizon even while
    // inspecting the Milky Way itself. This does not change camera or physics.
    const scale=Math.max(500000*PC_KM*K,cam.dist),now=performance.now();
    if(!galaxyPopulationStatus().ready)return {supported:false,name:'Milky Way neighborhood',note:'Galaxy sources are loading; no force is inferred yet.',estimated:true};
    // Local Group positions remain live; the distant catalog is bounded and
    // throttled. Sampling depends on the context, never visibility or facing.
    if(now-sampledAt>750||Math.abs(Math.log(scale/Math.max(1,lastScale)))>.15||Math.abs(G.t-lastEpoch)>1e5*31557600||lastHalo!==G.darkMatter){
        cached=galaxyFlowSources(camera,scale,18,G.darkMatter,false,origin);
        sampledAt=now;lastScale=scale;lastEpoch=G.t;lastHalo=G.darkMatter;
    }
    const wells=[...galaxyFlowSources(camera,scale,18,G.darkMatter,true,origin).map(w=>({...w,partition:'local'})),
        ...cached.map(w=>({...w,partition:'distant'}))];
    const contributions=[];
    for(let i=0;i<wells.length;i++){
        const w=wells[i],dx=(w.x-origin.x)/K,dy=-(w.z-origin.z)/K,dz=(w.y-origin.y)/K;
        const core=(w.core||0)/K,r2=dx*dx+dy*dy+dz*dz+core*core;
        if(!(r2>0&&w.mass>0))continue;
        const k=MU_S*w.mass/(r2*Math.sqrt(r2));
        const members=w.members||1;
        contributions.push({id:`galaxy:${w.partition}:${w.groupKey}`,label:w.label==='Andromeda'?`Andromeda${members>1?' group':''}`:`Catalog group · ${members} ${members===1?'galaxy':'galaxies'}`,
            acceleration:[dx*k,dy*k,dz*k],position:[w.x/K,-w.z/K,w.y/K],kind:'galaxy'});
    }
    const net=[0,0,0];for(const c of contributions)for(let i=0;i<3;i++)net[i]+=c.acceleration[i];
    return {supported:contributions.length>0,name:'Milky Way neighborhood',position:[gc[0]/K,-gc[2]/K,gc[1]/K],
        contributions,net,estimated:true,frame:'Milky Way context estimate',predictionSupported:false,
        note:'View context changes to the Milky Way center; your pinned selection stays unchanged. Estimated direction from a bounded sample of apparent galaxy positions and approximate masses, not a complete matter census. Andromeda uses the merger-model halo mass when dark matter is on; other catalog masses are stellar-light estimates. Galaxies replace their member stars and the Milky Way excludes self-pull. This field is not applied to the local simulation; no galaxy-wide N-body forecast.'};
}
