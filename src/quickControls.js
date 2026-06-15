// On-screen zoom + time-warp controls. Zoom (hold to keep zooming) drives the
// orbit camera distance directly; warp steps the sim clock ×2 / ÷2. These exist
// on both desktop (in the flight deck) and mobile (edge clusters) so neither
// platform has to reach for the scroll wheel or a buried menu.
import { cam } from "./scene.js";
import { G } from "./state.js";
import { WARP_MAX, CAM_DIST_MAX } from "./constants.js";

const $ = id => document.getElementById(id);

function zoom(factor) {
    cam.dist = Math.min(CAM_DIST_MAX, Math.max(.03, cam.dist * factor));
    cam.distTarget = null; // manual zoom cancels any fly-in
}
function warp(faster) {
    G.warp = faster ? Math.min(WARP_MAX, G.warp * 2) : Math.max(1, G.warp / 2);
}

// press-and-hold: fire once immediately, then repeat while held
function bindHold(id, fn) {
    const el = $(id);
    if (!el) return;
    let timer = 0;
    const stop = () => { if (timer) { clearInterval(timer); timer = 0; } el.classList.remove("qcDown"); };
    el.addEventListener("pointerdown", e => {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch (err) { }
        fn();
        stop();
        timer = setInterval(fn, 70);
        el.classList.add("qcDown");
    });
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
    el.addEventListener("lostpointercapture", stop);
}
function bindTap(id, fn) {
    const el = $(id);
    if (!el) return;
    el.addEventListener("click", e => { e.preventDefault(); fn(); });
}

export function initQuickControls() {
    bindHold("dZoomIn", () => zoom(.92));
    bindHold("dZoomOut", () => zoom(1.08));
    bindHold("mZoomIn", () => zoom(.9));
    bindHold("mZoomOut", () => zoom(1.1));
    bindTap("dWarpDown", () => warp(false));
    bindTap("dWarpUp", () => warp(true));
    bindTap("mWarpDown2", () => warp(false));
    bindTap("mWarpUp2", () => warp(true));
}
