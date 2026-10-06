import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { diskInputs, diskMaximumTaskPolicy } from './disk-plane-source-contract.mjs';
import { captureDiskQuality, assertDiskFullQuality } from './disk-current-quality.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const workflow = read('.github/workflows/disk-plane-validation.yml').toString();
const guard = "    if: github.event.pull_request.number == 59 && github.event.pull_request.base.sha == '6179f23661591bb4dee89a0bf8e686233e1ba280'\n";
function validateRouting(text) {
    const split = text.indexOf('  pixels:\n'); assert(split > 0);
    const historical = text.slice(split), current = text.slice(text.indexOf('jobs:\n'), split);
    assert.equal(historical.split(guard).length, 3, 'Both historical jobs have the exact PR/base guard');
    // This digest covers all old commands, pins, thresholds, timeout budgets,
    // uploads and matrix cells from main fd41a0c, with only our guards removed.
    assert.equal(sha(historical.replaceAll(guard, '')), '9708278d5a3202e7d82b3479510dfce9be0e00c5663bd67ef8333ed360f0dc11');
    assert(!/^    if:/m.test(current), 'Current-source jobs must not be skipped by the historical route');
    assert(!/continue-on-error|workflow_dispatch/.test(text), 'No blanket success bypass or ambiguous manual event refs');
    const block = text.match(/^on:\n  pull_request:\n    paths:\n((?:      - '[^']+'\n)+)permissions:/m);
    assert(block, 'Keep protected PR input triggers');
    const paths = new Set([...block[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
    for (const path of [...diskInputs.productionPaths.map(p => ['src', 'public'].includes(p) ? p + '/**' : p),
        'scripts/**', '.github/workflows/disk-plane-validation.yml']) assert(paths.has(path), `Missing trigger ${path}`);
    for (const command of ['smoke-disk-workflow-scope', 'smoke-disk-plane-support', 'smoke-disk-frustum-fast-path',
        'smoke-disk-fast-path-lifecycle', 'smoke-disk-program-precision', 'smoke-disk-static-programs',
        'smoke-native-disk-proof', 'smoke-disk-plane-qa', 'smoke-disk-pointer-fixture', 'smoke-disk-plane-finalize',
        'smoke-context-recovery-qa', 'smoke-hole-appearance', 'smoke-hole-precision', 'smoke-hole-emission',
        'probe-disk-continuity-current']) assert(current.includes(`node scripts/${command}.mjs`), `Required current regression ${command}`);
    assert(!current.includes('--verify-main-scope'));
    assert(!current.includes('smoke-disk-source-binding.mjs'));
    assert(!current.includes('smoke-disk-plane-cost-contract.mjs'));
    for (const token of ['  current-model:\n', '  current-pixels:\n', '    needs: current-model\n',
        '        device: [desktop, mobile]\n', '        bloom: [0, 1]\n', '          npm run build\n']) assert(current.includes(token));
}
validateRouting(workflow);
for (const mutate of [text => text.replace(guard, ''), text => text.replace('number == 59', 'number != 59'),
    text => text.replace("      - 'src/**'\n", ''), text => text.replace('  current-model:\n', '  current-model:\n    if: false\n'),
    text => text.replace('node scripts/probe-disk-continuity-current.mjs', 'true'),
    text => text.replace('        bloom: [0, 1]', '        bloom: [0]')]) assert.throws(() => validateRouting(mutate(workflow)));
// Preserve the release harness and threshold definitions without depending on
// an orphaned historical benchmark object in an ordinary checkout.
for (const [path, expected] of Object.entries({
    'scripts/probe-disk-plane.mjs': '1d4dcb546b354edb4c91aad108ef7e2cce8281de107b4843b70c235879c0cfd8',
    'scripts/disk-plane-source-contract.mjs': '93cb5fb5878110ca733261b86e35021e828463a9b45e96750a0002a439f90dda',
    'scripts/disk-plane-qa.mjs': '96171e517d8b3bc3a565077165e835bcc804d563b38e24190486cae0723c9f34',
    'scripts/disk-plane-finalize.mjs': 'dea0c1878e723106b483ebc103f05da8985517aaf2b2700cdca306f926075fba',
    'scripts/fixtures/disk-plane-inputs.json': '8808fe44eca9c77e8fc15439cd9ac02e97bf2a8f3267c94038d0d9a3c89b161f',
    'scripts/benchmark-disk-plane.mjs': '01cce86ae10eb05c7f4d6faa58c9023fa4eabe76df1015869acfed4765c54396',
    'scripts/smoke-disk-plane-cost-contract.mjs': 'bb6631cf571ba69d7da137962aaaff4c554e324791a2761af5e1cfa98d4a415f',
})) assert.equal(sha(read(path)), expected, `Historical bytes: ${path}`);
assert.equal(diskMaximumTaskPolicy.absoluteFloorMs, 220);
assert.equal(diskMaximumTaskPolicy.baselineMultiplier, 1.10);
console.log('Disk routing: exact historical jobs and harness bytes preserved; current model/pixel jobs mandatory; all protected triggers, four pixel cells and six routing negative controls pass. No historical pixel/cost acceptance claimed.');

// Both legacy and controller-based source must prove the actual same quality.
// Fake renderer objects exercise the shared browser metadata collector itself.
let qualityChecks = 0;
for (const mobile of [false, true]) for (const bloom of [false, true]) for (const legacy of [false, true]) {
    const viewport = mobile ? { width: 390, height: 700 } : { width: 960, height: 640 };
    const texWidth = mobile ? 96 : 124;
    const scene = { renderQuality: { mobile, ...(legacy ? {} : { mode: 'high' }) },
        cvHost: { clientWidth: viewport.width, clientHeight: viewport.height },
        viewportSize: { w: viewport.width, h: viewport.height }, bloomPass: { enabled: bloom },
        renderer: { getContext: () => ({ getContextAttributes: () => ({ antialias: true }),
            drawingBufferWidth: viewport.width, drawingBufferHeight: viewport.height, isContextLost: () => false }),
            getPixelRatio: () => 1, getRenderTarget: () => null, domElement: { ...viewport } } };
    const actual = captureDiskQuality(scene, { count: texWidth * texWidth, texW: texWidth });
    const expected = { mobile, bloom, viewport };
    assert.equal(assertDiskFullQuality(actual, expected).profile, legacy ? 'legacy-native-full' : 'current-high'); qualityChecks++;
    for (const mutate of [q => { q.modePresent = true; q.mode = 'low'; }, q => { q.modePresent = true; q.mode = null; },
        q => { q.modePresent = false; q.mode = 'high'; }, q => { delete q.modePresent; }, q => { q.mobile = !mobile; },
        q => { q.pixelRatio = .92; }, q => { q.antialias = false; }, q => { q.antialias = null; },
        q => { q.riverCount = 4096; }, q => { q.riverTexWidth--; }, q => { q.bloom = !bloom; },
        q => { q.canvasTarget = false; }, q => { q.contextLost = true; },
        ...['host', 'viewport', 'canvas', 'drawingBuffer'].map(key => q => { q[key].width--; }),
        ...['host', 'viewport', 'canvas', 'drawingBuffer'].map(key => q => { q[key].height++; })]) {
        const changed = structuredClone(actual); mutate(changed);
        assert.throws(() => assertDiskFullQuality(changed, expected), /Disk full-quality evidence/); qualityChecks++;
    }
}
const currentProbe = read('scripts/probe-disk-continuity-current.mjs').toString();
assert(currentProbe.includes('qa.quality.captureDiskQuality(s, qa.river.river)'));
assert(currentProbe.includes('assertDiskFullQuality(sample.qualityEvidence, { mobile, bloom, viewport: page.viewportSize() })'));
assert(currentProbe.includes('/?quality=high&dpr=1&focus=saturn'));
assert(currentProbe.includes("assertCrossingAcceptance(report.samples, 'candidate')"));
console.log(`Current disk full-quality: ${qualityChecks} legacy/current positive and incompatible actual-renderer negative controls passed; no pixel or recovery threshold changed.`);

// Execute the current probe's actual nested draw function against a bounded
// compositor model. The original omission draws optics once in the world pass
// and again in LensPass, despite each individual GPU readback being healthy.
const drawFunction = currentProbe.match(/    function draw\(\) \{[\s\S]*?\n    \}/)?.[0];
assert(drawFunction, 'Actual current-disk draw callback');
const prepareLens = 'lens.updateLensing(s.camera, s.camera.aspect);';
assert.equal(drawFunction.split(prepareLens).length, 2);
function inspectDrawOrdering(source, bloom) {
    let holeVisible = true, worldHoleDraws = 0, opticalDraws = 0, prepared = 0;
    const scene = { camera: { aspect: 1.5 }, renderer: { getRenderTarget: () => null }, composer: { render() {
        if (holeVisible) worldHoleDraws++; opticalDraws++; holeVisible = true;
    } } };
    const lens = { updateLensing() { prepared++; holeVisible = false; }, renderLensed() { holeVisible = false; opticalDraws++; holeVisible = true; } };
    const window = { __qaBloom: bloom, __diskPlanePointerSnapshot: () => ({}) };
    const gl = { finish() {}, readPixels() {}, getError: () => 0, isContextLost: () => false, RGBA: 6408, UNSIGNED_BYTE: 5121 };
    const qa = { readbacks: 0 }, pointerSnapshots = [];
    const draw = new Function('s', 'lens', 'window', 'gl', 'qa', 'pointerSnapshots', 'width', 'height', source+'; return draw;')(
        scene, lens, window, gl, qa, pointerSnapshots, 1, 1);
    draw(); draw();
    assert.equal(qa.readbacks, 2); assert.equal(pointerSnapshots.length, 2);
    return { prepared, worldHoleDraws, opticalDraws };
}
for (const bloom of [false, true]) assert.deepEqual(inspectDrawOrdering(drawFunction, bloom),
    { prepared: 2, worldHoleDraws: 0, opticalDraws: 2 });
assert.deepEqual(inspectDrawOrdering(drawFunction.replace(prepareLens, ''), true),
    { prepared: 0, worldHoleDraws: 2, opticalDraws: 2 }, 'Retain the old duplicate-optics bloom failure');
console.log('Current disk draw ordering: each production direct/bloom readback prepares lens visibility; original omitted preparation reproduces duplicate world/lens optics. Pixel thresholds unchanged.');
