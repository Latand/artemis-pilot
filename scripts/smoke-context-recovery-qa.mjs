import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { contextLossSettled, contextRestoreSettled, recoveredGpuIsHealthy, pausedRecoveryPassed } from './context-recovery-qa.mjs';

// Execute exactly the serialized browser predicates, with Playwright's raw
// truthiness semantics. Neither predicate may return a Promise or pass while
// the native GL flag and the production lifecycle flag disagree.
for (const predicate of [contextLossSettled, contextRestoreSettled]) {
    const state = { glLost: false, lifecycleLost: false };
    const sandbox = { window: { __qaRecoveryScene: { renderer: { getContext: () => ({ isContextLost: () => state.glLost }) }, renderContext: { isLost: () => state.lifecycleLost } } } };
    const poll = vm.runInNewContext(`(${predicate.toString()})`, sandbox);
    const initial = predicate === contextRestoreSettled;
    state.glLost = state.lifecycleLost = initial;
    let attempts = 0, accepted = false;
    for (const [glLost, lifecycleLost] of [[initial, initial], [!initial, initial], [initial, !initial], [!initial, !initial]]) {
        Object.assign(state, { glLost, lifecycleLost });
        const result = poll();
        assert.equal(typeof result, 'boolean', 'serialized polling must return synchronously');
        attempts++;
        if (result) { accepted = true; break; }
        assert(attempts < 4, 'ready state eventually passes');
    }
    assert(accepted); assert.equal(attempts, 4, 'all false initial/mixed states remain pending');
    // A never-restored/lost state must never be accepted by any retry.
    state.glLost = state.lifecycleLost = initial;
    for (let i = 0; i < 8; i++) assert.equal(poll(), false);
}

const before = { paused: true, t: 123, success: 40, contextLost: true, contextLifecycleLost: true };
const after = { paused: true, t: 123, success: 41, contextLost: false, contextLifecycleLost: false };
assert(pausedRecoveryPassed(before, after, 123));
for (const delta of [{ contextLost: true }, { contextLifecycleLost: true }, { success: 40 }, { paused: false }, { t: 124 }]) {
    assert.equal(pausedRecoveryPassed(before, { ...after, ...delta }, 123), false, `later assertion rejects ${JSON.stringify(delta)}`);
}
assert.equal(pausedRecoveryPassed({ ...before, contextLost: false }, after, 123), false, 'test must have observed real context loss');
assert.equal(pausedRecoveryPassed({ ...before, contextLifecycleLost: false }, after, 123), false, 'loss handler must have run');
assert.equal(pausedRecoveryPassed(before, before, 123), false, 'unchanged paused time alone cannot prove restoration');
assert.equal(pausedRecoveryPassed({ ...before, t: 124 }, { ...after, t: 124 }, 123), false, 'time must not advance during the outage before the held snapshot');
assert.equal(recoveredGpuIsHealthy({ contextLost: true, contextLifecycleLost: false }), false);
assert.equal(recoveredGpuIsHealthy({ contextLost: false, contextLifecycleLost: true }), false);

// The intentional pre-lifecycle baseline still waits for the native context.
// It is never accepted by the modern positive snapshot assertions above.
const legacyState = { lost: true };
const legacyRestore = vm.runInNewContext(`(${contextRestoreSettled.toString()})`, { window: { __qaRecoveryScene: { renderer: { getContext: () => ({ isContextLost: () => legacyState.lost }) } } } });
assert.equal(legacyRestore(), false); legacyState.lost = false; assert.equal(legacyRestore(), true);
assert.equal(recoveredGpuIsHealthy({ contextLost: false, contextLifecycleLost: null }), false);

const mobile = readFileSync(new URL('./verify-mobile-thrust.mjs', import.meta.url), 'utf8');
const drive = readFileSync(new URL('./verify-curvature-drive.mjs', import.meta.url), 'utf8');
for (const source of [mobile, drive]) {
    assert(source.includes('await prepareContextRecoveryQA(page);'));
    assert(!source.includes('waitForFunction(async'), 'both scoped GPU fixtures forbid Promise-returning polling');
    assert(source.includes('page.waitForFunction(contextRestoreSettled)'));
    assert(source.includes('recoveredGpuIsHealthy('), 'later snapshot assertion checks actual recovery independently');
}
assert(mobile.includes('pausedRecoveryPassed(pausedHeld,pausedRestored,preLossTime)'));
assert(mobile.includes('return window.__pausedTime;'), 'the pre-loss time is retained independently of later snapshots');
assert(mobile.includes('for(let i=0;i<1200;i++)'), 'full thrust frame count is retained');
console.log('GPU QA: synchronous serialized predicates reject initial/mixed/never-ready state; later assertions reject failed restore, absent loss and non-progressing or unpaused flight');
