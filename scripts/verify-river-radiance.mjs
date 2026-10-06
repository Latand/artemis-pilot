// Read-only paired renderer diagnostic. Two production roots, six fixed views,
// twenty delivered frames per view. This is a transient, not equilibrium or a
// performance measurement. Only the candidate's owner display gain may differ.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { comparableRadianceFrame, differingFields, healthyRadianceFrame, healthyRadianceCapture } from './river-radiance-qa.mjs';
import { prepareContextRecoveryQA, contextLossSettled, contextRestoreSettled } from './context-recovery-qa.mjs';
import { RADIANCE_LIFECYCLE_FRAMES, radianceLifecycleStep, sameCountActiveReplacement, healthyRadianceGain, healthyRadianceRecovery, signedRadianceAdvection, healthyRadianceMobileCadence } from './river-radiance-lifecycle.mjs';

const roots = process.argv.slice(2, 4).map(x => resolve(x));
assert.equal(roots.length, 2, 'Pass baseline and candidate roots');
const out = resolve(process.argv[4] || 'evidence/river-radiance');
const fixture = JSON.parse(await readFile(new URL('./fixtures/river-radiance-proxima.json', import.meta.url), 'utf8'));
const mobile = process.env.DEVICE === 'mobile', suite = process.env.RADIANCE_SUITE || 'transient';
assert(['transient', 'lifecycle'].includes(suite));
const viewport = mobile ? { width: 430, height: 932 } : { width: 900, height: 650 };
const cases = suite === 'lifecycle' ? [{ subject: 'proxima', rate: 0 }, { subject: 'black-hole', rate: 0 }] : [
  { subject: 'proxima', rate: 0 }, { subject: 'proxima', rate: 1e6 * 31557600 },
  { subject: 'sun', rate: 0 }, { subject: 'sun', rate: 3852 },
  { subject: 'black-hole', rate: 0 }, { subject: 'black-hole', rate: 3852 },
];
const report = { purpose: suite === 'lifecycle' ? 'Bounded 64-frame source/camera/advection/recovery lifecycle; no performance claim' : 'Owner-radiance paired transient; 20 frames per view; no equilibrium or performance claim',
  device: mobile ? 'mobile' : 'desktop', suite, viewport, cases: [], checks: [], errors: [],
  scope: 'Production device quality at DPR1 and full texture counts; physical clock paused; explicit signed visual advection. Native adaptive compute policy remains active.' };
await mkdir(out, { recursive: true });
const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
const check = (name, pass, details) => report.checks.push({ name, pass: !!pass, ...(details ? { details } : {}) });
const hash = value => createHash('sha256').update(value).digest('hex');

const readHook = `
window.__radianceRead=()=>{
 const texels=new Float32Array(TEXW*TEXW*4);renderer.readRenderTargetPixels(rtA,0,0,TEXW,TEXW,texels);
 const counts=new Array(uniformsShared.uSinkNB.value).fill(0),drawnCounts=counts.slice();let ambient=0,drawnAmbient=0,invalidOwners=0;
 const drawable=river.style===2?dots:lines,drawRange=drawable.geometry.drawRange;
 const drawnStart=Math.floor(drawRange.start/(river.style===2?1:IPP));
 const drawnCount=Math.min(river.count,Math.floor(drawRange.count/(river.style===2?1:IPP)));
 for(let i=0;i<TEXW*TEXW;i++){const owner=Math.round(texels[i*4+3])-1,drawn=i>=drawnStart&&i<drawnStart+drawnCount;
  if(owner<0){ambient++;if(drawn)drawnAmbient++;}else if(owner<counts.length){counts[owner]++;if(drawn)drawnCounts[owner]++;}else invalidOwners++;}
 const bytes=new Uint8Array(texels.buffer);let raw='';for(let i=0;i<bytes.length;i+=32768)raw+=String.fromCharCode(...bytes.subarray(i,i+32768));
 const sources=bodyVals.slice(0,uniformsShared.uSinkNB.value).map((b,i)=>({index:i,
  name:i>=riverStarUniformOffset?(riverStarPickRefs[i-riverStarUniformOffset]?.id||riverStarPickRefs[i-riverStarUniformOffset]?.name):i>=3+PL.length?'placed-hole:'+String(i-3-PL.length):['Earth','Moon','Sun',...PL.map(p=>p.name)][i],
  position:[b.x+smoothCenter.x,b.y+smoothCenter.y,b.z+smoothCenter.z],residual:[b.x,b.y,b.z],coefficient:b.w,
  sink:sinkVals[i],soi:soiVals[i],hole:holeVals[i],rs:rsVals[i],color:colorVals[i].toArray(),owners:counts[i],drawnOwners:drawnCounts[i],
  activeSource:i>=riverStarUniformOffset,currentActive:i<riverStarUniformOffset||ACTIVE_STARS.includes(riverStarPickRefs[i-riverStarUniformOffset]),
  halo:uniformsShared.uHalo.value[i].toArray().slice(0,3),inkGain:uniformsShared.uHalo.value[i].w??1,
  cdfShare:uniformsShared.uHalo.value[i].z-(i?uniformsShared.uHalo.value[i-1].z:0)}));
 return {sources,ambient,drawnAmbient,drawnStart,drawnCount,drawVisible:drawable.visible,invalidOwners,finite:texels.every(Number.isFinite),readError:renderer.getContext().getError(),textureBase64:btoa(raw),
  count:river.count,drawCount:river.drawCount,frame:river.frame,computeEvery:river.computeEvery,skippedCompute:river.skippedCompute,
  dispatch:window.__radianceDispatch??null,dtVis:river.dtVis,center:smoothCenter.toArray(),radius:smoothR,
  textureCenter:textureCenter.toArray(),sourceRelative:river.sourceRelativeHalos,presentationGain:river.presentationGain??1,
  active:{revision:activeStarSetRevision(),ids:ACTIVE_STARS.map(s=>s.id||s.name)},
  gainState:typeof renderedOwnerShares==='undefined'?null:{ownerShares:Array.from(renderedOwnerShares),referenceShares:Array.from(renderedReferenceShares)},
  uniforms:{vRef:uniformsShared.uVRef.value,loadShed:uniformsShared.uLoadShed.value,planeBias:uniformsShared.uPlaneBias.value,
    de:uniformsShared.uDE.value,origin:uniformsShared.uOrigin.value.toArray(),centerShift:uniformsShared.uCenterShift.value.toArray(),
    localFocus:uniformsShared.uLocalFocus.value,timeRate:uniformsShared.uTimeRate.value,opacity:uniformsShared.uOpacity.value,
    phase:uniformsShared.uPhase.value,style:uniformsShared.uStyle.value,pixelRatio:uniformsShared.uPixelRatio.value,
    dtSim:uniformsShared.uDtSim.value,respawn:uniformsShared.uRespawn.value,tick:uniformsShared.uTick.value,
    frameVelocity:uniformsShared.uFrameVel.value.toArray(),frameWeight:uniformsShared.uFrameW.value}};
};`;

function transform(code, id) {
  id = id.split('?')[0];
  if (id.endsWith('/src/render/catalogStars.js')) return code.replace('const start = () => loadTier0();', 'const start = () => {};');
  if (id.endsWith('/src/river.js')) {
    const entry = /export function updateRiver\([^\n]+\) \{/;
    assert(entry.test(code), 'Known river entry');
    const dispatch = 'renderer.setRenderTarget(rtB);\n            renderer.render(computeScene, computeCam);';
    assert.equal(code.split(dispatch).length, 2, 'One compute dispatch');
    return code.replace(entry, m => m + '\nif(window.__radianceFixture){if(window.__radianceRefresh)window.__radianceRefresh();else ACTIVE_STARS.splice(0,ACTIVE_STARS.length,...window.__radianceFixture.sources);dtSim=window.__radianceFixture.advance;}')
      .replace(dispatch, 'window.__radianceDispatch={dt:uniformsShared.uDtSim.value,respawn:uniformsShared.uRespawn.value,tick:uniformsShared.uTick.value,frame:river.frame};' + dispatch)
      .replace('export function resetRiverContext() {', 'export function resetRiverContext() { window.__radianceResetCalls=(window.__radianceResetCalls||0)+1;') + readHook;
  }
  if (!id.endsWith('/src/main.js')) return;
  const first = 'const firstFrameT0 = perfStart();';
  assert.equal(code.split(first).length, 2); assert(code.includes('renderer.setAnimationLoop(frame);'));
  return code.replace(first, 'G.t=0;G.paused=true;G.dead=true;G.observerMode=true;G.gr=true;G.warp=1;grB=1;resetEphem();clock.getDelta=()=>1/60;' + first)
    .replace('renderer.setAnimationLoop(frame);', '// Diagnostic delivers frames explicitly')
    .replaceAll('    finishFramePerf(frameT0,', '    window.__radianceCompleted=(window.__radianceCompleted||0)+1;\n    finishFramePerf(frameT0,')
    + '\nwindow.__radianceFrame=()=>{window.__radianceDispatch=null;clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;grB=1;frame();if(!renderer.getContext().isContextLost())renderer.getContext().finish();};';
}

const validate = process.argv.includes('--validate');
let browser;
try {
  if (!validate) browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (let ri = 0; ri < roots.length; ri++) {
    const root = roots[ri], revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    for (const path of ['src/main.js', 'src/river.js', 'src/render/catalogStars.js']) {
      execFileSync(process.execPath, ['--input-type=module', '--check'], { input: transform(await readFile(resolve(root, path), 'utf8'), '/' + path) });
    }
    const riverSource = await readFile(resolve(root, 'src/river.js'), 'utf8');
    const compute = riverSource.match(/const COMPUTE_FRAG = \/\* glsl \*\/`([\s\S]*?)`;/)?.[1];
    assert(compute, 'Compute shader present');
    if (validate) { console.log({ revision, hooks: 'valid', computeHash: hash(compute) }); continue; }
    const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'paired-radiance', enforce: 'pre', transform }] });
    await server.listen();
    try {
      for (const spec of cases) {
        const name = `${ri ? 'candidate' : 'baseline'}-${spec.subject}-${spec.rate ? 'high-rate' : 'paused'}`;
        const page = await browser.newPage({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile }); page.setDefaultTimeout(120000);
        page.on('pageerror', e => report.errors.push({ name, error: e.stack || e.message }));
        page.on('console', m => { if (m.type() === 'error' && /shader|THREE|GL_INVALID|WebGL/i.test(m.text())) report.errors.push({ name, error: m.text() }); });
        await page.addInitScript(() => { Date.now = () => Date.UTC(2026, 9, 3, 12); localStorage.clear(); localStorage.setItem('ap_introSeen', '1'); localStorage.setItem('ap_uiMode', 'observe'); });
        await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, body: '' }));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?quality=high&focus=sun&dist=40000&dpr=1&tier1=0&field=0&galaxy=0&galaxyvol=0&galaxies=0&realsky=0&river=1&bloom=0&compile=0&hidehelp=1`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__AP_READY && window.__radianceFrame && window.__radianceRead);
        await page.evaluate(async ({ fixture, spec, suite }) => {
          const [s, c, state, bh, bodies, active, hyg] = await Promise.all([import('/src/scene.js'), import('/src/constants.js'), import('/src/state.js'), import('/src/blackholes.js'), import('/src/bodies.js'), import('/src/universe/activeStars.js'), import('/src/universe/hygActiveCatalog.js')]);
          window.radianceQA = { s, c, state, bh, bodies, active, subject: spec.subject, selectedName: spec.subject === 'proxima' ? 'PROXIMA' : spec.subject === 'sun' ? 'Sun' : 'placed-hole:0', observerPc: 8 };
          window.__radianceFixture = { sources: spec.subject === 'proxima' ? fixture.sources : [], advance: spec.rate / 60 };
          state.setSimTime(spec.subject === 'proxima' && suite === 'transient' ? fixture.time : 0);
          Object.assign(state.G, { paused: true, dead: true, observerMode: true, landed: null, gr: true, focus: spec.subject === 'proxima' ? 'star:0' : 'free', warp: spec.rate || 1 });
          bh.clearBlackHoles();
          s.cam.distTarget = null;
          if (spec.subject === 'proxima') {
            if (suite === 'transient') for (const record of fixture.curated) { const star = c.STARS.find(star => star.name === record.name); if (star) Object.assign(star, { x: record.x, y: record.y, z: record.z }); }
            const host = (suite === 'transient' ? fixture.sources : c.STARS).find(star => star.name === 'PROXIMA');
            s.cam.dist = fixture.distLy * c.LY_SCENE; s.cam.yaw = fixture.yaw; s.cam.pitch = fixture.pitch;
            s.cam.tgt.set(host.x * c.K, host.z * c.K, -host.y * c.K);
          } else if (spec.subject === 'sun') {
            s.cam.dist = 40000; s.cam.yaw = Math.PI / 2; s.cam.pitch = 0;
            s.cam.tgt.copy(bodies.sunCore.position).add({ x: 22000, y: 0, z: 180000 });
          } else {
            bh.addBlackHole(200000, 0, 30, 1, 2, true, null, 0, 0, 300000, 3);
            s.cam.dist = 40; s.cam.yaw = Math.PI / 2; s.cam.pitch = 0;
            s.cam.tgt.set(bodies.earthG.position.x + state.BH.sx[0], state.BH.sy[0], bodies.earthG.position.z + state.BH.sz[0]);
          }
          if (suite === 'lifecycle') {
            state.setSimTime(0); state.G.focus = 'free';
            await hyg.ensureHygCatalogLoaded();
            window.__radianceRefresh = () => active.refreshActiveStars(window.radianceQA.observerPc * c.PC_KM, 0, 0, -1, 0, 0);
            window.__radianceRefresh();
          }
        }, { fixture, spec, suite });
        if (suite === 'lifecycle') await prepareContextRecoveryQA(page);
        const row = { name, revision, spec, computeHash: hash(compute), frames: [], recoveries: [] }; report.cases.push(row);
        for (let i = 0; i < (suite === 'lifecycle' ? RADIANCE_LIFECYCLE_FRAMES : 20); i++) {
          const plan = suite === 'lifecycle' ? radianceLifecycleStep(i, spec.subject) : null;
          if (plan?.reset) {
            const snapshot = () => page.evaluate(() => {
              const q = window.radianceQA, context = q.s.renderContext;
              return { time:q.state.G.t,paused:q.state.G.paused,completed:window.__radianceCompleted||0,
                contextLost:q.s.renderer.getContext().isContextLost(),lifecycleLost:context.isLost(),
                losses:context.losses,restores:context.restores,resetCalls:window.__radianceResetCalls||0,
                defaultTarget:q.s.renderer.getRenderTarget()===null };
            });
            const before = await snapshot();
            await page.evaluate(() => { const gl = radianceQA.s.renderer.getContext(); window.__radianceLoss = gl.getExtension('WEBGL_lose_context'); if(!window.__radianceLoss)throw Error('WEBGL_lose_context unavailable');window.__radianceLoss.loseContext(); });
            await page.waitForFunction(contextLossSettled);
            await page.evaluate(() => window.__radianceFrame());
            const held = await snapshot();
            await page.evaluate(() => window.__radianceLoss.restoreContext());
            await page.waitForFunction(contextRestoreSettled);
            row.recoveries.push({ index:i,before,held,restored:await snapshot() });
          }
          const capture = plan ? plan.capture : i === 19;
          const sample = await page.evaluate(({ index, capture, plan }) => {
            const q = window.radianceQA;
            if (plan) {
              q.observerPc = plan.observerPc; window.__radianceFixture.advance = plan.rate / 60;
              q.state.G.warp = Math.abs(plan.rate) || 1; q.state.G.focus = 'free';
              if (q.subject === 'proxima') {
                q.selectedName = plan.hostName;
                const host = q.c.STARS.find(star => star.name === plan.hostName);
                q.s.cam.tgt.set(host.x*q.c.K,host.z*q.c.K,-host.y*q.c.K);
                if (plan.offscreen) q.s.cam.tgt.x += q.s.cam.dist * 10;
              }
            }
            // A small deterministic 3D move verifies source-relative offsets;
            // world time stays fixed to isolate sampling from orbital evolution.
            if (q.subject === 'black-hole') {
              q.state.BH.x[0] = 200000 + index * 1000; q.state.BH.sx[0] = q.state.BH.x[0] * q.c.K;
              q.state.BH.z[0] = 300000 + index * 2000; q.state.BH.sy[0] = q.state.BH.z[0] * q.c.K;
              q.s.cam.tgt.set(q.bodies.earthG.position.x + q.state.BH.sx[0], q.state.BH.sy[0], q.bodies.earthG.position.z + q.state.BH.sz[0]);
              if (plan?.offscreen) q.s.cam.tgt.x += q.s.cam.dist * 10;
            }
            window.__radianceFrame();
            const state = window.__radianceRead(), gl = q.s.renderer.getContext();
            const result = { ...state, time: q.state.G.t, completed:window.__radianceCompleted||0,resetCalls:window.__radianceResetCalls||0,
              selectedName:q.selectedName,camera: q.s.camera.position.toArray(), quaternion: q.s.camera.quaternion.toArray(), target: q.s.cam.tgt.toArray(),
              renderedSource: q.subject === 'black-hole' ? q.bh.BH_META[0].g.position.toArray() : q.subject === 'sun' ? q.bodies.sunCore.position.toArray() : null,
              width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, dpr: q.s.renderer.getPixelRatio(), mobile: q.s.renderQuality.mobile,
              contextLost: gl.isContextLost(), glError: gl.getError() };
            if (capture) {
              const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight, pixels = new Uint8Array(width * height * 4);
              gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
              let canvasLit = 0, canvasMin = 255, canvasMax = 0;
              for (let p = 0; p < pixels.length; p += 4) {
                if (pixels[p] + pixels[p + 1] + pixels[p + 2] > 30) canvasLit++;
                for (let c = 0; c < 3; c++) { canvasMin = Math.min(canvasMin, pixels[p + c]); canvasMax = Math.max(canvasMax, pixels[p + c]); }
              }
              const source = state.sources.find(source => source.name === q.selectedName);
              const projected = q.s.cam.tgt.clone().set(...source.position).project(q.s.camera);
              const cx = Math.round((projected.x + 1) * width / 2), cy = Math.round((1 - projected.y) * height / 2);
              const metrics = (x, y, radius) => { let lit = 0, saturated = 0, total = 0, luminance = 0;
                for (let py = Math.max(0, y - radius); py < Math.min(height, y + radius); py++) for (let px = Math.max(0, x - radius); px < Math.min(width, x + radius); px++) {
                  if ((px - x) ** 2 + (py - y) ** 2 >= radius ** 2) continue;
                  const j = ((height - 1 - py) * width + px) * 4, r = pixels[j], g = pixels[j + 1], b = pixels[j + 2];
                  total++; if (r + g + b > 30) lit++; if (r >= 245 && g >= 245 && b >= 245) saturated++; luminance += .2126 * r + .7152 * g + .0722 * b;
                } return { lit, saturated, total, luminance }; };
              result.pixel = { sourceName: source.name, center: [cx, cy], projected: projected.toArray(), canvasLit, canvasMin, canvasMax,
                rings: [25, 50, 100].map(radius => ({ radius, ...metrics(cx, cy, radius) })) };
              // Draw, framebuffer read and PNG copy occur in this same task.
              result.png = q.s.renderer.domElement.toDataURL('image/png'); result.glError = gl.getError();
            }
            return result;
          }, { index: i, capture, plan });
          const { textureBase64, png, ...state } = sample;
          state.textureHash = hash(Buffer.from(textureBase64, 'base64'));
          row.frames.push(state);
          check(`${name} frame ${i}: valid GPU owner accounting`, healthyRadianceFrame(state));
          if (plan) check(`${name} frame ${i}: dispatched advection respects requested sign`, signedRadianceAdvection(state,plan));
          if (ri) check(`${name} frame ${i}: gain follows rendered owner snapshot`, healthyRadianceGain(state, row.frames.at(-2)));
          if (plan?.reset) check(`${name}: native reset forces a healthy new compute`, healthyRadianceRecovery(row.recoveries.at(-1), state));
          if (capture) check(`${name}: nonblank capture with selected source on screen`, healthyRadianceCapture(state));
          const imageName = name + (plan ? `-${i}` : '');
          if (png) { await writeFile(resolve(out, imageName + '-canvas.png'), Buffer.from(png.split(',')[1], 'base64')); await page.screenshot({ path: resolve(out, imageName + '-ui.png') }); }
        }
        check(`${name}: full production device quality`, row.frames.every(frame => frame.count === (mobile ? 9216 : 15376) && frame.width === viewport.width && frame.height === viewport.height && frame.dpr === 1 && frame.mobile === mobile));
        if (suite === 'lifecycle') {
          check(`${name}: actual same-count middle replacement`, sameCountActiveReplacement(row.frames[7],row.frames[8]));
          if (spec.subject === 'proxima') {
            row.sourceReplacement = { before:row.frames[7].sources.map(s=>s.name),after:row.frames[8].sources.map(s=>s.name) };
            check(`${name}: real selected HYG source is replaced`,row.sourceReplacement.before.some(id=>id.startsWith('hyg:')&&!row.sourceReplacement.after.includes(id)),row.sourceReplacement);
            check(`${name}: selected source order changes`, JSON.stringify(row.frames[15].sources.map(s=>s.name)) !== JSON.stringify(row.frames[23].sources.map(s=>s.name)));
          }
          check(`${name}: paused, forward and reverse advection delivered`, row.frames.some(f=>f.dispatch?.dt>0)&&row.frames.some(f=>f.dispatch?.dt<0)&&row.frames.some(f=>f.dtVis===0));
          check(`${name}: camera eligibility changes source CDF`, JSON.stringify(row.frames[23].sources.map(s=>s.cdfShare)) !== JSON.stringify(row.frames[31].sources.map(s=>s.cdfShare)));
          if (mobile) check(`${name}: ${spec.subject === 'proxima' ? 'signed mobile skips hold texture and gain snapshots' : 'moving hole uses native urgent compute exemption'}`,
            healthyRadianceMobileCadence(row.frames, spec.subject), row.frames.map((frame, index) => ({ index, frame:frame.frame,
              computeEvery:frame.computeEvery, skipped:frame.skippedCompute, dtVis:frame.dtVis, dispatch:frame.dispatch })));
          check(`${name}: all retained sources refer to current active objects`,row.frames.every(f=>f.sources.filter(s=>s.activeSource).every(s=>s.currentActive)));
        }
        check(`${name}: selected source has owned samples`, row.frames.at(-1).sources.some(source => source.name === (spec.subject === 'proxima' ? 'PROXIMA' : spec.subject === 'sun' ? 'Sun' : 'placed-hole:0') && source.owners > 0));
        if (spec.subject !== 'proxima') check(`${name}: source and rendered body stay aligned`, row.frames.every(frame => {
          const source = frame.sources.find(source => source.name === (spec.subject === 'sun' ? 'Sun' : 'placed-hole:0'));
          return source.position.every((value, i) => Math.abs(value - frame.renderedSource[i]) < 1e-6);
        }));
        await save(); await page.close();
      }
    } finally { await server.close(); }
  }
  if (!validate) {
    for (const spec of cases) {
      const rows = report.cases.filter(row => JSON.stringify(row.spec) === JSON.stringify(spec)); assert.equal(rows.length, 2);
      const mismatches = rows[0].frames.flatMap((frame, i) => differingFields(comparableRadianceFrame(frame), comparableRadianceFrame(rows[1].frames[i])).map(field => ({ frame: i, field, baseline: comparableRadianceFrame(frame)[field], candidate: comparableRadianceFrame(rows[1].frames[i])[field] })));
      check(`${spec.subject} ${spec.rate}: field, camera, sources, cadence and raw GPU texture exactly match`, mismatches.length === 0, mismatches);
      check(`${spec.subject} ${spec.rate}: compute shader unchanged`, rows[0].computeHash === rows[1].computeHash);
    }
    check('No browser/shader errors', report.errors.length === 0);
    const { sourceSampleInkGain } = await import(new URL('./src/riverRadianceMath.js', 'file://' + roots[1] + '/'));
    // Explicit sparse-identity control for all three source classes. This is
    // a display-function control, not a claim that every live view is sparse.
    report.sparseControls = cases.filter(spec => spec.rate === 0).map(({ subject }) => ({ subject,
      samples: [1, 8, 32, 64, 127, 128].map(allocated => ({ allocated, reference: 0, gain: sourceSampleInkGain(allocated, 0) })) }));
    check('Sparse Proxima/Sun/BH sample budgets keep identity gain', report.sparseControls.every(control => control.samples.every(sample => sample.gain === 1)));
    await save(); assert(report.checks.every(check => check.pass), JSON.stringify(report.checks.filter(check => !check.pass)));
  }
} catch (error) { report.errors.push({ error: error.stack || String(error) }); await save(); throw error; }
finally { await browser?.close(); }
