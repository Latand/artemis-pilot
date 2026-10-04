// Host-side setup imports the production module before Playwright polling.
// The exported predicates are serialized into the page and return booleans
// immediately; a Promise would be truthy even while restoration is pending.
export async function prepareContextRecoveryQA(page) {
    await page.evaluate(async () => { window.__qaRecoveryScene = await import('/src/scene.js'); });
}

export function contextLossSettled() {
    const s = window.__qaRecoveryScene;
    return s.renderer.getContext().isContextLost() && (s.renderContext?.isLost() ?? true);
}

export function contextRestoreSettled() {
    const s = window.__qaRecoveryScene;
    return !s.renderer.getContext().isContextLost() && !(s.renderContext?.isLost() ?? false);
}

export function recoveredGpuIsHealthy(snapshot) {
    return snapshot.contextLost === false && snapshot.contextLifecycleLost === false;
}

export function pausedRecoveryPassed(before, after, preLossTime) {
    return before.paused === true && before.contextLost === true && before.contextLifecycleLost === true
        && before.t === preLossTime && after.paused === true && after.t === preLossTime && after.success > before.success
        && recoveredGpuIsHealthy(after);
}
