// Context loss can precede its DOM event. Poll at frame boundaries as well as
// listening, so flight never advances blindly while the GPU is unavailable.
export function bindContextLifecycle(renderer, { onLost = () => {}, onRestored = () => {},
    onRecoveryTimeout = () => {}, recoveryTimeoutMs = 5000, schedule = setTimeout, cancel = clearTimeout } = {}) {
    const state = { lost: false, losses: 0, restores: 0, recoveryTimedOut: false };
    let deadline = null, disposed = false;
    function clearDeadline() {
        if (deadline !== null) cancel(deadline);
        deadline = null;
    }
    function hold() {
        if (state.lost || disposed) return;
        state.lost = true;
        state.recoveryTimedOut = false;
        const loss = ++state.losses;
        onLost();
        // A browser may never restore a genuinely lost context. Bound the
        // waiting UI, not the flight hold; only the native restore releases it.
        deadline = schedule(() => {
            if (disposed || !state.lost || state.losses !== loss) return;
            deadline = null;
            state.recoveryTimedOut = true;
            onRecoveryTimeout();
        }, recoveryTimeoutMs);
    }
    function lost(event) {
        event.preventDefault(); // permit browser-managed restoration
        hold();
    }
    function restored() {
        if (disposed || renderer.getContext().isContextLost()) return;
        clearDeadline();
        state.lost = false;
        state.recoveryTimedOut = false;
        state.restores++;
        onRestored();
    }
    renderer.domElement.addEventListener('webglcontextlost', lost);
    renderer.domElement.addEventListener('webglcontextrestored', restored);
    state.isLost = () => {
        if (renderer.getContext().isContextLost()) hold();
        return state.lost;
    };
    state.dispose = () => {
        disposed = true;
        clearDeadline();
        renderer.domElement.removeEventListener('webglcontextlost', lost);
        renderer.domElement.removeEventListener('webglcontextrestored', restored);
    };
    return state;
}

// getParameter returns null on a lost context. Loss may occur between a
// caller's isContextLost check and this query: never pass null to fromArray.
export function readRenderScissor(renderer, out) {
    const gl = renderer.getContext();
    if (gl.isContextLost()) return false;
    const box = gl.getParameter(gl.SCISSOR_BOX);
    if (!box) return false;
    out.fromArray(box);
    return true;
}
