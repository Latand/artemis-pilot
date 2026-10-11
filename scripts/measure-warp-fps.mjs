// Real-time frame rate of the running app (its own animation loop, no clock
// override), same camera, warp off vs warp on (held Shift+W) vs cruise.
// Run on a host without a GPU this measures the software renderer: a weak-
// graphics proxy for the relative cost of the warp presentation, not a
// device benchmark.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
const mobile = process.env.DEVICE === 'mobile', out = process.env.ARTEMIS_EVIDENCE || 'evidence/warp-fps';
mkdirSync(out, { recursive: true });
const seconds = +(process.env.FPS_SECONDS || 8);
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { device: mobile ? 'mobile' : 'desktop', seconds, phases: [], renderer: null, note: 'software renderer on a GPU-less host; relative cost only' };
try {
    const page = await browser.newPage({ viewport: mobile ? { width: 430, height: 932 } : { width: 1280, height: 720 }, isMobile: mobile, hasTouch: mobile });
    page.setDefaultTimeout(300000);
    await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('ap_introSeen', '1'); localStorage.setItem('ap_uiMode', 'pilot'); });
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, body: '' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=ship&dist=6&hidehelp=1&tier1=0&realsky=0&galaxies=0&galaxyvol=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__AP_READY);
    await page.evaluate(async () => { const { cam } = await import('/src/scene.js'), { shipG } = await import('/src/ship.js'); cam.tgt.copy(shipG.position); cam.dist = 6; cam.yaw = 2.3; cam.pitch = .4; });
    report.renderer = await page.evaluate(() => ({ name: window.__renderQuality?.rendererName, level: window.__renderQuality?.effectiveLevel, riverDraw: window.__renderQuality?.riverDraw, river: window.__river?.count }));
    // App frames = frames the render gate actually submitted (it skips ticks
    // while the GPU is busy); browser animation ticks are kept for reference.
    const count = ms => page.evaluate(ms => new Promise(res => { let n = 0; const g = window.__renderFrameGate || {}; const s0 = g.submitted || 0, w0 = g.waits || 0; const t0 = performance.now();
        const f = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res({ ticks: n, submitted: (g.submitted || 0) - s0, waits: (g.waits || 0) - w0, ms: performance.now() - t0 }); }; requestAnimationFrame(f); }), ms);
    const phase = async name => { const r = await count(seconds * 1000); const s = await page.evaluate(async () => { const { WARP } = await import('/src/warpBubble.js'); return { speed: WARP.speed, presence: window.__river?.warpPresence || 0 }; });
        report.phases.push({ name, fps: +(r.submitted / r.ms * 1000).toFixed(2), browserTicksPerSecond: +(r.ticks / r.ms * 1000).toFixed(2), gateWaits: r.waits, ...s }); };
    await count(3000); // warm-up
    await phase('warp off (lines on)');
    await page.evaluate(() => document.querySelector('[data-bubble-drive]').click());
    for (let i = 0; i < 5; i++) await page.keyboard.press('x');
    await page.keyboard.down('Shift'); await page.keyboard.down('w');
    await phase('warp ramp (Shift+W held)');
    await page.keyboard.up('w'); await page.keyboard.up('Shift');
    await phase('warp cruise');
    const [off, ramp, cruise] = report.phases.map(p => p.fps);
    report.relative = { ramp: +(ramp / off).toFixed(3), cruise: +(cruise / off).toFixed(3) };
} finally {
    writeFileSync(`${out}/fps-${report.device}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    await browser.close(); await server.close();
}
