// Source-only policy shared by the prepared browser probe and its smoke test.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { transformCelestialSource } from './celestial-detail-fixtures.mjs';
import { appendReadOnlyHoverInspection } from './disk-pointer-fixture.mjs';

export const MAIN_REVISION = '6179f23661591bb4dee89a0bf8e686233e1ba280';
export const COARSE_PITCHES = [.48, .08, .005, 0, -.005, -.08, -.48];
export const DENSE_PITCHES = [.0008, .0007, .00065, .0006, .00055, .0005, .0004, 0,
    -.0004, -.0005, -.00055, -.0006, -.00065, -.0007, -.0008];
export const DISK_PLANE_CASES = [
    ...COARSE_PITCHES.map(pitch => ({ scenario: 'saturn-near-lens', pitch })),
    ...[.48, 0, -.48].map(pitch => ({ scenario: 'saturn-foreground-lens', pitch })),
    // Preserve the original foreground fixture: its disk extends between the
    // camera and Saturn, so new in-plane emission is a diagnostic, not leakage.
    ...[.48, 0, -.48].map(pitch => ({ scenario: 'saturn-overlapping-disk', pitch })),
    ...[...new Set([...COARSE_PITCHES, ...DENSE_PITCHES])].map(pitch => ({ scenario: 'disk-crossing', pitch })),
];
export const VARIANTS = ['main', 'candidate'];
export const MATRIX = ['desktop-direct', 'desktop-bloom', 'mobile-direct', 'mobile-bloom'];
export const RESIZE_CASES = [{ scenario: 'disk-crossing', pitch: .0008 }, { scenario: 'disk-crossing', pitch: 0 },
    { scenario: 'disk-crossing', pitch: -.0008 }, { scenario: 'saturn-near-lens', pitch: .48 },
    { scenario: 'saturn-foreground-lens', pitch: .48 }];
export const RECOVERY_CONTROLS = [{ scenario: 'saturn-near-lens', pitch: .48 }, { scenario: 'saturn-foreground-lens', pitch: .48 }];
export const REPEAT_CYCLES = 2;
const drawsPerCapture = test => 5 + (test.scenario.startsWith('saturn-') ? 2 : 0) +
    (['saturn-foreground-lens', 'saturn-overlapping-disk'].includes(test.scenario) ? 3 : 0) +
    (test.scenario === 'saturn-foreground-lens' ? 1 : 0);
const sumDraws = tests => tests.reduce((sum, test) => sum + drawsPerCapture(test), 0);
const originalReadbacks = sumDraws(DISK_PLANE_CASES);
const stabilityReadbacks = 2 * sumDraws(DISK_PLANE_CASES.filter(test => test.scenario.startsWith('saturn-')));
const resizeReadbacks = REPEAT_CYCLES * 2 * sumDraws(RESIZE_CASES);
const recoveryReadbacks = REPEAT_CYCLES * (2 * drawsPerCapture({ scenario: 'disk-crossing' }) + sumDraws(RECOVERY_CONTROLS));
const savedCapturesPerRoot = DISK_PLANE_CASES.length + REPEAT_CYCLES * 2 * RESIZE_CASES.length + REPEAT_CYCLES * (2 + RECOVERY_CONTROLS.length);
const explicitReadbacksPerRoot = originalReadbacks + stabilityReadbacks + resizeReadbacks + recoveryReadbacks;
export const QA_OPERATION_BUDGET = { savedCapturesPerRoot, stabilityCapturesPerRoot: 2 * DISK_PLANE_CASES.filter(test => test.scenario.startsWith('saturn-')).length,
    readbacks: { original: originalReadbacks, stability: stabilityReadbacks, resize: resizeReadbacks, recovery: recoveryReadbacks },
    explicitReadbacksPerRoot, explicitReadbacksPerPairedCell: explicitReadbacksPerRoot * 2,
    explicitReadbacksAllFourCells: explicitReadbacksPerRoot * 2 * MATRIX.length,
    explicitHealthyAppFrameCallsPerRoot: savedCapturesPerRoot * 2 + 8,
    startupFramesPerRoot: 1, intentionallyLostFrameCallsPerRoot: REPEAT_CYCLES * 4,
    note: 'Source-derived scripted operations; scene/composer calls expand into GPU passes. Not timings or a total internal-GPU-work bound.' };

function replaceOnce(source, from, to, label) {
    assert.equal(source.split(from).length, 2, `Disk-plane QA source hook: ${label}`);
    return source.replace(from, to);
}

export function transformDiskPlaneSource(source, id) {
    const transformed = transformCelestialSource(source, id);
    source = transformed ?? source;
    id = id.replaceAll('\\', '/').split('?')[0];
    if (id.endsWith('/src/main.js')) {
        // Count only frames reaching the end of the actual render function.
        return appendReadOnlyHoverInspection(replaceOnce(source, '    sampleMemory();',
            '    sampleMemory();\n    window.__diskPlaneFrameSuccess = (window.__diskPlaneFrameSuccess || 0) + 1;', 'successful rendered frame'));
    }
    if (id.endsWith('/src/render/bodySurfaceMaterial.js')) {
        for (const hook of ['const pending = new Map();', 'let scheduled = false, surfaceWorker = null, workerFailed = false, inFlight = null;'])
            assert.equal(source.split(hook).length, 2, `Disk-plane QA asset hook: ${hook}`);
        // Read-only fixture visibility into asynchronous production asset work.
        return source + '\nexport const diskPlaneAssetQueue = () => ({ pending: pending.size, scheduled, inFlight: !!inFlight });\n';
    }
    return transformed;
}

export function validateDiskPlaneHooks(root) {
    const paths = ['src/main.js', 'src/render/catalogStars.js', 'src/render/bodySurfaceMaterial.js'];
    for (const path of paths) assert(transformDiskPlaneSource(readFileSync(resolve(root, path), 'utf8'), resolve(root, path)));
    assert(!existsSync(resolve(root, 'src/render/ringSamplingDepth.js')), 'This probe requires the native main ring path without a ring-depth module');
    const lens = readFileSync(resolve(root, 'src/lensing.js'), 'utf8');
    for (const hook of ['uN: { value: 0 }', 'export function renderLensed(', 'export function updateLensing('])
        assert(lens.includes(hook), `Same-target identity lens hook: ${hook}`);
    const scene = readFileSync(resolve(root, 'src/scene.js'), 'utf8');
    assert(scene.includes('export let bloomPass = { enabled: false,'), 'Direct-mode bloom placeholder starts disabled');
    assert(scene.includes('const bloomRequested = bloomParam !== "0" && (bloomParam === "1" || legacyBloom);'), '?bloom=0 keeps bloom disabled even if postprocessing loads');
    assert(scene.includes('bloomPass.enabled = bloomRequested;'), 'Loaded bloom pass retains the requested mode');
    for (const path of ['src/render/contextLifecycle.js', 'public/textures/2k_saturn.jpg', 'public/textures/2k_saturn_ring_alpha.png'])
        assert(existsSync(resolve(root, path)), `Required production asset/module: ${path}`);
    assert.equal(DISK_PLANE_CASES.length, 34);
    return { root: resolve(root), hooks: paths, cases: DISK_PLANE_CASES.length, densePitches: DENSE_PITCHES.length,
        ringEvidence: 'native state and paired unchanged pixels; no alpha-gap repair guarantee', browserStarted: false };
}

// Every emitted sample obeys r < 3*uRout and |z| <= max support=.02 rs.
// Enclose that entire support in a sphere, independently of disk orientation.
// This bound is deliberately conservative; a center-only depth test is invalid.
export function assertDiskBehindForeground({ holeDepth, bodyDepth, bodyRadius, rsUnits, rout, supportHalfWidthRs }) {
    const values = [holeDepth, bodyDepth, bodyRadius, rsUnits, rout, supportHalfWidthRs];
    assert(values.every(Number.isFinite), 'Finite foreground support inputs');
    assert(bodyRadius > 0 && rsUnits > 0 && rout > 1 && supportHalfWidthRs === .02, 'Actual disk radius and reviewed support clamp');
    const supportRadius = Math.hypot(3 * rout, supportHalfWidthRs) * rsUnits;
    const nearestSupportDepth = holeDepth - supportRadius, farthestBodyDepth = bodyDepth + bodyRadius;
    assert(nearestSupportDepth > farthestBodyDepth, 'Entire disk emission support must lie behind the foreground sphere');
    return { supportRadius, nearestSupportDepth, farthestBodyDepth, clearance: nearestSupportDepth - farthestBodyDepth };
}

export function assertOccludedEmissionPixels(metrics) {
    assert(Number.isInteger(metrics.opaquePixels) && metrics.opaquePixels > 50, 'Meaningful opaque interior mask');
    assert(Number.isInteger(metrics.occludedEmissionWitnessPixels) && metrics.occludedEmissionWitnessPixels > 50 &&
        metrics.occludedEmissionWitnessPixels <= metrics.opaquePixels, 'Depth-disabled disk must emit into the same foreground mask');
    assert.equal(metrics.opaqueEmissionChanged, 0, 'Wholly occluded disk emission cannot change any opaque interior channel');
}

export function assertCrossingAcceptance(cases, variant) {
    assert(VARIANTS.includes(variant), 'Explicit main or candidate variant');
    const edge = cases.filter(c => c.scenario === 'disk-crossing');
    assert.equal(edge.length, 21, 'Retain all 21 original disk cases');
    assert.deepEqual(edge.map(c => c.pitch).sort((a, b) => a - b),
        DISK_PLANE_CASES.filter(c => c.scenario === 'disk-crossing').map(c => c.pitch).sort((a, b) => a - b),
        'Every signed pitch must appear exactly once');
    assert(edge.every(c => Number.isInteger(c.metrics.diskPixels) && c.metrics.diskPixels >= 0 &&
        Number.isFinite(c.metrics.diskLight) && c.metrics.diskLight >= 0), 'Finite nonnegative disk measurements');
    const exact = edge.find(c => c.pitch === 0);
    const near = edge.filter(c => Math.abs(c.pitch) === .005);
    assert.equal(near.length, 2);
    assert(near.every(c => c.metrics.diskPixels > 0 && c.metrics.diskLight > 0), 'Both near-plane reference disks emit visible pixels');
    if (variant === 'main') {
        assert.equal(exact.metrics.diskPixels, 0, 'Exact main reproduces zero-plane dropout');
        assert.equal(exact.metrics.diskLight, 0, 'Exact main has no disk light at zero plane');
        return { expectedDropoutReproduced: true, positiveContinuityAcceptance: false };
    }
    const crossing = edge.filter(c => DENSE_PITCHES.includes(c.pitch)).sort((a, b) => b.pitch - a.pitch);
    assert.equal(crossing.length, DENSE_PITCHES.length);
    const outer = crossing.filter(c => Math.abs(c.pitch) === .0008).map(c => c.metrics.diskLight);
    assert(outer.every(light => Number.isFinite(light) && light > 0), 'Both dense endpoints emit light');
    const upper = Math.max(...outer) * 1.25, lower = Math.min(...outer) * .75, adjacent = Math.max(...outer) * .2;
    assert(crossing.every(c => c.metrics.diskLight <= upper && c.metrics.diskLight >= lower), 'Normalized disk footprint avoids a crossing flash or dropout');
    assert(crossing.every((c, i) => !i || Math.abs(c.metrics.diskLight - crossing[i - 1].metrics.diskLight) <= adjacent), 'Dense signed crossing remains continuous');
    assert(exact.metrics.diskPixels > near.reduce((sum, c) => sum + c.metrics.diskPixels, 0) / near.length * .5, 'No all-dark edge-on disk dropout');
    return { expectedDropoutReproduced: false, positiveContinuityAcceptance: true, upper, lower, adjacent };
}

export function compareMaskedPixels(main, candidate, label) {
    assert.equal(main.width, candidate.width, `${label}: same width`);
    assert.equal(main.height, candidate.height, `${label}: same height`);
    const a = Buffer.from(main.rgba, 'base64'), b = Buffer.from(candidate.rgba, 'base64');
    const am = Buffer.from(main.mask, 'base64'), bm = Buffer.from(candidate.mask, 'base64');
    const pixels = main.width * main.height;
    assert.equal(a.length, pixels * 4); assert.equal(b.length, pixels * 4);
    assert.equal(am.length, pixels); assert.equal(bm.length, pixels);
    let sampled = 0, changed = 0, maskChanged = 0, maxChannelDelta = 0;
    for (let p = 0; p < pixels; p++) {
        if (am[p] !== bm[p]) maskChanged++;
        if (!(am[p] || bm[p])) continue;
        sampled++;
        let delta = 0;
        for (let k = 0; k < 4; k++) delta = Math.max(delta, Math.abs(a[p * 4 + k] - b[p * 4 + k]));
        if (delta) changed++;
        maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    return { label, sampled, changed, maskChanged, maxChannelDelta, identical: changed === 0 && maskChanged === 0 };
}

export function assertPairedControl(main, candidate, label, { allowEmpty = false } = {}) {
    const result = compareMaskedPixels(main, candidate, label);
    assert(allowEmpty || result.sampled > 0, `${label}: visible control pixels, not an empty-mask pass`);
    assert.equal(result.changed, 0, `${label}: main/candidate control pixels remain byte-identical`);
    assert.equal(result.maskChanged, 0, `${label}: main/candidate contribution mask remains identical`);
    return { ...result, applicable: result.sampled > 0 };
}

export function assertControlCompleteness(mainLabels, strictControls, diagnostics) {
    const expected = [...mainLabels];
    assert.equal(new Set(expected).size, expected.length, 'Baseline control labels are unique');
    const strictLabels = strictControls.map(control => control.label), diagnosticLabels = diagnostics.map(control => control.label);
    const actual = [...strictLabels, ...diagnosticLabels];
    assert.equal(new Set(actual).size, actual.length, 'Every candidate control appears exactly once');
    assert.deepEqual([...actual].sort(), [...expected].sort(), 'Every baseline control has exactly one candidate pair');
    const diagnosticExpected = expected.filter(label => /^original\/saturn-overlapping-disk\/[^/]+\/opaque$/.test(label));
    assert.equal(diagnosticExpected.length, 3, 'All three original overlapping disk diagnostics are retained');
    assert.deepEqual([...diagnosticLabels].sort(), diagnosticExpected.sort(), 'Only the declared overlapping disk-on controls are diagnostic');
    return { expected: expected.length, strict: strictLabels.length, diagnostic: diagnosticLabels.length };
}
