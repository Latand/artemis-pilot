// Headless verification of the procedural Milky Way generator:
//   - determinism (same cell → identical stars, even across cache clears)
//   - the Galactic-centre direction maps onto Sgr A* (frame/rotation correctness)
//   - local stellar number density ≈ 0.14 stars/pc³ near the Sun
//   - a realistic IMF population (M-dwarf dominated, O/B vanishingly rare)
//   - vertical disc falloff and spiral-arm overdensity
//   - Eker-2018 main-sequence sanity (Sun-like, M-dwarf, B-star)
//
// Run: node scripts/smoke-universe.mjs   (or: bun scripts/smoke-universe.mjs)

const { starsInCell, sampleStarsNear, densityAt, clearCache, CELL_PC, N_SUN_PC3 } =
    await import("../src/universe/galaxy.js");
const { galToEquatorialKm, SUN_GAL, R0_PC } = await import("../src/universe/coords.js");
const { deriveStar } = await import("../src/universe/stellar.js");

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
    if (cond) { pass++; console.log(`  PASS  ${label}${detail ? "   " + detail : ""}`); }
    else { fail++; console.log(`  FAIL  ${label}${detail ? "   " + detail : ""}`); }
};
const hr = (t) => console.log("\n" + "─".repeat(60) + "\n  " + t + "\n" + "─".repeat(60));

// ── 1. Determinism ────────────────────────────────────────────────────────
hr("Determinism");
const a = starsInCell(82, 0, 0);
clearCache();
const b = starsInCell(82, 0, 0);
let identical = a.length === b.length;
for (let i = 0; identical && i < a.length; i += Math.max(1, (a.length / 50) | 0)) {
    if (a[i].mass !== b[i].mass || a[i].x !== b[i].x || a[i].id !== b[i].id) identical = false;
}
ok(identical, "cell (82,0,0) reproduces exactly across a cache clear", `n=${a.length}`);
const far = starsInCell(82, 0, 0);
ok(far === a || (far.length === a.length), "re-query returns the same set", `n=${far.length}`);

// ── 2. Frame correctness: GC direction → Sgr A* ───────────────────────────
hr("Frame: Galactic centre maps to Sgr A*");
{
    const [x, y, z] = galToEquatorialKm(0, 0, 0); // GC seen from the Sun
    const r = Math.hypot(x, y, z);
    const ra = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
    const dec = Math.asin(z / r) * 180 / Math.PI;
    ok(Math.abs(ra - 266.4168) < 2.5, "RA of Galactic centre ≈ Sgr A*", `got ${ra.toFixed(2)}° exp 266.42°`);
    ok(Math.abs(dec - (-29.0078)) < 2.5, "Dec of Galactic centre ≈ Sgr A*", `got ${dec.toFixed(2)}° exp -29.01°`);
}

// ── 3. Local number density near the Sun ──────────────────────────────────
hr("Local stellar number density near the Sun");
{
    // Use a single ~100 pc cell straddling the Sun's neighbourhood.
    const sunCell = starsInCell(82, 0, 0); // centre ≈ (8250, 50, 50) pc, near R0
    const density = sunCell.length / (CELL_PC ** 3);
    ok(density > 0.07 && density < 0.30, "density ≈ 0.14 stars/pc³",
        `got ${density.toFixed(3)} (model base ${N_SUN_PC3})`);

    // ── 4. IMF population realism (large in-cell sample) ──────────────────
    const n = sunCell.length;
    let mDwarf = 0, ob = 0, sumM = 0;
    for (const s of sunCell) {
        if (s.cls === "M") mDwarf++;
        if (s.cls === "O" || s.cls === "B") ob++;
        sumM += s.mass;
    }
    const mFrac = mDwarf / n, obFrac = ob / n, meanM = sumM / n;
    hr("IMF population realism (sample n=" + n + ")");
    ok(mFrac > 0.60 && mFrac < 0.88, "M dwarfs dominate (~73%)", `got ${(mFrac * 100).toFixed(1)}%`);
    ok(obFrac < 0.02, "O+B stars are rare (<2%)", `got ${(obFrac * 100).toFixed(3)}%`);
    ok(meanM > 0.2 && meanM < 0.7, "mean stellar mass sub-solar", `got ${meanM.toFixed(3)} M⊙`);
}

// ── 5. Vertical disc structure ────────────────────────────────────────────
hr("Disc structure: vertical falloff & spiral arms");
{
    const mid = densityAt(R0_PC, 0, 0);
    const hi = densityAt(R0_PC, 0, 300);
    const ratio = mid / hi;
    ok(ratio > 1.8 && ratio < 3.4, "density drops with height (thin-disc scale ~300 pc)",
        `ρ(0)/ρ(300pc) = ${ratio.toFixed(2)}`);

    // Spiral arm: compare a point on an arm vs interarm at the same radius.
    const R = 8000, TAN = Math.tan(12.8 * Math.PI / 180);
    const base = Math.log(R / 3000) / TAN;          // arm-0 crossing angle at R
    const onArm = densityAt(R * Math.cos(base), R * Math.sin(base), 0);
    const off = densityAt(R * Math.cos(base + Math.PI / 4), R * Math.sin(base + Math.PI / 4), 0);
    ok(onArm > off * 1.15, "spiral arm is denser than interarm", `arm/interarm = ${(onArm / off).toFixed(2)}`);
}

// ── 6. Eker 2018 main-sequence sanity ─────────────────────────────────────
hr("Eker 2018 derived properties");
{
    const sun = deriveStar(1.0);
    ok(sun.L > 0.85 && sun.L < 1.15 && sun.R > 0.85 && sun.R < 1.15 && sun.cls === "G",
        "1 M⊙ → Sun-like", `L=${sun.L.toFixed(2)} R=${sun.R.toFixed(2)} T=${sun.Teff | 0}K ${sun.cls}`);
    const m = deriveStar(0.2);
    ok(m.cls === "M" && m.L < 0.02 && m.R < 0.4, "0.2 M⊙ → red dwarf",
        `L=${m.L.toFixed(4)} R=${m.R.toFixed(2)} T=${m.Teff | 0}K ${m.cls}`);
    const b = deriveStar(10);
    ok((b.cls === "B" || b.cls === "O") && b.L > 1000, "10 M⊙ → hot luminous B star",
        `L=${b.L | 0} R=${b.R.toFixed(1)} T=${b.Teff | 0}K ${b.cls}`);
}

console.log("\n" + "=".repeat(60));
console.log(`  ${pass} PASSED   ${fail} FAILED   (${pass + fail} checks)`);
console.log("=".repeat(60));
process.exit(fail ? 1 : 0);
