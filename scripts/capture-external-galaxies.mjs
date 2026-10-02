// Full application frames plus single-target diagnostics using the SAME live
// production mesh/material/uniforms. No fixture shader, LUT, exposure tuning,
// replacement morphology, blur, sharpening, or image resampling is used.
// DEVICE=desktop|mobile SUITE=m31|zoom|catalog BASELINE=1
//   node scripts/capture-external-galaxies.mjs ROOT OUTPUT
// --validate checks the catalog and every fail-closed transform without GL.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { externalGalaxyCases, transformExternalGalaxySource } from './external-galaxy-fixtures.mjs';
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const root = resolve(args[0] || '.'), out = resolve(args[1] || 'evidence/external');
const suite = process.env.SUITE || 'all', device = process.env.DEVICE || 'desktop', baseline = process.env.BASELINE === '1';
assert(['desktop', 'mobile'].includes(device));
const pattern = process.env.CASE_PATTERN ? new RegExp(process.env.CASE_PATTERN) : null;
const tests = externalGalaxyCases(suite).filter(t => !pattern || pattern.test(t.name));
assert(tests.length);
const scripts = dirname(fileURLToPath(import.meta.url));
const browserSource = await readFile(resolve(scripts, 'external-galaxy-browser.js'), 'utf8');
for (const file of ['src/main.js', 'src/render/galaxyPopulationRender.js', 'src/render/catalogStars.js']) {
    const source = await readFile(resolve(root, file), 'utf8');
    const transformed = transformExternalGalaxySource(source, resolve(root, file));
    assert(transformed && transformed !== source);
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: transformed });
}
if (process.argv.includes('--validate') || process.argv.includes('--list')) {
    console.log(JSON.stringify({ root, device, suite, count: tests.length, tests }, null, 2)); process.exit(0);
}
await mkdir(out, { recursive: true });
const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const report = { version: 1, root, revision, device, suite, baseline, expectedCases: tests.map(t => t.name),
    omissions: ['Milky Way volume', 'resolved stellar field', 'HYG background catalog', 'legacy cosmic fallback'],
    productionPaths: ['full application frame', 'real galaxy catalog worker', 'population shader and morphology', 'point/quad LOD', 'camera and depth tiers', 'production exposure meter', 'merger evolution and tides'],
    frames: [], errors: [], warnings: [], failedRequests: [], failedChecks: [], phases: [], completed: false };
const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const phase = async name => {
    const event = { case: report.currentCase || 'startup', source: 'node', name, utc: new Date().toISOString(), elapsedMs: Math.round(performance.now()) };
    report.capturePhase = name; report.phases.push(event); console.log('QA PHASE', JSON.stringify(event)); await save();
};
let server, browser;
// Hard process bound also terminates a stuck WebGL driver, for which ordinary
// Playwright locator timeouts cannot interrupt a pending page.evaluate.
const watchdog = setTimeout(() => {
    report.errors.push({ kind: 'deadline', message: 'Capture exceeded the 8-minute process deadline' });
    void save().finally(() => process.exit(124));
}, 8 * 60_000);
try {
    await phase('server-create');
    server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
        plugins: [{ name: 'external-galaxy-qa-only', enforce: 'pre',
            resolveId(id) { if (id === 'virtual:galaxy-preview') return '\0no-qa-preview'; if (id === '/__external_galaxy_qa__.js') return '\0external-qa'; },
            load(id) { if (id === '\0no-qa-preview') return 'export default null;'; if (id === '\0external-qa') return browserSource; },
            transform: transformExternalGalaxySource,
        }] });
    await server.listen();
    await phase('browser-launch');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const mobile = device === 'mobile';
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 640 } : { width: 768, height: 512 },
        deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile,
        ...(mobile ? { userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' } : {}) });
    await context.addInitScript(() => { Date.now = () => Date.UTC(2026, 8, 13, 12); localStorage.clear(); localStorage.setItem('ap_introSeen', '1'); localStorage.setItem('ap_intro_seen', '1'); });
    const page = await context.newPage(); page.setDefaultTimeout(60_000);
    page.on('pageerror', e => report.errors.push({ case: report.currentCase || 'startup', kind: 'javascript', message: e.stack || e.message }));
    page.on('console', m => { const message = m.text();
        if (message.startsWith('EXTERNAL_QA_PHASE ')) {
            const event = { ...JSON.parse(message.slice('EXTERNAL_QA_PHASE '.length)), case: report.currentCase || 'startup', source: 'browser', utc: new Date().toISOString() };
            report.browserPhase = event.name; report.phases.push(event); console.log('QA PHASE', JSON.stringify(event));
        }
        if (m.type() === 'error') report.errors.push({ case: report.currentCase || 'startup', kind: 'console', message });
        if (m.type() === 'warning' && /WebGL|GL_INVALID|shader|texture|worker failed/i.test(message)) report.warnings.push({ case: report.currentCase || 'startup', message });
    });
    page.on('requestfailed', r => report.failedRequests.push({ url: r.url(), message: r.failure()?.errorText }));
    await phase('page-navigation');
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?hidehelp=1&dpr=1&tier1=0&realsky=0&field=0&galaxyvol=0&galaxy=0&galadapt=0&river=0&lens=0&bloom=0&compile=0&focus=earth&dist=25`, { waitUntil: 'domcontentloaded' });
    await phase('app-and-catalog-ready');
    await page.waitForFunction(() => window.__AP_READY && window.__externalGalaxyApp && window.__galaxyStatus?.().ready);
    await phase('qa-initialize');
    report.renderer = await page.evaluate(async () => { window.externalQA = await import('/__external_galaxy_qa__.js'); return externalQA.initialize(); });
    assert.equal(report.renderer.mobile, mobile, 'Mobile production quality path mismatch');
    report.browser = await browser.version(); await save();
    for (const test of tests) {
        report.currentCase = test.name; const start = performance.now();
        try {
            await phase('fixture-prepare');
            const fixture = await page.evaluate(test => externalQA.prepare(test), test);
            await phase('epoch-ready');
            if (test.epochGyr > 1) await page.waitForFunction(() => externalQA.epochReady(), null, { timeout: 60_000 });
            await phase('steady-frames');
            const costs = [];
            for (let i = 0; i < 2; i++) costs.push(await page.evaluate(() => externalQA.frame()));
            await phase('capture-app-and-target');
            const result = await page.evaluate(() => externalQA.capture());
            await phase('write-pngs');
            await writeFile(resolve(out, `${test.name}.png`), Buffer.from(result.png.split(',')[1], 'base64'));
            await writeFile(resolve(out, `${test.name}-target.png`), Buffer.from(result.targetPng.split(',')[1], 'base64'));
            delete result.png; delete result.targetPng;
            const failed = Object.entries(result.assertions).filter(([, pass]) => !pass).map(([check]) => check);
            report.failedChecks.push(...failed.map(check => ({ case: test.name, check })));
            report.frames.push({ name: test.name, test, fixture, ...result, frameAndFinishMs: costs, totalMs: performance.now() - start });
            // Includes app UI/context, before the diagnostic-only capture.
            if (report.frames.length === 1) { await phase('context-ui-frame'); await page.evaluate(() => externalQA.frame()); await phase('context-ui-screenshot'); await page.screenshot({ path: resolve(out, `${test.name}-ui.png`) }); }
            await phase('case-complete');
            console.log(`CAPTURE ${device}/${suite}/${test.name}: ${failed.length ? 'FAIL ' + failed.join(',') : 'PASS'} ${Math.round(performance.now() - start)}ms`);
        } catch (e) { report.errors.push({ case: test.name, kind: 'capture', message: e.stack || String(e) }); console.error(e); }
        await save();
    }
    delete report.currentCase;
    report.completed = report.frames.length === tests.length;
    report.passed = report.completed && !report.errors.length && !report.failedRequests.length && !report.failedChecks.length;
    // Baseline behavioral failures are evidence of the regression, not CI
    // failures. Incomplete captures, shader, JS or load failures always fail.
    if (!report.completed || report.errors.length || report.failedRequests.length || (!baseline && report.failedChecks.length)) process.exitCode = 1;
} catch (e) { report.errors.push({ kind: 'fatal', message: e.stack || String(e) }); process.exitCode = 1; }
finally { await save(); await browser?.close(); await server?.close(); clearTimeout(watchdog); }
