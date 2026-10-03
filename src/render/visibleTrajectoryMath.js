// Bounded display policy, independent of the simulation and renderer.
export const VISIBLE_TRAJECTORY_LIMIT = 10;
export const VISIBLE_TRAJECTORY_SEGMENTS = 32;

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
