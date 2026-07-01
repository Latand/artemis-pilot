// Headless verification of src/universe/astroConstants.js against the numbers
// in research/astro-population-model.md and research/catalog-strategy.md:
//   - local densities (MS base 0.08/pc³ + remnant/BD populations)
//   - disk/halo structural parameters and asymmetric-drift lags
//   - Reid 2019 arm table (5 major arms) and the arm-width function
//   - Eilers 2019 rotation curve at the solar radius
//   - main-sequence lifetime, IFMR breakpoints, multiplicity, metallicity
//   - per-type catalog completeness handoff
//
// Run: bun scripts/smoke-astro-constants.mjs   (or: node ...)

const {
    MS_DENSITY_PC3, WD_DENSITY_PC3, NS_DENSITY_PC3, BH_DENSITY_PC3, BD_DENSITY_PC3,
    DISK, HALO, REID_ARMS, ARM_AMP_YOUNG, ARM_AMP_OLD, YOUNG_AGE_GYR,
    armWidth, vCirc, DISP, tMSGyr, IFMR, multiplicityFrac, fehAt, completeness,
    R_SUN_KPC, Z_SUN_PC,
} = await import("../src/universe/astroConstants.js");

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
    if (cond) { pass++; console.log(`  PASS  ${label}${detail ? "   " + detail : ""}`); }
    else { fail++; console.log(`  FAIL  ${label}${detail ? "   " + detail : ""}`); }
};
const hr = (t) => console.log("\n" + "─".repeat(60) + "\n  " + t + "\n" + "─".repeat(60));

// ── 1. Local densities ─────────────────────────────────────────────────────
hr("Local densities (astro report §2)");
ok(MS_DENSITY_PC3 === 0.08, "MS density = 0.08 /pc³ (CNS5)", `got ${MS_DENSITY_PC3}`);
ok(WD_DENSITY_PC3 > 1e-3 && WD_DENSITY_PC3 < 1.5e-2, "WD density in report range", `got ${WD_DENSITY_PC3}`);
ok(NS_DENSITY_PC3 > 1e-4 && NS_DENSITY_PC3 < 5e-4, "NS density in report range", `got ${NS_DENSITY_PC3}`);
ok(BH_DENSITY_PC3 > 1e-5 && BH_DENSITY_PC3 < 7e-5, "BH density in report range", `got ${BH_DENSITY_PC3}`);
ok(BD_DENSITY_PC3 > 0.015 && BD_DENSITY_PC3 < 0.06, "BD density in report range", `got ${BD_DENSITY_PC3}`);

// ── 2. Sun position ─────────────────────────────────────────────────────────
hr("Sun position (astro report §3)");
ok(Math.abs(R_SUN_KPC - 8.178) < 1e-9, "R_SUN_KPC = 8.178 (GRAVITY 2019)", `got ${R_SUN_KPC}`);
ok(Math.abs(Z_SUN_PC - 20.8) < 1e-9, "Z_SUN_PC = 20.8 pc (Bennett & Bovy 2019)", `got ${Z_SUN_PC}`);

// ── 3. Disk / halo structure ─────────────────────────────────────────────────
hr("Disk/halo structural parameters (astro report §3)");
ok(DISK.thinHR === 2600 && DISK.thinHZ === 300, "thin disk scale length/height", JSON.stringify(DISK));
ok(DISK.thickHR === 2000 && DISK.thickHZ === 900, "thick disk scale length/height", JSON.stringify(DISK));
ok(Math.abs(DISK.thickFrac - 0.05) < 1e-9, "thick:thin local fraction ≈ 0.05");
ok(Math.abs(HALO.q - 0.6) < 1e-9 && Math.abs(HALO.n - 2.8) < 1e-9, "halo q=0.6, n=2.8", JSON.stringify(HALO));
ok(Math.abs(HALO.frac - 0.002) < 1e-9, "halo local normalization ≈ 1/500");

// ── 4. Spiral arms ──────────────────────────────────────────────────────────
hr("Reid 2019 spiral arms (astro report §4)");
ok(REID_ARMS.length === 5, "five major arms modelled", `got ${REID_ARMS.length}`);
const armNames = REID_ARMS.map(a => a.name).sort().join(",");
ok(armNames === "Local,Outer,Perseus,Sct-Cen,Sgr-Car".split(",").sort().join(","),
    "arm set matches Sct-Cen/Sgr-Car/Local/Perseus/Outer", armNames);
ok(REID_ARMS.every(a => a.rKinkKpc > 0 && a.widthKpc > 0 && Number.isFinite(a.pitchInner) && Number.isFinite(a.pitchOuter)),
    "every arm carries rKink/pitch/width fields");
const localArm = REID_ARMS.find(a => a.name === "Local");
ok(Math.abs(localArm.rKinkKpc - 8.26) < 1e-9 && Math.abs(localArm.pitchInner - 11.4) < 1e-9,
    "Local arm matches Table 2 (R_kink=8.26, pitch=11.4°)");
const armBetaExtent = { "Sct-Cen": [0, 104], "Sgr-Car": [2, 97], "Local": [-8, 34], "Perseus": [-23, 115], "Outer": [-16, 71] };
for (const [name, [betaMin, betaMax]] of Object.entries(armBetaExtent)) {
    const arm = REID_ARMS.find(a => a.name === name);
    ok(arm.betaMinDeg === betaMin && arm.betaMaxDeg === betaMax,
        `${name} arm betaMin/MaxDeg = ${betaMin}/${betaMax} (Reid 2019 Table 2)`,
        `got ${arm.betaMinDeg}/${arm.betaMaxDeg}`);
}
ok(Math.abs(armWidth(8.15) - 0.33) < 1e-9, "armWidth(8.15) = 0.33 kpc (reference radius)", `got ${armWidth(8.15)}`);
ok(Math.abs(armWidth(11.15) - (0.33 + 0.036 * 3)) < 1e-9, "armWidth scales at 0.036 kpc per kpc",
    `got ${armWidth(11.15)}`);
ok(ARM_AMP_YOUNG === 3 && ARM_AMP_OLD === 0.3 && Math.abs(YOUNG_AGE_GYR - 0.1) < 1e-9,
    "arm amplitude gating constants", `young=${ARM_AMP_YOUNG} old=${ARM_AMP_OLD} ageGyr=${YOUNG_AGE_GYR}`);

// ── 5. Rotation curve & dispersions ──────────────────────────────────────────
hr("Eilers 2019 rotation curve + dispersions (astro report §5)");
ok(Math.abs(vCirc(8.18) - 229.0) < 1e-9, "vCirc(8.18) = 229.0 km/s", `got ${vCirc(8.18)}`);
ok(Math.abs(vCirc(9.18) - 227.3) < 1e-9, "vCirc declines 1.7 km/s per kpc", `got ${vCirc(9.18)}`);
ok(vCirc(0) === 0 && vCirc(2.5) > 0 && vCirc(2.5) < vCirc(5), "vCirc ramps linearly inside 5 kpc",
    `vCirc(2.5)=${vCirc(2.5).toFixed(1)}`);
ok(vCirc(30) === vCirc(25), "vCirc clamps beyond 25 kpc rather than extrapolating");
ok(DISP.thin.lag === 10 && DISP.thick.lag === 45 && DISP.halo.lag === 200,
    "asymmetric-drift lags thin/thick/halo", `${DISP.thin.lag}/${DISP.thick.lag}/${DISP.halo.lag}`);
ok(DISP.thin.sU === 35 && DISP.thin.sV === 20 && DISP.thin.sW === 16, "thin-disk dispersions");
ok(DISP.halo.sU === 160 && DISP.halo.sV === 90 && DISP.halo.sW === 90, "halo dispersions");

// ── 6. Stellar lifetime, IFMR, multiplicity, metallicity ─────────────────────
hr("Stellar synthesis inputs (astro report §1d, §2, §6, §7)");
ok(Math.abs(tMSGyr(1) - 10) < 1e-9, "tMSGyr(1 Msun) = 10 Gyr", `got ${tMSGyr(1)}`);
ok(tMSGyr(2) < tMSGyr(1) && tMSGyr(10) < tMSGyr(2), "tMSGyr decreases with mass");

ok(IFMR(7.99).kind === "WD" && IFMR(8).kind === "NS", "IFMR breakpoint at 8 Msun (WD→NS)",
    `IFMR(7.99)=${IFMR(7.99).kind} IFMR(8)=${IFMR(8).kind}`);
ok(IFMR(21.99).kind === "NS" && IFMR(22).kind === "BH", "IFMR breakpoint at 22 Msun (NS→BH)",
    `IFMR(21.99)=${IFMR(21.99).kind} IFMR(22)=${IFMR(22).kind}`);
ok(Math.abs(IFMR(3).mass - (0.09 * 3 + 0.44)) < 1e-9, "WD mass follows Cummings 2018 relation");
ok(Math.abs(IFMR(10).mass - 1.35) < 1e-9, "NS mass = 1.35 Msun (peak)");
ok(Math.abs(IFMR(30).mass - 0.35 * 30) < 1e-9, "BH mass = 0.35·Minit (report midpoint)");
ok(Math.abs(IFMR(100).mass - 25) < 1e-9, "BH mass clamps at 25 Msun for large M_init (Gaia BH3 is an outlier)",
    `got ${IFMR(100).mass}`);

ok(Math.abs(multiplicityFrac(1) - 0.44) < 1e-9, "multiplicityFrac(1 Msun) = 0.44 (solar-type)",
    `got ${multiplicityFrac(1)}`);
ok(Math.abs(multiplicityFrac(0.05) - 0.21) < 1e-9, "multiplicityFrac(0.05) = 0.21 (BD/M-L dwarf)");
ok(Math.abs(multiplicityFrac(0.6) - 0.30) < 1e-9, "multiplicityFrac(0.6) = 0.30 (interpolated 0.5-0.7 gap)");
ok(Math.abs(multiplicityFrac(1.4) - 0.52) < 1e-9, "multiplicityFrac(1.4) = 0.52 (interpolated 1.3-1.5 gap)");
ok(Math.abs(multiplicityFrac(10) - 0.85) < 1e-9, "multiplicityFrac(10) = 0.85 (O/B)");

const thin = fehAt(R_SUN_KPC, "thin");
ok(Math.abs(thin.mean) < 1e-9 && Math.abs(thin.sigma - 0.15) < 1e-9,
    "thin-disk [Fe/H] at R_sun ≈ 0.0 ± 0.15", `mean=${thin.mean} sigma=${thin.sigma}`);
const thinOut = fehAt(R_SUN_KPC + 1, "thin");
ok(Math.abs(thinOut.mean - (-0.06)) < 1e-9, "thin-disk gradient -0.06 dex/kpc", `mean=${thinOut.mean}`);
const thick = fehAt(R_SUN_KPC, "thick");
ok(thick.mean === -0.5 && thick.sigma === 0.25, "thick-disk [Fe/H] mean/sigma");
const halo = fehAt(R_SUN_KPC, "halo");
ok(halo.mean === -1.5 && halo.sigma === 0.5, "halo [Fe/H] mean/sigma");

// ── 7. Catalog completeness handoff ─────────────────────────────────────────
hr("Catalog completeness handoff (catalog report §2)");
ok(completeness("M", 10) === 1, "completeness('M', 10) = 1 (inside CNS5 25 pc)", `got ${completeness("M", 10)}`);
ok(completeness("M", 100) === 0, "completeness('M', 100) = 0 (fully handed to procedural)",
    `got ${completeness("M", 100)}`);
ok(completeness("M", 40) > 0 && completeness("M", 40) < 1, "completeness('M', 40) fades smoothly mid-range",
    `got ${completeness("M", 40).toFixed(3)}`);
ok(completeness("K", 50) === 1 && completeness("K", 300) === 0, "completeness('K') anchors at 100/200 pc");
ok(completeness("G", 200) === 1 && completeness("F", 200) === 1, "completeness('G'/'F') complete to 300 pc");
ok(completeness("G", 1500) === 0, "completeness('G') fully handed off by 1000 pc");
ok(completeness("O", 400) === 1, "completeness('O') complete to 500 pc");
ok(Math.abs(completeness("B", 2000) - 0.9) < 1e-9, "completeness('B') eases to a 0.9 floor by 2000 pc",
    `got ${completeness("B", 2000)}`);
ok(completeness("A", 5000) === 0, "completeness('A') fully handed off by 5000 pc");
ok(completeness("Z", 10) === 0, "unknown class defaults to zero completeness (no silent overcounting)");

console.log("\n" + "=".repeat(60));
console.log(`  ${pass} PASSED   ${fail} FAILED   (${pass + fail} checks)`);
console.log("=".repeat(60));
process.exit(fail ? 1 : 0);
