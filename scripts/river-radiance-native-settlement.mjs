// QA-only readers and pure guards. Native worker work remains on its normal
// production frames; the caller owns the unchanged total preparation deadline.
import assert from 'node:assert/strict';
import { FIELD_BINS, FAMILY_BAR, FAMILY_DISK, binHasStars, binRadiusPc } from '../src/universe/resolvedField.js';
import { RESOLVED_MAG_LIMIT, patternAngles } from '../src/universe/galaxyModel.js';
import { MYR_S, EPOCH, epochPhi, omegaRadMyr } from '../src/universe/galaxyDynamics.js';

// These match resolvedFieldStars.js startGen/retuneLimit. The smoke checks the
// source contract explicitly because the production constants are private.
const MAG_MIN = 6, MAG_STEP = .25;
const MAX_LIMITS = 1 + (RESOLVED_MAG_LIMIT - MAG_MIN) / MAG_STEP;
const sorted = values => [...values].sort();
const integer = (value, name, minimum = 0) => assert(Number.isSafeInteger(value) && value >= minimum, `Invalid ${name}`);
const vector = (value, name, length = 3) => assert(Array.isArray(value) && value.length === length && value.every(Number.isFinite), `Invalid ${name}`);
function magnitude(value) {
  assert(Number.isFinite(value) && value >= MAG_MIN && value <= RESOLVED_MAG_LIMIT && Number.isInteger(value / MAG_STEP), 'Invalid native magnitude limit');
}
export function nativeFieldRequiredKeys(epochs) {
  assert(Array.isArray(epochs) && epochs.length >= 1 && epochs.length <= 2 && epochs.every(Number.isSafeInteger) && new Set(epochs).size === epochs.length, 'Invalid required epochs');
  const keys = [];
  for (let bin = 0; bin < FIELD_BINS; bin++) {
    if (binHasStars(bin, FAMILY_BAR)) keys.push(`b:${bin}`);
    if (binHasStars(bin, FAMILY_DISK)) for (const epoch of epochs) keys.push(`d:${bin}:${epoch}`);
  }
  return keys.sort();
}

// Serialized by page.evaluate: deliberately self-contained, read-only, and no
// rendering/worker scheduling or replacement of production readiness flags.
// initializeQA supplies fieldMath = import('/src/universe/resolvedField.js').
export function nativeFieldSnapshot() {
  const q = pairedQA, { state: s } = q.field.resolvedFieldDebug(), math = q.fieldMath;
  const field = q.field.resolvedFieldStatus(), { cam, camera } = q.scene;
  const keys = [];
  for (let bin = 0; bin < math.FIELD_BINS; bin++) {
    if (math.binHasStars(bin, math.FAMILY_BAR)) keys.push(`b:${bin}`);
    if (math.binHasStars(bin, math.FAMILY_DISK)) for (const epoch of s.needed) keys.push(`d:${bin}:${epoch}`);
  }
  const input = value => ({ camF: [...value.camF], tB: value.tB, active: value.active ? [...value.active] : null, sfr: value.sfr, keep: value.keep });
  const request = s.inflight;
  return {
    frameNo: __pairedWorkload().frameNo, field,
    queue: {
      requiredKeys: keys.sort(), built: [...s.built].map(([key, value]) => ({ key, gen: value.gen, ...input(value) })).sort((a, b) => a.key.localeCompare(b.key)),
      stagedKeys: s.staging ? [...s.staging.keys()].sort() : null,
      meshKeys: [...s.meshes.keys()].sort(), counts: [...s.counts].sort(([a], [b]) => a.localeCompare(b)),
      inflight: request ? {
        id: request.id, gen: request.gen, key: request.family === math.FAMILY_BAR ? `b:${request.bin}` : `d:${request.bin}:${request.params.epoch}`,
        magLimit: request.params.magLimit, params: structuredClone(request.params),
      } : null,
      nextId: s.nextId, fallbackBusy: s.fallbackBusy, idleUpdates: s.idleUpdates,
      genMLim: s.genMLim, guessAtGen: s.guessAtGen, lastT: s.lastT, lastCam: s.lastDebugCam ? [...s.lastDebugCam] : null,
    },
    observer: {
      t: q.G.t, paused: q.G.paused, observerMode: q.G.observerMode, gr: q.G.gr, dead: q.G.dead, focus: q.G.focus, warp: q.G.warp,
      ship: [q.G.x, q.G.y, q.G.z, q.G.vx, q.G.vy, q.G.vz], seed: q.galaxy.getSeed(), epoch: q.epoch.getEpochMs(),
      camera: { distance: cam.dist, yaw: cam.yaw, pitch: cam.pitch, target: cam.tgt.toArray(), position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov },
    },
  };
}

export function validateNativeFieldStatus(field) {
  assert(field && field.enabled === true, 'The full native field must remain enabled');
  for (const key of ['stars', 'gen', 'meshes', 'builds']) integer(field[key], `field ${key}`);
  assert(Number.isFinite(field.ms) && field.ms >= 0, 'Invalid accumulated native build time');
  integer(field.cached, 'native cache count');
  integer(field.budget, 'field budget', 1); magnitude(field.mLim);
  assert.equal(typeof field.staging, 'boolean'); assert.equal(typeof field.idle, 'boolean');
  const required = nativeFieldRequiredKeys(field.epochs);
  assert(field.meshes <= required.length, 'Native meshes exceed required bins');
  assert(!(field.idle && field.staging), 'Staged work is not idle');
  return required;
}
function subset(keys, required, name) {
  assert(Array.isArray(keys) && keys.every(key => typeof key === 'string') && new Set(keys).size === keys.length, `Invalid ${name} keys`);
  assert(keys.every(key => required.includes(key)), `${name} contains an unrequired bin`);
}
function buildInputs(record) {
  return { tB: record.tB, active: record.active, sfr: record.sfr, keep: record.keep };
}
function inputGroup(key) { return key.startsWith('b:') ? 'bar' : `disk:${key.split(':')[2]}`; }
export function validateNativeFieldSnapshot(snapshot) {
  assert(snapshot && snapshot.queue && snapshot.observer, 'Native settlement needs observed queue and frozen observer details');
  integer(snapshot.frameNo, 'native frame', 1);
  const { field, queue: queue, observer } = snapshot, required = validateNativeFieldStatus(field);
  assert.deepEqual(queue.requiredKeys, required, 'Required native bins must match the production luminosity function');
  magnitude(queue.genMLim); magnitude(queue.guessAtGen);
  integer(queue.nextId, 'next request ID', 1); integer(queue.idleUpdates, 'idle update count');
  assert.equal(typeof queue.fallbackBusy, 'boolean');
  assert(Array.isArray(queue.built), 'Missing built-bin records');
  const builtKeys = queue.built.map(record => record.key);
  subset(builtKeys, required, 'Built'); subset(queue.meshKeys, required, 'Mesh');
  assert.equal(queue.meshKeys.length, field.meshes, 'Mesh counters disagree');
  assert(Array.isArray(queue.counts), 'Missing native count map');
  subset(queue.counts.map(([key]) => key), required, 'Count');
  assert.deepEqual(sorted(queue.counts.map(([key]) => key)), sorted(queue.meshKeys), 'Mesh/count keys disagree');
  for (const [, count] of queue.counts) integer(count, 'mesh star count', 1);
  assert.equal(queue.counts.reduce((sum, [, count]) => sum + count, 0), field.stars, 'Star count differs from the real meshes');
  assert(queue.built.length <= field.builds, 'Built bins exceed completed requests');
  for (const record of queue.built) {
    assert.equal(record.gen, field.gen, 'Built bin belongs to another generation');
    vector(record.camF, 'built camera');
    if (record.active !== null) vector(record.active, 'built active neighbourhood');
    for (const key of ['tB', 'sfr', 'keep']) assert(Number.isFinite(record[key]), `Invalid build ${key}`);
  }
  assert.equal(field.staging, queue.stagedKeys !== null, 'Staging flag differs from the real queue');
  if (queue.stagedKeys !== null) {
    subset(queue.stagedKeys, required, 'Staged');
    assert.deepEqual(sorted(queue.stagedKeys), sorted(builtKeys), 'Every successful staged result must have one built bin');
    assert(queue.stagedKeys.length < required.length, 'A complete staged generation must have swapped');
  } else assert.equal(field.mLim, queue.genMLim, 'Applied limit differs without a staged generation');
  const request = queue.inflight;
  if (request !== null) {
    integer(request.id, 'inflight ID', 1);
    assert.equal(request.id, queue.nextId - 1); assert.equal(request.gen, field.gen, 'Inflight generation differs');
    assert(required.includes(request.key) && !builtKeys.includes(request.key), 'Inflight bin is outside the finite unbuilt queue');
    assert.equal(request.magLimit, queue.genMLim);
    assert(request.params && request.params.magLimit === queue.genMLim, 'Inflight limit disagrees');
    assert.equal(request.params.maxStars, field.budget * 1.2, 'Native per-bin work budget changed');
    for (const key of ['cam', 'sun', 'ref']) vector(request.params[key], `request ${key}`);
    if (request.params.active !== null) vector(request.params.active, 'request active neighbourhood');
    for (const key of ['activeR', 'sfr', 'keep', 'catalogMagLimit']) assert(Number.isFinite(request.params[key]), `Invalid request ${key}`);
    assert.equal(queue.idleUpdates, 0, 'An inflight build must reset idle updates');
  }
  assert(!queue.fallbackBusy || request !== null, 'Fallback work lost its inflight request');
  assert.equal(queue.nextId - 1, field.builds + (request === null ? 0 : 1), 'Issued, completed and inflight request counters disagree');
  if (queue.idleUpdates > 0) {
    assert.equal(builtKeys.length, required.length, 'Idle updates require every native bin built');
    assert.equal(queue.stagedKeys, null); assert.equal(request, null); assert.equal(queue.fallbackBusy, false);
  }
  assert.equal(field.idle, request === null && queue.stagedKeys === null && queue.idleUpdates > 2, 'Production idle predicate disagrees');
  assert(observer.paused === true && observer.observerMode === true, 'Observer and physical clock must stay frozen');
  assert(observer.gr === true && observer.dead === true, 'Keep the declared physical observer fixture');
  assert(Number.isFinite(observer.t) && Number.isFinite(observer.epoch));
  assert.equal(queue.lastT, observer.t, 'Native field clock differs from frozen simulation time');
  vector(queue.lastCam, 'last native camera'); vector(observer.ship, 'observer ship', 6);
  integer(observer.seed, 'observer seed'); assert(Number.isFinite(observer.warp));
  assert(observer.camera && ['distance', 'yaw', 'pitch', 'fov'].every(key => Number.isFinite(observer.camera[key])));
  for (const key of ['target', 'position']) vector(observer.camera[key], `observer ${key}`);
  vector(observer.camera.quaternion, 'observer quaternion', 4);
  return snapshot;
}
export function nativeFieldSettlementReady(snapshot) {
  validateNativeFieldSnapshot(snapshot);
  return snapshot.field.idle;
}
// Use exactly the production frame transform and camera rebuild score. Bins
// already built before the fixture was installed retain their valid selection
// reference. They are immutable history, not a claim that every bin was built
// from the current camera. New work must use the exact current reference.
export function nativeFieldCameraReference(snapshot, key) {
  const g = snapshot.queue.lastCam, tMyr = snapshot.queue.lastT / MYR_S;
  const disk = key.startsWith('d:'), epoch = disk ? Number(key.split(':')[2]) : null;
  const angle = disk ? epochPhi(epoch) + omegaRadMyr(Math.hypot(g[0], g[1])) * (tMyr - epoch * EPOCH.lengthMyr)
    : patternAngles(snapshot.queue.lastT, {}).bar;
  const c = Math.cos(-angle), s = Math.sin(-angle);
  return [g[0] * c - g[1] * s, g[0] * s + g[1] * c, g[2]];
}
export function historicalCameraScore(snapshot, record) {
  const current = nativeFieldCameraReference(snapshot, record.key);
  const radius = binRadiusPc(Number(record.key.split(':')[1]), snapshot.queue.genMLim);
  return Math.hypot(...current.map((value, i) => value - record.camF[i])) / Math.max(.06 * radius, .05);
}
function rememberInputs(previousInputs, snapshot, retained) {
  const inputs = structuredClone(previousInputs);
  const records = [...snapshot.queue.built], request = snapshot.queue.inflight;
  if (request) {
    const reference = nativeFieldCameraReference(snapshot, request.key);
    assert.deepEqual(request.params.ref, reference, 'New native request has a changed camera reference');
    assert.deepEqual(request.params.cam, request.key.startsWith('d:') ? snapshot.queue.lastCam : reference, 'New native request has a changed camera');
    records.push({ key: request.key, gen: request.gen, camF: request.params.ref, tB: snapshot.queue.lastT / MYR_S,
      active: request.params.active, sfr: request.params.sfr, keep: request.params.keep });
    const { magLimit, ...fixedParams } = request.params, group = `request:${inputGroup(request.key)}`;
    if (inputs[group]) assert.deepEqual(fixedParams, inputs[group], 'Native worker selection inputs changed at the frozen observer');
    else inputs[group] = fixedParams;
  }
  for (const record of records) {
    const original = retained.find(value => value.key === record.key && value.gen === record.gen);
    if (original) {
      assert.deepEqual(record, original, 'A retained historical native bin changed');
      assert(historicalCameraScore(snapshot, record) <= 1, 'Historical native camera reference exceeds production rebuild policy');
    } else assert.deepEqual(record.camF, nativeFieldCameraReference(snapshot, record.key), 'New native bin has a changed camera reference');
    // This paused-clock fixture has no allowed temporal/era/neighbourhood
    // transition. Only an already-retained camera reference may differ.
    assert.equal(record.tB, snapshot.queue.lastT / MYR_S, 'Native bin time differs from the frozen clock');
    const group = inputGroup(record.key), next = buildInputs(record);
    if (inputs[group]) assert.deepEqual(next, inputs[group], 'Native field selection inputs changed at the frozen observer');
    else inputs[group] = next;
  }
  return inputs;
}
export function createNativeFieldGuard(snapshot) {
  validateNativeFieldSnapshot(snapshot);
  const retained = structuredClone(snapshot.queue.built);
  return { version: 2, previous: structuredClone(snapshot), retained, limits: [snapshot.queue.genMLim], inputs: rememberInputs({}, snapshot, retained),
    samples: 1, completedBuilds: 0, issuedBuilds: 0, progress: snapshot.field.idle ? 'idle' : 'observed',
    maxGenerationLimits: MAX_LIMITS, maxAdditionalBuilds: MAX_LIMITS * snapshot.queue.requiredKeys.length - snapshot.queue.built.length };
}
export function advanceNativeFieldGuard(guard, snapshot) {
  assert(guard && guard.version === 2, 'Missing native settlement guard');
  validateNativeFieldSnapshot(snapshot);
  const previous = guard.previous, before = previous.queue, next = snapshot.queue;
  assert.equal(snapshot.frameNo, previous.frameNo + 1, 'Native settlement must retain every whole production frame');
  assert.deepEqual(snapshot.observer, previous.observer, 'Native observer/clock changed during settlement');
  assert.deepEqual(snapshot.field.epochs, previous.field.epochs, 'Native epoch queue changed');
  assert.deepEqual(next.lastCam, before.lastCam, 'Native camera moved');
  assert.equal(next.guessAtGen, before.guessAtGen, 'Frozen observer changed the limit estimate');
  assert.equal(snapshot.field.budget, previous.field.budget, 'Native star budget changed');
  assert(snapshot.field.ms >= previous.field.ms, 'Accumulated native build time moved backward');
  const completed = snapshot.field.builds - previous.field.builds, issued = next.nextId - before.nextId, generation = snapshot.field.gen - previous.field.gen;
  assert(completed >= 0 && completed <= 2 && issued >= 0 && issued <= 1, 'One production update can issue at most one bin build');
  assert(generation === 0 || generation === 1, 'Unobserved or backward native generation transition');
  const limits = [...guard.limits];
  if (generation === 0) {
    assert.equal(next.genMLim, before.genMLim, 'Limit changed without a new generation');
    assert.equal(next.built.length - before.built.length, completed, 'Completed builds must advance distinct bins');
    const current = new Map(next.built.map(record => [record.key, record]));
    for (const record of before.built) assert.deepEqual(current.get(record.key), record, 'A frozen generation rebuilt or removed an existing bin');
    assert(!snapshot.field.staging || previous.field.staging, 'Staging restarted without a generation');
    if (snapshot.field.mLim !== previous.field.mLim) {
      assert(previous.field.staging && !snapshot.field.staging && next.built.length === next.requiredKeys.length, 'Magnitude changed before a complete native swap');
    }
    if (!completed && !issued) {
      if (next.inflight) assert.deepEqual(next.inflight, before.inflight, 'A pending native request changed without issuance');
      else assert.equal(next.idleUpdates, before.idleUpdates + 1, 'Delivered native frame made no build or idle progress');
    }
  } else {
    assert(completed > 0, 'Frozen native generation changed without a completed build');
    assert(!limits.includes(next.genMLim), 'Repeated native magnitude limit would permit an endless generation cycle');
    limits.push(next.genMLim);
    assert(limits.length <= MAX_LIMITS, 'Native generations exhausted the finite magnitude grid');
    assert(next.built.length < completed, 'New generation counters include work from the discarded generation');
  }
  assert(next.idleUpdates <= before.idleUpdates + 1, 'Idle counters advanced without delivered frames');
  if (issued) assert.equal(next.idleUpdates, 0, 'Issuing a native build must reset idle updates');
  else if (completed) assert(next.idleUpdates <= 1, 'A completed request permits at most one delivered idle update');
  const completedBuilds = guard.completedBuilds + completed, issuedBuilds = guard.issuedBuilds + issued;
  assert(completedBuilds <= guard.maxAdditionalBuilds && issuedBuilds <= guard.maxAdditionalBuilds + 1, 'Native work exceeded its finite bin/limit allowance');
  return { ...guard, previous: structuredClone(snapshot), limits, inputs: rememberInputs(guard.inputs, snapshot, guard.retained), samples: guard.samples + 1,
    completedBuilds, issuedBuilds, progress: snapshot.field.idle ? 'idle' : generation ? 'generation' : completed ? 'build' : issued ? 'issued' : next.inflight ? 'waiting-for-build' : 'idle-update' };
}
export function validateNativeSettlementRecord(record) {
  assert(record && record.complete === true && record.before && record.after, 'Native field settlement is incomplete');
  assert.equal(record.A.length, record.B.length, 'Native settlement must deliver equal A/B frames');
  const result = {};
  for (const side of ['A', 'B']) {
    let guard = createNativeFieldGuard(record.before[side]);
    for (const frame of record[side]) {
      assert.equal(frame.frameNo, frame.nativeField?.frameNo, 'Native queue snapshot must identify its retained frame');
      guard = advanceNativeFieldGuard(guard, frame.nativeField);
    }
    assert.deepEqual(record.after[side], guard.previous, 'Native checkpoint must match its last retained frame');
    assert(nativeFieldSettlementReady(record.after[side]), 'Every native bin and three idle updates must finish before warmup');
    result[side] = guard;
  }
  assert.equal(record.before.A.frameNo, record.before.B.frameNo);
  return result;
}
