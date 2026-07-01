// F7 validation (WP8 carry-forward from the Wave-2 review): the player-facing
// local tier was previously unvalidated for TOTAL stellar density. This smoke
// sums local-procedural stars (localStarsInCell/sampleLocalStarsNear, which
// already apply catalog-completeness thinning — see galaxy.js's module header)
// with real tier-0 catalog stars (hygActiveCatalog.js) across the 25-100 pc
// shell where M-dwarf catalog completeness fades, and asserts the combined
// density lands within an honest tolerance of the CNS5 census (~0.08-0.10/pc³
// per validate-astro.mjs checks 1/1b) — [0.06, 0.13] to allow for the
// completeness-curve hand-off between the two tiers.
//
// Run: node scripts/smoke-local-tier.mjs   (or: bun scripts/smoke-local-tier.mjs)

import { readFileSync } from "node:fs";

globalThis.window = {};

const { localStarsInCell, LOCAL_CELL_PC, setSeed } = await import("../src/universe/galaxy.js");
const { SUN_GAL, PC_KM } = await import("../src/universe/coords.js");
const { registerHygCatalog, sampleHygStarsNear, hygCatalogStats } = await import("../src/universe/hygActiveCatalog.js");

function assert(ok, message) {
    if (!ok) throw new Error("FAIL: " + message);
    console.log("  PASS  " + message);
}

// --- bootstrap: load the real HYG v4.1 tier-0 binary, same as smoke-catalog.mjs ---
const meta = JSON.parse(readFileSync(new URL("../public/data/hyg-stars-v41.json", import.meta.url), "utf8"));
const bin = readFileSync(new URL("../public/data/hyg-stars-v41.bin", import.meta.url));
const vals = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
assert(registerHygCatalog(meta, vals), "HYG v4.1 catalog registers for the density census");
assert(hygCatalogStats().indexReady, "HYG catalog spatial index is ready");

setSeed(0x9e3779b9 >>> 0); // the module default seed — same universe every run of this smoke

// --- shell bookkeeping ---
const RADIUS_PC = 100;
const INNER_PC = 25; // below this, catalog is presumed complete and procedural M-dwarfs are thinned toward 0 by design (galaxy.js completeness())
const SHELLS = [[25, 50], [50, 75], [75, 100]];
const shellVolumePc3 = (lo, hi) => (4 / 3) * Math.PI * (hi ** 3 - lo ** 3);
const shellIndexFor = d => SHELLS.findIndex(([lo, hi]) => d >= lo && d < hi);

// --- 1. local-procedural side: iterate every 4 pc cell within the 100 pc box ---
// (localStarsInCell already applies completeness thinning + brown-dwarf
// seeding — see galaxy.js's module header. Brown dwarfs are sub-stellar and
// excluded from this stellar-density census, matching validate-astro.mjs.)
const procCounts = [0, 0, 0];
const ciLo = Math.floor((SUN_GAL[0] - RADIUS_PC) / LOCAL_CELL_PC), ciHi = Math.floor((SUN_GAL[0] + RADIUS_PC) / LOCAL_CELL_PC);
const cjLo = Math.floor((SUN_GAL[1] - RADIUS_PC) / LOCAL_CELL_PC), cjHi = Math.floor((SUN_GAL[1] + RADIUS_PC) / LOCAL_CELL_PC);
const ckLo = Math.floor((SUN_GAL[2] - RADIUS_PC) / LOCAL_CELL_PC), ckHi = Math.floor((SUN_GAL[2] + RADIUS_PC) / LOCAL_CELL_PC);
let cellsVisited = 0;
for (let ci = ciLo; ci <= ciHi; ci++)
    for (let cj = cjLo; cj <= cjHi; cj++)
        for (let ck = ckLo; ck <= ckHi; ck++) {
            cellsVisited++;
            for (const st of localStarsInCell(ci, cj, ck)) {
                if (st.kind === "BD") continue; // sub-stellar, excluded from the stellar density census
                const d = Math.hypot(st.gx - SUN_GAL[0], st.gy - SUN_GAL[1], st.gz - SUN_GAL[2]);
                if (d < INNER_PC || d >= RADIUS_PC) continue;
                const idx = shellIndexFor(d);
                if (idx >= 0) procCounts[idx]++;
            }
        }
assert(cellsVisited > 100000, `local-procedural census scans the full 100 pc box (cells=${cellsVisited})`);

// --- 2. tier-0 catalog side: real HYG rows within the same 100 pc, Sol-centred ---
const catalogStars = sampleHygStarsNear(0, 0, 0, RADIUS_PC, 2_000_000, 0);
assert(catalogStars.length < 2_000_000, "catalog sampler was not truncated by its oversized limit");
const catCounts = [0, 0, 0];
for (const st of catalogStars) {
    const d = Math.hypot(st.x, st.y, st.z) / PC_KM;
    if (d < INNER_PC || d >= RADIUS_PC) continue;
    const idx = shellIndexFor(d);
    if (idx >= 0) catCounts[idx]++;
}

// --- 3. per-shell breakdown + combined density ---
console.log("\n  shell breakdown (procedural / catalog / combined density):");
let totalCount = 0, totalVol = 0;
for (let i = 0; i < SHELLS.length; i++) {
    const [lo, hi] = SHELLS[i];
    const vol = shellVolumePc3(lo, hi);
    const count = procCounts[i] + catCounts[i];
    totalCount += count;
    totalVol += vol;
    console.log(
        `    ${lo}-${hi} pc: procedural=${procCounts[i]}  catalog=${catCounts[i]}  ` +
        `combined=${count}  density=${(count / vol).toFixed(4)}/pc³`,
    );
}
const overallDensity = totalCount / totalVol;
console.log(`  overall 25-100 pc density: ${overallDensity.toFixed(4)} stars/pc³ (n=${totalCount}, volume=${totalVol.toFixed(0)} pc³)\n`);

assert(procCounts.every(c => c > 0), "every shell contributes procedural stars");
assert(catCounts.every(c => c > 0), "every shell contributes tier-0 catalog stars");
assert(
    overallDensity >= 0.06 && overallDensity <= 0.13,
    `combined 25-100 pc stellar density is within [0.06, 0.13]/pc³ (census 0.08-0.10, honest tolerance for the completeness hand-off) — got ${overallDensity.toFixed(4)}`,
);

// --- 4. per-shell density bands ---------------------------------------------
// The aggregate 25-100 pc check above can pass even if one shell is wildly
// off and another compensates for it — e.g. all the density concentrated in
// the innermost shell would still average into [0.06, 0.13] while the outer
// shells sit near zero. Each shell gets its own band so a regression in one
// completeness-curve segment can't hide behind the others.
//
// The 25-50 pc floor (0.045/pc³) is deliberately looser than the 50-100 pc
// bands' [0.06, 0.13]: 25-60 pc is exactly where real M-dwarf catalog
// completeness is worst (HYG under-counts the faintest, most numerous
// stars there) and this tier's procedural pool is only a partial substitute
// — the ACTIVE-pool M-dwarf density in that range is intentionally delegated
// to the tier-1 visual layer (AT-HYG background sky) rather than fully
// backfilled here; see the matching note in activeStars.js/hygActiveCatalog.js.
// A follow-up work package makes tier-1 queryable so this floor can be
// tightened once that delegation is actually load-bearing instead of visual.
const SHELL_BANDS = [
    { lo: 25, hi: 50, min: 0.045, max: 0.13 },
    { lo: 50, hi: 75, min: 0.06, max: 0.13 },
    { lo: 75, hi: 100, min: 0.06, max: 0.13 },
];
for (let i = 0; i < SHELLS.length; i++) {
    const [lo, hi] = SHELLS[i];
    const band = SHELL_BANDS[i];
    const vol = shellVolumePc3(lo, hi);
    const density = (procCounts[i] + catCounts[i]) / vol;
    assert(
        density >= band.min && density <= band.max,
        `${lo}-${hi} pc shell stellar density is within [${band.min}, ${band.max}]/pc³ — got ${density.toFixed(4)}`,
    );
}

console.log("local-tier density smoke passed");
