// A volume has no single depth. Its completed angular radiance can be reused
// for rotations/FOV changes ONLY at the same observer and model state.
// 1e-9 pc is 31 km: < 5e-10 rad at our nearest (2 pc) integration sample.
// It accommodates float64 origin round-off, not interstellar translation.
export const OBSERVER_EPS_PC = 1e-9;
export function sameObserver(a, b) {
    return a.length === b.length && a.every((v, i) => Number.isFinite(v) &&
        Math.abs(v - b[i]) <= OBSERVER_EPS_PC + 8 * Number.EPSILON * Math.max(1, Math.abs(v), Math.abs(b[i])));
}
export function sameGalaxyState(a, b) {
    // Pattern angles drift far below a resolved feature at ordinary time
    // rates. Bound tolerated drift, never let it accumulate frame by frame.
    return a.length === b.length && a.every((v, i) => Number.isFinite(v) && Math.abs(v - b[i]) <= 1e-10);
}
export function canReuseGalaxyHistory(history, observer, model, pixelAngle) {
    return !!history && sameObserver(history.observer, observer) && sameGalaxyState(history.model, model) &&
        history.pixelAngle <= pixelAngle * 0.95;
}
export function targetSizeChanged(previous, next) {
    return previous.length !== next.length || next.some((v, i) => !Number.isFinite(v) || v !== previous[i]);
}
