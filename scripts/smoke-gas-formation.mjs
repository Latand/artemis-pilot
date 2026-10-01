// Deterministic single-core gas-cloud formation, persistence, and live-star
// integration. No WebGL, network, wall-clock advance, or browser is required.
// Run: node scripts/smoke-gas-formation.mjs
import assert from "node:assert/strict";

globalThis.window ??= {};

const { STARS, MU_S, LY_KM, R_SUN } = await import("../src/constants.js");
const model = await import("../src/universe/gasFormation.js");
const neb = await import("../src/universe/nebulaeData.js");
const active = await import("../src/universe/activeStars.js");
const { strongestActiveStarWell } = await import("../src/universe/starDominance.js");
const { gravityStarsFor } = await import("../src/ephemeris.js");

const initialStars = STARS.slice();
const initialCatalog = JSON.stringify(STARS);
let passed = 0, failed = 0;
function test(label, fn) {
    try {
        fn();
        passed++;
        console.log("  PASS  " + label);
    } catch (error) {
        failed++;
        console.error("  FAIL  " + label + "\n        " + error.message);
    }
}
const close = (actual, expected, message) => assert.ok(
    Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
    `${message}: got ${actual}, expected ${expected}`,
);
const makeRecord = (overrides = {}) => ({
    xKm: LY_KM, yKm: .125 * LY_KM, zKm: -.075 * LY_KM,
    radiusKm: model.GAS_RADIUS_KM, archetype: 0, seed: 0x57a4b19d,
    formation: { v: model.GAS_MODEL_VERSION, bornAtSec: 12345, massSolar: 1 },
    ...overrides,
});
const birthOf = record => record.formation.bornAtSec + model.formationDuration(record);
const formed = () => active.ACTIVE_STARS.filter(star => star.formedStar);
const gravFormed = () => active.GRAVITY_STARS.filter(star => star.formedStar);
function install(record = makeRecord()) {
    neb.clearNebulaRecords();
    assert.equal(neb.addNebulaRecord(record), 0);
    return neb.NEBULAE[0];
}
function refresh(record, time, focus = "neb:0") {
    return active.refreshActiveStars(record.xKm + 1e7, record.yKm, record.zKm, focus, time);
}

console.log("\nGas-cloud analytic model");
test("immutable source advances through gas, collapse, protostar, and star", () => {
    const record = makeRecord();
    Object.freeze(record.formation);
    Object.freeze(record);
    const duration = model.formationDuration(record);
    assert.ok(Number.isFinite(duration) && duration > 0);
    const phaseAt = fraction => model.gasStateAt(record, record.formation.bornAtSec + duration * fraction);
    assert.equal(phaseAt(0).phase, "Gas cloud");
    assert.equal(phaseAt(.5).phase, "Collapsing cloud");
    assert.equal(phaseAt(.875).phase, "Protostar");
    assert.equal(phaseAt(1.01).phase, "Newborn star");
    assert.ok(phaseAt(.5).radiusKm < phaseAt(0).radiusKm);
    assert.ok(phaseAt(.875).radiusKm < phaseAt(.5).radiusKm);
    assert.equal(phaseAt(0).radiusKm, record.radiusKm);
    assert.equal(phaseAt(1.01).radiusKm, R_SUN);
});

test("release does not instantly materialize a star", () => {
    const record = install();
    const state = model.gasStateAt(record, record.formation.bornAtSec);
    assert.equal(state.present, true);
    assert.equal(state.born, false);
    assert.equal(state.progress, 0);
    assert.equal(state.coreMassSolar, 0);
    assert.equal(state.gasMassSolar, 1);
    assert.equal(neb.formedStarForNebula(0, record.formation.bornAtSec), null);
    assert.deepEqual(neb.formedStarsAt(record.formation.bornAtSec), []);
});

test("pause is exact: repeated evaluation at one simulated instant is identical", () => {
    const record = makeRecord();
    const t = record.formation.bornAtSec + model.formationDuration(record) * .81;
    const expected = model.gasStateAt(record, t);
    const scratch = {};
    for (let i = 0; i < 100; i++) {
        assert.equal(model.gasStateAt(record, t, scratch), scratch);
        assert.deepEqual(scratch, expected);
    }
});

test("many small samples and one large jump have identical final states", () => {
    const record = makeRecord();
    const duration = model.formationDuration(record);
    for (const fraction of [.5, .9, 1, 3]) {
        const t = record.formation.bornAtSec + duration * fraction;
        const expected = model.gasStateAt(record, t);
        for (let i = 0; i <= 1000; i++) model.gasStateAt(record, record.formation.bornAtSec + (t - record.formation.bornAtSec) * i / 1000);
        assert.deepEqual(model.gasStateAt(record, t), expected);
    }
});

test("reverse crosses stellar birth and before release without mutating the source", () => {
    const record = install();
    const serialized = JSON.stringify(neb.serializeNebulae());
    const birth = birthOf(record);
    assert.ok(neb.formedStarForNebula(0, birth + 1));
    assert.equal(neb.formedStarForNebula(0, birth - 1), null);
    const before = model.gasStateAt(record, record.formation.bornAtSec - 1);
    assert.equal(before.present, false);
    assert.equal(before.born, false);
    assert.equal(before.phase, "Before release");
    assert.equal(before.gasMassSolar + before.coreMassSolar, 0);
    assert.ok(neb.formedStarForNebula(0, birth + 1));
    assert.equal(JSON.stringify(neb.serializeNebulae()), serialized);
});

test("gas plus core conserves each supported cloud mass through birth", () => {
    for (const massSolar of model.GAS_MASSES) {
        const record = makeRecord({ formation: { v: model.GAS_MODEL_VERSION, bornAtSec: 0, massSolar } });
        const duration = model.formationDuration(record);
        let previousCore = 0;
        for (let i = 0; i <= 200; i++) {
            const state = model.gasStateAt(record, duration * i / 100);
            close(state.gasMassSolar + state.coreMassSolar, massSolar, "mass budget");
            assert.ok(state.coreMassSolar >= previousCore && state.coreMassSolar <= massSolar);
            assert.ok(state.gasMassSolar >= 0 && state.gasMassSolar <= massSolar);
            previousCore = state.coreMassSolar;
        }
        const star = model.gasStateAt(record, duration * 2);
        assert.equal(star.gasMassSolar, 0);
        assert.equal(star.coreMassSolar, massSolar);
        assert.ok(star.radiusKm > 0 && star.tempK > 0 && star.lumSolar > 0);
    }
});

test("next birth boundary limits forward and reverse jumps", () => {
    const record = install();
    const birth = birthOf(record);
    close(neb.nextFormationBoundary(birth - 100, 300), 100, "forward boundary");
    close(neb.nextFormationBoundary(birth + 100, -300), -100, "reverse boundary");
    assert.equal(neb.nextFormationBoundary(birth - 100, 20), 20);
    assert.equal(neb.nextFormationBoundary(birth + 100, -20), -20);
});

test("empty and populated boundary queries preserve sub-ULP signed advances", () => {
    const t = 1e21;
    assert.equal(t + 1, t, "fixture must exercise sub-ULP arithmetic");
    neb.clearNebulaRecords();
    for (const dt of [1, -1]) assert.equal(neb.nextFormationBoundary(t, dt), dt);
    install();
    for (const dt of [1, -1]) assert.equal(neb.nextFormationBoundary(t, dt), dt);
    install(makeRecord({ formation: { v: model.GAS_MODEL_VERSION, bornAtSec: t, massSolar: 1 } }));
    for (const dt of [1, -1]) assert.equal(neb.nextFormationBoundary(t, dt), dt);
});

test("four birth boundaries are traversed in chronological order in both directions", () => {
    neb.clearNebulaRecords();
    const births = [];
    for (let i = 0; i < neb.NEB_MAX; i++) {
        const record = makeRecord({ seed: i, formation: { v: model.GAS_MODEL_VERSION, bornAtSec: i * 100, massSolar: 1 } });
        neb.addNebulaRecord(record);
        births.push(birthOf(record));
    }
    const lo = births[0] - 50, hi = births[births.length - 1] + 50;
    for (const direction of [1, -1]) {
        let t = direction > 0 ? lo : hi;
        const target = direction > 0 ? hi : lo;
        const expected = direction > 0 ? [...births, hi] : [...births].reverse().concat(lo);
        const reached = [];
        while (t !== target && reached.length <= neb.NEB_MAX) {
            const dt = neb.nextFormationBoundary(t, target - t);
            assert.ok(dt * direction > 0, "boundary slicing must make progress");
            t += dt;
            reached.push(t);
        }
        assert.deepEqual(reached, expected);
    }
});

test("the absolute birth boundary stays exact at deep-time clock magnitudes", () => {
    for (const bornAtSec of [0, 1e12, 1e15, 1e17, 1e18, 1e20]) {
        const record = makeRecord({ formation: { v: model.GAS_MODEL_VERSION, bornAtSec, massSolar: 1 } });
        const birth = birthOf(record);
        const step = Math.max(1, Math.abs(birth) * Number.EPSILON * 2);
        assert.equal(model.gasStateAt(record, birth - step).born, false, "before birth at " + bornAtSec);
        const atBirth = model.gasStateAt(record, birth);
        assert.equal(atBirth.born, true, "at absolute birth boundary for release time " + bornAtSec);
        assert.equal(atBirth.progress, 1);
        assert.equal(atBirth.coreMassSolar, 1);
        assert.equal(atBirth.gasMassSolar, 0);
    }
});

console.log("\nGas-cloud records and persistence");
test("formed identity is stable across repeat access and save/load", () => {
    const record = install();
    const time = birthOf(record) + 10;
    const original = neb.formedStarForNebula(0, time);
    const id = original.id;
    const rows = JSON.parse(JSON.stringify(neb.serializeNebulae()));
    assert.equal(neb.formedStarForNebula(0, time), original);
    neb.restoreNebulaRecords(rows);
    assert.equal(neb.formedStarForNebula(0, time).id, id);
    assert.deepEqual(neb.serializeNebulae(), rows);
});

test("identity is seeded, independent of access order, and survives index shifts", () => {
    const first = makeRecord();
    const second = makeRecord({ seed: first.seed + 1, xKm: 2 * LY_KM });
    neb.clearNebulaRecords();
    neb.addNebulaRecord(first);
    neb.addNebulaRecord(second);
    const time = birthOf(first) + 10;
    const idB = neb.formedStarForNebula(1, time).id;
    const idA = neb.formedStarForNebula(0, time).id;
    assert.notEqual(idA, idB);
    assert.equal(neb.removeNebulaRecord(0), true);
    const moved = neb.formedStarForNebula(0, time);
    assert.equal(moved.id, idB);
    assert.equal(moved.nebulaIndex, 0);
    neb.clearNebulaRecords();
    neb.addNebulaRecord(second);
    neb.addNebulaRecord(first);
    assert.equal(neb.formedStarForNebula(0, time).id, idB);
    assert.equal(neb.formedStarForNebula(1, time).id, idA);
});

test("nebula cap bounds clouds and their stars without evicting old records", () => {
    neb.clearNebulaRecords();
    const record = makeRecord();
    for (let i = 0; i < neb.NEB_MAX; i++) assert.equal(neb.addNebulaRecord(makeRecord({ seed: i, xKm: (i + 1) * LY_KM })), i);
    const before = JSON.stringify(neb.serializeNebulae());
    assert.equal(neb.addNebulaRecord(record), -1);
    assert.equal(neb.NEBULAE.length, neb.NEB_MAX);
    assert.equal(neb.formedStarsAt(birthOf(record) + 10).length, neb.NEB_MAX);
    assert.equal(new Set(neb.formedStarsAt(birthOf(record) + 10).map(star => star.id)).size, neb.NEB_MAX);
    assert.equal(JSON.stringify(neb.serializeNebulae()), before);
});

test("legacy six-field nebula tuples remain cosmetic and round-trip unchanged", () => {
    const rows = [[LY_KM, 0, 0, LY_KM, 1, 1234]];
    assert.equal(neb.restoreNebulaRecords(rows), 1);
    assert.equal(neb.NEBULAE[0].formation, undefined);
    assert.deepEqual(neb.serializeNebulae(), rows);
    assert.deepEqual(neb.formedStarsAt(1e18), []);
});

test("malformed tuples cannot create invalid positions, radii, or forming stars", () => {
    const validPose = [LY_KM, 0, 0, model.GAS_RADIUS_KM, 0, 9];
    const badFormation = { v: model.GAS_MODEL_VERSION, bornAtSec: 0, massSolar: -1 };
    neb.restoreNebulaRecords([
        null, {}, [], "wrong", [1, 2, 3],
        [Infinity, 0, 0, 1, 0, 1], [0, NaN, 0, 1, 0, 1],
        [0, 0, 0, -1, 0, 1], [0, 0, 0, 0, 0, 1],
        [...validPose, badFormation],
    ]);
    assert.ok(neb.NEBULAE.every(row => [row.xKm, row.yKm, row.zKm, row.radiusKm].every(Number.isFinite) && row.radiusKm > 0));
    assert.ok(neb.NEBULAE.every(row => !row.formation));
    assert.deepEqual(neb.formedStarsAt(1e18), []);
    for (const value of [null, {}, "invalid", 1]) assert.equal(neb.restoreNebulaRecords(value), 0);
});

test("unsupported or malformed formation metadata is rejected", () => {
    for (const value of [null, {}, { v: 99, bornAtSec: 0, massSolar: 1 },
        { v: model.GAS_MODEL_VERSION, bornAtSec: NaN, massSolar: 1 },
        { v: model.GAS_MODEL_VERSION, bornAtSec: 0, massSolar: Infinity },
        { v: model.GAS_MODEL_VERSION, bornAtSec: 0, massSolar: .01 }]) {
        assert.equal(model.normalizeFormation(value), null);
    }
});

test("formation reset removes clouds/newborns but retains cosmetic nebulae", () => {
    neb.restoreNebulaRecords([[LY_KM, 0, 0, LY_KM, 1, 1234]]);
    neb.addNebulaRecord(makeRecord());
    neb.clearFormingNebulaRecords();
    assert.equal(neb.NEBULAE.length, 1);
    assert.equal(neb.NEBULAE[0].formation, undefined);
    assert.deepEqual(neb.formedStarsAt(1e18), []);
});

console.log("\nFormed-star active integration");
test("birth invalidates the active-star cache inside the same catalog time bucket", () => {
    const record = install();
    const birth = birthOf(record);
    assert.equal(active.activeStarEvalTime(birth - 1), active.activeStarEvalTime(birth + 1));
    refresh(record, birth - 1);
    assert.equal(formed().length, 0);
    assert.equal(gravFormed().length, 0);
    assert.equal(active.activeStarForFocus("neb:0"), null);
    refresh(record, birth + 1);
    assert.equal(formed().length, 1);
    const star = formed()[0];
    assert.equal(active.activeStarForFocus("neb:0")?.id, star.id);
    assert.equal(active.activeStarFocusValue(star), "neb:0");
    assert.equal(gravFormed().length, 1);
    assert.ok(active.GRAVITY_STARS.includes(star));
    assert.ok(active.ACTIVE_STARS.length <= active.ACTIVE_STAR_CONFIG.totalLimit);
    for (let i = 0; i < 10; i++) refresh(record, birth + 1);
    assert.equal(formed().length, 1, "repeated paused refresh cannot duplicate newborns");
});

test("formed star uses standard gravity strength and a real stellar surface", () => {
    const record = install();
    refresh(record, birthOf(record) + 10);
    const star = formed()[0];
    assert.ok(star, "newborn must join ACTIVE_STARS");
    close(star.mu, MU_S * record.formation.massSolar, "stellar gravity parameter");
    close(star.R, R_SUN, "stellar photosphere radius");
    const x = star.x + star.R * 2;
    const sources = gravityStarsFor(x, star.y, star.z);
    assert.ok(sources.includes(star));
    const well = strongestActiveStarWell(sources, x, star.y, star.z);
    assert.equal(well?.star.id, star.id);
    assert.equal(well.dominant, true);
    close(well.acc, star.mu / (star.R * 2) ** 2, "standard inverse-square acceleration");
});

test("reverse removes active and gravity stars while preserving reusable cloud focus", () => {
    const record = install();
    const birth = birthOf(record);
    refresh(record, birth + 1);
    const id = formed()[0]?.id;
    assert.ok(id);
    refresh(record, birth - 1);
    assert.equal(formed().length, 0);
    assert.equal(gravFormed().length, 0);
    assert.equal(active.activeStarForFocus("neb:0"), null);
    refresh(record, record.formation.bornAtSec - 1);
    assert.equal(formed().length, 0);
    refresh(record, birth + 1);
    assert.equal(formed()[0]?.id, id);
});

test("reverse excludes a newborn only at its exact boundary, not one clock tick later", () => {
    const record = install(makeRecord({ formation: { v: model.GAS_MODEL_VERSION, bornAtSec: 1e21, massSolar: 1 } }));
    const birth = birthOf(record);
    const tick = 2 ** (Math.floor(Math.log2(birth)) - 52);
    assert.ok(birth + tick > birth && birth - tick < birth);
    active.refreshActiveStars(record.xKm, record.yKm, record.zKm, "neb:0", birth + tick, -1);
    assert.equal(formed().length, 1, "reverse must retain post-birth gravity until the boundary");
    assert.equal(gravFormed().length, 1);
    active.refreshActiveStars(record.xKm, record.yKm, record.zKm, "neb:0", birth, -1);
    assert.equal(formed().length, 0, "a reverse slice beginning exactly at birth uses the pre-birth side");
    assert.equal(gravFormed().length, 0);
    // Post-delivery/UI refresh describes the actual instant, not integration's
    // one-sided value. An unchanged exact-birth clock must still render a star.
    active.refreshActiveStars(record.xKm, record.yKm, record.zKm, "neb:0", birth, 0);
    assert.equal(formed().length, 1);
    assert.equal(gravFormed().length, 1);
    assert.equal(active.activeStarsExactTime(), birth);
});

test("same-count save replacement invalidates membership without stale newborns", () => {
    const first = install();
    const t = birthOf(first) + 10;
    refresh(first, t);
    const id = formed()[0]?.id;
    assert.ok(id);
    const replacement = makeRecord({ seed: first.seed + 1 });
    const row = [replacement.xKm, replacement.yKm, replacement.zKm, replacement.radiusKm, replacement.archetype, replacement.seed, replacement.formation];
    neb.restoreNebulaRecords([row]);
    refresh(replacement, t);
    assert.equal(formed().length, 1);
    assert.notEqual(formed()[0].id, id);
    assert.ok(!active.GRAVITY_STARS.some(star => star.id === id));
    neb.restoreNebulaRecords([row.slice(0, 6)]);
    refresh(replacement, t);
    assert.equal(formed().length, 0);
    assert.equal(gravFormed().length, 0);
});

test("loading a changed physical source cannot reuse stale stellar mass", () => {
    const first = install();
    const t = birthOf(first) + 10;
    refresh(first, t);
    assert.equal(formed()[0]?.mass, 1);
    const rows = neb.serializeNebulae();
    rows[0][6].massSolar = 3;
    neb.restoreNebulaRecords(rows);
    refresh(neb.NEBULAE[0], t);
    assert.equal(formed().length, 1);
    assert.equal(formed()[0].mass, 3);
    assert.equal(gravFormed()[0]?.mass, 3);
    assert.equal(active.activeStarForFocus("neb:0")?.mass, 3);
});

test("newborns do not automatically acquire mature planetary systems", () => {
    for (const massSolar of model.GAS_MASSES) for (let seed = 0; seed < 12; seed++) {
        // First populate the shared cache with a conventional stellar system:
        // focusing a newborn must discard it rather than leave stale planets.
        assert.ok(active.getFocusedSystem(STARS[0], 0));
        assert.ok(active.getCachedFocusedSystem());
        const record = install(makeRecord({ seed, formation: { v: model.GAS_MODEL_VERSION, bornAtSec: 0, massSolar } }));
        const time = birthOf(record) + 10;
        const star = neb.formedStarForNebula(0, time);
        assert.ok(star);
        assert.equal(active.getFocusedSystem(star, time)?.planets?.length || 0, 0);
        assert.equal(active.getCachedFocusedSystem()?.planets?.length || 0, 0);
    }
});

test("created stars retain active-pool slots even with a saturated catalog budget", () => {
    const record = install();
    const previous = active.ACTIVE_STAR_CONFIG.totalLimit;
    try {
        active.ACTIVE_STAR_CONFIG.totalLimit = 4;
        // Different focus/time bucket forces a full rebuild, not a cache hit.
        refresh(record, birthOf(record) + active.ACTIVE_STAR_EVAL_DT_S * 2, "neb:0");
        assert.equal(formed().length, 1);
        assert.ok(active.ACTIVE_STARS.length <= 4);
        assert.equal(gravFormed().length, 1);
    } finally {
        active.ACTIVE_STAR_CONFIG.totalLimit = previous;
    }
});

test("clearing source records removes every active/gravity star on refresh", () => {
    const record = install();
    const t = birthOf(record) + 10;
    refresh(record, t);
    assert.equal(formed().length, 1);
    neb.clearNebulaRecords();
    refresh(record, t);
    assert.equal(formed().length, 0);
    assert.equal(gravFormed().length, 0);
    assert.equal(active.activeStarForFocus("neb:0"), null);
});

test("formation never appends to or changes the curated STARS catalog", () => {
    assert.equal(STARS.length, initialStars.length);
    assert.ok(STARS.every((star, index) => star === initialStars[index]));
    assert.equal(JSON.stringify(STARS), initialCatalog);
});

neb.clearNebulaRecords();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
else console.log("gas-formation smoke passed");
