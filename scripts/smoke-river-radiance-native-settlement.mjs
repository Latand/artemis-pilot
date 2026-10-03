import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MYR_S } from '../src/universe/galaxyDynamics.js';
import {
  nativeFieldRequiredKeys, nativeFieldSnapshot, validateNativeFieldStatus, validateNativeFieldSnapshot,
  nativeFieldSettlementReady, createNativeFieldGuard, advanceNativeFieldGuard, validateNativeSettlementRecord,
} from './river-radiance-native-settlement.mjs';
import * as fieldMath from '../src/universe/resolvedField.js';

// Explicitly synthetic queue details for unit/aggregate tests. Never combined
// with the retained fixture as if that artifact had recorded these details.
// Importing this helper does not run this smoke or perform external actions.
export function syntheticNativeFieldSnapshot({ frameNo = 121, gen = 2, genMLim = 7.25, mLim = genMLim,
  builtCount = 89, priorBuilds = 90, idleUpdates = 3, staging = false, inflight = false, stars = 38715 } = {}) {
  const requiredKeys = nativeFieldRequiredKeys([18]), builds = priorBuilds + builtCount;
  const t = 17076376013673600, camF = [1, 2, 3], active = [4, 5, 6];
  const built = requiredKeys.slice(0, builtCount).map(key => ({ key, gen, camF: [...camF], tB: t / MYR_S, active: [...active], sfr: 1, keep: 1 }));
  const request = inflight ? { id: builds + 1, gen, key: requiredKeys[builtCount], magLimit: genMLim,
    params: { cam: [...camF], sun: [7, 8, 9], ref: [...camF], active: [...active], activeR: 10, sfr: 1, keep: 1,
      magLimit: genMLim, catalogMagLimit: 11, maxStars: 60000 * 1.2 } } : null;
  return {
    frameNo,
    field: { enabled: true, stars, mLim, gen, staging, budget: 60000, epochs: [18], meshes: stars ? 1 : 0,
      idle: !inflight && !staging && idleUpdates > 2, builds, ms: builds, cached: 10 },
    queue: { requiredKeys, built, stagedKeys: staging ? built.map(record => record.key) : null,
      meshKeys: stars ? [requiredKeys[0]] : [], counts: stars ? [[requiredKeys[0], stars]] : [],
      inflight: request, nextId: builds + (inflight ? 1 : 0) + 1, fallbackBusy: false,
      idleUpdates, genMLim, guessAtGen: 9, lastT: t, lastCam: [10, 20, 30] },
    observer: { t, paused: true, observerMode: true, gr: true, dead: true, focus: 'star:0', warp: MYR_S,
      ship: [0, 0, 0, 0, 0, 0], seed: 1, epoch: 1791028800000,
      camera: { distance: 100, yaw: 1, pitch: 2, target: [1, 2, 3], position: [2, 3, 4], quaternion: [0, 0, 0, 1], fov: 60 } },
  };
}

export function smokeNativeFieldSettlement() {
  const source = readFileSync(new URL('../src/render/resolvedFieldStars.js', import.meta.url), 'utf8');
  for (const contract of [
    'const MAG_MIN = 6, MAG_STEP = 0.25;', 'state.gen++;', 'state.built.clear();',
    'if (!best) { state.idleUpdates++; return; }', 'state.idleUpdates = 0;',
    'idle: !state.enabled || (!state.inflight && !state.staging && state.idleUpdates > 2)',
    'maxStars: state.budget * 1.2', 'state.inflight || state.fallbackBusy',
  ]) assert(source.includes(contract), `Revisit native settlement guard after production contract changes: ${contract}`);
  const keys = nativeFieldRequiredKeys([18]);
  assert.equal(keys.filter(key => key.startsWith('b:')).length, 38);
  assert.equal(keys.filter(key => key.startsWith('d:')).length, 51);
  assert.equal(nativeFieldRequiredKeys([18, 19]).length, 140);

  // The real artifact is a regression for the former asset timeout boundary.
  // Its last row is still incomplete. Internal queue details and a successful
  // continuation are deliberately tested separately below as synthetic data.
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/radiance-native-field-run-37148090790.json', import.meta.url), 'utf8'));
  assert.equal(fixture.sourceIncludesQueueDetails, false); assert.equal(fixture.nativeIdleObserved, false);
  assert.equal(fixture.catalogSetupUpdates, 120); assert.equal(fixture.runLimits.preparationMs, 3600000);
  assert.equal(fixture.runLimits.assetSettlementMs, 300000);
  for (const side of ['A', 'B']) {
    const frames = fixture.rows[side].map(row => ({ ...fixture.commonField, ...Object.fromEntries(fixture.columns.map((column, index) => [column, row[index]])) }));
    assert.equal(frames.length, 179);
    for (const [index, field] of frames.entries()) { assert.equal(field.frameNo, index + 2); validateNativeFieldStatus(field); assert.equal(field.idle, false); }
    const at = frame => frames.find(field => field.frameNo === frame);
    assert.equal(at(89).gen, 1); assert.equal(at(90).gen, 2); assert.equal(at(90).builds, 90);
    assert.equal(at(90).stars, 250001); assert.equal(at(90).staging, true);
    assert.equal(at(179).builds - at(90).builds, keys.length);
    assert.equal(at(179).stars, 38715); assert.equal(at(179).mLim, 7.25); assert.equal(at(179).staging, false);
    assert.equal(at(180).builds, 179); assert.equal(at(180).idle, false);
    assert.throws(() => createNativeFieldGuard({ frameNo: 180, field: at(180) }), /observed queue/);
  }

  const idle = syntheticNativeFieldSnapshot();
  assert(nativeFieldSettlementReady(idle));
  const zero = { before: { A: idle, B: idle }, after: { A: idle, B: idle }, A: [], B: [], complete: true };
  assert.equal(validateNativeSettlementRecord(zero).A.samples, 1);
  assert.throws(() => validateNativeSettlementRecord({ ...zero, complete: false }), /incomplete/);
  const incomplete = syntheticNativeFieldSnapshot({ idleUpdates: 2 });
  assert.equal(nativeFieldSettlementReady(incomplete), false);
  assert.throws(() => validateNativeSettlementRecord({ ...zero, before: { A: incomplete, B: incomplete }, after: { A: incomplete, B: incomplete } }), /three idle/);

  // The finite 89-bin retune and all three ordinary idle updates. A synthetic
  // 300-second wall boundary has no authority to discard valid native work.
  const start = syntheticNativeFieldSnapshot({ frameNo: 90, builtCount: 0, idleUpdates: 0, staging: true, mLim: 9, stars: 250001 });
  let guard = createNativeFieldGuard(start);
  const retained = [];
  for (let count = 1; count <= keys.length; count++) {
    const done = count === keys.length;
    const next = syntheticNativeFieldSnapshot({ frameNo: 90 + count, builtCount: count, idleUpdates: 0, staging: !done, mLim: done ? 7.25 : 9, stars: done ? 38715 : 250001 });
    guard = advanceNativeFieldGuard(guard, next); retained.push({ frameNo: next.frameNo, nativeField: next });
    assert.equal(nativeFieldSettlementReady(next), false);
  }
  for (let idleUpdates = 1; idleUpdates <= 3; idleUpdates++) {
    const next = syntheticNativeFieldSnapshot({ frameNo: 179 + idleUpdates, idleUpdates });
    guard = advanceNativeFieldGuard(guard, next); retained.push({ frameNo: next.frameNo, nativeField: next });
    assert.equal(nativeFieldSettlementReady(next), idleUpdates === 3);
  }
  assert.equal(guard.completedBuilds, 89); assert.equal(guard.progress, 'idle');
  const record = { before: { A: start, B: start }, after: { A: guard.previous, B: guard.previous }, A: retained, B: retained, complete: true };
  assert.equal(validateNativeSettlementRecord(record).B.completedBuilds, 89);
  const missingFrame = structuredClone(record); missingFrame.A.splice(10, 1); missingFrame.B.splice(10, 1);
  assert.throws(() => validateNativeSettlementRecord(missingFrame), /every whole production frame/);

  // The sole outstanding worker can span several real frames. Only the caller's
  // unchanged total preparation deadline bounds elapsed time, not this guard.
  const pending = syntheticNativeFieldSnapshot({ builtCount: 88, idleUpdates: 0, inflight: true });
  let waiting = createNativeFieldGuard(pending);
  for (let i = 1; i <= 5; i++) waiting = advanceNativeFieldGuard(waiting, { ...structuredClone(pending), frameNo: pending.frameNo + i });
  assert.equal(waiting.progress, 'waiting-for-build'); assert.equal(waiting.completedBuilds, 0);
  // A result may arrive before the next update, which then counts one idle tick.
  const resultThenIdle = syntheticNativeFieldSnapshot({ frameNo: waiting.previous.frameNo + 1, idleUpdates: 1 });
  assert.equal(advanceNativeFieldGuard(waiting, resultThenIdle).progress, 'build');

  // Real retuning occurs only on a completed result, starts a distinct limit,
  // and clears the completed-bin set. Reject immediate and eventual cycles.
  const almost = syntheticNativeFieldSnapshot({ frameNo: 89, gen: 1, genMLim: 9, builtCount: 88, priorBuilds: 1, idleUpdates: 0 });
  const retuned = advanceNativeFieldGuard(createNativeFieldGuard(almost), start);
  assert.deepEqual(retuned.limits, [9, 7.25]);
  const cycleGuard = { ...createNativeFieldGuard(syntheticNativeFieldSnapshot({ frameNo: 200, builtCount: 88, idleUpdates: 0 })), limits: [9, 7.25] };
  const cycle = syntheticNativeFieldSnapshot({ frameNo: 201, gen: 3, genMLim: 9, mLim: 7.25, builtCount: 0, priorBuilds: 179, idleUpdates: 0, staging: true });
  assert.throws(() => advanceNativeFieldGuard(cycleGuard, cycle), /endless generation cycle/);
  const sameLimit = structuredClone(start); sameLimit.queue.genMLim = 9;
  assert.throws(() => advanceNativeFieldGuard(createNativeFieldGuard(almost), sameLimit), /endless generation cycle/);

  for (const [name, mutate] of [
    ['missing queue', value => delete value.queue],
    ['bad bin', value => value.queue.requiredKeys.push('b:999')],
    ['duplicate bin', value => value.queue.built.push(value.queue.built[0])],
    ['wrong generation', value => value.queue.built[0].gen--],
    ['unbuilt idle', value => value.queue.built.pop()],
    ['false idle', value => value.queue.idleUpdates = 2],
    ['fractional idle', value => value.queue.idleUpdates = 3.5],
    ['inconsistent request count', value => value.queue.nextId++],
    ['inconsistent star count', value => value.field.stars++],
    ['inconsistent mesh count', value => value.field.meshes++],
    ['out of range magnitude', value => value.queue.genMLim = 5.75],
    ['off-grid magnitude', value => value.queue.genMLim = 7.3],
    ['orphan fallback', value => value.queue.fallbackBusy = true],
    ['moving physical clock', value => value.observer.paused = false],
    ['native clock differs', value => value.queue.lastT += MYR_S],
  ]) {
    const bad = structuredClone(idle); mutate(bad);
    assert.throws(() => validateNativeFieldSnapshot(bad), undefined, name);
  }
  for (const [name, mutate] of [
    ['skipped frame', value => value.frameNo++],
    ['observer moved', value => value.observer.camera.position[0]++],
    ['native camera moved', value => value.queue.lastCam[0]++],
    ['estimate changed', value => value.queue.guessAtGen = 8.75],
    ['build inputs changed', value => value.queue.built[0].sfr = .5],
    ['idle counter did not advance', value => value.queue.idleUpdates--],
    ['idle jumped', value => value.queue.idleUpdates++],
    ['backward generation', value => { value.field.gen--; for (const bin of value.queue.built) bin.gen--; }],
  ]) {
    const bad = syntheticNativeFieldSnapshot({ frameNo: 122, idleUpdates: 4 }); mutate(bad);
    assert.throws(() => advanceNativeFieldGuard(createNativeFieldGuard(idle), bad), undefined, name);
  }
  const lostRequest = structuredClone(pending); lostRequest.frameNo++; lostRequest.queue.inflight = null; lostRequest.queue.nextId--;
  assert.throws(() => advanceNativeFieldGuard(createNativeFieldGuard(pending), lostRequest));
  const changedRequest = structuredClone(pending); changedRequest.frameNo++; changedRequest.queue.inflight.params.activeR++;
  assert.throws(() => advanceNativeFieldGuard(createNativeFieldGuard(pending), changedRequest), /pending native request changed/);

  // Exercise the actual serialized reader against explicit synthetic Maps.
  const originalQA = globalThis.pairedQA, originalWorkload = globalThis.__pairedWorkload;
  try {
    const { field, queue, observer } = idle, camera = observer.camera;
    const vectorValue = array => ({ toArray: () => [...array] });
    globalThis.pairedQA = {
      fieldMath, field: { resolvedFieldStatus: () => structuredClone(field), resolvedFieldDebug: () => ({ state: {
        needed: field.epochs, built: new Map(queue.built.map(({ key, ...value }) => [key, value])), staging: null,
        meshes: new Map(queue.meshKeys.map(key => [key, {}])), counts: new Map(queue.counts), inflight: null,
        nextId: queue.nextId, fallbackBusy: false, idleUpdates: queue.idleUpdates, genMLim: queue.genMLim,
        guessAtGen: queue.guessAtGen, lastT: queue.lastT, lastDebugCam: queue.lastCam,
      } }) },
      scene: { cam: { dist: camera.distance, yaw: camera.yaw, pitch: camera.pitch, tgt: vectorValue(camera.target) },
        camera: { position: vectorValue(camera.position), quaternion: vectorValue(camera.quaternion), fov: camera.fov } },
      G: { ...observer, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
      galaxy: { getSeed: () => observer.seed }, epoch: { getEpochMs: () => observer.epoch },
    };
    globalThis.__pairedWorkload = () => ({ frameNo: idle.frameNo });
    const read = nativeFieldSnapshot(); validateNativeFieldSnapshot(read);
    assert.deepEqual(read.queue.requiredKeys, queue.requiredKeys); assert.equal(read.queue.built.length, 89);
    assert.deepEqual(read.observer, observer); assert.equal(read.field.idle, true);
  } finally {
    if (originalQA === undefined) delete globalThis.pairedQA; else globalThis.pairedQA = originalQA;
    if (originalWorkload === undefined) delete globalThis.__pairedWorkload; else globalThis.__pairedWorkload = originalWorkload;
  }
  console.log('Native field settlement: real incomplete sequence retained; finite bins/generations, frozen observer, queue accounting and three idle updates verified');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) smokeNativeFieldSettlement();
