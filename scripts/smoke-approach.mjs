// Pure close-approach prediction smoke.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { AU_KM, MU_S, SEC_YEAR, WARPS, WARP_MAX } from "../src/constants.js";
import { reconcileKeyedRows } from "../src/universe/epistemic.js";

let fails = 0;
const ok = (condition, label) => {
    console.log((condition ? "PASS" : "FAIL") + " " + label);
    if (!condition) fails++;
};

delete globalThis.window;
delete globalThis.document;
const timeline = await import("../src/universe/eventTimeline.js");
const {
    closeApproaches,
    createCloseApproachScan,
    createJumpRuntime,
    nextConjunction,
    pairDistanceAt,
    planJump,
    predictedLead,
} = timeline;
ok(typeof closeApproaches === "function" && typeof pairDistanceAt === "function", "pure predictor imports in bare Node");

const a1 = AU_KM;
const a2 = 1.6 * AU_KM;
const n1 = Math.sqrt(MU_S / (a1 ** 3));
const n2 = Math.sqrt(MU_S / (a2 ** 3));
const phaseGap = 1;
const conjunctionSec = phaseGap / (n1 - n2);
const bodies = [
    { name: "S1", a: a1, e: 0, varpi: 0, phase: 0, n: n1 },
    { name: "S2", a: a2, e: 0, varpi: 0, phase: phaseGap, n: n2 },
];
const rows = closeApproaches?.({
    fromSec: 0,
    spanSec: conjunctionSec * 2,
    bodies,
    pairs: [[0, 1]],
    perturbed: false,
});
ok(Array.isArray(rows) && rows.length >= 1, "synthetic circular conjunction found");
const best = rows?.reduce((minimum, row) => row.distKm < minimum.distKm ? row : minimum, rows[0]);
ok(
    best && Math.abs(best.tSimSec - conjunctionSec) < 3600,
    "golden refinement recovers the analytic conjunction within one hour",
);
ok(
    best && Math.abs(best.distKm - (a2 - a1)) < 1e-4 * AU_KM,
    "synthetic minimum distance matches the circular-orbit solution",
);
ok(
    Math.abs(pairDistanceAt?.(bodies[0], bodies[1], conjunctionSec) - (a2 - a1)) < 1e-9 * AU_KM,
    "pairDistanceAt evaluates the analytic minimum without shared state",
);
const coarseDt = (2 * Math.PI / n1) / 64;
ok(coarseDt > 86400, "coarse samples remain days apart before refinement");

const realFirst = closeApproaches({ fromSec: 0, spanSec: 3 * SEC_YEAR, perturbed: false });
const realSecond = closeApproaches({ fromSec: 0, spanSec: 3 * SEC_YEAR, perturbed: false });
const venusEarth = realFirst.filter(row => /VENUS–EARTH|EARTH–VENUS/.test(row.label));
ok(venusEarth.length >= 1, "default elements find a Venus–Earth approach within three years");
ok(
    venusEarth[0]?.distKm > 0.2 * AU_KM && venusEarth[0]?.distKm < 0.35 * AU_KM,
    "Venus–Earth distance stays within the two-body physical range",
);
ok(
    realFirst.every((row, index) => index === 0 || realFirst[index - 1].tSimSec <= row.tSimSec) &&
        JSON.stringify(realFirst) === JSON.stringify(realSecond),
    "real rows retain deterministic chronological order and values",
);
ok(
    new Set(realFirst.map(row => row.id)).size === realFirst.length &&
        realFirst.every(row => row.tier === "modeled" && /\(two-body estimate\)$/.test(row.label)),
    "real rows have unique stable ids and modeled two-body labels",
);

const nowFirst = nextConjunction?.({ fromSec: 0 });
const nowSecond = nextConjunction?.({ fromSec: 0 });
ok(
    nowFirst && nowFirst.tSimSec > 0 && nowFirst.tSimSec < 3 * SEC_YEAR,
    "NOW conjunction falls within three years",
);
ok(
    nowFirst?.id === nowSecond?.id && nowFirst?.tSimSec === nowSecond?.tSimSec &&
        nowFirst?.label === nowSecond?.label,
    "NOW row is deterministic",
);
ok(
    /^NOW · next conjunction:/.test(nowFirst?.label || "") &&
        /\(two-body estimate\)$/.test(nowFirst?.label || "") && nowFirst?.tier === "modeled",
    "NOW row carries modeled two-body semantics",
);

const physicalNeighborNames = [
    ["MERCURY", "VENUS"],
    ["VENUS", "EARTH"],
    ["EARTH", "MARS"],
    ["MARS", "JUPITER"],
    ["JUPITER", "SATURN"],
    ["SATURN", "URANUS"],
    ["URANUS", "NEPTUNE"],
];
const syntheticConjunctionBodies = names => [
    { name: names[0], a: a1, e: 0, varpi: 0, phase: 0, n: n1 },
    { name: names[1], a: a2, e: 0, varpi: 0, phase: phaseGap, n: n2 },
];
const physicalNeighborRows = physicalNeighborNames.map(names => nextConjunction({
    fromSec: 0,
    spanSec: conjunctionSec * 2,
    bodies: syntheticConjunctionBodies(names),
}));
const skippedVenusMars = nextConjunction({
    fromSec: 0,
    spanSec: conjunctionSec * 2,
    bodies: syntheticConjunctionBodies(["VENUS", "MARS"]),
});
ok(
    physicalNeighborRows.every((row, index) =>
        row?.pair?.[0]?.name === physicalNeighborNames[index][0] &&
        row?.pair?.[1]?.name === physicalNeighborNames[index][1]
    ) && skippedVenusMars === null,
    "conjunction membership follows seven physical neighbors and excludes Venus–Mars",
);

let perturbedElementReads = 0;
const inaccessibleBody = new Proxy({}, {
    get() {
        perturbedElementReads++;
        throw new Error("orbital element accessed during suppression");
    },
});
let suppressed;
try {
    suppressed = closeApproaches({
        fromSec: 0,
        spanSec: SEC_YEAR,
        bodies: [inaccessibleBody],
        perturbed: true,
    });
} catch {
    suppressed = null;
}
ok(
    suppressed?.suppressed === true && Object.keys(suppressed).join(",") === "suppressed",
    "perturbed mode returns the documented suppression result",
);
ok(perturbedElementReads === 0, "perturbed mode exits before conic element access");

const lead = predictedLead?.(best);
ok(
    Number.isFinite(lead?.leadSec) && lead.leadSec >= 30 * 86400,
    "predicted lead is finite and honors the 30-day floor",
);
ok(
    WARPS.includes(lead?.holdWarp) && lead.leadSec / lead.holdWarp >= 2 && lead.leadSec / lead.holdWarp <= 16,
    "predicted lead selects an allowed hold rung near eight wall seconds",
);

const jumpNowSec = best.tSimSec - lead.leadSec - 86400;
const defaultPlan = planJump(jumpNowSec, best.tSimSec, WARP_MAX);
const emptyOptionsPlan = planJump(jumpNowSec, best.tSimSec, WARP_MAX, {});
ok(
    JSON.stringify(defaultPlan) === JSON.stringify(emptyOptionsPlan),
    "empty jump options preserve the default plan byte semantics",
);
const overridePlan = planJump(jumpNowSec, best.tSimSec, WARP_MAX, lead);
const overrideRuntime = createJumpRuntime(overridePlan, {}, {
    currentWarp: 1,
    simTimeSec: jumpNowSec,
    feasibleWarp: WARP_MAX,
});
ok(
    overridePlan.ok && overridePlan.holdWarp === lead.holdWarp && overrideRuntime.validPlan,
    "predicted overrides produce a runtime-valid plan",
);
ok(
    overridePlan.legs.every((leg, index) =>
        WARPS.includes(leg.warp) && leg.toSimT > leg.fromSimT &&
        (index === 0 || leg.fromSimT === overridePlan.legs[index - 1].toSimT)
    ) && overridePlan.legs.at(-1)?.toSimT === best.tSimSec,
    "predicted override legs remain contiguous and reach the target",
);
ok(
    Math.abs(best.tSimSec - overridePlan.legs.at(-1)?.fromSimT - lead.leadSec) <= 1,
    "predicted hold starts at the measured lead boundary",
);

const slicedOptions = {
    fromSec: 0,
    spanSec: SEC_YEAR,
    bodies: [
        ...bodies,
        { name: "S3", a: 2.2 * AU_KM, e: 0, varpi: 0, phase: 0.4, n: Math.sqrt(MU_S / ((2.2 * AU_KM) ** 3)) },
    ],
    pairs: [[0, 1], [1, 2], [1, 0]],
};
const slicedScan = typeof createCloseApproachScan === "function"
    ? createCloseApproachScan(slicedOptions)
    : null;
let sliceCount = 0;
while (slicedScan && !slicedScan.done && sliceCount < 10) {
    slicedScan.step();
    sliceCount++;
}
ok(
    slicedScan?.done && JSON.stringify(slicedScan.result()) === JSON.stringify(closeApproaches(slicedOptions)),
    "pair-sliced scan merges to the synchronous deterministic result",
);
ok(sliceCount === 2, "two unique pairs use two slices while a reversed duplicate collapses");

const coarseWorkBudget = 7;
const boundedOptions = {
    fromSec: 0,
    spanSec: 5 * SEC_YEAR,
    bodies,
    pairs: [[0, 1]],
};
const forwardPairRows = closeApproaches({ ...boundedOptions, pairs: [[0, 1]] });
const reversePairRows = closeApproaches({ ...boundedOptions, pairs: [[1, 0]] });
const reorderedPairRows = closeApproaches({
    ...boundedOptions,
    bodies: [bodies[1], bodies[0]],
    pairs: [[0, 1]],
});
ok(
    JSON.stringify(forwardPairRows) === JSON.stringify(reversePairRows),
    "reversed explicit pairs preserve canonical row labels and ids",
);
ok(
    JSON.stringify(forwardPairRows.map(row => [row.id, row.label])) ===
        JSON.stringify(reorderedPairRows.map(row => [row.id, row.label])),
    "canonical pair display follows inner-to-outer orbital order",
);
const boundedScan = createCloseApproachScan(boundedOptions);
boundedScan.step(coarseWorkBudget);
const firstBoundedWork = boundedScan.lastStepSamples;
let boundedSteps = 1;
let everyStepBounded = firstBoundedWork > 0 && firstBoundedWork <= coarseWorkBudget && !boundedScan.done;
while (!boundedScan.done && boundedSteps < 10000) {
    boundedScan.step(coarseWorkBudget);
    everyStepBounded = everyStepBounded &&
        boundedScan.lastStepSamples > 0 && boundedScan.lastStepSamples <= coarseWorkBudget;
    boundedSteps++;
}
ok(
    everyStepBounded && boundedSteps > 1 &&
        JSON.stringify(boundedScan.result()) === JSON.stringify(closeApproaches(boundedOptions)),
    "resumable pair scan bounds every step and preserves deterministic rows",
);

const eventsSource = readFileSync(new URL("../src/events.js", import.meta.url), "utf8");
const updateEventsSource = eventsSource.slice(eventsSource.indexOf("export function updateEvents"));

const eventsHarness = {
    G: { t: 0, warp: 1, landed: false, dead: false, uiMode: "observe" },
    GS: [],
    BH: { n: 0 },
    epochMs: 1000,
    modeListeners: new Set(),
};
globalThis.__artemisEventsHarness = eventsHarness;
const harnessStubSources = new Map([
    ["./blackholes.js", "export const activeTde = () => null;"],
    ["./constants.js", "export const SEC_YEAR = 31557600;"],
    ["./discoveryLog.js", "export const getRecentDiscoverySnapshot = () => ({ revision: 0, change: 'replace', entries: [] });"],
    ["./epoch.js", "const h = globalThis.__artemisEventsHarness; export const getEpochMs = () => h.epochMs; export const civilDateAt = () => ({}); export const fmtCivil = () => 'DATE';"],
    ["./input.js", "export const setFocus = () => {};"],
    ["./state.js", "const h = globalThis.__artemisEventsHarness; export const G = h.G; export const GS = h.GS; export const BH = h.BH;"],
    ["./timeCtl.js", "export const cancelTimeJump = () => true; export const jumpStatus = () => ({ active: false, label: '', etaWallSec: 0, outcome: '' }); export const maxFeasibleWarp = () => 31557600000000000; export const setWarp = () => {}; export const startTimeJump = () => false;"],
    ["./uiMode.js", "const h = globalThis.__artemisEventsHarness; export const onModeChange = fn => { h.modeListeners.add(fn); return () => h.modeListeners.delete(fn); };"],
    ["./universe/eventTimeline.js", "export const buildTimeline = () => []; export const createCloseApproachScan = options => globalThis.__artemisEventsHarness.createScan(options); export const nextConjunction = options => globalThis.__artemisEventsHarness.findNow(options); export const planJump = () => ({ ok: false }); export const predictedLead = () => ({ leadSec: 2592000, holdWarp: 604800 });"],
    ["./universe/eventController.js", "export const eventSurfaceAllowed = () => true; export const createEventController = options => globalThis.__artemisEventsHarness.createController(options);"],
    ["./universe/epistemic.js", "export const EPISTEMIC_TIERS = { modeled: { id: 'modeled', label: 'MODELED' } }; export const createDiscoveryRecentSync = () => ({ update: () => ({ rows: [] }) }); export const mergeRecentRows = () => []; export const reconcileKeyedRows = (...args) => globalThis.__artemisEventsHarness.reconcile(...args);"],
]);
const eventsHarnessUrl = new URL("../src/events.js?smoke-approach", import.meta.url).href;
const harnessHooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (context.parentURL === eventsHarnessUrl && harnessStubSources.has(specifier)) {
            const source = harnessStubSources.get(specifier);
            return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});
const eventsModule = await import(eventsHarnessUrl);
harnessHooks.deregister();

const timerFirstIdleRequests = [];
const timerFirstTimerRequests = [];
const timerFirstCancelledIdle = [];
const timerFirstDeadlines = [];
const timerFirstHost = {
    requestIdleCallback(callback, options) {
        timerFirstIdleRequests.push({ callback, options });
        return 41;
    },
    cancelIdleCallback(handle) {
        timerFirstCancelledIdle.push(handle);
    },
    setTimeout(callback, delayMs) {
        timerFirstTimerRequests.push({ callback, delayMs });
        return 42;
    },
    clearTimeout() {},
};
if (typeof eventsModule.schedulePredictionWork === "function") {
    eventsModule.schedulePredictionWork(deadline => timerFirstDeadlines.push(deadline), timerFirstHost);
    timerFirstTimerRequests[0]?.callback();
}
ok(
    timerFirstIdleRequests.length === 1 &&
        timerFirstIdleRequests[0].options?.timeout === 100 &&
        timerFirstTimerRequests.length === 1 &&
        timerFirstTimerRequests[0].delayMs > 0 && timerFirstTimerRequests[0].delayMs <= 20 &&
        timerFirstDeadlines.length === 1 && timerFirstDeadlines[0].didTimeout === true &&
        timerFirstDeadlines[0].timeRemaining() === 0 && timerFirstCancelledIdle.join(",") === "41",
    "timer-first prediction work delivers one starvation deadline and cancels idle delivery",
);

const idleFirstIdleRequests = [];
const idleFirstTimerRequests = [];
const idleFirstClearedTimers = [];
const idleFirstDeadlines = [];
const idleFirstHost = {
    requestIdleCallback(callback) {
        idleFirstIdleRequests.push(callback);
        return 51;
    },
    cancelIdleCallback() {},
    setTimeout(callback, delayMs) {
        idleFirstTimerRequests.push({ callback, delayMs });
        return 52;
    },
    clearTimeout(handle) {
        idleFirstClearedTimers.push(handle);
    },
};
const genuineIdleDeadline = { didTimeout: false, timeRemaining: () => 7 };
if (typeof eventsModule.schedulePredictionWork === "function") {
    eventsModule.schedulePredictionWork(deadline => idleFirstDeadlines.push(deadline), idleFirstHost);
    idleFirstIdleRequests[0]?.(genuineIdleDeadline);
}
ok(
    idleFirstIdleRequests.length === 1 && idleFirstTimerRequests.length === 1 &&
        idleFirstDeadlines.length === 1 && idleFirstDeadlines[0] === genuineIdleDeadline &&
        idleFirstClearedTimers.join(",") === "52",
    "idle-first prediction work preserves the genuine deadline and cancels the fallback timer",
);

function createSchedulingRaceHost() {
    const idle = [];
    const timers = [];
    return {
        idle,
        timers,
        requestIdleCallback(callback) {
            idle.push(callback);
            return 61;
        },
        cancelIdleCallback() {},
        setTimeout(callback) {
            timers.push(callback);
            return 62;
        },
        clearTimeout() {},
    };
}
const timerWinnerHost = createSchedulingRaceHost();
const timerWinnerDeliveries = [];
eventsModule.schedulePredictionWork?.(
    deadline => timerWinnerDeliveries.push(deadline),
    timerWinnerHost,
);
timerWinnerHost.timers[0]?.();
timerWinnerHost.idle[0]?.(genuineIdleDeadline);
const idleWinnerHost = createSchedulingRaceHost();
const idleWinnerDeliveries = [];
eventsModule.schedulePredictionWork?.(
    deadline => idleWinnerDeliveries.push(deadline),
    idleWinnerHost,
);
idleWinnerHost.idle[0]?.(genuineIdleDeadline);
idleWinnerHost.timers[0]?.();
ok(
    timerWinnerDeliveries.length === 1 && timerWinnerDeliveries[0].didTimeout === true &&
        idleWinnerDeliveries.length === 1 && idleWinnerDeliveries[0] === genuineIdleDeadline,
    "prediction work invokes one logical callback when either canceled race path still fires",
);

const promptIdleCallbacks = [];
const promptPublications = [];
let promptScanSteps = 0;
const promptScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ fromSec: 0, perturbed: false, epochMs: 1000 }),
    scheduleIdle: callback => promptIdleCallbacks.push(callback),
    createScan: () => ({
        get done() { return promptScanSteps > 0; },
        step() { promptScanSteps++; return true; },
        result: () => [],
    }),
    findNow: () => Object.freeze({ id: "now:prompt", label: "NOW", tier: "modeled", tSimSec: 10 }),
    publish: result => promptPublications.push(result),
});
promptScheduler.update({ outcome: "" });
promptIdleCallbacks.shift()({ didTimeout: false, timeRemaining: () => 20 });
ok(
    promptPublications.length === 1 && promptPublications[0].rows.length === 1 &&
        promptPublications[0].rows[0].id === "now:prompt" && promptScanSteps === 0 &&
        promptIdleCallbacks.length === 1,
    "first idle callback publishes NOW before approach scanning",
);

const batchedIdleCallbacks = [];
let batchedNowMs = 0;
let batchedSteps = 0;
const batchedScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ fromSec: 0, perturbed: false, epochMs: 1000 }),
    scheduleIdle: callback => batchedIdleCallbacks.push(callback),
    createScan: () => ({
        get done() { return batchedSteps >= 10; },
        step() {
            batchedSteps++;
            batchedNowMs += 1.25;
            return this.done;
        },
        result: () => [],
    }),
    findNow: () => Object.freeze({ id: "now:batch", label: "NOW", tier: "modeled", tSimSec: 10 }),
    publish: () => {},
    nowMs: () => batchedNowMs,
    maxCallbackMs: 5,
});
batchedScheduler.update({ outcome: "" });
batchedIdleCallbacks.shift()({ didTimeout: false, timeRemaining: () => 20 });
batchedIdleCallbacks.shift()({ didTimeout: false, timeRemaining: () => 20 });
ok(
    batchedSteps === 4 && batchedIdleCallbacks.length === 1 && batchedNowMs === 5,
    "generous idle callbacks batch fixed work units within an elapsed ceiling",
);

const timeoutBatchCallbacks = [];
const timeoutBatchBudgets = [];
let timeoutBatchNowMs = 0;
let timeoutBatchSteps = 0;
const timeoutBatchScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ fromSec: 0, perturbed: false, epochMs: 1000 }),
    scheduleIdle: callback => timeoutBatchCallbacks.push(callback),
    createScan: () => ({
        get done() { return timeoutBatchSteps >= 10; },
        step(sampleBudget) {
            timeoutBatchBudgets.push(sampleBudget);
            timeoutBatchSteps++;
            timeoutBatchNowMs += 1.25;
            return this.done;
        },
        result: () => [],
    }),
    findNow: () => Object.freeze({ id: "now:timeout-batch", label: "NOW", tier: "modeled", tSimSec: 10 }),
    publish: () => {},
    nowMs: () => timeoutBatchNowMs,
    maxCallbackMs: 5,
});
timeoutBatchScheduler.update({ outcome: "" });
timeoutBatchCallbacks.shift()({ didTimeout: true, timeRemaining: () => 0 });
timeoutBatchCallbacks.shift()({ didTimeout: true, timeRemaining: () => 0 });

const timeoutCapCallbacks = [];
const timeoutCapBudgets = [];
let timeoutCapSteps = 0;
const timeoutCapScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ fromSec: 0, perturbed: false, epochMs: 1000 }),
    scheduleIdle: callback => timeoutCapCallbacks.push(callback),
    createScan: () => ({
        get done() { return timeoutCapSteps >= 200; },
        step(sampleBudget) {
            timeoutCapBudgets.push(sampleBudget);
            timeoutCapSteps++;
            return this.done;
        },
        result: () => [],
    }),
    findNow: () => Object.freeze({ id: "now:timeout-cap", label: "NOW", tier: "modeled", tSimSec: 10 }),
    publish: () => {},
    nowMs: () => 0,
    maxCallbackMs: 5,
});
timeoutCapScheduler.update({ outcome: "" });
timeoutCapCallbacks.shift()({ didTimeout: true, timeRemaining: () => 0 });
timeoutCapCallbacks.shift()({ didTimeout: true, timeRemaining: () => 0 });
ok(
    timeoutBatchSteps === 4 && timeoutBatchNowMs === 5 && timeoutBatchCallbacks.length === 1 &&
        timeoutBatchBudgets.every(budget => budget === 32) &&
        timeoutCapSteps === 128 && timeoutCapCallbacks.length === 1 &&
        timeoutCapBudgets.length === 128 && timeoutCapBudgets.every(budget => budget === 32),
    "timer starvation batching respects the elapsed ceiling and hard unit cap",
);

const deterministicIdleCallbacks = [];
const deterministicPublications = [];
const deterministicStepBudgets = [];
const deterministicCallbackUnits = [];
let deterministicLive = { fromSec: 0, perturbed: false, epochMs: 1000 };
let deterministicNowMs = 0;
let deterministicSteps = 0;
let deterministicScanCount = 0;
let deterministicQueueHighWater = 0;
const deterministicScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ ...deterministicLive }),
    scheduleIdle: callback => {
        deterministicIdleCallbacks.push(callback);
        deterministicQueueHighWater = Math.max(deterministicQueueHighWater, deterministicIdleCallbacks.length);
    },
    createScan: options => {
        deterministicScanCount++;
        return {
            get done() { return deterministicSteps >= 135; },
            step(sampleBudget) {
                deterministicStepBudgets.push(sampleBudget);
                deterministicSteps++;
                if (deterministicSteps > 128) deterministicNowMs += 1.25;
                return this.done;
            },
            result: () => [Object.freeze({
                id: "approach:deterministic",
                label: "DETERMINISTIC APPROACH",
                tier: "modeled",
                tSimSec: options.fromSec + 3 * 86400,
            })],
        };
    },
    findNow: options => Object.freeze({
        id: "now:deterministic:" + Math.floor(options.fromSec / 86400),
        label: "NOW",
        tier: "modeled",
        tSimSec: options.fromSec + 10,
    }),
    publish: result => deterministicPublications.push(result),
    nowMs: () => deterministicNowMs,
    maxCallbackMs: 5,
    spanSec: 200 * SEC_YEAR,
});
deterministicScheduler.update({ outcome: "" });
let deterministicCallbackCount = 0;
while (deterministicIdleCallbacks.length && deterministicCallbackCount < 10) {
    const beforeSteps = deterministicSteps;
    deterministicIdleCallbacks.shift()({ didTimeout: false, timeRemaining: () => 20 });
    deterministicCallbackUnits.push(deterministicSteps - beforeSteps);
    deterministicCallbackCount++;
    if (deterministicCallbackCount === 2) {
        deterministicLive = { ...deterministicLive, fromSec: 2 * 86400 };
    }
}
ok(
    deterministicCallbackUnits.join(",") === "0,128,4,3" && deterministicNowMs === 8.75 &&
        deterministicStepBudgets.length === 135 &&
        deterministicStepBudgets.every(budget => budget === 64) &&
        deterministicPublications.length === 2 &&
        deterministicPublications[0]?.rows[0]?.id === "now:deterministic:0" &&
        deterministicPublications[1]?.rows[0]?.id === "now:deterministic:2" &&
        deterministicPublications[1]?.rows[1]?.id === "approach:deterministic" &&
        deterministicScanCount === 1 && deterministicCallbackCount === 4 &&
        deterministicQueueHighWater === 1 && deterministicIdleCallbacks.length === 0,
    "deterministic scheduling proves unit cap, elapsed budget, prompt NOW, forward rebase, and bounded completion",
);

const realIntegrationIdleCallbacks = [];
const realIntegrationPublications = [];
const realIntegrationGuard = 100000;
let realIntegrationLive = { fromSec: 0, perturbed: false, epochMs: 1000 };
let realIntegrationQueueHighWater = 0;
let realIntegrationScanCount = 0;
let realIntegrationScan = null;
let realIntegrationScanOptions = null;
const realIntegrationScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ ...realIntegrationLive }),
    scheduleIdle: callback => {
        realIntegrationIdleCallbacks.push(callback);
        realIntegrationQueueHighWater = Math.max(
            realIntegrationQueueHighWater,
            realIntegrationIdleCallbacks.length,
        );
    },
    createScan: options => {
        realIntegrationScanCount++;
        realIntegrationScanOptions = options;
        realIntegrationScan = createCloseApproachScan(options);
        return realIntegrationScan;
    },
    findNow: nextConjunction,
    publish: result => realIntegrationPublications.push({
        fromSec: realIntegrationLive.fromSec,
        result,
    }),
    spanSec: 200 * SEC_YEAR,
});
const realIntegrationStartedMs = performance.now();
realIntegrationScheduler.update({ outcome: "" });
let realIntegrationCallbackCount = 0;
const realPromptCallback = realIntegrationIdleCallbacks.shift();
if (realPromptCallback) {
    realPromptCallback({ didTimeout: false, timeRemaining: () => 20 });
    realIntegrationCallbackCount++;
}
const realIntegrationPromptReady = realIntegrationPublications.length === 1 &&
    realIntegrationPublications[0].result.rows[0]?.id.startsWith("now:") &&
    realIntegrationScanCount === 0 && realIntegrationIdleCallbacks.length === 1;
const realFirstScanCallback = realIntegrationIdleCallbacks.shift();
if (realFirstScanCallback) {
    realFirstScanCallback({ didTimeout: false, timeRemaining: () => 20 });
    realIntegrationCallbackCount++;
}
const realIntegrationRebasedActiveScan = realIntegrationScan && !realIntegrationScan.done;
realIntegrationLive = { ...realIntegrationLive, fromSec: 3 * SEC_YEAR };
while (
    realIntegrationIdleCallbacks.length &&
    realIntegrationCallbackCount < realIntegrationGuard
) {
    realIntegrationIdleCallbacks.shift()({ didTimeout: false, timeRemaining: () => 20 });
    realIntegrationCallbackCount++;
}
const realIntegrationWallMs = performance.now() - realIntegrationStartedMs;
const realIntegrationFinal = realIntegrationPublications.at(-1);
const realIntegrationExpectedNow = nextConjunction({ fromSec: realIntegrationLive.fromSec });
const realIntegrationExpectedApproaches = (realIntegrationScan?.result() || [])
    .filter(row => row.tSimSec > realIntegrationLive.fromSec)
    .slice(0, 5);
console.log(
    "INFO real 200-year scheduler callbacks=" + realIntegrationCallbackCount +
    " wallMs=" + realIntegrationWallMs.toFixed(3) +
    " finalApproaches=" + realIntegrationExpectedApproaches.length,
);
ok(
    realIntegrationPromptReady && realIntegrationRebasedActiveScan &&
        realIntegrationIdleCallbacks.length === 0 &&
        realIntegrationCallbackCount < realIntegrationGuard &&
        realIntegrationQueueHighWater === 1 && realIntegrationScanCount === 1 &&
        realIntegrationScanOptions?.fromSec === 0 &&
        realIntegrationScanOptions?.spanSec === 200 * SEC_YEAR &&
        realIntegrationPublications.length === 2 &&
        realIntegrationFinal?.fromSec === realIntegrationLive.fromSec &&
        realIntegrationFinal?.result.rows[0]?.id === realIntegrationExpectedNow?.id &&
        realIntegrationFinal?.result.rows[0]?.tSimSec === realIntegrationExpectedNow?.tSimSec &&
        JSON.stringify(realIntegrationFinal?.result.rows.slice(1).map(row => row.id)) ===
            JSON.stringify(realIntegrationExpectedApproaches.map(row => row.id)) &&
        realIntegrationExpectedApproaches.length === 5 &&
        realIntegrationExpectedApproaches.every(row =>
            row.tSimSec > realIntegrationLive.fromSec && Number.isFinite(row.distKm) && row.distKm > 0 &&
            row.tier === "modeled" && row.pair?.[0]?.a <= row.pair?.[1]?.a &&
            /\(two-body estimate\)$/.test(row.label)
        ),
    "real scheduler integration publishes prompt NOW, rebases forward, and completes with physical rows",
);

const stepFailureIdle = [];
const stepFailurePublications = [];
const stepFailureEscapes = [];
let stepFailureScans = 0;
const stepFailureScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ fromSec: 0, perturbed: false, epochMs: 1000 }),
    scheduleIdle: callback => stepFailureIdle.push(callback),
    createScan: () => {
        const serial = ++stepFailureScans;
        let done = false;
        return {
            get done() { return done; },
            step() {
                if (serial === 1) throw new Error("transient step failure");
                done = true;
                return true;
            },
            result: () => [Object.freeze({
                id: "approach:recovered-step",
                label: "RECOVERED STEP",
                tier: "modeled",
                tSimSec: 20,
            })],
        };
    },
    findNow: () => Object.freeze({ id: "now:step", label: "NOW", tier: "modeled", tSimSec: 10 }),
    publish: result => stepFailurePublications.push(result),
});
stepFailureScheduler.update({ outcome: "" });
while (stepFailureIdle.length && stepFailureEscapes.length === 0) {
    try {
        stepFailureIdle.shift()({ didTimeout: false, timeRemaining: () => 20 });
    } catch (error) {
        stepFailureEscapes.push(error);
    }
}
ok(
    stepFailureEscapes.length === 0 && stepFailureScans === 2 && stepFailureIdle.length === 0 &&
        stepFailurePublications.at(-1)?.rows.some(row => row.id === "approach:recovered-step"),
    "transient scan-step failure retries once and publishes recovered approaches",
);

const resultFailureIdle = [];
const resultFailurePublications = [];
const resultFailureEscapes = [];
let resultFailureScans = 0;
let resultFailureClockMs = 0;
let resultFailureEnabled = true;
const resultFailureScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ fromSec: 0, perturbed: false, epochMs: 1000 }),
    scheduleIdle: callback => resultFailureIdle.push(callback),
    createScan: () => {
        resultFailureScans++;
        let done = false;
        return {
            get done() { return done; },
            step() { done = true; return true; },
            result() {
                if (resultFailureEnabled) throw new Error("deterministic result failure");
                return [Object.freeze({
                    id: "approach:recovered-result",
                    label: "RECOVERED RESULT",
                    tier: "modeled",
                    tSimSec: 20,
                })];
            },
        };
    },
    findNow: () => Object.freeze({ id: "now:result", label: "NOW", tier: "modeled", tSimSec: 10 }),
    publish: result => resultFailurePublications.push(result),
    nowMs: () => resultFailureClockMs,
});
resultFailureScheduler.update({ outcome: "" });
while (resultFailureIdle.length && resultFailureEscapes.length === 0) {
    try {
        resultFailureIdle.shift()({ didTimeout: false, timeRemaining: () => 20 });
    } catch (error) {
        resultFailureEscapes.push(error);
    }
}
const settledResultFailure = resultFailureEscapes.length === 0 && resultFailureScans === 2 &&
    resultFailureIdle.length === 0 && resultFailurePublications.at(-1)?.diagnostic?.stage === "result";
for (let i = 0; i < 5; i++) resultFailureScheduler.update({ outcome: "" });
const quietBeforeRecovery = resultFailureIdle.length === 0;
resultFailureEnabled = false;
resultFailureClockMs = 1000;
resultFailureScheduler.update({ outcome: "" });
drainIdleQueue(resultFailureIdle);
ok(
    settledResultFailure && quietBeforeRecovery && resultFailureScans === 3 &&
        resultFailurePublications.at(-1)?.rows.some(row => row.id === "approach:recovered-result") &&
        resultFailureIdle.length === 0,
    "repeated result failure settles diagnostically and a later update recovers",
);

const persistentPublishIdle = [];
const persistentPublishResults = [];
const persistentPublishDiagnostics = [];
let persistentPublishAttempts = 0;
let persistentPublishScans = 0;
let persistentPublishClockMs = 0;
let persistentPublishFailing = true;
const persistentPublishScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ fromSec: 0, perturbed: false, epochMs: 1000 }),
    scheduleIdle: callback => persistentPublishIdle.push(callback),
    createScan: () => {
        persistentPublishScans++;
        let done = false;
        return {
            get done() { return done; },
            step() { done = true; return true; },
            result: () => [Object.freeze({
                id: "approach:recovered-publish",
                label: "RECOVERED PUBLISH",
                tier: "modeled",
                tSimSec: 20,
            })],
        };
    },
    findNow: () => Object.freeze({ id: "now:publish", label: "NOW", tier: "modeled", tSimSec: 10 }),
    publish: result => {
        persistentPublishAttempts++;
        if (persistentPublishFailing) throw new Error("persistent publish failure");
        persistentPublishResults.push(result);
    },
    publishDiagnostic: result => persistentPublishDiagnostics.push(result),
    nowMs: () => persistentPublishClockMs,
});
persistentPublishScheduler.update({ outcome: "" });
drainIdleQueue(persistentPublishIdle);
const persistentPublishSettled = persistentPublishAttempts === 2 &&
    persistentPublishDiagnostics.length === 1 &&
    persistentPublishDiagnostics[0]?.diagnostic?.stage === "publish" &&
    persistentPublishDiagnostics[0]?.rows[0]?.diagnostic === true &&
    persistentPublishIdle.length === 0;
persistentPublishClockMs = 999;
for (let i = 0; i < 5; i++) persistentPublishScheduler.update({ outcome: "" });
const persistentPublishCooldownHeld = persistentPublishIdle.length === 0 && persistentPublishScans === 0;
persistentPublishFailing = false;
persistentPublishClockMs = 1000;
persistentPublishScheduler.update({ outcome: "" });
drainIdleQueue(persistentPublishIdle);
ok(
    persistentPublishSettled && persistentPublishCooldownHeld &&
        persistentPublishDiagnostics.length === 1 && persistentPublishAttempts === 4 &&
        persistentPublishScans === 1 && persistentPublishResults.length === 2 &&
        persistentPublishResults.at(-1)?.rows.some(row => row.id === "approach:recovered-publish") &&
        persistentPublishIdle.length === 0,
    "persistent primary publication failure emits one fallback diagnostic and recovers after cooldown",
);

const publishFailureIdle = [];
const publishFailureResults = [];
const publishFailureEscapes = [];
let publishFailureAttempts = 0;
let publishFailureScans = 0;
const publishFailureScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ fromSec: 0, perturbed: true, epochMs: 1000 }),
    scheduleIdle: callback => publishFailureIdle.push(callback),
    createScan: () => { publishFailureScans++; return null; },
    findNow: () => null,
    publish: result => {
        publishFailureAttempts++;
        if (publishFailureAttempts === 1) throw new Error("transient publish failure");
        publishFailureResults.push(result);
    },
});
try {
    publishFailureScheduler.update({ outcome: "" });
} catch (error) {
    publishFailureEscapes.push(error);
}
drainIdleQueue(publishFailureIdle);
ok(
    publishFailureEscapes.length === 0 && publishFailureAttempts === 2 &&
        publishFailureResults.length === 1 && publishFailureResults[0].suppressed === true &&
        publishFailureScans === 0 && publishFailureIdle.length === 0,
    "suppression publish failure retries once while conic work stays gated",
);

const idleCallbacks = [];
const boundedIdleBudgets = [];
const boundedPublications = [];
let boundedIdleSteps = 0;
const boundedScheduler = eventsModule.createPredictionScheduler?.({
    readState: () => ({ fromSec: 0, perturbed: false, epochMs: 1000 }),
    scheduleIdle: callback => idleCallbacks.push(callback),
    createScan: () => ({
        get done() { return boundedIdleSteps >= 3; },
        step(sampleBudget) {
            boundedIdleBudgets.push(sampleBudget);
            boundedIdleSteps++;
            return this.done;
        },
        result: () => [],
    }),
    findNow: () => Object.freeze({ id: "now:test", label: "NOW", tier: "modeled", tSimSec: 10 }),
    publish: result => boundedPublications.push(result),
});
boundedScheduler?.update({ outcome: "" });
let boundedIdleCallbacks = 0;
while (idleCallbacks.length && boundedIdleCallbacks < 20) {
    idleCallbacks.shift()({ didTimeout: true, timeRemaining: () => 0 });
    boundedIdleCallbacks++;
}
ok(
    boundedPublications.length === 2 && boundedPublications[0].rows.length === 1 &&
        boundedIdleBudgets.length === 3 &&
        boundedIdleBudgets.every(budget => Number.isInteger(budget) && budget > 0 && budget <= 64) &&
        boundedIdleCallbacks === 2,
    "timer-style idle deadlines publish through bounded resumable scan batches",
);

const staleIdleCallbacks = [];
const stalePublications = [];
const staleScanBuckets = [];
let staleLive = { fromSec: 0, perturbed: false, epochMs: 1000 };
let staleQueueHighWater = 0;
const staleScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ ...staleLive }),
    scheduleIdle: callback => {
        staleIdleCallbacks.push(callback);
        staleQueueHighWater = Math.max(staleQueueHighWater, staleIdleCallbacks.length);
    },
    createScan: options => {
        const bucket = Math.floor(options.fromSec / 86400);
        staleScanBuckets.push(bucket);
        let done = false;
        return {
            get done() { return done; },
            step() {
                done = true;
                if (bucket === 2) staleLive = { ...staleLive, fromSec: 3 * 86400 };
                return true;
            },
            result: () => [Object.freeze({
                id: "approach:" + bucket,
                label: "APPROACH " + bucket,
                tier: "modeled",
                tSimSec: options.fromSec + 20,
            })],
        };
    },
    findNow: options => Object.freeze({
        id: "now:" + Math.floor(options.fromSec / 86400),
        label: "NOW",
        tier: "modeled",
        tSimSec: options.fromSec + 10,
    }),
    publish: result => stalePublications.push(result),
});
staleScheduler.update({ outcome: "" });
staleLive = { ...staleLive, fromSec: 2 * 86400 };
let staleCallbackCount = 0;
while (staleIdleCallbacks.length && staleCallbackCount < 20) {
    staleIdleCallbacks.shift()({ didTimeout: false, timeRemaining: () => 4 });
    staleCallbackCount++;
}
ok(
    stalePublications.length === 2 && stalePublications.at(-1).rows[0].id === "now:3" &&
        staleScanBuckets.join(",") === "2" && staleQueueHighWater === 1 &&
        staleIdleCallbacks.length === 0,
    "forward bucket drift rebases the active scan and final publication",
);

const horizonIdleCallbacks = [];
const horizonPublications = [];
let horizonLive = { fromSec: 0, perturbed: false, epochMs: 1000 };
let horizonScans = 0;
const horizonScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ ...horizonLive }),
    scheduleIdle: callback => horizonIdleCallbacks.push(callback),
    createScan: options => {
        const serial = ++horizonScans;
        let done = false;
        return {
            get done() { return done; },
            step() {
                done = true;
                if (serial === 1) horizonLive = { ...horizonLive, fromSec: options.fromSec + 101 };
                return true;
            },
            result: () => [],
        };
    },
    findNow: options => Object.freeze({
        id: "now:horizon:" + options.fromSec,
        label: "NOW",
        tier: "modeled",
        tSimSec: options.fromSec + 10,
    }),
    publish: result => horizonPublications.push(result),
    spanSec: 100,
});
horizonScheduler.update({ outcome: "" });
drainIdleQueue(horizonIdleCallbacks);
ok(
    horizonScans === 2 && horizonIdleCallbacks.length === 0 &&
        horizonPublications.at(-1)?.rows[0]?.id === "now:horizon:101",
    "forward drift beyond scan coverage restarts from the live horizon",
);

function drainIdleQueue(queue, limit = 30) {
    let count = 0;
    while (queue.length && count < limit) {
        queue.shift()({ didTimeout: false, timeRemaining: () => 4 });
        count++;
    }
    return count;
}

const lifecycleIdleCallbacks = [];
const lifecyclePublications = [];
let lifecycleLive = { fromSec: 1000, perturbed: false, epochMs: 1000 };
let lifecycleScanSerial = 0;
const lifecycleScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ ...lifecycleLive }),
    scheduleIdle: callback => lifecycleIdleCallbacks.push(callback),
    createScan: options => {
        const serial = ++lifecycleScanSerial;
        let done = false;
        return {
            get done() { return done; },
            step() { done = true; return true; },
            result: () => [Object.freeze({
                id: "approach:" + serial,
                label: "APPROACH " + serial,
                tier: "modeled",
                tSimSec: options.fromSec + 20,
            })],
        };
    },
    findNow: options => Object.freeze({
        id: "now:" + options.fromSec + ":" + lifecycleLive.epochMs,
        label: "NOW",
        tier: "modeled",
        tSimSec: options.fromSec + 10,
    }),
    publish: result => lifecyclePublications.push(result),
});
lifecycleScheduler.update({ outcome: "" });
drainIdleQueue(lifecycleIdleCallbacks);
lifecycleLive = { ...lifecycleLive, fromSec: 500 };
lifecycleScheduler.update({ outcome: "" });
drainIdleQueue(lifecycleIdleCallbacks);
lifecycleLive = { ...lifecycleLive, epochMs: 2000 };
lifecycleScheduler.update({ outcome: "" });
drainIdleQueue(lifecycleIdleCallbacks);

const pendingEpochIdle = [];
const pendingEpochPublications = [];
let pendingEpochLive = { fromSec: 2000, perturbed: false, epochMs: 3000 };
let pendingEpochScans = 0;
const pendingEpochScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ ...pendingEpochLive }),
    scheduleIdle: callback => pendingEpochIdle.push(callback),
    createScan: () => {
        pendingEpochScans++;
        let done = false;
        return {
            get done() { return done; },
            step() { done = true; return true; },
            result: () => [],
        };
    },
    findNow: () => Object.freeze({ id: "now:epoch", label: "NOW", tier: "modeled", tSimSec: 2010 }),
    publish: result => pendingEpochPublications.push(result),
});
pendingEpochScheduler.update({ outcome: "" });
pendingEpochLive = { ...pendingEpochLive, epochMs: 4000 };
const pendingEpochCallbacks = drainIdleQueue(pendingEpochIdle);
ok(
    lifecyclePublications.map(result => result.rows[0].id).join(",") ===
        "now:1000:1000,now:1000:1000,now:500:1000,now:500:1000," +
        "now:500:2000,now:500:2000" && lifecycleScanSerial === 3 &&
        pendingEpochCallbacks === 3 && pendingEpochScans === 1 && pendingEpochPublications.length === 2,
    "clock rewind and epoch changes invalidate cache and pending prediction work",
);

class HarnessClassList {
    constructor() { this.values = new Set(); }
    contains(name) { return this.values.has(name); }
    toggle(name, force) {
        const enabled = force === undefined ? !this.values.has(name) : !!force;
        if (enabled) this.values.add(name);
        else this.values.delete(name);
        return enabled;
    }
}

class HarnessNode {
    constructor(tagName = "div", id = "") {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.children = [];
        this.parentNode = null;
        this.hidden = false;
        this.className = "";
        this.classList = new HarnessClassList();
        this.dataset = {};
        this.textContent = "";
        this.attributes = new Map();
        this.listeners = new Map();
    }
    get parentElement() { return this.parentNode; }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() {
        if (!this.parentNode) return null;
        const index = this.parentNode.children.indexOf(this);
        return this.parentNode.children[index + 1] || null;
    }
    append(...nodes) {
        for (const node of nodes) this.appendChild(node);
    }
    appendChild(node) {
        if (node.parentNode) node.remove();
        this.children.push(node);
        node.parentNode = this;
        return node;
    }
    insertBefore(node, before) {
        if (node.parentNode) node.remove();
        const index = before ? this.children.indexOf(before) : this.children.length;
        this.children.splice(index < 0 ? this.children.length : index, 0, node);
        node.parentNode = this;
        return node;
    }
    remove() {
        if (!this.parentNode) return;
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) this.parentNode.children.splice(index, 1);
        this.parentNode = null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(type, listener, options = {}) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
        options.signal?.addEventListener("abort", () => {
            const current = this.listeners.get(type) || [];
            this.listeners.set(type, current.filter(candidate => candidate !== listener));
        }, { once: true });
    }
    dispatch(type, event = {}) {
        for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    }
    querySelector(selector) {
        if (selector.startsWith("#")) return findHarnessNode(this, selector.slice(1));
        return null;
    }
    focus() {}
    getClientRects() { return []; }
}

function findHarnessNode(root, id) {
    if (root.id === id) return root;
    for (const child of root.children) {
        const found = findHarnessNode(child, id);
        if (found) return found;
    }
    return null;
}

function countHarnessId(root, id) {
    let count = root.id === id ? 1 : 0;
    for (const child of root.children) count += countHarnessId(child, id);
    return count;
}

function createEventsDocument() {
    const roots = new HarnessNode("root");
    const body = new HarnessNode("body", "body");
    roots.appendChild(body);
    const panel = new HarnessNode("aside", "evPanel");
    const liveSection = new HarnessNode("section");
    const live = new HarnessNode("div", "evLive");
    liveSection.append(live, new HarnessNode("div", "evLiveEmpty"));
    const timelineSection = new HarnessNode("section");
    timelineSection.appendChild(new HarnessNode("div", "evTimeline"));
    const recentSection = new HarnessNode("section");
    recentSection.append(new HarnessNode("div", "evRecent"), new HarnessNode("div", "evRecentEmpty"));
    panel.append(liveSection, timelineSection, recentSection);
    roots.appendChild(panel);
    for (const id of [
        "evBtn",
        "evClose",
        "tdJump",
        "tdJumpLabel",
        "evJumpChip",
        "evJumpChipLabel",
        "evJumpChipEta",
        "evJumpCancel",
    ]) roots.appendChild(new HarnessNode("button", id));
    const documentListeners = new Map();
    return {
        roots,
        body,
        createElement: tagName => new HarnessNode(tagName),
        getElementById: id => findHarnessNode(roots, id),
        addEventListener(type, listener, options = {}) {
            const listeners = documentListeners.get(type) || [];
            listeners.push(listener);
            documentListeners.set(type, listeners);
            options.signal?.addEventListener("abort", () => {
                const current = documentListeners.get(type) || [];
                documentListeners.set(type, current.filter(candidate => candidate !== listener));
            }, { once: true });
        },
        dispatch(type, event = {}) {
            for (const listener of [...(documentListeners.get(type) || [])]) listener(event);
        },
    };
}

const adapterIdleCallbacks = [];
const adapterControllers = [];
let adapterScanCount = 0;
globalThis.requestIdleCallback = callback => {
    adapterIdleCallbacks.push(callback);
    return adapterIdleCallbacks.length;
};
eventsHarness.reconcile = reconcileKeyedRows;
eventsHarness.createController = () => {
    const instance = {
        toggles: 0,
        toggleOpen() { this.toggles++; },
        setOpen() {},
        requestCancel() {},
        handleEscape() {},
        closeForAction() {},
        beginJump() {},
        syncDiscovery() { return 0; },
        noteActivity() {},
        setLive() {},
        isOpen() { return false; },
        renderJump() {},
    };
    adapterControllers.push(instance);
    return instance;
};
eventsHarness.createScan = options => {
    adapterScanCount++;
    let done = false;
    return {
        get done() { return done; },
        step() { done = true; return true; },
        result: () => [Object.freeze({
            id: "approach:adapter:" + Math.floor(options.fromSec / 86400),
            label: "ADAPTER APPROACH",
            tier: "modeled",
            tSimSec: options.fromSec + 20,
        })],
    };
};
eventsHarness.findNow = options => Object.freeze({
    id: "now:adapter:" + Math.floor(options.fromSec / 86400),
    label: "NOW",
    tier: "modeled",
    tSimSec: options.fromSec + 10,
});

eventsHarness.BH.n = 1;
const firstEventsDocument = createEventsDocument();
globalThis.document = firstEventsDocument;
eventsModule.initEvents();
eventsModule.initEvents();
const firstEventsButton = firstEventsDocument.getElementById("evBtn");
firstEventsButton.dispatch("click");
const samePanelControllerCount = adapterControllers.length;
const samePanelToggleCount = adapterControllers.reduce((sum, instance) => sum + instance.toggles, 0);
const samePanelPredictedIds = countHarnessId(firstEventsDocument.roots, "evPredicted");
const samePanelHeadingIds = countHarnessId(firstEventsDocument.roots, "evPredictedHead");
const samePanelPredictedSection = firstEventsDocument.getElementById("evPredicted")?.parentElement;
const firstPredictedAction = firstEventsDocument.getElementById("evPredicted")
    ?.firstChild?.children?.[2];

eventsHarness.BH.n = 0;
eventsModule.updateEvents();
eventsHarness.G.t = 2 * 86400;
const reboundEventsDocument = createEventsDocument();
globalThis.document = reboundEventsDocument;
eventsModule.initEvents();
const togglesBeforeOldDispatch = adapterControllers.reduce((sum, instance) => sum + instance.toggles, 0);
firstEventsButton.dispatch("click");
const togglesAfterOldDispatch = adapterControllers.reduce((sum, instance) => sum + instance.toggles, 0);
drainIdleQueue(adapterIdleCallbacks);
ok(
    samePanelControllerCount === 1 && samePanelToggleCount === 1 && samePanelPredictedIds === 1 &&
        samePanelHeadingIds === 1 &&
        samePanelPredictedSection?.getAttribute("aria-labelledby") === "evPredictedHead" &&
        adapterControllers.length === 2 && eventsHarness.modeListeners.size === 1 &&
        firstPredictedAction?.listeners.get("click")?.length === 0 &&
        togglesAfterOldDispatch === togglesBeforeOldDispatch && adapterScanCount === 1 &&
        countHarnessId(reboundEventsDocument.roots, "evPredicted") === 1,
    "repeated initialization is idempotent and genuine rebind disposes listeners and pending work",
);

eventsHarness.createScan = () => { throw new Error("adapter scan failure"); };
eventsHarness.G.t += 21;
eventsModule.updateEvents();
drainIdleQueue(adapterIdleCallbacks);
const adapterDiagnosticRow = reboundEventsDocument.getElementById("evPredicted")?.firstChild;
const adapterDiagnosticAction = adapterDiagnosticRow?.children?.[2];
ok(
    adapterDiagnosticRow?.dataset.eventId === "predictions-error" &&
        adapterDiagnosticAction?.hidden === true && adapterIdleCallbacks.length === 0,
    "adapter renders repeated prediction failure as one inert diagnostic row",
);

const persistentAdapterDocument = createEventsDocument();
let persistentAdapterPrimaryAttempts = 0;
eventsHarness.reconcile = (...args) => {
    if (args[0]?.id === "evPredicted") {
        persistentAdapterPrimaryAttempts++;
        throw new Error("persistent primary adapter failure");
    }
    return reconcileKeyedRows(...args);
};
eventsHarness.epochMs += 1000;
globalThis.document = persistentAdapterDocument;
eventsModule.initEvents();
drainIdleQueue(adapterIdleCallbacks);
const persistentAdapterDiagnosticRow = persistentAdapterDocument.getElementById("evPredicted")?.firstChild;
const persistentAdapterDiagnosticAction = persistentAdapterDiagnosticRow?.children?.[2];
ok(
    persistentAdapterPrimaryAttempts === 2 &&
        persistentAdapterDiagnosticRow?.dataset.eventId === "predictions-error" &&
        persistentAdapterDiagnosticRow?.getAttribute("role") === "status" &&
        persistentAdapterDiagnosticRow?.getAttribute("aria-live") === "polite" &&
        persistentAdapterDiagnosticAction?.hidden === true && adapterIdleCallbacks.length === 0,
    "production fallback renders one accessible inert diagnostic after persistent primary failure",
);
eventsHarness.reconcile = reconcileKeyedRows;

const policyIdleCallbacks = [];
const policyPublications = [];
let policyLive = { fromSec: 0, perturbed: false, epochMs: 5000 };
let policyScanCount = 0;
const policyScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ ...policyLive }),
    scheduleIdle: callback => policyIdleCallbacks.push(callback),
    createScan: options => {
        const serial = ++policyScanCount;
        let done = false;
        return {
            get done() { return done; },
            step() { done = true; return true; },
            result: () => [Object.freeze({
                id: "approach:policy:" + serial,
                label: "POLICY APPROACH",
                tier: "modeled",
                tSimSec: options.fromSec + 20,
            })],
        };
    },
    findNow: options => Object.freeze({
        id: "now:policy:" + policyScanCount,
        label: "NOW",
        tier: "modeled",
        tSimSec: options.fromSec + 10,
    }),
    publish: result => policyPublications.push(result),
});
policyScheduler.update({ outcome: "" });
drainIdleQueue(policyIdleCallbacks);
policyLive = { ...policyLive, perturbed: true };
policyScheduler.update({ outcome: "" });
policyLive = { ...policyLive, perturbed: false };
policyScheduler.update({ outcome: "" });
drainIdleQueue(policyIdleCallbacks);
policyScheduler.update({ outcome: "arrive" });
drainIdleQueue(policyIdleCallbacks);
policyScheduler.update({ outcome: "arrive" });
policyLive = { ...policyLive, fromSec: 11 };
policyScheduler.update({ outcome: "" });
drainIdleQueue(policyIdleCallbacks);
policyScheduler.update({ outcome: "" });
ok(
    policyPublications.length === 9 && policyPublications[2].suppressed === true &&
        policyPublications.filter(result => result.suppressed).length === 1 && policyScanCount === 4 &&
        policyIdleCallbacks.length === 0 && !/export function predictionRecomputeCause/.test(eventsSource),
    "runtime scheduler harness covers init, BH transition, arrival, expiry, and stable publication",
);

const earlyApproachIdle = [];
const earlyApproachPublications = [];
let earlyApproachLive = { fromSec: 0, perturbed: false, epochMs: 1000 };
let earlyApproachScans = 0;
const earlyApproachScheduler = eventsModule.createPredictionScheduler({
    readState: () => ({ ...earlyApproachLive }),
    scheduleIdle: callback => earlyApproachIdle.push(callback),
    createScan: () => {
        const serial = ++earlyApproachScans;
        let done = false;
        return {
            get done() { return done; },
            step() { done = true; return true; },
            result: () => [Object.freeze({
                id: "approach:early:" + serial,
                label: "EARLY APPROACH",
                tier: "modeled",
                tSimSec: 20,
            })],
        };
    },
    findNow: () => Object.freeze({ id: "now:later", label: "NOW", tier: "modeled", tSimSec: 100 }),
    publish: result => earlyApproachPublications.push(result),
});
earlyApproachScheduler.update({ outcome: "" });
drainIdleQueue(earlyApproachIdle);
earlyApproachLive = { ...earlyApproachLive, fromSec: 21 };
earlyApproachScheduler.update({ outcome: "" });
drainIdleQueue(earlyApproachIdle);
ok(
    earlyApproachScans === 2 && earlyApproachPublications.length === 4 &&
        earlyApproachPublications[1].rows[0].id === "now:later" &&
        earlyApproachPublications[1].rows[1].id === "approach:early:1",
    "expiry follows the earliest future approach while NOW remains pinned first",
);
ok(
    !/\b(?:closeApproaches|nextConjunction)\s*\(/.test(updateEventsSource),
    "updateEvents avoids synchronous conic execution",
);
ok(
    /requestIdleCallback/.test(eventsSource) && /setTimeout/.test(eventsSource) &&
        /\.step\(sliceBudget\(deadline\)\)/.test(eventsSource),
    "prediction work uses idle scheduling, a timer fallback, and pair slices",
);
ok(
    /Math\.floor\(fromSec\s*\/\s*86400\)/.test(eventsSource) &&
        /predictionCache/.test(eventsSource),
    "prediction cache keys include the simulation day bucket",
);
ok(
    /document\.createElement\("section"\)/.test(eventsSource) &&
        /PREDICTED/.test(eventsSource) && /insertBefore/.test(eventsSource),
    "PREDICTED section is created dynamically inside the events panel",
);
ok(
    eventsSource.includes("PREDICTIONS OFF — a placed compact object perturbs every orbit; two-body extrapolation would lie."),
    "perturbation gate carries the exact explanation row",
);
ok(
    /predictedLead\(view\.row\)/.test(eventsSource) &&
        /planJump\(G\.t,\s*view\.row\.tSimSec,\s*feasibility,\s*lead\)/.test(eventsSource),
    "predicted jump actions pass measured overrides into planJump",
);

class FakeNode {
    constructor(id) {
        this.id = id;
        this.parentNode = null;
        this.selection = "preserved";
    }
    get nextSibling() {
        if (!this.parentNode) return null;
        const index = this.parentNode.children.indexOf(this);
        return this.parentNode.children[index + 1] || null;
    }
    remove() {
        if (!this.parentNode) return;
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) this.parentNode.children.splice(index, 1);
        this.parentNode = null;
    }
}
class FakeParent {
    constructor() { this.children = []; }
    get firstChild() { return this.children[0] || null; }
    insertBefore(node, before) {
        if (node.parentNode) node.remove();
        const index = before ? this.children.indexOf(before) : this.children.length;
        this.children.splice(index < 0 ? this.children.length : index, 0, node);
        node.parentNode = this;
    }
}
const predictedParent = new FakeParent();
const predictedViews = new Map();
const createPredictedView = row => ({ node: new FakeNode(row.id), label: "" });
const updatePredictedView = (view, row) => { view.label = row.label; };
const firstPredictedRows = [nowFirst, ...realFirst.slice(0, 2)];
reconcileKeyedRows(
    predictedParent,
    firstPredictedRows,
    predictedViews,
    createPredictedView,
    updatePredictedView,
);
const retainedNowNode = predictedViews.get(nowFirst.id).node;
const stableReconcile = reconcileKeyedRows(
    predictedParent,
    firstPredictedRows.map(row => ({ ...row })),
    predictedViews,
    createPredictedView,
    updatePredictedView,
);
ok(
    stableReconcile.created === 0 && stableReconcile.moved === 0 && stableReconcile.removed === 0 &&
        predictedViews.get(nowFirst.id).node === retainedNowNode && retainedNowNode.selection === "preserved" &&
        /reconcileKeyedRows\(els\.predicted/.test(eventsSource),
    "predicted keyed rerender preserves retained nodes and selection state",
);

process.exit(fails ? 1 : 0);
