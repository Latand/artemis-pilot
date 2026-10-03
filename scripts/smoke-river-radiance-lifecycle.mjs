import assert from 'node:assert/strict';
import { radianceLifecycleStep as step, healthyRadianceGain, healthyRadianceRecovery, sameCountActiveReplacement, signedRadianceAdvection } from './river-radiance-lifecycle.mjs';
for (const subject of ['proxima', 'black-hole']) {
  const plan = Array.from({ length: 64 }, (_, index) => step(index, subject));
  assert(plan.some(s => s.rate > 0) && plan.some(s => s.rate < 0) && plan.some(s => s.offscreen));
  assert.deepEqual(plan.filter(s => s.reset).map(s => s.index), [48]);
  assert.deepEqual(plan.filter(s => s.capture).map(s => s.index), [15, 23, 63]);
}
const before = { active: { ids: ['a', 'b', 'c'], revision: 1 } };
const after = { active: { ids: ['a', 'd', 'c'], revision: 2 }, sources: [{ activeSource: true, currentActive: true }] };
assert(sameCountActiveReplacement(before, after));
for (const mutate of [x => x.active.ids[1] = 'b', x => x.active.revision = 1, x => x.active.ids.push('d'), x => x.sources[0].currentActive = false]) {
  const wrong = structuredClone(after); mutate(wrong); assert(!sameCountActiveReplacement(before, wrong));
}
const frame = { drawCount: 1000, skippedCompute: false, dispatch: { respawn: 1 },
  gainState: { ownerShares: [1, 0], referenceShares: [.5, .5] }, sources: [
    { index: 0, coefficient: 1, cdfShare: 1, inkGain: .5 }, { index: 1, coefficient: 1, cdfShare: 0, inkGain: 1 }] };
assert(healthyRadianceGain(frame));
for (const mutate of [x => x.sources[0].inkGain = 1, x => x.gainState.ownerShares[0] = .5, x => x.gainState.referenceShares[0] = .7]) {
  const wrong = structuredClone(frame); mutate(wrong); assert(!healthyRadianceGain(wrong));
}
const skipped = structuredClone(frame); skipped.dispatch = null; skipped.skippedCompute = true;
assert(healthyRadianceGain(skipped, frame)); skipped.gainState.ownerShares[0] = .9;
assert(!healthyRadianceGain(skipped, frame));
const state = { time: 7, paused: true, completed: 4, contextLost: false, lifecycleLost: false, losses:0, restores: 0, resetCalls: 0, defaultTarget: true };
const recovery = { before: state, held: { ...state, contextLost: true, lifecycleLost: true,losses:1 }, restored: { ...state,losses:1, restores: 1, resetCalls: 1 } };
const next = { time: 7, completed: 5, contextLost: false, dispatch: { respawn: 1 }, skippedCompute: false };
assert(healthyRadianceRecovery(recovery, next));
for (const mutate of [x => x.held.time++, x => x.held.contextLost = false, x => x.held.losses = 0, x => x.restored.lifecycleLost = true, x => x.restored.resetCalls = 0, x => x.held.completed++]) {
  const wrong = structuredClone(recovery); mutate(wrong); assert(!healthyRadianceRecovery(wrong, next));
}
assert(!healthyRadianceRecovery(recovery, { ...next, dispatch: { respawn: .5 } }));
assert(!healthyRadianceRecovery(recovery, { ...next, completed: 4 }));
assert(signedRadianceAdvection({dispatch:{dt:-3}},{rate:-1}));
assert(signedRadianceAdvection({dispatch:null},{rate:0}));
assert(!signedRadianceAdvection({dispatch:{dt:3}},{rate:-1}));
assert(!signedRadianceAdvection({dispatch:{dt:3}},{rate:0}));
console.log('Lifecycle guard rejects stale identities, stale gains, false restoration and missing reset compute');
