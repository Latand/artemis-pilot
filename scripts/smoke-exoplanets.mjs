import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setSeed } from "../src/universe/galaxy.js";
import { clearExoplanetTableForTest, exoplanetSystemFor, setExoplanetTableForTest } from "../src/universe/exoplanetHosts.js";
import { generateSystem } from "../src/universe/planetarySystem.js";

const fixture = JSON.parse(readFileSync(new URL("../public/data/exoplanets.fixture.json", import.meta.url), "utf8"));

assert.equal(typeof fixture.generatedUTC, "string", "fixture should carry generatedUTC");
assert.equal(typeof fixture.count, "number", "fixture should carry planet count");
assert(fixture.hosts && typeof fixture.hosts === "object", "fixture should carry hosts map");

const hd209458 = fixture.hosts["cat:HD209458"];
assert(hd209458, "fixture should include compact HD id variant");
assert.equal(fixture.hosts["cat:HIP108859"]?.hostname, hd209458.hostname, "fixture should include HIP id variant");
assert.equal(fixture.hosts["cat:HD 209458"]?.hostname, hd209458.hostname, "fixture should include display-name id variant");
assert(hd209458.planets[0].aAU > 0.04 && hd209458.planets[0].aAU < 0.06, "HD 209458 b should have sane a");
assert(hd209458.planets[0].periodDays > 3 && hd209458.planets[0].periodDays < 4, "HD 209458 b should have sane period");
for (const host of Object.values(fixture.hosts)) {
    assert(Array.isArray(host.planets), "host planets should be an array");
    for (const p of host.planets) {
        assert("letter" in p && "aAU" in p && "e" in p && "periodDays" in p, "planet should carry compact archive fields");
        assert("radiusMe" in p && "massMe" in p && "inclDeg" in p, "planet should carry measured radius/mass/inclination fields");
    }
}

setSeed(424242);
setExoplanetTableForTest(fixture);
const knownStar = { name: "HD 209458", hd: "209458", hip: "108859", mass: 1.13, lumSolar: 1.6, tempK: 6075, radiusSolar: 1.2, kind: "MS" };
const overlay = exoplanetSystemFor(knownStar);
assert(overlay?.planets?.some(p => p.real && Math.abs(p.a - 0.04707) < 1e-6), "known host should return real archive planet");

let mixStar = null;
let mixed = null;
for (let i = 0; i < 80; i++) {
    const s = { name: "Blend Smoke", mass: 1, lumSolar: 1, tempK: 5800, radiusSolar: 1, kind: "MS", feh: 0.2, procedural: true, id: "blend-smoke-" + i };
    const sys = generateSystem(s);
    if (sys.planets.some(p => p.real) && sys.planets.some(p => !p.real)) {
        mixStar = s;
        mixed = sys;
        break;
    }
}
assert(mixStar && mixed, "fixture host should produce a real+synth blended system for at least one deterministic seed");
assert(mixed.planets.length <= 9, "blend should cap systems at 9 planets");
assert(mixed.planets.every((p, i, arr) => p.index === i && (i === 0 || arr[i - 1].a <= p.a)), "blend should sort and re-index planets");

const unmatched = generateSystem({ name: "No Archive Match", mass: 1, lumSolar: 1, tempK: 5800, radiusSolar: 1, kind: "MS" });
assert(unmatched.planets.every(p => !p.real), "unmatched host should remain procedural-only");

clearExoplanetTableForTest();
const absent = generateSystem(knownStar);
assert(absent.planets.every(p => !p.real), "absent table should fall back to procedural-only");

console.log("smoke-exoplanets ok", { real: overlay.planets.length, blended: mixed.planets.length });
