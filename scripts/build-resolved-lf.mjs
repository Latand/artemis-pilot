// Tabulates the V-band luminosity function of the procedural Milky Way
// population (galaxy.js, the "scientific" 100-pc tier) for the resolved star
// field and the resolved/unresolved light handoff, and writes
// src/universe/resolvedLF.js.
//
// For each population component (young: age < YOUNG_AGE_GYR; old: everything
// else) and each 0.5-mag bin of absolute V magnitude it records:
//   nu    - stars per solar V luminosity of that component's light, so the
//           number density of bin b at x is j_c(x) * nu_c[b], with j_c the
//           component's V-band light density from galaxyModel.js (the same
//           density the volumetric Milky Way integrates);
//   teff  - a deterministic sample of effective temperatures of real
//           generator stars in the bin (keeps dwarf/giant bimodality);
//   cls   - their spectral classes (for the catalog-completeness handoff).
// It also writes the fraction of the V light carried by stars fainter than
// M_V = -8 .. +12, which galaxyModel.js uses for the unresolved share, and
// the local V-band luminosity density of the sampled cells (the model's
// normalization at the Sun). Everything is V band, like the point-star
// layers, so the diffuse light and the stars it hands over to add up in the
// same band.
//
// Run: node scripts/build-resolved-lf.mjs   (~1 minute)
import { writeFileSync } from "node:fs";
import { starsInCell, CELL_PC } from "../src/universe/galaxy.js";
import { SUN_GAL } from "../src/universe/coords.js";
import { absMagVFromL } from "../src/render/viewBrightness.js";
import { YOUNG_AGE_GYR } from "../src/universe/astroConstants.js";
import { synthStar, sampleIMFMass } from "../src/universe/stellar.js";
import { makeRNG } from "../src/universe/prng.js";

const M_MIN = -11, M_STEP = 0.5, NBIN = 60;          // M_V -11 .. +19
const SAMPLES = 16;
const CLS = "OBAFGKMLTY";

const ci0 = Math.floor(SUN_GAL[0] / CELL_PC), cj0 = Math.floor(SUN_GAL[1] / CELL_PC);
const cells = [];
for (let i = ci0 - 2; i <= ci0 + 3; i++) for (let j = cj0 - 3; j <= cj0 + 2; j++) for (const k of [-1, 0]) cells.push([i, j, k]);

const comps = ["young", "old"];
const acc = Object.fromEntries(comps.map(c => [c, {
    n: new Float64Array(NBIN), L: 0, LBol: 0, count: 0, lightByBin: new Float64Array(NBIN),
    samples: Array.from({ length: NBIN }, () => []), seen: new Float64Array(NBIN),
    ages: [],
}]));
let total = 0, t0 = Date.now();
// Deterministic reservoir sampling (xorshift).
let rs = 0x9e3779b9;
const rnd = () => { rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; return (rs >>> 0) / 4294967296; };

for (const [i, j, k] of cells) {
    for (const s of starsInCell(i, j, k)) {
        const c = acc[s.age < YOUNG_AGE_GYR ? "young" : "old"];
        c.count++;                                    // every IMF draw, remnants included
        if (c.ages.length < 200000) c.ages.push(s.age);
        if (!(s.L > 0) || !(s.Teff > 0)) continue;   // NS/BH: no optical light
        const M = absMagVFromL(s.L, s.Teff);
        const b = Math.floor((M - M_MIN) / M_STEP);
        const LV = Math.pow(10, -0.4 * (M - 4.83));
        c.L += LV;
        c.LBol += s.L;
        total++;
        if (b < 0 || b >= NBIN) continue;
        c.n[b]++;
        c.lightByBin[b] += LV;
        const cls = CLS.indexOf(String(s.cls || "G")[0]);
        const rec = [Math.round(s.Teff), cls < 0 ? 4 : cls, s.kind === "giant" ? 1 : 0];
        c.seen[b]++;
        if (c.samples[b].length < SAMPLES) c.samples[b].push(rec);
        else { const r = Math.floor(rnd() * c.seen[b]); if (r < SAMPLES) c.samples[b][r] = rec; }
    }
}
const Ltot = acc.young.L + acc.old.L;
const cellsVol = cells.length * CELL_PC * CELL_PC * CELL_PC;
const jV = Ltot / cellsVol;
console.log(`${total} stars in ${cells.length} cells, ${((Date.now() - t0) / 1000).toFixed(1)} s; young V-light share ${(acc.young.L / Ltot).toFixed(3)}; j_V ${jV.toFixed(4)} Lsun/pc^3 (bolometric ${((acc.young.LBol + acc.old.LBol) / cellsVol).toFixed(4)})`);

// The luminous tail (O/B stars, bright giants) is too rare for the cell
// sample, so it is tabulated by Monte Carlo through the same IMF and stellar
// physics (stellar.js), with ages drawn from each component's own age
// distribution in the cell sample, and normalized per IMF draw: the cells hold
// c.count draws per c.L of light.
const tail = {};
for (const [name, draws, mCut] of [["young", 4e7, 1.4], ["old", 2e7, 0.75]]) {
    const c = acc[name];
    const rng = makeRNG(name === "young" ? 0x5eed01 : 0x5eed02);
    const h = new Float64Array(NBIN);
    for (let n = 0; n < draws; n++) {
        const m = sampleIMFMass(rng);
        if (m < mCut) continue;
        const age = c.ages[Math.floor(rng() * c.ages.length)];
        const s = synthStar(rng, m, age, 0);
        if (!(s.L > 0) || !(s.Teff > 0) || s.kind === "WD") continue;
        const b = Math.floor((absMagVFromL(s.L, s.Teff) - M_MIN) / M_STEP);
        if (b >= 0 && b < NBIN) h[b]++;
    }
    tail[name] = { h, draws };
}
// Per bin: the cell sample where it is rich (>= 200 stars), else the tail MC.
for (const name of comps) {
    const c = acc[name], t = tail[name];
    const drawsPerL = c.count / c.L;
    c.nu = Array.from(c.n, (n, b) => n >= 200 || t.h[b] === 0 ? n / c.L : t.h[b] / t.draws * drawsPerL);
}

// Fraction of each component's V light carried by stars fainter than
// M_V = -8..+12, from the (tail-corrected) number table: light of bin b per
// unit component light = nu[b] * <L_V>_b.
const faintOf = name => {
    const c = acc[name];
    const lightBin = c.nu.map((nu, b) => {
        const Mc = M_MIN + (b + 0.5) * M_STEP;
        return c.n[b] > 0 ? nu * c.lightByBin[b] / c.n[b] : nu * Math.pow(10, -0.4 * (Mc - 4.83));
    });
    const tot = lightBin.reduce((a, v) => a + v, 0);
    const out = [];
    for (let M = -8; M <= 12; M++) {
        let f = 0;
        for (let b = 0; b < NBIN; b++) {
            const lo = M_MIN + b * M_STEP, hi = lo + M_STEP;
            const w = hi <= M ? 0 : lo >= M ? 1 : (hi - M) / M_STEP;
            f += lightBin[b] * w;
        }
        out.push(+(f / tot).toFixed(4));
    }
    return out;
};
const faintYoung = faintOf("young"), faintOld = faintOf("old");
const faint = faintYoung.map((v, i) => +((v * acc.young.L + faintOld[i] * acc.old.L) / Ltot).toFixed(4));

const fmt = a => "[" + Array.from(a, v => v === 0 ? "0" : v.toPrecision(4)).join(", ") + "]";
const out = `// GENERATED by scripts/build-resolved-lf.mjs -- do not edit by hand.
// V-band luminosity function of the procedural Milky Way population
// (galaxy.js starsInCell, ${cells.length} cells of ${CELL_PC} pc around the Sun, ${total} luminous
// stars). Absolute V magnitudes from L and Teff through BC_V(Teff)
// (viewBrightness.js). Provenance: derived from the model population, whose
// IMF, ages and stellar physics are cited in galaxy.js / stellar.js.
export const LF_M_MIN = ${M_MIN};
export const LF_M_STEP = ${M_STEP};
export const LF_NBIN = ${NBIN};
// Stars per solar V luminosity of the component's light, per bin.
// Luminous tail (cell bins with < 200 stars) from a Monte Carlo of the same
// IMF + stellar.js physics, normalized per IMF draw.
export const LF_NU = {
    young: ${fmt(acc.young.nu)},
    old: ${fmt(acc.old.nu)},
};
// Per bin: up to ${SAMPLES} [Teff K, spectral class index in "${CLS}", giant?] samples.
export const LF_SAMPLES = {
    young: ${JSON.stringify(acc.young.samples)},
    old: ${JSON.stringify(acc.old.samples)},
};
export const LF_CLASSES = "${CLS}";
// Fraction of each component's V light carried by stars fainter than
// M_V = -8, -7, ..., +12, and of the local mixture.
export const FAINT_LIGHT_V_YOUNG = Object.freeze(${JSON.stringify(faintYoung)});
export const FAINT_LIGHT_V_OLD = Object.freeze(${JSON.stringify(faintOld)});
export const FAINT_LIGHT_V = Object.freeze(${JSON.stringify(faint)});
// Young share of the local V light in the sampled cells (galaxyModel MW.fYoung).
export const LF_YOUNG_LIGHT_SHARE = ${(acc.young.L / Ltot).toFixed(4)};
// Local V-band luminosity density of the sampled cells (|z| < 100 pc),
// Lsun/pc^3 (galaxyModel MW.jSun). Measured: 0.053-0.056 (Flynn et al.
// 2006; Just et al. 2015).
export const LF_J_V_SUN = ${jV.toFixed(4)};
`;
writeFileSync(new URL("../src/universe/resolvedLF.js", import.meta.url), out);
console.log("faint young:", faintYoung.join(" "));
console.log("faint old:  ", faintOld.join(" "));
console.log("faint mix:  ", faint.join(" "));
for (const name of comps) console.log(name, "nu:", acc[name].nu.map((v, b) => (M_MIN + b * M_STEP) + ":" + v.toPrecision(2)).filter((_, b) => acc[name].nu[b] > 0).join(" "));
console.log("wrote src/universe/resolvedLF.js");
