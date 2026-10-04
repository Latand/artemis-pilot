// Numerical gas runtime, checkpoints, bounded delivery, and active sources.
// Solver equations have independent coverage in smoke-gas-sph.mjs.
// Run: node scripts/smoke-gas-formation.mjs
import assert from 'node:assert/strict';

globalThis.window ??= {};
const { STARS, MU_S, LY_KM, R_SUN } = await import('../src/constants.js');
const model = await import('../src/universe/gasFormation.js');
const neb = await import('../src/universe/nebulaeData.js');
const active = await import('../src/universe/activeStars.js');
const { generateSystem } = await import('../src/universe/planetarySystem.js');
const state = await import('../src/state.js');
const ephem = await import('../src/ephemeris.js');
const physics = await import('../src/physics.js');
const { strongestActiveStarWell } = await import('../src/universe/starDominance.js');
const { stellarSurfaceHit } = await import('../src/universe/stellarContact.js');
const galacticClock = await import('../src/universe/galacticClock.js');
const originalStars = STARS.slice(), originalCatalog = JSON.stringify(STARS);
const clone = value => JSON.parse(JSON.stringify(value));
let passed = 0, failed = 0;
function test(label, fn) {
    try { fn(); passed++; console.log('  PASS  ' + label); }
    catch (error) { failed++; console.error('  FAIL  ' + label + '\n        ' + error.message); }
}
function close(actual, expected, label) {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-11 * Math.max(1, Math.abs(expected)), `${label}: ${actual} != ${expected}`);
}
function record(formation = {}, source = {}) {
    return { xKm: LY_KM, yKm: .125 * LY_KM, zKm: -.075 * LY_KM,
        radiusKm: model.GAS_RADIUS_KM, archetype: 0, seed: 2401, ...source,
        formation: model.normalizeFormation({ v: 2, bornAtSec: 12345, massSolar: 1,
            temperatureK: 10, radialVelocity: 0, ...formation }) };
}
const unit = r => model.gasNumericalView(r, r.formation.bornAtSec).a.unitTimeSec;
const at = (r, age) => r.formation.bornAtSec + age * unit(r);
function prepare(r, target, maxSteps = 4, from = target) {
    let calls = 0, steps = 0, result;
    do {
        result = model.prepareGas(r, target, maxSteps, from);
        assert.ok(result.steps >= 0 && result.steps <= Math.min(4, maxSteps));
        steps += result.steps;
        assert.ok(++calls <= 5000, 'bounded preparation did not finish');
        if (!result.ready) assert.ok(result.steps > 0, `preparation stalled: ${JSON.stringify(result)}`);
    } while (!result.ready);
    return { calls, steps, result };
}
function pair(r, t) {
    const v = model.gasNumericalView(r, t), age = v.ageSec;
    assert.equal(v.ready, true, 'target must have a prepared numerical bracket');
    assert.ok(v.a.ageSec <= age, 'past bracket cannot be from the future');
    assert.ok(v.b.ageSec >= age, 'future bracket must cover target');
    assert.ok(v.blend >= 0 && v.blend <= 1);
    assert.ok(v.b.steps - v.a.steps <= 1, 'a render bracket must not bridge missing numerical history');
    return { a: v.a, b: v.b, blend: v.blend };
}
function install(r = record()) {
    neb.clearNebulaRecords(); assert.equal(neb.addNebulaRecord(r), 0); return neb.NEBULAE[0];
}
function refresh(r, t) { active.refreshActiveStars(r.xKm + r.radiusKm, r.yKm, r.zKm, 'neb:0', t); }
const sinks = () => active.ACTIVE_STARS.filter(s => s.formedStar);
const gravity = () => active.GRAVITY_STARS.filter(s => s.formedStar);

console.log('\nNumerical gas runtime');
test('v2 physical options survive normalization; timed v1 sources migrate as initial gas', () => {
    assert.equal(model.GAS_MODEL_VERSION, 3);
    for (const massSolar of [.3, 1, 3]) for (const temperatureK of [10, 30, 200]) for (const radialVelocity of [0, 3]) {
        const f = model.normalizeFormation({ v: 2, bornAtSec: -100, massSolar, temperatureK, radialVelocity });
        assert.deepEqual([f.v, f.massSolar, f.temperatureK, f.radialVelocity, f.particleCount], [3, massSolar, temperatureK, radialVelocity, 96]);
    }
    const old = record({ v: 1, checkpoint: { current: { sink: { mass: 1 } } } });
    assert.equal(old.formation.checkpoint, undefined);
    assert.equal(model.gasStateAt(old, at(old, 100)).coreMassSolar, 0);
    for (const value of [null, {}, { v: 99, bornAtSec: 0, massSolar: 1 }, { v: 2, bornAtSec: NaN, massSolar: 1 }, { v: 2, bornAtSec: 0, massSolar: -1 }]) assert.equal(model.normalizeFormation(value), null);
});
test('elapsed time and render reads alone cannot shrink gas or create a sink', () => {
    const r = record(); Object.freeze(r.formation); Object.freeze(r);
    const initial = clone(model.gasNumericalView(r, r.formation.bornAtSec).a);
    for (const age of [0, 1, 5, 1000]) {
        const t = at(r, age), s = model.gasStateAt(r, t);
        assert.equal(s.born, false); assert.equal(s.coreMassSolar, 0); assert.equal(s.steps, 0);
        assert.equal(s.gasMassSolar, 1); assert.deepEqual(model.gasNumericalView(r, t).a, initial);
    }
    const before = model.gasStateAt(r, r.formation.bornAtSec - 1);
    assert.equal(before.present, false); assert.equal(before.coreMassSolar + before.gasMassSolar, 0);
});
test('zero work cannot fulfil future time; oversized work budgets are capped at four steps', () => {
    const r = record(), target = at(r, 5), initial = clone(model.gasNumericalView(r, r.formation.bornAtSec).a);
    const zero = model.prepareGas(r, target, 0);
    assert.equal(zero.ready, false); assert.equal(zero.steps, 0);
    assert.deepEqual(model.gasNumericalView(r, target).a, initial);
    const bounded = model.prepareGas(r, target, 1e9);
    assert.equal(bounded.ready, false); assert.equal(bounded.steps, 4);
    assert.ok(bounded.coveredSec < target); assert.equal(model.gasStateAt(r, target).born, false);
});
const cold = record(), hot = record({ temperatureK: 200 }), outward = record({ radialVelocity: 3 });
test('cold gas numerically forms a sink; equally old hot and unbound clouds disperse without one', () => {
    for (const r of [cold, hot, outward]) {
        const work = prepare(r, at(r, 5)), s = model.gasStateAt(r, at(r, 5));
        assert.ok(work.steps > 100); assert.equal(s.ready, true);
        close(s.gasMassSolar + s.coreMassSolar, 1, 'mass budget');
    }
    assert.ok(model.gasStateAt(cold, at(cold, 5)).coreMassSolar > .5);
    assert.ok(model.gasKnownBirth(cold) > 0);
    for (const r of [hot, outward]) {
        const s = model.gasStateAt(r, at(r, 5));
        assert.equal(s.born, false); assert.equal(s.coreMassSolar, 0);
        assert.equal(model.gasKnownBirth(r), null); assert.equal(s.phase, 'Dispersing gas');
    }
});
test('ready paused states are exact and runtime history/checkpoints are bounded', () => {
    const t = at(hot, 5), expected = clone(pair(hot, t));
    for (let i = 0; i < 50; i++) {
        const p = model.prepareGas(hot, t, 4);
        assert.equal(p.ready, true); assert.equal(p.steps, 0); assert.deepEqual(pair(hot, t), expected);
    }
    for (const r of [cold, hot, outward]) {
        const stats = model.gasRuntimeStats(r);
        assert.ok(stats.history <= 24 && stats.checkpoints <= 32);
    }
});
test('many clock partitions and one bounded direct request produce identical canonical states', () => {
    const direct = record(), framed = record(), target = at(direct, 1.65);
    prepare(direct, target);
    for (let i = 1; i <= 73; i++) prepare(framed, at(framed, 1.65 * i / 73), 1 + i % 4);
    assert.deepEqual(pair(framed, target), pair(direct, target));
    assert.deepEqual(model.gasStateAt(framed, target), model.gasStateAt(direct, target));
});
test('a prepared bracket uses pre-birth mass until the exact numerical sink step', () => {
    const r = record(); prepare(r, at(r, 1.65));
    const birth = model.gasKnownBirth(r), before = r.formation.bornAtSec + birth - 1;
    assert.ok(birth > 0); prepare(r, before);
    const v = pair(r, before), s = model.gasStateAt(r, before);
    assert.equal(v.a.sink.mass, 0); assert.equal(s.born, false); assert.equal(s.coreMassSolar, 0);
    assert.ok(v.b.ageSec >= birth);
    prepare(r, r.formation.bornAtSec + birth);
    assert.equal(model.gasStateAt(r, r.formation.bornAtSec + birth).born, true);
});
test('an unprepared old render query never exposes a future snapshot or sink mass', () => {
    const t = at(cold, .1), v = model.gasNumericalView(cold, t);
    assert.equal(v.ready, false);
    assert.ok(v.a.ageSec <= t - cold.formation.bornAtSec, 'future checkpoint leaked into past render state');
    assert.equal(model.gasStateAt(cold, t).coreMassSolar, 0); assert.equal(model.gasStateAt(cold, t).born, false);
});
test('deep-epoch absolute sink boundaries select the numerical sample without cancellation errors', () => {
    for (const bornAtSec of [1e17, 1e21]) {
        const r = record({ bornAtSec }); prepare(r, at(r, 1.6));
        const birth = model.gasKnownBirth(r), absolute = bornAtSec + birth;
        assert.ok(birth > 0);
        const tick = 2 ** (Math.floor(Math.log2(absolute)) - 52);
        const before = model.gasStateAt(r, absolute - tick);
        assert.equal(before.ready, true); assert.equal(before.born, false); assert.equal(before.coreMassSolar, 0);
        const exact = model.gasStateAt(r, absolute);
        assert.equal(exact.ready, true); assert.equal(exact.born, true);
        assert.equal(exact.computedAgeSec, birth);
        assert.equal(exact.sinkBornAtSec, absolute);
        pair(r, absolute);
        const restored = record(clone(model.serializeGasFormation(r, absolute)));
        assert.deepEqual(pair(restored, absolute), pair(r, absolute));
    }
});

console.log('\nCheckpoint persistence and replay');
test('checkpoint save/load preserves intermediate brackets and deterministic continuation', () => {
    const original = record(), t = at(original, 1.49); prepare(original, t);
    const restored = record(clone(model.serializeGasFormation(original, t)));
    assert.deepEqual(pair(restored, t), pair(original, t));
    const future = at(original, 1.65); prepare(original, future); prepare(restored, future);
    assert.deepEqual(pair(restored, future), pair(original, future));
});
test('saved checkpoint data is detached from subsequent solver mutations', () => {
    const r = record(), t = at(r, .5); prepare(r, t);
    const saved = model.serializeGasFormation(r, t), before = JSON.stringify(saved);
    prepare(r, at(r, 2)); assert.equal(JSON.stringify(saved), before);
});
test('malformed or physically incompatible checkpoints fall back to seeded initial gas', () => {
    const r = record(), t = at(r, 1.6); prepare(r, t);
    const saved = clone(model.serializeGasFormation(r, t));
    for (const checkpoint of [{}, { previous: null, current: null }, { previous: saved.checkpoint.previous, current: { ...saved.checkpoint.current, ageSec: NaN } }]) {
        const restored = record({ ...saved, checkpoint });
        assert.equal(model.gasStateAt(restored, t).steps, 0); assert.equal(model.gasStateAt(restored, t).coreMassSolar, 0);
    }
    const changed = record({ ...saved, massSolar: 3 });
    assert.equal(model.gasStateAt(changed, t).steps, 0); assert.equal(model.gasStateAt(changed, t).coreMassSolar, 0);
});
test('nonadjacent saved checkpoints cannot pretend missing middle history is ready', () => {
    const r = record(), initial = clone(model.gasNumericalView(r, r.formation.bornAtSec).a);
    prepare(r, at(r, 1.65));
    const saved = clone(model.serializeGasFormation(r, at(r, 1.65)));
    saved.checkpoint.previous = initial;
    const restored = record(saved), target = at(restored, 1.4);
    assert.equal(model.gasNumericalView(restored, target).ready, false);
    assert.equal(model.gasStateAt(restored, target).coreMassSolar, 0);
    prepare(restored, target);
    const reference = record(); prepare(reference, target);
    assert.deepEqual(pair(restored, target), pair(reference, target));
});
test('reverse seek holds the world clock during bounded replay and matches a fresh trajectory', () => {
    const r = install(record({ temperatureK: 200 })), far = at(r, 5), target = at(r, .2);
    prepare(r, far); const reference = record({ temperatureK: 200 }); prepare(reference, target);
    let calls = 0, pending = 0, result;
    do {
        result = neb.prepareGasAdvance(far, target - far); assert.ok(result.steps <= 4);
        if (result.limited) { pending++; assert.equal(result.advance, 0); assert.match(result.reason, /replay/i); }
        assert.ok(++calls < 1000, 'reverse replay failed to finish');
    } while (result.limited);
    assert.ok(pending > 0); assert.equal(result.advance, target - far);
    assert.deepEqual(pair(r, target), pair(reference, target));
});
test('paused numerical catch-up performs bounded work without advancing world time', () => {
    const r = install(), target = at(r, .3); let calls = 0, result;
    do {
        result = neb.preparePausedGas(target); assert.equal(result.advance, 0); assert.ok(result.steps <= 4);
        assert.ok(++calls < 1000);
    } while (result.limited);
    assert.ok(calls > 1); assert.equal(model.gasStateAt(r, target).ready, true);
    assert.equal(neb.preparePausedGas(target).steps, 0);
});

console.log('\nShared numerical delivery and active sources');
test('large requested world advances are limited by performed gas work', () => {
    const r = install(), t = r.formation.bornAtSec, requested = 5 * unit(r);
    const result = neb.prepareGasAdvance(t, requested);
    assert.equal(result.steps, 4); assert.equal(result.limited, true);
    assert.ok(result.advance > 0 && result.advance < requested); assert.match(result.reason, /gas.*budget/i);
    assert.equal(model.gasStateAt(r, t).steps, 0); assert.equal(neb.formedStarsAt(t).length, 0);
});
test('four clouds share four total steps fairly and never form ahead of the delivered clock', () => {
    neb.clearNebulaRecords();
    const configs = [{}, { temperatureK: 200 }, { radialVelocity: 3 }, { massSolar: .3 }];
    for (let i = 0; i < configs.length; i++) assert.equal(neb.addNebulaRecord(record(configs[i], { xKm: (i + 1) * LY_KM })), i);
    const clouds = neb.NEBULAE.slice(), work = clouds.map(() => 0);
    let t = clouds[0].formation.bornAtSec, calls = 0;
    const target = at(clouds[0], 1.65);
    while (t < target) {
        const result = neb.prepareGasAdvance(t, target - t);
        assert.ok(result.steps <= 4); assert.ok(result.advance >= 0 && result.advance <= target - t);
        let frameWork = 0;
        for (let i = 0; i < clouds.length; i++) {
            const r = clouds[i]; pair(r, t);
            const steps = model.gasRuntimeStats(r).steps; work[i] += steps; frameWork += steps;
            const s = model.gasStateAt(r, t), birth = model.gasKnownBirth(r);
            if (birth === null || t - r.formation.bornAtSec < birth) assert.equal(s.coreMassSolar, 0);
            assert.equal(!!neb.formedStarForNebula(i, t), s.born && s.ready);
        }
        assert.equal(frameWork, result.steps); t += result.advance;
        assert.ok(++calls <= 5000, 'shared delivery stalled or starved a cloud');
    }
    assert.ok(work.every(n => n > 0));
    for (const r of clouds) {
        const reference = record(r.formation, { seed: r.seed, xKm: r.xKm }); prepare(reference, target);
        assert.deepEqual(pair(r, target), pair(reference, target));
        const s = model.gasStateAt(r, target); close(s.gasMassSolar + s.coreMassSolar, r.formation.massSolar, 'shared mass');
    }
});
test('look-ahead cannot keep integrating arbitrary future time while the clock is held', () => {
    const r = record(), release = r.formation.bornAtSec, target = at(r, 5); let steps = 0;
    for (let i = 0; i < 40; i++) steps += model.prepareGas(r, target, 4, release).steps;
    assert.ok(steps <= 4); assert.equal(model.gasStateAt(r, release).coreMassSolar, 0); assert.equal(model.gasStateAt(r, release).steps, 0);
});
test('only a numerically created sink joins active gravity and receives no automatic planets', () => {
    const r = install(), t = at(r, 1.65); refresh(r, t);
    assert.equal(sinks().length, 0); assert.equal(gravity().length, 0);
    prepare(r, t); const s = model.gasStateAt(r, t); refresh(r, t);
    assert.ok(s.born && s.coreMassSolar > 0 && s.coreMassSolar < 1);
    assert.equal(sinks().length, 1); assert.equal(gravity().length, 1);
    const star = sinks()[0]; assert.equal(star.gasSink, true); assert.equal(star.kind, 'protostar');
    close(star.mu, MU_S * s.coreMassSolar, 'sink gravity'); close(star.mass + s.gasMassSolar, 1, 'no doubled gas mass');
    assert.equal(star.R, s.stellar.radiusKm);
    assert.equal(star.sinkRadiusKm, s.sinkRadiusKm); assert.equal(active.activeStarFocusValue(star), 'neb:0');
    assert.equal(active.activeStarForFocus('neb:0'), star);
    assert.equal(generateSystem(star).planets.length, 0); assert.equal(active.getFocusedSystem(star, t), null);
});
test('active sink mass follows accretion and replay removes the source before actual birth', () => {
    const r = install(), t = at(r, 1.6); prepare(r, t); refresh(r, t);
    const id = sinks()[0]?.id, mass = sinks()[0]?.mass; assert.ok(id && mass > 0);
    const later = at(r, 2); prepare(r, later); refresh(r, later);
    assert.equal(sinks()[0].id, id); assert.ok(sinks()[0].mass >= mass);
    close(sinks()[0].mass, model.gasStateAt(r, later).coreMassSolar, 'accreted active mass');
    const past = at(r, .2); prepare(r, past, 4, later); refresh(r, past);
    assert.equal(sinks().length, 0); assert.equal(gravity().length, 0); assert.equal(active.activeStarForFocus('neb:0'), null);
});
test('seeded sink identity and numerical checkpoints survive a complete nebula save/load', () => {
    const r = install(), t = at(r, 1.65); prepare(r, t); refresh(r, t);
    const id = sinks()[0].id, expected = clone(pair(r, t)), rows = clone(neb.serializeNebulae(t));
    assert.equal(neb.restoreNebulaRecords(rows), 1); const restored = neb.NEBULAE[0];
    assert.deepEqual(pair(restored, t), expected); refresh(restored, t);
    assert.equal(sinks()[0].id, id); assert.equal(gravity().length, 1);
    neb.clearNebulaRecords(); refresh(restored, t); assert.equal(sinks().length, 0); assert.equal(gravity().length, 0);
});
test('capacity, duplicate identities, legacy cosmetic nebulae, and malformed saves stay bounded', () => {
    neb.clearNebulaRecords();
    for (let i = 0; i < neb.NEB_MAX; i++) assert.equal(neb.addNebulaRecord(record({}, { seed: 2401 + i })), i);
    assert.equal(neb.addNebulaRecord(record({}, { seed: 9999 })), -1); assert.equal(neb.NEBULAE.length, neb.NEB_MAX);
    neb.clearNebulaRecords(); const r = record(); assert.equal(neb.addNebulaRecord(r), 0); assert.equal(neb.addNebulaRecord(r), -1);
    const legacy = [[LY_KM, 0, 0, LY_KM, 1, 1234]];
    assert.equal(neb.restoreNebulaRecords(legacy), 1); assert.deepEqual(neb.serializeNebulae(), legacy); assert.equal(neb.formedStarsAt(1e20).length, 0);
    for (const value of [null, {}, 'bad', 1, [null, {}, [], [Infinity, 0, 0, 1, 0, 1], [0, 0, 0, -1, 0, 1]]]) assert.equal(neb.restoreNebulaRecords(value), 0);
});
test('empty and initialized numerical preparation preserve signed sub-ULP clock deltas', () => {
    const t = 1e21; neb.clearNebulaRecords();
    for (const dt of [1, -1]) assert.equal(neb.prepareGasAdvance(t, dt).advance, dt);
    install(record({ bornAtSec: t }));
    for (const dt of [1, -1]) {
        const p = neb.prepareGasAdvance(t, dt); assert.equal(p.advance, dt); assert.equal(p.steps, 0);
        assert.equal(neb.nextFormationBoundary(t, dt), dt);
    }
});
test('reset preserves catalog identity/genesis and same-time state while removing numerical sources', () => {
    neb.restoreNebulaRecords([[LY_KM, 0, 0, LY_KM, 1, 1234]]); neb.addNebulaRecord(record());
    // Earlier refresh fixtures deliberately visited other epochs. Catalog
    // positions now move; compare cleanup at one epoch, then verify the exact
    // genesis snapshot and round-trip back, rather than discarding positions.
    const timeBefore = galacticClock.galacticFrameTime();
    const catalogBefore = JSON.stringify(STARS);
    const scenarioBefore = clone({ G: state.G, WORLD: state.WORLD, BH: state.BH, GS: state.GS });
    neb.clearFormingNebulaRecords();
    assert.equal(neb.NEBULAE.length, 1); assert.equal(neb.NEBULAE[0].formation, undefined);
    assert.equal(STARS.length, originalStars.length); assert.ok(STARS.every((s, i) => s === originalStars[i]));
    assert.equal(galacticClock.galacticFrameTime(), timeBefore, 'Gas cleanup cannot alter the published clock');
    assert.equal(JSON.stringify(STARS), catalogBefore, 'Gas cleanup cannot change catalog fields or positions at the same time');
    assert.deepEqual(clone({ G: state.G, WORLD: state.WORLD, BH: state.BH, GS: state.GS }), scenarioBefore, 'Unrelated scenario state is preserved');
    galacticClock.syncGalacticFrame(0);
    assert.equal(JSON.stringify(STARS), originalCatalog, 'Identity, immutable genesis and canonical epoch coordinates survive all gas fixtures');
    galacticClock.syncGalacticFrame(timeBefore);
    assert.equal(JSON.stringify(STARS), catalogBefore, 'Catalog state is the exact canonical sample at the original time');
});

console.log('\nNumerical sink force and contact integration');
let integratedSink;
function sinkForPhysics() {
    if (!integratedSink) {
        const initial = record(), r = install(record({ bornAtSec: -1.65 * unit(initial) }));
        prepare(r, 0); refresh(r, 0);
        integratedSink = sinks()[0];
        assert.ok(integratedSink?.gasSink && gravity().includes(integratedSink));
    }
    return integratedSink;
}
function isolatePhysics() {
    state.resetWorld(); ephem.resetEphem(); state.resetShip();
    Object.assign(state.G, { focus: 'ship', gr: false, darkEnergy: false, darkMatter: false, warp: 60 });
    state.BH.n = 0; state.GS.length = 0;
    state.WORLD.earthDestroyed = state.WORLD.moonDestroyed = state.WORLD.sunDestroyed = true;
    state.WORLD.plDestroyed.fill(1);
    physics.initPhysicsHooks({
        die(reason) { state.G.dead = true; state.G.deadReason = reason; },
        award() {}, banner() {}, hideBanner() {},
    });
}
function relativeForce(actual, expected, label) {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(1e-25, Math.abs(expected) * 1e-9),
        `${label}: ${actual} != ${expected}`);
}
function shipAt(star, offset) {
    Object.assign(state.G, {
        x: star.x - ephem.eph.earthX + offset, y: star.y - ephem.eph.earthY, z: star.z,
        vx: 0, vy: 0, vz: 0, dead: false, landed: null,
    });
}
test('ephemeris and ship derivative use finite Plummer sink forces and ordinary inverse-square gravity', () => {
    isolatePhysics();
    // A standalone softened-star compatibility control. Real formed stars
    // now get their sole gravity from the explicit gas+core aggregate.
    const sink = { ...sinkForPhysics(), formedStar: false }, ordinary = { ...sink, gasSink: false, softeningKm: 0, R: R_SUN };
    neb.clearNebulaRecords();
    for (const source of [sink, ordinary]) {
        ephem.beginPredictionStars([source]); // isolates the same shared field used by live ship/body integration
        try {
            for (const multiplier of (source.gasSink ? [0, .1, 1, 10] : [.1, 1, 10])) {
                shipAt(source, sink.softeningKm * multiplier);
                const { x, y, z } = state.G;
                const dx = x - (source.x - ephem.eph.earthX), dy = y - (source.y - ephem.eph.earthY), dz = z - source.z;
                const r2 = dx * dx + dy * dy + dz * dz + source.softeningKm ** 2;
                const w = r2 > 0 ? source.mu / r2 ** 1.5 : 0;
                const expected = [-w * dx, -w * dy, -w * dz], field = [0, 0, 0], derivative = new Float64Array(6);
                ephem.relGravityAt3(x, y, z, field);
                physics.deriv(x, y, z, 0, 0, 0, 0, 0, 0, 0, derivative);
                for (let axis = 0; axis < 3; axis++) {
                    relativeForce(field[axis], expected[axis], 'ephemeris force');
                    relativeForce(derivative[axis + 3], expected[axis], 'ship derivative force');
                }
            }
        } finally { ephem.endPredictionStars(); }
    }
});
test('softened cores disable inner Kepler dominance while ordinary stars retain it', () => {
    const sink = sinkForPhysics(), ordinary = { ...sink, gasSink: false, softeningKm: 0, R: R_SUN };
    const distance = 2 * sink.softeningKm;
    const well = strongestActiveStarWell([sink], sink.x + distance, sink.y, sink.z);
    relativeForce(well.acc, sink.mu * distance / (distance * distance + sink.softeningKm ** 2) ** 1.5, 'softened dominance estimate');
    assert.equal(well.dominant, false, 'point-mass conics are invalid inside the softened core');
    assert.equal(strongestActiveStarWell([ordinary], ordinary.x + distance, ordinary.y, ordinary.z).dominant, true);
    assert.equal(strongestActiveStarWell([sink], sink.x + 20 * sink.softeningKm, sink.y, sink.z).dominant, true);
});
test('the shared live/prediction contact rule excludes numerical sinks and preserves ordinary star/BH surfaces', () => {
    const sink = sinkForPhysics();
    for (const distance of [0, sink.R * .5, sink.R, sink.R * 2]) {
        assert.equal(stellarSurfaceHit(sink, distance * distance), false, 'prediction must not stop at the sink control radius');
    }
    for (const star of [{ R: R_SUN }, { bh: true, R: 3e5, rs: 1e5 }]) {
        assert.equal(stellarSurfaceHit(star, 0), true);
        assert.equal(stellarSurfaceHit(star, (.5 * star.R) ** 2), true);
        assert.equal(stellarSurfaceHit(star, star.R ** 2), true);
        assert.equal(stellarSurfaceHit(star, (1.001 * star.R) ** 2), false);
    }
    assert.equal(stellarSurfaceHit(null, 0), false);
    assert.equal(stellarSurfaceHit({ R: 0 }, 0), false);
});
test('live ship integration survives the numerical control radius and exact sink center', () => {
    const sink = sinkForPhysics();
    for (const offset of [sink.R * .5, 0]) {
        isolatePhysics(); shipAt(sink, offset);
        ephem.beginPredictionStars([sink]);
        try {
            const delivered = physics.advance(.1, 0, 0, 0, 0);
            assert.equal(delivered, .1);
            assert.equal(state.G.dead, false, 'numerical accretion radius is not a lethal stellar surface');
            assert.ok([state.G.x, state.G.y, state.G.z, state.G.vx, state.G.vy, state.G.vz].every(Number.isFinite));
            assert.equal(physics.orbitInfo().domStar, false, 'core entry must stay on the softened integration path');
        } finally { ephem.endPredictionStars(); }
    }
});
test('ordinary stellar photosphere contact remains lethal in the live ship integrator', () => {
    isolatePhysics();
    const ordinary = { ...sinkForPhysics(), name: 'CONTROL STAR', gasSink: false, softeningKm: 0, R: R_SUN };
    shipAt(ordinary, ordinary.R * .5);
    ephem.beginPredictionStars([ordinary]);
    try {
        physics.advance(.1, 0, 0, 0, 0);
        assert.equal(state.G.dead, true);
        assert.match(state.G.deadReason, /CONTROL STAR.*photosphere/);
    } finally { ephem.endPredictionStars(); }
});
neb.clearNebulaRecords();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
else console.log('numerical gas-formation runtime smoke passed');
