import { createServer } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
    HTMLElement.prototype.requestFullscreen = () => { throw Error('Mobile must not request fullscreen'); };
});
try {
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, body: '' }));
    // Simulate a driver whose global compilation never completes. Mobile
    // readiness and entry must not depend on it, or on a synchronous GPU fence.
    await page.route('**/src/main.js', async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace('async function warmRendererStartup()', `
window.__startupDraws = 0;
const originalStartupRender = renderer.render.bind(renderer);
renderer.render = (...args) => { window.__startupDraws++; return originalStartupRender(...args); };
renderer.compileAsync = () => new Promise(() => {});
renderer.getContext().finish = () => { throw Error('Unexpected blocking GPU fence'); };
async function warmRendererStartup()`);
        await route.fulfill({ response, body });
    });
    // Isolate entry from external catalogs; retain default compile behavior.
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?galaxyvol=0&field=0&galaxies=0&tier1=0&realsky=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__AP_READY, null, { timeout: 30000 });
    const draws = await page.evaluate(() => window.__startupDraws);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__startupDraws), draws, 'No rendering beneath welcome screen');
    await page.locator('#introSims').tap();
    await page.waitForFunction(() => document.getElementById('simsMenu').style.display === 'flex');
    await page.locator('#simsClose').tap();
    await page.waitForFunction(() => window.__startupDraws > 0, null, { timeout: 30000 });
    await page.evaluate(() => localStorage.removeItem('ap_introSeen'));
    await page.reload();
    await page.waitForFunction(() => window.__AP_READY, null, { timeout: 30000 });
    await page.locator('#introEnter').tap();
    assert.equal(await page.locator('#intro').isVisible(), false);
    await page.waitForFunction(() => window.__startupDraws > 0, null, { timeout: 30000 });
    if (process.env.ARTEMIS_SCREENSHOT) await page.screenshot({ path: process.env.ARTEMIS_SCREENSHOT });
    await page.reload();
    await page.waitForFunction(() => window.__AP_READY, null, { timeout: 30000 });
    assert.equal(await page.locator('#intro').isVisible(), false, 'Returning users enter directly');
    await page.waitForFunction(() => window.__startupDraws > 0, null, { timeout: 30000 });
    await page.evaluate(async () => {
        const {G} = await import('/src/state.js');
        const {cam} = await import('/src/scene.js');
        const {PC_KM,K} = await import('/src/constants.js');
        const {galacticCenterScene} = await import('/src/universe/starfield.js');
        G.paused = true; G.focus = 'free'; G.gr = true;
        cam.tgt.fromArray(galacticCenterScene()); cam.dist = 30000*PC_KM*K; cam.distTarget = null;
    });
    await page.waitForFunction(() => window.__largeFlow?.visible, null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.__largeFlow.vertices), 1280, 'Mobile flow uses 160 glyphs');
    assert.deepEqual(errors, []);
    console.log('Mobile entry, travel menu, returning-user startup, bounded cosmic flow, and nonblocking GPU checks passed');
} finally {
    await browser.close();
    await server.close();
}
