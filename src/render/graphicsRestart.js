// One user-requested WebGL restart, with bounded failure reporting. It never
// resets physics, reloads the page, or retries automatically.
export function createGraphicsRestart(renderer, { onState = () => {},
    schedule = setTimeout, cancel = clearTimeout, timeoutMs = 5000 } = {}) {
    const state = { pending: false, status: 'idle' };
    let deadline = null, restoreTimer = null, extension = null, lossSettled = false, disposed = false;
    const canvas = renderer.domElement;
    function cleanup() {
        if (deadline !== null) cancel(deadline);
        if (restoreTimer !== null) cancel(restoreTimer);
        deadline = restoreTimer = extension = null;
    }
    function finish(status) { cleanup(); state.pending = false; state.status = status; onState(status); }
    function restored() {
        if (renderer.getContext().isContextLost()) return;
        lossSettled = false;
        if (state.pending) finish('restored');
    }
    function requestRestore() {
        if (!state.pending || !lossSettled || restoreTimer !== null) return;
        restoreTimer = schedule(() => {
            restoreTimer = null;
            if (!state.pending) return;
            try { extension.restoreContext(); } catch { finish('failed'); }
        }, 100);
    }
    function lost() {
        if (!renderer.getContext().isContextLost()) return;
        lossSettled = true; requestRestore();
    }
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    function restart() {
        if (state.pending || disposed) return false;
        try { extension = renderer.getContext().getExtension('WEBGL_lose_context'); }
        catch { extension = null; }
        if (!extension) { finish('unavailable'); return false; }
        state.pending = true; state.status = 'restarting'; onState(state.status);
        deadline = schedule(() => { if (state.pending) finish('timeout'); }, timeoutMs);
        try {
            if (renderer.getContext().isContextLost()) requestRestore();
            else { lossSettled = false; extension.loseContext(); }
        } catch { finish('failed'); return false; }
        return true;
    }
    function dispose() {
        const pending = state.pending;
        cleanup(); state.pending = false; state.status = 'cancelled'; disposed = true;
        canvas.removeEventListener('webglcontextlost', lost);
        canvas.removeEventListener('webglcontextrestored', restored);
        if (pending) onState('cancelled');
    }
    return { state, restart, dispose };
}
