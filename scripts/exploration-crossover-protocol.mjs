// Diagnostic protocol, frozen before execution. Never an acceptance replacement.
import assert from 'node:assert/strict';
const deepFreeze = value => {
    for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
    return Object.freeze(value);
};
export const protocol = deepFreeze({
    version: 1,
    revisions: { A: '5c304f4f9c3572bbc9c62f480a074fc5da58c729', B: 'd84ab18c5638bb24e89fac2c00cb734a1b9988dd' },
    browserVersion: '153.0.8010.12', playwrightVersion: '1.63.0',
    viewport: { width: 430, height: 932 }, deviceScaleFactor: 1,
    combinations: ['AA', 'BB', 'AB', 'BA'], slots: ['L', 'R'],
    orders: ['LRRL', 'RLLR', 'LRRL', 'RLLR', 'LRRL'],
    warmupFrames: 120, settledFrames: 4, samplesPerBlock: 60,
    startupFrameNo: 1, fixtureBeforeFrames: [125, 849, 1573], fixtureAfterFrames: [725, 1449, 2173],
    fixtures: [
        { name: 'earth-near', focus: 'earth', distance: 25, yaw: -.4, pitch: .45 },
        { name: 'catalog-star', focus: 'star:2', distance: null, yaw: -.4, pitch: .45 },
        { name: 'system-overview', focus: 'star:4', distance: 1500000, yaw: -.4, pitch: .45 },
    ],
    query: { focus: 'earth', dist: '25', hidehelp: '1', dpr: '1', tier1: '0', realsky: '0', field: '0',
        galaxyvol: '0', galaxies: '0', galaxy: '0', river: '0', bloom: '0', compile: '0', galadapt: '0',
        earthnight: '1', clouds: '1', moonmap: '1' },
    browserArgs: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    acceptance: { status: 'failed', revision: 'd84ab18c5638bb24e89fac2c00cb734a1b9988dd',
        fixture: 'system-overview', medianPairedP95Ratio: 1.0546875000009592, unchangedLimit: 1.05 },
    measuredFrames: 14400, warmupFramesTotal: 2976,
    deadlineMs: 45 * 60 * 1000, operationTimeoutMs: 120000, cleanupTimeoutMs: 15000,
    parity: 'After ALL timing: replay AA, BB, AB, BA with identical initialization, fixture order, 124 warmup and 600 serial frames per slot per fixture. Capture only each slot’s 600th frame. No extra application frames.',
    stopping: 'Exactly four timing combinations and four untimed parity replays. No retries, replacement samples, early success stop, profiling, or acceptance decision. Infrastructure/invariant failure, 120s stalled operation or fixed 45-minute diagnostic deadline stops invalid with partial evidence retained.',
});
export const quantile = (values, p) => {
    assert(values.length && values.every(Number.isFinite), 'Nonempty finite samples required');
    return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
};
export const summarize = values => ({ count: values.length, min: Math.min(...values), p50: quantile(values, .5),
    p95: quantile(values, .95), max: Math.max(...values), mean: values.reduce((a, b) => a + b, 0) / values.length });
export function trialSummary(blocks) {
    assert.equal(blocks.length, 4);
    const bySlot = Object.fromEntries(protocol.slots.map(slot => {
        const samples = blocks.filter(b => b.slot === slot).flatMap(b => b.samples);
        assert.equal(samples.length, 120);
        return [slot, Object.fromEntries(['frameAndFinishMs', 'cpuMs', 'finishMs', 'readbackMs', 'telemetryMs', 'roundTripMs', 'protocolAndSchedulingMs'].map(metric =>
            [metric, summarize(samples.map(sample => sample[metric]))]))];
    }));
    return { bySlot, rightMinusLeftReadbackMeanMs: bySlot.R.readbackMs.mean - bySlot.L.readbackMs.mean,
        rightOverLeftFrameP95: bySlot.R.frameAndFinishMs.p95 / bySlot.L.frameAndFinishMs.p95 };
}
export function effects(combinations) {
    assert.deepEqual(combinations.map(c => c.assignment), protocol.combinations);
    return protocol.fixtures.map(({ name }, fixtureIndex) => {
        const deltas = Object.fromEntries(combinations.map(c => [c.assignment,
            c.scenarios[fixtureIndex].trials.map(t => t.summary.rightMinusLeftReadbackMeanMs)]));
        for (const values of Object.values(deltas)) assert.equal(values.length, 5);
        return { fixture: name, rightMinusLeftReadbackMeanMs: deltas,
            trialContrasts: protocol.orders.map((_, i) => ({ trial: i + 1,
                sourceBMinusAReadbackMs: (deltas.AB[i] - deltas.BA[i]) / 2,
                rightMinusLeftSlotReadbackMs: (deltas.AB[i] + deltas.BA[i]) / 2,
                sameCodeAAReadbackMs: deltas.AA[i], sameCodeBBReadbackMs: deltas.BB[i] })),
            interpretation: 'Descriptive contrasts only. A single fixed-order allocation does not identify period/thermal drift or prove causation. Inspect all trials, same-code controls, command/pixel evidence and CPU model; no pass/fail threshold or acceptance override.' };
    });
}
export function validateComplete(report) {
    assert.deepEqual(report.combinations.map(c => c.assignment), protocol.combinations);
    let measured = 0, warmup = 0;
    for (const combo of report.combinations) {
        assert.deepEqual(combo.scenarios.map(s => s.fixture), protocol.fixtures);
        for (const scenario of combo.scenarios) {
            for (const slot of protocol.slots) { assert.equal(scenario.warmup[slot].length, 124); warmup += scenario.warmup[slot].length; }
            assert.deepEqual(scenario.trials.map(t => t.order), protocol.orders);
            for (const trial of scenario.trials) {
                assert.equal(trial.blocks.map(b => b.slot).join(''), trial.order);
                for (const block of trial.blocks) {
                    assert.equal(block.samples.length, 60); measured += block.samples.length;
                    for (const sample of block.samples) {
                        assert.equal(sample.gpu.contextLost, false); assert.equal(sample.gpu.error, 0);
                        assert(sample.gpu.width > 0 && sample.gpu.height > 0);
                        assert(sample.counters.calls > 0 && sample.programIds.length > 0);
                    }
                }
            }
        }
    }
    assert.equal(measured, protocol.measuredFrames); assert.equal(warmup, protocol.warmupFramesTotal);
    return { measured, warmup };
}
