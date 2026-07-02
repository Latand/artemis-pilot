import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setSeed } from "../src/universe/galaxy.js";
import {
    generateSystem, systemSeed, aFromPeriodDays, periodDaysFromA,
} from "../src/universe/planetarySystem.js";
import { hzEdgesAU, massMeFromRadiusRe, occurrenceLambda } from "../src/universe/astroConstants.js";

function hash(v) {
    return createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
}

function fake(name, mass, L, kind = "MS", feh = 0) {
    return { name, mass, lumSolar: L, tempK: 5800, radiusSolar: Math.max(0.1, Math.sqrt(Math.max(0.001, L))), kind, feh, x: 0, y: 0, z: 0, R: 696340 };
}

setSeed(12345);
const sun = fake("Smoke Sun", 1, 1);
assert.deepEqual(generateSystem(sun), generateSystem(sun), "same star should generate byte-identical systems");
const h1 = hash(generateSystem(sun));
setSeed(67890);
const h2 = hash(generateSystem(sun));
setSeed(12345);
assert.equal(hash(generateSystem(sun)), h1, "same seed should reproduce systems");
assert.notEqual(h1, h2, "changing galaxy seed should re-roll systems");
assert.equal(systemSeed(sun), systemSeed(sun), "systemSeed should be stable");

const hz = hzEdgesAU(1);
assert(Math.abs(hz.inner - Math.sqrt(1 / 1.10)) < 1e-12, "inner HZ should use Kopparapu sqrt(L/1.10)");
assert(Math.abs(hz.outer - Math.sqrt(1 / 0.35)) < 1e-12, "outer HZ should use Kopparapu sqrt(L/0.35)");
for (const p of [1.5, 12, 365.25, 1000]) {
    const a = aFromPeriodDays(1, p);
    assert(Math.abs(periodDaysFromA(1, a) - p) < 1e-9, "Kepler period/a helpers should round-trip");
}
assert(Math.abs(massMeFromRadiusRe(1.008) - 1) < 1e-12, "Forecaster Terran branch should map Earth radius near Earth mass");
assert(massMeFromRadiusRe(1.23) > 1.9 && massMeFromRadiusRe(1.23) < 2.2, "Forecaster break should be near 2.04 Mearth");

assert.equal(generateSystem(fake("BH", 8, 0, "BH")).planets.length, 0, "black holes should be gated empty");
assert(generateSystem(fake("WD", 0.6, 0.001, "WD")).planets.length <= 2, "white-dwarf systems should stay sparse");

setSeed(24680);
const classes = [
    { key: "M", mass: 0.3, L: 0.02, target: occurrenceLambda(0.3) },
    { key: "FGK", mass: 1.0, L: 1.0, target: occurrenceLambda(1.0) },
    { key: "AB", mass: 2.0, L: 17, target: occurrenceLambda(2.0) },
];
for (const cls of classes) {
    let totalCoreish = 0, samples = 5000, hot = 0, bad = 0;
    for (let i = 0; i < samples; i++) {
        const s = fake(cls.key + "-" + i, cls.mass, cls.L);
        const sys = generateSystem(s);
        for (const p of sys.planets) {
            if (!(p.a > 0) || p.radiusKm < 0.5 * 6371 || p.radiusKm > 14 * 6371) bad++;
        }
        totalCoreish += sys.planets.filter(p => p.type !== "gas" && p.type !== "hot-jupiter").length;
        hot += sys.planets.some(p => p.type === "hot-jupiter") ? 1 : 0;
        const sorted = sys.planets.every((p, n, arr) => n === 0 || arr[n - 1].a <= p.a);
        assert(sorted, "planetary systems should be sorted by semi-major axis");
    }
    const mean = totalCoreish / samples;
    assert(Math.abs(mean - cls.target) / cls.target < 0.2, `${cls.key} mean multiplicity ${mean} outside 20% of ${cls.target}`);
    assert.equal(bad, 0, `${cls.key} generated invalid a/radius`);
    if (cls.key === "FGK") {
        const frac = hot / samples;
        assert(frac >= 0.008 && frac <= 0.014, `FGK hot-Jupiter fraction ${frac} outside expected band`);
    }
}

let lowG = 0, highG = 0;
for (let i = 0; i < 5000; i++) {
    lowG += generateSystem(fake("lowG-" + i, 0.6, 0.2, "MS", -0.5)).planets.some(p => p.type === "gas") ? 1 : 0;
    highG += generateSystem(fake("highG-" + i, 1.6, 4, "MS", 0.4)).planets.some(p => p.type === "gas") ? 1 : 0;
}
assert(highG > lowG, "giant occurrence should rise with mass and metallicity");

console.log("smoke-planetary-systems ok", { deterministic: h1, lowG, highG });
