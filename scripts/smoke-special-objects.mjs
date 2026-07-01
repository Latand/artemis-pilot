// Headless verification of the WP19 curated special-objects overlay:
//   - Gaia BH3 present with the cited distance/mass and the bh flag
//   - pulsars present as non-bh compact objects with sane physics (mu, R)
//   - every RA/Dec position round-trips through the xyz placement to
//     within arcminutes of the catalog value
//   - no special object duplicates an existing curated STARS entry within
//     the same 0.35 pc proximity rule activeStars.js uses for HYG dedup
//   - finalizeStar's runtime fields (mu, flowC, flowSink) are finite
//
// Run: node scripts/smoke-special-objects.mjs   (or: bun scripts/smoke-special-objects.mjs)

globalThis.window = {};

const { SPECIAL_OBJECTS } = await import("../src/universe/specialObjects.js");
const { STARS, PC_KM } = await import("../src/constants.js");
const { ACTIVE_STAR_CONFIG } = await import("../src/universe/activeStars.js");

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
    if (cond) { pass++; console.log(`  PASS  ${label}${detail ? "   " + detail : ""}`); }
    else { fail++; console.log(`  FAIL  ${label}${detail ? "   " + detail : ""}`); }
};
const hr = (t) => console.log("\n" + "─".repeat(60) + "\n  " + t + "\n" + "─".repeat(60));

const byName = name => STARS.find(s => s.name === name);
const PC_LY = 3.2615637771674;

// ── 1. Gaia BH3 ──────────────────────────────────────────────────────────
hr("Gaia BH3");
{
    const bh3 = byName("GAIA BH3");
    ok(!!bh3, "GAIA BH3 is present in STARS");
    if (bh3) {
        const distPc = bh3.dLy / PC_LY;
        ok(Math.abs(distPc - 590) < 1, "GAIA BH3 distance is ~590 pc", `${distPc.toFixed(2)} pc`);
        ok(Math.abs(bh3.mass - 32.7) < 0.1, "GAIA BH3 mass is ~32.7 Msun", `${bh3.mass} Msun`);
        ok(bh3.bh === true, "GAIA BH3 is flagged as a black hole");
        ok(bh3.rs > 0 && Number.isFinite(bh3.rs), "GAIA BH3 has a finite Schwarzschild radius", `rs=${bh3.rs.toFixed(3)} km`);
    }
}

// ── 2. All curated black holes ───────────────────────────────────────────
hr("Curated stellar-mass black holes");
{
    const expected = {
        "GAIA BH1": { pc: 477, mass: 9.62 },
        "GAIA BH2": { pc: 1160, mass: 8.9 },
        "GAIA BH3": { pc: 590, mass: 32.7 },
        "CYGNUS X-1": { pc: 2200, mass: 21.2 },
    };
    for (const [name, spec] of Object.entries(expected)) {
        const star = byName(name);
        ok(!!star, `${name} is present in STARS`);
        if (!star) continue;
        const distPc = star.dLy / PC_LY;
        ok(Math.abs(distPc - spec.pc) < 1, `${name} distance matches catalog`, `${distPc.toFixed(1)} pc (expected ${spec.pc})`);
        ok(Math.abs(star.mass - spec.mass) < 1e-6, `${name} mass matches catalog`, `${star.mass} Msun`);
        ok(star.bh === true, `${name} is flagged as a black hole`);
        const expectedRs = 2.9532 * spec.mass;
        ok(Math.abs(star.rs - expectedRs) < 1e-6, `${name} Schwarzschild radius matches r_s = 2.9532*M`, `rs=${star.rs.toFixed(3)} km`);
        ok(Math.abs(star.R - 1.5 * expectedRs) < 1e-6, `${name} contact radius is the photon sphere (1.5 r_s)`);
    }
}

// ── 3. Pulsars as non-BH compact objects ─────────────────────────────────
hr("Pulsars / neutron stars");
{
    const pulsarNames = ["CRAB PULSAR", "VELA PULSAR", "PSR B1919+21", "GEMINGA"];
    for (const name of pulsarNames) {
        const star = byName(name);
        ok(!!star, `${name} is present in STARS`);
        if (!star) continue;
        ok(!star.bh, `${name} is not flagged as a black hole (has an event horizon-free surface)`);
        ok(Math.abs(star.mass - 1.4) < 1e-9, `${name} mass is 1.4 Msun`);
        ok(star.R > 0 && star.R < 20, `${name} has a sane neutron-star radius`, `R=${star.R.toFixed(2)} km`);
        ok(Number.isFinite(star.mu) && star.mu > 0, `${name} has a finite positive mu`, `mu=${star.mu.toExponential(3)}`);
    }
}

// ── 4. RA/Dec round-trip ─────────────────────────────────────────────────
hr("RA/Dec round-trip (xyz -> angles within arcminutes)");
{
    const ARCMIN = 1 / 60;
    for (const src of SPECIAL_OBJECTS) {
        const r = Math.hypot(src.x, src.y, src.z);
        const decDeg = Math.asin(src.z / r) * 180 / Math.PI;
        let raDeg = Math.atan2(src.y, src.x) * 180 / Math.PI;
        if (raDeg < 0) raDeg += 360;
        let raErr = Math.abs(raDeg - src.raDeg);
        if (raErr > 180) raErr = 360 - raErr;
        // RA error scales with 1/cos(dec); still require arcminute-level agreement
        const cosDec = Math.max(Math.cos(src.decDeg * Math.PI / 180), 1e-6);
        ok(raErr * cosDec < ARCMIN, `${src.name} RA round-trips to arcminute precision`, `err=${(raErr * 3600).toFixed(2)}"`);
        ok(Math.abs(decDeg - src.decDeg) < ARCMIN, `${src.name} Dec round-trips to arcminute precision`, `err=${(Math.abs(decDeg - src.decDeg) * 3600).toFixed(2)}"`);
    }
}

// ── 5. No duplicates vs the rest of STARS (0.35 pc proximity rule) ──────
hr("No duplicates against curated/HYG STARS");
{
    const maskKm = ACTIVE_STAR_CONFIG.realMaskPc * PC_KM;
    const mask2 = maskKm * maskKm;
    for (const special of SPECIAL_OBJECTS) {
        let nearest = null, nearestD2 = Infinity;
        for (const known of STARS) {
            if (known === special || known.name === special.name) continue;
            const dx = special.x - known.x, dy = special.y - known.y, dz = (special.z || 0) - (known.z || 0);
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < nearestD2) { nearestD2 = d2; nearest = known; }
        }
        const duplicate = nearest && nearestD2 <= mask2;
        ok(!duplicate, `${special.name} has no duplicate within ${ACTIVE_STAR_CONFIG.realMaskPc} pc`,
            nearest ? `nearest=${nearest.name} d=${(Math.sqrt(nearestD2) / PC_KM).toFixed(3)} pc` : "");
    }
    const names = SPECIAL_OBJECTS.map(s => s.name);
    ok(new Set(names).size === names.length, "special objects have unique names among themselves");
    ok(!SPECIAL_OBJECTS.some(s => s.name === "SGR A*"), "special objects do not duplicate the already-curated Sgr A*");
}

// ── 6. finalizeStar runtime fields are finite ────────────────────────────
hr("finalizeStar runtime fields");
{
    for (const src of SPECIAL_OBJECTS) {
        const star = byName(src.name);
        ok(!!star, `${src.name} made it into the finalized STARS array`);
        if (!star) continue;
        ok(Number.isFinite(star.mu) && star.mu > 0, `${src.name} mu is finite and positive`);
        ok(Number.isFinite(star.flowC) && star.flowC > 0, `${src.name} flowC is finite and positive`);
        ok(Number.isFinite(star.flowSink) && star.flowSink > 0, `${src.name} flowSink is finite and positive`);
        ok(Number.isFinite(star.x) && Number.isFinite(star.y) && Number.isFinite(star.z), `${src.name} xyz are finite`);
    }
}

console.log("\n" + "=".repeat(60));
console.log(`  ${pass} PASSED   ${fail} FAILED   (${pass + fail} checks)`);
console.log("=".repeat(60));
process.exit(fail ? 1 : 0);
