// Production app in Chromium/SwiftShader. Hardware identity injection is used
// ONLY for the explicit desktop-compile timeout case, never for FPS claims.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out = resolve(process.argv[2] || 'evidence/adaptive-quality');
await mkdir(out, { recursive: true });
const report = { scope: 'Cloud Chromium SwiftShader functional QA; not WARP, Iris Xe or a physical phone benchmark', cases: [], errors: [] };
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
let browser;
try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    for (const test of [{ name: 'desktop-default' }, { name: 'mobile-default', mobile: true }, { name: 'desktop-stuck-compile', stuck: true }]) {
        const page = await browser.newPage({ viewport: test.mobile ? { width: 390, height: 844 } : { width: 1000, height: 700 },
            deviceScaleFactor: 1, isMobile: !!test.mobile, hasTouch: !!test.mobile });
        page.setDefaultTimeout(45000);
        page.on('pageerror', error => report.errors.push(`${test.name}: ${error.message}`));
        page.on('console', message => { if (message.type() === 'error' && /THREE|Shader|GL_INVALID/.test(message.text())) report.errors.push(message.text()); });
        await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.fulfill({ status: 200, body: '' }));
        await page.addInitScript(() => { localStorage.clear(); HTMLElement.prototype.requestFullscreen = async () => {}; });
        await page.route('**/src/main.js', async route => {
            const response = await route.fetch();
            let body = await response.text();
            body = body.replace('async function warmRendererStartup()', `
window.__qaDraws = 0; window.__qaCompiles = 0;
const qaRender = renderer.render.bind(renderer);
renderer.render = (...args) => { window.__qaDraws++; return qaRender(...args); };
renderer.compileAsync = () => { window.__qaCompiles++; return new Promise(() => {}); };
async function warmRendererStartup()`);
            await route.fulfill({ response, body });
        });
        if (test.stuck) await page.route('**/src/scene.js', async route => {
            const response = await route.fetch();
            const body = (await response.text()).replace('const rendererName = readRendererName(renderer.getContext());',
                'const rendererName = "Injected hardware classification for timeout test";');
            await route.fulfill({ response, body });
        });
        const start = performance.now();
        // Keep the actual galaxy/background implementation; only external
        // multi-million-row catalog streaming is excluded from entry timing.
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?tier1=0&realsky=0&hidehelp=1${test.stuck ? '&compile=1' : ''}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__AP_READY);
        const readyMs = performance.now() - start;
        const initial = await page.evaluate(() => ({ quality: { ...__renderQuality }, compile: __startupStatus.compile,
            compiles: __qaCompiles, draws: __qaDraws, particles: __river.count }));
        assert(readyMs < 15000, 'readiness is bounded even when compilation never settles');
        assert.equal(initial.compile, test.stuck ? 'timeout' : 'skipped');
        assert.equal(initial.compiles, test.stuck ? 1 : 0);
        assert.equal(initial.draws, 0, 'welcome screen does not submit rendering');
        if (!test.stuck) {
            assert(initial.quality.software); assert(initial.quality.minimal);
            assert(initial.quality.dpr <= .5); assert.equal(initial.particles, 1024);
        }
        await page.locator('#renderQualityControls summary').click();
        await page.screenshot({ path: resolve(out, `${test.name}-entry.png`) });
        // Avoid rendering the intentionally non-software compile probe at full
        // detail on this software GPU. This case proves timeout and UI only.
        if (test.stuck) {
            await page.locator('#renderQualityMode').selectOption('minimal');
        }
        await page.locator('#renderQualityControls summary').click();
        await page.locator('#introEnter').click();
        await page.waitForFunction(() => window.__AP_FIRST_FRAME);
        await page.evaluate(async () => {
            const { G } = await import('/src/state.js'); G.paused = true; G.gr = true; G.predict = false;
        });
        await page.screenshot({ path: resolve(out, `${test.name}-scene.png`) });
        await page.evaluate(async () => {
            const bh = await import('/src/blackholes.js'); bh.clearBlackHoles();
            for (let i = 0; i < 3; i++) bh.addBlackHole(150000 + i * 80000, i * 40000, 10, 0, 0, true);
            const { G } = await import('/src/state.js'), { cam } = await import('/src/scene.js');
            const { eph } = await import('/src/ephemeris.js'), { K } = await import('/src/constants.js');
            G.focus = 'free'; cam.tgt.set((eph.earthX + 230000) * K, 0, -(eph.earthY + 40000) * K);
            cam.dist = 450; cam.distTarget = null; cam.yaw = 1.3; cam.pitch = .45;
        });
        await page.waitForFunction(() => __river.sourceCount >= 13);
        const sourceCount = await page.evaluate(() => __river.sourceCount);
        await page.screenshot({ path: resolve(out, `${test.name}-three-holes-minimal.png`) });
        const invariant = await page.evaluate(async () => {
            const { BH, G } = await import('/src/state.js');
            return { n: BH.n, mass: Array.from(BH.mu).slice(0, BH.n), t: G.t };
        });
        await page.locator('#renderQualityControls summary').click();
        await page.locator('#renderQualityMode').selectOption('low');
        await page.waitForFunction(() => __renderQuality.mode === 'low' && __renderQuality.dpr <= .75 && __river.computeEvery === 2);
        await page.waitForFunction(async () => {
            const lens = await import('/src/lensing.js');
            return lens.lensingPass.enabled && lens.lensingPass.uniforms.uN.value === 3;
        });
        assert.equal(await page.evaluate(() => __renderQuality.lensSamples), 0, 'three visible lenses do not force MSAA');
        await page.screenshot({ path: resolve(out, `${test.name}-three-holes-low.png`) });
        await page.locator('#renderQualityMode').selectOption('minimal');
        await page.waitForFunction(() => __renderQuality.mode === 'minimal' && __river.computeEvery === 4);
        const after = await page.evaluate(async () => {
            const { BH, G } = await import('/src/state.js');
            return { n: BH.n, mass: Array.from(BH.mu).slice(0, BH.n), t: G.t };
        });
        assert.deepEqual(after, invariant, 'quality changes keep paused physical state and all three holes');
        assert(await page.evaluate(() => __river.sourceCount >= 13), 'all solar and three-hole source uniforms remain');
        await page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        const hiddenDraws = await page.evaluate(() => __qaDraws);
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => __qaDraws), hiddenDraws, 'hidden document submits no GPU work');
        await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
        await page.waitForFunction(draws => __qaDraws > draws, hiddenDraws);
        await page.setViewportSize(test.mobile ? { width: 844, height: 390 } : { width: 1200, height: 760 });
        assert.equal(await page.evaluate(() => __renderQuality.mode), 'minimal');
        // Context loss/restoration exercises the real Three target rebuild.
        await page.evaluate(async () => {
            const { renderer } = await import('/src/scene.js');
            window.__qaContextExtension = renderer.getContext().getExtension('WEBGL_lose_context');
            __qaContextExtension.loseContext();
        });
        await page.waitForFunction(() => __renderContext.lost);
        const lostT = await page.evaluate(() => __G.t);
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => __G.t), lostT);
        await page.evaluate(() => __qaContextExtension.restoreContext());
        await page.waitForFunction(() => __renderContext.restores === 1 && !__renderContext.lost);
        const draws = await page.evaluate(() => __qaDraws);
        await page.waitForFunction(draws => __qaDraws > draws, draws);
        await page.screenshot({ path: resolve(out, `${test.name}-restored.png`) });
        const contextRestores = await page.evaluate(() => __renderContext.restores);
        report.cases.push({ ...test, readyMs, initial, sourceCount, contextRestores });
        console.log(test.name, JSON.stringify(report.cases.at(-1)));
        await page.close();
    }
    assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.errors.push(error.stack || String(error)); report.passed = false; console.error(error); process.exitCode = 1; }
finally { await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server.close(); }
