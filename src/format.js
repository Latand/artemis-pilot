import { AU_KM, SEC_YEAR } from "./constants.js";

export function fmtKm(v) {
    const av = Math.abs(v);
    if (av < 1) return Math.round(v * 1000).toLocaleString("en-US") + " m";
    if (av < 10) return v.toFixed(2).replace(/\.?0+$/, "") + " km";
    return Math.round(v).toLocaleString("en-US") + " km";
}
export const fmtDist = v => v > 2e7 ? (v / AU_KM).toFixed(3) + " AU" : fmtKm(v);
export function fmtMET(s) {
    const d = Math.floor(s / 86400);
    if (d >= 10000) { // ~27 years: a raw day counter stops reading as time
        const yr = s / SEC_YEAR;
        if (yr >= 1e9) return (yr / 1e9).toFixed(2) + " Gyr";
        if (yr >= 1e6) return (yr / 1e6).toFixed(2) + " Myr";
        if (yr >= 1e4) return (yr / 1e3).toFixed(1) + " kyr";
        return Math.floor(yr).toLocaleString("en-US") + " y " + String(Math.floor((s % SEC_YEAR) / 86400)).padStart(3, "0") + " d";
    }
    const h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), ss = Math.floor(s % 60);
    const p = n => String(n).padStart(2, "0");
    return p(d) + ":" + p(h) + ":" + p(m) + ":" + p(ss);
}
export const clamp01 = x => Math.max(0, Math.min(1, x));
export function smooth01(a, b, x) { const q = clamp01((x - a) / (b - a)); return q * q * (3 - 2 * q); }
export function speedColor(kms, out) {
    const t = Math.max(0, Math.min(1, Math.log(Math.max(kms, .2) / .3) / Math.log(11 / .3)));
    if (t < .55) { const q = t / .55; out[0] = .4 + .6 * q; out[1] = .1 + .16 * q; out[2] = .07 + .07 * q; }
    else { const q = (t - .55) / .45; out[0] = 1; out[1] = .26 + .6 * q; out[2] = .14 + .5 * q; }
    return t;
}
export function escapeKmS(mu, rKm) { return Math.sqrt(2 * mu / Math.max(1, rKm)); }
export function accelMs2(mu, rKm) { return 1000 * mu / Math.max(1, rKm * rKm); }
export function fmtAccel(v) {
    if (v >= .01) return v.toFixed(3) + " m/s²";
    if (v >= 1e-5) return (v * 1000).toFixed(2) + " mm/s²";
    return (v * 1e6).toFixed(2) + " µm/s²";
}
export function gravityShare(muA, rA, muB, rB) {
    const a = muA / Math.max(1, rA * rA), b = muB / Math.max(1, rB * rB);
    return a / Math.max(1e-18, a + b);
}
export function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
        return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
}
export function makeNoise(seed, gw, gh) {
    const rnd = mulberry32(seed);
    const g = new Float32Array(gw * gh);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    const sm = x => x * x * (3 - 2 * x);
    return (u, v) => {
        let val = 0, amp = .5, fu = u, fv = v;
        for (let o = 0; o < 5; o++) {
            const X = fu * gw, Y = fv * gh;
            const x0 = Math.floor(X), y0 = Math.floor(Y);
            const tx = sm(X - x0), ty = sm(Y - y0);
            const xi = ((x0 % gw) + gw) % gw, xj = (xi + 1) % gw;
            const yi = Math.min(gh - 1, Math.max(0, y0)), yj = Math.min(gh - 1, yi + 1);
            const a = g[yi * gw + xi], b = g[yi * gw + xj], c = g[yj * gw + xi], d = g[yj * gw + xj];
            val += amp * ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty);
            amp *= .5; fu *= 2.03; fv *= 2.03;
        }
        return val;
    };
}
