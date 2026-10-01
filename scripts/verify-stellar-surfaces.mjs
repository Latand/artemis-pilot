// Isolated GPU regression: the exact live photosphere shader, without waiting
// for Milky Way/catalog streaming. Optional output directory gets visual proof.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const out = process.argv[2] ? resolve(process.argv[2]) : null;
if (out) await mkdir(out, { recursive: true });
const port = Number(process.env.STELLAR_TEST_PORT || 5193);
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
try {
    const page = await browser.newPage({ viewport: { width: 1320, height: 930 } });
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('**/__stellar_test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Stellar surfaces regression</title><style>body{background:#03050a;color:#bec8d4;font:14px system-ui;margin:12px} main{display:grid;grid-template-columns:repeat(3,420px);gap:12px}figure{margin:0}canvas{display:block}figcaption{padding:7px}h1{font-size:18px}</style><h1>Visible-light stellar surfaces · deterministic illustrations, not observed maps</h1><main></main>' }));
    await page.goto(`http://127.0.0.1:${port}/__stellar_test`);
    const result = await page.evaluate(async () => {
        const { runStellarSurfaceChecks } = await import('/scripts/stellar-surface-fixture.js');
        return runStellarSurfaceChecks();
    });
    if (out) {
        await page.screenshot({ path: resolve(out, 'stellar-surfaces.png'), fullPage: true });
        await writeFile(resolve(out, 'stellar-surfaces.json'), JSON.stringify({ ...result, errors }, null, 2)+'\n');
    }
    console.log(JSON.stringify({ ...result, errors },null,2));
    assert.deepEqual(errors, [], 'no browser or shader compile errors');
    assert.deepEqual(result.findings, [], 'GPU photosphere checks');
    assert.equal(result.programCount, 1, 'all stellar classes share one shader program');
    assert.ok(result.rendered[1].mean[0] > result.rendered[1].mean[2], 'cool dwarf redder than blue');
    assert.ok(result.rendered[2].mean[2] > result.rendered[2].mean[0], 'hot star bluer than red');
} finally { await browser.close(); await server.close(); }
