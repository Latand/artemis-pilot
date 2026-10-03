// Presentation state only. No simulation, time-warp or physics imports.
export const RING_MAX_RATE = 1.4; // rad / real second (~13.4 rpm)
export const RING_FULL_SPEED = 120; // HUD Earth-relative km/s; artistic scale
const TAU = Math.PI * 2;
export function createShipMotion() { return { angle: 0, rate: 0, level: 0 }; }
export function stepShipMotion(state, speedKmS, dtReal, paused = false) {
    if (paused || !Number.isFinite(dtReal) || dtReal <= 0) return state;
    // Drain tab stalls instead of fast-forwarding a cosmetic motor. Negative
    // simulation time never reaches this function; reverse uses real seconds.
    const dt = Math.min(dtReal, .25);
    const speed = Number.isFinite(speedKmS) ? Math.abs(speedKmS) : 0;
    const target = RING_MAX_RATE * Math.sqrt(Math.min(1, speed / RING_FULL_SPEED));
    const oldRate = Number.isFinite(state.rate) ? Math.max(0, Math.min(RING_MAX_RATE, state.rate)) : 0;
    const tau = target > oldRate ? 1.2 : .8;
    const decay = Math.exp(-dt / tau);
    const turn = target * dt + (oldRate - target) * tau * (1 - decay);
    const angle = Number.isFinite(state.angle) ? state.angle : 0;
    state.angle = ((angle % TAU + turn) % TAU + TAU) % TAU;
    state.rate = target + (oldRate - target) * decay;
    if (target === 0 && state.rate < 1e-5) state.rate = 0;
    state.level = state.rate / RING_MAX_RATE;
    return state;
}
