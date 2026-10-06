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
