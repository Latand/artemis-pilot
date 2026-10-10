import { WARP, stopWarp } from './warpBubble.js';
import { G, WORLD, BH } from './state.js';
import { eph } from './ephemeris.js';
import { advanceBodiesOnly } from './physics.js';
import { ACTIVE_STARS, getCachedPhysicalSystem } from './universe/activeStars.js';
import { PL, R_EARTH, R_MOON, R_SUN } from './constants.js';
import { sunStateAt } from './universe/sunEvolution.js';
import { planetWorldState, moonWorldState } from './universe/planetarySystem.js';
import { NS_SURFACE_KM } from './tde.js';
const _body={x:0,y:0,z:0,vx:0,vy:0,vz:0};
import { segmentSphereHit } from './geometry.js';
// Explicit navigation approximation: prescribed motion in the Earth-relative
// coordinate chart. It does not solve interactions of exotic matter with bodies.
// Abort a swept segment intersecting loaded physical surfaces (linearly extrapolated over the delivered interval). This is a
// conservative navigation interlock, not physical warp-impact modelling.
export function warpSegmentBlocked(x,y,z,nx,ny,nz,dt=0) {
    const hits=(cx,cy,cz,r,vx=0,vy=0,vz=0)=>segmentSphereHit(x-cx+vx*dt,y-cy+vy*dt,z-cz+vz*dt,nx-cx,ny-cy,nz-cz,r*1.02);
    if (!WORLD.earthDestroyed && hits(0,0,0,R_EARTH)) return true;
    if (!WORLD.moonDestroyed && hits(eph.moonX,eph.moonY,eph.moonZ||0,R_MOON,eph.moonVx,eph.moonVy,eph.moonVz)) return true;
    if (!WORLD.sunDestroyed && hits(eph.sunX,eph.sunY,eph.sunZ||0,R_SUN*sunStateAt(G.t).R_Rsun,eph.sunVx,eph.sunVy,eph.sunVz)) return true;
    for(let i=0;i<PL.length;i++) if(!WORLD.plDestroyed[i]&&hits(eph.plX[i],eph.plY[i],eph.plZ[i]||0,PL[i].R,eph.plVx[i],eph.plVy[i],eph.plVz[i])) return true;
    for(let i=0;i<BH.n;i++) if(hits(BH.x[i],BH.y[i],BH.z[i]||0,BH.kind[i]===2?NS_SURFACE_KM:BH.rs[i]*3,BH.vx[i],BH.vy[i],BH.vz[i])) return true;
    for(const star of ACTIVE_STARS) if(!star.gasSink && hits(star.x-eph.earthX,star.y-eph.earthY,star.z||0,star.R,(star.vx||0)-eph.earthVx,(star.vy||0)-eph.earthVy,star.vz||0)) return true;
    const sys=getCachedPhysicalSystem();
    if(sys?.hostStar) for(const p of sys.planets||[]) {
        if(planetWorldState(sys,p.index,sys.hostStar,G.t,_body) && hits(_body.x-eph.earthX,_body.y-eph.earthY,_body.z,p.radiusKm,_body.vx-eph.earthVx,_body.vy-eph.earthVy,_body.vz)) return true;
        for(let j=0;j<(p.moons?.length||0);j++) if(moonWorldState(sys,p.index,j,sys.hostStar,G.t,_body) && hits(_body.x-eph.earthX,_body.y-eph.earthY,_body.z,p.moons[j].R,_body.vx-eph.earthVx,_body.vy-eph.earthVy,_body.vz)) return true;
    }
    return false;
}
export function warpTravelStep(requested) {
    if (!(requested>0)) { stopWarp(WARP,'Reverse time stops bubble travel'); return 0; }
    const dt=advanceBodiesOnly(Math.min(requested,1)); // limit linearized surface sweep to one simulation second
    if (!(dt>0)) return 0;
    const distance=WARP.meanSpeed*dt;
    const nx=G.x+G.vx*dt+WARP.dx*distance, ny=G.y+G.vy*dt+WARP.dy*distance, nz=G.z+G.vz*dt+WARP.dz*distance;
    if (!Number.isFinite(nx+ny+nz) || Math.hypot(nx,ny,nz)>5e23) {
        stopWarp(WARP,'Coordinate guard reached');
    } else if (warpSegmentBlocked(G.x,G.y,G.z,nx,ny,nz,dt)) {
        stopWarp(WARP,'Navigation interlock: loaded body in path');
    } else { G.x=nx; G.y=ny; G.z=nz; G.leftHome ||= Math.hypot(nx,ny,nz)>1e5; }
    // Central proper time equals coordinate time only in the ideal metric.
    // Bubble speed never enters local velocity or Lorentz calculations.
    G.tau+=dt;
    return dt;
}
