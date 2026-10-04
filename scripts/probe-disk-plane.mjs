// Prepared LOCAL paired browser QA. Nothing starts for --validate or --validate-hooks.
// Run only after authorization: each DEVICE=desktop|mobile and BLOOM=0|1 pair,
// BASE_ROOT=<exact main> EXPECTED_CANDIDATE_REVISION=<committed candidate>.
// This diagnoses issue50 disk continuity. It does not validate a ring-depth fix.
// --baseline-resize-observation requires desktop+bloom and ends at capture45;
// it preserves failures and labels a matching bounded replay inconclusive.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diskInputs, hash, verifyDiskSource } from './disk-plane-source-contract.mjs';
import { COARSE_PITCHES, DISK_PLANE_CASES, MATRIX, RESIZE_CASES, RECOVERY_CONTROLS, REPEAT_CYCLES, QA_OPERATION_BUDGET, transformDiskPlaneSource,
    validateDiskPlaneHooks, assertCrossingAcceptance, assertPairedControl } from './disk-plane-qa.mjs';
import { prepareContextRecoveryQA, contextLossSettled, contextRestoreSettled,
    recoveredGpuIsHealthy, pausedRecoveryPassed } from './context-recovery-qa.mjs';
import { atomicDiskReport, initializeDiskReport, finalizeDiskProbe } from './disk-plane-finalize.mjs';
import { installNativeRingProof } from './native-ring-proof.mjs';
import { installLensResizeObserver, wantsResizeDiagnostic, RESIZE_DIAGNOSTIC_PLAN, captureWithResizeEvidence, removeResizeObservers } from './lens-resize-observer.mjs';
import { diskProbeModes, BASELINE_RESIZE_BUDGET, assertNextBaselineObservation,
    baselineObservationAtStop, finishBaselineObservation } from './baseline-resize-observation.mjs';

const candidateRoot = resolve(process.env.CANDIDATE_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const baselineRoot = process.env.BASE_ROOT && resolve(process.env.BASE_ROOT);
const device = process.env.DEVICE || 'desktop', bloomOption = process.env.BLOOM || '0';
assert(['desktop', 'mobile'].includes(device), 'DEVICE must be desktop or mobile');
assert(['0', '1'].includes(bloomOption), 'BLOOM must be 0 or 1');
const { hooksOnly, validateOnly, baselineResizeObservation } = diskProbeModes(process.argv.slice(2), device, bloomOption);
const mobile = device === 'mobile', bloom = bloomOption === '1';
const matrixEntry = `${device}-${bloom ? 'bloom' : 'direct'}`;
const matrix = baselineResizeObservation ? ['desktop-bloom'] : MATRIX;
const operationBudget = baselineResizeObservation ? BASELINE_RESIZE_BUDGET : QA_OPERATION_BUDGET;
const hookChecks = [validateDiskPlaneHooks(candidateRoot)];
if (baselineRoot) hookChecks.unshift(validateDiskPlaneHooks(baselineRoot));
if (hooksOnly) {
    console.log(JSON.stringify({ mode: 'hooks-only', hookChecks, matrix, operationBudget, resizeDiagnosticPlan: RESIZE_DIAGNOSTIC_PLAN, browserStarted: false,
        sourceBound: false, runtimeAcceptance: false }, null, 2));
    process.exit(0);
}
assert(baselineRoot, 'BASE_ROOT must identify the exact main checkout');
assert.notEqual(baselineRoot, candidateRoot, 'Use separate exact-main and candidate roots');
assert(process.env.EXPECTED_CANDIDATE_REVISION, 'EXPECTED_CANDIDATE_REVISION is mandatory');
const bindSources = () => ({ main: verifyDiskSource(baselineRoot, 'A', diskInputs.baseline),
    candidate: verifyDiskSource(candidateRoot, 'B', process.env.EXPECTED_CANDIDATE_REVISION) });
const sourceBindingBefore = bindSources();
if (validateOnly) {
    console.log(JSON.stringify({ mode: 'source-validation', hookChecks, matrix, operationBudget, resizeDiagnosticPlan: RESIZE_DIAGNOSTIC_PLAN, sourceBindingBefore,
        sourceBindingAfter: bindSources(), browserStarted: false, runtimeAcceptance: false }, null, 2));
    process.exit(0);
}

// Deliberately import browser/server packages only after both validation exits.
const { chromium } = await import('playwright');
const { createServer } = await import('vite');
const out = resolve(process.env.ARTEMIS_EVIDENCE || `evidence/disk-plane/${matrixEntry}`);
await mkdir(out, { recursive: true });
const viewport = mobile ? { width: 390, height: 700 } : { width: 960, height: 640 };
const alternateViewport = mobile ? { width: 430, height: 760 } : { width: 840, height: 600 };
const report = { schema: 1, matrixEntry, matrix, mobile, bloom, completed: false,
    operationBudget,
    resizeDiagnosticPlan: RESIZE_DIAGNOSTIC_PLAN,
    sourceBindingBefore, sourceBindingAfter: null, diagnosticOnly: true,
    scope: 'Issue50 disk-plane continuity only; exact main paired with disk-only candidate.',
    ringEvidence: 'Actual ring draw program/sampler/filter state plus disk-off/TDE-off unchanged pixels. No alpha-gap or source-depth repair claim.',
    limitations: ['Chromium/SwiftShader viewport emulation is not physical mobile/Safari evidence.',
        'Controlled WEBGL_lose_context proves this recovery path, not the original device-loss trigger.',
        'No physical model, ring filter, planet appearance, lensing, or silhouette-edge change is accepted by this probe.',
        'This diagnostic is not a performance benchmark or a full-source acceptance run.'],
    omissions: ['unrelated cosmic background, HYG/tier-1 catalogs, merger worker, gravity-flow overlay'],
    variants: {}, pairedControls: [] };
if (baselineResizeObservation) Object.assign(report, { executionMode: 'baseline-resize-observation', acceptanceClaim: false,
    scope: 'One baseline desktop/bloom observation through the exact second alternate near-lens resize capture.',
    baselineResizeObservation: { completed: false, acceptanceClaim: false, outcome: 'pending',
        interpretation: 'A disappearing mismatch is inconclusive and does not establish renderer acceptance.' } });
let browser, server, observedPage, originalError, hadOriginalError=false;
const mainControls = new Map();
const flush = options => atomicDiskReport(resolve(out, 'report.json'),report,options);

// Runs inside the page: configure only the frozen diagnostic camera/hole.
function configureCase({ scenario, pitch }) {
    const { s, st, b, bh, c, sat, enc, e } = window.qa;
    const foreground = scenario === 'saturn-foreground-lens';
    st.BH.x[0] = qa.initialHole.x + (foreground ? 150000 : 0);
    st.BH.y[0] = qa.initialHole.y + (foreground ? 2000000 : 0);
    enc.syncHoleScene(); // Paused frames intentionally do not step physical caches.
    const physicalHole = bh.BH_META[0].g.position.clone().set((e.eph.earthX + st.BH.x[0]) * c.K,
        st.BH.z[0] * c.K, -(e.eph.earthY + st.BH.y[0]) * c.K);
    st.G.focus = 'free';
    s.cam.tgt.copy(scenario === 'disk-crossing' ? physicalHole : b.plGroups[sat].position);
    if (scenario.startsWith('saturn-')) s.cam.tgt.x -= 75;
    s.cam.dist = scenario === 'disk-crossing' ? st.BH.rs[0] * c.K * 8 : 600;
    s.cam.distTarget = null; s.cam.yaw = Math.PI / 2; s.cam.pitch = pitch;
    window.__celestialFrame();
    bh.updateBHVisuals(0, e.eph.earthX * c.K, -e.eph.earthY * c.K);
    qa.physicalHole = physicalHole;
}

// Every readback comes from the production direct/composer path. The only
// bloom-disabled draws are the two foreground opacity comparisons.
function captureCase({ scenario, pitch, includeImages = true, resizeDiagnosticPhase = null }) {
    const { s, st, b, bh, c, sat, tde, lens, hole, bloom, rings } = window.qa;
    const foreground = scenario === 'saturn-foreground-lens';
    const m = bh.BH_META[0], disk = m.optics.disk, state = tde.tidalState(sat);
    const original = { tidalActive: state.active, diskVisible: disk.visible, ringVisible: rings.map(r => r.visible) };
    const gl = s.renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    if (gl.isContextLost() || s.renderContext.isLost()) throw Error('Cannot capture a lost GPU context');
    const encode = bytes => {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return btoa(binary);
    };
    const draw = ({ lensed = true, tides = true, diskOn = true, ringsOn = true, opacityControl = false, identity = false } = {}) => {
        state.active = tides && original.tidalActive; disk.visible = diskOn;
        rings.forEach((ring, i) => { ring.visible = ringsOn && original.ringVisible[i]; });
        if (lensed) lens.updateLensing(s.camera, s.camera.aspect);
        else { lens.lensingPass.enabled = false; hole.holeRoot.visible = true; }
        const lensCount = lens.lensingPass.uniforms.uN.value, bloomEnabled = s.bloomPass.enabled;
        if (identity) lens.lensingPass.uniforms.uN.value = 0;
        const usedLensCount = lens.lensingPass.uniforms.uN.value;
        if (opacityControl) s.bloomPass.enabled = false;
        try {
            if (bloom) s.composer.render();
            else if (lensed) lens.renderLensed(s.renderer, s.scene, s.camera);
            else s.renderSceneTiered(s.renderer, s.scene, s.camera);
            gl.finish();
            const bytes = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
            const glError = gl.getError();
            if (glError !== 0 || gl.isContextLost()) throw Error(`Unhealthy GPU readback: ${glError}`);
            qa.readbacks++;
            return { bytes, png: includeImages ? s.renderer.domElement.toDataURL('image/png') : null,
                glError, usedLensCount, bloomEnabled: !!s.bloomPass.enabled, target: s.renderer.getRenderTarget() === null };
        } finally {
            lens.lensingPass.uniforms.uN.value = lensCount;
            s.bloomPass.enabled = bloomEnabled;
        }
    };
    try {
        const productionCapture = () => scenario.startsWith('saturn-') ? window.__diskPlaneNativeRingProof(s.renderer, rings, () => draw()) : { value: draw(), proof: null };
        const diagnostic = resizeDiagnosticPhase ? window.__diskPlaneObserveLensResize(resizeDiagnosticPhase, productionCapture) : null;
        const observed = diagnostic ? diagnostic.value : productionCapture();
        const production = observed.value, noLens = draw({ lensed: false }), noTides = draw({ tides: false });
        const plain = draw({ lensed: false, tides: false }), noDisk = draw({ diskOn: false });
        const ringControl = scenario.startsWith('saturn-') ? draw({ diskOn: false, tides: false }) : null;
        const ringAbsent = ringControl ? draw({ diskOn: false, tides: false, ringsOn: false }) : null;
        const opaqueLensed = foreground ? draw({ tides: false, opacityControl: true }) : null;
        // Same render target and compositor, with uN=0: avoids MSAA/canvas
        // rasterization differences masquerading as foreground deflection.
        const opaqueIdentity = foreground ? draw({ tides: false, opacityControl: true, identity: true }) : null;
        const body = b.plGroups[sat], bodyCenter = body.position.clone().project(s.camera);
        const bodyDepth = -body.position.clone().applyMatrix4(s.camera.matrixWorldInverse).z;
        const bodyRadius = c.PL[sat].R * c.K / bodyDepth * s.camera.projectionMatrix.elements[5] * height * .5;
        const metrics = { lensChanged: 0, lensUndeformed: 0, tidalChanged: 0, opaquePixels: 0, opaqueChanged: 0,
            identityVsDirectChanged: 0, diskPixels: 0, diskLight: 0, nonBlackPixels: 0, ringPixels: 0 };
        const ringMask = new Uint8Array(width * height), opaqueMask = new Uint8Array(width * height);
        const luminance = (bytes, i) => .2126 * bytes[i] + .7152 * bytes[i + 1] + .0722 * bytes[i + 2];
        for (let i = 0; i < production.bytes.length; i += 4) {
            const p = i / 4, light = luminance(production.bytes, i);
            if (light > 1) metrics.nonBlackPixels++;
            if (Math.abs(light - luminance(noLens.bytes, i)) > 8) metrics.lensChanged++;
            if (Math.abs(luminance(noTides.bytes, i) - luminance(plain.bytes, i)) > 8) metrics.lensUndeformed++;
            if (Math.abs(luminance(noLens.bytes, i) - luminance(plain.bytes, i)) > 8) metrics.tidalChanged++;
            const emit = light - luminance(noDisk.bytes, i);
            if (emit > 4) { metrics.diskPixels++; metrics.diskLight += emit; }
            if (ringControl && [0, 1, 2].some(k => Math.abs(ringControl.bytes[i + k] - ringAbsent.bytes[i + k]) > 1)) {
                ringMask[p] = 1; metrics.ringPixels++;
            }
            if (foreground) {
                const px = p % width + .5, py = Math.floor(p / width) + .5;
                if (Math.hypot(px - (bodyCenter.x * .5 + .5) * width, py - (bodyCenter.y * .5 + .5) * height) < bodyRadius * .55 && luminance(opaqueIdentity.bytes, i) > 8) {
                    opaqueMask[p] = 1; metrics.opaquePixels++;
                    if (Math.abs(luminance(opaqueLensed.bytes, i) - luminance(opaqueIdentity.bytes, i)) > 1) metrics.opaqueChanged++;
                    if (!bloom && Math.abs(luminance(opaqueIdentity.bytes, i) - luminance(plain.bytes, i)) > 1) metrics.identityVsDirectChanged++;
                }
            }
        }
        const physicalLensDepth = -qa.physicalHole.clone().applyMatrix4(s.camera.matrixWorldInverse).z;
        const control = frame => frame && ({ width, height, rgba: encode(frame.bytes) });
        const ringState = rings.map(ring => ({ visible: original.ringVisible[rings.indexOf(ring)],
            geometry: ring.geometry.type, transparent: ring.material.transparent, depthWrite: ring.material.depthWrite,
            depthTest: ring.material.depthTest, alphaTest: ring.material.alphaTest, side: ring.material.side,
            minFilter: ring.material.map.minFilter, magFilter: ring.material.map.magFilter,
            generateMipmaps: ring.material.map.generateMipmaps, anisotropy: ring.material.map.anisotropy,
            wrapS: ring.material.map.wrapS, wrapT: ring.material.map.wrapT, colorSpace: ring.material.map.colorSpace,
            mapName: ring.material.map.name, mapSize: [ring.material.map.image.width, ring.material.map.image.height] }));
        return { scenario, pitch, metrics, nativeRingState: ringState, nativeRingProof: observed.proof, resizeDiagnostic: diagnostic?.trace || null,
            images: includeImages ? { production: production.png, 'no-lens': noLens.png, 'no-tides': noTides.png,
                plain: plain.png, 'no-disk': noDisk.png, ...(ringControl ? { 'disk-off-tde-off': ringControl.png, 'disk-off-tde-off-ring-absent': ringAbsent.png } : {}),
                ...(foreground ? { 'opaque-lensed': opaqueLensed.png, 'opaque-identity-reference': opaqueIdentity.png } : {}) } : {},
            controls: { ...(ringControl ? { ring: { ...control(ringControl), mask: encode(ringMask) } } : {}),
                ...(foreground ? { opaque: { ...control(opaqueLensed), mask: encode(opaqueMask) } } : {}) },
            state: { meshSourceError: m.g.position.distanceTo(qa.physicalHole), physicalLensDepth, bodyDepth,
                lensDepthError: Math.min(...Array.from(lens.lensingPass.uniforms.uDist.value).slice(0, lens.lensingPass.uniforms.uN.value).map(z => Math.abs(z - physicalLensDepth))),
                opacityControl: foreground ? { sameTargetPath: true, identityLensCount: opaqueIdentity.usedLensCount,
                    actualLensCount: opaqueLensed.usedLensCount, bloomLensed: opaqueLensed.bloomEnabled, bloomIdentity: opaqueIdentity.bloomEnabled } : null,
                tidalActive: original.tidalActive, lambda: state.lambda, shrink: state.shrink, collapse: state.collapse,
                diskOn: disk.material.uniforms.uDiskOn.value, normal: disk.material.uniforms.uNormal.value.toArray(),
                origin: disk.material.uniforms.uOrigin.value.toArray(), distanceRs: disk.material.uniforms.uDistance.value,
                near: s.camera.near, far: s.camera.far, lensCount: lens.lensingPass.uniforms.uN.value,
                width, height, paused: st.G.paused, t: st.G.t, frameSuccess: window.__diskPlaneFrameSuccess,
                readbacks: qa.readbacks, nativeContextLost: gl.isContextLost(), lifecycleContextLost: s.renderContext.isLost(),
                canvasTarget: production.target, productionBloomEnabled: production.bloomEnabled,
                drawCalls: s.renderer.info.render.calls }, glError: production.glError };
    } finally {
        state.active = original.tidalActive; disk.visible = original.diskVisible;
        rings.forEach((ring, i) => { ring.visible = original.ringVisible[i]; });
        lens.updateLensing(s.camera, s.camera.aspect);
    }
}

async function settleAssets(page, test) {
    await page.evaluate(configureCase, test);
    // loadPlanetMap returns the actual memoized production load; do not accept
    // a transient procedural fallback or a timer as asset-readiness evidence.
    await page.evaluate(async () => {
        const map = await qa.textures.loadPlanetMap(qa.sat);
        if (!map) throw Error('Saturn photographic map did not load');
        qa.b.requestPlanetTexture(qa.sat);
        qa.expectedSaturnMap = map;
    });
    await page.waitForFunction(() => {
        const material = qa.b.plSurfaces[qa.sat].material, queue = qa.surface.diskPlaneAssetQueue();
        return material.map === qa.expectedSaturnMap && material.map?.image?.width > 0 &&
            qa.rings.every(r => r.material.map?.image?.width > 0 && !r.material.map.userData.procedural) &&
            queue.pending === 0 && !queue.inFlight && !queue.scheduled;
    });
    await page.evaluate(configureCase, test);
    const settled = await page.evaluate(() => ({ t: qa.st.G.t, paused: qa.st.G.paused,
        saturn: { name: qa.expectedSaturnMap.name, width: qa.expectedSaturnMap.image.width,
            height: qa.expectedSaturnMap.image.height, photographic: qa.b.plSurfaces[qa.sat].material.userData.surfacePhotographic },
        queue: qa.surface.diskPlaneAssetQueue() }));
    assert(settled.paused && settled.t === 0 && settled.saturn.photographic);
    assert.deepEqual(settled.queue, { pending: 0, scheduled: false, inFlight: false });
    return settled;
}

function assertLiveCase(result) {
    assert.equal(result.glError, 0); assert.equal(result.state.nativeContextLost, false);
    assert.equal(result.state.lifecycleContextLost, false); assert(result.state.canvasTarget);
    assert(result.state.frameSuccess > 0 && result.state.readbacks > 0 && result.state.drawCalls > 0, 'Live GPU and rendered-frame evidence');
    assert(result.metrics.nonBlackPixels > 0, 'Readback includes visible scene pixels');
    assert(result.state.paused && result.state.t === 0, 'All diagnostic frames preserve paused physical time');
    assert(result.state.meshSourceError < 1e-6, 'Drawn hole and physical lens positions match');
    assert(result.state.lensDepthError < .01, 'Selected lens depth matches the drawn hole');
    assert.equal(result.state.diskOn, 1, 'Steady quasar disk remains enabled on both sides');
    assert.equal(result.state.productionBloomEnabled, bloom, 'Requested production direct/bloom path is active');
    if (result.scenario.startsWith('saturn-')) {
        assert(result.nativeRingProof?.stateEvidenceOnly && result.nativeRingProof.hooksRestored);
        assert.equal(result.nativeRingProof.alphaGapGuarantee, false, 'Native draw evidence is not an alpha-gap repair guarantee');
        assert(result.nativeRingProof.samples.length > 0, 'Actual native Saturn ring draws were inspected');
        assert(result.nativeRingProof.samples.every(sample => sample.linked && sample.activeTextureRestored &&
            sample.sampler.textureMatchesRing && sample.shaders.every(shader => shader.compiled)), 'Linked programs, compiled shaders, and real bound ring samplers');
    }
    if (result.scenario === 'saturn-foreground-lens') {
        assert(result.state.physicalLensDepth > result.state.bodyDepth + 500, 'Lens is behind the complete body and rings');
        assert(result.metrics.opaquePixels > 50, 'Foreground mask samples visible opaque surface');
        assert.equal(result.metrics.opaqueChanged, 0, 'A lens behind the body cannot change its opaque interior');
        const control = result.state.opacityControl;
        assert.equal(control.identityLensCount, 0); assert(control.actualLensCount > 0);
        assert.equal(control.bloomLensed, false); assert.equal(control.bloomIdentity, false);
    }
}

async function saveResizeDiagnostic(trace, variant, stem) {
    if (trace) {
        for (const [index, pass] of trace.lensPasses.entries()) {
            if (!pass.sourceColor?.rgbaBase64) continue;
            const bytes = Buffer.from(pass.sourceColor.rgbaBase64, 'base64');
            const file = `${stem}-pre-lens-source-${index}.rgba`;
            await writeFile(resolve(out, variant, file), bytes);
            delete pass.sourceColor.rgbaBase64;
            Object.assign(pass.sourceColor, { file, bytes: bytes.length, sha256: hash(bytes) });
        }
        await writeFile(resolve(out, variant, `${stem}-resize-diagnostic.json`), JSON.stringify(trace, null, 2));
    }
}

async function saveCase(page, variant, test, phase) {
    const resizeDiagnosticPhase = wantsResizeDiagnostic({ variant, mobile, bloom, phase, ...test }) ? phase : null;
    const key = `${phase}/${test.scenario}/${test.pitch}`;
    const stem = `${phase}-${test.scenario}-${test.pitch}`;
    const result = await captureWithResizeEvidence({
        selected: !!resizeDiagnosticPhase,
        capture: () => page.evaluate(captureCase, { ...test, includeImages: true, resizeDiagnosticPhase }),
        recover: () => page.evaluate(() => window.__diskPlaneLastResizeTrace || null),
        save: trace => saveResizeDiagnostic(trace, variant, stem),
        onPersistenceError: error => { (report.resizeDiagnosticPersistenceErrors ||= []).push({ phase, error: error.stack || String(error) }); },
    });
    assertLiveCase(result);
    for (const [kind, png] of Object.entries(result.images)) {
        if (phase !== 'original' || COARSE_PITCHES.includes(test.pitch) || kind === 'production')
            await writeFile(resolve(out, variant, `${stem}-${kind}.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    result.productionSha256 = hash(Buffer.from(result.images.production.split(',')[1], 'base64'));
    delete result.images;
    for (const [name, control] of Object.entries(result.controls)) {
        const controlKey = `${key}/${name}`;
        if (variant === 'main') mainControls.set(controlKey, { ...control, nativeRingState: result.nativeRingState, nativeRingProof: result.nativeRingProof });
        else {
            const main = mainControls.get(controlKey);
            assert(main, `Paired main control exists: ${controlKey}`);
            assert.deepEqual(result.nativeRingState, main.nativeRingState, 'Native ring filters and state remain unchanged');
            assert.deepEqual(result.nativeRingProof, main.nativeRingProof, 'Actual native ring program and sampler state remain unchanged');
            report.pairedControls.push(assertPairedControl(main, control, controlKey, { allowEmpty: name === 'ring' && test.pitch === 0 }));
        }
    }
    delete result.controls;
    result.phase = phase;
    report.variants[variant].samples.push(result);
    await flush();
    return result;
}

async function assertStableControl(page, test) {
    const a = await page.evaluate(captureCase, { ...test, includeImages: false });
    const b = await page.evaluate(captureCase, { ...test, includeImages: false });
    assert.deepEqual(a.controls, b.controls, 'Settled frozen controls are stable across repeated draws');
    assert.deepEqual(a.metrics, b.metrics, 'No transient asset/frame mismatch in paired metrics');
    return { identical: true, readbackDelta: b.state.readbacks - a.state.readbacks, nativeRingState: a.nativeRingState };
}

async function recoverySnapshot(page) {
    return page.evaluate(() => ({ paused: qa.st.G.paused, t: qa.st.G.t, success: window.__diskPlaneFrameSuccess || 0,
        readbacks: qa.readbacks, contextLost: qa.s.renderer.getContext().isContextLost(),
        contextLifecycleLost: qa.s.renderContext.isLost(), losses: qa.s.renderContext.losses,
        restores: qa.s.renderContext.restores, canvasTarget: qa.s.renderer.getRenderTarget() === null }));
}

await initializeDiskReport(resolve(out,'report.json'),report);
try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    variantLoop: for (const [variant, root] of baselineResizeObservation ? [['main', baselineRoot]] : [['main', baselineRoot], ['candidate', candidateRoot]]) {
        const local = report.variants[variant] = { revision: sourceBindingBefore[variant].revision,
            errors: [], samples: [], assets: [], stability: [], recoveries: [], crossingAcceptance: null };
        await mkdir(resolve(out, variant), { recursive: true });
        server = await createServer({ root, configFile: false, logLevel: 'error',
            server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'disk-plane-diagnostic', enforce: 'pre',
                resolveId(id) { if (id === 'virtual:galaxy-preview') return '\0off'; },
                load(id) { if (id === '\0off') return 'export default null;'; },
                transform: transformDiskPlaneSource }] });
        await server.listen();
        const page = await browser.newPage({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
        page.setDefaultTimeout(180000);
        page.on('pageerror', e => local.errors.push(e.stack || e.message));
        page.on('console', message => {
            if (message.type() === 'error' && /THREE|Shader|GL_INVALID/.test(message.text())) local.errors.push(message.text());
        });
        await page.addInitScript(bloom => {
            window.__qaBloom = bloom; Date.now = () => Date.UTC(2026, 9, 3, 12);
            localStorage.clear(); localStorage.setItem('ap_introSeen', '1');
        }, bloom);
        await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.fulfill({ contentType: 'text/css', body: '' }));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=saturn&dist=600&bloom=${bloom ? 1 : 0}&river=0&field=0&realsky=0&tier1=0&galaxies=0&galaxyvol=0&galaxy=0&compile=0&hidehelp=1&planetmaps=1&earthnight=0`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__AP_READY && window.__celestialFrame);
        await page.evaluate(async () => {
            window.qa = { bloom: !!window.__qaBloom, readbacks: 0, s: await import('/src/scene.js'),
                st: await import('/src/state.js'), b: await import('/src/bodies.js'), bh: await import('/src/blackholes.js'),
                c: await import('/src/constants.js'), e: await import('/src/ephemeris.js'), tde: await import('/src/tdeVisuals.js'),
                hole: await import('/src/holeOptics.js'), lens: await import('/src/lensing.js'), enc: await import('/src/bhEncounters.js'),
                textures: await import('/src/textures.js'), surface: await import('/src/render/bodySurfaceMaterial.js') };
            qa.sat = qa.c.PL.findIndex(p => p.name === 'SATURN');
            qa.rings = [];
            qa.b.plGroups[qa.sat].traverse(object => {
                if (object.geometry?.type === 'RingGeometry' && object.material?.isMeshLambertMaterial) qa.rings.push(object);
            });
            if (qa.rings.length !== 1) throw Error('Exactly one native Saturn ring is required');
            qa.st.G.paused = true; qa.st.G.gr = false; qa.st.G.predict = false; qa.st.G.focus = 'free';
            qa.bh.clearBlackHoles();
            qa.bh.addBlackHole(qa.e.eph.plX[qa.sat] - 150000, qa.e.eph.plY[qa.sat] - 100000,
                50000, 0, 0, true, null, 1, 0, qa.e.eph.plZ[qa.sat], 0);
            await window.__celestialEnsureLensing();
            if (qa.bloom) await qa.s.ensurePostProcessing(qa.lens.lensingPass);
            for (let i = 0; i < 8; i++) window.__celestialFrame();
            qa.initialHole = { x: qa.st.BH.x[0], y: qa.st.BH.y[0] };
        });
        await page.evaluate(installNativeRingProof);
        if (variant === 'main' && !mobile && bloom) {
            observedPage = page;
            await page.evaluate(installLensResizeObserver);
        }
        await prepareContextRecoveryQA(page);
        for (const test of DISK_PLANE_CASES) {
            if (baselineResizeObservation) assertNextBaselineObservation(local.samples, test, 'original');
            local.assets.push({ phase: 'original', ...test, ...await settleAssets(page, test) });
            if (test.scenario.startsWith('saturn-')) local.stability.push({ ...test, ...await assertStableControl(page, test) });
            await saveCase(page, variant, test, 'original');
        }
        local.crossingAcceptance = assertCrossingAcceptance(local.samples.filter(s => s.phase === 'original'), variant);

        // Two resize/camera cycles, comparing their settled pixels. The first
        // cycle may warm production surface detail at a new viewport; it must
        // not be confused with an optics change by comparing to cold assets.
        for (let cycle = 1; cycle <= REPEAT_CYCLES; cycle++) {
            for (const [sizeName, size] of [['alternate', alternateViewport], ['original', viewport]]) {
                await page.setViewportSize(size);
                await page.waitForFunction(() => {
                    const { s } = qa;
                    return s.viewportSize.w === s.cvHost.clientWidth && s.viewportSize.h === s.cvHost.clientHeight &&
                        s.renderer.domElement.width === Math.floor(s.cvHost.clientWidth * s.renderer.getPixelRatio()) &&
                        s.renderer.domElement.height === Math.floor(s.cvHost.clientHeight * s.renderer.getPixelRatio());
                });
                const phase = `resize-${cycle}-${sizeName}`;
                for (const test of RESIZE_CASES) {
                    if (baselineResizeObservation) assertNextBaselineObservation(local.samples, test, phase);
                    await settleAssets(page, test);
                    const sample = await saveCase(page, variant, test, phase);
                    if (test.scenario === 'disk-crossing' && test.pitch === 0)
                        assert(variant === 'main' ? sample.metrics.diskPixels === 0 : sample.metrics.diskPixels > 0, 'Resize retains expected main dropout / candidate visible disk');
                    if (cycle > 1) {
                        const previous = local.samples.find(s => s.phase === `resize-1-${sizeName}` && s.scenario === test.scenario && s.pitch === test.pitch);
                        assert.equal(sample.productionSha256, previous.productionSha256, 'Repeated camera/resize restores exact settled frozen pixels');
                    }
                    // Equality above must pass first. This stops the original
                    // prefix before any later controls, recovery, or candidate.
                    if (baselineResizeObservation && baselineObservationAtStop(local.samples)) break variantLoop;
                }
            }
        }

        // Two actual native GPU outages, while already paused. Counter and
        // framebuffer evidence must resume; unchanged paused time alone fails.
        for (let cycle = 1; cycle <= REPEAT_CYCLES; cycle++) {
            const test = { scenario: 'disk-crossing', pitch: 0 };
            await settleAssets(page, test);
            const beforePixels = await saveCase(page, variant, test, `recovery-${cycle}-before`);
            const before = await recoverySnapshot(page), preLossTime = before.t;
            await page.evaluate(() => {
                qa.lossExtension = qa.s.renderer.getContext().getExtension('WEBGL_lose_context');
                if (!qa.lossExtension) throw Error('WEBGL_lose_context unavailable; real recovery test cannot be replaced');
                qa.lossExtension.loseContext();
            });
            await page.waitForFunction(contextLossSettled);
            await page.evaluate(() => { for (let i = 0; i < 4; i++) window.__celestialFrame(); });
            const held = await recoverySnapshot(page);
            assert.equal(held.t, preLossTime); assert.equal(held.success, before.success, 'Lost context cannot count a successful rendered frame');
            assert.equal(held.losses, before.losses + 1, 'Production handler observed the native loss');
            await page.evaluate(() => qa.lossExtension.restoreContext());
            await page.waitForFunction(contextRestoreSettled);
            await settleAssets(page, test);
            const afterPixels = await saveCase(page, variant, test, `recovery-${cycle}-after`);
            const restored = await recoverySnapshot(page);
            assert(pausedRecoveryPassed(held, restored, preLossTime), 'Real GPU recovery renders a new frame while retaining pre-loss paused time');
            assert(recoveredGpuIsHealthy(restored)); assert(restored.canvasTarget && restored.readbacks > held.readbacks);
            assert.equal(restored.restores, before.restores + 1, 'Production handler observed restoration');
            assert.equal(afterPixels.productionSha256, beforePixels.productionSha256, 'Restored disk framebuffer equals the pre-loss frozen frame');
            local.recoveries.push({ cycle, preLossTime, before, held, restored, identicalPixels: true });
            for (const test of RECOVERY_CONTROLS) {
                await settleAssets(page, test);
                await saveCase(page, variant, test, `recovery-${cycle}-controls`);
            }
        }
        assert.deepEqual(local.errors, [], 'No page/shader/GPU errors');
        if (observedPage === page) {
            report.resizeObserverCleanup = await removeResizeObservers(page);
            assert(report.resizeObserverCleanup.complete && report.resizeObserverCleanup.activeListeners === 0);
            observedPage = null;
        }
        await page.close(); await server.close(); server = null;
        await flush();
    }
    if (baselineResizeObservation) report.baselineResizeObservation = finishBaselineObservation(report.variants);
    else {
        assert(report.pairedControls.some(control => control.label.endsWith('/ring') && control.applicable), 'Paired unchanged ring pixels were actually sampled');
        assert.equal(report.pairedControls.length, mainControls.size, 'Every baseline control has a candidate pair');
    }
    report.completed = true;
} catch (error) {
    originalError = error; hadOriginalError=true;
    if (baselineResizeObservation) Object.assign(report.baselineResizeObservation, { completed: false, outcome: 'failed', failure: error.stack || String(error) });
} finally {
    if (observedPage) {
        try {
            report.resizeObserverCleanup = await removeResizeObservers(observedPage);
            assert(report.resizeObserverCleanup.complete && report.resizeObserverCleanup.activeListeners === 0);
        } catch (error) {
            report.resizeObserverCleanup = { complete: false, error: error.stack || String(error) };
            if (!hadOriginalError) { originalError = error; hadOriginalError = true; }
        }
        observedPage = null;
    }
    // Observer cleanup is bounded independently; the original resource
    // finalizer still attempts browser/server closure and preserves failures.
    await finalizeDiskProbe({report,originalError,hadOriginalError,
        verifySources:()=>{report.sourceBindingAfter = bindSources();assert.deepEqual(report.sourceBindingAfter,sourceBindingBefore);},
        flush,closeBrowser:()=>browser?.close(),closeServer:()=>server?.close()});
}
