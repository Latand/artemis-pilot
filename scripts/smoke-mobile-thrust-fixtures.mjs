import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { mobileThrustQualitySettings } from './mobile-thrust-fixtures.mjs';
const legacy = { mobile: true, dpr: 1, loadShed: 1, bloomScale: .5 };
const high = { ...legacy, loadShed: 0, mode: 'high', level: 0, effectiveLevel: 0, dprCap: 1.15, maxPixels: 4.2e6,
    riverDraw: 1, riverEvery: 1, galaxyScale: 1, lensSamples: 0, minimal: false,
    software: true, rendererName: 'SwiftShader', frameMs: 125, samples: 99, changes: 0, reason: 'manual' };
assert.deepEqual(mobileThrustQualitySettings(legacy), mobileThrustQualitySettings(high));
for (const [key, value] of Object.entries({ mode: 'auto', level: 3, effectiveLevel: 1, dprCap: .5,
    maxPixels: 3e5, riverDraw: .2, riverEvery: 4, galaxyScale: .2, lensSamples: 4, minimal: true, mobile: false, dpr: .5, loadShed: 1 })) {
    assert.throws(() => mobileThrustQualitySettings({ ...high, [key]: value }), undefined, `${key} cannot hide behind legacy compatibility`);
}
for (const [key, value] of Object.entries({ bloomScale: 1, futureBudget: 12 })) {
    assert.notDeepEqual(mobileThrustQualitySettings(high), mobileThrustQualitySettings({ ...high, [key]: value }));
}
assert.throws(() => mobileThrustQualitySettings({ ...legacy, loadShed: 0 }));
assert.throws(() => mobileThrustQualitySettings({ ...legacy, loadShed: 2 }));
assert.throws(() => mobileThrustQualitySettings({ ...high, loadShed: 2 }));
assert.equal(high.frameMs, 125, 'Raw telemetry is not mutated');
const timing = readFileSync(new URL('./benchmark-mobile-thrust.mjs', import.meta.url), 'utf8');
const mobile = readFileSync(new URL('./verify-mobile-thrust.mjs', import.meta.url), 'utf8');
assert(timing.includes('?quality=high&dpr=1&'));
assert(timing.includes('f.antialias===true&&f.bufferSamples===referenceBuffer.bufferSamples&&f.texW===96&&f.riverCount===96*96'));
assert(timing.includes('thrustWarmFrames:48,measuredFrames:48'));
assert(timing.includes("order:['base','head','head','base']"));
assert(timing.includes('means.head<=means.base*1.5+20'));
assert(timing.includes('coastMeans.head<=coastMeans.base*1.5+20'));
assert(timing.includes('for(let i=0;i<48;i++)coastFrames.push(await step())'));
assert(mobile.includes('for(let i=0;i<1200;i++)'));
assert(mobile.includes('timeout:180000'), 'Screenshot timeout is unchanged');
assert(mobile.includes('completed.after===completed.before+1'), 'Every soak iteration requires actual frame completion');
for (const field of ['riverCount:river.count', 'buffer:[gl.drawingBufferWidth,gl.drawingBufferHeight]', 'galaxyResolution:galaxy.res']) assert(timing.includes(field));
for (const script of [timing, mobile]) assert(script.includes('report.failure=error.stack||String(error)'), 'Raw failures survive in evidence');
// Execute the exact injected manual entry point. It must read back the canvas
// after each healthy draw, reuse storage, and avoid GL readback while lost.
const injected = mobile.match(/\+('(?:[^'\\]|\\.)*')/);
assert(injected, 'Manual frame transform string exists');
const hook = vm.runInNewContext(injected[1]);
const calls = [], pixels = [], gl = { lost: false, RGBA: 1, UNSIGNED_BYTE: 2,
    isContextLost() { return this.lost; }, getError() { return 0; },
    readPixels(...args) { calls.push('readback'); pixels.push(args.at(-1)); } };
const sandbox = { window: { __frameSuccess: 4 }, Uint8Array, performance: { now: () => 0 },
    renderer: { getContext: () => gl, getRenderTarget: () => null, setAnimationLoop() {} },
    lastMobileFrame: 0, frame: () => { calls.push('frame'); if (!gl.lost) sandbox.window.__frameSuccess++; } };
vm.runInNewContext(hook, sandbox);
for (let i = 0; i < 2; i++) {
    const result = sandbox.window.__thrustStep();
    assert.equal(result.after, result.before + 1); assert.equal(result.error, 0); assert(result.canvas);
}
assert.deepEqual(calls, ['frame', 'readback', 'frame', 'readback']); assert.equal(pixels[0], pixels[1]);
gl.lost = true; const lost = sandbox.window.__thrustStep();
assert(lost.contextLost); assert.equal(lost.after, lost.before); assert.equal(pixels.length, 2);
// Parse the exact benchmark transform against current and legacy startup shapes.
const transformBody = timing.slice(timing.indexOf("if(!id.split"), timing.indexOf('\n  }}]});'));
const transform = new Function('source', 'id', 'assert', transformBody);
const current = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
for (const source of [current, current.replace('const firstFrameT0 = perfStart();', 'const firstFrameT0 = perfStart();\nframe();')]) {
    const transformed = transform(source, '/src/main.js', assert);
    assert.equal(transformed.split('const firstFrameT0 = perfStart();\nframe();').length - 1, 1);
    assert(!transformed.includes('renderer.setAnimationLoop(frame);'));
    execFileSync(process.execPath, ['--check', '--input-type=module'], { input: transformed });
}
console.log('Mobile thrust fixtures: explicit verified High budgets, equal initial frame, completed manual GPU frames, raw evidence and all original limits retained.');

// Hosted recovery regression: restored frame 7 resumed flight without any
// additional delta-v, while the coast HUD was last written on frame 6.
// Exercise the production cadence and mobile mode formatter, not a made-up
// timer assumption, and keep physical release independent of the badge.
const { releasedMobileFlightIsSafe, restoredMobileHudAdvanced } = await import('./mobile-thrust-recovery-qa.mjs');
const held = { success: 6, hudFrame: 6, t: 12, dv: 6.916208611402841 };
const released = { ...held, success: 7, t: 14, contextLost: false, contextLifecycleLost: false,
    paused: false, dead: false, input: { keys: [], thrustMain: 0, thrustLat: 0, boost: false },
    drive: { magnitude: 0, engaged: false, ax: 0, ay: 0, az: 0 }, throttle: 'COAST', mode: 'HOLD' };
assert(releasedMobileFlightIsSafe(held, released), 'Stale mode alone does not imply physical thrust');
for (const delta of [{ dv: held.dv + 1e-9 }, { success: 6 }, { t: 12 }, { paused: true }, { dead: true },
    { contextLost: true }, { contextLifecycleLost: true }, { throttle: 'FIELD 68%' }, { input: undefined }, { drive: undefined }]) {
    assert.equal(releasedMobileFlightIsSafe(held, { ...released, ...delta }), false);
}
for (const delta of [{ keys: ['KeyW'] }, { thrustMain: 1 }, { thrustLat: 1 }, { boost: true }]) {
    assert.equal(releasedMobileFlightIsSafe(held, { ...released, input: { ...released.input, ...delta } }), false);
}
for (const delta of [{ magnitude: 1e-9 }, { engaged: true }, { ax: 1e-9 }, { ay: 1e-9 }, { az: 1e-9 }]) {
    assert.equal(releasedMobileFlightIsSafe(held, { ...released, drive: { ...released.drive, ...delta } }), false);
}
assert(releasedMobileFlightIsSafe(held, { ...released, drive: null }), 'Known pre-field baseline has no field actuator');
const cadence = current.slice(current.indexOf('function hudCadence('), current.indexOf('function nearLabelCadence('));
const mobileSource = readFileSync(new URL('../src/mobileControls.js', import.meta.url), 'utf8');
const formatter = mobileSource.slice(mobileSource.indexOf('export function updateMobileControls('), mobileSource.indexOf('export function initMobileControls(')).replace('export ', '');
const hudSandbox = { G: { warp: 60, t: 14, paused: false, dead: false, landed: null }, renderQuality: { mobile: true },
    ui: {}, mMet: {}, mVel: {}, mAlt: {}, mFocus: {}, mWarp: {}, mWarpVal: {}, mMode: { textContent: 'HOLD' },
    setText: (el, value) => { el.textContent = value; }, setClass: () => {}, fmtMET: () => '', fmtDist: () => '',
    focusName: () => 'SHIP', warpLabel: () => '', syncMobileButtons: () => {},
    window: { __frameSuccess: 7, __mobileHudFrame: 6 } };
vm.createContext(hudSandbox); vm.runInContext(cadence + formatter, hudSandbox);
const hudPoll = vm.runInContext(`(${restoredMobileHudAdvanced.toString()})`, hudSandbox);
assert.equal(typeof hudPoll(held), 'boolean'); assert.equal(hudPoll(held), false);
const every = vm.runInContext('hudCadence(false, 0)', hudSandbox); assert.equal(every, 2);
for (const frameNo of [7, 8]) {
    if (frameNo % every === 0) {
        vm.runInContext('updateMobileControls({r: 10, R: 1}, 7.74, 0)', hudSandbox);
        hudSandbox.window.__mobileHudFrame = frameNo;
    }
    hudSandbox.window.__frameSuccess = frameNo;
    assert.equal(hudSandbox.mMode.textContent, frameNo === 7 ? 'HOLD' : 'COAST');
    assert.equal(hudPoll(held), frameNo === 8);
}
hudSandbox.window.__frameSuccess = held.success;
assert.equal(hudPoll(held), false, 'A HUD write without a successfully submitted restored frame is insufficient');
assert(mobile.includes('await page.waitForTimeout(2200);'), 'Original first recovery observation remains');
assert(mobile.includes('const recoveryDeadline=Date.now()+180000;'));
assert(mobile.includes('timeout:Math.max(1,recoveryDeadline-Date.now())'), 'HUD observation shares, never extends, restoration readiness deadline');
assert(mobile.indexOf('releasedMobileFlightIsSafe(held,restored)') < mobile.indexOf('page.waitForFunction(restoredMobileHudAdvanced'), 'Do not wait away a physical release failure');
assert(mobile.includes("restoredHud.mode==='COAST'"), 'Keep the independent production badge assertion');
console.log('Mobile recovery: actual odd/even HUD cadence reproduces stale HOLD; physical-release failures remain immediate and readiness deadline is shared.');
