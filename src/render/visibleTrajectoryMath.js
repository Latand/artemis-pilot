// Bounded display policy, independent of the simulation and renderer.
export const VISIBLE_TRAJECTORY_LIMIT = 10;
export const VISIBLE_TRAJECTORY_SEGMENTS = 32;

// A sharp instantaneous guide must not strobe on a temporally averaged body.
// Selected bodies keep exact positions, but their velocity direction can also
// turn too far within one shutter. Fade that guide over 10–60 degrees/interval.
// This only controls opacity; it never invents a slower direction or clock.
export function trajectoryDisplayOpacity(bodyBlend = 0, seconds = 0, period = Infinity, directionSweep = 0) {
    const phase = Math.max(directionSweep / (2 * Math.PI), Number.isFinite(period) && period > 0 ? Math.abs(seconds) / period : 0);
    const x = Math.max(0, Math.min(1, (phase - 1 / 36) / (1 / 6 - 1 / 36)));
    return (1 - Math.max(0, Math.min(1, bodyBlend))) * (1 - x * x * (3 - 2 * x));
}

// Mean anomaly alone misses rapid periapsis turning on eccentric trajectories.
// The planar velocity heading is monotonic in eccentric anomaly, so unwrapped
// endpoint headings recover the whole turn without dense temporal substeps.
// Inspect both sides for a conservative, reverse-symmetric presentation bound.
export function orbitalDirectionSweep(orbit, seconds) {
    if (!orbit || !Number.isFinite(seconds) || !seconds) return 0;
    const tau=2*Math.PI, span=Math.abs(seconds)*orbit.n;
    if(span>=tau/6)return tau/6; // already fully faded by the mean-rate floor
    const heading=mean=>{
        const cycles=Math.floor((mean+Math.PI)/tau),M=mean-cycles*tau;
        let E=orbit.e<.8?M:(M<0?-Math.PI:Math.PI);
        for(let i=0;i<12;i++)E-=(E-orbit.e*Math.sin(E)-M)/(1-orbit.e*Math.cos(E));
        return Math.atan2(Math.sin(E),Math.sqrt(1-orbit.e*orbit.e)*Math.cos(E))+cycles*tau;
    };
    const current=heading(orbit.M);
    // Include the centered shutter and either frame-to-frame interval. Five
    // fixed endpoint solves cover an eccentric periapsis without substeps.
    return Math.max(span,Math.abs(heading(orbit.M-span)-current),Math.abs(heading(orbit.M+span)-current),
        Math.abs(heading(orbit.M+span/2)-heading(orbit.M-span/2)));
}

export function selectVisibleTrajectories(candidates, previousIds = [], limit = VISIBLE_TRAJECTORY_LIMIT) {
    const previous = new Set(previousIds);
    const ranked = candidates.filter(c => c.visible && [c.sx,c.sy,c.nx,c.ny,c.radiusPx].every(Number.isFinite))
        .map(c => ({ c, score: (c.selected ? 1e6 : 0) + (previous.has(c.id) ? 12 : 0) + Math.min(20,c.radiusPx) - Math.hypot(c.nx,c.ny) * 8 }))
        .sort((a,b) => b.score-a.score || String(a.c.id).localeCompare(String(b.c.id)));
    const result=[];
    for (const {c} of ranked) {
        if (result.length >= Math.max(0, Math.min(VISIBLE_TRAJECTORY_LIMIT, limit))) break;
        if (!c.selected && result.some(p => Math.hypot(c.sx-p.sx,c.sy-p.sy)<30)) continue;
        result.push(c);
    }
    return result;
}
export function trajectoryHorizon({ speed, kmPerPixel, period = Infinity, linear = false }) {
    if (!(speed > 1e-12) || !(kmPerPixel > 0)) return 0;
    const desired = 65 * kmPerPixel / speed;
    // Instantaneous linear estimates are intentionally very short. Never
    // extrapolate a black-hole encounter across days merely to fill pixels.
    return Math.max(0, Math.min(desired, linear ? 60 : period * .12));
}
export function playbackDirection(warp) { return Number.isFinite(warp) && warp < 0 ? -1 : 1; }

// Perspective projection of an instantaneous velocity at its anchor. The
// depth term matters away from the center, including radial motion toward us.
export function projectedVelocity(vRight, vUp, vDepth, rightOverDepth, upOverDepth, out = {}) {
    out.x = vRight - rightOverDepth * vDepth;
    out.y = vUp - upOverDepth * vDepth;
    return out;
}

// Conservative spherical disk occlusion. Cull only a fully covered target,
// preserving partial limbs; radii and positions use the same world units.
export function fullyOcculted(camera, target, targetRadius, center, radius) {
    const dx=target.x-camera.x,dy=target.y-camera.y,dz=target.z-camera.z;
    const distance=Math.hypot(dx,dy,dz);
    if (!(distance>0) || !(radius>0)) return false;
    const ox=center.x-camera.x,oy=center.y-camera.y,oz=center.z-camera.z;
    const along=(ox*dx+oy*dy+oz*dz)/distance;
    if (!(along>radius && along<distance-targetRadius)) return false;
    const cover=radius-targetRadius*along/distance;
    if (!(cover>0)) return false;
    const perpendicular2=Math.max(0,ox*ox+oy*oy+oz*oz-along*along);
    return perpendicular2<cover*cover;
}
