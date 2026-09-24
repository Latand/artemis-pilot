// Galaxy population + cosmological light cone (Node, no browser).
//
//   universe/cosmicExpansion.js: flat Lambda-CDM background, conformal time,
//     the observer's past light cone, redshift / angular / luminosity distance.
//   universe/galaxyPopulation.js: Milky Way + Local Volume + 2MRS (Finger-of-
//     God compressed) + zone-of-avoidance clones + faint completion + cosmic
//     web, one flux-limited selection, provenance per galaxy, bound units.
//   workers/galaxyPopulationWorker.js packPopulation: GC-relative chunks.
import { readFileSync } from "node:fs";
import { decodeLocalVolume, decode2mrs } from "../src/universe/galaxyCatalogs.js";
import {
    buildGalaxyPopulation, populationHash, PROV, lfDensityBrighter, selectionMK, friendsOfFriends, comovingFromCz, czFromComoving,
    makeWebField, MILKY_WAY, TWOMRS_KLIM,
} from "../src/universe/galaxyPopulation.js";
import {
    T0_GYR, scaleFactorAt, lnScaleFactorAt, cosmicTimeAtLnA, conformalTimeAtLnA, lnAAtConformalTime, lightConeView,
    eventHorizonComovingMpc, emissionLnA, buildLightConeTable, cosmicTimeGyr, COSMO, HUBBLE_DISTANCE_MPC,
} from "../src/universe/cosmicExpansion.js";
import { packPopulation } from "../src/workers/galaxyPopulationWorker.js";
import { evolutionAt, EVOLUTION_T, degenerateFactor, T_FORM_GYR } from "../src/universe/galaxyEvolution.js";
import { DARK_ENERGY } from "../src/constants.js";
import { W2G } from "../src/universe/coords.js";

let failures = 0;
function check(ok, msg, ctx) {
    if (ok) console.log("ok   " + msg);
    else { failures++; console.log("FAIL " + msg + (ctx !== undefined ? " " + JSON.stringify(ctx) : "")); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// --- Cosmology ------------------------------------------------------------------
check(COSMO.H0 === DARK_ENERGY.H0_KM_S_MPC && COSMO.OL === DARK_ENERGY.OMEGA_LAMBDA, "cosmology shares H0 / Omega_Lambda with constants.js");
check(near(T0_GYR, 13.79, 0.02), `age of the universe ${T0_GYR.toFixed(3)} Gyr (Planck 2018: 13.787)`);
check(near(scaleFactorAt(T0_GYR), 1, 1e-12), "a(t0) = 1");
check(near(cosmicTimeAtLnA(Math.log(0.5)), 5.86, 0.05), "a = 0.5 (z = 1) at ~5.9 Gyr");
for (const la of [-8, -2, 0, 3, 9, 13.5, 16]) {
    const back = lnAAtConformalTime(conformalTimeAtLnA(la));
    check(near(back, la, 1e-6 * Math.max(1, Math.abs(la))), `conformal time round-trip at ln a = ${la}`, { back });
}
{
    const eh = eventHorizonComovingMpc(0) * 3.2615637771674e-3;
    check(eh > 15.5 && eh < 17.5, `cosmic event horizon today ${eh.toFixed(2)} Gly comoving (~16-17)`);
}
{
    // low-z limit: z ~ H0 d / c, d_A ~ d_L ~ d
    const v = lightConeView(0, 10);
    check(near(v.z, COSMO.H0 * 10 / COSMO.cKms, 2e-5), `z(10 Mpc) = ${v.z.toExponential(4)} ~ H0 d / c`);
    check(near(v.dA, 10, 0.05) && near(v.dL, 10, 0.05), "d_A ~ d_L ~ d at 10 Mpc");
    // Etherington: d_L = (1+z)^2 d_A
    const w = lightConeView(0, 800);
    check(near(w.dL / w.dA, (1 + w.z) ** 2, 1e-9), "distance duality d_L = (1+z)^2 d_A");
    check(near(w.sbDim, (1 + w.z) ** -4, 1e-12), "surface-brightness dimming (1+z)^-4");
}
{
    // Causality: a farther observer sees an earlier emission epoch of the same source.
    let prev = Infinity, mono = true;
    for (const chi of [0, 1, 10, 100, 500, 1000, 2000]) {
        const t = cosmicTimeAtLnA(emissionLnA(0, chi));
        if (!(t <= prev)) mono = false;
        prev = t;
    }
    check(mono, "emission time decreases monotonically with the observer's distance");
    const tE = cosmicTimeAtLnA(emissionLnA(0, 306.6));   // 1 Gly
    check(near(T0_GYR - tE, 0.97, 0.05), `light from 1 Gly (comoving) left ~1 Gyr ago (${(T0_GYR - tE).toFixed(3)})`);
    // Far future: galaxies beyond the event horizon are seen infinitely redshifted.
    const late = lnScaleFactorAt(200);
    const v = lightConeView(late, 50);
    check(v.sbDim < 1e-8 && v.z > 100, "at 200 Gyr a galaxy 50 comoving Mpc away is redshifted out of sight", { z: v.z, sbDim: v.sbDim });
    check(Number.isFinite(lnScaleFactorAt(1e6)) && Number.isFinite(cosmicTimeGyr(1e30)), "deep-time scale factor stays finite");
    const tbl = buildLightConeTable(0, 2500, 64);
    check(tbl.table.every(x => Number.isFinite(x) && x <= 0), "light-cone table finite and non-positive");
}
check(near(comovingFromCz(czFromComoving(123.4)), 123.4, 1e-6), "cz <-> comoving distance round-trip");

// --- Stellar-population evolution ---------------------------------------------------
{
    let ok = true;
    for (const T of EVOLUTION_T) {
        const e = evolutionAt(T, T0_GYR);
        if (Math.abs(e.L - 1) > 0.01 || Math.abs(e.dBV) > 0.01) ok = false;
    }
    check(ok, "every type is at its catalogue luminosity and colour today");
    const e5 = [10, 30, 100, 1000, 10000].map(dt => evolutionAt(-5, T0_GYR + dt).L);
    check(e5.every((v, i) => i === 0 || v < e5[i - 1]), "passive ellipticals fade monotonically in the future", e5);
    check(evolutionAt(-5, T0_GYR + 100).L > 0.08 && evolutionAt(-5, T0_GYR + 100).L < 0.3, "an elliptical 100 Gyr on has faded ~2 mag (age^-0.8)");
    check(evolutionAt(-5, T0_GYR - 8).L > 1.5, "an elliptical 8 Gyr ago was brighter (younger stars)");
    check(evolutionAt(10, T0_GYR + 10).L > 1, "an irregular still forming stars brightens over the next 10 Gyr");
    check(evolutionAt(4, T0_GYR + 100).dBV > 0.2, "a spiral reddens once star formation dies away");
    check(evolutionAt(4, 0.5).L === 0 && T_FORM_GYR > 0.5, "no galaxy light before formation");
    check(evolutionAt(4, 1e6).L < 1e-12 && degenerateFactor(1e6) < 1e-5, "degenerate era: galaxies are dark by 10^15 yr");
}

// --- Population -------------------------------------------------------------------
const lv = decodeLocalVolume(readFileSync(new URL("../public/data/local-volume.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../public/data/2mrs-manifest.json", import.meta.url), "utf8"));
const mrs = decode2mrs(readFileSync(new URL("../public/data/2mrs.bin", import.meta.url)), manifest);
const t0 = performance.now();
const pop = buildGalaxyPopulation(lv, mrs);
const ms = performance.now() - t0;
console.log(`built ${pop.count} galaxies in ${ms.toFixed(0)} ms`, JSON.stringify(pop.stats));
check(pop.count > 150000 && pop.count < 600000, `population size ${pop.count}`);
check(ms < 8000, `build time ${ms.toFixed(0)} ms`);
const byProv = new Array(6).fill(0);
for (let i = 0; i < pop.count; i++) byProv[pop.prov[i]]++;
check(byProv[PROV.MILKY_WAY] === 1, "exactly one Milky Way entry");
const lvRows = lv.filter(g => g.distMpc > 0).length;
check(byProv[PROV.LV_MEASURED] >= lvRows - 10, `Local Volume galaxies kept (${byProv[PROV.LV_MEASURED]} of ${lvRows})`);
const dupCount = Array.from(mrs.lvIndex).filter(v => v >= 0).length;
check(byProv[PROV.REDSHIFT] + dupCount + pop.stats.dropped === mrs.count, "every 2MRS row is drawn once: redshift entry, or its Local Volume twin, or dropped (unconfirmed)", { redshift: byProv[PROV.REDSHIFT], dupCount, dropped: pop.stats.dropped, count: mrs.count });
check(pop.stats.dropped <= 8, `only the unconfirmed sub-250 km/s rows are dropped (${pop.stats.dropped})`);
check(byProv[PROV.ZOA_CLONE] > 1000 && byProv[PROV.COMPLETION] > 20000 && byProv[PROV.WEB] > 20000, "procedural parts present", byProv);
// Every value finite
let finite = true;
for (let i = 0; i < pop.count && finite; i++) {
    if (!Number.isFinite(pop.pos[i * 3] + pop.pos[i * 3 + 1] + pop.pos[i * 3 + 2] + pop.MV[i] + pop.hKpc[i] + pop.normal[i * 3])) finite = false;
}
check(finite, "positions, magnitudes, sizes, orientations finite");
let unitLen = true;
for (let i = 0; i < pop.count; i += 97) {
    const l = Math.hypot(pop.normal[i * 3], pop.normal[i * 3 + 1], pop.normal[i * 3 + 2]);
    if (Math.abs(l - 1) > 1e-4) unitLen = false;
}
check(unitLen, "symmetry axes are unit vectors");
// Milky Way entry: the volume's integrated luminosity, at the Galactic centre.
{
    const mw = pop.mwIndex;
    const d = Math.hypot(pop.pos[mw * 3], pop.pos[mw * 3 + 1], pop.pos[mw * 3 + 2]) * 1e6;
    check(near(d, 8178, 5), `Milky Way entry at the Galactic centre (${d.toFixed(0)} pc)`);
    check(near(pop.MV[mw], MILKY_WAY.MV, 1e-4), "Milky Way luminosity from the volumetric model");
}
// Andromeda: measured position and distance, bound to the Local Group.
{
    const i = pop.names.indexOf("Andromeda");
    const gi = Array.from(pop.name).indexOf(i);
    const d = Math.hypot(pop.pos[gi * 3], pop.pos[gi * 3 + 1], pop.pos[gi * 3 + 2]);
    check(gi >= 0 && near(d, 0.783, 0.005), `Andromeda at ${d.toFixed(3)} Mpc`);
    check(pop.unit[gi] === pop.localGroupUnit, "Andromeda belongs to the Local Group unit");
}
// Selection: procedural galaxies obey the flux limit, completion galaxies are fainter than 2MRS.
{
    let bad = 0, fainter = 0, n = 0;
    for (let i = 0; i < pop.count; i++) {
        const p = pop.prov[i];
        if (p !== PROV.COMPLETION && p !== PROV.WEB) continue;
        const d = Math.hypot(pop.pos[i * 3], pop.pos[i * 3 + 1], pop.pos[i * 3 + 2]);
        // completion companions are selected at their host's distance (<= 4.5 Mpc away)
        if (pop.MK[i] > selectionMK(p === PROV.COMPLETION ? Math.max(0.01, d - 5) : d) + 0.05) bad++;
        if (p === PROV.COMPLETION) {
            n++;
            // completion galaxies sit near their host; allow the host-offset slack
            if (pop.MK[i] > TWOMRS_KLIM - 25 - 5 * Math.log10(Math.max(d, 1)) - 1.5) fainter++;
        }
    }
    check(bad === 0, "procedural galaxies respect the selection M_fl(d)", { bad });
    check(fainter > 0.9 * n, "completion galaxies are fainter than the 2MRS limit at their distance", { fainter, n });
}
// Density continuity across the survey / web seam.
{
    const shell = (r0, r1) => {
        let c = 0;
        for (let i = 0; i < pop.count; i++) {
            const d = Math.hypot(pop.pos[i * 3], pop.pos[i * 3 + 1], pop.pos[i * 3 + 2]);
            if (d >= r0 && d < r1) c++;
        }
        const pred = (() => { let s = 0; const N = 50; for (let k = 0; k < N; k++) { const r = r0 + (r1 - r0) * (k + 0.5) / N; s += lfDensityBrighter(selectionMK(r)) * 4 * Math.PI * r * r * (r1 - r0) / N; } return s; })();
        return { c, pred, ratio: c / pred };
    };
    const a = shell(180, 230), b = shell(230, 270), c = shell(270, 320);
    console.log("seam shells", JSON.stringify({ a, b, c }));
    check(b.ratio > 0.6 * Math.min(a.ratio, c.ratio) && b.ratio < 1.6 * Math.max(a.ratio, c.ratio), "no density step at the survey/web seam");
    check(c.ratio > 0.8 && c.ratio < 1.25, "web density matches the luminosity function", c);
}
// Clustering: counts in cells are over-dispersed relative to Poisson in the survey and the web.
{
    const dispersion = (rMin, rMax, cell) => {
        const counts = new Map();
        for (let i = 0; i < pop.count; i++) {
            const x = pop.pos[i * 3], y = pop.pos[i * 3 + 1], z = pop.pos[i * 3 + 2];
            const d = Math.hypot(x, y, z);
            if (d < rMin || d > rMax) continue;
            const k = Math.floor(x / cell) + "," + Math.floor(y / cell) + "," + Math.floor(z / cell);
            counts.set(k, (counts.get(k) || 0) + 1);
        }
        // include empty cells inside the shell
        let n = 0, sum = 0, sum2 = 0;
        const half = Math.ceil(rMax / cell);
        for (let a = -half; a < half; a++) for (let b = -half; b < half; b++) for (let c = -half; c < half; c++) {
            const cx = (a + 0.5) * cell, cy = (b + 0.5) * cell, cz = (c + 0.5) * cell, d = Math.hypot(cx, cy, cz);
            if (d < rMin + cell || d > rMax - cell) continue;
            const v = counts.get(a + "," + b + "," + c) || 0;
            n++; sum += v; sum2 += v * v;
        }
        const mean = sum / n, varc = sum2 / n - mean * mean;
        return { mean, var: varc, ratio: varc / Math.max(mean, 1e-9) };
    };
    const s = dispersion(30, 120, 10), w = dispersion(360, 600, 40);
    console.log("counts in cells", JSON.stringify({ survey: s, web: w }));
    check(s.ratio > 3, "survey region is strongly clustered (variance/mean > 3)", s);
    check(w.ratio > 2, "cosmic web region is clustered (variance/mean > 2)", w);
}
// Finger-of-God compression: Virgo's line-of-sight spread shrinks toward its transverse size.
{
    const ra = 187.706 * Math.PI / 180, dec = 12.391 * Math.PI / 180;
    const eq = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
    const eps = 84381.406 / 3600 * Math.PI / 180;
    const u = [eq[0], Math.cos(eps) * eq[1] + Math.sin(eps) * eq[2], -Math.sin(eps) * eq[1] + Math.cos(eps) * eq[2]];
    let n = 0, m = 0, m2 = 0;
    for (let i = 0; i < pop.count; i++) {
        if (pop.prov[i] !== PROV.REDSHIFT) continue;
        const x = pop.pos[i * 3], y = pop.pos[i * 3 + 1], z = pop.pos[i * 3 + 2], d = Math.hypot(x, y, z);
        const cosT = (x * u[0] + y * u[1] + z * u[2]) / d;
        if (cosT < Math.cos(6 * Math.PI / 180) || d < 5 || d > 45) continue;
        n++; m += d; m2 += d * d;
    }
    const sd = Math.sqrt(m2 / n - (m / n) ** 2);
    check(n > 80, `Virgo members found (${n})`);
    check(sd < 6.5, `Virgo line-of-sight spread after compression ${sd.toFixed(2)} Mpc (raw redshift space ~10)`);
}
// Groups: FoF groups exist and the Local Group has the right members.
check(pop.stats.groups > 2000, `friends-of-friends groups ${pop.stats.groups}`);
{
    const lgMembers = Array.from(pop.unit).filter(u => u === pop.localGroupUnit).length;
    check(lgMembers > 40 && lgMembers < 150, `Local Group members ${lgMembers}`);
}
// Zone of avoidance: clones fill |b| < 5 deg.
{
    let inZoa = 0;
    for (let i = 0; i < pop.count; i++) {
        if (pop.prov[i] !== PROV.ZOA_CLONE) continue;
        const x = pop.pos[i * 3], y = pop.pos[i * 3 + 1], z = pop.pos[i * 3 + 2], d = Math.hypot(x, y, z);
        const gz = (W2G[2][0] * x + W2G[2][1] * y + W2G[2][2] * z) / d;
        if (Math.abs(Math.asin(gz)) < 8.01 * Math.PI / 180) inZoa++;
    }
    check(inZoa === byProv[PROV.ZOA_CLONE], "every clone lies inside the zone of avoidance");
}
// Friends-of-friends on a synthetic pair: linked when close, not when far.
{
    const ux = [1, Math.cos(0.001), 0], uy = [0, Math.sin(0.001), 1], uz = [0, 0, 0];
    const root = friendsOfFriends(ux, uy, uz, [1000, 1050, 1000]);
    check(root[0] === root[1] && root[2] !== root[0], "FoF links a close pair and not a distant galaxy");
}
// Web field: deterministic and structured.
{
    const w1 = makeWebField(7, 200), w2 = makeWebField(7, 200);
    let same = true, lo = 0, hi = 0;
    for (let k = 0; k < 2000; k++) {
        const x = (k * 37.1) % 300 - 150, y = (k * 53.7) % 300 - 150, z = (k * 71.3) % 300 - 150;
        const a = w1(x, y, z), b = w2(x, y, z);
        if (a !== b) same = false;
        if (a < 0.1) lo++; if (a > 0.5) hi++;
    }
    check(same, "web field deterministic");
    check(lo > 400 && hi > 50, "web field has voids and dense structure", { lo, hi });
}
// Determinism of the whole build.
{
    const again = buildGalaxyPopulation(lv, mrs);
    check(populationHash(again) === populationHash(pop), "population build is deterministic");
}
// Packing: GC-relative chunks conserve every galaxy; Local Group chunk first.
{
    const packed = packPopulation(pop);
    const total = packed.chunks.reduce((s, c) => s + c.count, 0);
    check(total === pop.count, "chunks hold every galaxy once");
    check(packed.chunks[0].lg && packed.chunks[0].count === Array.from(pop.unit).filter(u => u === pop.localGroupUnit).length, "first chunk is the Local Group");
    let ok = true;
    for (const c of packed.chunks) for (let k = 0; k < c.count; k++) {
        if (!Number.isFinite(c.unit[k * 3] + c.delta[k * 3] + c.phot[k * 4])) { ok = false; break; }
    }
    check(ok, "packed attributes finite");
}

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\ngalaxy population smoke passed");
