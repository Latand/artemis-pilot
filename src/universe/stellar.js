// Stellar physics for procedurally generated stars: sample a real mass from
// the stellar initial mass function, then synthesize luminosity, radius,
// temperature, colour and evolutionary state (MS/giant/remnant) from mass,
// age and metallicity. Main-sequence relations are Eker et al. 2018 (MNRAS
// 479, 5491) — the same model the catalog build script uses and which is
// validated in scripts/verify-stellar-model.mjs. IMF is Chabrier 2003
// (arXiv astro-ph/0304382); giant inflation and the initial-final mass
// relation follow research/astro-population-model.md §7.

import { tMSGyr, IFMR } from "./astroConstants.js";

const TSUN_K = 5772;
const R_SUN_KM = 695700; // IAU nominal solar radius, for remnant radius conversions

// --- Initial mass function (Chabrier 2003) --------------------------------
// dN/d(log10 m): lognormal below 1 M⊙, Salpeter α=2.3 power law above 1 M⊙,
// continuously matched at the 1 M⊙ boundary. Tabulated once at module init
// on a 512-point log-mass grid and inverted by binary search + linear
// interpolation — deterministic, no runtime dependence.
//
// Lognormal parameters: m_c=0.22, σ=0.57 — Chabrier 2003 (PASP 115, 763)
// Table 1's *system* IMF, not the individual-star form (m_c=0.079, σ=0.69).
// Ruling (2026-07): sampleIMFMass draws primaries, and WP6 adds companions
// on top of each primary — individual-star IMF + separately-sampled
// companions double-counts low-mass stars (each companion is itself drawn
// from the same single-star distribution, which already accounts for
// unresolved multiples). The system form is the correct input for a
// primary-then-companion pipeline; using it also fixes the mass function
// turnover, which the individual-star form places right at its own m_c=0.079
// — indistinguishable from the 0.08 M⊙ sampling floor — while the system
// form's peak at m_c=0.22 sits well inside the sampled range.
const CHABRIER_MC = 0.22;
const CHABRIER_SIGMA = 0.57;
const IMF_HIGH_ALPHA = 2.3;
const IMF_M_MIN = 0.08, IMF_M_MAX = 120;
const IMF_TABLE_N = 512;

function chabrierLogDensity(logm) {
    if (logm <= 0) {
        const d = logm - Math.log10(CHABRIER_MC);
        return Math.exp(-(d * d) / (2 * CHABRIER_SIGMA * CHABRIER_SIGMA));
    }
    // Salpeter dN/dm ∝ m^-α becomes dN/d(log m) ∝ m^(1-α); scale so the
    // power-law branch meets the lognormal branch's value at log m = 0.
    const d0 = -Math.log10(CHABRIER_MC);
    const f0 = Math.exp(-(d0 * d0) / (2 * CHABRIER_SIGMA * CHABRIER_SIGMA));
    return f0 * Math.pow(10, logm * (1 - IMF_HIGH_ALPHA));
}

const IMF_CDF_LOGM = new Float64Array(IMF_TABLE_N);
const IMF_CDF_VALUE = new Float64Array(IMF_TABLE_N);

(function buildIMFTable() {
    const logLo = Math.log10(IMF_M_MIN), logHi = Math.log10(IMF_M_MAX);
    const dlog = (logHi - logLo) / (IMF_TABLE_N - 1);
    const density = new Float64Array(IMF_TABLE_N);
    for (let i = 0; i < IMF_TABLE_N; i++) {
        const logm = logLo + i * dlog;
        IMF_CDF_LOGM[i] = logm;
        density[i] = chabrierLogDensity(logm);
    }
    let cum = 0;
    IMF_CDF_VALUE[0] = 0;
    for (let i = 1; i < IMF_TABLE_N; i++) {
        cum += 0.5 * (density[i] + density[i - 1]) * dlog;
        IMF_CDF_VALUE[i] = cum;
    }
    const total = IMF_CDF_VALUE[IMF_TABLE_N - 1];
    for (let i = 0; i < IMF_TABLE_N; i++) IMF_CDF_VALUE[i] /= total;
})();

// Sample one stellar mass (M⊙) from the Chabrier (2003) IMF via inverse-CDF
// table lookup (binary search over the precomputed cumulative table).
export function sampleIMFMass(rng) {
    const u = rng();
    let lo = 0, hi = IMF_TABLE_N - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (IMF_CDF_VALUE[mid] <= u) lo = mid; else hi = mid;
    }
    const c0 = IMF_CDF_VALUE[lo], c1 = IMF_CDF_VALUE[hi];
    const t = c1 > c0 ? (u - c0) / (c1 - c0) : 0;
    const logm = IMF_CDF_LOGM[lo] + t * (IMF_CDF_LOGM[hi] - IMF_CDF_LOGM[lo]);
    return Math.pow(10, logm);
}

// Deprecated alias — kept because galaxy.js and build-hyg-catalog.mjs still
// call this name. The (mMin,mMax) params are honoured only via rejection
// against the full-range table (rare/never hit in practice: every existing
// caller uses the full [0.08,120] default range); new code should call
// sampleIMFMass directly.
export function sampleKroupaMass(rng, mMin = IMF_M_MIN, mMax = IMF_M_MAX) {
    if (mMin <= IMF_M_MIN && mMax >= IMF_M_MAX) return sampleIMFMass(rng);
    for (let tries = 0; tries < 64; tries++) {
        const m = sampleIMFMass(rng);
        if (m >= mMin && m <= mMax) return m;
    }
    return Math.max(mMin, Math.min(mMax, sampleIMFMass(rng)));
}

// Brown-dwarf extension: Kroupa (2001) sub-stellar segment, dN/dm ∝ m^-0.3 on
// [0.01, 0.08] M⊙. Analytic inverse-CDF (single power-law segment), sampled
// separately from the stellar IMF above for the BD population (WP6 seeds it
// as its own density, not mixed into sampleIMFMass).
const BD_ALPHA = 0.3, BD_M_MIN = 0.01, BD_M_MAX = 0.08;
export function sampleBDMass(rng) {
    const p = 1 - BD_ALPHA;
    const ap = Math.pow(BD_M_MIN, p), bp = Math.pow(BD_M_MAX, p);
    return Math.pow(ap + rng() * (bp - ap), 1 / p);
}

// --- Eker 2018 mass→luminosity (main sequence): log L = a·log M + b ---------
function ekerLogL(M) {
    const x = Math.log10(M);
    // Segment boundaries are half-open [lo, hi) to match build-hyg-catalog.mjs
    // EKER_MLR exactly (M = 0.45 falls in the second segment).
    if (M < 0.45) return 2.028 * x - 0.976;
    if (M <= 0.72) return 4.572 * x - 0.102;
    if (M <= 1.05) return 5.743 * x - 0.007;
    if (M <= 2.40) return 4.329 * x + 0.010;
    if (M <= 7.00) return 3.967 * x + 0.093;
    return 2.865 * x + 1.105; // 7–31 M⊙; extrapolated above 31 (rare)
}

function deriveMainSequence(M, out) {
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
    out.mass = M;
    out.L = L;
    out.R = R;
    out.Teff = Teff;
    out.color = tempToColor(Teff);
    out.cls = spectralClass(Teff);
    return out;
}

export function deriveStarVisualInto(M, out) {
    const logM = Math.log10(M);
    const L = Math.pow(10, ekerLogL(M));
    let R, Teff;
    if (M > 1.5) {
        const logT = -0.170 * logM * logM + 0.888 * logM + 3.671;
        Teff = Math.pow(10, logT);
    } else {
        R = 0.438 * M * M + 0.479 * M + 0.075;
        Teff = TSUN_K * Math.pow(L / (R * R), 0.25);
    }
    out.L = L;
    out.color = tempToColor(Teff);
    return out;
}

// Derive full main-sequence properties from a mass (solar units, K, hex colour).
export function deriveStar(M) {
    return deriveMainSequence(M, {});
}

// Present-day main-sequence weighting. The IMF is a *birth* distribution; in an
// old field population massive (short-lived) stars have evolved off the main
// sequence. For a roughly constant star-formation history over the disc age
// T_DISK, the present-day number of MS stars of mass M is the IMF times
// min(1, τ_MS(M)/T_DISK). Using τ_MS ≈ 10 Gyr · M^-2.5 and T_DISK ≈ 10 Gyr gives
// weight = min(1, M^-2.5): ≈1 below 1 M⊙, ~0.12 at 2.3 M⊙, ~0.003 at 10 M⊙ —
// which brings the living O/B fraction down to the observed ~0.1%.
// Deprecated for population synthesis: WP6 replaces this discard-massive-
// stars semantics with synthStar's age-driven MS/giant/remnant conversion
// (a star that fails this weight becomes a remnant instead of vanishing).
// Kept as-is for any caller still doing coin-flip survival on its own.
const T_DISK_GYR = 10;
export function msLifetimeWeight(M) {
    if (M <= 1) return 1;
    return Math.min(1, (10 * Math.pow(M, -2.5)) / T_DISK_GYR);
}

// --- Full stellar synthesis from (mass, age, [Fe/H]) -----------------------
// synthStar(rng, mass, ageGyr, feh) -> { kind, mass, L, R, Teff, color, cls }
// kind: 'MS' while age < t_MS(mass); 'giant' for the post-MS shell-burning
// shell (t_MS..1.1*t_MS); a remnant (WD/NS/BH, per the IFMR) after that.
//
// Determinism: exactly two rng() draws are consumed up front, in every
// branch, regardless of which kind the star ends up being. Only the giant
// branch uses them (L/Teff jitter); MS and remnant branches are fully
// deterministic functions of (mass, ageGyr, feh). This keeps a star's
// identity — and the caller's rng cursor position for whatever it draws
// next — independent of which evolutionary state the star lands in.
export function synthStar(rng, mass, ageGyr, feh = 0) {
    const u1 = rng();
    const u2 = rng();
    const tMS = tMSGyr(mass);
    if (ageGyr < tMS) return synthMS(mass, feh);
    if (ageGyr < 1.1 * tMS) return synthGiant(mass, u1, u2);
    return synthRemnant(mass, ageGyr, tMS);
}

function synthMS(mass, feh) {
    const out = {};
    deriveMainSequence(mass, out);
    // Metallicity shift: lower [Fe/H] means less line blanketing, so the star
    // reads slightly hotter/bluer at fixed L,R; ~50 K per dex is a mild,
    // qualitatively-right nudge (not a full opacity calculation — L and R
    // from the Eker mass relations are left untouched, only Teff/color/cls
    // shift). feh is dex relative to solar, so feh<0 (metal-poor) raises Teff.
    const teff = out.Teff - feh * 50;
    out.Teff = teff;
    out.color = tempToColor(teff);
    out.cls = massSpectralClass(mass);
    out.kind = "MS";
    return out;
}

function synthGiant(mass, u1, u2) {
    // L = 100 L☉ ± 0.5 dex (uniform), Teff = 4600 K ± 300 K (uniform); the
    // report's red-clump reference point. Radius from Stefan–Boltzmann.
    const logL = 2 + (u1 * 2 - 1) * 0.5;
    const L = Math.pow(10, logL);
    const Teff = 4600 + (u2 * 2 - 1) * 300;
    const R = Math.sqrt(L) * Math.pow(TSUN_K / Teff, 2);
    return {
        kind: "giant",
        mass,
        L, R, Teff,
        color: tempToColor(Teff),
        cls: spectralClass(Teff),
    };
}

const SCHWARZSCHILD_KM_PER_MSUN = 2.9532; // 2GM☉/c² in km

function synthRemnant(massInit, ageGyr, tMS) {
    const { kind, mass } = IFMR(massInit);
    if (kind === "WD") {
        // Cooling-age proxy: time elapsed since leaving the main sequence.
        // Young WDs are hot (~20000 K) and comparatively bright (~1e-3 L☉);
        // as they cool over Gyr timescales they redden and dim toward
        // ~5000 K / ~1e-4 L☉. Both a simple, monotone, deterministic decay —
        // not a real cooling-track lookup.
        const coolingGyr = Math.max(0, ageGyr - tMS);
        const decay = Math.pow(1 + coolingGyr / 1.5, -1);
        const Teff = 5000 + 15000 * decay;
        const L = 1e-4 + 9e-4 * decay;
        const R = Math.sqrt(L) * Math.pow(TSUN_K / Teff, 2);
        return { kind: "WD", mass, L, R, Teff, color: tempToColor(Teff), cls: "WD" };
    }
    if (kind === "NS") {
        const R = 12 / R_SUN_KM; // 12 km neutron star radius, in R☉
        const Teff = 1e6;
        const L = R * R * Math.pow(Teff / TSUN_K, 4); // Stefan–Boltzmann link
        return { kind: "NS", mass, L, R, Teff, color: 0x8fb8ff, cls: "NS" };
    }
    // Black hole: zero luminosity, Schwarzschild radius in solar units.
    const R = (SCHWARZSCHILD_KM_PER_MSUN * mass) / R_SUN_KM;
    return { kind: "BH", mass, L: 0, R, Teff: 0, color: 0x000000, cls: "BH" };
}

// Harvard spectral class from effective temperature (standard Pecaut &
// Mamajek 2013 Teff boundaries).
//
// This function stays Teff-facing: it's used for catalog stars (built from
// real photometry, which carries no birth mass of its own) and for giants
// (whose Teff, not their birth mass, is what actually distinguishes a red
// clump star). Main-sequence stars synthesized by synthStar are classified
// by massSpectralClass(mass) instead — the Eker 2018 mass->Teff chain runs
// HOTTER-per-mass than the empirical Pecaut-Mamajek track in the K/M regime,
// which places the K/M Teff boundary at too low a mass; running this
// model's own generated Teff values through the literal Mamajek Teff cuts
// therefore skews the K/M/G population fractions (validate-astro.mjs check
// 2) if this function is asked to double as the MS classifier. Classifying
// MS stars directly against the standard Mamajek mass boundaries sidesteps
// that Teff-chain mismatch, so this function keeps the literal standard
// cuts rather than a Teff-recalibration workaround.
export function spectralClass(Teff) {
    if (Teff >= 30000) return "O";
    if (Teff >= 10000) return "B";
    if (Teff >= 7500) return "A";
    if (Teff >= 6000) return "F";
    if (Teff >= 5280) return "G";
    if (Teff >= 3850) return "K";
    return "M";
}

// Mass-based Harvard spectral class for main-sequence stars, using the
// AUTHORITATIVE Mamajek EEM-table boundary masses at the class-transition
// dwarf types (F0V = 1.61, G0V = 1.06, K0V = 0.88, M0V = 0.57 M☉;
// science-review adjudication 2026-07). synthStar's MS branch uses this
// directly: a star's birth mass is already known at synthesis time, and
// classifying from it sidesteps the Eker mass->Teff chain's hotter-per-mass
// offset in the K/M regime (see spectralClass's comment above) that skews
// population fractions when classifying by Teff instead.
//
// KNOWN MODEL LIMITATION (documented, do not "fix" by tuning boundaries):
// with these physical boundaries the generated G fraction reads ~3.9% vs the
// census ~5.9%, because this model's K+G total (~16.3%) runs below the real
// census (~18.8%). We honor K (12.4% vs census 12.9%) and keep the G deficit
// visible rather than pulling G/K below the real K0V mass to mask it.
//
// CROSS-TIER NOTE: catalog stars are classified by spectralClass(Teff);
// procedural MS stars by mass. Near class transitions the two scales can
// assign adjacent letters to physically similar stars; with the authoritative
// A/F=1.61 boundary the worst-case mismatch band is small. Colors are always
// Teff-driven on both tiers, so this affects the label only.
// Giants keep the Teff-based spectralClass (their Teff, not birth mass, is
// the physically distinguishing feature of the evolved state); remnants keep
// their fixed WD/NS/BH labels.
export function massSpectralClass(mass) {
    if (mass >= 16) return "O";
    if (mass >= 2.1) return "B";
    if (mass >= 1.61) return "A";
    if (mass >= 1.06) return "F";
    if (mass >= 0.88) return "G";
    if (mass >= 0.57) return "K";
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
