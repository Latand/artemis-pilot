// Display-only, instantaneous two-body exposure. Never advances the world.
const TAU = 2 * Math.PI;
const smooth = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
const wrap = x => ((x + Math.PI) % TAU + TAU) % TAU - Math.PI;

export function osculatingOrbit(x, y, z, vx, vy, vz, mu, out = {}) {
    const r = Math.hypot(x, y, z), v2 = vx * vx + vy * vy + vz * vz;
    const a = 1 / (2 / r - v2 / mu);
    const hx = y * vz - z * vy, hy = z * vx - x * vz, hz = x * vy - y * vx;
    const h = Math.hypot(hx, hy, hz);
    if (!(mu > 0 && r > 0 && a > 0 && h > 0) || !Number.isFinite(a)) return null;
    let px = (vy * hz - vz * hy) / mu - x / r;
    let py = (vz * hx - vx * hz) / mu - y / r;
    let pz = (vx * hy - vy * hx) / mu - z / r;
    const e = Math.hypot(px, py, pz);
    // Unbound/near-parabolic encounters do not have an orbit to average.
    if (!(e < .98)) return null;
    if (e < 1e-8) { px = x / r; py = y / r; pz = z / r; }
    else { px /= e; py /= e; pz /= e; }
    const qx = (hy * pz - hz * py) / h, qy = (hz * px - hx * pz) / h, qz = (hx * py - hy * px) / h;
    const b = a * Math.sqrt(1 - e * e);
    const E = Math.atan2((x * qx + y * qy + z * qz) / b, (x * px + y * py + z * pz) / a + e);
    Object.assign(out, { a, b, e, px, py, pz, qx, qy, qz, n: Math.sqrt(mu / (a * a * a)), M: E - e * Math.sin(E) });
    out.period = TAU / out.n;
    return out;
}

export function sampleOrbit(orbit, dt, out) {
    const M = wrap(orbit.M + orbit.n * (dt % orbit.period));
    let E = orbit.e < .8 ? M : (M < 0 ? -Math.PI : Math.PI);
    for (let i = 0; i < 12; i++) E -= (E - orbit.e * Math.sin(E) - M) / (1 - orbit.e * Math.cos(E));
    const x = orbit.a * (Math.cos(E) - orbit.e), y = orbit.b * Math.sin(E);
    out.x = orbit.px * x + orbit.qx * y;
    out.y = orbit.py * x + orbit.qy * y;
    out.z = orbit.pz * x + orbit.qz * y;
    return out;
}

export function exposurePolicy({ advance, realDt, period, orbitPx, radiusPx, focused = false, paused = false }) {
    if (paused || focused || !Number.isFinite(advance) || !advance || !(period > 0) || !(realDt > 0)) return { blend: 0, averaged: 0, span: 0 };
    // At least a 1/30-s presentation shutter, so 60/120 Hz frames overlap.
    // Actual delivered time is used; no selected-rate or clock cap is added.
    const shutter = Math.abs(advance) * Math.max(1, 1 / (30 * realDt));
    const turns = shutter / period;
    const travelPx = TAU * orbitPx * turns;
    const blend = smooth(2, 14, travelPx) * (1 - smooth(2, 6, radiusPx)) * smooth(3, 12, orbitPx);
    // Extend continuously to a complete orbit BEFORE phase is undersampled.
    // A fixed periapsis seam makes the averaged ring phase-independent.
    const averaged = smooth(.18, .75, turns);
    const span = Math.min(period, shutter + (period - Math.min(period, shutter)) * averaged);
    return { blend, averaged, span: Math.sign(advance) * span };
}
