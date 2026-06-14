// Headless verification of the procedural Milky Way generator:
//   - determinism (same cell → identical stars, even across cache clears)
//   - the Galactic-centre direction maps onto Sgr A* (frame/rotation correctness)
//   - local stellar number density ≈ 0.14 stars/pc³ near the Sun
//   - a realistic IMF population (M-dwarf dominated, O/B vanishingly rare)
//   - vertical disc falloff and spiral-arm overdensity
//   - Eker-2018 main-sequence sanity (Sun-like, M-dwarf, B-star)
//
// Run: node scripts/smoke-universe.mjs   (or: bun scripts/smoke-universe.mjs)

globalThis.window = {};

const {
    starsInCell, sampleLocalStarsNear, localStarById, densityAt, clearCache, setSeed, getSeed,
    CELL_PC, LOCAL_CELL_PC, N_SUN_PC3,
} =
    await import("../src/universe/galaxy.js");
const { galToEquatorialKm, SUN_GAL, R0_PC } = await import("../src/universe/coords.js");
const { deriveStar } = await import("../src/universe/stellar.js");
const {
    ACTIVE_STAR_CONFIG, ACTIVE_STARS, activeStarForFocus, activeStarStats, proceduralFocusValue, refreshActiveStars,
    restorePinnedProceduralStars, serializePinnedProceduralStars,
} = await import("../src/universe/activeStars.js");
const { STARS, MU_E, MU_S, PC_KM, MPC_KM, DARK_ENERGY, DARK_MATTER } = await import("../src/constants.js");
const {
    darkEnergyAccelerationKmS2, darkEnergyVisibleFractionKm,
    darkMatterEnclosedMassSolar, darkMatterHaloAccelAtEquatorialKm, darkMatterLocalCircularSpeedKmS, darkMatterRelativeAccel,
} = await import("../src/cosmology.js");
const { STAR_DOMINANCE_MARGIN, strongestActiveStarWell } = await import("../src/universe/starDominance.js");
const { circularVelocityVector, orbitInfoMatchesTarget } = await import("../src/autopilot.js");

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
{
    const originalSeed = getSeed();
    setSeed(originalSeed ^ 0x5a5a5a5a);
    const seeded = starsInCell(82, 0, 0);
    let changed = seeded.length !== far.length;
    for (let i = 0; !changed && i < Math.min(seeded.length, far.length, 50); i++) {
        if (seeded[i].id !== far[i].id || seeded[i].mass !== far[i].mass || seeded[i].x !== far[i].x) changed = true;
    }
    ok(changed, "coarse cell cache respects seed changes", `seed=${getSeed()}`);
    setSeed(originalSeed);
    clearCache();
}

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

// ── 7. Local procedural streaming for the active universe layer ───────────
hr("Local procedural streaming");
{
    const a = sampleLocalStarsNear(R0_PC, 0, 20, 8, 420);
    const b = sampleLocalStarsNear(R0_PC, 0, 20, 8, 420);
    let same = a.length === b.length;
    for (let i = 0; same && i < Math.min(a.length, 40); i++) {
        if (a[i].id !== b[i].id || a[i].mass !== b[i].mass || a[i].x !== b[i].x) same = false;
    }
    ok(same, "local streamed stars are deterministic", `n=${a.length}, cell=${LOCAL_CELL_PC}pc`);
    ok(a.length > 60 && a.length <= 420, "local 8 pc sample is bounded and populated", `n=${a.length}`);
    ok(a.every(s => s.mass > 0 && s.R > 0 && Number.isFinite(s.x + s.y + s.z)), "local stars carry physical fields");
    const sample = a[0];
    clearCache();
    const restored = localStarById(sample.id);
    ok(restored && restored.id === sample.id && restored.mass === sample.mass && restored.x === sample.x,
        "local star ID reconstructs the same generated star", sample.id);
}

// ── 8. Active-star set: bounded real/procedural bridge ────────────────────
hr("Active stellar attractor set");
{
    const stats = refreshActiveStars(0, 0, 0, "star:0");
    const proc = ACTIVE_STARS.filter(s => s.procedural);
    const known = ACTIVE_STARS.filter(s => !s.procedural);
    ok(stats.total === ACTIVE_STARS.length && stats.total <= 640, "active set is bounded", `total=${stats.total}`);
    ok(known.length > 0 && proc.length > 0, "active set mixes destination stars with procedural fill",
        `known=${known.length} procedural=${proc.length}`);
    ok(ACTIVE_STARS.every(s => s.mu > 0 && s.R > 0 && Number.isFinite(s.x + s.y + (s.z || 0))),
        "active stars are valid gravity/contact sources");
    const ids = proc.slice(0, 20).map(s => s.id).join("|");
    refreshActiveStars(0, 0, 0, "star:0");
    const ids2 = ACTIVE_STARS.filter(s => s.procedural).slice(0, 20).map(s => s.id).join("|");
    ok(ids === ids2, "active procedural IDs reproduce after refresh");
    const info = activeStarStats();
    ok(info.seed === stats.seed && info.radiusPc === stats.radiusPc, "active stats expose seed and radius");
    const focusStar = proc[0];
    const focus = proceduralFocusValue(focusStar);
    const farStats = refreshActiveStars(0, 0, 0, focus);
    const resolved = activeStarForFocus(focus);
    ok(resolved && resolved.id === focusStar.id, "proc focus resolves through the active-star layer", focusStar.id);
    ok(ACTIVE_STARS.filter(st => st.id === focusStar.id).length === 1 && farStats.total <= 640,
        "proc focus is force-included once inside the bounded set", `total=${farStats.total}`);
    restorePinnedProceduralStars([focusStar.id]);
    ok(serializePinnedProceduralStars().includes(focusStar.id), "pinned procedural stars serialize for quicksave");
    const overflowIds = sampleLocalStarsNear(R0_PC, 0, 20, 16, ACTIVE_STAR_CONFIG.totalLimit + 120).map(s => s.id);
    const restoredOverflow = restorePinnedProceduralStars(overflowIds);
    const overflowFocus = proceduralFocusValue(overflowIds[0]);
    const overflowStats = refreshActiveStars(0, 0, 0, overflowFocus);
    ok(serializePinnedProceduralStars().length <= ACTIVE_STAR_CONFIG.pinnedProceduralLimit,
        "restored procedural pins stay within the save budget", `pins=${serializePinnedProceduralStars().length}`);
    ok(restoredOverflow.length <= ACTIVE_STAR_CONFIG.pinnedProceduralLimit,
        "restore reports only retained procedural pins", `restored=${restoredOverflow.length}`);
    ok(overflowStats.total === ACTIVE_STARS.length && overflowStats.total <= ACTIVE_STAR_CONFIG.totalLimit,
        "restored procedural pins cannot exceed the active-star cap", `total=${overflowStats.total}`);
    ok(activeStarForFocus(overflowFocus)?.id === overflowIds[0] &&
        ACTIVE_STARS.filter(st => st.id === overflowIds[0]).length === 1,
        "focused procedural star survives pin trimming once", overflowIds[0]);
}

// ── 9. Stellar dominant-well orbit info and 3D circularization ─────────────
hr("Stellar orbit/capture helpers");
{
    const proxima = STARS.find(st => st.name === "PROXIMA");
    const orbitR = proxima.R * 45;
    refreshActiveStars(proxima.x + orbitR, proxima.y, proxima.z, "star:0");
    const well = strongestActiveStarWell(ACTIVE_STARS, proxima.x + orbitR, proxima.y, proxima.z, 0);
    ok(well?.dominant && well?.star === proxima && Math.abs(Math.hypot(well.rx, well.ry, well.rz) - orbitR) / orbitR < 1e-9,
        "active stellar dominance helper chooses Proxima when nearby", `r=${Math.round(Math.hypot(well.rx, well.ry, well.rz))}`);
    ok(!strongestActiveStarWell(ACTIVE_STARS, proxima.x + orbitR, proxima.y, proxima.z, well.acc / STAR_DOMINANCE_MARGIN * 1.01)?.dominant,
        "stellar dominance helper respects contested local wells");
    const binaryA = { id: "test-a", x: 0, y: 0, z: 0, mu: 100, R: 1 };
    const binaryB = { id: "test-b", x: 8, y: 0, z: 0, mu: 100, R: 1 };
    const binaryWell = strongestActiveStarWell([binaryA, binaryB], 3.9, 0, 0, 0);
    ok(binaryWell?.secondStar && !binaryWell.dominant,
        "stellar dominance helper rejects comparable binary wells",
        `ratio=${(binaryWell.acc / binaryWell.secondAcc).toFixed(2)}`);
    const procFocus = ACTIVE_STARS.find(st => st.procedural);
    const procR = procFocus.R * 80;
    const procWell = strongestActiveStarWell([procFocus], procFocus.x + procR, procFocus.y, procFocus.z || 0, 0);
    ok(procWell?.dominant && procWell.star.id === procFocus.id,
        "procedural active star can own the local well", procFocus.id);

    const want = circularVelocityVector(3, 4, 5, -1, 2, .5, MU_E);
    const rMag = Math.hypot(3, 4, 5);
    const vMag = Math.hypot(want.x, want.y, want.z);
    const tangentErr = Math.abs((want.x * 3 + want.y * 4 + want.z * 5) / Math.max(1e-12, rMag * vMag));
    ok(tangentErr < 1e-12, "circular velocity is tangent in full 3D", `dot=${tangentErr.toExponential(2)}`);
    ok(Math.abs(vMag - Math.sqrt(MU_E / rMag)) < 1e-9,
        "circular velocity magnitude matches sqrt(mu/r)", `v=${vMag.toFixed(6)}`);
    ok(!orbitInfoMatchesTarget({ domStar: false, star: proxima, starId: proxima.name }, { star: true, ref: proxima, id: proxima.name }),
        "autopilot star target matching waits for a dominant stellar well");
    ok(orbitInfoMatchesTarget({ domStar: true, star: proxima, starId: proxima.name }, { star: true, ref: proxima, id: proxima.name }),
        "autopilot star target matching accepts the dominant stellar well");
}

// ── 10. Cosmology: physical dark energy and Milky Way dark matter ─────────
hr("Cosmology fields");
{
    const beta = DARK_ENERGY.H2_PHYS;
    ok(beta > 3.2e-36 && beta < 3.5e-36,
        "dark-energy beta uses Planck18-scale OmegaLambda H0^2", beta.toExponential(3));
    const aMpc = darkEnergyAccelerationKmS2(MPC_KM) * 1000;
    ok(aMpc > 9.5e-14 && aMpc < 1.1e-13,
        "Lambda acceleration at 1 Mpc is physical", `${aMpc.toExponential(3)} m/s²`);
    const sunEqPc = Math.cbrt(MU_S / beta) / PC_KM;
    ok(sunEqPc > 108 && sunEqPc < 114,
        "one solar mass balances Lambda around 111 pc", `${sunEqPc.toFixed(2)} pc`);
    ok(darkEnergyVisibleFractionKm(PC_KM) === 0 && darkEnergyVisibleFractionKm(120 * PC_KM) > .9,
        "dark-energy visualization starts at real stellar-balance scale");
    const m200 = darkMatterEnclosedMassSolar(DARK_MATTER.VIRIAL_RADIUS_PC);
    ok(Math.abs(m200 / DARK_MATTER.HALO_MASS_SOLAR - 1) < 1e-9,
        "NFW halo encloses M200 at R200", `${(m200 / 1e12).toFixed(3)}e12 M⊙`);
    const vLocal = darkMatterLocalCircularSpeedKmS();
    ok(vLocal > 130 && vLocal < 160,
        "dark-matter-only local circular speed is Milky-Way scale", `${vLocal.toFixed(1)} km/s`);
    const softPoint = galToEquatorialKm(DARK_MATTER.SOFTENING_PC, 0, 0);
    const corePoint = galToEquatorialKm(DARK_MATTER.SOFTENING_PC * 1e-4, 0, 0);
    const softAccel = [0, 0, 0], coreAccel = [0, 0, 0];
    darkMatterHaloAccelAtEquatorialKm(softPoint[0], softPoint[1], softPoint[2], softAccel);
    darkMatterHaloAccelAtEquatorialKm(corePoint[0], corePoint[1], corePoint[2], coreAccel);
    const softMag = Math.hypot(softAccel[0], softAccel[1], softAccel[2]);
    const coreMag = Math.hypot(coreAccel[0], coreAccel[1], coreAccel[2]);
    ok(Number.isFinite(coreMag) && coreMag <= softMag * 1.01,
        "dark-matter softening keeps inner-halo acceleration bounded",
        `core/soft=${(coreMag / softMag).toExponential(2)}`);
    const rel0 = [1, 1, 1];
    darkMatterRelativeAccel(0, 0, 0, 0, 0, 0, rel0);
    ok(Math.hypot(rel0[0], rel0[1], rel0[2]) < 1e-24,
        "halo uses differential acceleration in the Sol frame");
}

console.log("\n" + "=".repeat(60));
console.log(`  ${pass} PASSED   ${fail} FAILED   (${pass + fail} checks)`);
console.log("=".repeat(60));
process.exit(fail ? 1 : 0);
