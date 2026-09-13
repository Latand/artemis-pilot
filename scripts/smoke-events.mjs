// Pure event-timeline smoke: Sun phases and engulfment, injected merger rows,
// deterministic jump planning, and live-state feasibility.
import { readFileSync } from "node:fs";
import { PL, AU_KM, R_SUN, SEC_YEAR, WARPS, WARP_MAX } from "../src/constants.js";
import { sunMaxRadiusReachedRsunAt, PHASE_BOUNDARIES_GYR } from "../src/universe/sunEvolution.js";
import { sunPhaseEvents, engulfmentEvents } from "../src/universe/sunTimeline.js";
import {
    createDiscoveryRecentSync,
    discoveryTier,
    mergeRecentRows,
    reconcileKeyedRows,
} from "../src/universe/epistemic.js";
import {
    buildTimeline,
    planJump,
    pickJumpWarp,
    maxFeasibleWarp,
    maxFeasibleWarpScalar,
    JUMP_HOLD_WARP,
    JUMP_LEAD_SEC,
    createJumpRuntime,
    settleJumpRuntime,
    stepJumpRuntime,
} from "../src/universe/eventTimeline.js";
import { resolveJumpFrameDelivery } from "../src/universe/jumpFrame.js";
import {
    createEventController,
    eventSurfaceAllowed,
    JUMP_END_LATCH_MS as CONTROLLER_JUMP_END_LATCH_MS,
} from "../src/universe/eventController.js";

let fails = 0;
const ok = (cond, label) => {
    console.log((cond ? "PASS" : "FAIL") + " " + label);
    if (!cond) fails++;
};
const GYR = 1e9 * SEC_YEAR;
const indexSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const eventsSource = readFileSync(new URL("../src/events.js", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const timeCtlSource = readFileSync(new URL("../src/timeCtl.js", import.meta.url), "utf8");

const tickJumpHotSource = timeCtlSource.slice(
    timeCtlSource.indexOf("export function tickJump"),
    timeCtlSource.indexOf("function finishTimeJump"),
);
const settleJumpHotSource = timeCtlSource.slice(
    timeCtlSource.indexOf("export function settleTimeJump"),
    timeCtlSource.indexOf("export function jumpStatus"),
);
const terminalFeasibilitySource = timeCtlSource.slice(
    timeCtlSource.indexOf("function liveTerminalFeasibleWarp"),
    timeCtlSource.indexOf("export function cancelTimeJump"),
);
ok(
    /feasibleWarpForStateScalar\(GS\.length,\s*!!G\.landed,\s*G\.dead,\s*BH\.n\)/.test(timeCtlSource) &&
        /tickInput\.feasibleWarp\s*=\s*liveFeasibleWarp\(\)/.test(tickJumpHotSource) &&
        /settleInput\.feasibleWarp\s*=\s*liveFeasibleWarp\(\)/.test(settleJumpHotSource) &&
        /const feasibleWarp\s*=\s*liveFeasibleWarp\(\)/.test(terminalFeasibilitySource) &&
        !/\bmaxFeasibleWarp\(\)/.test(tickJumpHotSource + settleJumpHotSource + terminalFeasibilitySource),
    "active jump feasibility sampling uses the scalar zero-allocation path",
);

const eng = engulfmentEvents();
const names = eng.map(event => event.id);
ok(
    names.some(name => name.includes("mercury")) &&
        names.some(name => name.includes("venus")) &&
        names.some(name => name.includes("earth")),
    "Mercury, Venus, Earth engulfed",
);

const feasibilityCases = [
    { label: "free", gsCount: 0, landed: false, dead: false, bhN: 0, expected: WARP_MAX },
    { label: "dead", gsCount: 0, landed: false, dead: true, bhN: 0, expected: 0 },
    { label: "landed", gsCount: 0, landed: true, dead: false, bhN: 0, expected: 600 },
    { label: "gravity ghosts", gsCount: 1, landed: false, dead: false, bhN: 0, expected: 600 },
];
for (const state of feasibilityCases) {
    const scalar = maxFeasibleWarpScalar(state.gsCount, state.landed, state.dead, state.bhN);
    const objectApi = state.label === "free"
        ? maxFeasibleWarp()
        : maxFeasibleWarp(state);
    ok(
        scalar === state.expected && objectApi === scalar,
        "scalar and public feasibility APIs agree for " + state.label,
    );
}
ok(!names.some(name => name.includes("mars")), "Mars remains beyond the AGB-tip radius");
const earthEngulfment = eng.find(event => event.id === "sun-engulfs-earth");
const innerEngulfments = eng.filter(event => event.id === "sun-engulfs-mercury" || event.id === "sun-engulfs-venus");
ok(
    earthEngulfment && /may engulf Earth/i.test(earthEngulfment.label) &&
        earthEngulfment.qualifier === "contingent scenario" &&
        /around \d+\.\d billion years from now/i.test(earthEngulfment.displayTime) &&
        /depends on solar mass loss and tidal drag/i.test(earthEngulfment.displayTime) &&
        !/\d{4}-\d{2}-\d{2}/.test(earthEngulfment.displayTime) && Number.isFinite(earthEngulfment.tSimSec),
    "Earth engulfment remains a numeric scenario with contingent, coarse scientific language",
);
ok(
    innerEngulfments.length === 2 && innerEngulfments.every(event => event.tier === "modeled" && !event.qualifier),
    "Mercury and Venus remain modeled engulfment events",
);
for (const event of eng) {
    const aKm = event.id.includes("earth")
        ? AU_KM
        : PL.find(planet => event.id.includes(planet.name.toLowerCase())).a;
    const before = sunMaxRadiusReachedRsunAt(event.tSimSec * (1 - 1e-9)) * R_SUN;
    const after = sunMaxRadiusReachedRsunAt(event.tSimSec * (1 + 1e-9)) * R_SUN;
    ok(before <= aKm && after >= aKm * (1 - 1e-6), "bisection exact at " + event.id);
}
ok(
    eng.every((event, i) => i === 0 || eng[i - 1].tSimSec <= event.tSimSec),
    "engulfment rows sorted",
);

const phases = sunPhaseEvents();
ok(
    Math.abs(phases.find(phase => phase.id === "sun-ms-end").tSimSec / GYR - PHASE_BOUNDARIES_GYR.msEnd) < 1e-9,
    "MS-end row matches PHASE_BOUNDARIES_GYR.msEnd",
);

const timeline = buildTimeline({ nowSec: 0, merger: { firstPassageGyr: 3.9, mergedGyr: 5.8 } });
ok(
    timeline.every((row, i) => i === 0 || timeline[i - 1].tSimSec <= row.tSimSec),
    "timeline sorted",
);
ok(
    timeline.some(row => row.id.includes("merger") || row.id.includes("m31")),
    "injected merger rows present",
);
ok(
    buildTimeline({ nowSec: 0 }).every(row => !row.id.includes("m31") && !row.id.includes("merger")),
    "merger rows require injected state",
);

const feas = maxFeasibleWarp({ gsCount: 0, landed: false, dead: false, bhN: 0 });
ok(feas === WARP_MAX, "clean state reaches the full ladder");
ok(
    maxFeasibleWarp({ gsCount: 0, landed: false, dead: false, bhN: 1 }) === WARP_MAX,
    "placed black holes retain deep-time bridge access",
);
const target = 6.3 * GYR;
const plan = planJump(0, target, feas);
ok(plan.ok, "Gyr jump plans on a clean state");
ok(plan.legs.every(leg => WARPS.includes(leg.warp)), "every leg uses a real WARPS rung");
ok(
    plan.legs.every((leg, i) => i === 0 || plan.legs[i - 1].warp <= leg.warp || leg.warp === JUMP_HOLD_WARP),
    "legs climb the ladder, then hold",
);
const hold = plan.legs[plan.legs.length - 1];
ok(hold.warp === JUMP_HOLD_WARP, "arrival hold is 1 Myr/s");
ok(
    Math.abs(target - hold.fromSimT - JUMP_LEAD_SEC) < 1e-3 * JUMP_LEAD_SEC,
    "hold begins about 10 Myr before the event",
);
ok(plan.etaWallSec > 5 && plan.etaWallSec < 60, "honest ETA spans tens of seconds");

function planStartsValidly(planToCheck, nowSec) {
    if (!planToCheck.ok || !planToCheck.legs.every(leg => leg.toSimT > leg.fromSimT)) return false;
    const runtime = createJumpRuntime(planToCheck, {}, { currentWarp: 60, tdeInProgress: false });
    const result = stepJumpRuntime(runtime, {
        wallDeltaSec: 0,
        physicsDeltaSec: 0,
        simTimeSec: nowSec,
        currentWarp: 60,
        tdeInProgress: false,
    });
    return result.kind === "run";
}

const deepTimeMatrix = [
    { nowSec: 3.9 * GYR, targetSec: 5.8 * GYR },
    { nowSec: 5.8 * GYR, targetSec: 6.3 * GYR },
    { nowSec: 6.3 * GYR, targetSec: timeline.find(row => row.id === "sun-engulfs-mercury").tSimSec },
];
ok(
    deepTimeMatrix.every(({ nowSec, targetSec }) => planStartsValidly(planJump(nowSec, targetSec, feas), nowSec)),
    "large-now jump matrix emits advancing runtime-valid plans",
);

let sequentialNowSec = 0;
let sequentialPlansValid = true;
for (const event of timeline) {
    const sequentialPlan = planJump(sequentialNowSec, event.tSimSec, feas);
    if (!planStartsValidly(sequentialPlan, sequentialNowSec)) sequentialPlansValid = false;
    sequentialNowSec = event.tSimSec;
}
ok(sequentialPlansValid, "sequential timeline events remain available through deep time");

function driveLargeTimestampJump(nowSec, targetSec, feasibility, fps, maxFrames = 5000) {
    const largePlan = planJump(nowSec, targetSec, feasibility);
    if (!largePlan.ok) return { plan: largePlan, arrived: false, safe: true };
    const runtime = createJumpRuntime(largePlan, {}, { currentWarp: 60, tdeInProgress: false });
    let simTimeSec = nowSec;
    let currentWarp = 60;
    let elapsedWallSec = 0;
    let resultRef = null;
    let safe = true;
    let etaPositive = true;
    let etaMonotonic = true;
    let etaTracksRemaining = true;
    let previousEtaWallSec = Infinity;
    for (let frame = 0; frame < maxFrames; frame++) {
        const result = stepJumpRuntime(runtime, {
            wallDeltaSec: 1 / fps,
            physicsDeltaSec: 1 / fps,
            simTimeSec,
            currentWarp,
            tdeInProgress: false,
        });
        if (resultRef && result !== resultRef) safe = false;
        resultRef = result;
        if (result.kind === "arrive") {
            return {
                plan: largePlan,
                arrived: simTimeSec === targetSec,
                safe,
                etaWallSec: result.etaWallSec,
                elapsedWallSec,
                fps,
                etaPositive,
                etaMonotonic,
                etaTracksRemaining,
            };
        }
        if (result.kind !== "run" || !(result.warp > 0) || result.warp > feasibility || !(result.etaWallSec > 0)) {
            return { plan: largePlan, arrived: false, safe: false };
        }
        const nextElapsedWallSec = elapsedWallSec + 1 / fps;
        const requestedAdvanceSec = result.advanceSec;
        const requestedTargetSec = result.targetSimTimeSec;
        const settled = settleJumpRuntime(runtime, {
            deliveredAdvanceSec: requestedAdvanceSec,
            simTimeSec: requestedTargetSec,
        });
        const expectedEtaWallSec = Math.max(0, largePlan.etaWallSec - nextElapsedWallSec);
        const etaTolerance = 1 / fps + Math.max(Number.EPSILON, largePlan.etaWallSec * Number.EPSILON);
        if (settled.kind === "arrive") {
            return {
                plan: largePlan,
                arrived: settled.syncTimeSec === targetSec,
                safe,
                etaWallSec: settled.etaWallSec,
                elapsedWallSec: nextElapsedWallSec,
                fps,
                etaPositive,
                etaMonotonic,
                etaTracksRemaining,
            };
        }
        etaPositive = etaPositive && settled.etaWallSec > 0;
        etaMonotonic = etaMonotonic && settled.etaWallSec <= previousEtaWallSec + Number.EPSILON;
        etaTracksRemaining = etaTracksRemaining &&
            Math.abs(settled.etaWallSec - expectedEtaWallSec) <= etaTolerance;
        previousEtaWallSec = settled.etaWallSec;
        currentWarp = settled.warp;
        if (Number.isFinite(settled.syncTimeSec)) simTimeSec = settled.syncTimeSec;
        elapsedWallSec = nextElapsedWallSec;
    }
    return { plan: largePlan, arrived: false, safe };
}

const ulpNow = 3.9e9 * SEC_YEAR;
const ulpRefreshRates = [30, 60, 120, 144, 240];
const fullUlpRuns = ulpRefreshRates.flatMap(fps => [
    driveLargeTimestampJump(ulpNow, ulpNow + 16, WARP_MAX, fps),
    driveLargeTimestampJump(ulpNow, ulpNow + 1600, WARP_MAX, fps),
    driveLargeTimestampJump(ulpNow, ulpNow + JUMP_LEAD_SEC + 80, WARP_MAX, fps),
]);
const cappedUlpRuns = ulpRefreshRates.flatMap(fps => [
    driveLargeTimestampJump(ulpNow, ulpNow + 16, 600, fps),
    driveLargeTimestampJump(ulpNow, ulpNow + 1600, 600, fps),
]);
const cappedLeadBoundary = planJump(ulpNow, ulpNow + JUMP_LEAD_SEC + 80, 600);
const tinyUlpRuns = [...fullUlpRuns, ...cappedUlpRuns].filter(run =>
    run.plan.ok && run.plan.legs.length === 1 && run.plan.legs[0].warp === 1,
);
ok(
    fullUlpRuns.every(run => run.arrived && run.safe && run.etaWallSec === 0) &&
        cappedUlpRuns.every(run => run.arrived && run.safe && run.etaWallSec === 0) &&
        [...fullUlpRuns, ...cappedUlpRuns].every(run =>
            Math.abs(run.elapsedWallSec - run.plan.etaWallSec) <= 1 / run.fps + 1e-9,
        ) &&
        !cappedLeadBoundary.ok &&
        cappedLeadBoundary.reason === "deep time blocked: absorbed matter's gravity ghosts force step-by-step physics",
    "large-timestamp tiny, short, and lead-boundary jumps make representable exact progress",
);
ok(
    tinyUlpRuns.length === ulpRefreshRates.length * 2 &&
        tinyUlpRuns.every(run => run.etaPositive && run.etaMonotonic && run.etaTracksRemaining),
    "compensated 1x ETA tracks remaining wall time across high refresh rates",
);

ok(!planJump(1e9, 1e6, feas).ok, "past targets are refused");
ok(pickJumpWarp(target, feas) === WARP_MAX, "rung selector reaches the required clean-state cruise");

const capped = maxFeasibleWarp({ gsCount: 1, landed: false, dead: false, bhN: 1 });
ok(capped === 600, "gravity ghosts cap stepped physics at 600x");
const refused = planJump(0, target, capped);
ok(!refused.ok && /ghost|step-by-step/.test(refused.reason), "deep jump gives the gravity-ghost reason");
const cappedShortRefusal = planJump(0, JUMP_LEAD_SEC / 2, capped);
ok(
    !cappedShortRefusal.ok && cappedShortRefusal.reason === "deep time blocked: absorbed matter's gravity ghosts force step-by-step physics",
    "capped 5 Myr short jump uses the exact gravity-ghost refusal",
);
const cappedShortAccepted = planJump(0, 30000, capped);
ok(
    cappedShortAccepted.ok && cappedShortAccepted.etaWallSec === 50,
    "capped short jump remains available when its ETA is within 60 seconds",
);
ok(
    maxFeasibleWarp({ gsCount: 0, landed: true, dead: false, bhN: 0 }) === 600,
    "surface state caps stepped physics at 600x",
);
ok(maxFeasibleWarp({ gsCount: 0, landed: false, dead: true, bhN: 0 }) === 0, "dead state disables jumps");

const runtimePlan = {
    ok: true,
    targetSec: 522.7,
    etaWallSec: 3.1,
    holdWarp: 60,
    legs: [
        { kind: "rung", warp: 1, fromSimT: 0, toSimT: 0.7, wallSec: 0.7 },
        { kind: "rung", warp: 60, fromSimT: 0.7, toSimT: 42.7, wallSec: 0.7 },
        { kind: "rung", warp: 600, fromSimT: 42.7, toSimT: 462.7, wallSec: 0.7 },
        { kind: "hold", warp: 60, fromSimT: 462.7, toSimT: 522.7, wallSec: 1 },
    ],
};
const lowFpsRuntime = createJumpRuntime(runtimePlan, { label: "LOW FPS" }, {
    currentWarp: 60,
    tdeInProgress: false,
});
const lowFpsStep = stepJumpRuntime(lowFpsRuntime, {
    wallDeltaSec: 1.5,
    physicsDeltaSec: 0.05,
    simTimeSec: 0,
    currentWarp: 60,
    tdeInProgress: false,
});
ok(lowFpsStep.kind === "run" && lowFpsStep.warp === 600, "uncapped wall delta advances multiple jump rungs");

function driveRealJumpAtFps(fps) {
    const wallDeltaSec = 1 / fps;
    const runtime = createJumpRuntime(plan, { label: fps + " FPS" }, {
        currentWarp: 60,
        tdeInProgress: false,
    });
    let simTimeSec = 0;
    let currentWarp = 60;
    let elapsedWallSec = 0;
    let cruiseEtaWallSec = null;
    let minRunningEtaWallSec = Infinity;
    let arrivalEtaWallSec = null;
    for (let guard = 0; guard < 10000; guard++) {
        const physicsCapSec = currentWarp > 600 ? 1 / 30 : 0.06;
        const physicsDeltaSec = Math.min(wallDeltaSec, physicsCapSec);
        const result = stepJumpRuntime(runtime, {
            wallDeltaSec,
            physicsDeltaSec,
            simTimeSec,
            currentWarp,
            tdeInProgress: false,
        });
        elapsedWallSec += wallDeltaSec;
        if (result.kind === "arrive") {
            arrivalEtaWallSec = result.etaWallSec;
            return {
                elapsedWallSec,
                simTimeSec,
                cruiseEtaWallSec,
                minRunningEtaWallSec,
                arrivalEtaWallSec,
            };
        }
        if (result.kind !== "run") throw new Error("unexpected jump result " + result.kind);
        const requestedAdvanceSec = result.advanceSec;
        const requestedTargetSec = result.targetSimTimeSec;
        const settled = settleJumpRuntime(runtime, {
            deliveredAdvanceSec: requestedAdvanceSec,
            simTimeSec: requestedTargetSec,
        });
        if (settled.kind === "arrive") {
            arrivalEtaWallSec = settled.etaWallSec;
            return {
                elapsedWallSec,
                simTimeSec: settled.syncTimeSec,
                cruiseEtaWallSec,
                minRunningEtaWallSec,
                arrivalEtaWallSec,
            };
        }
        minRunningEtaWallSec = Math.min(minRunningEtaWallSec, settled.etaWallSec);
        if (cruiseEtaWallSec === null && plan.legs[runtime.legIndex]?.kind === "cruise") {
            cruiseEtaWallSec = settled.etaWallSec;
        }
        currentWarp = settled.warp;
        if (Number.isFinite(settled.syncTimeSec)) simTimeSec = settled.syncTimeSec;
    }
    throw new Error("jump driver guard exhausted at " + fps + " FPS");
}

const jump30 = driveRealJumpAtFps(30);
const jump15 = driveRealJumpAtFps(15);
const jump5 = driveRealJumpAtFps(5);
ok(
    jump30.minRunningEtaWallSec > 0 && jump15.minRunningEtaWallSec > 0 && jump5.minRunningEtaWallSec > 0,
    "adaptive ETA stays positive on every running frame",
);
ok(
    jump30.arrivalEtaWallSec === 0 && jump15.arrivalEtaWallSec === 0 && jump5.arrivalEtaWallSec === 0,
    "adaptive ETA reaches zero on arrival",
);
ok(
    jump5.cruiseEtaWallSec > jump15.cruiseEtaWallSec && jump15.cruiseEtaWallSec > jump30.cruiseEtaWallSec,
    "adaptive ETA reflects bounded-physics slowdown",
);
ok(jump30.elapsedWallSec >= 20 && jump30.elapsedWallSec <= 25, "30 FPS jump retains the honest 20-25 second arrival window");
ok(
    jump15.elapsedWallSec > jump30.elapsedWallSec && jump5.elapsedWallSec > jump15.elapsedWallSec,
    "end-to-end driver reproduces increasing low-FPS arrival time",
);
ok(
    Math.abs(jump30.simTimeSec - target) <= target * 1e-12 &&
        Math.abs(jump15.simTimeSec - target) <= target * 1e-12 &&
        Math.abs(jump5.simTimeSec - target) <= target * 1e-12,
    "bounded-physics driver lands exactly at the event time",
);

const exactRuntime = createJumpRuntime({
    ok: true,
    targetSec: 100,
    etaWallSec: 1 / 60,
    holdWarp: 60,
    legs: [{ kind: "hold", warp: 60, fromSimT: 99, toSimT: 100, wallSec: 1 / 60 }],
}, { label: "EXACT" }, { currentWarp: 60, tdeInProgress: false });
const exactStep = stepJumpRuntime(exactRuntime, {
    wallDeltaSec: 0.5,
    physicsDeltaSec: 0.25,
    simTimeSec: 99,
    currentWarp: 60,
    tdeInProgress: false,
});
ok(exactStep.kind === "run" && exactStep.warp === 4, "physics delta clamps the final frame to exact arrival");
const arrivedStep = settleJumpRuntime(exactRuntime, {
    deliveredAdvanceSec: exactStep.advanceSec,
    simTimeSec: 100,
});
ok(arrivedStep.kind === "arrive" && arrivedStep.warp === 60, "runtime completes exactly at the target and restores hold warp");

const restoreRuntime = createJumpRuntime({
    ok: true,
    targetSec: 1,
    etaWallSec: 1 / 60,
    holdWarp: 60,
    legs: [{ kind: "hold", warp: 60, fromSimT: 0, toSimT: 1, wallSec: 1 / 60 }],
}, {}, { currentWarp: 1, tdeInProgress: false, simTimeSec: 0, feasibleWarp: WARP_MAX });
const restoreRequest = stepJumpRuntime(restoreRuntime, {
    wallDeltaSec: 1 / 60,
    physicsDeltaSec: 1 / 60,
    simTimeSec: 0,
    currentWarp: 1,
});
const restoreArrival = settleJumpRuntime(restoreRuntime, {
    deliveredAdvanceSec: restoreRequest.advanceSec,
    simTimeSec: restoreRequest.targetSimTimeSec,
});
ok(
    restoreArrival.kind === "arrive" && restoreArrival.warp === 1,
    "runtime arrival restores the captured pre-jump warp",
);

const deliveryOut = {};
const partialDelivery = resolveJumpFrameDelivery(
    { advanceSec: 1, targetSimTimeSec: 1 },
    0.25,
    0.25,
    deliveryOut,
);
ok(
    partialDelivery === deliveryOut && partialDelivery.deliveredAdvanceSec === 0.25 &&
        Number.isNaN(partialDelivery.syncTimeSec),
    "frame delivery reports thrust-style underdelivery without absolute-clock synchronization",
);
const fullDelivery = resolveJumpFrameDelivery(
    { advanceSec: 1, targetSimTimeSec: 1 },
    1,
    1,
    deliveryOut,
);
ok(
    fullDelivery === deliveryOut && fullDelivery.deliveredAdvanceSec === 1 && fullDelivery.syncTimeSec === 1,
    "frame delivery synchronizes the absolute clock after full physics delivery",
);

const deliveryPlan = {
    ok: true,
    targetSec: 60,
    etaWallSec: 1,
    holdWarp: 60,
    legs: [{ kind: "hold", warp: 60, fromSimT: 0, toSimT: 60, wallSec: 1 }],
};
const deliveryRuntime = createJumpRuntime(deliveryPlan, {}, {
    currentWarp: 60,
    tdeInProgress: false,
    simTimeSec: 0,
    feasibleWarp: 60,
});
const deliveryRequest = stepJumpRuntime(deliveryRuntime, {
    wallDeltaSec: 1 / 60,
    physicsDeltaSec: 1 / 60,
    simTimeSec: 0,
    currentWarp: 60,
});
const deliveryRequestRef = deliveryRequest;
const deliverySettled = settleJumpRuntime(deliveryRuntime, {
    deliveredAdvanceSec: 0.25,
    simTimeSec: 0.25,
});
ok(
    deliverySettled === deliveryRequestRef && deliverySettled.kind === "run" &&
        deliverySettled.deliveredAdvanceSec === 0.25 && Number.isNaN(deliverySettled.syncTimeSec) &&
        deliveryRuntime.advanceDebtSec === 0.75 && deliverySettled.etaWallSec > 59.5 / 60,
    "runtime ETA and clock settlement use delivered physics after underdelivery",
);
const repaymentRequest = stepJumpRuntime(deliveryRuntime, {
    wallDeltaSec: 1 / 60,
    physicsDeltaSec: 1 / 60,
    simTimeSec: 0.25,
    currentWarp: deliverySettled.warp,
});
ok(
    repaymentRequest.kind === "run" && repaymentRequest.advanceSec === 1.75,
    "next jump frame repays funded underdelivery debt",
);
settleJumpRuntime(deliveryRuntime, {
    deliveredAdvanceSec: repaymentRequest.advanceSec,
    simTimeSec: repaymentRequest.targetSimTimeSec,
});

for (const transition of [
    { label: "thrust underdelivery", state: { thrusting: true } },
    { label: "death during physics", state: { dead: true } },
    { label: "landing during physics", state: { landed: true } },
]) {
    const transitionRuntime = createJumpRuntime(deliveryPlan, {}, {
        currentWarp: 60,
        tdeInProgress: false,
        simTimeSec: 0,
        feasibleWarp: 60,
    });
    const transitionRequest = stepJumpRuntime(transitionRuntime, {
        wallDeltaSec: 1 / 60,
        physicsDeltaSec: 1 / 60,
        simTimeSec: 0,
        currentWarp: 60,
    });
    const transitionRef = transitionRequest;
    const transitionResult = settleJumpRuntime(transitionRuntime, {
        deliveredAdvanceSec: 0.25,
        simTimeSec: 0.25,
        ...transition.state,
    });
    ok(
        transitionResult === transitionRef && transitionResult.kind === "cancel" &&
            transitionResult.warp <= 600 && transitionResult.deliveredAdvanceSec === 0.25 &&
            Number.isNaN(transitionResult.syncTimeSec),
        "post-physics settlement safely cancels on " + transition.label,
    );
}

for (const safety of [
    { label: "active TDE", start: { tdeInProgress: true }, step: { tdeInProgress: true }, kind: "tde" },
    { label: "death", start: {}, step: { dead: true }, kind: "cancel" },
    { label: "landing", start: {}, step: { landed: true }, kind: "cancel" },
    { label: "thrust", start: {}, step: { thrusting: true }, kind: "cancel" },
]) {
    const safetyRuntime = createJumpRuntime(deliveryPlan, {}, {
        currentWarp: 60,
        tdeInProgress: !!safety.start.tdeInProgress,
        simTimeSec: 0,
        feasibleWarp: 60,
    });
    const safetyResult = stepJumpRuntime(safetyRuntime, {
        wallDeltaSec: 1 / 60,
        physicsDeltaSec: 1 / 60,
        simTimeSec: 0,
        currentWarp: 60,
        ...safety.step,
    });
    ok(safetyResult.kind === safety.kind, "jump runtime stops on " + safety.label);
}

const stalePrePhysicsDeathRuntime = createJumpRuntime(deliveryPlan, {}, {
    currentWarp: WARP_MAX,
    tdeInProgress: false,
    simTimeSec: 0,
    feasibleWarp: WARP_MAX,
});
const stalePrePhysicsDeath = stepJumpRuntime(stalePrePhysicsDeathRuntime, {
    wallDeltaSec: 1 / 60,
    physicsDeltaSec: 1 / 60,
    simTimeSec: 0,
    currentWarp: WARP_MAX,
    dead: true,
    feasibleWarp: 0,
});
ok(
    stalePrePhysicsDeath.kind === "cancel" && stalePrePhysicsDeath.warp === WARPS[0],
    "pre-physics runtime death zero ceiling returns the slowest 0.01x valid ladder fallback",
);

for (const safety of [
    { label: "landing", state: { landed: true } },
    { label: "thrust", state: { thrusting: true } },
    { label: "TDE", state: { tdeInProgress: true }, kind: "tde" },
]) {
    const staleRuntime = createJumpRuntime(deliveryPlan, {}, {
        currentWarp: WARP_MAX,
        tdeInProgress: false,
        simTimeSec: 0,
        feasibleWarp: WARP_MAX,
    });
    const staleResult = stepJumpRuntime(staleRuntime, {
        wallDeltaSec: 1 / 60,
        physicsDeltaSec: 1 / 60,
        simTimeSec: 0,
        currentWarp: WARP_MAX,
        feasibleWarp: 600,
        ...safety.state,
    });
    ok(
        staleResult.kind === (safety.kind || "cancel") && staleResult.warp === 600,
        "pre-physics runtime " + safety.label + " caps stale WARP_MAX restoration at 600x",
    );
}

for (const safety of [
    { label: "death", feasibleWarp: 0, expectedWarp: WARPS[0], state: { dead: true } },
    { label: "landing", feasibleWarp: 600, expectedWarp: 600, state: { landed: true } },
    { label: "thrust", feasibleWarp: 600, expectedWarp: 600, state: { thrusting: true } },
    { label: "TDE", feasibleWarp: 600, expectedWarp: 600, state: { tdeInProgress: true }, kind: "tde" },
]) {
    const staleRuntime = createJumpRuntime(deliveryPlan, {}, {
        currentWarp: WARP_MAX,
        tdeInProgress: false,
        simTimeSec: 0,
        feasibleWarp: WARP_MAX,
    });
    const request = stepJumpRuntime(staleRuntime, {
        wallDeltaSec: 1 / 60,
        physicsDeltaSec: 1 / 60,
        simTimeSec: 0,
        currentWarp: WARP_MAX,
        feasibleWarp: WARP_MAX,
    });
    const requestRef = request;
    const staleResult = settleJumpRuntime(staleRuntime, {
        deliveredAdvanceSec: request.advanceSec,
        simTimeSec: request.targetSimTimeSec,
        feasibleWarp: safety.feasibleWarp,
        ...safety.state,
    });
    ok(
        staleResult === requestRef && staleResult.kind === (safety.kind || "cancel") &&
            staleResult.warp === safety.expectedWarp,
        "post-physics runtime " + safety.label + " reuses its result with a live-feasible restore rung",
    );
}

const validRuntimePlan = {
    ok: true,
    targetSec: 100,
    etaWallSec: 100 / 60,
    holdWarp: 60,
    legs: [{ kind: "hold", warp: 60, fromSimT: 0, toSimT: 100, wallSec: 100 / 60 }],
};
const unsafeStartPlans = [
    {
        label: "oversized warp",
        plan: {
            ok: true,
            targetSec: 1e30,
            etaWallSec: 1,
            holdWarp: 1e30,
            legs: [{ kind: "hold", warp: 1e30, fromSimT: 0, toSimT: 1e30, wallSec: 1 }],
        },
        feasibility: WARP_MAX,
    },
    {
        label: "off-origin first leg",
        plan: { ...validRuntimePlan, legs: [{ ...validRuntimePlan.legs[0], fromSimT: 1 }] },
        feasibility: 60,
    },
    {
        label: "off-ladder warp",
        plan: {
            ok: true,
            targetSec: 30,
            etaWallSec: 1,
            holdWarp: 30,
            legs: [{ kind: "hold", warp: 30, fromSimT: 0, toSimT: 30, wallSec: 1 }],
        },
        feasibility: 60,
    },
    {
        label: "currently infeasible warp",
        plan: {
            ok: true,
            targetSec: 3600,
            etaWallSec: 1,
            holdWarp: 3600,
            legs: [{ kind: "hold", warp: 3600, fromSimT: 0, toSimT: 3600, wallSec: 1 }],
        },
        feasibility: 600,
    },
];
for (const unsafe of unsafeStartPlans) {
    const unsafeRuntime = createJumpRuntime(unsafe.plan, {}, {
        currentWarp: 60,
        tdeInProgress: false,
        simTimeSec: 0,
        feasibleWarp: unsafe.feasibility,
    });
    ok(!unsafeRuntime.validPlan, "live start validation rejects " + unsafe.label);
}
const malformedRuntimePlans = [
    {
        label: "missing toSimT",
        plan: { ...validRuntimePlan, legs: [{ ...validRuntimePlan.legs[0], toSimT: undefined }] },
    },
    {
        label: "NaN warp",
        plan: { ...validRuntimePlan, legs: [{ ...validRuntimePlan.legs[0], warp: NaN }] },
    },
    {
        label: "reversed bounds",
        plan: { ...validRuntimePlan, legs: [{ ...validRuntimePlan.legs[0], fromSimT: 101 }] },
    },
    {
        label: "unsupported kind",
        plan: { ...validRuntimePlan, legs: [{ ...validRuntimePlan.legs[0], kind: "teleport" }] },
    },
    {
        label: "broken ordering",
        plan: {
            ok: true,
            targetSec: 3,
            etaWallSec: 2,
            holdWarp: 1,
            legs: [
                { kind: "rung", warp: 1, fromSimT: 0, toSimT: 1, wallSec: 1 },
                { kind: "hold", warp: 1, fromSimT: 2, toSimT: 3, wallSec: 1 },
            ],
        },
    },
    {
        label: "decreasing rung warp",
        plan: {
            ok: true,
            targetSec: 126,
            etaWallSec: 1.2,
            holdWarp: 60,
            legs: [
                { kind: "rung", warp: 600, fromSimT: 0, toSimT: 60, wallSec: 0.1 },
                { kind: "rung", warp: 60, fromSimT: 60, toSimT: 66, wallSec: 0.1 },
                { kind: "hold", warp: 60, fromSimT: 66, toSimT: 126, wallSec: 1 },
            ],
        },
    },
    {
        label: "cruise warp differs from final rung",
        plan: {
            ok: true,
            targetSec: 702,
            etaWallSec: 2.7,
            holdWarp: 60,
            legs: [
                { kind: "rung", warp: 60, fromSimT: 0, toSimT: 42, wallSec: 0.7 },
                { kind: "cruise", warp: 600, fromSimT: 42, toSimT: 642, wallSec: 1 },
                { kind: "hold", warp: 60, fromSimT: 642, toSimT: 702, wallSec: 1 },
            ],
        },
    },
];
for (const malformed of malformedRuntimePlans) {
    const malformedRuntime = createJumpRuntime(malformed.plan, {}, { currentWarp: 60, tdeInProgress: false });
    const malformedResult = stepJumpRuntime(malformedRuntime, {
        wallDeltaSec: 0.1,
        physicsDeltaSec: 0.05,
        simTimeSec: 0,
        currentWarp: 60,
        tdeInProgress: false,
    });
    ok(
        malformedResult.kind === "cancel" && malformedResult.reason === "invalid jump plan",
        "runtime rejects malformed plan: " + malformed.label,
    );
}

const callerOwnedPlan = {
    ...validRuntimePlan,
    legs: validRuntimePlan.legs.map(leg => ({ ...leg })),
};
const snapshottedRuntime = createJumpRuntime(callerOwnedPlan, {}, { currentWarp: 60, tdeInProgress: false });
callerOwnedPlan.targetSec = NaN;
callerOwnedPlan.legs[0].warp = NaN;
const runtimePlanFrozen = Object.isFrozen(snapshottedRuntime.plan) &&
    Object.isFrozen(snapshottedRuntime.plan.legs) && Object.isFrozen(snapshottedRuntime.plan.legs[0]);
const internalMutationRejected = !Reflect.set(snapshottedRuntime.plan.legs[0], "warp", NaN);
const snapshottedStep = stepJumpRuntime(snapshottedRuntime, {
    wallDeltaSec: 0.1,
    physicsDeltaSec: 0.05,
    simTimeSec: 0,
    currentWarp: 60,
    tdeInProgress: false,
});
ok(
    runtimePlanFrozen && internalMutationRejected &&
        snapshottedStep.kind === "run" && Number.isFinite(snapshottedStep.warp) &&
        Number.isFinite(snapshottedStep.targetSimTimeSec),
    "runtime snapshots validated caller-owned plan data before hot stepping",
);

const allocationRuntime = createJumpRuntime(validRuntimePlan, {}, { currentWarp: 60, tdeInProgress: false });
const firstHotResult = stepJumpRuntime(allocationRuntime, {
    wallDeltaSec: 0.1,
    physicsDeltaSec: 0.05,
    simTimeSec: 0,
    currentWarp: 60,
    tdeInProgress: false,
});
const firstHotWarp = firstHotResult.warp;
const firstHotTarget = firstHotResult.targetSimTimeSec;
settleJumpRuntime(allocationRuntime, {
    deliveredAdvanceSec: firstHotResult.advanceSec,
    simTimeSec: firstHotTarget,
});
const secondHotResult = stepJumpRuntime(allocationRuntime, {
    wallDeltaSec: 0.1,
    physicsDeltaSec: 0.05,
    simTimeSec: firstHotTarget,
    currentWarp: firstHotWarp,
    tdeInProgress: false,
});
ok(firstHotResult === secondHotResult, "validated hot step reuses its result object");

const watchdogRuntime = createJumpRuntime(runtimePlan, {}, { currentWarp: 60, tdeInProgress: false });
const watchdogStep = stepJumpRuntime(watchdogRuntime, {
    wallDeltaSec: 0.1,
    physicsDeltaSec: 0.05,
    simTimeSec: 0,
    currentWarp: 600,
    tdeInProgress: false,
});
ok(watchdogStep.kind === "cancel" && watchdogStep.reason === "time changed", "external warp mutation cancels the runtime");

const driverRuntime = createJumpRuntime(runtimePlan, {}, { currentWarp: 60, tdeInProgress: false });
const driverStep = stepJumpRuntime(driverRuntime, {
    wallDeltaSec: 0.1,
    physicsDeltaSec: 0.05,
    simTimeSec: 0,
    currentWarp: 60,
    tdeInProgress: false,
    externalTimeDriver: true,
});
ok(driverStep.kind === "cancel" && driverStep.reason === "external time", "external time driver cancels the runtime");

const tdeRuntime = createJumpRuntime(runtimePlan, {}, { currentWarp: 60, tdeInProgress: false });
const tdeStep = stepJumpRuntime(tdeRuntime, {
    wallDeltaSec: 0.1,
    physicsDeltaSec: 0.05,
    simTimeSec: 0,
    currentWarp: 60,
    tdeInProgress: true,
});
ok(tdeStep.kind === "tde" && tdeStep.warp === 60, "TDE transition restores the captured pre-jump warp");

ok(discoveryTier({ kind: "star", id: "hyg:32349", label: "SIRIUS" }) === "measured", "catalog stars are MEASURED");
ok(discoveryTier({ kind: "star", id: "cell:1:2:3", label: "MW-7K3FQ" }) === "modeled", "procedural MW stars are MODELED");
ok(discoveryTier({ kind: "planet", id: "planet:2", label: "MARS" }) === "measured", "ephemeris bodies are MEASURED");
ok(discoveryTier({ kind: "record", id: "distance", label: "Range record" }) === "measured", "flight records are MEASURED");
ok(discoveryTier({ kind: "notable", id: "quasar", label: "QUASAR" }) === "modeled", "simulated notable phenomena are MODELED");
ok(discoveryTier({ kind: "notable", id: "earthlike", label: "EARTH-LIKE WORLD: EARTH" }) === "measured", "logged Earth observation is MEASURED");
ok(
    discoveryTier({ kind: "sysplanet", id: "sysplanet:generated:mw:4", label: "MW-4 b" }) === "modeled",
    "generated system planets are MODELED",
);
ok(
    discoveryTier({ kind: "sysmoon", id: "sysmoon:generated:mw:4:0", label: "MW-4 b I" }) === "modeled",
    "generated system moons are MODELED",
);
ok(
    discoveryTier({ kind: "sysplanet", id: "sysplanet:catalog:toi-700:0", label: "TOI-700 d" }) === "measured",
    "catalog-backed real exoplanet bodies are MEASURED",
);
ok(
    /\.real === true \? "catalog" : "generated"/.test(mainSource) &&
        /G\.landed\.discoveryId/.test(mainSource) &&
        /G\.landed\.body === "sysplanet"/.test(mainSource) &&
        /G\.landed\.body === "sysmoon"/.test(mainSource),
    "landing discovery ids preserve cached system-body provenance",
);

const discoverySync = createDiscoveryRecentSync(12);
const catalogDiscovery = { kind: "star", id: "hyg:32349", label: "SIRIUS", civil: "2000-01-01", met: 10 };
const firstDiscovery = discoverySync.update([catalogDiscovery]);
ok(firstDiscovery.changed && firstDiscovery.rows.length === 1, "discovery sync accepts the initial snapshot");
const stableRows = firstDiscovery.rows;
const stableDiscovery = discoverySync.update([{ ...catalogDiscovery }]);
ok(!stableDiscovery.changed && stableDiscovery.rows === stableRows, "unchanged discovery snapshot preserves row-array identity");
const appendedDiscovery = discoverySync.update([
    catalogDiscovery,
    { kind: "star", id: "cell:1:2:3", label: "MW-7K3FQ", civil: "2000-01-02", met: 20 },
]);
ok(
    appendedDiscovery.changed && appendedDiscovery.rows.length === 2 && appendedDiscovery.rows[1].tier === "modeled",
    "runtime discovery append refreshes RECENT with inherited tier",
);
const restoredDiscovery = discoverySync.update([
    { kind: "moon", id: "moon:0", label: "THE MOON", civil: "1999-12-31", met: 5 },
]);
ok(
    restoredDiscovery.changed && restoredDiscovery.rows.length === 1 && restoredDiscovery.rows[0].label === "THE MOON",
    "restored discovery snapshot replaces prior discovery rows",
);
const cataclysmRow = { id: "event:1", label: "Moon torn apart", tSimSec: 30, tier: "modeled", source: "event", sequence: 1 };
const mergedRecent = mergeRecentRows(restoredDiscovery.rows, [cataclysmRow], 12);
ok(
    mergedRecent.some(row => row.id === cataclysmRow.id) && mergedRecent.some(row => row.label === "THE MOON"),
    "discovery replacement preserves cataclysm rows",
);

class FakeNode {
    constructor(id) { this.id = id; this.parentNode = null; }
    get nextSibling() {
        if (!this.parentNode) return null;
        const i = this.parentNode.children.indexOf(this);
        return this.parentNode.children[i + 1] || null;
    }
    remove() {
        if (!this.parentNode) return;
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
    }
}
class FakeParent {
    constructor() { this.children = []; }
    get firstChild() { return this.children[0] || null; }
    insertBefore(node, before) {
        if (node.parentNode) node.remove();
        const i = before ? this.children.indexOf(before) : this.children.length;
        this.children.splice(i < 0 ? this.children.length : i, 0, node);
        node.parentNode = this;
    }
}
const fakeParent = new FakeParent();
const fakeViews = new Map();
const createFakeView = item => ({ node: new FakeNode(item.id), value: "" });
const updateFakeView = (view, item) => { view.value = item.label; };
reconcileKeyedRows(fakeParent, [{ id: "a", label: "A" }, { id: "b", label: "B" }], fakeViews, createFakeView, updateFakeView);
const stableA = fakeViews.get("a").node;
const unchangedReconcile = reconcileKeyedRows(
    fakeParent,
    [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    fakeViews,
    createFakeView,
    updateFakeView,
);
ok(
    unchangedReconcile.created === 0 && unchangedReconcile.moved === 0 && unchangedReconcile.removed === 0 && fakeViews.get("a").node === stableA,
    "unchanged keyed rows retain identity without DOM moves",
);
const appendReconcile = reconcileKeyedRows(
    fakeParent,
    [{ id: "c", label: "C" }, { id: "a", label: "A" }, { id: "b", label: "B" }],
    fakeViews,
    createFakeView,
    updateFakeView,
);
ok(
    appendReconcile.created === 1 && appendReconcile.moved === 0 && fakeParent.children.map(node => node.id).join(",") === "c,a,b" && fakeViews.get("a").node === stableA,
    "append-only keyed update inserts one row and keeps retained nodes stable",
);
const replaceReconcile = reconcileKeyedRows(
    fakeParent,
    [{ id: "d", label: "D" }],
    fakeViews,
    createFakeView,
    updateFakeView,
);
ok(
    replaceReconcile.created === 1 && replaceReconcile.removed === 3 && fakeParent.children[0].id === "d",
    "keyed reconciliation removes only rows absent from a restored snapshot",
);

const reorderParent = new FakeParent();
const reorderViews = new Map();
reconcileKeyedRows(
    reorderParent,
    [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
    reorderViews,
    createFakeView,
    updateFakeView,
);
const retainedNodes = new Map([...reorderViews].map(([id, view]) => [id, view.node]));
const cyclicReconcile = reconcileKeyedRows(
    reorderParent,
    [{ id: "b", label: "B" }, { id: "c", label: "C" }, { id: "a", label: "A" }],
    reorderViews,
    createFakeView,
    updateFakeView,
);
ok(
    cyclicReconcile.created === 0 && cyclicReconcile.moved === 1 && cyclicReconcile.removed === 0 &&
        reorderParent.children.map(node => node.id).join(",") === "b,c,a" &&
        [...retainedNodes].every(([id, node]) => reorderViews.get(id).node === node),
    "cyclic keyed reorder uses one retained-node move",
);

class FakeClassList {
    constructor() { this.values = new Set(); this.writes = 0; }
    contains(name) { return this.values.has(name); }
    toggle(name, force) {
        const enabled = force === undefined ? !this.values.has(name) : !!force;
        const changed = enabled ? !this.values.has(name) : this.values.has(name);
        if (enabled) this.values.add(name);
        else this.values.delete(name);
        if (changed) this.writes++;
        return enabled;
    }
}
class FakeUiNode {
    constructor() {
        this.classList = new FakeClassList();
        this.attributes = new Map();
        this._hidden = false;
        this._textContent = "";
        this.writes = 0;
        this.focuses = 0;
        this.visible = true;
    }
    get hidden() { return this._hidden; }
    set hidden(value) { this._hidden = !!value; this.writes++; }
    get textContent() { return this._textContent; }
    set textContent(value) { this._textContent = String(value); this.writes++; }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); this.writes++; }
    focus() { this.focuses++; }
    getClientRects() { return this.visible ? [{}] : []; }
}
const controllerNodes = {
    panel: new FakeUiNode(),
    button: new FakeUiNode(),
    close: new FakeUiNode(),
    jumpDock: new FakeUiNode(),
    jumpDockLabel: new FakeUiNode(),
    jumpChip: new FakeUiNode(),
    jumpChipLabel: new FakeUiNode(),
    jumpChipEta: new FakeUiNode(),
};
controllerNodes.button.setAttribute("aria-expanded", "false");
controllerNodes.jumpDock.hidden = true;
controllerNodes.jumpChip.hidden = true;
let controllerCancels = 0;
const eventController = createEventController({
    ...controllerNodes,
    cancelJump() { controllerCancels++; return true; },
});
ok(
    eventController.syncDiscovery(1, "replace") !== 0 && !eventController.hasUnread(),
    "event controller treats pristine initialization as a seen baseline",
);
ok(
    eventController.syncDiscovery(2, "replace") !== 0 && !eventController.hasUnread(),
    "event controller treats restored history replacement as a seen baseline",
);
const stableControllerWrites = controllerNodes.button.writes + controllerNodes.button.classList.writes;
ok(
    eventController.syncDiscovery(2, "replace") === 0 &&
        controllerNodes.button.writes + controllerNodes.button.classList.writes === stableControllerWrites,
    "unchanged discovery revision performs zero controller DOM writes",
);
eventController.syncDiscovery(3, "append");
ok(eventController.hasUnread() && controllerNodes.button.classList.contains("evBtn--new"), "closed live append sets unread");
eventController.setLive(true);
ok(
    controllerNodes.button.classList.contains("evBtn--new") && controllerNodes.button.classList.contains("evBtn--live"),
    "live TDE state coexists with unread for amber CSS precedence",
);
eventController.toggleOpen();
ok(
    eventController.isOpen() && !eventController.hasUnread() && controllerNodes.close.focuses === 1 &&
        controllerNodes.button.getAttribute("aria-expanded") === "true",
    "opening the sheet clears unread and focuses close",
);
eventController.syncDiscovery(4, "append");
eventController.setOpen(false);
ok(!eventController.hasUnread() && controllerNodes.button.focuses === 1, "activity viewed while open stays seen on close");
eventController.setOpen(true);
ok(eventController.handleEscape("Escape") && !eventController.isOpen(), "Escape closes the sheet");
eventController.setOpen(true);
eventController.handleMode("pilot", false, false, false);
ok(!eventController.isOpen(), "mode change closes the sheet");
ok(
    eventSurfaceAllowed("observe", false, false, false) &&
        !eventSurfaceAllowed("pilot", false, false, false) &&
        !eventSurfaceAllowed("observe", true, false, false) &&
        !eventSurfaceAllowed("observe", false, true, false) &&
        !eventSurfaceAllowed("observe", false, false, true),
    "responsive event surface decisions match OBSERVE and hidden-mode contracts",
);

eventController.beginJump(100);
eventController.renderJump(true, "TEST EVENT", 3, 0, 1000, "");
ok(!controllerNodes.jumpChip.hidden && /TEST EVENT/.test(controllerNodes.jumpChipLabel.textContent), "rapid jump start shows the chip");
eventController.requestCancel(0, 1100);
ok(
    controllerCancels === 1 && controllerNodes.jumpChipLabel.textContent === "Jump cancelled" &&
        controllerNodes.jumpChipEta.textContent === "" && !controllerNodes.jumpChip.hidden,
    "cancel uses the shared readable end latch and clears ETA",
);
eventController.renderJump(false, "", 0, 0, 1100 + CONTROLLER_JUMP_END_LATCH_MS - 1, "cancel");
const latchStillVisible = !controllerNodes.jumpChip.hidden;
eventController.renderJump(false, "", 0, 0, 1100 + CONTROLLER_JUMP_END_LATCH_MS, "cancel");
ok(latchStillVisible && controllerNodes.jumpChip.hidden, "jump end latch expires after 1.5 seconds");
for (const safety of ["death", "landing", "thrust", "TDE"]) {
    eventController.beginJump(10);
    eventController.renderJump(true, safety.toUpperCase() + " EVENT", 1, 0, 3000, "");
    eventController.renderJump(false, "", 0, 10, 3001, "cancel");
    ok(
        controllerNodes.jumpChipLabel.textContent === "Jump cancelled" && !controllerNodes.jumpChip.hidden,
        safety + " on the target frame remains a cancellation in the controller",
    );
}
eventController.beginJump(10);
eventController.renderJump(true, "FAST EVENT", 1, 0, 5000, "");
eventController.renderJump(false, "", 0, 10, 5001, "arrive");
ok(
    controllerNodes.jumpChipLabel.textContent === "Arrived at FAST EVENT" && !controllerNodes.jumpChip.hidden,
    "rapid start and arrival produces one readable arrival confirmation",
);

const evDockAt = indexSource.indexOf('id="evDock"');
const evPanelAt = indexSource.indexOf('id="evPanel"');
ok(
    evDockAt >= 0 && evDockAt < evPanelAt &&
        /id="evBtn"[^>]*aria-controls="evPanel"[^>]*aria-expanded="false"/.test(indexSource) &&
        /id="evBtnDot"[^>]*aria-hidden="true"/.test(indexSource) &&
        /id="evJumpChip"[^>]*hidden/.test(indexSource) &&
        /id="evJumpChipLabel"[^>]*aria-live="polite"/.test(indexSource) &&
        /id="evJumpChipEta"/.test(indexSource) &&
        /id="evJumpCancel"[^>]*aria-label="Cancel time jump"/.test(indexSource) &&
        /id="evClose"[^>]*aria-label="Close events"/.test(indexSource),
    "mobile events dock, jump chip, and close control are static accessible nodes",
);

const updateEventsSource = eventsSource.slice(eventsSource.indexOf("export function updateEvents"));
ok(
    /import \{[^}]*getRecentDiscoverySnapshot[^}]*\} from "\.\/discoveryLog\.js"/.test(eventsSource) &&
        /import \{[^}]*createEventController[^}]*\} from "\.\/universe\/eventController\.js"/.test(eventsSource) &&
        /function setEventsOpen\(/.test(eventsSource) &&
        /getElementById\("evBtn"\)/.test(eventsSource) &&
        /getElementById\("evClose"\)/.test(eventsSource) &&
        /getElementById\("evJumpChip"\)/.test(eventsSource) &&
        /getElementById\("evJumpCancel"\)/.test(eventsSource) &&
        /controller\.syncDiscovery\(source\.revision, source\.change\)/.test(eventsSource) &&
        /controller\?\.noteActivity\(\)/.test(eventsSource) &&
        !/getElementById|querySelector|addEventListener/.test(updateEventsSource),
    "events adapter uses cached nodes and the behavior-tested controller without HUD listener churn",
);
ok(
    /row\.displayTime \|\| fmtCivil\(civilDateAt\(getEpochMs\(\), row\.tSimSec\)\)/.test(eventsSource),
    "timeline rendering uses the Earth scenario's coarse display time when supplied",
);

const newDotRuleAt = styleSource.indexOf("#evBtn.evBtn--new #evBtnDot");
const liveDotRuleAt = styleSource.indexOf("#evBtn.evBtn--live #evBtnDot");
ok(
    newDotRuleAt >= 0 && liveDotRuleAt > newDotRuleAt &&
        /#evBtn\.evBtn--new #evBtnDot\s*\{[^}]*var\(--cyan\)/s.test(styleSource) &&
        /#evBtn\.evBtn--live #evBtnDot\s*\{[^}]*var\(--amber\)/s.test(styleSource),
    "unread cyan styling remains below the live TDE amber precedence rule",
);

ok(
    /endLatchMs: JUMP_END_LATCH_MS/.test(eventsSource) &&
        /controller\.beginJump\(view\.row\.tSimSec\)/.test(eventsSource) &&
        /controller\.requestCancel\(G\.t, wallNowMs\(\)\)/.test(eventsSource) &&
        /controller\.renderJump\(status\.active, status\.label, status\.etaWallSec, G\.t, wallNowMs\(\), status\.outcome\)/.test(eventsSource),
    "events adapter routes jump start, cancel, and end rendering through the tested latch controller",
);

ok(
    /#evDock,\s*#evBtn,\s*#evClose,\s*#evJumpChip\s*\{\s*display:\s*none;/.test(styleSource) &&
        !/#timeDock,\s*#evPanel/.test(styleSource) &&
        /#evBtn\s*\{[^}]*backdrop-filter:\s*var\(--blur\);[^}]*-webkit-backdrop-filter:\s*var\(--blur\);/s.test(styleSource) &&
        /#evJumpChip\s*\{[^}]*backdrop-filter:\s*var\(--blur\);[^}]*-webkit-backdrop-filter:\s*var\(--blur\);/s.test(styleSource) &&
        /#evDock\s*\{[^}]*top:\s*calc\(56px \+ env\(safe-area-inset-top,\s*0px\)\)[^}]*z-index:\s*13/s.test(styleSource) &&
        /body\.mode-observe:not\(\.mode-xr\):not\(\.mode-cabin\):not\(\.mode-clean\) #evBtn\s*\{\s*display:\s*inline-flex;/.test(styleSource) &&
        /#evJumpChip:not\(\[hidden\]\)\s*\{\s*display:\s*flex;/.test(styleSource) &&
        /#evPanel\.open\s*\{[^}]*left:\s*10px;[^}]*right:\s*10px;[^}]*max-height:\s*62dvh;[^}]*z-index:\s*23/s.test(styleSource) &&
        /#evPanel\.open\s*\{[^}]*right:\s*calc\(14px \+ env\(safe-area-inset-right,\s*0px\)\);[^}]*width:\s*min\(420px,\s*calc\(100vw - 28px\)\);[^}]*max-height:\s*70dvh/s.test(styleSource) &&
        /#evClose\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px/s.test(styleSource) &&
        /\.evJump,\s*\.evWatch\s*\{[^}]*min-height:\s*40px/s.test(styleSource) &&
        /body\.mode-cabin #evJumpChip,\s*body\.mode-clean #evJumpChip,\s*body\.mode-xr #evJumpChip\s*\{\s*display:\s*none !important;/.test(styleSource) &&
        /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*#evPanel\.open\s*\{\s*animation:\s*none;/s.test(styleSource),
    "coarse events pill, sheet, and jump chip follow the frozen responsive visibility contract",
);

class ModuleDomNode {
    constructor() {
        this.children = [];
        this.style = {};
        this.className = "";
        this.textContent = "";
        this.parentNode = null;
    }
    get firstChild() { return this.children[0] || null; }
    appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
    remove() {
        if (!this.parentNode) return;
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) this.parentNode.children.splice(index, 1);
        this.parentNode = null;
    }
}
const moduleDomNodes = new Map();
globalThis.window = {};
globalThis.document = {
    getElementById(id) {
        if (!moduleDomNodes.has(id)) moduleDomNodes.set(id, new ModuleDomNode());
        return moduleDomNodes.get(id);
    },
    createElement() { return new ModuleDomNode(); },
};
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = callback => { callback(); return 0; };
const [{ G, GS, WORLD }, timeCtl] = await Promise.all([
    import("../src/state.js"),
    import("../src/timeCtl.js"),
]);
ok(
    feasibilityCases.every(state =>
        timeCtl.maxFeasibleWarp(state) ===
        maxFeasibleWarpScalar(state.gsCount, state.landed, state.dead, state.bhN)
    ),
    "time-control object overrides remain equivalent to the scalar feasibility API",
);
G.warp = 60;
G.paused = true;
G.dead = false;
G.landed = null;
G.t = 0;
GS.length = 0;
WORLD.tdeInProgress = false;
const startViewBefore = { ...timeCtl.jumpStatus() };
let unsafeStartsPreserved = true;
for (const unsafe of [...unsafeStartPlans.slice(0, 3), malformedRuntimePlans[0]]) {
    const unsafeStart = timeCtl.startTimeJump(unsafe.plan, { label: "UNSAFE" });
    unsafeStartsPreserved = unsafeStartsPreserved && unsafeStart === false && !timeCtl.jumpActive() &&
        G.warp === 60 && G.paused === true &&
        timeCtl.jumpStatus().active === startViewBefore.active &&
        timeCtl.jumpStatus().label === startViewBefore.label &&
        timeCtl.jumpStatus().etaWallSec === startViewBefore.etaWallSec;
}
GS.push({});
const infeasibleStart = timeCtl.startTimeJump(unsafeStartPlans[3].plan, { label: "INFEASIBLE" });
GS.length = 0;
unsafeStartsPreserved = unsafeStartsPreserved && infeasibleStart === false && !timeCtl.jumpActive() &&
    G.warp === 60 && G.paused === true;
ok(
    unsafeStartsPreserved,
    "oversized, off-origin, off-ladder, infeasible, and malformed public starts preserve state",
);

WORLD.tdeInProgress = true;
const activeTdeStart = timeCtl.startTimeJump(deliveryPlan, { label: "TDE" });
const activeTdePreserved = activeTdeStart === false && !timeCtl.jumpActive() && G.paused === true && G.warp === 60;
if (timeCtl.jumpActive()) timeCtl.cancelTimeJump("test cleanup");
WORLD.tdeInProgress = false;
ok(activeTdePreserved, "public jump start refuses an already-active TDE without state changes");

function resetPublicJumpState(warp = 60) {
    if (timeCtl.jumpActive()) timeCtl.cancelTimeJump("test cleanup");
    timeCtl.setExternalTimeDriver(false);
    G.warp = warp;
    G.paused = true;
    G.dead = false;
    G.landed = null;
    G.t = 0;
    GS.length = 0;
    WORLD.tdeInProgress = false;
}

function startEscalatedPublicJump(wallDeltaSec) {
    resetPublicJumpState(60);
    const started = timeCtl.startTimeJump(plan, { label: "DEEP EVENT" });
    const frame = started && timeCtl.tickJump(wallDeltaSec, 1 / 30, false);
    return frame;
}

function countWarpWrites(action) {
    let value = G.warp;
    let writes = 0;
    let result;
    Object.defineProperty(G, "warp", {
        configurable: true,
        enumerable: true,
        get() { return value; },
        set(next) { writes++; value = next; },
    });
    try {
        result = action();
    } finally {
        Object.defineProperty(G, "warp", {
            configurable: true,
            enumerable: true,
            writable: true,
            value,
        });
    }
    return { result, value, writes };
}

let publicFrame = startEscalatedPublicJump(2.1);
ok(publicFrame?.kind === "run" && G.warp >= 3600, "production seam escalates a jump through the 3600x rung");
const cancelRestore = countWarpWrites(() => timeCtl.cancelTimeJump("cancel button"));
ok(
    cancelRestore.result === true && cancelRestore.value === 60 && cancelRestore.writes === 1 &&
        timeCtl.jumpStatus().outcome === "cancel",
    "public cancel restores the captured warp once after deep-rung escalation",
);

publicFrame = startEscalatedPublicJump(20);
ok(publicFrame?.kind === "run" && G.warp === WARP_MAX, "production seam reaches WARP_MAX before cancellation");
const pauseRestore = countWarpWrites(() => timeCtl.setPaused(true, "dock"));
ok(
    pauseRestore.value === 60 && pauseRestore.writes === 1 && G.paused === true &&
        timeCtl.jumpStatus().outcome === "cancel",
    "pause cancellation restores warp once and preserves the requested paused state",
);

publicFrame = startEscalatedPublicJump(20);
const driverRestore = countWarpWrites(() => timeCtl.setExternalTimeDriver(true));
ok(
    publicFrame?.kind === "run" && driverRestore.value === 60 && driverRestore.writes === 1 &&
        timeCtl.jumpStatus().outcome === "cancel",
    "external-driver handoff restores the captured warp once from WARP_MAX",
);
timeCtl.setExternalTimeDriver(false);

resetPublicJumpState(1234);
const malformedRestoreStart = timeCtl.startTimeJump(deliveryPlan, { label: "SAFE RESTORE" });
timeCtl.cancelTimeJump("cancel button");
ok(
    !!malformedRestoreStart && WARPS.includes(G.warp) && G.warp <= 600,
    "public cancellation sanitizes an off-ladder captured warp",
);
resetPublicJumpState(NaN);
const nonfiniteRestoreStart = timeCtl.startTimeJump(deliveryPlan, { label: "FINITE RESTORE" });
timeCtl.cancelTimeJump("cancel button");
ok(
    !!nonfiniteRestoreStart && WARPS.includes(G.warp) && Number.isFinite(G.warp),
    "public cancellation sanitizes a nonfinite captured warp",
);

const terminalPlan = {
    ok: true,
    targetSec: 1,
    etaWallSec: 1 / 60,
    holdWarp: 60,
    legs: [{ kind: "hold", warp: 60, fromSimT: 0, toSimT: 1, wallSec: 1 / 60 }],
};

function settlePublicTargetFrame(safety = "", capturedWarp = 1) {
    resetPublicJumpState(capturedWarp);
    const started = timeCtl.startTimeJump(terminalPlan, { label: "TARGET EVENT" });
    const frame = started && timeCtl.tickJump(1 / 60, 1 / 60, false);
    if (!frame) return null;
    G.t = frame.targetSimTimeSec;
    if (safety === "death") G.dead = true;
    if (safety === "landing") G.landed = { body: "earth" };
    if (safety === "TDE") WORLD.tdeInProgress = true;
    return countWarpWrites(
        () => timeCtl.settleTimeJump(frame, frame.advanceSec, safety === "thrust"),
    );
}

const staleDeathTerminal = settlePublicTargetFrame("death", WARP_MAX);
ok(
    staleDeathTerminal.result?.kind === "cancel" && staleDeathTerminal.value === WARPS[0] &&
        staleDeathTerminal.writes === 1,
    "post-physics death zero ceiling restores the slowest 0.01x valid ladder fallback once",
);

function terminatePublicBeforePhysics(safety) {
    resetPublicJumpState(WARP_MAX);
    const started = timeCtl.startTimeJump(terminalPlan, { label: "PRE-PHYSICS EVENT" });
    if (!started) return null;
    if (safety === "death") G.dead = true;
    if (safety === "landing") G.landed = { body: "earth" };
    if (safety === "TDE") WORLD.tdeInProgress = true;
    return countWarpWrites(
        () => timeCtl.tickJump(1 / 60, 1 / 60, safety === "thrust"),
    );
}

for (const safety of ["death", "landing", "thrust", "TDE"]) {
    const terminal = terminatePublicBeforePhysics(safety);
    const expectedWarp = safety === "death" ? WARPS[0] : 600;
    ok(
        terminal?.result === null && terminal.value === expectedWarp && terminal.writes === 1 &&
            !timeCtl.jumpActive() && timeCtl.jumpStatus().outcome === "cancel",
        "pre-physics public " + safety + " restores WARP_MAX within the live ceiling once",
    );
}

for (const safety of ["death", "landing", "thrust", "TDE"]) {
    const terminal = settlePublicTargetFrame(safety, WARP_MAX);
    const expectedWarp = safety === "death" ? WARPS[0] : 600;
    ok(
        (terminal.result?.kind === "cancel" || terminal.result?.kind === "tde") &&
            terminal.value === expectedWarp && terminal.writes === 1 &&
            timeCtl.jumpStatus().outcome === "cancel",
        "post-physics public " + safety + " restores WARP_MAX within the live ceiling once",
    );
}

resetPublicJumpState(WARP_MAX);
timeCtl.startTimeJump(terminalPlan, { label: "FEASIBLE CANCEL" });
const feasibleCancel = countWarpWrites(() => timeCtl.cancelTimeJump("cancel button"));
ok(
    feasibleCancel.value === WARP_MAX && feasibleCancel.writes === 1,
    "direct cancellation preserves a captured WARP_MAX rung while it remains feasible",
);

function startJumpThenAddGravityGhost() {
    resetPublicJumpState(WARP_MAX);
    const started = timeCtl.startTimeJump(terminalPlan, { label: "STALE FEASIBILITY" });
    if (started) GS.push({});
    return started;
}

startJumpThenAddGravityGhost();
const staleGsCancel = countWarpWrites(() => timeCtl.cancelTimeJump("cancel button"));
ok(
    staleGsCancel.value === 600 && staleGsCancel.writes === 1,
    "direct cancellation applies a newly introduced gravity-ghost ceiling",
);

startJumpThenAddGravityGhost();
const staleGsPause = countWarpWrites(() => timeCtl.setPaused(true, "dock"));
ok(
    staleGsPause.value === 600 && staleGsPause.writes === 1 && G.paused,
    "pause cancellation applies a newly introduced gravity-ghost ceiling once",
);

startJumpThenAddGravityGhost();
const staleGsDriver = countWarpWrites(() => timeCtl.setExternalTimeDriver(true));
ok(
    staleGsDriver.value === 600 && staleGsDriver.writes === 1,
    "external-driver cancellation applies a newly introduced gravity-ghost ceiling once",
);
timeCtl.setExternalTimeDriver(false);

resetPublicJumpState(WARP_MAX);
const staleGsArrivalStart = timeCtl.startTimeJump(terminalPlan, { label: "STALE ARRIVAL" });
const staleGsArrivalFrame = staleGsArrivalStart && timeCtl.tickJump(1 / 60, 1 / 60, false);
if (staleGsArrivalFrame) {
    G.t = staleGsArrivalFrame.targetSimTimeSec;
    GS.push({});
}
const staleGsArrival = countWarpWrites(
    () => timeCtl.settleTimeJump(staleGsArrivalFrame, staleGsArrivalFrame?.advanceSec || 0, false),
);
ok(
    staleGsArrival.result?.kind === "arrive" && staleGsArrival.value === 600 &&
        staleGsArrival.writes === 1 && timeCtl.jumpStatus().outcome === "arrive",
    "successful arrival applies a newly introduced gravity-ghost ceiling once",
);

for (const safety of ["death", "landing", "thrust", "TDE"]) {
    const terminal = settlePublicTargetFrame(safety);
    const expectedWarp = safety === "death" ? WARPS[0] : 1;
    ok(
        (terminal.result?.kind === "cancel" || terminal.result?.kind === "tde") &&
            terminal.value === expectedWarp &&
            terminal.writes === 1 &&
            timeCtl.jumpStatus().outcome === "cancel",
        safety + " wins over target-frame arrival and restores the captured warp once",
    );
}

const successfulTerminal = settlePublicTargetFrame();
ok(
    successfulTerminal.result?.kind === "arrive" && successfulTerminal.value === 1 &&
        successfulTerminal.writes === 1 && timeCtl.jumpStatus().outcome === "arrive",
    "full target delivery records arrival and restores the captured warp once",
);
resetPublicJumpState(1);
const laterJump = timeCtl.startTimeJump(terminalPlan, { label: "LATER EVENT" });
ok(!!laterJump && timeCtl.jumpStatus().outcome === "", "a later jump clears the prior terminal outcome");
timeCtl.cancelTimeJump("test cleanup");

const discoveryLog = await import("../src/discoveryLog.js");
discoveryLog.clearLog();
const pristineDiscoverySnapshot = discoveryLog.getRecentDiscoverySnapshot();
const pristineDiscoverySnapshotAgain = discoveryLog.getRecentDiscoverySnapshot();
ok(
    pristineDiscoverySnapshot === pristineDiscoverySnapshotAgain &&
        pristineDiscoverySnapshot.change === "replace" && pristineDiscoverySnapshot.entries.length === 0,
    "pristine discovery state exposes one stable replacement snapshot",
);

discoveryLog.restoreLog({
    seen: { bodies: [], stars: ["hyg:32349"], notables: [] },
    entries: [{ kind: "star", id: "hyg:32349", label: "SIRIUS", civil: "2000-01-01", met: 10 }],
    records: {},
});
const restoredLogSnapshot = discoveryLog.getRecentDiscoverySnapshot();
ok(
    restoredLogSnapshot.revision > pristineDiscoverySnapshot.revision &&
        restoredLogSnapshot.change === "replace" && restoredLogSnapshot.entries.length === 1,
    "nonempty restore advances discovery revision with replacement semantics",
);
const restoredEntriesIdentity = restoredLogSnapshot.entries;
const restoredLogSnapshotAgain = discoveryLog.getRecentDiscoverySnapshot();
ok(
    restoredLogSnapshotAgain === restoredLogSnapshot && restoredLogSnapshotAgain.entries === restoredEntriesIdentity,
    "unchanged discovery reads allocate no snapshot array or entry copies",
);

discoveryLog.noteStar("cell:1:2:3", "MW-7K3FQ");
const appendedLogSnapshot = discoveryLog.getRecentDiscoverySnapshot();
ok(
    appendedLogSnapshot.revision > restoredLogSnapshot.revision && appendedLogSnapshot.change === "append" &&
        appendedLogSnapshot.entries.length === 2 && appendedLogSnapshot.entries[1].id === "cell:1:2:3",
    "live discovery append advances revision with append semantics",
);
discoveryLog.restoreLog({
    seen: { bodies: ["moon:0"], stars: [], notables: [] },
    entries: [{ kind: "moon", id: "moon:0", label: "THE MOON", civil: "2000-01-02", met: 20 }],
    records: {},
});
const replacementLogSnapshot = discoveryLog.getRecentDiscoverySnapshot();
ok(
    replacementLogSnapshot.revision > appendedLogSnapshot.revision && replacementLogSnapshot.change === "replace" &&
        replacementLogSnapshot.entries.length === 1 && replacementLogSnapshot.entries[0].label === "THE MOON",
    "replacement restore publishes one new stable tail snapshot",
);
globalThis.setTimeout = realSetTimeout;

process.exit(fails ? 1 : 0);
