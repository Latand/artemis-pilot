// Sampling support only. The ambient volume still follows cam.tgt, but a
// visible mass can lie outside it (especially while flying past the Sun).
// Give each source the radius it would have in a camera-distance-matched
// view. This neither adds particles nor changes the gravitational field.
export const HALO_RADIUS_MAX = 1.2e8;
export function haloSamplingRadius(volumeRadius, cameraDistance) {
    return Math.min(HALO_RADIUS_MAX, Math.max(volumeRadius, cameraDistance * 2.8));
}
export function haloEdgeFade(distance, reach) {
    const x = Math.min(1, Math.max(0, (distance / reach - 0.8) / 0.45));
    return 1 - x * x * (3 - 2 * x);
}
// Convert the existing 60-Hz refresh budget to a real-time probability, so
// camera coverage settles equally at 30/60/120 Hz and on skipped computes.
export function refreshProbability(perFrame, elapsed) {
    return 1 - Math.pow(1 - Math.min(1, Math.max(0, perFrame)), Math.max(0, elapsed) * 60);
}

const smooth = (a, b, x) => { const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t); };
// A soft padded frustum keeps source ownership ready before a halo enters
// the viewport. Very distant subpixel/float32-unsafe halos remain field
// sources, but do not consume visible sampling slots.
export function haloViewWeight(x, y, depth, cameraDistance, centerDistance, reach, tanHalfFov, aspect, nearTierLimit = Infinity) {
    const range = Number.isFinite(nearTierLimit) ? 1 - smooth(nearTierLimit * .8, nearTierLimit, Math.max(0, depth - reach * 1.25)) : 1;
    const angular = smooth(.0005, .002, reach / Math.max(cameraDistance, 1e-9));
    const precision = 1 - smooth(1e4, 1e5, centerDistance / Math.max(reach, 1e-9));
    if (depth + reach <= 0) return 0;
    const z = Math.max(depth, reach, 1e-9);
    const pad = Math.min(2, reach / z / tanHalfFov);
    const edge = Math.max(Math.abs(x) / (z * tanHalfFov * aspect), Math.abs(y) / (z * tanHalfFov));
    return range * angular * precision * (1-smooth(1+pad, 1.5+pad, edge));
}
