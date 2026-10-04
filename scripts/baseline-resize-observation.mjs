// Host-only bounds for one baseline observation. No browser/runtime imports.
import assert from 'node:assert/strict';
import { DISK_PLANE_CASES, RESIZE_CASES } from './disk-plane-qa.mjs';

export function diskProbeModes(argv, device, bloomOption) {
    assert(argv.every(arg => ['--validate', '--validate-hooks', '--baseline-resize-observation'].includes(arg)), 'Known probe option');
    const hooksOnly = argv.includes('--validate-hooks'), validateOnly = argv.includes('--validate');
    assert(!(hooksOnly && validateOnly), 'Choose one validation mode');
    const baselineResizeObservation = argv.includes('--baseline-resize-observation');
    if (baselineResizeObservation) assert(device === 'desktop' && bloomOption === '1', 'Baseline resize observation requires DEVICE=desktop BLOOM=1');
    return { hooksOnly, validateOnly, baselineResizeObservation };
}

export const BASELINE_RESIZE_PREFIX = [
    ...DISK_PLANE_CASES.map(test => ({ ...test, phase: 'original' })),
    ...RESIZE_CASES.map(test => ({ ...test, phase: 'resize-1-alternate' })),
    ...RESIZE_CASES.map(test => ({ ...test, phase: 'resize-1-original' })),
    ...RESIZE_CASES.slice(0, 4).map(test => ({ ...test, phase: 'resize-2-alternate' })),
];
const drawsPerCapture = test => 5 + (test.scenario.startsWith('saturn-') ? 2 : 0) + (test.scenario === 'saturn-foreground-lens' ? 2 : 0);
const stabilityReadbacks = DISK_PLANE_CASES.filter(test => test.scenario.startsWith('saturn-')).reduce((sum, test) => sum + 2 * drawsPerCapture(test), 0);
const ordinaryReadbacks = BASELINE_RESIZE_PREFIX.reduce((sum, test) => sum + drawsPerCapture(test), stabilityReadbacks);
export const BASELINE_RESIZE_BUDGET = Object.freeze({ savedCaptures: BASELINE_RESIZE_PREFIX.length,
    stabilityCaptures: 20, ordinaryReadbacks, additionalUntimedColorReadbacks: 2, totalReadbacks: ordinaryReadbacks + 2,
    explicitAppFrameCalls: BASELINE_RESIZE_PREFIX.length * 2 + 8, startupFrames: 1,
    expectedFinalFrameSuccess: BASELINE_RESIZE_PREFIX.length * 2 + 9,
    recoveryRuns: 0, candidateRuns: 0, costRuns: 0,
    stopAfter: 'resize-2-alternate/saturn-near-lens/0.48', acceptanceClaim: false });
const key = test => `${test.phase}/${test.scenario}/${test.pitch}`;

// Call before settlement so an accidentally extended loop cannot add another
// app frame, camera setup, or capture beyond the authorized prefix.
export function assertNextBaselineObservation(samples, test, phase) {
    const expected = BASELINE_RESIZE_PREFIX[samples.length];
    assert(expected, 'Baseline observation reached its fixed stop; no further setup or capture is allowed');
    assert.equal(key({ ...test, phase }), key(expected), 'Baseline observation preserves the exact original setup/capture order');
}

export function baselineObservationAtStop(samples) {
    return samples.length === BASELINE_RESIZE_PREFIX.length && key(samples.at(-1)) === key(BASELINE_RESIZE_PREFIX.at(-1));
}

export function finishBaselineObservation(variants) {
    assert.deepEqual(Object.keys(variants), ['main'], 'Baseline observation cannot execute a candidate');
    const main = variants.main, samples = main.samples;
    assert(baselineObservationAtStop(samples), 'Baseline observation must stop at the exact bounded capture');
    assert.deepEqual(samples.map(key), BASELINE_RESIZE_PREFIX.map(key), 'The complete original prefix remains unchanged');
    assert.equal(main.recoveries.length, 0, 'No recovery run belongs to this observation');
    assert.deepEqual(main.errors, [], 'No observed page/GPU errors');
    const observations = samples.filter(sample => sample.resizeDiagnostic);
    assert.deepEqual(observations.map(sample => sample.phase), ['resize-1-alternate', 'resize-2-alternate'], 'Exactly the two approved observations are required');
    for (const sample of observations) {
        const trace = sample.resizeDiagnostic;
        assert(trace.complete && trace.hooksRestored && !trace.truncated);
        assert.equal(trace.addedDraws, 0); assert.equal(trace.addedReadbacks, 1);
        assert.equal(trace.rawDepthTexelsObserved, false);
    }
    assert.equal(observations[1].productionSha256, observations[0].productionSha256, 'Original baseline resize equality remains exact');
    assert.equal(samples.at(-1).state.readbacks, BASELINE_RESIZE_BUDGET.ordinaryReadbacks, 'Exact ordinary readback count');
    assert.equal(samples.at(-1).state.frameSuccess, BASELINE_RESIZE_BUDGET.expectedFinalFrameSuccess, 'Exact original app-frame prefix');
    assert.equal(observations.at(-1).resizeDiagnostic.after.diagnosticReadbacks, 2, 'Exactly two added color reads');
    return { completed: true, acceptanceClaim: false, outcome: 'mismatch-not-reproduced',
        interpretation: 'Inconclusive: equality in this bounded observation does not establish a fix or renderer acceptance.',
        savedCaptures: samples.length, ordinaryReadbacks: samples.at(-1).state.readbacks, addedColorReadbacks: 2 };
}
