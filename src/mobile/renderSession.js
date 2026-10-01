import { G, keys } from '../state.js';
import { setPaused } from '../timeCtl.js';
import { mobileProfile } from './renderPolicy.js';

const storageKey = 'ap_mobileGraphics', recoveryKey = 'ap_graphicsRecovery';
let stored = 'auto', recovering = false;
try { stored = localStorage.getItem(storageKey) || 'auto'; recovering = sessionStorage.getItem(recoveryKey) === 'safe'; } catch { /* private browsing */ }
const query = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const requested = query.get('graphics') || (recovering ? 'safe' : stored);
export const renderSession = {
    mobile: false, mode: ['auto', 'safe'].includes(requested) ? requested : 'auto',
    level: requested === 'safe' ? 2 : 0, interacting: false, lastInteraction: 0,
    state: 'ready', reason: '', contextLosses: 0, resets: 0, resizes: 0,
    frames: 0, skipped: 0, gpuPending: false, fenceWaitMs: 0, maxFenceWaitMs: 0, fenceSupported: false,
};
const resets = new Set(), profiles = new Set(), inputs = new Set();
const now = () => performance.now();
const notify = () => window.dispatchEvent(new Event('ap:render-status'));
export function onGraphicsReset(fn) { resets.add(fn); return () => resets.delete(fn); }
export function onGraphicsProfile(fn) { profiles.add(fn); return () => profiles.delete(fn); }
export function onInputCancel(fn) { inputs.add(fn); return () => inputs.delete(fn); }
export function cancelTouchInput() { keys.clear(); for (const fn of inputs) fn(); markInteraction(false); }
export function markInteraction(active) { renderSession.interacting = active; renderSession.lastInteraction = now(); }
export function interactionSettled() { return !renderSession.interacting && now() - renderSession.lastInteraction > 180; }
export function currentMobileProfile() { return mobileProfile(renderSession.level); }
export function setMobileGraphics(mode, persist = true) {
    renderSession.mode = mode === 'safe' ? 'safe' : 'auto';
    renderSession.level = renderSession.mode === 'safe' ? 2 : 0;
    if (persist) try { localStorage.setItem(storageKey, renderSession.mode); sessionStorage.removeItem(recoveryKey); } catch { /* optional preference */ }
    for (const fn of profiles) fn();
    notify();
}
function lowerQuality(reason) {
    renderSession.reason = reason;
    if (renderSession.level >= 2) return;
    renderSession.level++;
    for (const fn of profiles) fn();
    notify();
}
export function recoverGraphics() {
    cancelTouchInput(); setPaused(true, 'graphics recovery');
    setMobileGraphics('safe'); renderSession.resets++;
    // No physics reset and no context-loss/recreation loop. Three.js handles
    // restored resources; cached render-target *contents* must be invalidated.
    for (const fn of resets) fn();
    renderSession.reason = renderSession.state === 'lost' ? 'Waiting for the browser to restore graphics. Reload Safe is available; it resets unsaved simulation state.' : 'Graphics reset in Safe mode. Simulation is paused.';
    if (renderSession.state !== 'lost') renderSession.state = 'ready';
    notify();
}
export function reloadSafe() {
    try { sessionStorage.setItem(recoveryKey, 'safe'); } catch { /* URL also carries preference */ }
    const url = new URL(location.href); url.searchParams.set('graphics', 'safe');
    location.assign(url.href);
}

// Install once at the renderer's animation-loop boundary. main.js and WebXR
// still own the callback; tests can stop it with setAnimationLoop(null).
// A fence bounds mobile submissions to ONE in-flight frame, without waiting
// on the main thread. DOM input and controls keep receiving browser events.
export function installRenderSession(renderer, beforeFrame = () => {}) {
    const canvas = renderer.domElement;
    let sync = null, submitted = 0, lastFrame = 0, slowFrames = 0;
    const clearFence = () => {
        const gl = renderer.getContext();
        if (sync && !gl.isContextLost()) gl.deleteSync(sync);
        sync = null; submitted = 0; renderSession.gpuPending = false;
    };
    const invalidate = reason => {
        clearFence(); cancelTouchInput(); setPaused(true, reason);
        for (const fn of resets) fn();
        lastFrame = 0;
    };
    onGraphicsReset(clearFence);
    canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        renderSession.contextLosses++; renderSession.state = 'lost';
        renderSession.reason = 'Graphics context lost. Waiting for the browser to restore it.';
        if (renderSession.mobile) {
            renderSession.mode = 'safe'; renderSession.level = 2;
            try { sessionStorage.setItem(recoveryKey, 'safe'); } catch { /* best effort */ }
            for (const fn of profiles) fn();
        }
        invalidate('graphics context lost'); notify();
    });
    canvas.addEventListener('webglcontextrestored', () => {
        invalidate('graphics restored'); renderSession.state = 'ready';
        renderSession.reason = 'Graphics restored. Simulation remains paused.';
        notify();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            // Cancel a time jump as well as thrust. There is no hidden-tab
            // simulation catch-up on return; resuming time is a deliberate tap.
            cancelTouchInput(); setPaused(true, 'tab hidden');
            renderSession.state = 'hidden';
        } else if (!renderer.getContext().isContextLost()) {
            clearFence(); lastFrame = 0; renderSession.state = 'ready';
            renderSession.reason = 'Returned to the scene. Tap Play to resume time.';
        }
        notify();
    });
    window.addEventListener('pagehide', () => { cancelTouchInput(); setPaused(true, 'page hidden'); });
    window.addEventListener('pageshow', event => { if (event.persisted) { invalidate('page restored'); notify(); } });
    const setLoop = renderer.setAnimationLoop.bind(renderer);
    renderer.setAnimationLoop = callback => {
        clearFence();
        setLoop(callback == null ? null : (...args) => {
            if (document.hidden || renderer.getContext().isContextLost() || ['lost', 'failed'].includes(renderSession.state)) { renderSession.skipped++; return; }
            const t = now(), gl = renderer.getContext(), mobile = renderSession.mobile && !renderer.xr.isPresenting;
            if (sync) {
                const result = gl.clientWaitSync(sync, 0, 0);
                renderSession.fenceWaitMs = t - submitted;
                renderSession.maxFenceWaitMs = Math.max(renderSession.maxFenceWaitMs, t - submitted);
                if (result === gl.TIMEOUT_EXPIRED) {
                    renderSession.skipped++;
                    if (t - submitted > 1500 && renderSession.state !== 'slow') {
                        lowerQuality('A long GPU submission was detected. Reduced graphics budget.');
                        renderSession.state = 'slow'; notify();
                    }
                    return;
                }
                if (result === gl.WAIT_FAILED) { clearFence(); recoverGraphics(); return; }
                if (t - submitted > 120) slowFrames++; else slowFrames = 0;
                if (slowFrames >= 3) { lowerQuality('Sustained slow rendering. Reduced graphics budget.'); slowFrames = 0; }
                clearFence();
                if (renderSession.state === 'slow') { renderSession.state = 'ready'; notify(); }
            }
            if (mobile && lastFrame && t - lastFrame < 1000 / 30 - 1) { renderSession.skipped++; return; }
            try { beforeFrame(); lastFrame = t; callback(...args); renderSession.frames++; }
            catch (error) {
                renderSession.state = 'failed'; renderSession.reason = String(error?.message || error);
                cancelTouchInput(); setPaused(true, 'render failure'); notify(); console.error(error); return;
            }
            if (mobile && gl.fenceSync && !gl.isContextLost()) {
                sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); submitted = now(); gl.flush();
                renderSession.fenceSupported = !!sync; renderSession.gpuPending = !!sync;
            }
        });
    };
    window.__mobileDiagnostics = () => ({ ...renderSession, build: typeof __BUILD_ID__ === 'undefined' ? 'local' : __BUILD_ID__, profile: currentMobileProfile(),
        canvas: [canvas.width, canvas.height], dpr: renderer.getPixelRatio(),
        volume: window.__volStatus?.(), userAgent: navigator.userAgent,
        viewport: [innerWidth, innerHeight], visualViewport: window.visualViewport ? {width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale} : null,
        resources: { ...renderer.info.memory, programs: renderer.info.programs?.length || 0 },
        view: { focus:G.focus, distance:window.__cam?.dist, epoch:G.t, paused:G.paused, warp:G.warp },
        timingNote: 'Fence wait includes browser scheduling; it is not a hardware GPU benchmark.' });
}
