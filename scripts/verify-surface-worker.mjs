// Hosted browser worker/readback/context-restore QA. No acceptance threshold is
// relaxed: main-thread preparation maxSliceMs must remain strictly below 16 ms.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { boundedDiagnostic } from './qa-bounded-diagnostic.mjs';
const out = resolve(process.env.ARTEMIS_EVIDENCE || 'evidence/surface-worker');
if (process.argv.includes('--validate')) {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: await readFile('scripts/surface-worker-fixture.mjs', 'utf8') });
    console.log('surface worker fixture syntax valid'); process.exit(0);
}
await mkdir(out, { recursive: true });
const report = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    scope: 'Actual 2K Earth source assets, production worker/integral kernel and Earth material, WebGL context restore. The deliberate legacy readback probe runs after and outside the production 16 ms measurement.',
    checks: [], errors: [], passed: false };
const check = (ok, name) => { report.checks.push({ name, pass: !!ok }); assert(ok, name); };
const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
let browser, server, page;
try {
    server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'surface-worker-fixture', configureServer(server) {
        server.middlewares.use((req, res, next) => {
            if (req.url !== '/__surface-worker-qa') return next();
            res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#050509"><script type="module" src="/scripts/surface-worker-fixture.mjs"></script>');
        });
    } }] }); await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    page = await browser.newPage({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }); page.setDefaultTimeout(120000);
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__surface-worker-qa`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.surfaceWorkerQA?.ready || window.surfaceWorkerQA?.error);
    check(!await page.evaluate(() => surfaceWorkerQA.error), 'worker fixture initializes');
    report.environment = await page.evaluate(() => ({ innerWidth, deviceMemory: navigator.deviceMemory ?? null, gpu: surfaceWorkerQA.renderer.getContext().getParameter(surfaceWorkerQA.renderer.getContext().RENDERER) }));
    check(report.environment.innerWidth === 430, 'fixture uses the actual compact-device layout and memory policy');
    await page.waitForFunction(() => surfaceWorkerQA.preparation().pending === 0);
    check(await page.evaluate(() => surfaceWorkerQA.update()), 'worker image results activate exposure');
    report.productionPreparation = await page.evaluate(() => surfaceWorkerQA.preparation());
    check(report.productionPreparation.workerJobs === 3 && report.productionPreparation.built === 3, 'shared Earth/cloud sources use three worker jobs');
    check(report.productionPreparation.mainMathMs === 0 && report.productionPreparation.mainCopyMs === 0, 'source readback and math ran off the main thread');
    report.beforeRestore = await page.evaluate(() => surfaceWorkerQA.capture());
    await page.screenshot({ path: resolve(out, 'before-restore.png') }); await save();
    check(report.productionPreparation.maxSliceMs < 16, 'main-thread preparation stays below the unchanged 16 ms gate');
    report.legacyProbe = await page.evaluate(() => surfaceWorkerQA.legacyProbe());
    check(report.legacyProbe.every(result => result.exact), 'worker prefix floats are bit-identical to the previous DOM-image readback path');
    await save();
    check(await page.evaluate(() => !!surfaceWorkerQA.renderer.getContext().getExtension('WEBGL_lose_context')), 'context-restore test extension is available');
    await page.evaluate(() => surfaceWorkerQA.renderer.forceContextLoss());
    await page.waitForFunction(() => surfaceWorkerQA.lost === 1);
    await page.evaluate(() => surfaceWorkerQA.renderer.forceContextRestore());
    await page.waitForFunction(() => surfaceWorkerQA.restored === 1);
    report.afterRestore = await page.evaluate(() => surfaceWorkerQA.capture());
    check(report.afterRestore.hash === report.beforeRestore.hash, 'context restoration produces identical rendered pixels');
    check(JSON.stringify(report.afterRestore.prefixes) === JSON.stringify(report.beforeRestore.prefixes), 'context restore reuses retained CPU prefix buffers');
    check(report.afterRestore.preparation.built === report.beforeRestore.preparation.built, 'context restore does not rebuild prefixes');
    check(JSON.stringify(report.afterRestore.resources) === JSON.stringify(report.beforeRestore.resources), 'restored GPU resource count is stable');
    await page.screenshot({ path: resolve(out, 'after-restore.png') });
    check(report.errors.length === 0, 'no script, shader or worker errors'); report.passed = true;
} catch (error) {
    report.failure = error.stack || String(error); process.exitCode = 1;
    if (page) report.failureScreenshot = await boundedDiagnostic(() => page.screenshot({ path: resolve(out, 'failure.png'), timeout: 10000 }).then(() => true), 12000);
} finally {
    await save(); if (browser) await browser.close(); if (server) await server.close();
}
