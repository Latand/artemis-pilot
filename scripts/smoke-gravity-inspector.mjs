// Headless regression for the diagnostic ledger and its shared live force paths.
import assert from 'node:assert/strict';
globalThis.window = {};
const { getLocalGravityInspection } = await import('../src/gravityInspection.js');
const { G, WORLD, BH, GS, EPHT, resetWorld, bhRegister, addPhantom } = await import('../src/state.js');
const { PL, LY_KM, MU_S, MU_E, C_LIGHT, R_EARTH } = await import('../src/constants.js');
const {
    eph, resetEphem, snapshotEphem, loadEphemSnapshot, relGravityAt3,
    bodyGravityAcceleration, earthGravityAcceleration, holeGravityAcceleration, gasSystemGravityAcceleration,
    advanceEphemSnapshotBounded, advanceEphemSnapshot, ephemPredictionStepSize, IDX_MOON, IDX_SUN, IDX_PLANETS,
    beginPredictionStars, endPredictionStars, beginPredictionBH, endPredictionBH, pairG, pairRadius,
} = await import('../src/ephemeris.js');
const { deriv, shipGravityAt3 } = await import('../src/physics.js');
const { GRAVITY_STARS, ACTIVE_STARS } = await import('../src/universe/activeStars.js');
const { NEBULAE, addNebulaRecord, clearNebulaRecords, formedStarForNebula } = await import('../src/universe/nebulaeData.js');
const { prepareGas, gasNumericalView, gasStateAt } = await import('../src/universe/gasFormation.js');
const { gasGravitySources, gasFieldAt, beginPredictionGas, endPredictionGas, invalidateGasDynamics } = await import('../src/universe/gasDynamics.js');
const { setEpochMs, J2000_MS } = await import('../src/epoch.js');
setEpochMs(J2000_MS);
let passed = 0;
function test(label, fn) { fn(); ++passed; console.log('PASS ' + label); }
function reset() {
    clearNebulaRecords(); endPredictionGas(); resetWorld(); BH.n = 0; GRAVITY_STARS.length = 0; ACTIVE_STARS.length = 0;
    endPredictionStars(); resetEphem();
    Object.assign(G, { t: 0, x: R_EARTH + 1000, y: 80, z: 120, vx: 1, vy: 7, vz: .4,
        darkEnergy: true, darkMatter: true, focus: 'ship', dead: false, landed: null });
}
function state() { return structuredClone({ G, WORLD, BH, GS, EPHT, eph, ephem: snapshotEphem(), GRAVITY_STARS, ACTIVE_STARS, NEBULAE,
    gas: NEBULAE.filter(n => n.formation).map(n => gasNumericalView(n, EPHT.t)) }); }
function check(focus) {
    const before = state();
    const result = getLocalGravityInspection(focus);
    assert.deepEqual(state(), before, 'inspection must not mutate observable state');
    if (!result.supported) { assert.equal(result.net, null); assert.equal(result.contributions.length, 0); return result; }
    assert.ok(result.position.every(Number.isFinite));
    for (let a = 0; a < 3; a++) {
        let sum = 0, scale = 0;
        for (const row of result.contributions) {
            assert.ok(row.acceleration.every(Number.isFinite));
            assert.ok(row.position === null || row.position.every(Number.isFinite));
            sum += row.acceleration[a]; scale += Math.abs(row.acceleration[a]);
        }
        assert.ok(Math.abs(sum - result.net[a]) <= 1e-13 * scale + 1e-28,
            `${focus} contribution sum axis ${a}: ${sum} vs ${result.net[a]}`);
    }
    const expected = [0, 0, 0], st = snapshotEphem();
    if (focus === 'ship') shipGravityAt3(G.x, G.y, G.z, G.vx, G.vy, G.vz, expected);
    else if (focus === 'earth') earthGravityAcceleration(st, expected);
    else if (typeof focus === 'string' && focus.startsWith('neb:')) gasSystemGravityAcceleration(st, NEBULAE[Number(focus.slice(4))], expected);
    else if (typeof focus === 'string' && focus.startsWith('bh:')) holeGravityAcceleration(st, Number(focus.slice(3)), expected);
    else bodyGravityAcceleration(st, focus === 'moon' ? IDX_MOON : focus === 'sun' ? IDX_SUN : IDX_PLANETS + focus, expected);
    assert.deepEqual(result.net, expected, 'tracing must preserve the exact untraced acceleration');
    return result;
}
reset();
test('ship, Earth, Moon, Sun and every planet sum to the exact solver result without side effects', () => {
    for (const f of ['ship', 'earth', 'moon', 'sun', ...PL.map((_, i) => i)]) check(f);
});
test('ship gravity agrees with RK4 in vacuum and exposes J2 / PN without drag or thrust', () => {
    let result = check('ship'), d = [];
    deriv(G.x, G.y, G.z, G.vx, G.vy, G.vz, 0, 0, 0, 0, d);
    assert.deepEqual(result.net, d.slice(3));
    assert.ok(result.contributions.some(r => r.id === 'earth:j2'));
    Object.assign(G, { x: eph.sunX + 2e7, y: eph.sunY + 2e6, z: 1e6 });
    result = check('ship');
    assert.ok(result.contributions.some(r => r.id === 'sun:1pn'));
    deriv(G.x, G.y, G.z, G.vx, G.vy, G.vz, 0, 0, 0, 0, d);
    assert.deepEqual(result.net, d.slice(3));
    Object.assign(G, { x: R_EARTH + 10, y: 0, z: 0 });
    result = check('ship');
    deriv(G.x, G.y, G.z, G.vx, G.vy, G.vz, 0, 1, 2, 3, d);
    assert.notDeepEqual(result.net, d.slice(3));
});
test('self forces, destroyed targets and destroyed sources are excluded; Earth world z is pinned', () => {
    reset();
    const earth = check('earth');
    assert.equal(earth.net[2], 0);
    assert.ok(earth.contributions.some(r => r.id === 'frame:pinned-z' && r.acceleration[2] !== 0));
    assert.ok(!earth.contributions.some(r => r.id === 'earth'));
    assert.ok(!check('moon').contributions.some(r => r.id === 'moon'));
    assert.ok(!check('sun').contributions.some(r => r.id === 'sun'));
    for (let i = 0; i < PL.length; i++) assert.ok(!check(i).contributions.some(r => r.id === 'planet:' + i));
    WORLD.sunDestroyed = true; WORLD.plDestroyed[3] = 1;
    assert.equal(check('sun').supported, false);
    assert.equal(check(3).supported, false);
    assert.ok(!check('ship').contributions.some(r => ['sun', 'sun:1pn', 'planet:3'].includes(r.id)));
    WORLD.earthDestroyed = true;
    assert.equal(check('earth').supported, false);
    for (const f of ['ship', 'moon', 0]) {
        const r = check(f);
        assert.ok(!r.contributions.some(row => row.id === 'earth'));
        assert.ok(r.contributions.filter(row => row.id === 'frame:earth').every(row => row.acceleration.every(v => v === 0)));
    }
});
test('placed holes use shared pair laws, exclude self, and honor retarded mass fronts', () => {
    reset(); BH.n = 2;
    bhRegister(0, 1000, 20, 1e-12, 0, 0, null, 0, 0, 30);
    bhRegister(1, 2e6, 3e5, 3, 0, 0, null, 0, 0, -1e5);
    for (const f of ['ship', 'earth', 'moon', 'sun', 0, 'bh:0', 'bh:1']) check(f);
    const h = check('bh:0');
    assert.ok(!h.contributions.some(r => r.id === 'bh:0'));
    assert.equal(h.predictionSupported, false);
    const r = Math.hypot(BH.x[0], BH.y[0], BH.z[0]);
    const w = MU_E * pairG(r, BH.rs[0], pairRadius(MU_E, R_EARTH, BH.mu[0])) / r;
    assert.deepEqual(h.contributions.find(row => row.id === 'earth').acceleration,
        [-w * BH.x[0], -w * BH.y[0], -w * BH.z[0]]);
    BH.ev[1] = [{ x: BH.x[1], y: BH.y[1], z: BH.z[1], t: EPHT.t, dmu: BH.mu[1] }];
    assert.ok(!check('ship').contributions.some(row => row.id === 'bh:1'));
});
test('only active stellar sources are used, with sink softening and the live near-Sun gate', () => {
    reset();
    const star = { id: 'test', name: 'Test star', x: LY_KM + 1e5, y: 2e4, z: 3e4, mu: MU_S, R: 7e5 };
    const sink = { id: 'sink', name: 'Test sink', x: LY_KM - 1e5, y: 8e4, z: -2e4, mu: MU_S, softeningKm: 4e5, gasSink: true };
    GRAVITY_STARS.push(star, sink); ACTIVE_STARS.push(star, sink, { ...star, id: 'not-gravitating' });
    assert.ok(!check('ship').contributions.some(r => r.kind === 'star' || r.kind === 'sink'));
    beginPredictionStars([...GRAVITY_STARS], true);
    assert.ok(!check('ship').contributions.some(r => r.kind === 'star' || r.kind === 'sink'));
    endPredictionStars();
    Object.assign(G, { x: LY_KM - eph.earthX, y: -eph.earthY, z: 5e4 });
    const result = check('ship');
    assert.deepEqual(result.contributions.filter(r => r.kind === 'star' || r.kind === 'sink').map(r => r.id), ['star:test', 'star:sink']);
    const field = [0, 0, 0], traced = [0, 0, 0], rows = [];
    relGravityAt3(G.x, G.y, G.z, field);
    relGravityAt3(G.x, G.y, G.z, traced, -1, null, 0, null, rows);
    assert.deepEqual(field, traced);
    assert.ok(rows.find(r => r.id === 'star:sink').acceleration.every(Number.isFinite));
    // Exercise the body and Earth stellar paths even though the production
    // near-Sun gate normally suppresses them: use the existing prediction set.
    beginPredictionStars([star, sink]);
    for (const f of ['earth', 'moon', 0]) check(f);
    endPredictionStars();
});
test('transient softened fields and enabled cosmology remain in the ledger', () => {
    reset(); addPhantom(1e5, 3e4, 2e4, .1, .2, .3, MU_S * 1e-4, 2e4);
    assert.ok(check('ship').contributions.some(r => r.id === 'transient-gravity'));
    check('earth'); check('moon');
    Object.assign(G, { x: LY_KM * 1e8, y: LY_KM * 2e7, z: LY_KM * 3e6 });
    const far = check('ship');
    assert.ok(far.contributions.some(r => r.id === 'dark-matter'));
    assert.ok(far.contributions.some(r => r.id === 'dark-energy'));
});
test('bounded snapshot integration matches the production KDK without forcing its horizon', () => {
    reset();
    const initial = snapshotEphem();
    const bounded = snapshotEphem();
    const elapsed = advanceEphemSnapshotBounded(bounded, 120, 1, 120);
    assert.equal(elapsed, 120);
    loadEphemSnapshot(initial);
    const regular = snapshotEphem();
    advanceEphemSnapshot(regular, 120, 120);
    assert.deepEqual(bounded, regular);
    loadEphemSnapshot(initial);
    const limited = snapshotEphem();
    const delivered = advanceEphemSnapshotBounded(limited, 1e10, 2, 120);
    assert.equal(delivered, 240);
    assert.equal(limited.t, initial.t + delivered);
    loadEphemSnapshot(initial);
    const before = state();
    for (let n = 0; n < 10; n++) for (const f of ['ship', 'earth', 'moon', 'sun', 0]) check(f);
    assert.deepEqual(state(), before);
});
test('unsupported catalogs, stars, analytic moons and missing holes do not invent acceleration', () => {
    reset();
    for (const f of ['star:0', 'hyg:123', 'sysmoon:a:0', 'minor:1', 'galaxy:1', 'bh:42', null, -1, 0.5]) {
        const result = check(f);
        assert.equal(result.supported, false);
        assert.equal(result.predictionSupported, false);
        assert.ok(result.note.length > 20);
    }
});
test('bounded previews retain Earth-hole encounter bounds and follow coasting hole positions', () => {
    reset(); BH.n = 1;
    bhRegister(0, 20000, 0, 3, -100, 0, null, 0, 0, 1000);
    const before = state(), live = snapshotEphem(), prediction = snapshotEphem();
    beginPredictionBH();
    try {
        const initialStep = ephemPredictionStepSize(prediction);
        assert.ok(initialStep > 0 && initialStep < 1, 'near-Earth hole must not permit a multi-second body step');
        prediction.t += 100;
        assert.ok(ephemPredictionStepSize(prediction) < initialStep / 2,
            'Earth encounter bound must use the approaching prediction hole, not its frozen live position');
        prediction.t = live.t;
        const delivered = advanceEphemSnapshotBounded(prediction, 3600, 1, 3600);
        assert.equal(delivered, initialStep);
        assert.ok(Math.hypot(prediction.earthX - live.earthX, prediction.earthY - live.earthY) < 100,
            'one bounded step must not launch Earth through the nearby hole');
    } finally { endPredictionBH(); loadEphemSnapshot(live); }
    assert.deepEqual(state(), before, 'encounter-aware prediction must restore all live state');

    // Exercise the other-body bound without the Earth pair masking it.
    WORLD.earthDestroyed = true; WORLD.sunDestroyed = true; WORLD.plDestroyed.fill(1);
    bhRegister(0, live.x[IDX_MOON] + 200000, live.y[IDX_MOON], 3, -1000, 0, null, 0, 0, live.z[IDX_MOON]);
    beginPredictionBH();
    try {
        const initialStep = ephemPredictionStepSize(live);
        const future = { ...live, t: live.t + 199 };
        assert.ok(ephemPredictionStepSize(future) < initialStep / 100,
            'Moon/body encounter bound must also follow the extrapolated hole');
    } finally { endPredictionBH(); }
});
function addGas(seed, { bornAtSec = 0, massSolar = 3, x = 1e10, y = 2e9, z = -3e9 } = {}) {
    const i = addNebulaRecord({ xKm: x, yKm: y, zKm: z, radiusKm: 1e7, seed, archetype: 0,
        formation: { v: 3, bornAtSec, massSolar, temperatureK: 10, radialVelocity: 0 } });
    assert.ok(i >= 0); invalidateGasDynamics(); return NEBULAE[i];
}
function prepareGasNow(n) {
    for (let tries = 0; tries < 2000; tries++) {
        if (prepareGas(n, EPHT.t, 4, EPHT.t).ready) { invalidateGasDynamics(); return; }
    }
    assert.fail('gas preparation did not converge');
}
test('each unformed gas aggregate contributes exactly once to ship, body, Earth and hole ledgers', () => {
    reset(); addGas(7001); addGas(7002, { x: -2e10, y: -4e9, z: 5e9 });
    BH.n = 1; bhRegister(0, 4e7, -3e7, 3, 0, 0, null, 0, 0, 2e7);
    for (const focus of ['ship', 'earth', 'moon', 'sun', ...PL.map((_, i) => i), 'bh:0', 'neb:0', 'neb:1']) {
        const result = check(focus), gas = result.contributions.filter(row => row.kind === 'gas');
        assert.deepEqual(gas.map(row => row.id), ['neb:0', 'neb:1'].filter(id => id !== focus));
    }
    const before = check('ship').net;
    GRAVITY_STARS.push(...gasGravitySources(EPHT.t).map((s, i) => ({ id: 'formed-test-' + i, formedStar: true, x: s.x, y: s.y, z: s.z, mu: s.mu, R: 1e6 })));
    beginPredictionStars(GRAVITY_STARS);
    assert.deepEqual(check('ship').net, before, 'formed-star render views must not duplicate aggregate force');
    endPredictionStars();
    BH.ev[0] = [{ x: BH.x[0], y: BH.y[0], z: BH.z[0], t: EPHT.t, dmu: BH.mu[0] }];
    assert.equal(check('bh:0').contributions.filter(row => row.kind === 'gas').length, 0, 'retarded pair gate applies to traced gas reaction');
});
test('assembled cores and mass-losing remnants retain one actual bound-mass source, with honest nebula scope', () => {
    reset(); const assembled = addGas(7011, { bornAtSec: -1e6 }); prepareGasNow(assembled);
    assert.ok(gasStateAt(assembled, EPHT.t).assembled);
    const view = formedStarForNebula(0, EPHT.t); assert.ok(view?.formedStar);
    GRAVITY_STARS.push(view);
    assert.equal(check('ship').contributions.filter(row => row.kind === 'gas').length, 1);
    assert.ok(!check('ship').contributions.some(row => row.kind === 'star' && row.id.includes(view.id)));
    const cachedAccelerations = gasGravitySources(EPHT.t).map(source => [...source.acceleration]);
    const scoped = check('neb:0'); assert.equal(scoped.supported, true);
    assert.deepEqual(gasGravitySources(EPHT.t).map(source => [...source.acceleration]), cachedAccelerations, 'local-only inspection must not alter the cached live gas kick');
    assert.equal(scoped.frame, 'Local perturbation only'); assert.equal(scoped.predictionSupported, false);
    assert.ok(scoped.note.includes('not the total motion acceleration'));
    assert.ok(!scoped.contributions.some(row => row.id === 'neb:0'));
    assert.ok(scoped.position.every(Number.isFinite));
    const remnant = addGas(7012, { bornAtSec: -1e18, x: -2e10 }); prepareGasNow(remnant);
    const state = gasStateAt(remnant, EPHT.t), source = gasGravitySources(EPHT.t)[1];
    assert.ok(state.ejectedMassSolar > 0);
    assert.equal(source.mu, MU_S * (state.gasMassSolar + state.stellarMassSolar));
    assert.ok(source.mu < MU_S * remnant.formation.massSolar);
    check('ship'); check('moon'); check('earth');
    clearNebulaRecords(); invalidateGasDynamics();
    assert.equal(check('ship').contributions.filter(row => row.kind === 'gas').length, 0);
    assert.equal(check('neb:0').supported, false);
});
test('bounded snapshot previews preserve live gas COM/checkpoints and keep frozen gas inventory', () => {
    reset(); const n = addGas(7021); prepareGasNow(n);
    n.formation.dynamics.offsetKm = [100, -200, 300];
    n.formation.dynamics.velocityKmS = [1, -.5, .2];
    invalidateGasDynamics();
    BH.n = 1; bhRegister(0, 8e7, 4e7, 3, 0, 0, null, 0, 0, 2e7);
    const before = state(), live = snapshotEphem(), prediction = snapshotEphem();
    beginPredictionStars([...GRAVITY_STARS], true); beginPredictionBH(); beginPredictionGas(EPHT.t);
    try {
        for (let i = 0; i < 6; i++) advanceEphemSnapshotBounded(prediction, 120, 1, 120);
        const rows = [], field = [0, 0, 0];
        gasFieldAt(n.xKm + 1e9, n.yKm, n.zKm, EPHT.t + 1e12, field, -1, 0, 0, rows);
        assert.equal(rows.length, 1); assert.equal(rows[0].id, 'neb:0');
        assert.deepEqual(rows[0].acceleration, field);
    } finally { loadEphemSnapshot(live); endPredictionBH(); endPredictionStars(); endPredictionGas(); }
    assert.deepEqual(state(), before, 'preview must restore body state and never change gas COM/checkpoints');
    check('ship'); check('earth'); check('bh:0');
});
console.log(`Gravity inspector: ${passed} tests passed`);
