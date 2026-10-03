// Hosted Chromium only. Local --validate checks syntax, the real production
// construction contract, geometric containment, and the complete case plan;
// it never starts a server or browser. Run the normal entry point in CI.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { boundedDiagnostic } from './qa-bounded-diagnostic.mjs';
import { buildPlan, makeGeometry, containmentProof, DISTANCES, GAPS_KM, RADIUS, CLOUD_RADIUS, SIZE, NEAR, FAR, failureReplayPlan, FAILURE_REPLAY_MODES } from './cloud-depth-fixture.mjs';

const plan = buildPlan();
const source = await readFile('src/bodies.js', 'utf8');
assert(source.includes('earth = new THREE.Mesh(sphere(radius, 96, 72, 48, 32), earthMat)'), 'fixture matches production ground topology');
assert(source.includes('sphere((R_EARTH + EARTH_CLOUD_HEIGHT_KM) * K, 96, 72, 96, 64)'), 'fixture matches production cloud topology');
assert(source.includes('applyTerrellToMaterial(createEarthCloudMaterial(maps.clouds, () => BH.n > 0))'), 'fixture uses the production cloud factory and Terrell patch');
assert(source.includes('registerEarthCloudGround(clouds, earth)'), 'production registers its actual Earth/cloud pair');
assert(Math.abs(CLOUD_RADIUS - RADIUS - .006) < 1e-12, 'physical cloud radius remains six kilometres above Earth');
const containment = {};
for (const tier of ['desktop', 'mobile']) {
    const geometry = makeGeometry(tier), proof = containmentProof(geometry.cloud);
    assert(proof.minimumClearanceKm > .6 && proof.maximumRadiusError < 5e-7, `${tier}: cloud contains the entire ground sphere without changing physical altitude`);
    assert.equal(proof.triangles, tier === 'mobile' ? 12096 : 13632);
    assert.equal(geometry.ground.index.count / 3, tier === 'mobile' ? 2976 : 13632);
    containment[tier] = proof;
    geometry.ground.dispose(); geometry.cloud.dispose();
}
for (const tier of ['desktop', 'mobile']) for (const distance of DISTANCES) for (const kind of ['clear', 'contact', 'limb']) {
    assert(plan.cases.some(c => c.tier === tier && c.distance === distance && c.kind === kind), `missing ${tier}/${distance}/${kind}`);
}
for (const gapKm of GAPS_KM) assert(plan.cases.some(c => c.gapKm === gapKm), `missing ${gapKm} km contact sweep`);
for (const mode of ['paused', 'active', 'reverse']) assert(plan.cases.some(c => c.mode === mode), `missing ${mode} exposure`);
if (process.argv.includes('--validate')) {
    for (const file of ['scripts/cloud-depth-fixture.mjs', 'scripts/verify-cloud-depth.mjs']) execFileSync(process.execPath, ['--input-type=module', '--check'], { input: await readFile(file, 'utf8') });
    for (const distance of DISTANCES) {
        const replay = failureReplayPlan({ kind: 'clear', distance });
        assert.equal(replay.length * FAILURE_REPLAY_MODES.length, 12, 'failure replay has exactly twelve possible draws');
        assert(replay.every(stage => stage.near < distance - CLOUD_RADIUS), 'diagnostic near planes retain the entire physical cloud shell');
        assert(replay[1].near > NEAR && replay[2].alternateContext, 'larger-near and non-MSAA controls are separate');
    }
    console.log(JSON.stringify({ valid: true, browserStarted: false, cases: plan.cases.length, skipped: plan.skipped.length, failureReplayMaximumFrames: 12, containment }, null, 2));
    process.exit(0);
}

const out = resolve(process.env.ARTEMIS_EVIDENCE || 'evidence/cloud-depth-webgl');
await mkdir(out, { recursive: true });
const report = {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    scope: 'Isolated production Earth and cloud materials, actual 2K textures, actual material.onBeforeRender guard and Three render lists. No application clock, atmosphere, galaxy, HUD, ship-scene or frame-time acceptance.',
    raster: { viewport: [SIZE, SIZE], fovDegrees: 48, near: NEAR, far: FAR, requestedAntialias: true, depthRequirement: 'exactly 24 bits', tolerances: 'zero changed pixels; no numeric acceptance threshold' },
    oracle: 'Diagnostic only: cloud depthTest is disabled solely for a beta=0, no-foreground, enclosing front-face shell over Earth. Convex face-plane containment is proven. All production candidates and foreground baselines keep depthTest=true and depthWrite=false.',
    foregroundPolicy: 'Guarded foreground/limb renders must exactly equal the identical unbiased baseline. Conservative fallback may preserve old cloud/Earth speckles. A forced fixed -2 offset is an explicitly unsafe negative control, never production acceptance.',
    phasePolicy: 'Matched renderer phases and exposure signs only. Repeat/reverse checks do not validate the application simulation clock.',
    distances: DISTANCES, gapsKm: GAPS_KM, containment, skipped: plan.skipped, expectedCases: plan.cases.length,
    expectedRenderedFrames: plan.cases.length * 3 + 4 * 3 + 5 * 2 + 14 * 7,
    checks: [], cases: [], sequences: [], screenshots: [], errors: [], passed: false,
};
for (const path of ['src/bodies.js', 'src/render/planetAppearance.js', 'src/render/cloudDepthGuard.js', 'src/render/bodyBoundsHooks.js', 'src/render/relativeBodyFrame.js', 'src/render/bodySurfaceMaterial.js', 'src/render/surfaceRotationExposure.js', 'src/relView.js', 'src/state.js',
    'scripts/cloud-depth-fixture.mjs', 'scripts/verify-cloud-depth.mjs', 'public/textures/2k_earth_daymap.jpg', 'public/textures/2k_earth_nightmap.jpg', 'public/textures/2k_earth_clouds.jpg']) {
    (report.sourceSha256 ||= {})[path] = createHash('sha256').update(await readFile(path)).digest('hex');
}
const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
const check = (ok, name) => { report.checks.push({ name, pass: !!ok }); assert(ok, name); };
const bounded = async (name, task, timeout = 120000) => {
    const result = await boundedDiagnostic(task, timeout);
    if (!result.ok) throw new Error(`${name}: ${result.error}`);
    return result.value;
};
let browser, server, page;
const captured = new Set();
async function capture(label) {
    if (captured.has(label)) return;
    captured.add(label);
    const images = await bounded('bounded pixel diagnostics', () => page.evaluate(() => cloudDepthQA.images()), 15000);
    for (const image of images) {
        const file = `${String(report.cases.length).padStart(4, '0')}-${label}-${image.name}.png`;
        await writeFile(resolve(out, file), Buffer.from(image.data, 'base64'));
        report.screenshots.push({ file, caseIndex: report.cases.length - 1, diagnostic: image.name !== 'guarded' });
    }
}
function caseFailures(result) {
    const failures = [];
    const require = (ok, name) => { if (!ok) failures.push(name); };
    require(result.physicalUnchanged, 'render controls changed physical matrices, altitude, projection or exposure');
    require(result.guarded.depthTest && !result.guarded.depthWrite, 'guarded draw changed depthTest/depthWrite');
    require(result.baseline.depthTest && !result.baseline.depthWrite && !result.baseline.offset, 'unbiased diagnostic is not the exact ordinary-depth baseline');
    require(result.guarded.lists.hasGround && result.guarded.lists.hasCloud, 'real Three render lists did not include both Earth and clouds');
    require(JSON.stringify(result.programs) === JSON.stringify(report.programBaseline), 'material shader cache grew or changed after warmup');
    if (result.kind === 'clear') {
        require(result.guarded.guard.enabled && result.guarded.guard.reason === 'clear-cloud-footprint' && result.guarded.offset, 'clear footprint did not enable production bias');
        require(!result.guarded.lists.hasProbe, 'ordering oracle unexpectedly includes a foreground probe');
        require(!result.control.depthTest && !result.control.depthWrite && !result.control.offset, 'ordering oracle changed more than cloud depth testing');
        require(result.guardedVsOracle.pixels === 0, `guarded shell has ${result.guardedVsOracle.pixels} cloud/Earth ordering errors`);
        require(result.guardedVsBaseline.coveragePixels === 0 && result.guardedVsBaseline.alphaPixels === 0, 'bias changed silhouette or alpha coverage');
    } else {
        require(result.guarded.lists.hasProbe, 'foreground probe did not enter the actual draw list');
        require(!result.guarded.guard.enabled && result.guarded.guard.reason === 'foreground-overlap' && !result.guarded.offset, 'foreground/limb bound did not disable production bias');
        require(result.guardedVsBaseline.pixels === 0, `guarded fallback differs from unbiased baseline at ${result.guardedVsBaseline.pixels} pixels`);
        require(result.foreground.baselinePixels > 0, 'foreground control had no visible solid probe pixels');
        require(result.foreground.lostBaselinePixels === 0 && result.foreground.candidatePixels === result.foreground.baselinePixels, 'guarded fallback lost foreground coverage');
        require(result.control.depthTest && !result.control.depthWrite && result.control.offset, 'forced fixed-bias negative control is malformed');
    }
    return failures;
}
try {
    server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'cloud-depth-fixture', configureServer(server) {
        server.middlewares.use((req, res, next) => {
            if (req.url !== '/__cloud-depth-qa') return next();
            res.setHeader('Content-Type', 'text/html');
            res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><body style="margin:0;background:#141414"><script type="module" src="/scripts/cloud-depth-fixture.mjs"></script>');
        });
    } }] });
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    // CSS viewport is independent of the bounded 512-square raster. Desktop
    // worker preparation policy is declared; both production mesh tiers run.
    page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(120000);
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__cloud-depth-qa`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.cloudDepthQA?.ready || window.cloudDepthQA?.error);
    check(!await page.evaluate(() => cloudDepthQA.error), 'production-material fixture initializes');
    report.environment = await page.evaluate(() => cloudDepthQA.environment());
    check(report.environment.webgl2 && report.environment.depthBits === 24, 'actual hosted WebGL2 attachment has 24-bit depth');
    check(report.environment.maps.every(map => map.width === 2048 && map.height === 1024), 'all three actual 2K source maps are loaded');
    check(report.environment.geometry.desktop.groundTriangles === 13632 && report.environment.geometry.mobile.groundTriangles === 2976, 'actual raster ground meshes retain production tessellation');
    check(report.environment.geometry.desktop.cloud.triangles === 13632 && report.environment.geometry.mobile.cloud.triangles === 12096, 'actual raster cloud meshes retain production tessellation');
    await page.waitForFunction(() => cloudDepthQA.preparation().pending === 0);
    report.preparation = await page.evaluate(() => cloudDepthQA.preparation());
    check(report.preparation.built === 3 && report.preparation.workerFailures === 0, 'production exposure worker prepares all three actual image sources');
    report.warmup = await bounded('warm two production shader variants and mesh tiers', () => page.evaluate(() => {
        const results = [];
        for (const tier of ['desktop', 'mobile']) for (const mode of ['paused', 'active']) results.push(cloudDepthQA.run({ kind: 'contact', tier, mode, distance: 25, phase: 3, gapKm: 1 }));
        return { programs: cloudDepthQA.programs(), active: !!cloudDepthQA.earth.material.defines?.SURFACE_ROTATION_EXPOSURE && !!cloudDepthQA.cloud.material.defines?.SURFACE_ROTATION_EXPOSURE,
            radii: [cloudDepthQA.earth.geometry.parameters.radius, cloudDepthQA.cloud.geometry.parameters.radius], results };
    }));
    check(report.warmup.active, 'both production exposure shaders activate through updateEarthSurfaceExposure');
    report.programBaseline = report.warmup.programs;
    check(report.programBaseline.earth.length === 2 && report.programBaseline.cloud.length === 2, 'exact and exposed Earth/cloud programs are both compiled');
    report.policyTransitions = await bounded('actual black-hole and relativistic state transitions', () => page.evaluate(() => cloudDepthQA.policyTransitions()));
    for (const state of report.policyTransitions.states) {
        const expectedReason = state.holes ? 'draw-deformation-context' : state.beta ? 'unsupported-projection' : 'clear-cloud-footprint';
        check(state.guard.reason === expectedReason && state.offset === !(state.holes || state.beta), `${state.name}: production callback follows actual BH.n and relativistic uniform state`);
        check(state.depthTest && !state.depthWrite, `${state.name}: ordinary depth tests and writes are unchanged`);
        if (state.holes || state.beta) check(state.guardedVsBaseline.pixels === 0, `${state.name}: conservative draw matches the unbiased baseline exactly`);
    }
    check(JSON.stringify(report.policyTransitions.programs) === JSON.stringify(report.programBaseline), 'policy transitions do not create shader variants');
    await save();
    for (const spec of plan.cases) {
        const result = await bounded('render isolated case', () => page.evaluate(spec => cloudDepthQA.run(spec), spec));
        result.failures = caseFailures(result); report.cases.push(result);
        if (result.failures.length) {
            const originalFailure = new Error(`${JSON.stringify(spec)}: ${result.failures.join('; ')}`);
            // Freeze the original verdict and original three images before any
            // replay. Diagnostics cannot clear or replace this failing result.
            report.failure = originalFailure.stack; await save();
            report.originalFailureImages = await boundedDiagnostic(() => capture('failure'), 20000);
            await save();
            await writeFile(resolve(out, 'failure-original-report.json'), JSON.stringify(report, null, 2));
            if (spec.kind === 'clear' && report.originalFailureImages.ok) {
                try {
                    report.failureReplay = await boundedDiagnostic(() => page.evaluate(spec => cloudDepthQA.failureReplay(spec), spec), 90000);
                    report.failureReplay.sourceSha256 = { ...report.sourceSha256 };
                    if (report.failureReplay.ok) {
                        for (const context of report.failureReplay.value.contexts) {
                            const images = context.images; context.images = [];
                            for (const image of images) {
                                const file = `${String(report.cases.length).padStart(4, '0')}-failure-replay-${context.label}-${image.name}.png`;
                                const record = { file, mode: image.name, written: false }; context.images.push(record);
                                await writeFile(resolve(out, file), Buffer.from(image.data, 'base64')); record.written = true;
                                report.screenshots.push({ file, caseIndex: report.cases.length - 1, diagnostic: true });
                            }
                        }
                    } else report.failureReplay.restorationUnverified = true;
                    await writeFile(resolve(out, 'failure-replay.json'), JSON.stringify(report.failureReplay, null, 2));
                } catch (error) { report.failureReplayPersistenceError = error.stack || String(error); }
                await save();
            }
            throw originalFailure;
        }
        if (result.kind === 'clear' && result.controlVsBaseline.pixels > 0) await capture('zero-bias-speckles');
        if (result.kind === 'contact' && result.foreground.fixedLostBaselinePixels > 0) await capture('near-contact-negative-control');
        if (result.kind === 'limb' && result.foreground.fixedLostBaselinePixels > 0) await capture('limb-negative-control');
        if (report.cases.length % 24 === 0) { await save(); console.log(`Validated ${report.cases.length}/${plan.cases.length} isolated cloud-depth cases`); }
    }
    for (const tier of ['desktop', 'mobile']) for (const distance of DISTANCES) {
        const result = await bounded('matched renderer-phase repeat sequence', () => page.evaluate(({ tier, distance }) => cloudDepthQA.sequence(tier, distance), { tier, distance }));
        report.sequences.push(result);
        check(result.pausedExact && result.reverseExposureExact && result.returnToPhaseExact, `${tier}/${distance}: pause, exposure reversal and revisited physical phase render exactly`);
        check(JSON.stringify(result.programs) === JSON.stringify(report.programBaseline), `${tier}/${distance}: phase changes reuse cached material programs`);
    }
    report.totals = {
        clearCases: report.cases.filter(c => c.kind === 'clear').length,
        contactCases: report.cases.filter(c => c.kind === 'contact').length,
        limbCases: report.cases.filter(c => c.kind === 'limb').length,
        zeroBiasWrongPixels: report.cases.filter(c => c.kind === 'clear').reduce((sum, c) => sum + c.controlVsBaseline.pixels, 0),
        guardedOrderingWrongPixels: report.cases.filter(c => c.kind === 'clear').reduce((sum, c) => sum + c.guardedVsOracle.pixels, 0),
        fallbackChangedPixels: report.cases.filter(c => c.kind !== 'clear').reduce((sum, c) => sum + c.guardedVsBaseline.pixels, 0),
        forcedBiasContactCoverageLoss: report.cases.filter(c => c.kind === 'contact').reduce((sum, c) => sum + c.foreground.fixedLostBaselinePixels, 0),
        forcedBiasLimbCoverageLoss: report.cases.filter(c => c.kind === 'limb').reduce((sum, c) => sum + c.foreground.fixedLostBaselinePixels, 0),
    };
    check(report.cases.length === plan.cases.length, 'every declared distance, phase and front-of-camera contact case executed');
    check(report.totals.zeroBiasWrongPixels > 0, 'zero-bias negative control reproduces actual-texture cloud/Earth speckles');
    check(report.totals.forcedBiasContactCoverageLoss > 0, 'near-contact negative control detects the unsafe unguarded fixed bias');
    check(report.totals.forcedBiasLimbCoverageLoss > 0, 'limb negative control detects unsafe fixed-bias overpainting');
    check(report.totals.guardedOrderingWrongPixels === 0 && report.totals.fallbackChangedPixels === 0, 'production guard repairs clear-footprint order and exactly preserves foreground/limb baselines');
    report.final = await page.evaluate(() => ({ renderedFrames: cloudDepthQA.renderedFrames, hookCalls: cloudDepthQA.hookCalls, programs: cloudDepthQA.programs(), memory: cloudDepthQA.renderer.info.memory,
        depthTest: cloudDepthQA.cloud.material.depthTest, depthWrite: cloudDepthQA.cloud.material.depthWrite, beta: cloudDepthQA.earth.material.uniforms.uBeta.value }));
    check(report.final.hookCalls === report.final.renderedFrames && report.final.renderedFrames === report.expectedRenderedFrames, 'actual production material hook ran on all 1,836 explicitly bounded frames');
    check(report.final.depthTest && !report.final.depthWrite && report.final.beta === 0, 'all diagnostic depth state is restored');
    check(report.errors.length === 0, 'no script, shader, asset or worker errors');
    report.passed = true; console.log(JSON.stringify(report.totals, null, 2));
} catch (error) {
    report.failure = error.stack || String(error); process.exitCode = 1;
    console.error(report.failure);
    if (page) report.failureScreenshot = await boundedDiagnostic(() => page.screenshot({ path: resolve(out, 'failure-browser.png'), timeout: 10000 }).then(() => true), 12000);
} finally {
    await save();
    if (browser) report.browserClose = await boundedDiagnostic(() => browser.close(), 15000);
    if (server) report.serverClose = await boundedDiagnostic(() => server.close(), 10000);
    await save();
}
