// Current-source functional regression. Not PR #59's exact-tree attestation,
// paired foreground/ring proof, native-program proof or cost benchmark.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { DISK_PLANE_CASES, assertCrossingAcceptance, transformDiskPlaneSource } from './disk-plane-qa.mjs';
import { installPointerAudit, parkNeutralPointer, assertPointerCaptures } from './disk-pointer-fixture.mjs';
import { prepareContextRecoveryQA, contextLossSettled, contextRestoreSettled, pausedRecoveryPassed } from './context-recovery-qa.mjs';
import { initializeDiskReport, atomicDiskReport, finalizeDiskProbe } from './disk-plane-finalize.mjs';

const device = process.env.DEVICE || 'desktop', bloomOption = process.env.BLOOM || '0';
assert(['desktop', 'mobile'].includes(device)); assert(['0', '1'].includes(bloomOption));
const mobile = device === 'mobile', bloom = bloomOption === '1';
const viewport = mobile ? { width: 390, height: 700 } : { width: 960, height: 640 };
const alternate = mobile ? { width: 430, height: 760 } : { width: 840, height: 600 };
const out = resolve(process.env.ARTEMIS_EVIDENCE || `evidence/disk-current/${device}-${bloomOption}`);
await mkdir(out, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function bindSource() {
    const paths = [...new Set(execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--',
        'src', 'public', 'scripts', 'index.html', 'package.json'], { encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
    return { revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        files: Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(path))]))) };
}
const report = { scope: 'Current-source full-quality disk crossing and lifecycle only', device, bloom,
    completed: false, historicalAttestation: false, performanceAcceptance: false,
    omissions: ['paired baseline parity', 'foreground/ring pixel masks', 'native fast-path observer',
        'active-cost measurements', 'unrelated cosmic/catalog/merger layers', 'physical mobile/Safari'],
    sourceBefore: await bindSource(), samples: [], resize: [], recoveries: [], errors: [] };
const flush = options => atomicDiskReport(resolve(out, 'report.json'), report, options);
await initializeDiskReport(resolve(out, 'report.json'), report);
let browser, server, originalError, hadOriginalError = false;

// Same 8-r_s camera and 50,000-km steady quasar as the historical crossing.
// No shader, optical, physical or acceptance-threshold substitutions.
function captureCrossing(pitch) {
    const { s, st, bh, c, e, enc, lens } = window.qa;
    enc.syncHoleScene();
    const position = bh.BH_META[0].g.position.clone().set((e.eph.earthX + st.BH.x[0]) * c.K,
        st.BH.z[0] * c.K, -(e.eph.earthY + st.BH.y[0]) * c.K);
    st.G.focus = 'free'; s.cam.tgt.copy(position); s.cam.dist = st.BH.rs[0] * c.K * 8;
    s.cam.distTarget = null; s.cam.yaw = Math.PI / 2; s.cam.pitch = pitch;
    window.__celestialFrame(); window.__celestialFrame();
    bh.updateBHVisuals(0, e.eph.earthX * c.K, -e.eph.earthY * c.K);
    const disk = bh.BH_META[0].optics.disk, gl = s.renderer.getContext();
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const pointerSnapshots = [];
    function draw() {
        const pointer = { before: window.__diskPlanePointerSnapshot() }; pointerSnapshots.push(pointer);
        if (window.__qaBloom) s.composer.render(); else lens.renderLensed(s.renderer, s.scene, s.camera);
        gl.finish(); const bytes = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        qa.readbacks++; pointer.after = window.__diskPlanePointerSnapshot();
        if (gl.getError() !== 0 || gl.isContextLost()) throw Error('Unhealthy GPU readback');
        if (s.renderer.getRenderTarget() !== null) throw Error('Capture did not restore canvas target');
        return bytes;
    }
    const visible = disk.visible;
    let pixels, absent, png;
    try {
        disk.visible = true; pixels = draw(); png = s.renderer.domElement.toDataURL('image/png');
        disk.visible = false; absent = draw();
    } finally { disk.visible = visible; }
    const metrics = { diskPixels: 0, diskLight: 0 };
    const luminance = (bytes, i) => .2126 * bytes[i] + .7152 * bytes[i + 1] + .0722 * bytes[i + 2];
    for (let i = 0; i < pixels.length; i += 4) {
        const emitted = luminance(pixels, i) - luminance(absent, i);
        if (emitted > 4) { metrics.diskPixels++; metrics.diskLight += emitted; }
    }
    return { scenario: 'disk-crossing', pitch, metrics, png, pointerSnapshots, width, height,
        diskOn: disk.material.uniforms.uDiskOn.value, bloom: !!s.bloomPass.enabled,
        quality: s.renderQuality.mode, paused: st.G.paused, t: st.G.t, success: window.__diskPlaneFrameSuccess || 0 };
}
async function capture(page, pitch, phase) {
    const sample = await page.evaluate(captureCrossing, pitch);
    assertPointerCaptures(sample.pointerSnapshots);
    assert(sample.paused && sample.t === 0 && sample.success > 0);
    assert.equal(sample.diskOn, 1); assert.equal(sample.bloom, bloom); assert.equal(sample.quality, 'high');
    const png = Buffer.from(sample.png.split(',')[1], 'base64');
    sample.productionSha256 = hash(png); delete sample.png;
    await writeFile(resolve(out, `${phase}-${pitch}.png`), png);
    return sample;
}
const snapshot = page => page.evaluate(() => ({ paused: qa.st.G.paused, t: qa.st.G.t,
    success: window.__diskPlaneFrameSuccess || 0, readbacks: qa.readbacks,
    contextLost: qa.s.renderer.getContext().isContextLost(), contextLifecycleLost: qa.s.renderContext.isLost(),
    losses: qa.s.renderContext.losses, restores: qa.s.renderContext.restores }));
try {
    server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
        plugins: [{ name: 'current-disk-continuity', enforce: 'pre',
            resolveId(id) { if (id === 'virtual:galaxy-preview') return '\0off'; },
            load(id) { if (id === '\0off') return 'export default null;'; }, transform: transformDiskPlaneSource }] });
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    page.setDefaultTimeout(120000);
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    page.on('console', message => { if (message.type() === 'error' && /THREE|Shader|GL_INVALID/.test(message.text())) report.errors.push(message.text()); });
    await page.addInitScript(value => {
        window.__qaBloom = value; Date.now = () => Date.UTC(2026, 9, 3, 12);
        localStorage.clear(); localStorage.setItem('ap_introSeen', '1');
    }, bloom);
    await page.addInitScript(installPointerAudit);
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.fulfill({ contentType: 'text/css', body: '' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?quality=high&focus=saturn&dist=600&bloom=${bloomOption}&river=0&field=0&realsky=0&tier1=0&galaxies=0&galaxyvol=0&galaxy=0&compile=0&hidehelp=1&planetmaps=1&earthnight=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__AP_READY && window.__celestialFrame);
    await parkNeutralPointer(page);
    await page.evaluate(async () => {
        window.qa = { readbacks: 0, s: await import('/src/scene.js'), st: await import('/src/state.js'),
            bh: await import('/src/blackholes.js'), c: await import('/src/constants.js'), e: await import('/src/ephemeris.js'),
            enc: await import('/src/bhEncounters.js'), lens: await import('/src/lensing.js'),
            b: await import('/src/bodies.js'), textures: await import('/src/textures.js'), surface: await import('/src/render/bodySurfaceMaterial.js') };
        const { st, bh, c, e } = qa, sat = c.PL.findIndex(p => p.name === 'SATURN');
        st.G.paused = true; st.G.gr = false; st.G.predict = false; st.G.focus = 'free';
        bh.clearBlackHoles(); bh.addBlackHole(e.eph.plX[sat] - 150000, e.eph.plY[sat] - 100000, 50000, 0, 0, true, null, 1, 0, e.eph.plZ[sat], 0);
        await window.__celestialEnsureLensing();
        if (window.__qaBloom) await qa.s.ensurePostProcessing(qa.lens.lensingPass);
        const map = await qa.textures.loadPlanetMap(sat); if (!map) throw Error('Saturn map unavailable');
        qa.b.requestPlanetTexture(sat);
        for (let i = 0; i < 8; i++) window.__celestialFrame();
    });
    await page.waitForFunction(() => { const q = qa.surface.diskPlaneAssetQueue(); return q.pending === 0 && !q.inFlight && !q.scheduled; });
    await prepareContextRecoveryQA(page);
    for (const { pitch } of DISK_PLANE_CASES.filter(test => test.scenario === 'disk-crossing')) {
        report.samples.push(await capture(page, pitch, 'crossing')); await flush();
    }
    report.crossingAcceptance = assertCrossingAcceptance(report.samples, 'candidate');
    for (let cycle = 1; cycle <= 2; cycle++) for (const [name, size] of [['alternate', alternate], ['original', viewport]]) {
        await page.setViewportSize(size);
        await page.waitForFunction(() => qa.s.viewportSize.w === qa.s.cvHost.clientWidth && qa.s.viewportSize.h === qa.s.cvHost.clientHeight);
        await parkNeutralPointer(page);
        const sample = await capture(page, 0, `resize-${cycle}-${name}`);
        assert(sample.metrics.diskPixels > 0, 'Resized exact-plane disk remains visible');
        if (cycle === 2) assert.equal(sample.productionSha256, report.resize.find(entry => entry.name === name).sample.productionSha256,
            'Repeated resize preserves exact frozen disk pixels');
        report.resize.push({ cycle, name, sample }); await flush();
    }
    for (let cycle = 1; cycle <= 2; cycle++) {
        const beforePixels = await capture(page, 0, `recovery-${cycle}-before`), before = await snapshot(page);
        await page.evaluate(() => {
            qa.lossExtension = qa.s.renderer.getContext().getExtension('WEBGL_lose_context');
            if (!qa.lossExtension) throw Error('Real WEBGL_lose_context is required');
            qa.lossExtension.loseContext();
        });
        await page.waitForFunction(contextLossSettled);
        await page.evaluate(() => { for (let i = 0; i < 4; i++) window.__celestialFrame(); });
        const held = await snapshot(page);
        assert.equal(held.t, before.t); assert.equal(held.success, before.success); assert.equal(held.losses, before.losses + 1);
        await page.evaluate(() => qa.lossExtension.restoreContext());
        await page.waitForFunction(contextRestoreSettled);
        const afterPixels = await capture(page, 0, `recovery-${cycle}-after`), restored = await snapshot(page);
        assert(pausedRecoveryPassed(held, restored, before.t)); assert(restored.readbacks > held.readbacks);
        assert.equal(restored.restores, before.restores + 1);
        assert.equal(afterPixels.productionSha256, beforePixels.productionSha256, 'GPU recovery preserves exact frozen disk pixels');
        report.recoveries.push({ cycle, before, held, restored, identicalPixels: true }); await flush();
    }
    assert.deepEqual(report.errors, []); report.completed = true;
} catch (error) { originalError = error; hadOriginalError = true; }
finally {
    await finalizeDiskProbe({ report, originalError, hadOriginalError, flush,
        verifySources: async () => { report.sourceAfter = await bindSource(); assert.deepEqual(report.sourceAfter, report.sourceBefore); },
        closeBrowser: () => browser?.close(), closeServer: () => server?.close() });
}
