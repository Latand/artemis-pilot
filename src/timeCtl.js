import { toast } from "./achievements.js";
import { G, GS, BH, WORLD } from "./state.js";
import { WARP_MAX, WARP_MIN, warpStepDown, warpStepUp } from "./constants.js";
import {
    createJumpRuntime,
    maxFeasibleWarpScalar as feasibleWarpForStateScalar,
    safeJumpRestoreWarp,
    settleJumpRuntime,
    stepJumpRuntime,
} from "./universe/eventTimeline.js";

let jumpState = null;
let externalTimeDriver = false;
const jumpView = {
    active: false,
    label: "",
    etaWallSec: 0,
    outcome: "",
};
const tickInput = {
    wallDeltaSec: 0,
    physicsDeltaSec: 0,
    simTimeSec: 0,
    currentWarp: 0,
    tdeInProgress: false,
    externalTimeDriver: false,
    dead: false,
    landed: false,
    thrusting: false,
    feasibleWarp: 0,
};
const settleInput = {
    deliveredAdvanceSec: 0,
    simTimeSec: 0,
    tdeInProgress: false,
    dead: false,
    landed: false,
    thrusting: false,
    feasibleWarp: 0,
};

function clampWarp(w) {
    const n = Number(w);
    if (!Number.isFinite(n)) return G.warp;
    return Math.max(WARP_MIN, Math.min(WARP_MAX, n));
}

export function setWarp(w, source = "user") {
    if (source !== "jump") cancelTimeJump(source);
    G.warp = clampWarp(w);
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

function liveFeasibleWarp() {
    return feasibleWarpForStateScalar(GS.length, !!G.landed, G.dead, BH.n);
}

function liveTerminalFeasibleWarp(thrusting = false) {
    const feasibleWarp = liveFeasibleWarp();
    return WORLD.tdeInProgress || thrusting ? Math.min(600, feasibleWarp) : feasibleWarp;
}

export function cancelTimeJump(reason) {
    if (!jumpState) return false;
    const restoreWarp = jumpState.restoreWarp;
    jumpState = null;
    clearJumpView("cancel");
    setWarp(safeJumpRestoreWarp(restoreWarp, liveTerminalFeasibleWarp()), "jump");
    toast("Jump cancelled — " + reason);
    return true;
}

export function startTimeJump(plan, meta = {}) {
    if (plan?.ok !== true || WORLD.tdeInProgress || G.dead || G.landed) return false;
    const candidate = createJumpRuntime(plan, meta, {
        currentWarp: G.warp,
        tdeInProgress: WORLD.tdeInProgress,
        simTimeSec: G.t,
        feasibleWarp: liveFeasibleWarp(),
    });
    if (!candidate.validPlan) return false;
    jumpState = candidate;
    jumpView.active = true;
    jumpView.label = String(meta.label || "EVENT");
    jumpView.etaWallSec = Number.isFinite(plan?.etaWallSec) ? plan.etaWallSec : 0;
    jumpView.outcome = "";
    setPaused(false, "jump");
    return jumpState;
}

export function jumpActive() {
    return !!jumpState;
}

export function jumpSaveWarp() {
    if (!jumpState) return G.warp;
    const plan = jumpState.plan;
    return Number.isFinite(plan.holdWarp) ? plan.holdWarp :
        Number.isFinite(plan.hold?.warp) ? plan.hold.warp :
            G.warp;
}

function clearJumpView(outcome = "") {
    jumpView.active = false;
    jumpView.label = "";
    jumpView.etaWallSec = 0;
    jumpView.outcome = outcome;
}

export function tickJump(wallDtR, physicsDtR = wallDtR, thrusting = false) {
    if (!jumpState) return null;
    const state = jumpState;
    tickInput.wallDeltaSec = wallDtR;
    tickInput.physicsDeltaSec = physicsDtR;
    tickInput.simTimeSec = G.t;
    tickInput.currentWarp = G.warp;
    tickInput.tdeInProgress = WORLD.tdeInProgress;
    tickInput.externalTimeDriver = externalTimeDriver;
    tickInput.dead = G.dead;
    tickInput.landed = !!G.landed;
    tickInput.thrusting = !!thrusting;
    tickInput.feasibleWarp = liveFeasibleWarp();
    const result = stepJumpRuntime(state, tickInput);
    if (result.kind !== "run") {
        finishTimeJump(result, thrusting);
        return null;
    }
    setWarp(result.warp, "jump");
    jumpView.etaWallSec = result.etaWallSec;
    return result;
}

function finishTimeJump(result, thrusting = false) {
    const restoreWarp = safeJumpRestoreWarp(result.warp, liveTerminalFeasibleWarp(thrusting));
    if (result.kind === "cancel") {
        jumpState = null;
        clearJumpView("cancel");
        setWarp(restoreWarp, "jump");
        toast("Jump cancelled — " + result.reason);
        return;
    }
    if (result.kind === "tde") {
        jumpState = null;
        clearJumpView("cancel");
        setWarp(restoreWarp, "jump");
        toast("Tidal disruption in progress — jump cancelled to watch");
        return;
    }
    if (result.kind === "arrive") {
        const label = jumpView.label;
        jumpState = null;
        clearJumpView("arrive");
        setWarp(restoreWarp, "jump");
        toast("Arrived at " + label);
        return;
    }
}

export function settleTimeJump(frameResult, deliveredAdvanceSec, thrusting = false) {
    if (!jumpState || jumpState.result !== frameResult) return null;
    settleInput.deliveredAdvanceSec = deliveredAdvanceSec;
    settleInput.simTimeSec = G.t;
    settleInput.tdeInProgress = WORLD.tdeInProgress;
    settleInput.dead = G.dead;
    settleInput.landed = !!G.landed;
    settleInput.thrusting = !!thrusting;
    settleInput.feasibleWarp = liveFeasibleWarp();
    const result = settleJumpRuntime(jumpState, settleInput);
    if (result.kind === "run") jumpView.etaWallSec = result.etaWallSec;
    else finishTimeJump(result, thrusting);
    return result;
}

export function jumpStatus() {
    return jumpView;
}

export function setExternalTimeDriver(on) {
    const next = !!on;
    if (next && !externalTimeDriver) cancelTimeJump("external time");
    externalTimeDriver = next;
}

export function maxFeasibleWarp({ gsCount = GS.length, landed = !!G.landed, dead = G.dead, bhN = BH.n } = {}) {
    return feasibleWarpForStateScalar(gsCount, landed, dead, bhN);
}
