// Production UI and real WebGL loss events in software Chromium. Loss is
// deliberately injected/withheld; this does not reproduce a physical GPU reset.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const out = resolve(process.argv[2] || 'evidence/context-loss-deadline');
await mkdir(out, { recursive: true });
const report = { scope: 'Production app, Chromium SwiftShader, 390x844 mobile viewport; injected WebGL loss and synthetic BFCache events, not physical iPhone coverage', passed: false, cases: [], errors: [] };
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
let browser;
try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.fulfill({ status: 200, body: '' }));
    await page.addInitScript(() => { HTMLElement.prototype.requestFullscreen = async () => {}; });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?quality=minimal&tier1=0&realsky=0&hidehelp=1`);
    await page.waitForFunction(() => window.__AP_READY);
    await page.locator('#introEnter').click();
    await page.waitForFunction(() => window.__AP_FIRST_FRAME);
    await page.evaluate(async () => {
        const scene = window.__qaScene = await import('/src/scene.js');
        const { G, keys } = await import('/src/state.js');
        const { setUiMode } = await import('/src/uiMode.js'); setUiMode('pilot', false);
        Object.assign(G, { paused: false, warp: 1, predict: false });
        window.__qaG = G; window.__qaKeys = keys; window.__qaDraws = 0;
        const render = scene.renderer.render.bind(scene.renderer);
        scene.renderer.render = (...args) => { window.__qaDraws++; return render(...args); };
        window.__qaExtension = scene.renderer.getContext().getExtension('WEBGL_lose_context');
        if (!window.__qaExtension) throw Error('WEBGL_lose_context required for this fixture');
        scene.renderer.domElement.addEventListener('webglcontextrestored', () => { window.__qaTimeAtRestore = G.t; });
        window.__qaSnapshot = () => ({ t: G.t, position: [G.x, G.y, G.z], velocity: [G.vx, G.vy, G.vz], paused: G.paused });
    });
    const status = page.locator('#renderContextStatus'), button = page.locator('#restartGraphics');
    async function lose() {
        const snapshot = await page.evaluate(() => {
            __qaG.thrustMain = 1; __qaG.boost = true; __qaKeys.add('KeyW');
            const snapshot = __qaSnapshot();
            __qaExtension.loseContext();
            __qaScene.renderContext.isLost(); // Exercise poll-before-native-event ordering.
            return snapshot;
        });
        await page.waitForFunction(() => __renderContext.lost);
        assert(await status.isVisible()); assert(await button.isHidden());
        assert.deepEqual(await page.evaluate(() => [__qaG.thrustMain, __qaG.thrustLat, __qaG.boost, __qaKeys.size]), [0, 0, false, 0]);
        return snapshot;
    }
    async function waitForEscape(held) {
        await button.waitFor({ state: 'visible' });
        assert.equal(await button.textContent(), 'Reload page'); assert(await button.isEnabled());
        assert.match(await status.textContent(), /Flight is still held/);
        assert.match(await status.textContent(), /may lose unsaved simulation changes/);
        assert.deepEqual(await page.evaluate(() => __qaSnapshot()), held, 'No physics or pause-state change throughout outage');
        assert(await page.evaluate(() => __qaScene.renderer.getContext().isContextLost() && __renderContext.recoveryTimedOut));
    }
    async function restore(held) {
        const draws = await page.evaluate(() => __qaDraws);
        await page.evaluate(() => __qaExtension.restoreContext());
        await page.waitForFunction(() => !__renderContext.lost && !__qaScene.renderer.getContext().isContextLost());
        assert(await status.isHidden()); assert(await button.isHidden());
        assert.equal(await page.evaluate(() => __qaTimeAtRestore), held.t, 'No catch-up at native restoration');
        await page.waitForFunction(before => __qaDraws > before, draws);
        assert.equal(await page.evaluate(() => __qaG.paused), held.paused);
    }
    const first = await lose();
    await page.waitForTimeout(300); assert(await button.isHidden());
    await waitForEscape(first);
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 568, height: 320 }]) {
        await page.setViewportSize(viewport);
        for (const mode of ['pilot', 'observe']) for (const expanded of [false, true]) {
            await page.evaluate(async next => { (await import('/src/uiMode.js')).setUiMode(next, false); }, mode);
            await page.evaluate(open => { document.getElementById('renderQualityControls').open = open; }, expanded);
            // Let responsive layout observers settle before testing all corners.
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const bounds = await button.evaluate(el => {
                const r = el.getBoundingClientRect();
                const points = [[.1, .1], [.9, .1], [.5, .5], [.1, .9], [.9, .9]];
                return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
                    visible: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
                    height: r.height, reachable: points.every(([x, y]) => {
                        const top = document.elementFromPoint(r.x + r.width * x, r.y + r.height * y);
                        return top === el || el.contains(top);
                    }) };
            });
            report.layoutChecks ||= [];
            report.layoutChecks.push({ viewport, mode, expanded, bounds });
            await page.screenshot({ path: resolve(out, `loss-${viewport.width}x${viewport.height}-${mode}-${expanded ? 'open' : 'closed'}.png`) });
            assert(bounds.visible && bounds.reachable && bounds.height >= 44,
                `Reload stays usable at ${JSON.stringify(viewport)}, ${mode}, Graphics expanded=${expanded}: ${JSON.stringify(bounds)}`);
        }
        await page.screenshot({ path: resolve(out, `loss-${viewport.width}x${viewport.height}.png`) });
    }
    await page.evaluate(async () => {
        document.getElementById('renderQualityControls').open = false;
        (await import('/src/uiMode.js')).setUiMode('pilot', false);
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await restore(first);
    report.cases.push('Never-restored deadline and late restoration preserve live flight; portrait/landscape Reload hit target is visible and at least 44px');

    // An unrelated BFCache gate reset must not hide the expired reload escape.
    const second = await lose();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await waitForEscape(second);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    assert(await button.isVisible()); assert(await button.isEnabled());
    await restore(second);
    report.cases.push('Repeated outage and synthetic BFCache pagehide/pageshow retain deadline/action and allow late restoration');

    await page.evaluate(() => { __qaG.paused = true; });
    const third = await lose();
    await page.waitForTimeout(200); await restore(third);
    await page.waitForTimeout(5100);
    assert(await status.isHidden()); assert(await button.isHidden());
    assert.deepEqual(await page.evaluate(() => __qaSnapshot()), third);
    report.cases.push('Early restoration cancels stale timeout and preserves an already-paused flight');

    const fourth = await lose(); await waitForEscape(fourth);
    await Promise.all([page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() }), button.click()]);
    await page.waitForFunction(() => window.__AP_READY);
    assert(await status.isHidden());
    report.cases.push('Only the explicit Reload click navigates; fresh document initializes successfully');
    assert.deepEqual(report.errors, []);
    report.passed = true;
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    report.failure = String(error.stack || error);
    throw error;
} finally {
    await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await server.close();
}
