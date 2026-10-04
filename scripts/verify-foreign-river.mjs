// Bounded real-provider integration, not a travel/performance benchmark.
// Never substitutes ACTIVE_STARS, source positions, river dtSim or GPU output.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { FOREIGN_RIVER_HOST, healthyForeignFrame, foreignMovementPreserved, residualTolerance, sameForeignSystem, healthyForeignAdvection, collectForeignBodyDraw, foreignSourceEligibility, openForeignReturnControls } from './foreign-river-qa.mjs';
import { healthyRadianceGain, healthyRadianceRecovery } from './river-radiance-lifecycle.mjs';
import { prepareContextRecoveryQA, contextLossSettled, contextRestoreSettled } from './context-recovery-qa.mjs';

const root = resolve(process.argv[2] || '.'), out = resolve(process.argv[3] || 'evidence/foreign-river');
const mobile = process.env.DEVICE === 'mobile', viewport = mobile ? { width: 430, height: 932 } : { width: 1100, height: 760 };
const validate = process.argv.includes('--validate');
const report = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  device: mobile ? 'mobile' : 'desktop', viewport, host: FOREIGN_RIVER_HOST, passed: false, frames: [], captures: [], checks: [], errors: [],
  purpose: 'Real foreign host/source precision through star, planet, free movement, signed epochs, return, quickload and native GPU recovery',
  limitations: ['Fixed starting inspection pose; continuous navigation is tested by the separate real-control route.',
    'AT-HYG network tiles, distant resolved field, galaxy volume/population and real-sky backdrop omitted from this focused integration test.',
    'Normal river texture/draw/compute policy and real provider/clock remain enabled. No performance or physical-device claim.',
    'Foreign planets retain the existing host-source field; this does not add planet wells or mutual stellar gravity.',
    'Ship stays in the Milky Way; warp visibility distance outside this observer path is not certified.'] };
const save = () => {
  const path = resolve(out, 'report.json');
  writeFileSync(path + '.tmp', JSON.stringify(report, null, 2) + '\n');
  renameSync(path + '.tmp', path);
};
const check = (name, pass, details) => { report.checks.push({ name, pass: !!pass, details }); assert(pass, name + ': ' + JSON.stringify(details)); };
const sha = value => createHash('sha256').update(value).digest('hex');
const radianceSource = await readFile(new URL('./verify-river-radiance.mjs', import.meta.url), 'utf8');
const match = radianceSource.match(/const readHook = `([\s\S]*?)`;\n\nfunction transform/);
assert(match, 'Reuse the reviewed complete-texel radiance readback hook');
const readHook = match[1].replaceAll('__radianceRead', '__foreignRiverBaseRead').replaceAll('__radianceDispatch', '__foreignDispatch');
function once(source, token, replacement) { assert.equal(source.split(token).length, 2, 'Fixture hook changed: ' + token); return source.replace(token, replacement); }

function transform(source, id) {
  id = id.replaceAll('\\', '/').split('?')[0];
  if (id.endsWith('/src/stars.js')) return once(source, 'photosphere.name = star.name + " photosphere";', `photosphere.name = star.name + " photosphere";
        const previousPhotoAfterRender=photosphere.onAfterRender;
        photosphere.onAfterRender=function(renderer,scene,camera,geometry,material,group){
            previousPhotoAfterRender?.call(this,renderer,scene,camera,geometry,material,group);
            window.__foreignRecordBody?.(star.id,this,renderer,camera,geometry,material,group);
        };`);
  if (id.endsWith('/src/render/systemBodies.js')) return source + `\nexport function foreignRiverSystemState(){return {starId:renderedStarId,hostId:renderedSystem?.hostStar?.id,planets:renderedSystem?.planets,slots:groups.filter(slot=>slot.planet).map(slot=>slot.planet)};}\n`;
  if (id.endsWith('/src/river.js')) {
    const dispatch = 'renderer.setRenderTarget(rtB);\n            renderer.render(computeScene, computeCam);';
    source = once(source, dispatch, 'window.__foreignDispatch={dt:uniformsShared.uDtSim.value,respawn:uniformsShared.uRespawn.value,tick:uniformsShared.uTick.value,frame:river.frame};' + dispatch);
    source = once(source, 'export function resetRiverContext() {', 'export function resetRiverContext() { window.__foreignResetCalls=(window.__foreignResetCalls||0)+1;');
    return source + readHook + `
window.__foreignRiverRead=()=>{
 const state=__foreignRiverBaseRead(),gl=renderer.getContext(),drawable=river.style===2?dots:lines;
 for(const s of state.sources)if(s.activeSource){const i=s.index-riverStarUniformOffset,star=riverStarPickRefs[i];
  s.world=[star.x*K,(star.z||0)*K,-star.y*K];s.field=[flowCtx.starX[i],flowCtx.starY[i],flowCtx.starZ[i]];s.sourceTime=star._foreignT??star._posSimT;
  s.provider={mu:star.mu,R:star.R,rs:star.rs,bh:!!star.bh};s.fieldCoefficient=flowCtx.starC[i];s.fieldSink=flowCtx.starSink[i];}
 const orbit=camera.userData.preciseOrbit,anchor=camera.userData.systemAnchor;
 const expected=anchor&&orbit&&orbit.worldPosition.equals(camera.position)
  ?anchor.origin.clone().sub(smoothCenter).add(anchor.offset).add(orbit.offset):camera.position.clone().sub(smoothCenter);
 const expectedView=expected.clone().negate().applyQuaternion(camera.quaternion.clone().invert());
 const program=renderer.properties.get(drawable.material).currentProgram?.program;
 const value=name=>{const location=program&&gl.getUniformLocation(program,name);return location?gl.getUniform(program,location):null;};
 const uniform=name=>{const result=value(name);return result===null?null:Array.from(result);};
 for(const s of state.sources)if(s.activeSource){s.gpuCoefficient=uniform('uBody['+s.index+']')?.[3];s.gpuSink=value('uSink['+s.index+']');}
 const model=uniform('modelViewMatrix');
 return {...state,sourceView:{quaternion:camera.quaternion.toArray(),fov:camera.fov,aspect:camera.aspect,nearTierLimit:TIER_SPLIT_UNITS},
  precision:{expectedCamera:expected.toArray(),expectedTranslation:expectedView.toArray(),cameraUniform:uniformsShared.uCam.value.toArray(),
  modelViewTranslation:drawable.modelViewMatrix.elements.slice(12,15),gpuCamera:uniform('uCam')||[],gpuTranslation:model?.slice(12,15)||[],
  arithmeticScale:anchor?[...anchor.origin.clone().sub(smoothCenter).toArray(),...anchor.offset.toArray(),...orbit.offset.toArray()]:expected.toArray()},
  contextLost:gl.isContextLost(),glError:gl.getError()};
};`;
  }
  if (!id.endsWith('/src/main.js')) return null;
  source = once(source, 'renderer.setAnimationLoop(frame);', '// QA delivers bounded real application frames');
  assert(source.includes('    finishFramePerf(frameT0,'));
  source = source.replaceAll('    finishFramePerf(frameT0,', '    window.__foreignCompleted=(window.__foreignCompleted||0)+1;\n    finishFramePerf(frameT0,');
  return source + `
window.__foreignFrame=()=>{window.__foreignDispatch=null;window.__foreignDraws=Object.create(null);window.__foreignFrameOrdinal=(window.__foreignFrameOrdinal||0)+1;clock.getDelta=()=>1/30;lastMobileFrame=-Infinity;frame();};
window.__foreignRecoveryState=()=>({time:G.t,paused:G.paused,completed:window.__foreignCompleted||0,contextLost:renderer.getContext().isContextLost(),
 lifecycleLost:renderContext.isLost(),losses:renderContext.losses,restores:renderContext.restores,resetCalls:window.__foreignResetCalls||0,defaultTarget:renderer.getRenderTarget()===null});
`;
}

for (const path of ['src/main.js', 'src/river.js', 'src/stars.js', 'src/render/systemBodies.js']) execFileSync(process.execPath, ['--input-type=module', '--check'], {
  input: transform(await readFile(resolve(root, path), 'utf8'), '/' + path) });
if (validate) { console.log(JSON.stringify({ hooks: 'valid', revision: report.revision, browserRun: false })); process.exit(0); }
await mkdir(out, { recursive: true });
save();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  report.errors.push({ message: 'Interrupted by ' + signal + '; partial raw evidence retained' });
  report.passed = false; save(); process.exit(signal === 'SIGTERM' ? 143 : 130);
});
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'foreign-river-qa', enforce: 'pre', transform }] });
await server.listen();
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile }); page.setDefaultTimeout(120000);
  page.on('pageerror', e => report.errors.push(e.stack || e.message));
  page.on('console', m => { if (m.type() === 'error' && /shader|webgl|THREE/i.test(m.text())) report.errors.push(m.text()); });
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('ap_introSeen', '1'); localStorage.setItem('ap_uiMode', 'observe'); });
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, body: '' }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?tier1=0&field=0&galaxyvol=0&galaxies=0&realsky=0&river=1&bloom=0&compile=0&hidehelp=1&dpr=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__AP_READY && window.__foreignFrame && window.__foreignRiverRead);
  await page.evaluate(async ({ hostId, collector }) => {
    const [scene, state, active, systems, P, input, C, systemRender] = await Promise.all([
      import('/src/scene.js'), import('/src/state.js'), import('/src/universe/activeStars.js'), import('/src/universe/exploredSystem.js'),
      import('/src/universe/planetarySystem.js'), import('/src/input.js'), import('/src/constants.js'), import('/src/render/systemBodies.js')]);
    window.qa = { scene, state, active, systems, P, input, C, systemRender, hostId, bodyKind: 'star' };
    const collectDraw = (0, eval)('(' + collector + ')');
    window.__foreignRecordBody = (key, object, renderer, camera, geometry, material, group) => {
      const records = (window.__foreignDraws ||= Object.create(null))[key] ||= [];
      records.push(collectDraw(object, renderer, camera, geometry, material, group, window.__foreignFrameOrdinal));
    };
    const planetMesh = systemRender.systemBodyRenderState()[0].mesh, previousAfterRender = planetMesh.onAfterRender;
    planetMesh.onAfterRender = function(renderer, scene, camera, geometry, material, group) {
      previousAfterRender?.call(this, renderer, scene, camera, geometry, material, group);
      window.__foreignRecordBody('planet:0', this, renderer, camera, geometry, material, group);
    };
    state.setSimTime(0); Object.assign(state.G, { paused: true, dead: true, observerMode: true, landed: null, gr: true, warp: 1 });
    active.pinProceduralStarById(hostId, 0); input.setFocus('proc:' + hostId);
    const host = active.activeStarForFocus('proc:' + hostId); systems.getExploredSystem('proc:' + hostId, null, 0);
    scene.cam.dist = host.R * C.K * 4; scene.cam.distTarget = null; scene.cam.yaw = -.95; scene.cam.pitch = .46;
    scene.cam.tgt.set(host.x * C.K, host.z * C.K, -host.y * C.K);
  }, { hostId: FOREIGN_RIVER_HOST, collector: collectForeignBodyDraw.toString() });
  await prepareContextRecoveryQA(page);
  const sample = async (name, { capture = false, hidden = false, ownership = 'owned' } = {}) => {
    const frame = await page.evaluate(({ name, capture, hidden, ownership }) => {
      __foreignFrame(); const q = qa, s = q.scene, gl = s.renderer.getContext(); gl.finish();
      const state = __foreignRiverRead();
      const eye = s.camera.userData.systemAnchor;
      const host = q.systems.getExploredHost();
      const cached = q.active.getCachedFocusedSystem(), rendered = q.systemRender.foreignRiverSystemState();
      const body = q.bodyKind === 'star' ? s.scene.getObjectByName(host?.name + ' photosphere') : q.systemRender.systemBodyRenderState()[0]?.mesh;
      const draws = window.__foreignDraws?.[q.bodyKind === 'star' ? host?.id : 'planet:0'] || [], drawn = draws.at(-1);
      let bodyPrecision = null;
      if (!hidden && body && eye) {
        const own = body.userData.systemAnchor, orbit = s.camera.userData.preciseOrbit;
        const relative = own ? own.origin.clone().sub(eye.origin).add(own.offset).sub(eye.offset).sub(orbit.offset)
          : s.camera.position.clone().setFromMatrixPosition(body.matrixWorld).sub(eye.origin).sub(eye.offset).sub(orbit.offset);
        const expected = relative.clone().applyQuaternion(s.camera.quaternion.clone().invert());
        bodyPrecision = { visible: body.visible && body.parent.visible, expectedTranslation: expected.toArray(),
          drawnThisFrame: draws.some(draw => draw.submission.triangles > 0)
            && draws.every(draw => draw.frame === window.__foreignFrameOrdinal && draw.object === body.uuid), draws,
          modelViewTranslation: drawn?.modelViewTranslation || [], gpuTranslation: drawn?.gpuTranslation || [],
          arithmeticScale: [...relative.toArray(), ...eye.offset.toArray(), ...orbit.offset.toArray(), ...(own?.offset.toArray() || [])] };
      }
      const result = { ...state, name, hidden, ownershipExpectation: ownership, time: q.state.G.t, paused: q.state.G.paused, focus: q.state.G.focus,
        completed: window.__foreignCompleted || 0, host: host?.id, dead: q.state.G.dead, observerMode: q.state.G.observerMode,
        deathBannerVisible: getComputedStyle(document.getElementById('banner')).display !== 'none',
        system: { cachedStarId: cached?.starId, renderedStarId: rendered.starId, renderedHostId: rendered.hostId,
          cachedPlanets: JSON.stringify(cached?.planets), renderedPlanets: JSON.stringify(rendered.planets), slotPlanets: JSON.stringify(rendered.slots) },
        camera: s.camera.position.toArray(), anchor: eye ? { origin: eye.origin.toArray(), offset: eye.offset.toArray() } : null,
        cameraDistance: s.cam.dist, bodyPrecision, ship: [q.state.G.x, q.state.G.y, q.state.G.z],
        width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, dpr: s.renderer.getPixelRatio(), mobile: s.renderQuality.mobile };
      if (capture) {
        // Final render, GPU read and PNG copy share this single browser task.
        const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let lit = 0, min = 255, max = 0;
        for (let i = 0; i < pixels.length; i += 4) { const v = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]); if (v > 8) lit++; min = Math.min(min, v); max = Math.max(max, v); }
        result.pixels = { lit, min, max }; result.png = s.renderer.domElement.toDataURL('image/png');
        if (q.bodyKind === 'star' && bodyPrecision) {
          const [x, y, z] = bodyPrecision.expectedTranslation, scale = s.viewportSize.pxScale;
          const cx = gl.drawingBufferWidth / 2 + x / -z * scale, cy = gl.drawingBufferHeight / 2 - y / -z * scale;
          const radius = Math.max(5, Math.min(100, host.R * q.C.K / -z * scale * .35));
          let sourceLit = 0, total = 0;
          for (let py = Math.max(0, Math.floor(cy - radius)); py <= Math.min(gl.drawingBufferHeight - 1, Math.ceil(cy + radius)); py++)
            for (let px = Math.max(0, Math.floor(cx - radius)); px <= Math.min(gl.drawingBufferWidth - 1, Math.ceil(cx + radius)); px++) {
              if ((px - cx) ** 2 + (py - cy) ** 2 > radius ** 2) continue;
              const offset = ((gl.drawingBufferHeight - 1 - py) * gl.drawingBufferWidth + px) * 4;
              total++; if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 8) sourceLit++;
            }
          result.sourcePixels = { center: [cx, cy], radius, sourceLit, total };
        }
      }
      return result;
    }, { name, capture, hidden, ownership });
    const { textureBase64, png, ...record } = frame; record.textureHash = sha(Buffer.from(textureBase64, 'base64'));
    record.hostEligibility = foreignSourceEligibility(record, record.sources.find(source => source.name === FOREIGN_RIVER_HOST));
    report.frames.push(record);
    if (png) { await writeFile(resolve(out, name + '-canvas.png'), Buffer.from(png.split(',')[1], 'base64')); report.captures.push(name); }
    await save();
    check(name + ': native viewport and particle capacity', frame.width === viewport.width && frame.height === viewport.height && frame.dpr === 1 && frame.mobile === mobile && frame.count === (mobile ? 9216 : 15376));
    check(name + ': healthy finite GPU readback', !frame.contextLost && frame.glError === 0 && frame.readError === 0 && frame.finite && frame.invalidOwners === 0);
    if (hidden) check(name + ': cosmic flow is explicitly hidden', frame.drawVisible === false);
    else {
      check(name + ': finite owned sources and split CPU/GPU observer/body alignment', healthyForeignFrame(record, mobile), { precision: record.precision, bodyPrecision: record.bodyPrecision, sources: record.sources.filter(s => s.activeSource) });
      check(name + ': current radiance gain snapshot', healthyRadianceGain(record, report.frames.at(-2)));
      check(name + ': host identity survives real publication', frame.host === FOREIGN_RIVER_HOST);
      check(name + ': current cache, renderer and slots retain original system parameters', sameForeignSystem(record, report.frames[0]));
      check(name + ': foreign clock publication is current', record.sources.filter(s => s.name.startsWith('gx:')).every(s => s.sourceTime === record.time));
    }
    if (capture) check(name + ': nonblank synchronized pixels', frame.pixels.lit > 0 && frame.pixels.max > frame.pixels.min);
    if (capture && frame.sourcePixels) check(name + ': the actually drawn host has nonblank source-region pixels', frame.sourcePixels.sourceLit > 0 && frame.sourcePixels.total > 0, frame.sourcePixels);
    return record;
  };
  // Fixed preparatory frames are retained, not timed or retried until stable.
  for (let i = 0; i < 8; i++) await sample('host-' + i, { capture: i === 0 || i === 7 });
  const hostFrame = report.frames.at(-1);
  await page.evaluate(() => { const system = qa.active.getCachedFocusedSystem(); qa.bodyKind = 'planet'; qa.input.setFocus(qa.P.planetFocusValue(0, system)); qa.scene.cam.distTarget = null; qa.scene.cam.dist = system.planets[0].radiusKm * qa.C.K * 3; });
  // Preserve the failed 583370e pose: this view puts the host behind the
  // observer, so its complete halo is correctly excluded while gravity stays.
  const away = await sample('planet-away', { capture: true, ownership: 'excluded' });
  check('away-facing captured host is outside the halo support', away.hostEligibility.depthPlusReach < 0);
  // One declared inspection pose, aimed from the opposite side of the planet
  // toward both planet and host. This is fixture framing, never camera flight.
  await page.evaluate(() => {
    const offset = qa.scene.cam.preciseTarget.offset;
    qa.scene.cam.yaw = Math.atan2(offset.z, offset.x);
    qa.scene.cam.pitch = Math.asin(offset.y / offset.length());
  });
  // Production can defer paused ownership reassignment for at most its four
  // native cadence frames. Retain all four fixed deliveries and their state.
  for (let i = 0; i < 4; i++) {
    const row = await sample('planet-aim-' + i, { ownership: 'policy' });
    check('native foreign ownership cadence is bounded ' + i, row.computeEvery <= 4);
  }
  for (let i = 0; i < 8; i++) await sample('planet-' + i, { capture: i === 0 || i === 7 });
  const beforeFree = report.frames.at(-1);
  await page.locator('#exploreObject').click(); await page.keyboard.down('w');
  await sample('free-move-0'); const free = await sample('free-move-1', { capture: true }); await page.keyboard.up('w');
  check('real free movement retains nonzero split residual', free.focus === 'free' && free.anchor && Math.hypot(...free.anchor.offset.map((v, i) => v - beforeFree.anchor.offset[i])) > .01);
  check('river follows the same observer movement', foreignMovementPreserved(beforeFree, free));
  await page.keyboard.press('k'); const saved = await sample('saved-free-planet');
  // Real signed clock delivery, with selected planet following its actual host.
  await page.evaluate(() => { qa.input.setFocus(qa.P.planetFocusValue(0, qa.active.getCachedFocusedSystem())); qa.state.G.paused = false; qa.state.G.warp = 10 * qa.C.SEC_YEAR; });
  let previous = saved;
  for (const direction of [1, -1]) {
    const phase = [];
    await page.evaluate(direction => { qa.state.G.warp = direction * 10 * qa.C.SEC_YEAR; }, direction);
    for (let i = 0; i < 4; i++) { const row = await sample((direction > 0 ? 'forward-' : 'reverse-') + i, { capture: i === 3, ownership: 'policy' });
      phase.push(row); check('clock advances in requested direction ' + direction + ':' + i, (row.time - previous.time) * direction > 0); previous = row; }
    check('actual river advection has nonzero correct signed dispatch ' + direction, healthyForeignAdvection(phase, direction));
  }
  await page.evaluate(() => { qa.state.G.paused = true; });
  await openForeignReturnControls(page);
  await page.locator('#exploreMilkyWayReturn').click();
  await sample('return-0', { hidden: true }); await sample('return-1', { hidden: true, capture: true });
  await page.locator('#exploreObject').click(); await page.keyboard.press('l');
  const loaded = await sample('loaded-free-planet', { capture: true });
  check('quickload restores exact host/time/ship and split free camera', loaded.host === saved.host && loaded.time === saved.time && loaded.focus === saved.focus
    && JSON.stringify(loaded.ship) === JSON.stringify(saved.ship) && loaded.anchor.origin.every((v, i) => v === saved.anchor.origin[i])
    && loaded.anchor.offset.every((v, i) => Math.abs(v - saved.anchor.offset[i]) <= residualTolerance(saved.anchor.offset)));
  check('live system parameters survive every epoch and reload', sameForeignSystem(loaded, hostFrame));
  check('quickload retains the completed dead-ship observer transition without a death overlay', loaded.dead && loaded.observerMode && !loaded.deathBannerVisible);
  // Observe the original two-second delayed-entry boundary before context
  // recovery, keeping the real wall clock and camera state untouched.
  await page.waitForFunction(() => performance.now() - qa.state.G.deathRt >= 2100);
  const settledLoad = await sample('loaded-observer-settled', { capture: true });
  check('delayed observer entry cannot reset the loaded camera', settledLoad.focus === saved.focus && settledLoad.observerMode && !settledLoad.deathBannerVisible
    && JSON.stringify(settledLoad.anchor) === JSON.stringify(loaded.anchor));
  const recoveryState = () => page.evaluate(() => __foreignRecoveryState());
  const before = await recoveryState();
  await page.evaluate(() => { window.__foreignLoss = qa.scene.renderer.getContext().getExtension('WEBGL_lose_context'); if (!__foreignLoss) throw Error('GPU loss extension unavailable'); __foreignLoss.loseContext(); });
  await page.waitForFunction(contextLossSettled); await page.evaluate(() => __foreignFrame());
  const held = await recoveryState(); await page.evaluate(() => __foreignLoss.restoreContext()); await page.waitForFunction(contextRestoreSettled);
  const restored = await recoveryState(); report.recovery = { before, held, restored };
  const recovered = await sample('recovered-free-planet', { capture: true });
  check('native recovery holds time and resets the actual river', healthyRadianceRecovery(report.recovery, recovered), report.recovery);
  for (let i = 0; i < 4; i++) await sample('post-recovery-' + i, { capture: i === 3 });
  check('no browser or shader errors', report.errors.length === 0, report.errors);
  report.passed = true; await save();
} catch (error) { report.errors.push({ message: error.stack || String(error) }); await save(); throw error; }
finally { await browser.close(); await server.close(); }
