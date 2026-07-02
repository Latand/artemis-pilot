import { toast } from "./achievements.js";
import { G, GS, BH } from "./state.js";
import { WARPS, WARP_MAX, WARP_MIN, warpStepDown, warpStepUp } from "./constants.js";

let jumpPlan = null;
let lastWarp = G.warp;
let externalTimeDriver = false;

function clampWarp(w) {
    const n = Number(w);
    if (!Number.isFinite(n)) return G.warp;
    return Math.max(WARP_MIN, Math.min(WARP_MAX, n));
}

function noteWarpWrite() {
    lastWarp = G.warp;
}

export function setWarp(w, source = "user") {
    if (source !== "jump") cancelTimeJump(source);
    G.warp = clampWarp(w);
    noteWarpWrite();
    return G.warp;
}

export function stepWarp(dir, source = "user") {
    return setWarp(dir < 0 ? warpStepDown(G.warp) : warpStepUp(G.warp), source);
}

export function setPaused(p, source = "user") {
    if (source !== "jump") cancelTimeJump(source);
    G.paused = !!p;
    return G.paused;
}

export function cancelTimeJump(reason) {
    if (!jumpPlan) return false;
    jumpPlan = null;
    toast("Jump cancelled — " + reason);
    noteWarpWrite();
    return true;
}

export function startTimeJump(plan) {
    jumpPlan = plan || {};
    noteWarpWrite();
    return jumpPlan;
}

export function jumpActive() {
    return !!jumpPlan;
}

export function jumpSaveWarp() {
    if (!jumpPlan) return G.warp;
    return Number.isFinite(jumpPlan.holdWarp) ? jumpPlan.holdWarp :
        Number.isFinite(jumpPlan.hold?.warp) ? jumpPlan.hold.warp :
            G.warp;
}

export function tickJump(dtR) {
    if (jumpPlan && !externalTimeDriver && G.warp !== lastWarp) cancelTimeJump("time changed");
    noteWarpWrite();
}

export function setExternalTimeDriver(on) {
    const next = !!on;
    if (next && !externalTimeDriver) cancelTimeJump("external time");
    externalTimeDriver = next;
    if (externalTimeDriver) noteWarpWrite();
}

export function maxFeasibleWarp({ gsCount = GS.length, landed = !!G.landed, dead = G.dead, bhN = BH.n } = {}) {
    if (dead) return 0;
    if (gsCount > 0 || landed || bhN > 0) return Math.min(600, WARP_MAX);
    return WARPS[WARPS.length - 1];
}
