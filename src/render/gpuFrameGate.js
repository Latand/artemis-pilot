// Bound the live WebGL2 queue without blocking the browser thread. RAF can run
// ahead of software GPU completion; submission time is not completed work.
export function createGpuFrameGate(getContext, { fallbackIntervalMs = 1000 / 30, stallMs = 4000, onStall = () => {}, onRecovered = () => {} } = {}) {
    const stats = { supported: null, fallback: false, fallbackIntervalMs,
        inFlight: false, stalled: false, submitted: 0, fenced: 0, completed: 0, discarded: 0, waits: 0, failures: 0, maxPendingMs: 0 };
    let sync = null, owner = null, submittedAt = -Infinity;
    let disabled = false, disposed = false;
    function clearStall() {
        if (!stats.stalled) return;
        stats.stalled = false; onRecovered();
    }
    function release(discard = true) {
        if (sync && discard) stats.discarded++;
        if (sync && owner && !owner.isContextLost()) owner.deleteSync(sync);
        sync = owner = null; stats.inFlight = false;
    }
    function context() {
        const gl = getContext();
        stats.supported = !disabled && typeof gl.fenceSync === 'function' &&
            typeof gl.clientWaitSync === 'function' && typeof gl.deleteSync === 'function';
        stats.fallback = !stats.supported;
        return gl;
    }
    function reset() {
        release(); disabled = disposed = false; submittedAt = -Infinity; clearStall();
        context();
    }
    function fail() {
        release(); disabled = true; stats.supported = false; stats.fallback = true; stats.failures++; clearStall();
    }
    function ready(now) {
        if (disposed) return false;
        const gl = context();
        if (gl.isContextLost()) { release(); return false; }
        if (!stats.supported) return true; // The main phase-preserving pacer owns fallback admission.
        if (!sync) return true;
        if (owner !== gl) { reset(); return true; }
        let status;
        try { status = gl.clientWaitSync(sync, 0, 0); } // Zero timeout: never a CPU/GPU fence wait.
        catch { fail(); return true; }
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
            release(false); clearStall(); stats.completed++; return true;
        }
        if (status === gl.WAIT_FAILED) { fail(); return true; }
        stats.waits++;
        const pendingMs = Math.max(0, now - submittedAt);
        stats.maxPendingMs = Math.max(stats.maxPendingMs, pendingMs);
        if (pendingMs >= stallMs && !stats.stalled) { stats.stalled = true; onStall(); }
        return false;
    }
    function submitted(now) {
        if (disposed) return;
        const gl = context();
        if (gl.isContextLost()) { release(); return; }
        stats.submitted++;
        if (!stats.supported || sync) return;
        try {
            sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            if (!sync) { fail(); return; }
            owner = gl; submittedAt = now; stats.inFlight = true; stats.fenced++;
            gl.flush(); // Dispatch commands; unlike finish/readPixels this does not wait for completion.
        } catch { fail(); }
    }
    function dispose() { release(); clearStall(); disposed = true; }
    context();
    return { stats, ready, submitted, reset, dispose };
}
