// Full-application host ownership QA. This harness never substitutes system
// selection, camera targets, body models or materials. Test-only hooks freeze
// the clock, expose the selected system, and deliver production frames.
// DEVICE=desktop|mobile [BASE_ROOT=...] node scripts/verify-explored-systems.mjs [ROOT] [OUTPUT]
// --validate checks both QA hooks and JavaScript syntax without a browser.
// --compare BASE_REPORT CANDIDATE_REPORT OUTPUT compares matched full-app p95.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)];
const median = values => quantile(values, .5);
if (process.argv.includes('--compare')) {
    const [baseFile, candidateFile, destination = 'evidence/explored-comparison.json'] = process.argv.slice(process.argv.indexOf('--compare') + 1);
    const base = JSON.parse(await readFile(baseFile, 'utf8'));
    const candidate = JSON.parse(await readFile(candidateFile, 'utf8'));
    assert.equal(base.device, candidate.device);
    assert.deepEqual(base.routes.map(r => r.fixture), candidate.routes.map(r => r.fixture), 'Baseline and candidate must use identical routes');
    assert.deepEqual(base.benchmark.map(x => x.fixture), candidate.benchmark.map(x => x.fixture), 'Performance camera workloads must match');
    const scenarios = candidate.benchmark.map((after, i) => {
        const before = base.benchmark[i];
        const baselineP95Ms = median(before.runs.map(r => quantile(r.frameAndFinishMs, .95)));
        const candidateP95Ms = median(after.runs.map(r => quantile(r.frameAndFinishMs, .95)));
        return { name: after.fixture.name, baselineP95Ms, candidateP95Ms,
            regressionPercent: (candidateP95Ms / baselineP95Ms - 1) * 100,
            passesFivePercentTarget: candidateP95Ms <= baselineP95Ms * 1.05 };
    });
    const longTaskSummary = report => {
        const entries = report.longTasks?.benchmark || [];
        return { count: entries.length, totalBlockingMs: entries.reduce((n, e) => n + Math.max(0, e.duration - 50), 0),
            maximumMs: Math.max(0, ...entries.map(e => e.duration)) };
    };
    const beforeLong = longTaskSummary(base), afterLong = longTaskSummary(candidate);
    const longTaskBudget = {
        scope: 'Matched benchmark fixtures including warmup; startup, exploration routes and reload are reported separately',
        definition: 'Main-thread tasks >=50ms; total blocking time counts only duration above 50ms',
        baseline: beforeLong, candidate: afterLong,
        allowedTotalBlockingMs: beforeLong.totalBlockingMs * 1.05 + 50,
        allowedMaximumMs: Math.max(200, beforeLong.maximumMs * 1.05),
        allowedCount: Math.ceil(beforeLong.count * 1.05) + 1,
    };
    longTaskBudget.passed = afterLong.totalBlockingMs <= longTaskBudget.allowedTotalBlockingMs &&
        afterLong.maximumMs <= longTaskBudget.allowedMaximumMs && afterLong.count <= longTaskBudget.allowedCount;
    const comparison = { device: base.device, baselineRevision: base.revision, candidateRevision: candidate.revision,
        measurement: 'Median of three p95 windows; 120 individually delivered production frames/window, including GPU finish',
        scenarios, longTaskBudget,
        passesFivePercentTarget: scenarios.every(s => s.passesFivePercentTarget),
        baselineReproduced: base.reproduction?.hostDropped === true, candidatePassed: candidate.passed === true };
    await writeFile(destination, JSON.stringify(comparison, null, 2) + '\n');
    console.log(JSON.stringify(comparison, null, 2));
    assert(comparison.baselineReproduced, 'Baseline must reproduce the real host-drop bug');
    assert(comparison.candidatePassed, 'Candidate functional verification must pass');
    assert(comparison.passesFivePercentTarget, 'Matched full-app p95 exceeded the 5% regression target');
    assert(comparison.longTaskBudget.passed, 'Matched main-thread long tasks exceeded the explicit blocking-time/count/maximum budget');
    process.exit(0);
}

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const root = resolve(process.env.BASE_ROOT || args[0] || '.');
const baseline = !!process.env.BASE_ROOT || process.env.BASELINE === '1';
const device = process.env.DEVICE || 'desktop', mobile = device === 'mobile';
assert(['desktop', 'mobile'].includes(device), 'DEVICE must be desktop or mobile');
const out = resolve(args[1] || process.env.ARTEMIS_EVIDENCE || `evidence/explored/${baseline ? 'before' : 'after'}-${device}`);
function once(source, token, replacement) {
    assert.equal(source.split(token).length, 2, `Explored-system QA hook changed: ${token}`);
    return source.replace(token, replacement);
}
function transform(source, id) {
    id = id.replaceAll('\\', '/').split('?')[0];
    if (id.endsWith('/src/render/catalogStars.js')) return once(source, 'const start = () => loadTier0();', 'const start = () => {}; // QA: background catalog omitted; explicit HYG loading is exercised separately.');
    if (id.endsWith('/src/render/bodySurfaceMaterial.js')) return source + '\nexport const exploredSurfaceQueueState=()=>({pending:pending.size,inFlight:!!inFlight});\n';
    if (!id.endsWith('/src/main.js')) return null;
    source = once(source, 'const firstFrameT0 = perfStart();',
        'G.t=0;G.paused=true;G.warp=1;resetEphem();clock.getDelta=()=>1/60;\nconst firstFrameT0 = perfStart();');
    source = once(source, 'renderer.setAnimationLoop(frame);', '// QA: production frame is delivered explicitly.');
    source = once(source, 'updateSystemRender(focusedSystem, G.t, camera, G.focus);',
        'updateSystemRender(focusedSystem, G.t, camera, G.focus);window.__exploredCurrentSystem=focusedSystem;');
    return source + `\nwindow.__exploredFrame=()=>{clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;
        const t=performance.now();frame();const cpu=performance.now()-t;renderer.getContext().finish();
        return {cpuMs:cpu,frameAndFinishMs:performance.now()-t};};\n`;
}
const main = await readFile(resolve(root, 'src/main.js'), 'utf8');
execFileSync(process.execPath, ['--input-type=module', '--check'], { input: transform(main, '/src/main.js') });
const surfaces = await readFile(resolve(root, 'src/render/bodySurfaceMaterial.js'), 'utf8');
execFileSync(process.execPath, ['--input-type=module', '--check'], { input: transform(surfaces, '/src/render/bodySurfaceMaterial.js') });
const catalog = await readFile(resolve(root, 'src/render/catalogStars.js'), 'utf8');
execFileSync(process.execPath, ['--input-type=module', '--check'], { input: transform(catalog, '/src/render/catalogStars.js') });
if (process.argv.includes('--validate')) {
    console.log(JSON.stringify({ root, baseline, device, routes: 20, hooks: 'valid', benchmarkWindows: 3, samplesPerWindow: 120 }));
    process.exit(0);
}
await mkdir(out, { recursive: true });
const report = {
    version: 1, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), baseline, device,
    epoch: '2026-10-01T12:00:00.000Z', errors: [], warnings: [], checks: [], routes: [], repeatedRoutes: [], captures: [], benchmark: [],
    omissions: ['AT-HYG streaming', 'HYG background catalog', 'procedural background field', 'volumetric galaxy', 'galaxy population', 'gravity overlay', 'bloom'],
    identityRepairNote: 'Blank HIP records are excluded from matched fixtures because their formerly colliding host identities are intentionally repaired; real-HYG identity tests cover that change',
    productionPaths: ['main frame and real system selection', 'Shift+F keyboard input', 'body generation and render pool',
        'Explore/Pilot controls', 'camera movement', 'quicksave/quickload', 'body materials and lighting', 'production desktop/mobile quality'],
};
const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const check = (name, pass, details = null, candidateOnly = false) => {
    report.checks.push({ name, pass: !!pass, candidateOnly, ...(details ? { details } : {}) });
    if (!pass && !(baseline && candidateOnly)) console.error('CHECK FAILED', name, details || '');
};
let server, browser, page;
try {
    server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
        plugins: [{ name: 'full-app-explored-system-qa', enforce: 'pre', transform }] });
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: mobile ? { width: 430, height: 932 } : { width: 1200, height: 800 },
        deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    await context.addInitScript(() => {
        Date.now = () => Date.UTC(2026, 9, 1, 12);
        localStorage.setItem('ap_introSeen', '1'); localStorage.setItem('ap_uiMode', 'observe'); localStorage.removeItem('ap_cam');
        window.__qaPhase = 'startup'; window.__qaLongTasks = [];
        if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
            const observer = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) window.__qaLongTasks.push({ startTime: entry.startTime, duration: entry.duration, phase: window.__qaPhase });
            });
            observer.observe({ type: 'longtask', buffered: true });
        }
    });
    page = await context.newPage(); page.setDefaultTimeout(120000);
    page.on('pageerror', error => report.errors.push({ phase: report.phase || 'startup', message: error.stack || error.message }));
    page.on('console', message => {
        if (message.type() === 'error' && /THREE|Shader|GL_INVALID|WebGL/i.test(message.text())) report.errors.push({ phase: report.phase, message: message.text() });
        if (message.type() === 'warning' && /WebGL|shader|texture/i.test(message.text())) report.warnings.push(message.text());
    });
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, body: '' }));
    const query = new URLSearchParams({ focus: 'earth', dist: '25', hidehelp: '1', dpr: '1', tier1: '0', realsky: '0', field: '0',
        galaxyvol: '0', galaxies: '0', galaxy: '0', river: '0', bloom: '0', compile: '0', galadapt: '0' });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?${query}`, { waitUntil: 'domcontentloaded' });
    async function initialize() {
        await page.waitForFunction(() => window.__AP_READY && window.__exploredFrame);
        return page.evaluate(async () => {
            const [s, a, p, c, input, saves, eph, body, state, surfaces] = await Promise.all([
                import('/src/scene.js'), import('/src/universe/activeStars.js'), import('/src/universe/planetarySystem.js'),
                import('/src/constants.js'), import('/src/input.js'), import('/src/saves.js'), import('/src/ephemeris.js'),
                import('/src/render/systemBodies.js'), import('/src/state.js'), import('/src/render/bodySurfaceMaterial.js'),
            ]);
            const hash = value => {
                const text = JSON.stringify(value); let n = 2166136261;
                for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
                return (n >>> 0).toString(16).padStart(8, '0');
            };
            const nearest = a.nearestActiveStar(eph.eph.earthX + state.G.x, eph.eph.earthY + state.G.y, state.G.z).star;
            const nearestId = p.stableStarKey(nearest);
            const hosts = c.STARS.flatMap((star, starIndex) => {
                if (star.hip === '' || star.bh || star.kind === 'BH' || star.kind === 'NS' || p.stableStarKey(star) === nearestId) return [];
                const system = p.generateSystem(star);
                const children = system.planets.flatMap(planet => (planet.moons || []).map((moon, moonIndex) => ({
                    starIndex, starId: system.starId, starName: star.name, planetIndex: planet.index, moonIndex,
                    planetName: planet.name, moonName: moon.name, topologyHash: hash(system.planets),
                })));
                return children.length ? [children] : [];
            });
            const fixtures = [];
            // Round robin covers as many real catalog hosts as possible before
            // taking another moon of an already covered host. Every tuple differs.
            for (let index = 0; fixtures.length < 20 && index < 48; index++) for (const children of hosts) {
                if (children[index] && fixtures.length < 20) fixtures.push(children[index]);
            }
            const resources = roots => {
                const objects = new Set(), geometries = new Set(), materials = new Set(), textures = new Set();
                for (const root of roots) root.traverse(object => {
                    objects.add(object.uuid); if (object.geometry) geometries.add(object.geometry.uuid);
                    for (const material of (Array.isArray(object.material) ? object.material : [object.material]).filter(Boolean)) {
                        materials.add(material.uuid);
                        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value.uuid);
                        for (const uniform of Object.values(material.uniforms || {})) if (uniform?.value?.isTexture) textures.add(uniform.value.uuid);
                    }
                });
                return { objects: objects.size, geometries: geometries.size, materials: materials.size, textures: textures.size };
            };
            const ship = () => Object.fromEntries(['t', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'heading', 'pitch', 'fuel', 'paused'].map(k => [k, state.G[k]]));
            window.exploredQA = { s, a, p, c, input, saves, eph, body, state, surfaces, hash, resources, fixtures, nearestId, ship };
            const gl = s.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
            return { fixtures, nearestId, ship: ship(), mobile: s.renderQuality.mobile,
                gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                seed: (await import('/src/universe/galaxy.js')).getSeed() };
        });
    }
    const initial = await initialize(); report.initial = initial; report.browser = await browser.version();
    check('Twenty distinct deterministic routes', initial.fixtures.length === 20 && new Set(initial.fixtures.map(x => `${x.starId}/${x.planetIndex}/${x.moonIndex}`)).size === 20);
    check('Production mobile quality matches requested device', initial.mobile === mobile);
    assert.equal(initial.fixtures.length, 20, 'The unchanged catalog/seed must supply twenty real star/planet/moon tuples');
    const phase = async name => { report.phase = name; await page.evaluate(name => { window.__qaPhase = name; }, name); };
    const frames = async (count = 2) => {
        const result = []; for (let i = 0; i < count; i++) result.push(await page.evaluate(() => __exploredFrame())); return result;
    };
    const focus = value => page.evaluate(value => { const q = exploredQA; q.input.setFocus(value); q.s.cam.distTarget = null; }, value);
    const key = async chord => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press(chord); };
    const mode = async value => {
        const button = page.locator(`[data-ui-mode="${value}"]`);
        if (mobile) await button.tap(); else await button.click();
        await page.evaluate(() => document.activeElement?.blur()); await frames();
    };
    const snapshot = async (fixture = null) => page.evaluate(fixture => {
        const q = exploredQA, sys = window.__exploredCurrentSystem, slots = q.body.systemBodyRenderState();
        const selectedPlanet = q.p.planetFocusIndex(q.state.G.focus), selectedMoon = q.p.planetMoonFocusIndex(q.state.G.focus);
        let expectedPosition = null, cameraTargetError = null;
        if (fixture && (selectedPlanet >= 0 || selectedMoon)) {
            const star = q.c.STARS[fixture.starIndex], expected = { ...q.p.generateSystem(star), hostStar: star };
            const position = selectedMoon ? q.body.moonScenePosition(expected, fixture.planetIndex, fixture.moonIndex, q.state.G.t) :
                q.body.planetScenePosition(expected, selectedPlanet, q.state.G.t);
            if (position) { expectedPosition = position.toArray(); cameraTargetError = q.s.cam.tgt.distanceTo(position); }
        }
        return { focus: q.state.G.focus, mode: q.state.G.uiMode, starId: sys?.starId || null, hostName: sys?.hostStar?.name || null,
            topologyHash: sys ? q.hash(sys.planets) : null, ship: q.ship(), expectedPosition, cameraTargetError,
            cam: { target: q.s.cam.tgt.toArray(), position: q.s.camera.position.toArray(), yaw: q.s.cam.yaw, pitch: q.s.cam.pitch, dist: q.s.cam.dist },
            render: { slots: slots.length, moonSlots: slots.map(slot => slot.moons.length),
                materials: slots.map(slot => [slot.mesh.material.uuid, ...slot.moons.map(m => m.material.uuid)]),
                textures: slots.map(slot => [slot.mesh, ...slot.moons].map(mesh => [mesh.material.map?.uuid || null, mesh.material.normalMap?.uuid || null])),
                appearanceIds: slots.map(slot => slot.mesh.userData.appearanceIdentity || null),
                resources: q.resources(slots.flatMap(slot => [slot.group, slot.orbit])), scene: q.resources([q.s.scene]),
                gpu: { ...q.s.renderer.info.memory, programs: q.s.renderer.info.programs.length } } };
    }, fixture);
    const capture = async name => {
        await page.screenshot({ path: resolve(out, `${name}.png`), timeout: 180000 });
        report.captures.push({ name, path: `${name}.png`, state: await snapshot() }); await save();
    };
    const assertPaused = (name, state) => check(`${name}: paused time and ship unchanged`, JSON.stringify(state.ship) === JSON.stringify(initial.ship), state.ship);
    const assertOwner = (name, state, fixture) => {
        check(`${name}: stable host`, state.starId === fixture.starId, { expected: fixture.starId, actual: state.starId }, true);
        check(`${name}: unchanged generated planets and moons`, state.topologyHash === fixture.topologyHash, null, true);
        if (state.focus.startsWith('system:') || state.focus.startsWith('planet:')) {
            check(`${name}: host-qualified child identity`, state.focus.startsWith(`system:${encodeURIComponent(fixture.starId)}:planet:`), state.focus, true);
            check(`${name}: camera follows correct host child`, state.cameraTargetError !== null && state.cameraTargetError < 1e-3,
                { cameraTargetError: state.cameraTargetError }, true);
        }
        assertPaused(name, state);
    };

    // Benchmark equivalent views before the failure/recovery routes. Only
    // star/solar focus is used here because the baseline child path is broken:
    // comparing its wrong planet to the corrected planet would be misleading.
    const benchmarkFixtures = [
        { name: 'earth-near', focus: 'earth', distance: 25, yaw: -.4, pitch: .45 },
        { name: 'catalog-star', focus: `star:${initial.fixtures[0].starIndex}`, distance: null, yaw: -.4, pitch: .45 },
        { name: 'system-overview', focus: `star:${initial.fixtures[1].starIndex}`, distance: 1500000, yaw: -.4, pitch: .45 },
    ];
    for (const fixture of benchmarkFixtures) {
        await phase(`benchmark:${fixture.name}`); await focus(fixture.focus);
        await page.evaluate(fixture => {
            const { cam } = exploredQA.s; if (fixture.distance !== null) cam.dist = fixture.distance;
            cam.yaw = fixture.yaw; cam.pitch = fixture.pitch; cam.distTarget = null;
        }, fixture);
        await frames(30);
        await page.waitForFunction(() => { const q = exploredQA.surfaces.exploredSurfaceQueueState(); return q.pending === 0 && !q.inFlight; });
        await frames(3);
        const result = { fixture, state: await snapshot(), runs: [] };
        for (let round = 0; round < 3; round++) {
            const samples = await frames(120);
            result.runs.push({ cpuMs: samples.map(s => s.cpuMs), frameAndFinishMs: samples.map(s => s.frameAndFinishMs) });
        }
        report.benchmark.push(result); await save();
    }
    await phase('baseline-reproduction');
    const first = initial.fixtures[0]; await focus(`star:${first.starIndex}`); await frames(3);
    const before = await snapshot(first); await capture('01-non-nearest-star');
    await key('Shift+KeyF'); await frames(3);
    const after = await snapshot(first); await capture('02-shift-f-planet');
    report.reproduction = { fixture: first, nearestId: initial.nearestId, before, after, hostDropped: before.starId !== after.starId };
    if (baseline) check('Baseline reproduces host drop to ship-nearest system', report.reproduction.hostDropped && after.starId === initial.nearestId, report.reproduction);
    else assertOwner('Shift+F reproduction', after, first);

    for (const [index, fixture] of initial.fixtures.entries()) {
        await phase(`route:${index + 1}:${fixture.starName}`); await mode('observe');
        await focus(`star:${fixture.starIndex}`); await frames(2);
        const route = { fixture, states: {}, input: ['setFocus(star)', 'Shift+F', 'setFocus(moon)', 'K', 'other star', 'L', 'W', 'Pilot', 'wheel', 'Explore', 'star'] };
        route.states.star = await snapshot(fixture); assertOwner(`Route ${index + 1} star`, route.states.star, fixture);
        for (let i = 0; i <= fixture.planetIndex; i++) { await key('Shift+KeyF'); await frames(2); }
        route.states.planet = await snapshot(fixture); assertOwner(`Route ${index + 1} planet`, route.states.planet, fixture);
        await page.evaluate(fixture => { const q = exploredQA; q.input.setFocus(q.p.planetMoonFocusValue(fixture.planetIndex, fixture.moonIndex, fixture.starId)); q.s.cam.distTarget = null; }, fixture);
        await frames(3); route.states.moon = await snapshot(fixture); assertOwner(`Route ${index + 1} moon`, route.states.moon, fixture);
        check(`Route ${index + 1}: child navigation reuses rendered material pool`,
            JSON.stringify(route.states.star.render.materials) === JSON.stringify(route.states.moon.render.materials), null, true);
        if (index === 0) await capture('03-same-host-moon');
        await key('KeyK');
        const savedFocus = route.states.moon.focus;
        const savedRecord = await page.evaluate(() => JSON.parse(localStorage.getItem('artemis.quicksave.v1')));
        check(`Route ${index + 1}: quicksave persists exact child focus`, savedRecord?.g?.focus === savedFocus);
        check(`Route ${index + 1}: quicksave persists host context`, savedRecord?.exploredSystem?.starId === fixture.starId, null, true);
        const other = initial.fixtures.find(f => f.starId !== fixture.starId);
        await focus(`star:${other.starIndex}`); await frames(2);
        await key('KeyL'); await page.waitForFunction(value => __G.focus === value, savedFocus); await frames(3);
        route.states.loaded = await snapshot(fixture); assertOwner(`Route ${index + 1} quickload`, route.states.loaded, fixture);
        await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.down('KeyW'); await frames(2); await page.keyboard.up('KeyW');
        route.states.free = await snapshot(fixture); assertOwner(`Route ${index + 1} free camera`, route.states.free, fixture);
        check(`Route ${index + 1}: Explore movement moves only the camera`, route.states.free.focus === 'free' &&
            JSON.stringify(route.states.free.cam.target) !== JSON.stringify(route.states.loaded.cam.target));
        if (index === 0) await capture('04-explore-free-camera');
        await mode('pilot'); route.states.pilot = await snapshot(fixture); assertOwner(`Route ${index + 1} Pilot`, route.states.pilot, fixture);
        // Dispatch a wheel event on the real application canvas so the normal
        // production zoom handler is exercised without accidentally grabbing
        // the ship at screen centre on touch-size viewports.
        await page.evaluate(() => exploredQA.s.renderer.domElement.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true, cancelable: true })));
        await frames(2); route.states.pilotZoom = await snapshot(fixture); assertOwner(`Route ${index + 1} Pilot camera`, route.states.pilotZoom, fixture);
        check(`Route ${index + 1}: Pilot camera zoom is independent`, route.states.pilotZoom.cam.dist !== route.states.pilot.cam.dist);
        if (index === 0) await capture('05-pilot-retains-system');
        await mode('observe'); route.states.explore = await snapshot(fixture); assertOwner(`Route ${index + 1} Explore return`, route.states.explore, fixture);
        await focus(`star:${fixture.starIndex}`); await frames(2); route.states.returned = await snapshot(fixture);
        assertOwner(`Route ${index + 1} star return`, route.states.returned, fixture);
        const resourceStates = Object.values(route.states).map(s => s.render);
        check(`Route ${index + 1}: fixed eight-planet/six-moon pool`, resourceStates.every(r => r.slots === 8 && r.moonSlots.every(n => n === 6)));
        check(`Route ${index + 1}: bounded live system resources`, resourceStates.every(r => r.resources.geometries <= 80 && r.resources.materials <= 136 && r.resources.textures <= 136), resourceStates.map(r => r.resources));
        report.routes.push(route); await save(); console.log(`ROUTE ${index + 1}/20 ${fixture.starName} planet ${fixture.planetIndex} moon ${fixture.moonIndex}`);
    }
    await phase('same-host-repeated-routes');
    await mode('observe'); await focus(`star:${first.starIndex}`); await frames(3);
    const clickSystem = async selector => {
        const button = page.locator(selector);
        await button.scrollIntoViewIfNeeded();
        if (mobile) await button.tap(); else await button.click();
        await page.evaluate(() => document.activeElement?.blur()); await frames(2);
    };
    if (!baseline) {
        if (mobile) await page.locator('#explorePanelToggle').tap();
        for (const selector of ['#exploreSystemStar', '#exploreSystemPlanet']) {
            await page.locator(selector).scrollIntoViewIfNeeded();
            const box = await page.locator(selector).boundingBox();
            check(`${selector}: real ${mobile ? 'touch' : 'desktop'} control is reachable`,
                !!box && box.height >= 44 && box.y >= 0 && box.y + box.height <= (mobile ? 932 : 800));
        }
        // Warm the entire real button route, including intermediate planets,
        // not only its final planet. Settle each requested view and upload its
        // deferred maps before defining a no-growth/no-reallocation baseline.
        const settleWarmView = async () => {
            for (let i = 0; i < 8; i++) {
                await frames(24);
                if (await page.evaluate(() => exploredQA.s.cam.distTarget === null)) break;
            }
            await page.waitForFunction(() => { const q = exploredQA.surfaces.exploredSurfaceQueueState(); return q.pending === 0 && !q.inFlight; });
            await frames(3);
        };
        for (let p = 0; p <= first.planetIndex; p++) { await clickSystem('#exploreSystemPlanet'); await settleWarmView(); }
        await clickSystem('#exploreSystemMoon'); await settleWarmView();
        await page.waitForFunction(first => exploredQA.body.systemBodyRenderState()[first.planetIndex].moons[first.moonIndex].material.userData.surfaceDetailWidth >= 512, first);
        check('Representative moon camera has completed its requested approach', await page.evaluate(() => exploredQA.s.cam.distTarget === null));
        if (mobile) await page.locator('#explorePanelToggle').tap();
        await capture('06-settled-moon-surface');
        if (mobile) await page.locator('#explorePanelToggle').tap();
        await clickSystem('#exploreSystemStar'); await settleWarmView();
    }
    const repeatedStart = await snapshot(first);
    report.repeatedWarmBaseline = repeatedStart;
    for (let index = 0; index < 20; index++) {
        for (let p = 0; p <= first.planetIndex; p++) {
            if (baseline) { await key('Shift+KeyF'); await frames(2); }
            else await clickSystem('#exploreSystemPlanet');
        }
        const planet = await snapshot(first); assertOwner(`Repeated ${index + 1} planet`, planet, first);
        if (baseline) {
            await page.evaluate(first => { const q = exploredQA; q.input.setFocus(q.p.planetMoonFocusValue(first.planetIndex, first.moonIndex, first.starId)); }, first);
            await frames(2);
        } else {
            await clickSystem('#exploreSystemMoon');
            if (index === 0) {
                const box = await page.locator('#exploreSystemMoon').boundingBox();
                check('Moon touch control is a reachable 44px target', !!box && box.height >= 44 && box.y >= 0 && box.y + box.height <= (mobile ? 932 : 800));
                await capture('06-touch-system-navigation');
            }
        }
        const moon = await snapshot(first); assertOwner(`Repeated ${index + 1} moon`, moon, first);
        if (baseline) { await focus(`star:${first.starIndex}`); await frames(2); }
        else await clickSystem('#exploreSystemStar');
        const star = await snapshot(first); assertOwner(`Repeated ${index + 1} star`, star, first);
        check(`Repeated ${index + 1}: same host retains material identity`,
            JSON.stringify(star.render.materials) === JSON.stringify(repeatedStart.render.materials), null, true);
        check(`Repeated ${index + 1}: render-pool counts do not grow`,
            star.render.resources.materials === repeatedStart.render.resources.materials &&
            star.render.resources.geometries === repeatedStart.render.resources.geometries);
        check(`Repeated ${index + 1}: warmed host retains surface texture identity`,
            JSON.stringify(star.render.textures) === JSON.stringify(repeatedStart.render.textures), null, true);
        check(`Repeated ${index + 1}: warmed GPU resources do not grow`,
            star.render.gpu.geometries <= repeatedStart.render.gpu.geometries && star.render.gpu.textures <= repeatedStart.render.gpu.textures, null, true);
        report.repeatedRoutes.push({ fixture: first, states: { planet, moon, star } });
    }
    await phase('warmed-switch-handler-cpu');
    const switchSamples = [];
    for (let i = 0; i < 20; i++) for (const target of ['planet', 'moon', 'star']) {
        switchSamples.push(await page.evaluate(({ first, target }) => {
            const q = exploredQA;
            const focus = target === 'star' ? `star:${first.starIndex}` : target === 'planet' ?
                q.p.planetFocusValue(first.planetIndex, first.starId) : q.p.planetMoonFocusValue(first.planetIndex, first.moonIndex, first.starId);
            const start = performance.now(); q.input.setFocus(focus); const cpuMs = performance.now() - start;
            return { target, cpuMs };
        }, { first, target }));
    }
    report.switchHandlerCPU = { scope: 'Synchronous production setFocus handler only; each call is a separate browser task, with no render/GPU finish included',
        samples: switchSamples, maximumMs: Math.max(...switchSamples.map(s => s.cpuMs)), thresholdMs: 50 };
    check('Warmed same-host target switch handler never creates a 50ms long task', report.switchHandlerCPU.maximumMs < 50, report.switchHandlerCPU.maximumMs, true);
    await frames(2);
    await capture('06-twenty-routes-returned');
    const resourceSamples = [...report.routes, ...report.repeatedRoutes].flatMap(r => Object.values(r.states).map(s => s.render));
    report.resourceBounds = {
        samples: resourceSamples.length, first: resourceSamples[0], last: resourceSamples.at(-1),
        maximum: Object.fromEntries(['geometries', 'materials', 'textures'].map(key => [key, Math.max(...resourceSamples.map(r => r.resources[key]))])),
        gpuMaximum: Object.fromEntries(['geometries', 'textures', 'programs'].map(key => [key, Math.max(...resourceSamples.map(r => r.gpu[key]))])),
    };
    check('Whole scene material/object counts stay bounded across routes', resourceSamples.every(r =>
        r.scene.materials <= resourceSamples[0].scene.materials + 8 && r.scene.objects <= resourceSamples[0].scene.objects + 16));
    // WebGL uploads are lazy: first-frame GPU counts exclude most of the
    // already allocated fixed pool. Bound later uploads by that actual pool,
    // and use the separately warmed repeat checks to reject continued growth.
    const poolGeometryCapacity = Math.max(...resourceSamples.map(r => r.resources.geometries));
    report.resourceBounds.poolGeometryCapacity = poolGeometryCapacity;
    check('GPU geometry and texture counts stay within fixed system capacity', resourceSamples.every(r =>
        r.gpu.geometries <= resourceSamples[0].gpu.geometries + poolGeometryCapacity && r.gpu.textures <= resourceSamples[0].gpu.textures + 136));

    if (!baseline) {
        await phase('reload-and-migration');
        const fixture = initial.fixtures.at(-1);
        await page.evaluate(fixture => { const q = exploredQA; q.input.setFocus(q.p.planetMoonFocusValue(fixture.planetIndex, fixture.moonIndex, fixture.starId)); }, fixture);
        await frames(3); await key('KeyK');
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('artemis.quicksave.v1')));
        report.longTasksBeforeReload = await page.evaluate(() => __qaLongTasks);
        await page.reload({ waitUntil: 'domcontentloaded' }); await initialize();
        await key('KeyL'); await page.waitForFunction(value => __G.focus === value, saved.g.focus); await frames(3);
        report.reloaded = await snapshot(fixture); assertOwner('Fresh page quickload', report.reloaded, fixture);
        await capture('07-fresh-page-child-restore');
        const legacy = structuredClone(saved); delete legacy.exploredSystem; legacy.g.focus = 'planet:0';
        await page.evaluate(async legacy => { localStorage.setItem('artemis.quicksave.v1', JSON.stringify(legacy)); await exploredQA.saves.loadState(); }, legacy);
        await frames(); check('Legacy unqualified save returns safely to Earth', await page.evaluate(() => __G.focus === 'earth'));
        const missing = structuredClone(saved); missing.g.focus = 'system:cat%3AMISSING-QA-HOST:planet:0'; missing.exploredSystem = null;
        await page.evaluate(async missing => { localStorage.setItem('artemis.quicksave.v1', JSON.stringify(missing)); await exploredQA.saves.loadState(); }, missing);
        await frames(); check('Missing host save returns safely to Earth', await page.evaluate(() => __G.focus === 'earth'));

        // Actual HYG row 87 is outside the Earth ship's local active catalog.
        // This uses the production loader and frame; no star visual is injected.
        await phase('hyg-real-host-retention');
        const hyg = await page.evaluate(async () => {
            const q = exploredQA, catalog = await import('/src/universe/hygActiveCatalog.js');
            await catalog.ensureHygCatalogLoaded(); q.input.setFocus('hyg:87');
            const system = q.a.getCachedFocusedSystem();
            if (!system?.planets.length) throw new Error('Real TAU PHE fixture must have a generated planet');
            return { starId: system.starId, hostName: system.hostStar.name, hygIndex: system.hostStar.hygIndex,
                childFocus: q.p.planetFocusValue(0, system), topologyHash: q.hash(system.planets) };
        });
        await frames(12);
        await focus(hyg.childFocus); await frames(3);
        await page.evaluate(() => {
            const q = exploredQA, { G } = q.state;
            q.a.refreshActiveStars(q.eph.eph.earthX + G.x, q.eph.eph.earthY + G.y, G.z, G.focus, G.t);
            const host = q.a.getCachedFocusedSystem().hostStar;
            const dx = q.s.cam.tgt.x - host.x * q.c.K, dy = q.s.cam.tgt.y - (host.z || 0) * q.c.K, dz = q.s.cam.tgt.z + host.y * q.c.K;
            const distance = Math.hypot(dx, dy, dz);
            q.s.cam.yaw = Math.atan2(dz, dx) + .17;
            q.s.cam.pitch = Math.max(-1.4, Math.min(1.4, Math.asin(dy / distance))); q.s.cam.distTarget = null;
        });
        await frames(12);
        const hygVisual = () => page.evaluate(async () => {
            const q = exploredQA, E = await import('/src/universe/exploredSystem.js'), host = E.getExploredHost();
            const surface = q.s.scene.getObjectByName('TAU PHE photosphere'), group = surface?.parent;
            const point = group?.children.find(child => child.isPoints);
            const curatedNames = new Set(q.c.STARS.map(star => star.name + ' photosphere')); let dynamicSurfaces = 0;
            q.s.scene.traverse(object => { if (object.name.endsWith(' photosphere') && !curatedNames.has(object.name)) dynamicSurfaces++; });
            return { focus: q.state.G.focus, starId: q.a.getCachedFocusedSystem()?.starId,
                retainedHygIndex: host?.hygIndex, hostName: host?.name,
                activeMember: q.a.ACTIVE_STARS.some(star => star.hygIndex === 87), gravityMember: q.a.GRAVITY_STARS.some(star => star.hygIndex === 87),
                photosphereInScene: !!surface && group?.parent === q.s.scene, photosphereVisible: !!surface?.visible,
                groupVisible: !!group?.visible, dynamicPoint: !!point && point.geometry.attributes.position.count === 1,
                dynamicSurfaces, topologyHash: q.hash(q.a.getCachedFocusedSystem()?.planets), ship: q.ship() };
        });
        const retained = await hygVisual();
        report.hyg = { fixture: hyg, retained, loadedThrough: 'ensureHygCatalogLoaded, real packaged HYG metadata/binary and index' };
        check('Real HYG host has validated locator in its child key', hyg.hygIndex === 87 && hyg.hostName === 'TAU PHE' && hyg.childFocus.includes(':host:hyg%3A87:'));
        check('HYG host leaves Earth-centred active stars', !retained.activeMember, retained);
        check('HYG visual retention does not add remote gravity', !retained.gravityMember, retained);
        check('Dropped HYG host retains production photosphere and dynamic point', retained.photosphereInScene && retained.groupVisible && retained.dynamicPoint, retained);
        check('Dynamic stellar surfaces remain within the existing 48 cap', retained.dynamicSurfaces <= 48, retained.dynamicSurfaces);
        assertPaused('HYG child retention', retained);
        await capture('08-hyg-retained-host-and-planet');
        await focus(`star:${first.starIndex}`); await frames(3); await focus(hyg.childFocus); await frames(12);
        report.hyg.revisited = await hygVisual();
        check('HYG child resolves after selecting another star', report.hyg.revisited.starId === hyg.starId && report.hyg.revisited.retainedHygIndex === 87 && report.hyg.revisited.topologyHash === hyg.topologyHash);
        await key('KeyK');
        const hygSave = await page.evaluate(() => JSON.parse(localStorage.getItem('artemis.quicksave.v1')));
        check('HYG child quicksave retains catalog locator', hygSave.exploredSystem?.hostFocus === 'hyg:87' && hygSave.g.focus === hyg.childFocus);
        report.longTasksBeforeReload.push(...await page.evaluate(() => __qaLongTasks));
        const binaryPattern = '**/hyg-stars-v41.bin*';
        let releaseBinary;
        const binaryGate = new Promise(resolve => { releaseBinary = resolve; });
        await page.route(binaryPattern, async route => { await binaryGate; await route.continue(); });
        await page.reload({ waitUntil: 'domcontentloaded' }); await initialize(); await phase('hyg-delayed-quickload');
        const liveState = () => page.evaluate(async () => {
            const q = exploredQA;
            return { ship: q.ship(), focus: q.state.G.focus, world: JSON.stringify(q.state.WORLD), ephemeris: q.hash(q.eph.snapshotEphem()),
                seed: (await import('/src/universe/galaxy.js')).getSeed(), epoch: (await import('/src/epoch.js')).getEpochMs() };
        });
        const plans = await page.evaluate(async () => {
            const ap = await import('/src/autopilot.js'), rel = await import('/src/relTravel.js');
            ap.apTravelToFocus(() => {}); rel.relTravelToFocus(() => {});
            return { ap: ap.AP.mode, rel: rel.REL.active };
        });
        check('Actual AP and REL plans are active before quickload', plans.ap === 'travel' && plans.rel, plans);
        const beforeLoad = await liveState();
        const requestedBinary = page.waitForRequest(request => request.url().includes('hyg-stars-v41.bin'), { timeout: 30000 });
        try {
            await key('KeyL'); await requestedBinary; await frames(3);
            const duringLoad = await liveState();
            report.hyg.delayedPreflight = { before: beforeLoad, during: duringLoad };
            check('Delayed HYG binary leaves live G/world/seed/epoch/ephemeris unchanged', JSON.stringify(beforeLoad) === JSON.stringify(duringLoad));
        } finally { releaseBinary(); }
        await page.waitForFunction(async expected => {
            const E = await import('/src/universe/exploredSystem.js');
            return __G.focus === expected.childFocus && E.getExploredHost()?.hygIndex === 87 && exploredQA.a.getCachedFocusedSystem()?.starId === expected.starId;
        }, hyg);
        await page.unroute(binaryPattern); await frames(12);
        report.hyg.reloaded = await hygVisual();
        check('Cold-page HYG quickload restores the actual retained host and rendering', report.hyg.reloaded.retainedHygIndex === 87 && report.hyg.reloaded.photosphereInScene && report.hyg.reloaded.dynamicPoint && report.hyg.reloaded.topologyHash === hyg.topologyHash);
        check('HYG quickload cancels active AP and REL plans', await page.evaluate(async () => {
            const { AP } = await import('/src/autopilot.js'), { REL } = await import('/src/relTravel.js');
            return AP.mode === 'off' && !REL.active && REL.plan === null && REL.target === null;
        }));
        assertPaused('HYG fresh-page quickload', report.hyg.reloaded);
        await capture('09-hyg-fresh-page-restored');

        // A failed real binary fetch must be caught by the loader, with a
        // coherent restored save and safe Earth view rather than half a world.
        report.longTasksBeforeReload.push(...await page.evaluate(() => __qaLongTasks));
        await page.route(binaryPattern, route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'QA catalog unavailable' }));
        await page.reload({ waitUntil: 'domcontentloaded' }); await initialize(); await phase('hyg-failed-quickload');
        const failedLoad = await page.evaluate(async () => {
            const q = exploredQA, ok = await q.saves.loadState();
            return { ok, focus: q.state.G.focus, ship: q.ship(), seed: (await import('/src/universe/galaxy.js')).getSeed() };
        });
        await frames(3); await page.unroute(binaryPattern); report.hyg.unavailable = failedLoad;
        check('Unavailable HYG binary restores save with safe Earth focus', failedLoad.ok === true && failedLoad.focus === 'earth' && failedLoad.seed === hygSave.galaxySeed);
        assertPaused('Unavailable HYG quickload', failedLoad);
    }
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    const entries = [...(report.longTasksBeforeReload || []), ...await page.evaluate(() => __qaLongTasks)];
    delete report.longTasksBeforeReload;
    report.longTasks = { supported: await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes('longtask')), thresholdMs: 50,
        count: entries.length, totalMs: entries.reduce((n, entry) => n + entry.duration, 0), maximumMs: Math.max(0, ...entries.map(e => e.duration)),
        benchmark: entries.filter(e => e.phase.startsWith('benchmark:')),
        explorationRoutes: entries.filter(e => e.phase.startsWith('route:') || e.phase === 'same-host-repeated-routes'),
        switchHandlerTasks: entries.filter(e => e.phase === 'warmed-switch-handler-cpu'), entries };
    check('Long-task observer supported', report.longTasks.supported);
    check('No horizontal overflow on full application UI', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    check('No runtime or shader errors', report.errors.length === 0, report.errors);
    report.complete = report.routes.length === 20 && report.repeatedRoutes.length === 20;
    report.passed = report.complete && !report.errors.length && report.checks.every(c => c.pass || (baseline && c.candidateOnly));
    if (!report.passed) process.exitCode = 1;
} catch (error) {
    report.errors.push({ phase: report.phase || 'startup', message: error.stack || String(error) }); report.passed = false; process.exitCode = 1;
    console.error(error);
} finally {
    await save(); await browser?.close(); await server?.close();
}
