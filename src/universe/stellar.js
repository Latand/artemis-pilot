// Stellar physics for procedurally generated stars: sample a real mass from the
// stellar initial mass function, then derive luminosity, radius, temperature and
// colour from that mass. The mass→(L,R,T) relations are Eker et al. 2018
// (MNRAS 479, 5491) — the same model the catalog build script uses and which is
// validated in scripts/verify-stellar-model.mjs.

const TSUN_K = 5772;

// --- Initial mass function ------------------------------------------------
// Kroupa (2001) broken power law dN/dm ∝ m^-α: α=1.3 on [0.08,0.5], α=2.3 above.
// Continuity at 0.5 M⊙ fixes the relative segment weights (A0 = 2·A1).
const KROUPA = [
    // [mLo, mHi, alpha, A]
    [0.08, 0.5, 1.3, 2.0],
    [0.5, 120.0, 2.3, 1.0],
];

function segmentWeight(A, alpha, lo, hi) {
    if (Math.abs(alpha - 1) < 1e-9) return A * Math.log(hi / lo);
    const p = 1 - alpha;
    return A * (Math.pow(hi, p) - Math.pow(lo, p)) / p;
}

// Sample one stellar mass (M⊙) from the Kroupa IMF, using inverse-CDF sampling.
export function sampleKroupaMass(rng, mMin = 0.08, mMax = 120) {
    const weights = KROUPA.map(([lo, hi, a, A]) => {
        const l = Math.max(lo, mMin), h = Math.min(hi, mMax);
        return l >= h ? 0 : segmentWeight(A, a, l, h);
    });
    const total = weights[0] + weights[1];
    const u = rng() * total;
    const seg = u < weights[0] ? 0 : 1;
    const [lo, hi, alpha] = KROUPA[seg];
    const l = Math.max(lo, mMin), h = Math.min(hi, mMax);
    const p = 1 - alpha;
    const lp = Math.pow(l, p), hp = Math.pow(h, p);
    return Math.pow(lp + rng() * (hp - lp), 1 / p);
}

// --- Eker 2018 mass→luminosity (main sequence): log L = a·log M + b ---------
function ekerLogL(M) {
    const x = Math.log10(M);
    if (M <= 0.45) return 2.028 * x - 0.976;
    if (M <= 0.72) return 4.572 * x - 0.102;
    if (M <= 1.05) return 5.743 * x - 0.007;
    if (M <= 2.40) return 4.329 * x + 0.010;
    if (M <= 7.00) return 3.967 * x + 0.093;
    return 2.865 * x + 1.105; // 7–31 M⊙; extrapolated above 31 (rare)
}

// Derive full main-sequence properties from a mass (solar units, K, hex colour).
export function deriveStar(M) {
    const logM = Math.log10(M);
    const L = Math.pow(10, ekerLogL(M));
    let R, Teff;
    if (M > 1.5) {
        // Eker mass→Teff (valid 1.5–31 M⊙), radius from Stefan–Boltzmann.
        const logT = -0.170 * logM * logM + 0.888 * logM + 3.671;
        Teff = Math.pow(10, logT);
        R = Math.sqrt(L) * Math.pow(TSUN_K / Teff, 2);
    } else {
        // Eker mass→radius polynomial, Teff back out of Stefan–Boltzmann.
        R = 0.438 * M * M + 0.479 * M + 0.075;
        Teff = TSUN_K * Math.pow(L / (R * R), 0.25);
    }
    return { mass: M, L, R, Teff, color: tempToColor(Teff), cls: spectralClass(Teff) };
}

// Present-day main-sequence weighting. The IMF is a *birth* distribution; in an
// old field population massive (short-lived) stars have evolved off the main
// sequence. For a roughly constant star-formation history over the disc age
// T_DISK, the present-day number of MS stars of mass M is the IMF times
// min(1, τ_MS(M)/T_DISK). Using τ_MS ≈ 10 Gyr · M^-2.5 and T_DISK ≈ 10 Gyr gives
// weight = min(1, M^-2.5): ≈1 below 1 M⊙, ~0.12 at 2.3 M⊙, ~0.003 at 10 M⊙ —
// which brings the living O/B fraction down to the observed ~0.1%.
const T_DISK_GYR = 10;
export function msLifetimeWeight(M) {
    if (M <= 1) return 1;
    return Math.min(1, (10 * Math.pow(M, -2.5)) / T_DISK_GYR);
}

// Harvard spectral class from effective temperature.
export function spectralClass(Teff) {
    if (Teff >= 30000) return "O";
    if (Teff >= 10000) return "B";
    if (Teff >= 7500) return "A";
    if (Teff >= 6000) return "F";
    if (Teff >= 5200) return "G";
    if (Teff >= 3700) return "K";
    return "M";
}

// Approximate stellar colour (sRGB hex) from effective temperature: interpolate
// across class anchor colours. Good enough for additive point/glow rendering.
const COLOR_ANCHORS = [
    [40000, 0x9bb0ff], // O — blue-white
    [20000, 0xaabfff], // B
    [9000, 0xcad7ff], // A — white-blue
    [7000, 0xf8f7ff], // F — white
    [5800, 0xfff4ea], // G — yellow-white (Sun-ish)
    [4500, 0xffd2a1], // K — orange
    [3400, 0xffb46a], // M — orange-red
    [2600, 0xff9966], // late M / cool
];

function tempToColor(T) {
    const A = COLOR_ANCHORS;
    if (T >= A[0][0]) return A[0][1];
    if (T <= A[A.length - 1][0]) return A[A.length - 1][1];
    for (let i = 0; i < A.length - 1; i++) {
        const [tHi, cHi] = A[i], [tLo, cLo] = A[i + 1];
        if (T <= tHi && T >= tLo) {
            const f = (T - tLo) / (tHi - tLo);
            return lerpHex(cLo, cHi, f);
        }
    }
    return 0xffffff;
}

function lerpHex(a, b, f) {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    const r = Math.round(ar + (br - ar) * f);
    const g = Math.round(ag + (bg - ag) * f);
    const bl = Math.round(ab + (bb - ab) * f);
    return (r << 16) | (g << 8) | bl;
}
