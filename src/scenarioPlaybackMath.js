// Curated playback changes the requested clock rate, never the trajectory.
// Pure helpers: no DOM, shared state, render objects or authored ship positions.
export const JUPITER_PLAYBACK_SECONDS = 60;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = a => { const n=Math.hypot(...a); return a.map(x=>x/n); };

export function jupiterEncounterSeed(eph, planet, index = 3) {
    const mu = planet.mu, periapsisKm = planet.R * 3.5, vinfKmS = 5.6;
    const tangent = unit([eph.plVx[index]-eph.sunVx, eph.plVy[index]-eph.sunVy, eph.plVz[index]-(eph.sunVz||0)]);
    const heliocentric = [eph.plX[index]-eph.sunX, eph.plY[index]-eph.sunY, eph.plZ[index]-(eph.sunZ||0)];
    const normal = unit(cross(heliocentric, tangent));
    const sideways = cross(normal, tangent);
    const ahead = 2e6, offset = 1.35e6, radius = Math.hypot(ahead,offset);
    const radial = tangent.map((t,i)=>(ahead*t+offset*sideways[i])/radius);
    const transverse = cross(normal,radial);
    const h = periapsisKm * Math.sqrt(vinfKmS**2 + 2*mu/periapsisKm);
    const vt = h/radius, vr = -Math.sqrt(vinfKmS**2+2*mu/radius-vt*vt);
    const position = [eph.plX[index],eph.plY[index],eph.plZ[index]].map((p,i)=>p+radius*radial[i]);
    const velocity = [eph.plVx[index],eph.plVy[index],eph.plVz[index]].map((v,i)=>v+vr*radial[i]+vt*transverse[i]);
    const a = mu/(vinfKmS**2), eccentricity = 1+periapsisKm/a;
    const H = Math.acosh((radius/a+1)/eccentricity);
    const periapsisTimeSec = Math.sqrt(a**3/mu)*(eccentricity*Math.sinh(H)-H);
    return { position, velocity, normal, tangent, radius, periapsisKm, vinfKmS, eccentricity, angularMomentum:h, periapsisTimeSec, durationSimSec:2*periapsisTimeSec };
}

// Monotone cubic mapping wall-playhead -> simulation time. Harmonic slopes
// prevent overshoot; a continuous derivative makes the Time / second ramps
// smooth while reserving twenty seconds for the central close encounter.
export function createPlaybackPlan(periapsisTimeSec) {
    const wall = [0, 14, 22, 30, 38, 46, 60];
    const sim = [0, .72, .93, 1, 1.07, 1.28, 2].map(x=>x*periapsisTimeSec);
    const d = wall.slice(1).map((x,i)=>(sim[i+1]-sim[i])/(x-wall[i]));
    const slope = [d[0]];
    for(let i=1;i<wall.length-1;i++) {
        const h0=wall[i]-wall[i-1], h1=wall[i+1]-wall[i];
        const w0=2*h1+h0,w1=h1+2*h0;
        slope.push((w0+w1)/(w0/d[i-1]+w1/d[i]));
    }
    slope.push(d.at(-1));
    return { wall, sim, slope, duration:wall.at(-1), simDuration:sim.at(-1) };
}
export function simulationAtPlayhead(plan, seconds) {
    const t=clamp(seconds,0,plan.duration);
    let i=0; while(i<plan.wall.length-2 && t>plan.wall[i+1]) i++;
    const h=plan.wall[i+1]-plan.wall[i], u=(t-plan.wall[i])/h;
    return (2*u**3-3*u*u+1)*plan.sim[i]+(u**3-2*u*u+u)*h*plan.slope[i]+(-2*u**3+3*u*u)*plan.sim[i+1]+(u**3-u*u)*h*plan.slope[i+1];
}
export function playheadAtSimulation(plan, seconds) {
    if(seconds<=0) return 0;
    if(seconds>=plan.simDuration) return plan.duration;
    let lo=0,hi=plan.duration;
    for(let i=0;i<42;i++){const m=(lo+hi)/2;if(simulationAtPlayhead(plan,m)<seconds)lo=m;else hi=m;}
    return (lo+hi)/2;
}
export function playbackStep(plan, deliveredSimSec, wallDeltaSec) {
    const playhead=playheadAtSimulation(plan,deliveredSimSec);
    // A stalled/background frame cannot consume an entire encounter.
    const dt=clamp(Number(wallDeltaSec)||0,0,.12);
    const advanceSec=Math.max(0,simulationAtPlayhead(plan,Math.min(plan.duration,playhead+dt))-deliveredSimSec);
    return { advanceSec, warp:dt>0?advanceSec/dt:0, playhead, done:deliveredSimSec>=plan.simDuration-1e-6 };
}
export function playbackPhase(playhead) {
    return playhead < 14 ? 'Approach' : playhead < 24 ? 'Falling toward Jupiter' : playhead < 36 ? 'Gravity turns the flight' : playhead < 46 ? 'Leaving the encounter' : 'Outbound coast';
}
export function encounterCameraDistance(separationScene, radiusScene, aspect=1) {
    const halfFov=Math.atan(Math.tan(24*Math.PI/180)*Math.min(1,Math.max(.2,aspect)));
    return Math.max(radiusScene*5,(separationScene*.62+radiusScene*1.2)/Math.sin(halfFov));
}
