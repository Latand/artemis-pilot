// Full-app, deterministic celestial close-up QA. It does not substitute a
// demonstration material/scene. Only costly unrelated sky layers are omitted.
//
// DEVICE=desktop|mobile SUITE=bodies|stars|holes|all [CASE_PATTERN=regex]
//   node scripts/capture-celestial-detail.mjs [ROOT] [OUTPUT]
// BASE_ROOT=/path/to/base SUITE=holes node scripts/capture-celestial-detail.mjs
//   uses exactly this harness against the baseline tree; 1.06 r_s is omitted
//   because legacy focus navigation clamps Sgr A* at 2.7 r_s.
// --validate checks fixture coverage and Vite hooks without starting a browser.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { celestialCases, transformCelestialSource } from './celestial-detail-fixtures.mjs';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const root = resolve(process.env.BASE_ROOT || args[0] || '.');
const baseline = !!process.env.BASE_ROOT || process.env.BASELINE === '1';
const suite = process.env.SUITE || 'all', device = process.env.DEVICE || 'desktop';
assert(['desktop', 'mobile'].includes(device), 'DEVICE must be desktop or mobile');
const out = resolve(args[1] || `evidence/celestial/${baseline ? 'before' : 'after'}-${device}-${suite}`);
const pattern = process.env.CASE_PATTERN ? new RegExp(process.env.CASE_PATTERN) : null;
const tests = celestialCases({ suite, baseline }).filter(s => !pattern || pattern.test(s.name));
assert(tests.length, 'No capture states selected');
const scripts = dirname(fileURLToPath(import.meta.url));
const browserSource = await readFile(resolve(scripts, 'celestial-detail-browser.js'), 'utf8');
for (const path of ['src/main.js', 'src/render/systemBodies.js', 'src/render/catalogStars.js']) {
    const source = await readFile(resolve(root, path), 'utf8');
    const transformed = transformCelestialSource(source, resolve(root, path));
    assert(transformed && transformed !== source, `Missing QA transform for ${path}`);
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: transformed });
}
if (process.argv.includes('--validate') || process.argv.includes('--list')) {
    console.log(JSON.stringify({ root, baseline, device, suite, count: tests.length, tests }, null, 2));
    process.exit(0);
}
await mkdir(out, { recursive: true });
const revision = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; } })();
const report = { version: 1, baseline, suite, device, revision, epoch: '2026-09-13T12:00:00.000Z', simulatedSeconds: 0,
    omissions: ['volumetric galaxy', 'galaxy population', 'merger debris', 'procedural background field', 'HYG background catalog', 'cosmic fallback cloud'],
    productionPaths: ['application frame', 'body/star/hole materials', 'body lighting', 'focus clamp', 'lensing', 'tiered renderer', 'tone mapping'],
    frames: [], errors: [], warnings: [], failedChecks: [], failedRequests: [], expectedCases: tests.map(s => s.name) };
const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
let server, browser;
try {
    server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
        plugins: [{ name: 'celestial-detail-qa-only', enforce: 'pre',
            resolveId(id) { if (id === 'virtual:galaxy-preview') return '\0qa-disabled-galaxy-preview'; if (id === '/__celestial_qa__.js') return '\0celestial-qa'; },
            load(id) {
                // galaxyvol=0 prevents this data from being used. Avoid even
                // generating a several-second map preview for unrelated QA.
                if (id === '\0qa-disabled-galaxy-preview') return 'export default null;';
                if (id === '\0celestial-qa') return browserSource;
            },
            transform(source, id) { return transformCelestialSource(source, id); },
        }] });
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true,
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const mobile = device === 'mobile';
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 640 } : { width: 900, height: 600 },
        deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile,
        ...(mobile ? { userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' } : {}) });
    await context.addInitScript(() => {
        Date.now = () => Date.UTC(2026, 8, 13, 12);
        localStorage.clear(); localStorage.setItem('ap_introSeen', '1'); localStorage.setItem('ap_intro_seen', '1');
    });
    const page = await context.newPage(); page.setDefaultTimeout(90000);
    page.on('pageerror', error => report.errors.push({ case: report.currentCase || 'startup', kind: 'javascript', message: error.stack || error.message }));
    page.on('console', message => {
        const text = message.text();
        if (message.type() === 'error') report.errors.push({ case: report.currentCase || 'startup', kind: 'console', message: text });
        else if (message.type() === 'warning' && /WebGL|GL_INVALID|shader|texture/i.test(text)) report.warnings.push({ case: report.currentCase || 'startup', message: text });
    });
    page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
    const query = new URLSearchParams({ hidehelp: '1', dpr: '1', tier1: '0', realsky: '0', field: '0', galaxies: '0', galaxyvol: '0', galaxy: '0',
        focus: 'earth', dist: '25', river: '0', bloom: '0', compile: '0', clouds: '1', moonmap: '1', earthnight: '1', planetmaps: '1' });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__AP_READY && window.__celestialFrame);
    report.browser = await browser.version();
    report.renderer = await page.evaluate(async () => { window.celestialQA = await import('/__celestial_qa__.js'); return celestialQA.initialize(); });
    assert.equal(report.renderer.mobile, mobile, 'Requested device did not activate its production quality path');
    await save();
    for (const test of tests) {
        report.currentCase = test.name;
        const started = performance.now(), errorsBefore = report.errors.length;
        try {
            const fixture = await page.evaluate(test => celestialQA.prepare(test), test);
            const costs = [];
            // Fixed update count, not a timing-dependent "wait until it looks
            // ready". Every shot receives the identical production cadence.
            for (let i = 0; i < 3; i++) costs.push(await page.evaluate(() => celestialQA.frame()));
            await page.waitForFunction(() => celestialQA.ready(), null, { timeout: 45000, polling: 100 });
            const result = await page.evaluate(() => celestialQA.capture());
            await writeFile(resolve(out, `${test.name}.png`), Buffer.from(result.png.split(',')[1], 'base64')); delete result.png;
            result.assertions.noJavaScriptError = report.errors.length === errorsBefore;
            const failed = Object.entries(result.assertions).filter(([, ok]) => !ok).map(([key]) => key);
            report.failedChecks.push(...failed.map(check => ({ case: test.name, check })));
            report.frames.push({ name: test.name, fixture, test, ...result, frameAndFinishMs: costs, captureTotalMs: performance.now() - started });
            // One contextual UI screenshot per shard complements the clean
            // production-canvas screenshots used to inspect material detail.
            if (report.frames.length === 1) await page.screenshot({ path: resolve(out, `${test.name}-ui.png`) });
            console.log(`CAPTURE ${device}/${suite}/${test.name}: ${failed.length ? 'FAIL ' + failed.join(', ') : 'PASS'} at ${result.state.actualRadii.toFixed(5)} radii`);
        } catch (error) {
            report.errors.push({ case: test.name, kind: 'capture', message: error.stack || String(error) });
            console.error(`CAPTURE FAILED ${test.name}: ${error.message}`);
        }
        await save();
    }
    if (!baseline && device === 'desktop' && (suite === 'holes' || suite === 'all')) {
        report.currentCase = 'hole-integration';
        const integration = await page.evaluate(() => celestialQA.holeIntegrationChecks());
        for (const shot of integration.frames) {
            await writeFile(resolve(out, `${shot.name}.png`), Buffer.from(shot.png.split(',')[1], 'base64'));
            delete shot.png;
        }
        report.integration = integration;
        report.failedChecks.push(...Object.entries(integration.checks).filter(([, pass]) => !pass).map(([check]) => ({ case: 'hole-integration', check })));
        for (const [name, pass] of Object.entries(integration.checks)) console.log(`INTEGRATION ${pass ? 'PASS' : 'FAIL'} ${name}`);
        await save();
    }
    delete report.currentCase;
    report.complete = report.frames.length === tests.length;
    report.passed = report.complete && !report.errors.length && !report.failedChecks.length;
    if (!report.passed) process.exitCode = 1;
} catch (error) {
    report.errors.push({ case: report.currentCase || 'startup', kind: 'fatal', message: error.stack || String(error) });
    report.passed = false; process.exitCode = 1; console.error(error);
} finally {
    await save(); await browser?.close(); await server?.close();
}
