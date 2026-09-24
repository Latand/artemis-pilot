// Milky Way - Andromeda tidal debris (universe/mergerTides.js): disk
// orientations, disk equilibrium before the encounter, outside-in stripping
// at first passage, a bound remnant after coalescence, exact light
// bookkeeping between the smooth models and the debris, determinism.
// Pure Node (no browser).
import { simulateMergerTides, milkyWayDiskFrame, andromedaDiskFrame, keepAt, keepAtRadius, TIDES, MW_BIN_COUNT, MW_LIGHT, MW_DISK_OF_TOTAL, sampleParticles } from "../src/universe/mergerTides.js";
import { mergerDebugState } from "../src/universe/localGroupOrbit.js";
import { galacticToWorld, raDecToWorldUnitInto } from "../src/universe/coords.js";

let failed = 0;
function check(ok, msg, ctx) {
    console.log((ok ? "ok   " : "FAIL ") + msg + (ctx !== undefined ? "  " + JSON.stringify(ctx) : ""));
    if (!ok) failed++;
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const DEG = 180 / Math.PI;

// --- orbit timeline (consistent Hernquist forces) ------------------------------
const dbg = mergerDebugState();
check(dbg.firstPassageGyr > 3.7 && dbg.firstPassageGyr < 4.5, "first pericentre ~4 Gyr from now", dbg.firstPassageGyr);
check(dbg.mergedGyr > 5.5 && dbg.mergedGyr < 9.5, "captured under 50 kpc by ~6-9 Gyr", dbg.mergedGyr);

// --- disk orientations ----------------------------------------------------------
const mw = milkyWayDiskFrame();
const yGal = galacticToWorld([0, 1, 0]), zGal = galacticToWorld([0, 0, 1]);
check(dot(mw.e2, yGal) > 0.999, "Milky Way: rotation at the Sun toward l = 90 deg", dot(mw.e2, yGal));
check(dot(mw.n, zGal) < -0.999, "Milky Way: spin toward the south Galactic pole (clockwise from the NGP)", dot(mw.n, zGal));
const m31 = andromedaDiskFrame();
const los = [0, 0, 0];
raDecToWorldUnitInto(TIDES.m31.ra, TIDES.m31.dec, los);
const incl = Math.acos(Math.abs(dot(m31.n, los))) * DEG;
check(Math.abs(incl - TIDES.m31.inclDeg) < 0.01, "Andromeda: inclination 77 deg", incl);
// velocity of the south-west major-axis half (-e1): v ~ n x (-e1) = -e2
const vSW = [-m31.e2[0], -m31.e2[1], -m31.e2[2]];
check(dot(vSW, los) < 0, "Andromeda: south-west half approaching", dot(vSW, los));
// near side NW: the in-plane minor axis toward NW points toward us (negative los)
const a = [0, 0, 0], b = [0, 0, 0];
raDecToWorldUnitInto(TIDES.m31.ra, TIDES.m31.dec + 1e-3, a); raDecToWorldUnitInto(TIDES.m31.ra, TIDES.m31.dec - 1e-3, b);
const eN = [a[0] - b[0], a[1] - b[1], a[2] - b[2]].map(v => v / 2e-3 * DEG);
// the in-plane direction whose sky projection points north-west
const pa = TIDES.m31.paDeg / DEG;
raDecToWorldUnitInto(TIDES.m31.ra + 1e-3, TIDES.m31.dec, a); raDecToWorldUnitInto(TIDES.m31.ra - 1e-3, TIDES.m31.dec, b);
let eE = [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; const lE = Math.hypot(...eE); eE = eE.map(v => v / lE);
const lN = Math.hypot(...eN); const eNn = eN.map(v => v / lN);
const nwSky = [0, 1, 2].map(i => Math.sin(pa) * eNn[i] - Math.cos(pa) * eE[i]);
// in-plane vector perpendicular to the major axis, oriented so its sky part points NW
let minor = m31.e2.slice();
if (dot(minor, nwSky) < 0) minor = minor.map(v => -v);
check(dot(minor, los) < 0, "Andromeda: north-west side is the near side", dot(minor, los));

// --- simulation -----------------------------------------------------------------
const t0 = Date.now();
const N1 = 400;
const m = simulateMergerTides({ nPerGalaxy: N1, debug: true });
const ms = Date.now() - t0;
check(m.n === 2 * N1 && m.times.length > 100, "keyframes produced", { n: m.n, keys: m.times.length, ms });
const kIdx = t => m.times.findIndex(x => x >= t - 1e-9);
const first = keepAt(m, m.times[0], m.times[0]);
check(first.mwTotal > 0.97 && first.m31 > 0.97, "disks intact (equilibrium) before the encounter", { mw: first.mwTotal, m31: first.m31, t: m.times[0] });
const after = keepAt(m, 4.8, 4.8);
const inner = (after.mwBins[0] + after.mwBins[1] + after.mwBins[2]) / 3, outer = (after.mwBins[5] + after.mwBins[6] + after.mwBins[7]) / 3;
check(after.mwTotal > 0.35 && after.mwTotal < 0.97, "first passage strips part of the Milky Way disk", after.mwTotal);
check(inner > outer + 0.3, "stripping works outside-in", { inner, outer, bins: Array.from(after.mwBins, v => +v.toFixed(2)) });
const last = keepAt(m, m.times[m.times.length - 1], m.times[m.times.length - 1]);
check(last.mwTotal < 0.1 && last.m31 < 0.1, "after coalescence the disks are debris", { mw: last.mwTotal, m31: last.m31 });

// remnant: bound and concentrated around the merged centre
{
    const { x, v, cMW, cM31, gmMW, gmM31 } = m.debug;
    const f = 1.5 / 2.8;
    const bc = [0, 1, 2].map(i => (1 - f) * cMW[i] + f * cM31[i]);
    const rs = []; let unbound = 0;
    for (let p = 0; p < m.n; p++) {
        const r = Math.hypot(x[p * 3] - bc[0], x[p * 3 + 1] - bc[1], x[p * 3 + 2] - bc[2]);
        const d1 = Math.hypot(x[p * 3] - cMW[0], x[p * 3 + 1] - cMW[1], x[p * 3 + 2] - cMW[2]);
        const d2 = Math.hypot(x[p * 3] - cM31[0], x[p * 3 + 1] - cM31[1], x[p * 3 + 2] - cM31[2]);
        const e = 0.5 * (v[p * 3] ** 2 + v[p * 3 + 1] ** 2 + v[p * 3 + 2] ** 2) - gmMW / (d1 + TIDES.aMWKpc) - gmM31 / (d2 + TIDES.aM31Kpc);
        if (e > 0) unbound++;
        rs.push(r);
    }
    rs.sort((p, q) => p - q);
    const med = rs[rs.length >> 1], p90 = rs[Math.floor(rs.length * 0.9)];
    check(unbound <= m.n * 0.02, "remnant debris is bound", { unbound });
    check(med > 5 && med < 80 && p90 < 300, "remnant is concentrated (restricted N-body envelope)", { medianKpc: +med.toFixed(1), p90Kpc: +p90.toFixed(1) });
}

// light bookkeeping: smooth-model keep + debris weights = 1, weights monotone
{
    let maxErr = 0, nonMono = 0;
    for (let k = 0; k < m.times.length; k++) {
        let s = 0;
        for (let p = 0; p < N1; p++) {
            s += m.w[k * m.n + p] / 255;
            if (k > 0 && m.w[k * m.n + p] < m.w[(k - 1) * m.n + p]) nonMono++;
        }
        maxErr = Math.max(maxErr, Math.abs(1 - s / N1 - m.keepMWTotal[k]));
    }
    check(maxErr < 3e-3, "Milky Way light: keep + debris = 1 at every keyframe", maxErr);
    check(nonMono === 0, "a disturbed particle stays disturbed", nonMono);
    let inRange = true;
    for (const v of m.keepMW) if (!(v >= 0 && v <= 1)) inRange = false;
    check(inRange, "bin keep factors in [0, 1]");
    check(Math.abs(MW_DISK_OF_TOTAL + MW_LIGHT.halo + MW_LIGHT.bar - 1) < 1e-3, "Milky Way light shares sum to 1", MW_DISK_OF_TOTAL + MW_LIGHT.halo + MW_LIGHT.bar);
}
// keep at radius: piecewise linear, bounded
{
    const bins = Float32Array.from([1, 0.9, 0.8, 0.5, 0.2, 0.1, 0.05, 0]);
    const v0 = keepAtRadius(bins, TIDES.mwBinEdgesKpc, 0), v8 = keepAtRadius(bins, TIDES.mwBinEdgesKpc, 8), v30 = keepAtRadius(bins, TIDES.mwBinEdgesKpc, 30);
    check(v0 === 1 && Math.abs(v8 - 0.5) < 1e-6 && v30 === 0, "keepAtRadius interpolates bin centres", { v0, v8, v30 });
}
// sampling: before the first keyframe nothing is drawn
{
    const pos = new Float32Array(m.n * 3), ws = new Float32Array(m.n * 2);
    const drawn = sampleParticles(m, 1.0, 0, m.n, pos, ws);
    check(!drawn && ws.every((v, i) => i % 2 === 1 || v === 0), "no debris before the encounter");
    sampleParticles(m, 4.8, 0, m.n, pos, ws);
    check(pos.every(Number.isFinite) && ws.some((v, i) => i % 2 === 0 && v > 0.5), "debris sampled after first passage");
}
// determinism
{
    const m2 = simulateMergerTides({ nPerGalaxy: N1 });
    let same = m2.pos.length === m.pos.length;
    for (let i = 0; same && i < m.pos.length; i++) if (m.pos[i] !== m2.pos[i]) same = false;
    check(same, "simulation is deterministic");
}

if (failed) { console.error(`merger tides smoke: ${failed} check(s) failed`); process.exit(1); }
console.log("merger tides smoke passed");
