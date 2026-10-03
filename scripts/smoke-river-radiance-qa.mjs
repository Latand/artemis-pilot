import assert from 'node:assert/strict';
import { comparableRadianceFrame, differingFields, healthyRadianceFrame, healthyRadianceCapture } from './river-radiance-qa.mjs';
const original = { count: 10, ambient: 2, drawnAmbient: 1, drawnCount: 5, drawCount: 5, drawVisible: true, finite: true, contextLost: false, glError: 0,
  readError: 0, invalidOwners: 0, textureHash: 'raw-texture', sources: [{ owners: 8, drawnOwners: 4,
    position: [1, 2, 3], color: [.2, .3, .4], halo: [22, 1, 1], inkGain: 1 }],
  dispatch: { dt: 3, respawn: .1 }, uniforms: { vRef: .01, loadShed: 0 },
  computeEvery: 1, skippedCompute: false, pixel: { saturated: 200 } };
const changedGain = structuredClone(original); changedGain.sources[0].inkGain = .02;
changedGain.pixel.saturated = 1;
assert.deepEqual(comparableRadianceFrame(original), comparableRadianceFrame(changedGain));
for (const mutate of [x => x.textureHash = 'different', x => x.sources[0].position[0]++,
  x => x.sources[0].color[0]++, x => x.sources[0].halo[2] = .5,
  x => x.dispatch.dt++, x => x.dispatch.respawn++, x => x.computeEvery++,
  x => x.skippedCompute = true, x => x.uniforms.vRef++, x => x.uniforms.loadShed++]) {
  const altered = structuredClone(original); mutate(altered);
  assert(differingFields(comparableRadianceFrame(original), comparableRadianceFrame(altered)).length);
}
assert(healthyRadianceFrame(original));
for (const mutate of [x => x.contextLost = true, x => x.glError = 1280,
  x => x.readError = 1280, x => x.invalidOwners++, x => x.finite = false,
  x => x.ambient--, x => x.sources[0].owners--, x => x.sources[0].drawnOwners--,
  x => x.drawCount++, x => x.drawVisible = false]) {
  const altered = structuredClone(original); mutate(altered); assert(!healthyRadianceFrame(altered));
}
const capture = { width: 900, height: 650, pixel: { projected: [.1, -.2, .99], center: [495, 390],
  canvasLit: 300, canvasMin: 0, canvasMax: 255, rings: [{ total: 1941, lit: 100, saturated: 10, luminance: 8000 }] } };
assert(healthyRadianceCapture(capture));
for (const mutate of [x => x.width = 0, x => x.pixel.projected[0] = NaN,
  x => x.pixel.projected[0] = 1.01, x => x.pixel.projected[2] = -1.01,
  x => x.pixel.projected[2] = 1.01, x => x.pixel.center[0] = 900,
  x => x.pixel.center[1] = -1, x => x.pixel.canvasLit = 0,
  x => x.pixel.canvasMax = x.pixel.canvasMin, x => x.pixel.rings[0].total = 0,
  x => x.pixel.rings[0].luminance = NaN, x => x.pixel.rings[0].lit = 0]) {
  const altered = structuredClone(capture); mutate(altered); assert(!healthyRadianceCapture(altered));
}
console.log('Radiance diagnostic rejects state, cadence, texture, GPU accounting and blank/off-screen capture mismatches');
