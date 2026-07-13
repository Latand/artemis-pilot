import { SEC_YEAR, WARPS, WARP_MAX } from "../constants.js";
import { resolveJumpFrameDelivery } from "./jumpFrame.js";
import { engulfmentEvents, sunPhaseEvents } from "./sunTimeline.js";

const GYR_SEC = 1e9 * SEC_YEAR;
export const JUMP_HOLD_WARP = 1e6 * SEC_YEAR;
export const JUMP_LEAD_SEC = 1e7 * SEC_YEAR;
export const CRUISE_WALL_S = 6;
export const RUNG_WALL_S = 0.7;

const FIRST_LADDER_RUNG = WARPS.indexOf(1);
const GHOST_REASON = "deep time blocked: absorbed matter's gravity ghosts force step-by-step physics";

function mergerRows(merger) {
    if (!merger) return [];
    const uncertainty = "modeled scenario; the real encounter is uncertain — Sawala et al. 2025";
    return [
        {
            id: "m31-first-passage",
            label: "MW–M31 first passage (" + uncertainty + ")",
            tSimSec: merger.firstPassageGyr * GYR_SEC,
            focus: "m31",
            tier: "modeled",
            qualifier: "contingent scenario",
        },
        {
            id: "m31-merger-scenario",
            label: "MW–M31 coalescence (" + uncertainty + ")",
            tSimSec: merger.mergedGyr * GYR_SEC,
            focus: "m31",
            tier: "modeled",
            qualifier: "contingent scenario",
        },
    ].filter(row => Number.isFinite(row.tSimSec));
}

export function buildTimeline({ nowSec = 0, merger } = {}) {
    void nowSec;
    return [...sunPhaseEvents(), ...engulfmentEvents(), ...mergerRows(merger)]
        .sort((a, b) => a.tSimSec - b.tSimSec || a.id.localeCompare(b.id));
}

export function maxFeasibleWarpScalar(gsCount = 0, landed = false, dead = false, bhN = 0) {
    void bhN;
    if (dead) return 0;
    if (gsCount > 0 || landed) return Math.min(600, WARP_MAX);
    return WARP_MAX;
}

export function maxFeasibleWarp({ gsCount = 0, landed = false, dead = false, bhN = 0 } = {}) {
    return maxFeasibleWarpScalar(gsCount, landed, dead, bhN);
}

export function pickJumpWarp(spanSec, feas) {
    if (!(spanSec > 0) || !(feas > 0)) return 0;
    const required = spanSec / CRUISE_WALL_S;
    for (const warp of WARPS) {
        if (warp >= required) return Math.min(warp, feas);
        if (warp >= feas) return feas;
    }
    return Math.min(WARP_MAX, feas);
}

function shortJumpPlan(nowSec, targetSec, feas) {
    const remaining = targetSec - nowSec;
    let warp = Math.min(JUMP_HOLD_WARP, feas);
    if (remaining / warp < 1) {
        warp = WARPS[0];
        for (const rung of WARPS) {
            if (rung > feas || rung > remaining) break;
            warp = rung;
        }
    }
    return {
        ok: true,
        targetSec,
        legs: [{ kind: "hold", warp, fromSimT: nowSec, toSimT: targetSec, wallSec: remaining / warp }],
        holdWarp: warp,
        etaWallSec: remaining / warp,
    };
}

function enforceCappedJumpEta(plan, feas) {
    if (feas <= 600 && plan.etaWallSec > 60) return { ok: false, reason: GHOST_REASON };
    return plan;
}

export function planJump(nowSec, targetSec, feas) {
    if (!Number.isFinite(nowSec) || !Number.isFinite(targetSec) || !(targetSec > nowSec)) {
        return { ok: false, reason: "jump target must be in the future" };
    }
    if (!(feas > 0)) return { ok: false, reason: "jump unavailable while the vehicle is lost" };
    const span = targetSec - JUMP_LEAD_SEC - nowSec;
    if (span <= 0) return enforceCappedJumpEta(shortJumpPlan(nowSec, targetSec, feas), feas);

    const cruiseWarp = pickJumpWarp(span, feas);
    const cruiseEnd = targetSec - JUMP_LEAD_SEC;
    const legs = [];
    let cursor = nowSec;
    let etaWallSec = 0;
    const cruiseIndex = WARPS.indexOf(cruiseWarp);
    const lastRung = cruiseIndex >= 0 ? cruiseIndex : WARPS.findIndex(warp => warp >= cruiseWarp);
    for (let i = Math.max(0, FIRST_LADDER_RUNG); i <= lastRung && cursor < cruiseEnd; i++) {
        const warp = Math.min(WARPS[i], cruiseWarp);
        const toSimT = Math.min(cruiseEnd, cursor + warp * RUNG_WALL_S);
        if (!(toSimT > cursor)) continue;
        const wallSec = (toSimT - cursor) / warp;
        legs.push({ kind: "rung", warp, fromSimT: cursor, toSimT, wallSec });
        cursor = toSimT;
        etaWallSec += wallSec;
    }
    if (cursor < cruiseEnd) {
        const wallSec = (cruiseEnd - cursor) / cruiseWarp;
        legs.push({ kind: "cruise", warp: cruiseWarp, fromSimT: cursor, toSimT: cruiseEnd, wallSec });
        cursor = cruiseEnd;
        etaWallSec += wallSec;
    }
    const holdWarp = Math.min(JUMP_HOLD_WARP, feas);
    const holdWallSec = (targetSec - cursor) / holdWarp;
    legs.push({ kind: "hold", warp: holdWarp, fromSimT: cursor, toSimT: targetSec, wallSec: holdWallSec });
    etaWallSec += holdWallSec;
    return enforceCappedJumpEta({ ok: true, targetSec, legs, holdWarp, etaWallSec }, feas);
}

function nearlyEqual(a, b) {
    return Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 1e-12;
}

function validJumpPlan(plan, { simTimeSec, feasibleWarp } = {}) {
    if (!plan || plan.ok !== true || !Number.isFinite(plan.targetSec) ||
        !Number.isFinite(plan.etaWallSec) || plan.etaWallSec < 0 ||
        !Number.isFinite(plan.holdWarp) || plan.holdWarp <= 0 ||
        !Array.isArray(plan.legs) || !plan.legs.length) return false;

    const validateLiveOrigin = Number.isFinite(simTimeSec);
    const validateFeasibility = Number.isFinite(feasibleWarp);
    if (!WARPS.includes(plan.holdWarp) || plan.holdWarp > WARP_MAX ||
        (validateFeasibility && (!(feasibleWarp > 0) || plan.holdWarp > feasibleWarp)) ||
        (validateLiveOrigin && !(plan.targetSec > simTimeSec)) ||
        (validateFeasibility && feasibleWarp <= 600 && plan.etaWallSec > 60)) return false;

    let previousToSimT = null;
    let totalWallSec = 0;
    let sawCruise = false;
    let lastRungWarp = null;
    for (let i = 0; i < plan.legs.length; i++) {
        const leg = plan.legs[i];
        if (!leg || (leg.kind !== "rung" && leg.kind !== "cruise" && leg.kind !== "hold") ||
            !Number.isFinite(leg.warp) || leg.warp <= 0 || leg.warp > WARP_MAX || !WARPS.includes(leg.warp) ||
            (validateFeasibility && leg.warp > feasibleWarp) ||
            !Number.isFinite(leg.fromSimT) || !Number.isFinite(leg.toSimT) || leg.toSimT <= leg.fromSimT ||
            !Number.isFinite(leg.wallSec) || leg.wallSec < 0) return false;
        if (i === 0 && validateLiveOrigin && leg.fromSimT !== simTimeSec) return false;
        if (leg.kind === "rung") {
            if (sawCruise || (lastRungWarp !== null && leg.warp < lastRungWarp)) return false;
            lastRungWarp = leg.warp;
        }
        if (leg.kind === "cruise") {
            if (sawCruise || (lastRungWarp !== null && leg.warp !== lastRungWarp)) return false;
            sawCruise = true;
        }
        if (leg.kind === "hold" && i !== plan.legs.length - 1) return false;
        if (previousToSimT !== null && leg.fromSimT !== previousToSimT) return false;
        if (!nearlyEqual(leg.wallSec, (leg.toSimT - leg.fromSimT) / leg.warp)) return false;
        previousToSimT = leg.toSimT;
        totalWallSec += leg.wallSec;
    }

    const lastLeg = plan.legs[plan.legs.length - 1];
    return lastLeg.kind === "hold" && lastLeg.warp === plan.holdWarp &&
        lastLeg.toSimT === plan.targetSec && nearlyEqual(totalWallSec, plan.etaWallSec);
}

function snapshotJumpPlan(plan) {
    const sourceLegs = Array.isArray(plan?.legs) ? plan.legs : [];
    const legs = new Array(sourceLegs.length);
    for (let i = 0; i < sourceLegs.length; i++) {
        const leg = sourceLegs[i];
        legs[i] = Object.freeze({
            kind: leg?.kind,
            warp: leg?.warp,
            fromSimT: leg?.fromSimT,
            toSimT: leg?.toSimT,
            wallSec: leg?.wallSec,
        });
    }
    Object.freeze(legs);
    return Object.freeze({
        ok: plan?.ok,
        targetSec: plan?.targetSec,
        etaWallSec: plan?.etaWallSec,
        holdWarp: plan?.holdWarp,
        legs,
    });
}

export function safeJumpRestoreWarp(value, feasibleWarp = WARP_MAX) {
    const feasibility = Number(feasibleWarp);
    if (Number.isFinite(feasibility) && feasibility <= 0) return WARPS[0];
    const limit = Number.isFinite(feasibility) && feasibility > 0
        ? Math.min(WARP_MAX, feasibility)
        : 1;
    const requested = Number(value);
    const ceiling = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, limit)
        : Math.min(1, limit);
    let safe = WARPS[0];
    for (let i = 0; i < WARPS.length && WARPS[i] <= ceiling; i++) safe = WARPS[i];
    return safe;
}

export function createJumpRuntime(plan, meta = {}, {
    currentWarp = 0,
    tdeInProgress = false,
    simTimeSec,
    feasibleWarp,
} = {}) {
    const runtimePlan = snapshotJumpPlan(plan);
    return {
        active: true,
        validPlan: validJumpPlan(runtimePlan, { simTimeSec, feasibleWarp }),
        plan: runtimePlan,
        meta,
        legIndex: 0,
        legWallSec: 0,
        elapsedWallSec: 0,
        physicsWallRate: 1,
        advanceDebtSec: 0,
        tdeAtStart: !!tdeInProgress,
        restoreWarp: safeJumpRestoreWarp(currentWarp, feasibleWarp),
        expectedWarp: currentWarp,
        pending: false,
        pendingWallDeltaSec: 0,
        pendingWarp: 0,
        delivery: {
            requestedAdvanceSec: 0,
            deliveredAdvanceSec: 0,
            fullyDelivered: false,
            syncTimeSec: NaN,
            postSimTimeSec: NaN,
        },
        result: {
            kind: "run",
            warp: currentWarp,
            etaWallSec: Number.isFinite(runtimePlan.etaWallSec) ? runtimePlan.etaWallSec : 0,
            advanceSec: 0,
            targetSimTimeSec: NaN,
            deliveredAdvanceSec: 0,
            syncTimeSec: NaN,
            reason: "",
        },
    };
}

function terminalFeasibleWarp(feasibleWarp, tdeInProgress, dead, landed, thrusting) {
    const numeric = Number(feasibleWarp);
    const liveCeiling = Number.isFinite(numeric) ? Math.max(0, Math.min(WARP_MAX, numeric)) : WARP_MAX;
    if (dead) return 0;
    if (tdeInProgress || landed || thrusting) return Math.min(600, liveCeiling);
    return liveCeiling;
}

function finishJumpRuntime(runtime, kind, reason = "", feasibleWarp = WARP_MAX) {
    const warp = safeJumpRestoreWarp(runtime.restoreWarp, feasibleWarp);
    runtime.active = false;
    runtime.expectedWarp = warp;
    runtime.result.kind = kind;
    runtime.result.warp = warp;
    runtime.result.etaWallSec = 0;
    runtime.result.advanceSec = 0;
    runtime.result.targetSimTimeSec = NaN;
    runtime.result.deliveredAdvanceSec = 0;
    runtime.result.syncTimeSec = NaN;
    runtime.result.reason = reason;
    return runtime.result;
}

function estimateJumpRemainingWallSec(runtime, simTimeSec) {
    const legs = runtime.plan.legs;
    const rate = Math.max(Number.EPSILON, runtime.physicsWallRate);
    let predictedAdvanceSec = Math.max(0, runtime.advanceDebtSec);
    let etaWallSec = 0;
    for (let i = runtime.legIndex; i < legs.length; i++) {
        const leg = legs[i];
        const legEndAdvanceSec = Math.max(0, leg.toSimT - simTimeSec);
        if (leg.kind === "rung") {
            const scheduledWallSec = Math.max(0, leg.wallSec - (i === runtime.legIndex ? runtime.legWallSec : 0));
            etaWallSec += scheduledWallSec;
            predictedAdvanceSec += leg.warp * scheduledWallSec * rate;
            continue;
        }
        const remainingSimSec = Math.max(0, legEndAdvanceSec - predictedAdvanceSec);
        etaWallSec += remainingSimSec / Math.max(Number.EPSILON, leg.warp * rate);
        predictedAdvanceSec = Math.max(predictedAdvanceSec, legEndAdvanceSec);
    }
    return etaWallSec;
}

export function stepJumpRuntime(runtime, {
    wallDeltaSec = 0,
    physicsDeltaSec = wallDeltaSec,
    simTimeSec = 0,
    currentWarp = runtime?.expectedWarp,
    tdeInProgress = false,
    externalTimeDriver = false,
    dead = false,
    landed = false,
    thrusting = false,
    feasibleWarp = WARP_MAX,
} = {}) {
    if (!runtime?.active) return runtime?.result;
    const restoreFeasibleWarp = terminalFeasibleWarp(
        feasibleWarp,
        runtime.tdeAtStart || tdeInProgress,
        dead,
        landed,
        thrusting,
    );
    if (!runtime.validPlan) return finishJumpRuntime(runtime, "cancel", "invalid jump plan", restoreFeasibleWarp);
    if (runtime.pending) return finishJumpRuntime(runtime, "cancel", "unsettled jump frame", restoreFeasibleWarp);
    if (externalTimeDriver) return finishJumpRuntime(runtime, "cancel", "external time", restoreFeasibleWarp);
    if (currentWarp !== runtime.expectedWarp) return finishJumpRuntime(runtime, "cancel", "time changed", restoreFeasibleWarp);
    if (runtime.tdeAtStart || tdeInProgress) return finishJumpRuntime(runtime, "tde", "", restoreFeasibleWarp);
    if (dead) return finishJumpRuntime(runtime, "cancel", "vehicle lost", restoreFeasibleWarp);
    if (landed) return finishJumpRuntime(runtime, "cancel", "vehicle landed", restoreFeasibleWarp);
    if (thrusting) return finishJumpRuntime(runtime, "cancel", "thrust active", restoreFeasibleWarp);

    const legs = runtime.plan.legs;

    const wallDelta = Math.max(0, Number(wallDeltaSec) || 0);
    runtime.elapsedWallSec += wallDelta;
    let leg = legs[runtime.legIndex];
    while (leg && simTimeSec >= leg.toSimT) {
        runtime.legIndex++;
        runtime.legWallSec = 0;
        leg = legs[runtime.legIndex];
    }
    if (!leg) return finishJumpRuntime(runtime, "arrive", "", restoreFeasibleWarp);

    let wallRemaining = wallDelta;
    while (leg?.kind === "rung") {
        const rungRemaining = Math.max(0, leg.wallSec - runtime.legWallSec);
        if (wallRemaining < rungRemaining) {
            runtime.legWallSec += wallRemaining;
            wallRemaining = 0;
            break;
        }
        wallRemaining -= rungRemaining;
        runtime.legIndex++;
        runtime.legWallSec = 0;
        leg = legs[runtime.legIndex];
    }
    if (!leg) return finishJumpRuntime(runtime, "arrive", "", restoreFeasibleWarp);

    const physicsDelta = Math.max(0, Number(physicsDeltaSec) || 0);
    if (wallDelta > 0 && physicsDelta > 0) {
        runtime.physicsWallRate = Math.min(1, physicsDelta / wallDelta);
    }
    const remaining = Math.max(0, leg.toSimT - simTimeSec);
    const warp = physicsDelta > 0 ? Math.min(leg.warp, remaining / physicsDelta) : leg.warp;
    if (physicsDelta > 0) runtime.advanceDebtSec += warp * physicsDelta;
    let nextSimTimeSec = simTimeSec;
    if (runtime.advanceDebtSec > 0) {
        const candidate = Math.min(leg.toSimT, simTimeSec + runtime.advanceDebtSec);
        const emittedAdvanceSec = candidate - simTimeSec;
        if (emittedAdvanceSec > 0 && runtime.advanceDebtSec >= emittedAdvanceSec) {
            nextSimTimeSec = candidate;
        }
    }
    const etaWallSec = estimateJumpRemainingWallSec(runtime, simTimeSec);
    runtime.expectedWarp = warp;
    runtime.result.kind = "run";
    runtime.result.warp = warp;
    runtime.result.etaWallSec = etaWallSec > 0
        ? etaWallSec
        : Math.max(Number.EPSILON, Math.min(runtime.result.etaWallSec, wallDelta || Number.EPSILON));
    runtime.result.advanceSec = nextSimTimeSec - simTimeSec;
    runtime.result.targetSimTimeSec = nextSimTimeSec;
    runtime.result.deliveredAdvanceSec = 0;
    runtime.result.syncTimeSec = NaN;
    runtime.result.reason = "";
    runtime.pending = true;
    runtime.pendingWallDeltaSec = wallDelta;
    runtime.pendingWarp = warp;
    return runtime.result;
}

export function settleJumpRuntime(runtime, {
    deliveredAdvanceSec = 0,
    simTimeSec = NaN,
    tdeInProgress = false,
    dead = false,
    landed = false,
    thrusting = false,
    feasibleWarp = WARP_MAX,
} = {}) {
    if (!runtime?.active || !runtime.pending) return runtime?.result;
    const result = runtime.result;
    const delivery = resolveJumpFrameDelivery(result, deliveredAdvanceSec, simTimeSec, runtime.delivery);
    runtime.pending = false;
    runtime.advanceDebtSec = Math.max(0, runtime.advanceDebtSec - delivery.deliveredAdvanceSec);
    if (delivery.requestedAdvanceSec > 0 && runtime.pendingWallDeltaSec > 0 && runtime.pendingWarp > 0) {
        runtime.physicsWallRate = Math.min(
            1,
            delivery.deliveredAdvanceSec / (runtime.pendingWarp * runtime.pendingWallDeltaSec),
        );
    }
    const settledSimTimeSec = Number.isFinite(delivery.syncTimeSec)
        ? delivery.syncTimeSec
        : delivery.postSimTimeSec;
    result.deliveredAdvanceSec = delivery.deliveredAdvanceSec;
    result.syncTimeSec = delivery.syncTimeSec;
    result.etaWallSec = estimateJumpRemainingWallSec(runtime, settledSimTimeSec);

    const restoreFeasibleWarp = terminalFeasibleWarp(feasibleWarp, tdeInProgress, dead, landed, thrusting);
    let terminal = null;
    if (tdeInProgress) terminal = finishJumpRuntime(runtime, "tde", "", restoreFeasibleWarp);
    else if (dead) terminal = finishJumpRuntime(runtime, "cancel", "vehicle lost", restoreFeasibleWarp);
    else if (landed) terminal = finishJumpRuntime(runtime, "cancel", "vehicle landed", restoreFeasibleWarp);
    else if (thrusting) terminal = finishJumpRuntime(runtime, "cancel", "thrust active", restoreFeasibleWarp);
    else if (settledSimTimeSec >= runtime.plan.targetSec) {
        terminal = finishJumpRuntime(runtime, "arrive", "", restoreFeasibleWarp);
    }
    if (terminal) {
        terminal.deliveredAdvanceSec = delivery.deliveredAdvanceSec;
        terminal.syncTimeSec = delivery.syncTimeSec;
        return terminal;
    }

    result.kind = "run";
    result.etaWallSec = result.etaWallSec > 0 ? result.etaWallSec : Number.EPSILON;
    return result;
}
