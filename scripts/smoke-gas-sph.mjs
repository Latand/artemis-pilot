// Independent regression checks for the numerical gas solver.
// Run: node scripts/smoke-gas-sph.mjs
// These verify this coarse discrete model, not resolved stellar physics.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

globalThis.window ??= {};
const {
    createGasSph, gasSphNextDt, stepGasSph, advanceGasSph,
    gasSphDiagnostics, snapshotGasSph, restoreGasSph,
    GAS_SPH_MAX_PARTICLES, GAS_SPH_MAX_STEPS_PER_ADVANCE,
} = await import('../src/universe/gasSph.js');

let passed = 0, failed = 0;
const start = performance.now();
function test(label, fn) {
    try { fn(); ++passed; console.log('  PASS  ' + label); }
    catch (error) { ++failed; console.error('  FAIL  ' + label + '\n        ' + error.message); }
}
const close = (actual, expected, tolerance, label) => assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: actual=${actual}, expected=${expected}, tolerance=${tolerance}`,
);
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const clone = value => structuredClone(value);
const options = { massSolar: 1, temperatureK: 10, seed: 2401, particleCount: 96 };
const finiteFields = ['positions', 'velocities', 'accelerations', 'hydroAccelerations', 'density', 'gravitationalPotential', 'temperatureK'];

function finite(s) {
    for (const key of finiteFields) assert.ok(s[key].every(Number.isFinite), `${key} must be finite`);
    for (const key of ['position', 'velocity', 'acceleration', 'angularMomentum']) assert.ok(s.sink[key].every(Number.isFinite), `sink.${key} must be finite`);
    for (const key of ['time', 'ageSec', 'radiatedEnergy', 'backgroundHeatingEnergy', 'unresolvedEnergy']) assert.ok(Number.isFinite(s[key]), `${key} must be finite`);
    assert.equal(s.status, 'running', 'ordinary regression must not hit the resolution limit');
}
function advanceTo(s, targetTime, budget = 256) {
    const target = targetTime * s.unitTimeSec;
    let calls = 0;
    while (s.ageSec < target) {
        const result = advanceGasSph(s, target, { maxSteps: budget });
        assert.ok(result.steps > 0, `no progress at t=${s.time}, status=${s.status}`);
        assert.ok(++calls < 10000, 'bounded regression work was exceeded');
    }
    finite(s);
    return s;
}
function probe(name, extra = {}, target = 5) {
    const s = createGasSph({ ...options, ...extra });
    const initial = gasSphDiagnostics(s), started = performance.now();
    advanceTo(s, target);
    const final = gasSphDiagnostics(s);
    console.log('  PROBE ' + JSON.stringify({
        name, dimensionlessTime: s.time, steps: s.steps,
        elapsedMs: +(performance.now() - started).toFixed(2),
        sinkMassFraction: final.sinkMass,
        sinkTime: s.sink.formedAtSec === null ? null : s.sink.formedAtSec / s.unitTimeSec,
        gasRmsRadiusRatio: final.rmsRadius / initial.rmsRadius,
        energyBalanceError: final.energyBalanceError,
    }));
    return { s, initial, final };
}

console.log('\nNumerical gas SPH regression (same-engine deterministic, 96 parcels)');
const pristine = createGasSph(options);
test('seed and physical options reproduce the initial 3-D state exactly', () => {
    assert.deepEqual(snapshotGasSph(pristine), snapshotGasSph(createGasSph(options)));
    const changed = createGasSph({ ...options, seed: 2402 });
    assert.notDeepEqual(changed.positions, pristine.positions);
    for (let axis = 0; axis < 3; ++axis) {
        const coordinates = Array.from(pristine.positions).filter((_, i) => i % 3 === axis);
        assert.ok(Math.max(...coordinates) - Math.min(...coordinates) > 1, `axis ${axis} is populated`);
    }
    assert.equal(pristine.sink.mass, 0);
    finite(pristine);
});
test('pairwise gravity attracts, pressure supports, and net internal force vanishes', () => {
    let gravityVirial = 0, pressureVirial = 0;
    const netGravity = [0, 0, 0], netPressure = [0, 0, 0];
    for (let i = 0; i < pristine.positions.length; ++i) {
        const pressure = pristine.hydroAccelerations[i];
        const gravity = pristine.accelerations[i] - pressure;
        pressureVirial += pristine.parcelMass * pristine.positions[i] * pressure;
        gravityVirial += pristine.parcelMass * pristine.positions[i] * gravity;
        netPressure[i % 3] += pristine.parcelMass * pressure;
        netGravity[i % 3] += pristine.parcelMass * gravity;
    }
    assert.ok(gravityVirial < 0, 'gravity must be attractive');
    assert.ok(pressureVirial > 0, 'positive pressure must supply outward support');
    close(Math.hypot(...netGravity), 0, 1e-12, 'net gravitational force');
    close(Math.hypot(...netPressure), 0, 1e-12, 'net pressure force');
});
test('temperature changes pressure without changing seeded positions or bulk velocities', () => {
    const hot = createGasSph({ ...options, temperatureK: 200 });
    assert.deepEqual(hot.positions, pristine.positions);
    assert.deepEqual(hot.velocities, pristine.velocities);
    close(hot.soundSpeedSquared / pristine.soundSpeedSquared, 20, 1e-12, 'thermal support ratio');
});

const cold = probe('cold-bound', {});
const hot = probe('hot-supported', { temperatureK: 200 });
const outward = probe('outward-unbound', { radialVelocity: 3 });
const lowMass = probe('low-mass-marginal', { massSolar: .3 });
const highMass = probe('high-mass-cold', { massSolar: 3 });

test('cold 1 Msolar gas produces a numerically collapsed sink from actual steps', () => {
    assert.ok(cold.final.sinkMass > .5);
    assert.ok(cold.s.sink.formedAtSec > 0 && cold.s.sink.formedAtSec < cold.s.ageSec);
    assert.ok(cold.final.gasMass < cold.initial.gasMass);
    assert.ok(cold.s.steps > 100, 'collapse must require integrated evolution');
});
test('same-seed 200 K cloud expands without a sink through five dynamical units', () => {
    assert.equal(hot.final.sinkMass, 0);
    assert.equal(hot.s.sink.formedAtSec, null);
    assert.ok(hot.final.rmsRadius > 2 * hot.initial.rmsRadius);
});
test('unbound outward motion disperses without forced recapture or star creation', () => {
    assert.ok(outward.initial.virialRatio > 2);
    assert.equal(outward.final.sinkMass, 0);
    assert.ok(outward.final.rmsRadius > 5 * outward.initial.rmsRadius);
});
test('0.3 Msolar at 10 K is not forced to form on the cold-cloud clock', () => {
    assert.equal(lowMass.final.sinkMass, 0);
    assert.equal(lowMass.s.sink.formedAtSec, null);
    assert.ok(lowMass.final.rmsRadius > .7 * lowMass.initial.rmsRadius);
});
test('cold 3 Msolar cloud independently reaches a sink while conserving its mass', () => {
    assert.ok(highMass.final.sinkMass > .5);
    close(highMass.final.totalMassSolar, 3, 1e-12, 'physical mass');
});
test('all positive and negative controls conserve total parcel plus sink mass', () => {
    for (const { final } of [cold, hot, outward, lowMass, highMass]) close(final.totalMass, 1, 1e-12, 'dimensionless mass');
});
test('linear and angular momentum survive collapse, sink accretion, and dispersion', () => {
    for (const { initial, final } of [cold, hot, outward, lowMass, highMass]) {
        close(distance(final.momentum, initial.momentum), 0, 1e-11, 'linear momentum');
        close(distance(final.angularMomentum, initial.angularMomentum), 0, 1e-11, 'angular momentum including sink spin');
        close(distance(final.centerOfMass, initial.centerOfMass), 0, 1e-10, 'center of mass');
    }
    assert.ok(Math.hypot(...cold.s.sink.angularMomentum) > 0, 'swallowed angular momentum is retained');
});
test('isothermal energy budget includes bath exchange and unresolved sink energy', () => {
    for (const { s, final } of [cold, hot, outward, lowMass, highMass]) {
        assert.ok(s.radiatedEnergy >= 0 && s.backgroundHeatingEnergy >= 0);
        const independentlyBalanced = final.kineticEnergy + final.potentialEnergy + final.thermalEnergy
            + s.radiatedEnergy - s.backgroundHeatingEnergy + s.unresolvedEnergy - s.initialEnergy;
        close(independentlyBalanced, final.energyBalanceError, 1e-12, 'energy ledger');
        assert.ok(Math.abs(independentlyBalanced) < .005 * Math.abs(s.initialEnergy), `energy residual=${independentlyBalanced}`);
    }
    assert.ok(cold.s.radiatedEnergy > 0 && hot.s.backgroundHeatingEnergy > 0);
    assert.notEqual(cold.s.unresolvedEnergy, 0);
});

let atBirth;
test('first sink consumes a dense, bound, converging potential minimum with at least 16 parcels', () => {
    const s = createGasSph(options);
    while (s.sink.mass === 0 && s.time < 3) assert.ok(stepGasSph(s));
    assert.ok(s.sink.mass > 0, 'no first sink found');
    atBirth = snapshotGasSph(s);
    const ids = Array.from(s.active).flatMap((active, i) => active ? [] : [i]);
    assert.ok(ids.length >= 16, 'one dense pair cannot create a core');
    let kinetic = 0, potential = 0, convergence = 0, minimumPotential = Infinity, minimumId = -1, candidateDensity = 0;
    for (let i = 0; i < s.count; ++i) {
        let phi = 0;
        for (let j = 0; j < s.count; ++j) if (j !== i) {
            const r2 = [0, 1, 2].reduce((sum, axis) => sum + (s.positions[3 * i + axis] - s.positions[3 * j + axis]) ** 2, 0);
            phi -= s.parcelMass / Math.sqrt(r2 + s.softening ** 2);
        }
        if (phi < minimumPotential) { minimumPotential = phi; minimumId = i; }
    }
    assert.ok(ids.includes(minimumId), 'sink must contain the gravitational potential minimum');
    const norm = 1 / (Math.PI * s.h ** 3);
    for (const i of ids) {
        const k = i * 3;
        for (let axis = 0; axis < 3; ++axis) {
            const dv = s.velocities[k + axis] - s.sink.velocity[axis];
            kinetic += .5 * s.parcelMass * dv * dv;
            convergence += s.parcelMass * (s.positions[k + axis] - s.sink.position[axis]) * dv;
        }
        let density = 0;
        for (let j = 0; j < s.count; ++j) {
            const l = j * 3, r = Math.hypot(...[0, 1, 2].map(axis => s.positions[k + axis] - s.positions[l + axis]));
            const q = r / s.h;
            density += s.parcelMass * norm * (q < 1 ? 1 - 1.5 * q * q + .75 * q ** 3 : q < 2 ? .25 * (2 - q) ** 3 : 0);
            if (j > i && ids.includes(j)) potential -= s.parcelMass ** 2 / Math.sqrt(r * r + s.softening ** 2);
        }
        if (i === minimumId) candidateDensity = density;
    }
    const thermal = 1.5 * ids.length * s.parcelMass * s.soundSpeedSquared;
    assert.ok(candidateDensity >= s.sinkDensity, `candidate density ${candidateDensity} < ${s.sinkDensity}`);
    assert.ok(convergence < 0, 'core must contract');
    assert.ok(kinetic + thermal + potential < 0, 'core must be bound');
    assert.ok(2 * thermal < -potential, 'core must overcome thermal support');
});
test('a large source age cannot create a sink without a changed dynamical state', () => {
    const fresh = createGasSph(options), aged = createGasSph(options);
    aged.time = 1e9; aged.ageSec = aged.time * aged.unitTimeSec;
    stepGasSph(fresh); stepGasSph(aged);
    for (const key of finiteFields) assert.deepEqual(aged[key], fresh[key]);
    assert.equal(aged.sink.mass, 0);
    assert.equal(aged.sink.formedAtSec, null);
});
test('a zero work budget cannot turn a distant requested age into a completed collapse', () => {
    const s = createGasSph(options), before = snapshotGasSph(s);
    const result = advanceGasSph(s, 1e100, { maxSteps: 0 });
    assert.equal(result.steps, 0); assert.equal(result.complete, false);
    assert.ok(result.pendingSec > 0);
    assert.deepEqual(snapshotGasSph(s), before);
});
test('work cap preserves pending time instead of skipping integration', () => {
    const s = createGasSph(options);
    const result = advanceGasSph(s, 1e100, { maxSteps: 1e9 });
    assert.equal(result.steps, GAS_SPH_MAX_STEPS_PER_ADVANCE);
    assert.equal(s.steps, GAS_SPH_MAX_STEPS_PER_ADVANCE);
    assert.equal(result.complete, false); assert.ok(result.pendingSec > 0);
    assert.ok(s.time < 10);
});
test('canonical steps are identical across direct and frame-partitioned requests', () => {
    const direct = advanceTo(createGasSph(options), 2);
    const framed = createGasSph(options);
    for (let frame = 1; frame <= 101; ++frame) advanceTo(framed, 2 * frame / 101, 1 + frame % 17);
    assert.deepEqual(snapshotGasSph(framed), snapshotGasSph(direct));
});
test('JSON checkpoint replay is exact before and after sink creation', () => {
    const s = advanceTo(createGasSph(options), .875);
    const checkpoint = JSON.parse(JSON.stringify(snapshotGasSph(s)));
    const expected = snapshotGasSph(advanceTo(s, 3));
    assert.deepEqual(snapshotGasSph(advanceTo(restoreGasSph(checkpoint), 3, 7)), expected);
    assert.ok(atBirth, 'first-sink checkpoint missing');
    assert.deepEqual(snapshotGasSph(advanceTo(restoreGasSph(JSON.parse(JSON.stringify(atBirth))), 3, 13)), expected);
});
test('snapshot and restored state do not alias mutable arrays or config', () => {
    const s = createGasSph(options), saved = snapshotGasSph(s), restored = restoreGasSph(saved);
    const original = s.positions[0];
    saved.positions[0] += 1; saved.sink.position[0] += 1; saved.config.seed += 1;
    assert.equal(s.positions[0], original); assert.equal(restored.positions[0], original);
    assert.equal(s.sink.position[0], 0); assert.equal(restored.sink.position[0], 0);
    assert.equal(s.config.seed, options.seed); assert.equal(restored.config.seed, options.seed);
});
test('rewind is explicit and cannot silently integrate dissipative gas backward', () => {
    const s = advanceTo(createGasSph(options), .5), before = snapshotGasSph(s);
    const result = advanceGasSph(s, .1 * s.unitTimeSec);
    assert.equal(result.rewindRequired, true);
    assert.equal(result.steps, 0); assert.deepEqual(snapshotGasSph(s), before);
});
test('invalid target ages and unstable timestep requests are rejected', () => {
    for (const age of [NaN, Infinity, -Infinity]) assert.throws(() => advanceGasSph(createGasSph(options), age), RangeError);
    for (const dt of [0, -1, NaN, Infinity]) assert.throws(() => stepGasSph(createGasSph(options), dt), RangeError);
    const s = createGasSph(options);
    assert.throws(() => stepGasSph(s, gasSphNextDt(s) * 2), RangeError);
});
test('maximum particle count stays finite and within the CPU allocation cap', () => {
    const s = createGasSph({ ...options, particleCount: 1e9 });
    assert.equal(s.count, GAS_SPH_MAX_PARTICLES);
    for (let i = 0; i < 8; ++i) assert.ok(stepGasSph(s));
    finite(s);
});

test('halving timestep preserves sink outcome and reduces the energy residual', () => {
    const run = divisor => {
        const s = createGasSph(options);
        while (s.time < 1) assert.ok(stepGasSph(s, Math.min(gasSphNextDt(s) / divisor, 1 - s.time)));
        const beforeSink = gasSphDiagnostics(s);
        while (s.time < 2) assert.ok(stepGasSph(s, Math.min(gasSphNextDt(s) / divisor, 2 - s.time)));
        return { s, d: gasSphDiagnostics(s), beforeSink };
    };
    const coarse = run(1), fine = run(2);
    assert.ok(coarse.s.sink.mass > .5 && fine.s.sink.mass > .5);
    assert.equal(coarse.beforeSink.sinkMass, 0); assert.equal(fine.beforeSink.sinkMass, 0);
    close(coarse.beforeSink.rmsRadius, fine.beforeSink.rmsRadius, .02 * coarse.beforeSink.rmsRadius, 'pre-sink cloud radius sensitivity');
    close(coarse.beforeSink.peakDensity, fine.beforeSink.peakDensity, .05 * coarse.beforeSink.peakDensity, 'pre-sink peak density sensitivity');
    close(coarse.s.sink.mass, fine.s.sink.mass, .05, 'sink mass sensitivity');
    close(coarse.s.sink.formedAtSec / coarse.s.unitTimeSec, fine.s.sink.formedAtSec / fine.s.unitTimeSec, .05, 'sink time sensitivity');
    assert.ok(Math.abs(fine.d.energyBalanceError) < Math.abs(coarse.d.energyBalanceError), 'energy error must improve at smaller timestep');
    console.log('  PROBE ' + JSON.stringify({ name: 'half-timestep', coarseSteps: coarse.s.steps, fineSteps: fine.s.steps,
        coarseSinkTime: coarse.s.sink.formedAtSec / coarse.s.unitTimeSec, fineSinkTime: fine.s.sink.formedAtSec / fine.s.unitTimeSec,
        coarseEnergyError: coarse.d.energyBalanceError, fineEnergyError: fine.d.energyBalanceError }));
});

const malformedCases = [
    ['version', s => { s.version = -1; }],
    ['particle count', s => { s.count = GAS_SPH_MAX_PARTICLES + 1; }],
    ['short positions', s => { s.positions.pop(); }],
    ['sparse positions', s => { delete s.positions[0]; }],
    ['nonfinite velocity', s => { s.velocities[0] = NaN; }],
    ['active flag', s => { s.active[0] = 2; }],
    ['short sink vector', s => { s.sink.position = [0]; }],
    ['nonfinite sink vector', s => { s.sink.velocity[0] = NaN; }],
    ['sparse sink vector', s => { delete s.sink.position[0]; }],
    ['nonfinite initial momentum', s => { s.initialMomentum[0] = NaN; }],
    ['sparse initial momentum', s => { delete s.initialMomentum[0]; }],
    ['missing initial center', s => { delete s.initialCenterOfMass; }],
    ['nonpositive smoothing', s => { s.h = 0; }],
    ['nonfinite softening', s => { s.softening = NaN; }],
    ['negative sound speed squared', s => { s.soundSpeedSquared = -1; }],
    ['inconsistent parcel mass', s => { s.parcelMass *= 2; }],
    ['inconsistent sink mass', s => { s.sink.mass = .5; }],
    ['nonfinite unit time', s => { s.unitTimeSec = Infinity; }],
    ['negative solver time', s => { s.time = -1; s.ageSec = -s.unitTimeSec; }],
    ['inconsistent age', s => { s.ageSec = 5 * s.unitTimeSec; }],
    ['noninteger step counter', s => { s.steps = .5; }],
    ['unknown status', s => { s.status = 'invented-star'; }],
    ['config count mismatch', s => { s.config.particleCount += 1; }],
    ['negative radiated energy', s => { s.radiatedEnergy = -1; }],
    ['negative bath heating', s => { s.backgroundHeatingEnergy = -1; }],
    ['nonfinite initial energy', s => { s.initialEnergy = Infinity; }],
];
for (const [label, corrupt] of malformedCases) test('restore rejects ' + label, () => {
    const snapshot = clone(snapshotGasSph(pristine)); corrupt(snapshot);
    assert.throws(() => restoreGasSph(snapshot), { name: 'TypeError' });
});

console.log(`\n${passed} passed, ${failed} failed; ${(performance.now() - start).toFixed(1)} ms`);
console.log('Scope: coarse fixed-resolution isothermal/SPH regression only; no Jeans convergence, radiation transport, fragmentation statistics, fusion, or mobile performance claim.');
if (failed) process.exitCode = 1;
