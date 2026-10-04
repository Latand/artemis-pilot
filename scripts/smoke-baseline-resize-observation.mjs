// Pure entry-point, prefix, stop, and completion tests. No runtime packages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diskProbeModes, BASELINE_RESIZE_PREFIX, BASELINE_RESIZE_BUDGET,
    assertNextBaselineObservation, baselineObservationAtStop, finishBaselineObservation } from './baseline-resize-observation.mjs';

for (const device of ['desktop', 'mobile']) for (const bloom of ['0', '1']) {
    assert.deepEqual(diskProbeModes([], device, bloom), { hooksOnly: false, validateOnly: false, baselineResizeObservation: false });
    assert.equal(diskProbeModes(['--validate'], device, bloom).validateOnly, true);
    assert.equal(diskProbeModes(['--validate-hooks'], device, bloom).hooksOnly, true);
}
for (const suffix of [[], ['--validate'], ['--validate-hooks']])
    assert.equal(diskProbeModes(['--baseline-resize-observation', ...suffix], 'desktop', '1').baselineResizeObservation, true);
for (const [device, bloom] of [['desktop', '0'], ['mobile', '1'], ['mobile', '0'], [undefined, '1'], ['desktop', undefined]])
    assert.throws(() => diskProbeModes(['--baseline-resize-observation'], device, bloom), /requires DEVICE=desktop BLOOM=1/);
assert.throws(() => diskProbeModes(['--unknown'], 'desktop', '1'), /Known probe option/);
assert.throws(() => diskProbeModes(['--validate', '--validate-hooks'], 'desktop', '1'), /one validation/);

assert.equal(BASELINE_RESIZE_PREFIX.length, 45);
assert.equal(BASELINE_RESIZE_BUDGET.ordinaryReadbacks, 417);
assert.equal(BASELINE_RESIZE_BUDGET.additionalUntimedColorReadbacks, 2);
assert.equal(BASELINE_RESIZE_BUDGET.totalReadbacks, 419);
assert.equal(BASELINE_RESIZE_BUDGET.explicitAppFrameCalls, 98);
assert.equal(BASELINE_RESIZE_BUDGET.expectedFinalFrameSuccess, 99);
assert.equal(BASELINE_RESIZE_BUDGET.candidateRuns, 0);
assert.equal(BASELINE_RESIZE_BUDGET.recoveryRuns, 0);
assert.equal(BASELINE_RESIZE_BUDGET.costRuns, 0);
assert.deepEqual(BASELINE_RESIZE_PREFIX.at(-1), { phase: 'resize-2-alternate', scenario: 'saturn-near-lens', pitch: .48 });

const samples = [];
let readbacks = 0, frameSuccess = 9, diagnosticReadbacks = 0;
for (const test of BASELINE_RESIZE_PREFIX) {
    assertNextBaselineObservation(samples, test, test.phase);
    assert.throws(() => assertNextBaselineObservation(samples, { ...test, scenario: 'wrong-scenario' }, test.phase), /exact original/);
    const drawCount = 5 + (test.scenario.startsWith('saturn-') ? 2 : 0) + (test.scenario === 'saturn-foreground-lens' ? 2 : 0);
    if (test.phase === 'original' && test.scenario.startsWith('saturn-')) readbacks += drawCount * 2;
    readbacks += drawCount; frameSuccess += 2;
    const observed = test.phase.endsWith('-alternate') && test.scenario === 'saturn-near-lens' && test.pitch === .48;
    if (observed) diagnosticReadbacks++;
    samples.push({ ...test, productionSha256: 'exact-pixel-hash', state: { readbacks, frameSuccess },
        resizeDiagnostic: observed ? { complete: true, hooksRestored: true, truncated: false, addedDraws: 0,
            addedReadbacks: 1, rawDepthTexelsObserved: false, after: { diagnosticReadbacks } } : null });
    assert.equal(baselineObservationAtStop(samples), samples.length === 45, 'no earlier or later stop');
}
assert.equal(readbacks, 417); assert.equal(frameSuccess, 99); assert.equal(diagnosticReadbacks, 2);
assert.throws(() => assertNextBaselineObservation(samples, { scenario: 'saturn-foreground-lens', pitch: .48 }, 'resize-2-alternate'), /no further setup/);
const valid = { main: { samples, recoveries: [], errors: [] } };
const completion = finishBaselineObservation(valid);
assert.equal(completion.completed, true); assert.equal(completion.acceptanceClaim, false);
assert.equal(completion.outcome, 'mismatch-not-reproduced'); assert.match(completion.interpretation, /Inconclusive/);
const mutate = change => { const copy = structuredClone(valid); change(copy); return copy; };
for (const [change, pattern] of [
    [value => { value.candidate = {}; }, /cannot execute a candidate/],
    [value => { value.main.samples.pop(); }, /exact bounded capture/],
    [value => { value.main.samples.push({ phase: 'resize-2-alternate', scenario: 'saturn-foreground-lens', pitch: .48 }); }, /exact bounded capture/],
    [value => { [value.main.samples[0], value.main.samples[1]] = [value.main.samples[1], value.main.samples[0]]; }, /complete original prefix/],
    [value => { value.main.samples.at(-1).productionSha256 = 'different-pixel-hash'; }, /equality remains exact/],
    [value => { value.main.samples.at(-1).state.readbacks--; }, /ordinary readback count/],
    [value => { value.main.samples.at(-1).state.readbacks++; }, /ordinary readback count/],
    [value => { value.main.samples.at(-1).state.frameSuccess--; }, /app-frame prefix/],
    [value => { value.main.samples.at(-1).state.frameSuccess++; }, /app-frame prefix/],
    [value => { value.main.samples.at(-1).resizeDiagnostic.after.diagnosticReadbacks = 3; }, /two added color/],
    [value => { value.main.samples.at(-1).resizeDiagnostic = null; }, /two approved observations/],
    [value => { value.main.recoveries.push({}); }, /No recovery run/],
    [value => { value.main.errors.push('shader failure'); }, /No observed page/],
]) assert.throws(() => finishBaselineObservation(mutate(change)), pattern);
for (const delta of [{ complete: false }, { hooksRestored: false }, { truncated: true },
    { addedDraws: 1 }, { addedReadbacks: 0 }, { addedReadbacks: 2 }, { rawDepthTexelsObserved: true }])
    assert.throws(() => finishBaselineObservation(mutate(value => Object.assign(value.main.samples.at(-1).resizeDiagnostic, delta))));

const source = readFileSync(new URL('./probe-disk-plane.mjs', import.meta.url), 'utf8');
const equality = source.indexOf("assert.equal(sample.productionSha256, previous.productionSha256, 'Repeated camera/resize restores exact settled frozen pixels')");
const stop = source.indexOf('if (baselineResizeObservation && baselineObservationAtStop(local.samples)) break variantLoop;');
assert(equality >= 0 && stop > equality && stop < source.indexOf('// Two actual native GPU outages'));
const guard = source.indexOf('if (baselineResizeObservation) assertNextBaselineObservation(local.samples, test, phase);');
assert(guard >= 0 && guard < source.indexOf('await settleAssets(page, test);', guard), 'bound before any extra setup frame');
assert(source.includes("baselineResizeObservation ? [['main', baselineRoot]] : [['main', baselineRoot], ['candidate', candidateRoot]]"));
assert(source.includes('originalError = error; hadOriginalError=true;'));
assert(source.includes('finalizeDiskProbe({report,originalError,hadOriginalError,'));
console.log('Baseline resize observation CPU smoke passed: strict entry mode, original 45-capture/417-readback/99-frame prefix, two extra color reads, exact equality before stopping, no candidate/recovery/cost suffix, inconclusive completion, and count/order/failure negatives. No browser/GPU executed.');
