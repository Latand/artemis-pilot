import { healthyRadianceFrame } from './river-radiance-qa.mjs';

export const FOREIGN_RIVER_HOST = 'gx:m31:2654435769:1250:0:0:18';
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

export function healthyForeignSources(frame, hostId = FOREIGN_RIVER_HOST) {
  const stars = frame.sources.filter(source => source.activeSource);
  const host = stars.find(source => source.name === hostId);
  if (!host || stars.length > 24 || host.owners <= 0 || host.drawnOwners <= 0) return false;
  return stars.every(source => source.currentActive && source.world.every(Number.isFinite)
    && (!source.name.startsWith('gx:') || source.sourceTime === frame.time)
    && source.world.every((v, i) => v === source.field[i])
    && source.residual.every((v, i) => Math.abs(v - (source.world[i] - frame.center[i]))
      <= residualTolerance([v, source.world[i] - frame.center[i]])));
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
