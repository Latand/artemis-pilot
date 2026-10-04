import { healthyRadianceFrame } from './river-radiance-qa.mjs';
import { Quaternion, Vector3 } from 'three';
import { haloViewWeight } from '../src/riverCoverageMath.js';
import { spawnReach } from '../src/riverMath.js';
import { K } from '../src/constants.js';

export const FOREIGN_RIVER_HOST = 'gx:m31:2654435769:1250:0:0:18';
// Compact Explore has two real disclosure levels. Use their visible controls
// in order; never force-click the hidden destination or mutate its DOM state.
export async function openForeignReturnControls(page) {
  if (await page.locator('#explorePanelBody').evaluate(element => element.hidden))
    await page.locator('#explorePanelToggle').click();
  if (!await page.locator('#exploreDestinations').evaluate(element => element.open))
    await page.locator('#exploreDestinations > summary').click();
  if (!await page.locator('#exploreMilkyWayReturn').isVisible()) throw new Error('Return control remains hidden after visible disclosure actions');
}
// Roundoff budgets come from operations on the retained local residuals. The
// intergalactic absolute position must never inflate the permitted error.
export const residualTolerance = values => 64 * Number.EPSILON * Math.max(1, ...values.map(Math.abs));
export const float32Tolerance = value => 4 * 2 ** (Math.floor(Math.log2(Math.max(Math.abs(value), 2 ** -126))) - 23);
const near = (a, b, tolerance) => a.length === b.length && a.every((v, i) => Number.isFinite(v) && Math.abs(v - b[i]) <= tolerance(b[i]));

// The real onAfterRender collector. That callback can run for an empty draw,
// so record the effective solid-triangle submission rather than inferring it.
// This function is also serialized into the browser without external bindings.
export function collectForeignBodyDraw(object, renderer, camera, geometry, material, group, frame) {
  const available = geometry.index?.count ?? geometry.attributes.position?.count ?? 0;
  const range = geometry.drawRange;
  const start = Math.max(0, range.start, group?.start ?? 0);
  const end = Math.min(available, range.start + range.count, group ? group.start + group.count : Infinity);
  const elements = Math.max(0, end - start);
  const instances = object.isInstancedMesh ? object.count : geometry.isInstancedBufferGeometry
    ? Math.min(geometry.instanceCount, geometry._maxInstanceCount ?? Infinity) : 1;
  const triangles = object.isMesh && !material.wireframe && material.visible !== false
    && Number.isSafeInteger(elements) && Number.isSafeInteger(instances) && instances > 0
    ? Math.floor(elements / 3) * instances : 0;
  const gl = renderer.getContext(), program = renderer.properties.get(material).currentProgram?.program;
  const location = program && gl.getUniformLocation(program, 'modelViewMatrix');
  const gpu = location ? Array.from(gl.getUniform(program, location)) : [];
  return { frame, object: object.uuid, near: camera.near, far: camera.far,
    submission: { indexed: !!geometry.index, available, start, end, elements, instances, triangles },
    modelViewTranslation: object.modelViewMatrix.elements.slice(12, 15), gpuTranslation: gpu.slice(12, 15) };
}

export function healthyForeignObserver(frame) {
  const p = frame.precision;
  if (!p || !p.expectedCamera.every(Number.isFinite) || !p.expectedTranslation.every(Number.isFinite)) return false;
  const tolerance = residualTolerance(p.arithmeticScale);
  return near(p.cameraUniform, p.expectedCamera, () => tolerance)
    && near(p.modelViewTranslation, p.expectedTranslation, () => tolerance)
    && near(p.gpuCamera, p.expectedCamera, value => tolerance + float32Tolerance(value))
    && near(p.gpuTranslation, p.expectedTranslation, value => tolerance + float32Tolerance(value));
}

export function foreignSourceEligibility(frame, source) {
  const view = frame.sourceView;
  if (!source || !view || !view.quaternion?.every(Number.isFinite) || !Number.isFinite(view.fov + view.aspect + view.nearTierLimit)
    || !source.halo?.every(Number.isFinite)) return null;
  const relative = new Vector3(...source.residual).sub(new Vector3(...frame.precision.expectedCamera));
  const distance = relative.length();
  relative.applyQuaternion(new Quaternion(...view.quaternion).invert());
  const core = source.hole ? Math.max(source.sink, Math.min(Math.max(frame.radius * .0008, .45), 64)) : source.sink;
  const reach = spawnReach(core, source.soi, source.halo[0]);
  const weight = source.coefficient > 0 ? haloViewWeight(relative.x, relative.y, -relative.z,
    distance, Math.hypot(...source.residual), reach, Math.tan(view.fov * Math.PI / 360), view.aspect, view.nearTierLimit) : 0;
  return { view: relative.toArray(), distance, reach, depthPlusReach: -relative.z + reach, weight };
}

export function healthyForeignSources(frame, hostId = FOREIGN_RIVER_HOST) {
  const stars = frame.sources.filter(source => source.activeSource);
  const host = stars.find(source => source.name === hostId);
  if (!host || stars.length > 24) return false;
  const eligibility = frame.sources.map(source => foreignSourceEligibility(frame, source));
  if (eligibility.some(value => !value || !Number.isFinite(value.weight))) return false;
  const weights = eligibility.map((value, i) => Math.sqrt(Math.max(0, frame.sources[i].coefficient)) * value.weight);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!frame.sources.every((source, i) => Math.abs(source.halo[1] - eligibility[i].weight) <= residualTolerance([eligibility[i].weight])
    && Math.abs(source.cdfShare - (total > 1e-6 ? weights[i] / total : 0)) <= residualTolerance([1]))) return false;
  const weight = eligibility[frame.sources.indexOf(host)].weight, share = frame.gainState?.ownerShares[host.index];
  if (!Number.isFinite(share) || share < 0) return false;
  // A skipped compute retains its previous ownership snapshot. The existing
  // gain check separately requires that snapshot to stay unchanged, or match
  // the current CDF after a dispatch. Never accept missing eligible owners.
  if (share > 0 ? host.owners <= 0 || host.drawnOwners <= 0 : host.owners !== 0 || host.drawnOwners !== 0) return false;
  if (frame.ownershipExpectation === 'owned' && !(weight > 0 && host.cdfShare > 0 && share > 0)) return false;
  if (frame.ownershipExpectation === 'excluded' && !(weight === 0 && host.cdfShare === 0 && share === 0 && frame.dispatch)) return false;
  if (!['owned', 'excluded', 'policy'].includes(frame.ownershipExpectation)) return false;
  return stars.every(source => {
    const provider = source.provider;
    if (!provider || !Number.isFinite(provider.mu) || provider.mu <= 0) return false;
    const coefficient = .001 * Math.sqrt(2 * provider.mu / 1000);
    const sink = (provider.bh ? provider.rs : provider.R) * K;
    return Number.isFinite(sink) && sink > 0 && source.coefficient === coefficient && source.fieldCoefficient === coefficient
      && source.sink === sink && source.fieldSink === sink
      && Number.isFinite(source.gpuCoefficient) && Math.abs(source.gpuCoefficient - coefficient) <= float32Tolerance(coefficient)
      && Number.isFinite(source.gpuSink) && Math.abs(source.gpuSink - sink) <= float32Tolerance(sink)
      && source.currentActive && source.world.every(Number.isFinite)
    && (!source.name.startsWith('gx:') || source.sourceTime === frame.time)
    && source.world.every((v, i) => v === source.field[i])
    && source.residual.every((v, i) => Math.abs(v - (source.world[i] - frame.center[i]))
      <= residualTolerance([v, source.world[i] - frame.center[i]]));
  });
}

export function healthyForeignBody(frame) {
  const body = frame.bodyPrecision;
  const tolerance = body ? residualTolerance(body.arithmeticScale) : 0;
  return !!body && body.visible && body.drawnThisFrame && body.expectedTranslation.every(Number.isFinite)
    && near(body.modelViewTranslation, body.expectedTranslation, () => tolerance)
    && near(body.gpuTranslation, body.expectedTranslation, value => tolerance + float32Tolerance(value));
}

export function healthyForeignFrame(frame, mobile) {
  return healthyRadianceFrame(frame) && frame.count === (mobile ? 9216 : 15376)
    && healthyForeignSources(frame) && healthyForeignObserver(frame) && healthyForeignBody(frame);
}

export function foreignMovementPreserved(before, after) {
  const expected = after.precision.expectedCamera.map((v, i) => v - before.precision.expectedCamera[i]);
  const actual = after.precision.cameraUniform.map((v, i) => v - before.precision.cameraUniform[i]);
  // The frame origin can move too, so compare the measured relative movement,
  // with a separate nonzero split-target advance in the driver.
  return near(actual, expected, () => residualTolerance([...before.precision.arithmeticScale, ...after.precision.arithmeticScale]));
}

export function sameForeignSystem(frame, original) {
  const current = frame.system, first = original.system;
  return !!current && !!first && first.cachedStarId === 'proc:' + FOREIGN_RIVER_HOST
    && current.cachedStarId === first.cachedStarId && current.renderedStarId === first.cachedStarId
    && current.renderedHostId === FOREIGN_RIVER_HOST
    && current.cachedPlanets === first.cachedPlanets && current.renderedPlanets === first.cachedPlanets
    && current.slotPlanets === first.cachedPlanets;
}

export function healthyForeignAdvection(frames, direction) {
  return [1, -1].includes(direction) && frames.length > 0
    && frames.every(frame => Number.isFinite(frame.dtVis) && frame.dtVis * direction > 0
      && (!frame.dispatch || Number.isFinite(frame.dispatch.dt) && (frame.dispatch.dt === 0 || frame.dispatch.dt * direction > 0)))
    && frames.some(frame => frame.dispatch?.dt * direction > 0);
}
