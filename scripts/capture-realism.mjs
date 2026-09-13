import { chromium } from 'playwright';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const out = resolve(process.argv[2] || 'docs/realism-2026-09-13/after');
const base = process.env.ARTEMIS_URL || 'http://127.0.0.1:5178/';
await mkdir(out, { recursive: true });
const server = process.env.ARTEMIS_URL ? null : await createServer({server:{host:'127.0.0.1',port:5178,strictPort:true,hmr:false}});
await server?.listen();
const fingerprint = createHash('sha256');
for (const file of (await readdir('src', {recursive:true})).filter(f=>f.endsWith('.js')).sort()) { fingerprint.update(file); fingerprint.update(await readFile(resolve('src',file))); }
const sourceHash = fingerprint.digest('hex');
const browser = await chromium.launch({ headless: true });
try {
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
    Date.now = () => Date.UTC(2026, 8, 13, 12);
    localStorage.setItem('ap_intro_seen', '1');
});
const page = await context.newPage();
const errors = [];
page.setDefaultTimeout(180000);
page.on('pageerror', e => { errors.push(String(e)); console.error(String(e)); });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base + '?warp=0&hidehelp=1&realsky=1&perf=1&dpr=1&focus=earth&dist=28');
await page.waitForFunction(() => window.__AP_READY, null, { timeout: 60000 });
const enter = page.getByRole('button', { name: 'ENTER SIMULATION', exact: true });
if (await enter.isVisible()) await enter.click();
await page.evaluate(() => { __G.paused = true; __G.gr = false; __G.predict = false; __G.constellations = false; __G.darkEnergy = false; __G.darkMatter = false; });
await page.waitForFunction(async () => (await import('/src/realSky.js')).realSkyStatus().loaded, null, { timeout: 60000 });
for (let i=0; i<36; i++) {
    const stats = await page.evaluate(() => __tier1Stats());
    if (stats.initialized && stats.tilesLoaded === stats.totalTiles) break;
    if (i % 6 === 0) console.log('Catalog warmup', JSON.stringify(stats));
    await page.evaluate(async () => {
        const {updateTier1} = await import('/src/universe/athygTier1.js');
        for(let j=0;j<400;j++) updateTier1(0,0,0,null,0);
    });
    await page.waitForTimeout(5000);
    if (i === 35) throw new Error('Catalog did not finish loading');
}
const results = [];
const scenarios = [
    { name: 'earth', focus: 'earth', radius: 6.371, phase: 1.05 },
    { name: 'earth-night', focus: 'earth', radius: 6.371, phase: 2.35 },
    { name: 'mars', focus: 2, radius: 3.3895, phase: 1.05 },
    { name: 'jupiter', focus: 3, radius: 69.911, phase: 1.05 },
    { name: 'saturn', focus: 4, radius: 58.232, phase: 1.05 },
    { name: 'sun', focus: 'sun', radius: 695.7, phase: 0 },
    { name: 'starfield', focus: 'sun', distance: 1e7, phase: 0 },
];
if (process.argv.includes('--extended')) scenarios.push(
    {name:'proxima',focus:'star:0',radius:107.375628,phase:0},
    {name:'milky-way',focus:'sun',distance:9460730472.5808*120000,phase:0},
    {name:'local-group',focus:'sun',distance:9460730472.5808*3200000,phase:0},
    {name:'earth-return',focus:'earth',radius:6.371,phase:1.05},
);
const selected = process.env.ARTEMIS_SCENES?.split(',');
for (const s of scenarios.filter(s => !selected || selected.includes(s.name))) {
    await page.evaluate(async s => {
        const b = await import('/src/bodies.js');
        __G.focus = s.focus;
        const {STARS, K} = await import('/src/constants.js');
        const star = typeof s.focus === 'string' && s.focus.startsWith('star:') ? STARS[Number(s.focus.slice(5))] : null;
        const center = star ? {x:star.x*K,y:star.z*K,z:-star.y*K} : s.focus === 'earth' ? b.earthG.position : typeof s.focus === 'number' ? b.plGroups[s.focus].position : b.sunPos;
        __cam.tgt.copy(center);
        __cam.dist = s.distance || s.radius * (s.name === 'saturn' ? 6.5 : 4.3);
        __cam.distTarget = null;
        __cam.yaw = (s.focus === 'sun' || star) ? -.95 : Math.atan2(b.sunPos.z - center.z, b.sunPos.x - center.x) + s.phase;
        __cam.pitch = s.name === 'saturn' ? .5 : .22;
        if (typeof s.focus === 'number') b.requestPlanetTexture(s.focus);
    }, s);
    if (s.distance > 1e12) {
        await page.waitForFunction(async () => (await import('/src/cosmic.js')).isCosmicLayerBuilt(), null, {timeout:120000});
    }
    await page.waitForTimeout(2200);
    await page.evaluate(() => __PERF.clear());
    const cadence = await page.evaluate(() => new Promise(resolve => {
        const values = []; let previous;
        function step(t) { if (previous !== undefined) values.push(t - previous); previous = t; if (values.length < 30) requestAnimationFrame(step); else { values.sort((a,b)=>a-b); resolve({medianMs:values[15], p95Ms:values[28]}); } }
        requestAnimationFrame(step);
    }));
    const state = await page.evaluate(() => ({ cam: __cam, camera: __gl.camera.position, t: __G.t, perf: __PERF.samples, render: __PERF.renderInfo, quality: __renderQuality, tier1: __tier1Stats() }));
    const style = await page.addStyleTag({content: 'body * { visibility: hidden !important } #gl, #gl canvas { visibility: visible !important }'});
    await page.screenshot({ path: resolve(out, s.name + '.png') });
    if (s.name === 'earth') { await page.waitForTimeout(1000); await page.screenshot({path: resolve(out, 'earth-paused.png')}); }
    await style.evaluate(el => el.remove());
    results.push({ ...s, ...cadence, ...state });
    console.log(s.name, JSON.stringify(cadence), state.render.calls, 'draw calls');
}
await page.screenshot({path: resolve(out, 'interface.png')});
const gpu = await page.evaluate(() => {
    const gl = __gl.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION) };
});
await writeFile(resolve(out, 'metrics.json'), JSON.stringify({sourceHash, epoch:'2026-09-13T12:00:00Z', viewport:{width:1440,height:900}, gpu, results, errors}, null, 2) + '\n');
if (errors.length) { console.error(errors); process.exitCode = 1; }
} finally {
    await browser.close();
    await server?.close();
}
