/**
 * Standalone verification harness for the Eker 2018 physical-property model.
 * Run: node scripts/verify-stellar-model.mjs
 * No network required; all functions are duplicated from build-hyg-catalog.mjs.
 *
 * The catalog-resolver sections above this comment stay self-contained
 * (duplicated logic, no imports) since they validate the *reverse* problem
 * (real L/B-V/spectral-type -> mass/radius) used by build-hyg-catalog.mjs.
 * The sections below import the live modules directly to validate the
 * *forward* synthesis problem (mass/age/[Fe/H] -> full stellar state) added
 * in WP5: src/universe/stellar.js's synthStar/sampleIMFMass.
 */
import { synthStar, sampleIMFMass } from "../src/universe/stellar.js";
import { tMSGyr } from "../src/universe/astroConstants.js";
import { makeRNG, hashInts } from "../src/universe/prng.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SOLAR_TEMP_K  = 5772;
const SOLAR_ABS_MAG = 4.83;

// ---------------------------------------------------------------------------
// Utilities (mirrors build-hyg-catalog.mjs)
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function colorTempFromBV(ci) {
    if (!Number.isFinite(ci)) return SOLAR_TEMP_K;
    const bv = Math.max(-0.35, Math.min(2.0, ci));
    return Math.round(4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)));
}

const BC_BY_CLASS = { O: -4.0, B: -2.0, A: -0.3, F: -0.1, G: -0.07, K: -0.2, M: -1.2 };
function bolomCorr(spectClass) { return BC_BY_CLASS[spectClass] ?? -0.1; }

function parseSpectClass(spect) {
    if (!spect) return null;
    const m = spect.match(/^([OBAFGKMLTWCS])/i);
    return m ? m[1].toUpperCase() : null;
}

function parseLumClass(spect) {
    if (!spect) return null;
    // Strip only the temperature subclass (letter + digits/decimal/range-dash),
    // NOT the luminosity class roman numerals.  e.g. "K5III" -> "III", "M1-2 Ia" -> "Ia".
    const tail = spect.replace(/^[A-Z][0-9]*(?:\.[0-9]+)?(?:[-–][0-9]+)?\s*/i, "").trim();
    if (/^Ia/i.test(tail))                               return "Ia";
    if (/^Ib/i.test(tail))                               return "Ib";
    if (/^III/i.test(tail))                              return "III";
    if (/^II([^I]|$)/i.test(tail))                      return "II";
    if (/^IV/i.test(tail))                               return "IV";
    if (/^V([^I]|$)/i.test(tail))                       return "V";
    return null;
}

// Eker et al. (2018, MNRAS 479, 5491) MLR segments: [massLo, massHi, a, b]
const EKER_MLR = [
    [0.00,  0.45,  2.028, -0.976],
    [0.45,  0.72,  4.572, -0.102],
    [0.72,  1.05,  5.743, -0.007],
    [1.05,  2.40,  4.329,  0.010],
    [2.40,  7.00,  3.967,  0.093],
    [7.00, 31.0,   2.865,  1.105],
];

function ekerLumFromMass(mass) {
    const logM = Math.log10(mass);
    for (const [lo, hi, a, b] of EKER_MLR) {
        if (mass >= lo && mass < hi) return a * logM + b;
    }
    const [, , a, b] = EKER_MLR[EKER_MLR.length - 1];
    return a * logM + b;
}

function ekerMassFromLum(lum) {
    if (!(lum > 0)) return null;
    const logL = Math.log10(lum);
    for (const [lo, hi, a, b] of EKER_MLR) {
        const logM = (logL - b) / a;
        const mass = Math.pow(10, logM);
        if (mass >= lo && mass < hi) return clamp(mass, 0.08, 120);
    }
    const [lo, , a, b] = EKER_MLR[EKER_MLR.length - 1];
    const logM = (logL - b) / a;
    return clamp(Math.pow(10, logM), 0.08, 120);
}

function ekerRadiusFromMass(mass) {
    return 0.438 * mass * mass + 0.479 * mass + 0.075;
}

function sbRadius(lum, tempK) {
    if (!(lum > 0) || !(tempK > 0)) return null;
    return Math.sqrt(lum) * Math.pow(SOLAR_TEMP_K / tempK, 2);
}

const EVOLVED_MASS_PRIOR = { Ia: 12, Ib: 10, II: 6, III: 2.5, IV: 1.5 };

// Main physical-properties resolver — same logic as physicalRow() in build script.
function resolvePhysics({ lum, bv, spect }) {
    const spectClass = parseSpectClass(spect);
    const lumClass   = parseLumClass(spect);
    const tempK      = colorTempFromBV(bv);

    const isGiant = lumClass === "Ia" || lumClass === "Ib" ||
                    lumClass === "II"  || lumClass === "III";

    let mass, radius;
    if (isGiant) {
        radius = sbRadius(lum, tempK);
        mass   = clamp(EVOLVED_MASS_PRIOR[lumClass] ?? 2.5, 0.5, 200);
    } else {
        mass = ekerMassFromLum(lum);
        if (mass !== null) {
            radius = (mass >= 0.179 && mass <= 1.5)
                ? ekerRadiusFromMass(mass)
                : sbRadius(lum, tempK);
        } else {
            radius = null;
        }
    }

    if (mass   !== null) mass   = clamp(mass,   0.01, 300);
    if (radius !== null) radius = clamp(radius, 0.001, 2000);

    return { tempK, mass, radius, lumClass };
}

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;

function check(label, value, lo, hi) {
    const ok = value !== null && value >= lo && value <= hi;
    const status = ok ? "PASS" : "FAIL";
    if (ok) passed++; else failed++;
    const range = `[${lo.toPrecision(4)}, ${hi.toPrecision(4)}]`;
    const got   = value === null ? "null" : value.toPrecision(5);
    console.log(`  ${status}  ${label.padEnd(26)} got ${got.padStart(10)}  expected ${range}`);
    return ok;
}

function section(title) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`  ${title}`);
    console.log("─".repeat(60));
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

// 1. Sun proxy (G2V, lum=1, bv=0.656 -> ~5772 K)
section("Sun proxy  (G2V, L=1, bv=0.656)");
{
    const r = resolvePhysics({ lum: 1.0, bv: 0.656, spect: "G2V" });
    console.log(`  lumClass=${r.lumClass}, T=${r.tempK} K`);
    check("mass (Msun)",   r.mass,   0.80, 1.20);
    check("radius (Rsun)", r.radius, 0.80, 1.20);
}

// 2. Sirius A  A1V  L~25.4  T~9940 K
section("Sirius A  (A1V, L=25.4, T~9940 K)");
{
    // B-V = 0.009 for Sirius
    const r = resolvePhysics({ lum: 25.4, bv: 0.009, spect: "A1V" });
    console.log(`  lumClass=${r.lumClass}, T=${r.tempK} K`);
    check("mass (Msun)",   r.mass,   1.55, 2.60);   // lit ~2.06, ±25%
    check("radius (Rsun)", r.radius, 1.29, 2.15);   // lit ~1.71, ±25%
}

// 3. Vega  A0V  L~40  T~9600 K
section("Vega  (A0V, L=40, T~9600 K)");
{
    // B-V = 0.00
    const r = resolvePhysics({ lum: 40, bv: 0.00, spect: "A0V" });
    console.log(`  lumClass=${r.lumClass}, T=${r.tempK} K`);
    check("mass (Msun)",   r.mass,   1.57, 2.62);   // lit ~2.1, ±25%
    check("radius (Rsun)", r.radius, 1.77, 2.95);   // lit ~2.36, ±25%
}

// 4. Proxima Centauri  M5.5V  L~0.0017  T~3040 K
section("Proxima Cen  (M5.5V, L=0.0017, T~3040 K)");
{
    // B-V ≈ 1.90 for late-M
    const r = resolvePhysics({ lum: 0.0017, bv: 1.90, spect: "M5Ve" });
    console.log(`  lumClass=${r.lumClass}, T=${r.tempK} K`);
    check("mass (Msun)",   r.mass,   0.09, 0.15);   // lit ~0.12, ±25%
    check("radius (Rsun)", r.radius, 0.10, 0.19);   // lit ~0.15, ±25%  (Eker MRR)
}

// 5. Betelgeuse  M1-2 Ia supergiant  L~1.26e5  T~3600 K
//    Lit radius ~750-900 Rsun; mass low-confidence ~10-20 Msun
section("Betelgeuse  (M2 Ia, L=1.26e5, T~3600 K)");
{
    const r = resolvePhysics({ lum: 1.26e5, bv: 1.85, spect: "M1-2 Ia" });
    console.log(`  lumClass=${r.lumClass}, T=${r.tempK} K`);
    check("mass (Msun) low-confidence", r.mass,    6,  30);   // prior Ia~12, plausible 10-20
    check("radius (Rsun)",              r.radius, 450, 1200); // lit ~750-900, ±40%
}

// 6. Aldebaran  K5III giant  L~518  T~3900 K
//    Lit radius ~45 Rsun; must be >> main-sequence for same L
section("Aldebaran  (K5III, L=518, T~3900 K)");
{
    // B-V ≈ 1.54 for K5 giant
    const r = resolvePhysics({ lum: 518, bv: 1.54, spect: "K5III" });
    console.log(`  lumClass=${r.lumClass}, T=${r.tempK} K`);
    check("radius (Rsun)",  r.radius, 27,  65);    // lit ~45, ±40%
    // Also verify a main-sequence star with same L would get a much smaller radius
    const msRef = resolvePhysics({ lum: 518, bv: -0.10, spect: "B3V" });
    const giantMuchLarger = r.radius > msRef.radius * 5;
    const giantLabel = giantMuchLarger ? "PASS" : "FAIL";
    if (giantMuchLarger) passed++; else failed++;
    console.log(`  ${giantLabel}  giant R >> MS R for same L  (${r.radius?.toFixed(1)} vs ${msRef.radius?.toFixed(1)})`);
}

// ---------------------------------------------------------------------------
// WP5: forward synthesis (synthStar / sampleIMFMass) — HR diagram, IFMR
// breakpoints, Chabrier sampler statistics.
// ---------------------------------------------------------------------------

function linreg(xs, ys) {
    const n = xs.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return slope;
}

// 7. HR-diagram sanity over a synthesized population.
section("HR diagram: synthStar over mass/age");
{
    // 7a. MS branch: age=0 forces every mass below t_MS, so L(M) should be
    // the plain Eker relation and strictly non-decreasing.
    const rng = makeRNG(hashInts(0xbeef, 12, 0));
    let monotonic = true, noNaN = true, prevL = -Infinity;
    for (let i = 0; i <= 200; i++) {
        const logM = Math.log10(0.1) + (i / 200) * (Math.log10(100) - Math.log10(0.1));
        const m = Math.pow(10, logM);
        const s = synthStar(rng, m, 0, 0);
        if (s.kind !== "MS") monotonic = false;
        if (!Number.isFinite(s.L) || !Number.isFinite(s.R) || !Number.isFinite(s.Teff)) noNaN = false;
        if (s.L < prevL) monotonic = false;
        prevL = s.L;
    }
    const label = monotonic && noNaN ? "PASS" : "FAIL";
    if (monotonic && noNaN) passed++; else failed++;
    console.log(`  ${label}  MS branch: L(M) monotonic, all kind=MS, no NaN/Inf`);

    // 7b. Red-clump cluster: for a spread of masses, age them into the giant
    // window (t_MS .. 1.1*t_MS) and check Teff/L land near the report's
    // red-clump reference point.
    let clusterOk = true;
    for (const m of [0.9, 1.2, 1.8, 2.5, 4]) {
        const tMS = tMSGyr(m);
        const s = synthStar(rng, m, tMS * 1.05, 0);
        if (s.kind !== "giant") clusterOk = false;
        if (!(s.Teff >= 4200 && s.Teff <= 5000)) clusterOk = false;
        if (!(s.L >= 30 && s.L <= 320)) clusterOk = false;
    }
    const clusterLabel = clusterOk ? "PASS" : "FAIL";
    if (clusterOk) passed++; else failed++;
    console.log(`  ${clusterLabel}  red-clump giants cluster near Teff≈4600±400 K, L≈30-320 L☉`);

    // 7c. WD sequence: age a low/mid mass star well past 1.1*t_MS and check
    // the remnant lands on the WD branch with L <= 1e-2 L☉.
    let wdOk = true;
    for (const m of [0.8, 1.5, 3, 6]) {
        const tMS = tMSGyr(m);
        const s = synthStar(rng, m, tMS * 5 + 5, 0);
        if (s.kind !== "WD") wdOk = false;
        if (!(s.L <= 1e-2)) wdOk = false;
    }
    const wdLabel = wdOk ? "PASS" : "FAIL";
    if (wdOk) passed++; else failed++;
    console.log(`  ${wdLabel}  WD sequence: kind=WD, L <= 1e-2 L☉`);
}

// 8. IFMR breakpoints via synthStar (mass, age) -> kind.
section("IFMR breakpoints (synthStar)");
{
    const rng = makeRNG(hashInts(0xbeef, 13, 0));
    const cases = [
        { mass: 5, age: 20, want: "WD" },
        { mass: 10, age: 1, want: "NS" }, // tMS(10)≈0.032 Gyr, age=1 >> 1.1*tMS
        { mass: 30, age: 1, want: "BH" }, // tMS(30)≈0.002 Gyr, age=1 >> 1.1*tMS
    ];
    for (const { mass, age, want } of cases) {
        const s = synthStar(rng, mass, age, 0);
        const ok = s.kind === want;
        if (ok) passed++; else failed++;
        console.log(`  ${ok ? "PASS" : "FAIL"}  mass=${mass} age=${age} Gyr -> ${s.kind} (want ${want})`);
    }
}

// 9. Chabrier IMF sampler statistics (200k draws, fixed seed).
section("Chabrier IMF sampler statistics (n=200,000)");
{
    const rng = makeRNG(hashInts(0xbeef, 14, 0));
    const N = 200_000;
    const mMin = 0.08, mMax = 120, nBins = 60;
    const logLo = Math.log10(mMin), logHi = Math.log10(mMax);
    const dlog = (logHi - logLo) / nBins;
    const binCounts = new Array(nBins).fill(0);
    for (let i = 0; i < N; i++) {
        const m = sampleIMFMass(rng);
        let b = Math.floor((Math.log10(m) - logLo) / dlog);
        if (b < 0) b = 0; if (b >= nBins) b = nBins - 1;
        binCounts[b]++;
    }
    const binCenterLogM = (b) => logLo + (b + 0.5) * dlog;

    // Peak of dN/dlogm below 1 M☉: for a pure lognormal in log10(m) centered
    // at m_c, the maximum of dN/dlogm is mathematically AT m_c regardless of
    // sigma (it's a Gaussian bell in log-mass; d/d(logm) = 0 exactly at the
    // mean). sampleIMFMass now uses the Chabrier *system* IMF (m_c=0.22,
    // σ=0.57 — see stellar.js comment) because it draws primaries, and WP6
    // adds companions on top; the peak should land near m_c=0.22, well
    // inside the sampled range (unlike the individual-star form's m_c=0.079,
    // which sits right at the 0.08 M⊙ sampling floor).
    let peakB = -1, peakVal = -1;
    for (let b = 0; b < nBins; b++) {
        const m = Math.pow(10, binCenterLogM(b));
        if (m > 1) continue;
        const v = binCounts[b] / dlog;
        if (v > peakVal) { peakVal = v; peakB = b; }
    }
    const peakM = Math.pow(10, binCenterLogM(peakB));
    const peakOk = peakM >= 0.12 && peakM <= 0.32;
    if (peakOk) passed++; else failed++;
    console.log(`  ${peakOk ? "PASS" : "FAIL"}  dN/dlogm turnover peak at ${peakM.toFixed(3)} M☉ (want 0.12-0.32, i.e. near system-IMF m_c=0.22)`);

    // Slope above 1 M☉: fit log10(dN/dlogm) vs log10(m), expect α ≈ 2.3±0.3
    // (dN/dlogm ∝ m^(1-α), so α = 1 - slope).
    const xs = [], ys = [];
    for (let b = 0; b < nBins; b++) {
        const logM = binCenterLogM(b);
        const m = Math.pow(10, logM);
        if (m < 1 || m > 20) continue;
        if (binCounts[b] < 30) continue;
        xs.push(logM);
        ys.push(Math.log10(binCounts[b] / dlog));
    }
    const slope = linreg(xs, ys);
    const alpha = 1 - slope;
    const slopeOk = alpha >= 2.0 && alpha <= 2.6;
    if (slopeOk) passed++; else failed++;
    console.log(`  ${slopeOk ? "PASS" : "FAIL"}  slope above 1 M☉: α=${alpha.toFixed(2)} (want 2.3±0.3, from ${xs.length} bins)`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} PASSED   ${failed} FAILED   (${passed + failed} checks total)`);
console.log("=".repeat(60));
if (failed > 0) process.exit(1);
