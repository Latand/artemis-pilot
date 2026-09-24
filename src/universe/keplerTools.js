// Two-body conic toolkit for the black-hole encounter pipeline and the
// tidal-debris renderer. Everything is 3-D, km and km/s, with mu = G(M + m).
//
// All timing uses the universal-variable (Stumpff) formulation, which stays
// well conditioned across elliptic, parabolic, hyperbolic and near-radial
// orbits — tidal debris sits at e = 1 +- 1e-2, exactly where the classical
// eccentric/hyperbolic-anomaly forms lose precision.
//
//   sqrt(mu) t(chi) = sigma0 chi^2 C(z) + (1 - alpha r0) chi^3 S(z) + r0 chi
//   r(chi)          = chi^2 C(z) + sigma0 chi (1 - z S(z)) + r0 (1 - z C(z))
//   z = alpha chi^2, alpha = 1/a = 2/r0 - v0^2/mu, sigma0 = r0.v0 / sqrt(mu)
//
// Pure module: no allocation in the per-particle propagator.

export function stumpC(z) {
    if (z > 0.1) { const s = Math.sqrt(z); return (1 - Math.cos(s)) / z; }
    if (z < -0.1) { const s = Math.sqrt(-z); return (Math.cosh(s) - 1) / (-z); }
    // sum_k (-z)^k / (2k+2)!
    return 1 / 2 - z * (1 / 24 - z * (1 / 720 - z * (1 / 40320 - z * (1 / 3628800 - z / 479001600))));
}
export function stumpS(z) {
    if (z > 0.1) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
    if (z < -0.1) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); }
    // sum_k (-z)^k / (2k+3)!
    return 1 / 6 - z * (1 / 120 - z * (1 / 5040 - z * (1 / 362880 - z * (1 / 39916800 - z / 6227020800))));
}

// Universal-variable helpers for a state (r0, sigma0, alpha).
function uTime(chi, r0, sigma0, alpha, sqmu) {
    const z = alpha * chi * chi;
    return (sigma0 * chi * chi * stumpC(z) + (1 - alpha * r0) * chi * chi * chi * stumpS(z) + r0 * chi) / sqmu;
}
function uRadius(chi, r0, sigma0, alpha) {
    const z = alpha * chi * chi;
    return chi * chi * stumpC(z) + sigma0 * chi * (1 - z * stumpS(z)) + r0 * (1 - z * stumpC(z));
}
// r.v / sqrt(mu) along the orbit
function uSigma(chi, r0, sigma0, alpha) {
    const z = alpha * chi * chi;
    return sigma0 * (1 - z * stumpC(z)) + (1 - alpha * r0) * chi * (1 - z * stumpS(z));
}

// Solve sqrt(mu) dt = F(chi) (monotonic, F' = r > 0) by safeguarded Newton.
// A warm start (last frame's chi) usually converges in two or three plain
// Newton steps; the bracketed fallback handles cold starts and big jumps.
export function solveUniversal(dt, r0, sigma0, alpha, mu, guess = NaN) {
    const sqmu = Math.sqrt(mu);
    if (dt === 0) return 0;
    const target = dt;
    if (Number.isFinite(guess)) {
        let chi = guess;
        for (let k = 0; k < 6; k++) {
            const f = uTime(chi, r0, sigma0, alpha, sqmu) - target;
            const r = uRadius(chi, r0, sigma0, alpha);
            if (!(r > 0)) break;
            const step = f * sqmu / r;
            const next = chi - step;
            if (!Number.isFinite(next)) break;
            if (Math.abs(step) <= 1e-11 * Math.max(1, Math.abs(next))) return next;
            chi = next;
        }
    }
    // bracket, from a first step that cannot overshoot wildly: chi is below
    // sqrt(mu) dt / r0 (the linear term), below the parabolic cube root, at
    // most an orbit for an ellipse, and a hyperbolic anomaly of 7 is a long
    // way out (larger steps would overflow cosh)
    let lo, hi;
    const dir = dt > 0 ? 1 : -1;
    const adt = Math.abs(sqmu * dt);
    let step = Math.max(1e-30, Math.min(adt / Math.max(r0, 1e-30), Math.cbrt(6 * adt / Math.max(1e-12, 1 - alpha * r0))));
    if (alpha > 0) step = Math.min(step, 2 * Math.PI / Math.sqrt(alpha));
    else if (alpha < 0) step = Math.min(step, 7 / Math.sqrt(-alpha));
    lo = 0; hi = dir * step;
    for (let k = 0; k < 200 && (uTime(hi, r0, sigma0, alpha, sqmu) - target) * dir < 0; k++) { lo = hi; hi *= 2; }
    if (dir < 0) { const t = lo; lo = hi; hi = t; }
    let chi = Number.isFinite(guess) && guess > lo && guess < hi ? guess : .5 * (lo + hi);
    for (let k = 0; k < 100; k++) {
        const f = uTime(chi, r0, sigma0, alpha, sqmu) - target;
        if (f > 0) hi = chi; else lo = chi;
        const r = uRadius(chi, r0, sigma0, alpha);
        let next = chi - f * sqmu / Math.max(1e-300, r);
        if (!(next > lo && next < hi)) next = .5 * (lo + hi);
        if (Math.abs(next - chi) <= 1e-13 * Math.max(1, Math.abs(chi))) { chi = next; break; }
        chi = next;
    }
    return chi;
}

// Full osculating description of a relative state. `out` is reused.
export function makeConic() {
    return {
        mu: 0, r: 0, v: 0, E: 0, alpha: 0, h: 0, e: 0, p: 0, rp: 0, a: 0,
        hx: 0, hy: 0, hz: 0, ex: 1, ey: 0, ez: 0, qx: 0, qy: 1, qz: 0,
        nu: 0, sigma0: 0, inbound: false, bound: false, period: Infinity,
        tToPeri: 0, // time until the NEXT pericentre passage (>= 0)
        tSincePeri: 0, // signed time since the nearest pericentre: < 0 before it
    };
}

export function conicFromState(rx, ry, rz, vx, vy, vz, mu, out) {
    const r = Math.hypot(rx, ry, rz);
    const v2 = vx * vx + vy * vy + vz * vz;
    const rv = rx * vx + ry * vy + rz * vz;
    out.mu = mu; out.r = r; out.v = Math.sqrt(v2);
    out.E = v2 / 2 - mu / r;
    out.alpha = 2 / r - v2 / mu;
    out.a = out.alpha !== 0 ? 1 / out.alpha : Infinity;
    out.bound = out.alpha > 0;
    let hx = ry * vz - rz * vy, hy = rz * vx - rx * vz, hz = rx * vy - ry * vx;
    const h = Math.hypot(hx, hy, hz);
    out.h = h;
    // eccentricity vector (v x h)/mu - r/r
    const ex = (vy * hz - vz * hy) / mu - rx / r;
    const ey = (vz * hx - vx * hz) / mu - ry / r;
    const ez = (vx * hy - vy * hx) / mu - rz / r;
    const e = Math.hypot(ex, ey, ez);
    out.e = e;
    out.p = h * h / mu;
    out.rp = out.p / (1 + e);
    if (!(h > 1e-12 * r * Math.max(out.v, 1e-12))) {
        // radial orbit: any normal will do; pericentre at the centre
        const ax = Math.abs(rx) < .9 * r ? 1 : 0, ay = ax ? 0 : 1;
        hx = ry * 0 - rz * ay; hy = rz * ax - rx * 0; hz = rx * ay - ry * ax;
        const hn = Math.hypot(hx, hy, hz) || 1;
        hx /= hn; hy /= hn; hz /= hn;
        out.rp = 0;
    } else { hx /= h; hy /= h; hz /= h; }
    out.hx = hx; out.hy = hy; out.hz = hz;
    let ux, uy, uz;
    if (e > 1e-9) { ux = ex / e; uy = ey / e; uz = ez / e; }
    else { ux = rx / r; uy = ry / r; uz = rz / r; }
    out.ex = ux; out.ey = uy; out.ez = uz;
    out.qx = hy * uz - hz * uy; out.qy = hz * ux - hx * uz; out.qz = hx * uy - hy * ux;
    out.nu = Math.atan2((rx * out.qx + ry * out.qy + rz * out.qz) / r, (rx * ux + ry * uy + rz * uz) / r);
    out.inbound = rv < 0;
    out.sigma0 = rv / Math.sqrt(mu);
    out.period = out.bound ? 2 * Math.PI / Math.sqrt(mu * out.alpha * out.alpha * out.alpha) : Infinity;
    // time to/since pericentre: chi_p solves sigma(chi) = 0, sigma is monotonic
    // between the current point and the pericentre on either leg
    const tp = pericentreOffset(r, out.sigma0, out.alpha, mu);
    out.tSincePeri = -tp;
    out.tToPeri = tp >= 0 ? tp : (out.bound ? tp + out.period : Infinity);
    return out;
}

// Signed time from the current state to the nearest pericentre passage
// (positive ahead when inbound, negative behind when outbound).
export function pericentreOffset(r0, sigma0, alpha, mu) {
    if (sigma0 === 0) return 0;
    const sqmu = Math.sqrt(mu);
    const dir = sigma0 < 0 ? 1 : -1;
    // bracket the root of sigma(chi) in the travel direction
    let lo = 0, hi = dir * Math.max(1e-12, Math.abs(sigma0));
    const lim = alpha > 0 ? Math.PI / Math.sqrt(alpha) : Infinity; // half an orbit in chi
    for (let k = 0; k < 400; k++) {
        const s = uSigma(hi, r0, sigma0, alpha);
        if (s * dir >= 0 || Math.abs(hi) >= lim) break;
        lo = hi; hi *= 2;
    }
    if (Math.abs(hi) > lim) hi = dir * lim;
    for (let k = 0; k < 200; k++) {
        const m = .5 * (lo + hi);
        if (uSigma(m, r0, sigma0, alpha) * dir < 0) lo = m; else hi = m;
        if (Math.abs(hi - lo) <= 1e-15 * Math.max(1e-30, Math.abs(hi))) break;
    }
    const chi = .5 * (lo + hi);
    return uTime(chi, r0, sigma0, alpha, sqmu);
}

// Time from the current state until the orbit first reaches radius rTarget
// moving inward (Infinity when it never does before pericentre).
export function timeToRadiusInbound(r0, sigma0, alpha, mu, rTarget) {
    if (r0 <= rTarget) return 0;
    if (sigma0 >= 0) return Infinity;
    const sqmu = Math.sqrt(mu);
    // pericentre chi
    let lo = 0, hi = Math.max(1e-12, -sigma0);
    const lim = alpha > 0 ? Math.PI / Math.sqrt(alpha) : Infinity;
    for (let k = 0; k < 400; k++) {
        if (uSigma(hi, r0, sigma0, alpha) >= 0 || hi >= lim) break;
        lo = hi; hi *= 2;
    }
    if (hi > lim) hi = lim;
    for (let k = 0; k < 200; k++) {
        const m = .5 * (lo + hi);
        if (uSigma(m, r0, sigma0, alpha) < 0) lo = m; else hi = m;
        if (hi - lo <= 1e-15 * hi) break;
    }
    const chiP = .5 * (lo + hi);
    if (uRadius(chiP, r0, sigma0, alpha) > rTarget) return Infinity;
    lo = 0; hi = chiP;
    for (let k = 0; k < 200; k++) {
        const m = .5 * (lo + hi);
        if (uRadius(m, r0, sigma0, alpha) > rTarget) lo = m; else hi = m;
        if (hi - lo <= 1e-15 * hi) break;
    }
    return uTime(.5 * (lo + hi), r0, sigma0, alpha, sqmu);
}

// State at time dt from (r0, v0) — Lagrange f, g form. out = {x,y,z,vx,vy,vz}.
export function propagateState(rx, ry, rz, vx, vy, vz, mu, dt, out, guess = NaN) {
    const r0 = Math.hypot(rx, ry, rz);
    const v2 = vx * vx + vy * vy + vz * vz;
    const sqmu = Math.sqrt(mu);
    const sigma0 = (rx * vx + ry * vy + rz * vz) / sqmu;
    const alpha = 2 / r0 - v2 / mu;
    const chi = solveUniversal(dt, r0, sigma0, alpha, mu, guess);
    const z = alpha * chi * chi, C = stumpC(z), S = stumpS(z);
    const r = uRadius(chi, r0, sigma0, alpha);
    const f = 1 - chi * chi * C / r0;
    const g = dt - chi * chi * chi * S / sqmu;
    const fd = sqmu / (r * r0) * chi * (z * S - 1);
    const gd = 1 - chi * chi * C / r;
    out.x = f * rx + g * vx; out.y = f * ry + g * vy; out.z = f * rz + g * vz;
    out.vx = fd * rx + gd * vx; out.vy = fd * ry + gd * vy; out.vz = fd * rz + gd * vz;
    out.chi = chi;
    return out;
}

// Perifocal position at time dt after pericentre for pericentre distance q
// and alpha = 1/a; writes X (toward pericentre) and Y (along the pericentre
// velocity) into out[0], out[1] and returns the universal anomaly for warm
// starts. Allocation-free: used per particle per frame.
export function perifocalAt(q, alpha, mu, dt, chiGuess, out) {
    const sqmu = Math.sqrt(mu);
    const v0 = Math.sqrt(Math.max(0, mu * (2 / q - alpha)));
    const chi = solveUniversal(dt, q, 0, alpha, mu, chiGuess);
    const z = alpha * chi * chi, C = stumpC(z), S = stumpS(z);
    const f = 1 - chi * chi * C / q;
    const g = dt - chi * chi * chi * S / sqmu;
    out[0] = f * q;
    out[1] = g * v0;
    out[2] = chi * chi * C + q * (1 - z * C); // radius
    return chi;
}
