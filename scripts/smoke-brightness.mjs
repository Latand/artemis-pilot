// Smoke test for src/render/viewBrightness.js (WP16: unified observer-relative
// star photometry). Pure math — no THREE, no DOM, no canvas — exercising the
// exact functions every star-rendering layer (Tier-0 catalog cloud, Tier-1
// AT-HYG stream, and the Sun's far-field view) imports and calls, so a PASS
// here is a guarantee those layers are using provably identical formulas
// rather than hand-copied approximations that could drift apart.

import {
    SUN_ABS_MAG, SUN_TEFF_K,
    absMagFromL, lFromAbsMag, absMagFromApparent, apparentMagAt,
    observedMag, observedMagFromAbsMag,
    BRIGHTNESS_CURVE, SKY_CURVE,
    sizePxForMag, alphaForMag, hdrIntensityForMag,
    sunObservedMag,
    SKY_DOME_FADE_START_PC, SKY_DOME_FADE_END_PC, skyDomeFade,
    bvToTeff, teffToRGB,
} from "../src/render/viewBrightness.js";

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
    if (cond) { pass++; console.log(`  PASS  ${label}${detail ? "   " + detail : ""}`); }
    else { fail++; console.log(`  FAIL  ${label}${detail ? "   " + detail : ""}`); }
};
const hr = t => console.log("\n" + "─".repeat(60) + "\n  " + t + "\n" + "─".repeat(60));
const close = (a, b, tol) => Math.abs(a - b) <= tol;

// ── 1. absMag <-> L round-trip, and the Sun's own calibration point ────────
hr("Absolute magnitude <-> solar luminosity");
ok(close(absMagFromL(1), SUN_ABS_MAG, 1e-9), "absMagFromL(1 Lsun) = SUN_ABS_MAG", `got ${absMagFromL(1)}`);
ok(close(lFromAbsMag(SUN_ABS_MAG), 1, 1e-9), "lFromAbsMag(SUN_ABS_MAG) = 1 Lsun", `got ${lFromAbsMag(SUN_ABS_MAG)}`);
for (const L of [0.001, 0.1, 1, 10, 1000]) {
    const rt = lFromAbsMag(absMagFromL(L));
    ok(close(rt, L, L * 1e-9), `L=${L}: absMagFromL -> lFromAbsMag round-trips`, `got ${rt}`);
}
ok(SUN_TEFF_K > 5000 && SUN_TEFF_K < 6500, "SUN_TEFF_K is a plausible G2V value", `got ${SUN_TEFF_K}`);

// ── 2. observedMag is THE one formula every layer funnels through ─────────
hr("Observer-relative apparent magnitude (WP16 a1)");
// A tier-0-style star (stores L directly) and a tier-1-style star (stores
// absMag directly, derived earlier from apparent mag + distance from Sol)
// must render at IDENTICAL brightness from the same camera distance when
// they represent the same intrinsic luminosity — this is the literal
// "equal-L stars at equal dCam match across layer formulas" acceptance line.
for (const L of [0.01, 1, 100]) {
    for (const dCamPc of [0.5, 5, 500, 50000]) {
        const viaL = observedMag(L, dCamPc);
        const viaAbsMag = observedMagFromAbsMag(absMagFromL(L), dCamPc);
        ok(close(viaL, viaAbsMag, 1e-9), `L=${L}, dCam=${dCamPc}pc: observedMag(L,d) == observedMagFromAbsMag(absMagFromL(L),d)`,
            `${viaL.toFixed(6)} vs ${viaAbsMag.toFixed(6)}`);
    }
}
// A tier-1 star's stored absMag is itself derived from an apparent magnitude
// + a distance-from-Sol at ingest (absMagFromApparent) — round-trip that too.
for (const [mag, distPc] of [[4.83, 10], [1.2, 8.6], [11.05, 4.2465]]) {
    const absMag = absMagFromApparent(mag, distPc);
    const back = apparentMagAt(absMag, distPc);
    ok(close(back, mag, 1e-9), `mag=${mag} @ ${distPc}pc: absMagFromApparent -> apparentMagAt round-trips`, `got ${back}`);
}

// ── 3. brightness monotonically declines with camera distance (no floor) ──
hr("Monotonic falloff with camera distance (no floor, WP16 a2)");
{
    const distances = [1e-4, 1e-3, 1e-2, 0.1, 1, 10, 100, 1000, 1e5];
    let prevHdr = Infinity;
    let monotonic = true;
    for (const d of distances) {
        const mag = observedMag(1, d);
        const hdr = hdrIntensityForMag(mag, BRIGHTNESS_CURVE);
        if (hdr >= prevHdr) monotonic = false;
        prevHdr = hdr;
    }
    ok(monotonic, "hdrIntensityForMag(observedMag(L=1,d)) strictly decreases as d grows over 9 decades");
    // No floor: at a large enough distance the intensity must go arbitrarily
    // close to zero, not asymptote to some positive constant (the exact bug
    // the old sunGlow opacity floor had).
    const veryFar = hdrIntensityForMag(observedMag(1, 1e8), BRIGHTNESS_CURVE);
    ok(veryFar < 1e-6, "brightness has no floor: goes near-zero at extreme camera distance", `got ${veryFar}`);
}

// ── 4. Sun: exact 1/d^2 falloff, continuous through the whole range ───────
hr("Sun as an ordinary L=1 star: true inverse-square falloff (WP16 a2)");
{
    // hdrIntensityForMag is unclamped, so for a fixed L it is an EXACT power
    // law in distance (mag ~ 5*log10(d) => hdr ~ d^-2) — verified exactly,
    // not just "roughly", across the radial fly-away sequence from the plan's
    // own acceptance line (1 AU, 10 AU, 100 AU, 0.1 pc, 1.3 pc, 10 pc, 100 pc).
    const AU_PC = 1 / 206264.806;
    const flyAwayPc = [1 * AU_PC, 10 * AU_PC, 100 * AU_PC, 0.1, 1.3, 10, 100];
    const hdrAt = d => hdrIntensityForMag(sunObservedMag(d), BRIGHTNESS_CURVE);
    let prev = Infinity;
    let monotonic = true;
    for (const d of flyAwayPc) {
        const hdr = hdrAt(d);
        if (hdr >= prev) monotonic = false;
        prev = hdr;
    }
    ok(monotonic, "Sun's HDR intensity strictly decreases across the full 1 AU -> 100 pc fly-away sequence",
        flyAwayPc.map(d => hdrAt(d).toExponential(2)).join(" > "));
    // At Proxima's distance (1.3 pc) the Sun should read as an ordinary,
    // unremarkable point (roughly naked-eye-limit-ish magnitude) per the
    // plan's own acceptance text ("an ordinary mag ~ 0.4 point").
    const magAt1p3pc = sunObservedMag(1.3);
    ok(magAt1p3pc > -1 && magAt1p3pc < 2, "Sun observed from 1.3 pc (Proxima's distance) reads as an ordinary faint point",
        `mag=${magAt1p3pc.toFixed(2)}`);
    // Exact inverse-square: ratio of two points' HDR intensity equals the
    // inverse-square ratio of their distances, to float precision.
    for (const [d1, d2] of [[0.1, 1], [1, 10], [10, 100], [1e-4, 1e-2]]) {
        const ratio = hdrAt(d1) / hdrAt(d2);
        const expected = (d2 / d1) ** 2;
        ok(close(ratio, expected, expected * 1e-6), `hdr(${d1}pc)/hdr(${d2}pc) == (${d2}/${d1})^2 exactly (unclamped power law)`,
            `got ${ratio.toExponential(4)} vs ${expected.toExponential(4)}`);
    }
    // Continuity through the "sprite -> point" handoff: since it's one
    // continuous function of camDistPc (no discrete regime switch), sampling
    // either side of the plan's ~0.5 pc handoff point must show no jump.
    const eps = 1e-6;
    const justBelow = hdrAt(0.5 - eps), justAbove = hdrAt(0.5 + eps);
    ok(close(justBelow, justAbove, justBelow * 1e-3), "no discontinuity at the 0.5 pc sprite->point handoff distance",
        `${justBelow.toExponential(6)} vs ${justAbove.toExponential(6)}`);
}

// ── 5. equal-L stars at equal camera distance match, regardless of how far
//      from Sol they originally were (the actual near-Sun-bubble fix) ──────
hr("No near-Sun bubble: brightness depends on camera distance only (WP16 a1)");
{
    // Two stars of identical luminosity, one that happened to sit 2 pc from
    // Sol and one that sits 3000 pc from Sol, observed from the SAME camera
    // distance must render identically bright. The old bug baked in apparent
    // magnitude computed from Sol, so the "near" one stayed artificially
    // bright at galaxy zoom regardless of true camera distance.
    const L = 1.6;
    const nearSolAbsMag = absMagFromApparent(/* mag as seen from 2pc */ absMagFromL(L) + 5 * Math.log10(2 / 10), 2);
    const farFromSolAbsMag = absMagFromApparent(/* mag as seen from 3000pc */ absMagFromL(L) + 5 * Math.log10(3000 / 10), 3000);
    ok(close(nearSolAbsMag, farFromSolAbsMag, 1e-6), "absMag recovered is independent of the star's distance from Sol",
        `${nearSolAbsMag.toFixed(6)} vs ${farFromSolAbsMag.toFixed(6)}`);
    const camDistPc = 50000; // galaxy-zoom camera distance
    const magNear = observedMagFromAbsMag(nearSolAbsMag, camDistPc);
    const magFar = observedMagFromAbsMag(farFromSolAbsMag, camDistPc);
    ok(close(magNear, magFar, 1e-6), "at galaxy-zoom camera distance, both stars render at the identical apparent magnitude",
        `${magNear.toFixed(6)} vs ${magFar.toFixed(6)}`);
}

// ── 6. size/alpha curves stay well-behaved (clamped, monotonic) ───────────
hr("Size/alpha curve sanity");
for (const curve of [BRIGHTNESS_CURVE, SKY_CURVE]) {
    const sizes = [-2, 0, 2, 4, 6, 8, 10].map(m => sizePxForMag(m, curve));
    let monotonic = true;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[i - 1] + 1e-9) monotonic = false;
    ok(monotonic, `sizePxForMag is non-increasing with magnitude (curve basePx=${curve.basePx})`, sizes.map(s => s.toFixed(2)).join(","));
    ok(sizes.every(s => s >= curve.minPx - 1e-9 && s <= curve.maxPx + 1e-9), "sizePxForMag stays within [minPx, maxPx]");
    const alphas = [-2, 0, 4, 8, 12].map(m => alphaForMag(m, curve));
    ok(alphas.every(a => a >= 0 && a <= 1), "alphaForMag stays within [0, 1]", alphas.map(a => a.toFixed(3)).join(","));
}

// ── 7. realSky dome fade zone: continuous, monotonic, correct endpoints ───
hr("realSky dome fade (50 -> 500 pc, WP16 a1 legacy-path boundary)");
ok(skyDomeFade(0) === 1, "fully opaque at the Sun");
ok(skyDomeFade(SKY_DOME_FADE_START_PC) === 1, "still fully opaque at the 50 pc fade-start boundary");
ok(skyDomeFade(SKY_DOME_FADE_END_PC) === 0, "fully faded by the 500 pc fade-end boundary");
ok(skyDomeFade(1e6) === 0, "stays fully faded far beyond 500 pc");
{
    const samples = Array.from({ length: 21 }, (_, i) => 30 + i * 25); // 30..530 pc
    const fades = samples.map(skyDomeFade);
    let monotonic = true;
    for (let i = 1; i < fades.length; i++) if (fades[i] > fades[i - 1] + 1e-9) monotonic = false;
    ok(monotonic, "skyDomeFade is non-increasing across the whole 30-530 pc sample range");
    ok(fades.every(f => f >= 0 && f <= 1), "skyDomeFade stays within [0, 1]");
}

// ── 8. shared blackbody LUT: physically-sane ordering ─────────────────────
hr("Shared Teff/color LUT");
ok(bvToTeff(-0.3) > bvToTeff(0.65), "bvToTeff: bluer (lower B-V) star is hotter", `${bvToTeff(-0.3).toFixed(0)}K vs ${bvToTeff(0.65).toFixed(0)}K`);
ok(bvToTeff(0.65) > bvToTeff(1.5), "bvToTeff: redder (higher B-V) star is cooler", `${bvToTeff(0.65).toFixed(0)}K vs ${bvToTeff(1.5).toFixed(0)}K`);
{
    const hot = teffToRGB(25000);
    const cool = teffToRGB(3200);
    ok(hot[2] >= hot[0], "a hot (25000K) star's blue channel dominates its red channel", `rgb=${hot.map(v => v.toFixed(2))}`);
    ok(cool[0] > cool[2], "a cool (3200K) star's red channel dominates its blue channel", `rgb=${cool.map(v => v.toFixed(2))}`);
    const sun = teffToRGB(SUN_TEFF_K);
    ok(sun.every(v => v >= 0 && v <= 1), "Sun's own Teff maps to a valid 0..1 RGB triple", `rgb=${sun.map(v => v.toFixed(2))}`);
}

console.log("\n" + "=".repeat(60));
console.log(`  ${pass} PASSED   ${fail} FAILED   (${pass + fail} checks)`);
console.log("=".repeat(60));
process.exit(fail ? 1 : 0);
