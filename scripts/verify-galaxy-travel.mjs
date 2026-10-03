// Full production application and real controls; only frame delivery is
// deterministic (30 Hz). No mocked galaxy, stars, target selection or clock.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const out = resolve(process.argv[2] || 'evidence/galaxy-travel');
await mkdir(out, { recursive: true });
const report = { passed: false, errors: [], captures: [], cpuMs: [], frameSamples: [], limitations: ['Software WebGL timings are not hardware frame-rate certification. AT-HYG tiles disabled; all galaxy layers and the new provider remain enabled.'] };
const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{name:'travel-qa',enforce:'pre',transform(code,id){
    if (!id.endsWith('/src/main.js')) return;
    return code.replace('renderer.setAnimationLoop(frame);', '') + `\nwindow.__travelFrame=()=>{clock.getDelta=()=>1/30;lastMobileFrame=-Infinity;PERF.last=Object.create(null);const begin=performance.now();frame();const cpuMs=performance.now()-begin;const gl=renderer.getContext();gl.finish();const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return {cpuMs,totalMs:performance.now()-begin,stages:Object.fromEntries(Object.entries(PERF.last).map(([k,v])=>[k,v.ms]))};};`;
}}] });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1, recordVideo: { dir: out, size: {width:1100,height:760} } });
    const page = await context.newPage(); page.setDefaultTimeout(120000);
    page.on('pageerror', e => { report.errors.push(e.stack || e.message); console.error(e.message); });
    page.on('console', m => { if (m.type() === 'error' && /shader|webgl|THREE/i.test(m.text())) report.errors.push(m.text()); });
    await page.addInitScript(() => { localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','observe');localStorage.removeItem('ap_cam'); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?tier1=0&river=0&bloom=0&compile=0&hidehelp=1&dpr=1&perf=1`, {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => window.__AP_READY && window.__travelFrame);
    await page.evaluate(async () => {
        const [scene, state, field, active, systems, registry, P, THREE] = await Promise.all([
            import('/src/scene.js'), import('/src/state.js'), import('/src/render/foreignStarField.js'), import('/src/universe/activeStars.js'),
            import('/src/universe/exploredSystem.js'), import('/src/universe/galaxyRegistry.js'), import('/src/universe/planetarySystem.js'), import('/node_modules/three/build/three.module.js')]);
        window.qa={scene,state,field,active,systems,registry,P,THREE};
    });
    // Clicking noninteractive inspector text releases button focus through
    // the real UI, preserving accessible Space/Enter button activation.
    const releaseKeys = async () => page.locator('#exploreObject').click();
    const frames = async n => { for (let i=0;i<n;i++) {const sample=await page.evaluate(() => window.__travelFrame());report.cpuMs.push(sample.cpuMs);report.frameSamples.push(sample);} };
    const snapshot = async name => {
        const state = await page.evaluate(() => ({ focus: qa.state.G.focus, time: qa.state.G.t, ship:[qa.state.G.x,qa.state.G.y,qa.state.G.z],
            camera:qa.scene.camera.position.toArray(),anchor:qa.scene.cam.preciseTarget ? {origin:qa.scene.cam.preciseTarget.origin.toArray(),offset:qa.scene.cam.preciseTarget.offset.toArray()}:null,yaw:qa.scene.cam.yaw,pitch:qa.scene.cam.pitch,target:qa.scene.cam.tgt.toArray(),distance:qa.scene.cam.dist,goal:qa.scene.cam.distTarget,
            star:qa.systems.getExploredHost()?.id,system:qa.systems.getExploredSystem(qa.state.G.focus)?.starId,
            rows:qa.field.foreignCameraStars().length, overview:qa.state.G.cosmicOverview,
            points:qa.scene.scene.children.find(o=>o.name==='persistent Andromeda stars')?.geometry.drawRange.count,
            moonBeaconVisible:!!qa.scene.scene.children.find(o=>o.name==='Moon selection beacon')?.visible,
            visibleLabels:[...document.querySelectorAll('.lbl')].filter(el=>getComputedStyle(el).display!=='none'&&Number(getComputedStyle(el).opacity)>.01).map(el=>el.textContent),
            activeIds:qa.active.ACTIVE_STARS.filter(s=>s.galaxyId).map(s=>s.id) }));
        report.captures.push({name,...state});await page.screenshot({path:resolve(out,name+'.png')});await save();console.log(name,state.focus,state.distance,state.rows);return state;
    };
    await frames(3); await page.keyboard.press('Space'); await frames(2);
    const initial=await snapshot('01-departure');
    await page.locator('#exploreAndromeda').click();
    const launch=await page.evaluate(()=>({camera:qa.scene.camera.position.toArray(),focus:qa.state.G.focus}));
    assert.deepEqual(launch.camera,initial.camera,'Destination action never teleports the observer');
    const aimed=await page.evaluate(()=>({from:qa.scene.cam.dist,to:qa.scene.cam.distTarget}));
    await frames(1);
    const firstCamera=await page.evaluate(()=>qa.scene.camera.position.toArray());
    const displacement=Math.hypot(...firstCamera.map((v,i)=>v-initial.camera[i]));
    const expected=Math.abs(aimed.to-aimed.from)*4/30;
    assert(Math.abs(displacement-expected)<Math.max(8,expected*1e-10),'First rendered approach frame follows continuous production zoom, without a target snap');
    await frames(3);await snapshot('02-mw-exit');
    await frames(2);await snapshot('03-intergalactic');
    await page.locator('#exploreTravelStop').click();const stopped=await page.evaluate(()=>qa.scene.cam.dist);await frames(3);
    assert.equal(await page.evaluate(()=>qa.scene.cam.dist),stopped,'Stop cancels the ordinary approach controller');
    await page.locator('#exploreAndromeda').click();
    await frames(60);await snapshot('04-andromeda-entry');
    await frames(90);await snapshot('05-local-star-field');
    await page.locator('#exploreTravelStop').click();await frames(2);
    const manualBefore=await page.evaluate(()=>qa.field.foreignCameraStars().map(s=>s.id));
    await releaseKeys();await page.keyboard.down('w');await frames(3);await page.keyboard.up('w');await frames(2);
    const manual=await snapshot('05b-manual-free-camera');assert.equal(manual.focus,'free');
    const manualAfter=await page.evaluate(()=>qa.field.foreignCameraStars().map(s=>s.id));
    assert(manualAfter.some(id=>manualBefore.includes(id)),'Manual free flight uses the same persistent population');
    const candidate = await page.evaluate(() => {
        const {scene,field,THREE,P}=qa;
        const candidates=field.foreignCameraStars().map(star=>{const p=new THREE.Vector3(star.x*.001,star.z*.001,-star.y*.001).project(scene.camera);return {id:star.id,x:(p.x+1)*550,y:(1-p.y)*380,z:p.z,lum:star.lumSolar,planets:P.generateSystem(star).planets.length};})
            .filter(p=>p.x>410&&p.x<980&&p.y>160&&p.y<620&&p.z<1&&p.z>-1&&p.planets>0).sort((a,b)=>b.lum-a.lum);
        return candidates[0];
    });
    assert(candidate,'Arrival exposes selectable real provider points with planets');report.clickedStar=candidate;
    await page.mouse.click(candidate.x,candidate.y);await frames(3);
    const selected=await snapshot('06-selected-point');
    assert.equal(selected.star,candidate.id,'Click promotes the same visible identity');
    await frames(130);const surface=await snapshot('07-stellar-photosphere');
    assert.equal(surface.star,candidate.id);
    assert(!surface.visibleLabels.some(label=>/^(EARTH|MOON|MARS|NEPTUNE|GAIA BH[12])$/.test(label)),'Remote Solar/MW guide labels never masquerade as M31 local bodies');
    await page.locator('#exploreSystemPlanet').click();await frames(80);const planet=await snapshot('08-planet');
    assert(planet.focus.startsWith('system:'));assert.equal(planet.star,candidate.id);
    const preciseBefore=await page.evaluate(()=>qa.scene.cam.preciseTarget.offset.toArray());
    await releaseKeys();await page.keyboard.down('w');await frames(6);await page.keyboard.up('w');await frames(2);
    const planetFree=await snapshot('08b-planet-free-camera');assert.equal(planetFree.focus,'free');
    assert(planetFree.anchor&&Math.hypot(...planetFree.anchor.offset.map((v,i)=>v-preciseBefore[i]))>.01,'WASD moves a local residual at planet scale');
    await page.locator('#exploreSystemPlanet').click();await frames(60);
    await releaseKeys();await page.keyboard.press('k');await frames(2);
    await page.locator('#exploreMilkyWayReturn').click();await frames(30);const returned=await snapshot('09-return-milky-way');
    assert(returned.distance>1e10);assert.equal(returned.time,initial.time);
    assert.equal(returned.moonBeaconVisible,false,'A retained local Moon beacon cannot overlay the Milky Way return');
    await releaseKeys();await page.keyboard.press('l');await frames(6);const reload=await snapshot('10-reloaded-same-planet');
    assert.equal(reload.focus,planet.focus);assert.equal(reload.star,candidate.id);assert.equal(reload.time,initial.time);
    assert(!reload.visibleLabels.some(label=>/^(EARTH|MOON|MARS|NEPTUNE|GAIA BH[12])$/.test(label)));
    assert.deepEqual(reload.ship,initial.ship);assert.deepEqual(report.errors,[]);
    report.passed=true;report.transitionCpuMaximumMs=Math.max(...report.cpuMs.slice(5));report.absoluteTransitionTargetMs=50;report.absoluteTransitionTargetPass=report.frameSamples.slice(5).every(f=>f.totalMs<=50);await save();
    await context.close();
} catch(e) { report.failure=e.stack;await save();throw e; }
finally {await browser.close();await server.close();}
