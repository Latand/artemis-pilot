// WP18 — WebXR performance budgets: fixed foveation, best-effort dynamic
// resolution, and a bloom-gating signal for the main render loop.
//
// VERIFIED against the installed three@0.164.1 (node_modules/three/build/
// three.module.js, WebXRManager):
//   - `renderer.xr.setFoveation(v)` applies LIVE, even mid-session — it sets
//     `glProjLayer.fixedFoveation`/`glBaseLayer.fixedFoveation` immediately
//     when a layer already exists (three.module.js:27112-27129).
//   - `renderer.xr.setFramebufferScaleFactor(v)` stores the value unconditionally,
//     but only reads it when a NEW `XRWebGLLayer`/`XRProjectionLayer` is built
//     in `setSession()` (three.module.js:26761,26799). If a session is already
//     presenting it prints "Cannot change framebuffer scale while presenting"
//     and has no effect on the current session's resolution
//     (three.module.js:26668-26678). So true per-frame dynamic resolution via
//     this API is NOT possible in this three version; the best available
//     lever is "prime the scale that the *next* session will start at",
//     which still matters in practice (headset sleep/guardian pauses restart
//     sessions routinely). This module treats that as its resolution lever
//     and additionally exposes `shouldGateBloom()` as the lever that IS live
//     within a session, for the main loop to fold into its bloom decision.

import { PERF } from "../perf.js";

const WINDOW = 60;                 // rolling frame-time samples
const P95_INDEX = Math.floor(WINDOW * 0.95); // 57 of 60, sorted ascending
const STEP = 0.05;
const SCALE_FLOOR = 0.7;
const SCALE_CEIL = 1.0;
const OVERLOAD_FACTOR = 1.15;      // p95 above target*this => step down
const UNDERLOAD_FACTOR = 0.85;     // p95 below target*this => comfortably under
const DWELL_OVERLOAD_MS = 500;     // sustained overload before stepping down
const DWELL_UNDERLOAD_MS = 1500;   // sustained headroom before stepping up (asymmetric: recover slowly, no oscillation)
const DEFAULT_TARGET_HZ = 90;
const BLOOM_GATE_FACTOR = 1.05;    // p95 above target*this gates bloom this session

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export { SCALE_FLOOR, SCALE_CEIL, STEP, WINDOW, DWELL_OVERLOAD_MS, DWELL_UNDERLOAD_MS };

// ---------------------------------------------------------------------------
// Pure dynamic-resolution controller. No renderer/DOM access — safe to drive
// with a synthetic frame-time series from a Node smoke test.
// ---------------------------------------------------------------------------
export function createResController(initialScale = SCALE_CEIL) {
    return {
        ring: new Float32Array(WINDOW),     // circular frame-time buffer, ms (zero-filled: biases early frames toward "not overloaded")
        scratch: new Float32Array(WINDOW),  // reused sort buffer, never reallocated
        idx: 0,
        framesSeen: 0,
        scale: clamp(initialScale, SCALE_FLOOR, SCALE_CEIL),
        overloadMs: 0,
        underloadMs: 0,
        p95: 0,
    };
}

function computeP95(state) {
    state.scratch.set(state.ring);
    state.scratch.sort(); // Float32Array#sort is numeric by default, in-place, zero-alloc
    return state.scratch[P95_INDEX];
}

/**
 * Feed one frame's duration (ms) into the rolling window and step
 * `state.scale` with dwell + hysteresis. Pure and allocation-free per call
 * (the window fills with preallocated typed arrays; only comparisons/adds).
 * @param {boolean} allowStep - when false, p95/dwell bookkeeping still runs
 *   (so shouldGateBloom() stays accurate) but the scale itself never steps.
 * @returns {boolean} true iff state.scale changed this call.
 */
export function feedFrameTime(state, dtMs, targetMs, allowStep = true) {
    state.ring[state.idx] = dtMs;
    state.idx = (state.idx + 1) % WINDOW;
    state.framesSeen++;
    state.p95 = computeP95(state);

    const overloaded = state.p95 > targetMs * OVERLOAD_FACTOR;
    const underloaded = state.p95 < targetMs * UNDERLOAD_FACTOR;

    if (!allowStep || state.framesSeen < WINDOW) {
        // window still warming up (or stepping disabled) — track dwell decay
        // only, never step, so a stale streak can't fire once stepping resumes
        if (!overloaded) state.overloadMs = 0;
        if (!underloaded) state.underloadMs = 0;
        return false;
    }

    const before = state.scale;
    if (overloaded) {
        state.overloadMs += dtMs;
        state.underloadMs = 0;
        if (state.overloadMs >= DWELL_OVERLOAD_MS && state.scale > SCALE_FLOOR) {
            state.scale = Math.max(SCALE_FLOOR, Math.round((state.scale - STEP) * 100) / 100);
            state.overloadMs = 0;
        }
    } else if (underloaded) {
        state.underloadMs += dtMs;
        state.overloadMs = 0;
        if (state.underloadMs >= DWELL_UNDERLOAD_MS && state.scale < SCALE_CEIL) {
            state.scale = Math.min(SCALE_CEIL, Math.round((state.scale + STEP) * 100) / 100);
            state.underloadMs = 0;
        }
    } else {
        // in the comfortable middle band — reset both streaks so returning to
        // an edge always requires a fresh full dwell (no oscillation)
        state.overloadMs = 0;
        state.underloadMs = 0;
    }
    return state.scale !== before;
}

/** Target frame budget (ms) for an XRSession, from its live frame rate when
 * available, else the highest supported rate, else `fallbackHz`. */
export function targetMsFromSession(session, fallbackHz = DEFAULT_TARGET_HZ) {
    let hz = session && typeof session.frameRate === "number" ? session.frameRate : 0;
    if (!hz && session && Array.isArray(session.supportedFrameRates) && session.supportedFrameRates.length) {
        hz = session.supportedFrameRates[session.supportedFrameRates.length - 1];
    }
    if (!hz || hz <= 0) hz = fallbackHz;
    return 1000 / hz;
}

// ---------------------------------------------------------------------------
// Renderer-facing wiring
// ---------------------------------------------------------------------------
let ctrl = null;
let targetMs = 1000 / DEFAULT_TARGET_HZ;
let dynResEnabled = true;
let gateBloom = false;
let lastAppliedScale = SCALE_CEIL;

function readQuery() {
    try { return new URLSearchParams(location.search); } catch (e) { return null; }
}

function resetSessionBaseline(renderer) {
    targetMs = targetMsFromSession(renderer.xr.getSession());
    ctrl.ring.fill(0);
    ctrl.idx = 0;
    ctrl.framesSeen = 0;
    ctrl.overloadMs = 0;
    ctrl.underloadMs = 0;
    gateBloom = false;
}

/** Call once at startup, before the first XR session is requested. Sets
 * foveation (live) and primes the framebuffer scale factor for the next
 * session (see module header — cannot affect an in-progress session). */
export function initXrPerf(renderer) {
    const q = readQuery();
    const foveationOverride = q ? parseFloat(q.get("foveation")) : NaN;
    const foveation = Number.isFinite(foveationOverride) ? clamp(foveationOverride, 0, 1) : 1;
    renderer.xr.setFoveation(foveation);

    const resOverride = q ? parseFloat(q.get("xrres")) : NaN;
    const initialScale = Number.isFinite(resOverride) ? clamp(resOverride, SCALE_FLOOR, SCALE_CEIL) : SCALE_CEIL;
    dynResEnabled = !(q && q.get("xrdynres") === "0");

    ctrl = createResController(initialScale);
    lastAppliedScale = ctrl.scale;
    renderer.xr.setFramebufferScaleFactor(ctrl.scale);

    renderer.xr.addEventListener("sessionstart", () => resetSessionBaseline(renderer));
    syncPerfState(renderer, renderer.xr.isPresenting);
    return { foveation, initialScale, dynResEnabled };
}

/** Call once per frame with the renderer and this frame's real elapsed time
 * (ms, unclamped). No-op bookkeeping outside an active XR session. */
export function tickXrPerf(renderer, dtMs) {
    if (!ctrl) initXrPerf(renderer);
    const presenting = renderer.xr.isPresenting;
    if (!presenting) {
        gateBloom = false;
        syncPerfState(renderer, presenting);
        return;
    }
    const changed = feedFrameTime(ctrl, dtMs, targetMs, dynResEnabled);
    if (changed && ctrl.scale !== lastAppliedScale) {
        // Primes the NEXT session only — see module header. Intentionally
        // still called every actual step so a session that restarts mid-ride
        // (headset sleep, guardian pause) picks up the learned scale.
        renderer.xr.setFramebufferScaleFactor(ctrl.scale);
        lastAppliedScale = ctrl.scale;
    }
    gateBloom = ctrl.p95 > targetMs * BLOOM_GATE_FACTOR;
    syncPerfState(renderer, presenting);
}

/** Live lever for the main bloom toggle: true only while presenting in XR
 * and sustained frame time is over budget. OR this into the existing
 * bloom-load-shed boolean; false (never gates) outside of XR. */
export function shouldGateBloom() {
    return gateBloom;
}

function syncPerfState(renderer, presenting) {
    if (!PERF.enabled) return;
    if (!PERF.xr) {
        PERF.xr = {
            presenting: false, targetMs: 0, p95Ms: 0, scale: SCALE_CEIL,
            appliedScale: SCALE_CEIL, foveation: 1, gateBloom: false, dynResEnabled: true,
        };
    }
    const x = PERF.xr;
    x.presenting = presenting;
    x.targetMs = targetMs;
    x.p95Ms = ctrl ? ctrl.p95 : 0;
    x.scale = ctrl ? ctrl.scale : SCALE_CEIL;
    x.appliedScale = lastAppliedScale;
    x.foveation = renderer.xr.getFoveation() ?? 1;
    x.gateBloom = gateBloom;
    x.dynResEnabled = dynResEnabled;
}
