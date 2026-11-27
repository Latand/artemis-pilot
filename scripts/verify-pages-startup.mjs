// Exercise the production bundle at the same non-root path as GitHub Pages.
import assert from 'node:assert/strict';
import { access, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const origin = 'https://artemis.test';
const site = '/artemis-pilot/';
const dist = resolve('dist');
const entry = (await readFile(resolve(dist, 'index.html'), 'utf8'))
    .match(/<script type="module"[^>]*src="\.\/([^"]+)"/)?.[1];
assert(entry, 'production HTML must reference a built entry module');
const browserBinary = await open(resolve(dist, 'data/athyg-tier1.bin'));
const binarySize = (await browserBinary.stat()).size;
const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
    for (const name of ['fresh', 'returning', 'recover-saved', 'no-webgl', 'no-msaa', 'first-render-error', 'missing-entry', 'missing-app']) {
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            const errors = [];
            const requests = new Set();
            let binaryRanges = 0;
            page.on('pageerror', error => errors.push(error.message));
            context.on('request', request => requests.add(new URL(request.url()).pathname));
            await context.route('**/*', async route => {
                const url = new URL(route.request().url());
                if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
                    // Leave the stylesheet pending until the context closes.
                    // First entry must not wait for the third-party font request.
                    return;
                }
                if (url.origin !== origin || !url.pathname.startsWith(site)) return route.fulfill({ status: 404 });
                const file = url.pathname.slice(site.length) || 'index.html';
                if ((name === 'missing-entry' && file === entry) ||
                    (name === 'missing-app' && /^assets\/main-[^/]+\.js$/.test(file))) {
                    return route.fulfill({ status: 404 });
                }
                if (file === 'data/athyg-tier1.bin') {
                    const range = route.request().headers()['range']?.match(/^bytes=(\d+)-(\d+)$/);
                    if (!range) return route.fulfill({ status: 416 });
                    const [, lo, hi] = range.map(Number);
                    if (lo > hi || hi >= binarySize) return route.fulfill({ status: 416 });
                    const body = Buffer.alloc(hi - lo + 1);
                    const { bytesRead } = await browserBinary.read(body, 0, body.length, lo);
                    assert.equal(bytesRead, body.length);
                    binaryRanges++;
                    return route.fulfill({ status: 206, body, headers: {
                        'content-range': `bytes ${lo}-${hi}/${binarySize}`,
                        'content-type': 'application/octet-stream',
                    } });
                }
                const path = resolve(dist, file);
                try { await access(path); } catch { return route.fulfill({ status: 404 }); }
                return route.fulfill({ path });
            });
            await page.addInitScript(({ name }) => {
                HTMLElement.prototype.requestFullscreen = async () => {};
                if (['returning', 'recover-saved', 'no-webgl'].includes(name)) localStorage.setItem('ap_introSeen', '1');
                if (name === 'recover-saved' || name === 'no-webgl') {
                    localStorage.setItem('ap_cam', '{"dist":321,"focus":"sun"}');
                    localStorage.setItem('ap_quality', 'high');
                }
                if (name === 'no-webgl' || name === 'no-msaa') {
                    const getContext = HTMLCanvasElement.prototype.getContext;
                    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
                        if (type.startsWith('webgl') && (name === 'no-webgl' || args[0]?.antialias)) return null;
                        return getContext.call(this, type, ...args);
                    };
                }
            }, { name });
            const params = name === 'recover-saved' ? '?safestart=1&quality=minimal' :
                name === 'no-msaa' ? '?quality=high' : '';
            await page.goto(origin + site + params, { waitUntil: 'commit' });
            if (name === 'no-webgl' || name.startsWith('missing-')) {
                await page.waitForFunction(() => !document.getElementById('startupActions')?.hidden &&
                    !!document.getElementById('startupMessage'));
                const message = await page.locator('#startupMessage').textContent();
                assert.match(message, name === 'no-webgl' ? /WebGL could not start/ : /could not start/);
                assert.equal(await page.locator('#introEnter').isDisabled(), true);
                assert.equal(await page.locator('#startupSafe').getAttribute('href'), '?safestart=1&quality=minimal');
            } else {
                await page.waitForFunction(() => window.__AP_READY === true);
                if (name === 'first-render-error') {
                    const marker = 'Injected first-render failure';
                    await page.evaluate(marker => {
                        const fail = () => { throw new Error(marker); };
                        WebGL2RenderingContext.prototype.drawArrays = fail;
                        WebGL2RenderingContext.prototype.drawElements = fail;
                    }, marker);
                    await page.locator('#introEnter').click();
                    await page.waitForFunction(() => document.getElementById('startupActions').hidden === false);
                    assert.match(await page.locator('#startupMessage').textContent(), /could not start/);
                    assert.equal(await page.evaluate(() => Boolean(window.__AP_FIRST_FRAME)), false);
                    assert.equal(await page.locator('#introEnter').isDisabled(), true);
                    assert(errors.includes(marker), 'the original WebGL draw error is still reported');
                    console.log('PASS Pages startup:', name);
                    continue;
                }
                if (name === 'no-msaa') {
                    assert.equal(await page.locator('#gl canvas').evaluate(canvas =>
                        canvas.getContext('webgl2').getContextAttributes().antialias), false);
                } else {
                    if (name !== 'returning') await page.locator('#introEnter').click();
                    await page.waitForFunction(() => window.__AP_FIRST_FRAME === true);
                    assert.equal(await page.locator('#startupNotice').isHidden(), true);
                    for (const asset of ['athyg-tier1-manifest.json', 'hyg-stars-v41.json', 'hyg-stars-v41.bin']) {
                        if (name === 'fresh') await page.waitForFunction(asset =>
                            performance.getEntriesByType('resource').some(r =>
                                new URL(r.name).pathname === '/artemis-pilot/data/' + asset), asset);
                    }
                    if (name === 'fresh') assert(binaryRanges > 0, 'worker reads the Tier-1 binary under the Pages prefix');
                    if (name === 'recover-saved') {
                        await page.reload({ waitUntil: 'commit' });
                        await page.waitForFunction(() => window.__AP_READY === true);
                        assert.deepEqual(await page.evaluate(() => [
                            localStorage.getItem('ap_cam'), localStorage.getItem('ap_quality'), window.__renderQuality.mode,
                        ]), ['{"dist":321,"focus":"sun"}', 'high', 'minimal']);
                    }
                }
                assert.deepEqual([...requests].filter(path => path.startsWith('/data/')), []);
                assert.deepEqual(errors, []);
            }
            console.log('PASS Pages startup:', name);
        } finally {
            await context.close();
        }
    }
} finally {
    await browser.close();
    await browserBinary.close();
}
