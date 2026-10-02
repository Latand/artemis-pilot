// Context loss can precede its DOM event. Poll at frame boundaries as well as
// listening, so flight never advances blindly while the GPU is unavailable.
export function bindContextLifecycle(renderer, { onLost = () => {}, onRestored = () => {} } = {}) {
    const state = { lost: false, losses: 0, restores: 0 };
    function hold() {
        if (state.lost) return;
        state.lost = true;
        state.losses++;
        onLost();
    }
    renderer.domElement.addEventListener('webglcontextlost', event => {
        event.preventDefault(); // permit browser-managed restoration
        hold();
    });
    renderer.domElement.addEventListener('webglcontextrestored', () => {
        state.lost = false;
        state.restores++;
        onRestored();
    });
    state.isLost = () => {
        if (renderer.getContext().isContextLost()) hold();
        return state.lost;
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
