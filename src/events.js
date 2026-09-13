import { activeTde } from "./blackholes.js";
import { SEC_YEAR } from "./constants.js";
import { getRecentDiscoverySnapshot } from "./discoveryLog.js";
import { civilDateAt, fmtCivil, getEpochMs } from "./epoch.js";
import { setFocus } from "./input.js";
import { G, GS, BH } from "./state.js";
import { cancelTimeJump, jumpStatus, maxFeasibleWarp, setWarp, startTimeJump } from "./timeCtl.js";
import { onModeChange } from "./uiMode.js";
import {
    buildTimeline,
    createCloseApproachScan,
    nextConjunction,
    planJump,
    predictedLead,
} from "./universe/eventTimeline.js";
import { createEventController, eventSurfaceAllowed } from "./universe/eventController.js";
import {
    createDiscoveryRecentSync,
    EPISTEMIC_TIERS,
    mergeRecentRows,
    reconcileKeyedRows,
} from "./universe/epistemic.js";

const RECENT_LIMIT = 12;
const PREDICTION_LIMIT = 5;
const PREDICTION_SPAN_SEC = 200 * SEC_YEAR;
const PREDICTION_WORK_SAMPLES = 64;
const PREDICTION_TIMEOUT_SAMPLES = 32;
const PREDICTION_IDLE_MS = 2;
const PREDICTION_MAX_UNITS_PER_CALLBACK = 128;
const PREDICTION_FALLBACK_MS = 8;
const PREDICTION_RECOVERY_DELAY_MS = 1000;
const PREDICTION_OFF_LABEL = "PREDICTIONS OFF — a placed compact object perturbs every orbit; two-body extrapolation would lie.";
export const JUMP_END_LATCH_MS = 1500;
const discoverySync = createDiscoveryRecentSync(RECENT_LIMIT);
const recentEvents = [];
const recentNodes = new Map();
const predictedNodes = new Map();
const timelineViews = [];
let discoveryRows = [];
let eventSerial = 0;
let recentDirty = true;
let els = null;
let controller = null;
let predictionScheduler = null;
let boundPanel = null;
let boundDocument = null;
let eventBindingAbort = null;
let modeUnsubscribe = null;

function predictionRecomputeCause(
    initialized,
    arrived,
    simTimeSec,
    firstRowSec,
    previousPerturbed,
    perturbed,
) {
    if (!initialized) return "init";
    if (arrived) return "arrival";
    if (previousPerturbed !== perturbed) return "perturbation";
    if (Number.isFinite(firstRowSec) && simTimeSec >= firstRowSec) return "expiry";
    return "";
}

function predictionCacheKey(fromSec, perturbed) {
    return Math.floor(fromSec / 86400) + ":" + (perturbed ? "1" : "0");
}

export function schedulePredictionWork(callback, host = globalThis) {
    let settled = false;
    let idleHandle = null;
    let timerHandle = null;
    const deliver = (deadline, idleWon) => {
        if (settled) return;
        settled = true;
        if (idleWon) {
            if (timerHandle !== null) host.clearTimeout(timerHandle);
        } else if (idleHandle !== null && typeof host.cancelIdleCallback === "function") {
            host.cancelIdleCallback(idleHandle);
        }
        callback(deadline);
    };
    if (typeof host.requestIdleCallback === "function") {
        idleHandle = host.requestIdleCallback(deadline => deliver(deadline, true), { timeout: 100 });
    }
    if (!settled) {
        timerHandle = host.setTimeout(
            () => deliver({ didTimeout: true, timeRemaining: () => 0 }, false),
            PREDICTION_FALLBACK_MS,
        );
    }
    return timerHandle;
}

export function createPredictionScheduler({
    readState,
    scheduleIdle: queueIdle,
    createScan,
    findNow,
    publish,
    publishDiagnostic = publish,
    spanSec = PREDICTION_SPAN_SEC,
    rowLimit = PREDICTION_LIMIT,
    maxSamplesPerSlice = PREDICTION_WORK_SAMPLES,
    maxCallbackMs = PREDICTION_IDLE_MS,
    nowMs = () => performance.now(),
} = {}) {
    const predictionCache = new Map();
    let initialized = false;
    let previousPerturbed = false;
    let firstRowSec = Infinity;
    let arrivalHandled = false;
    let generation = 0;
    let previousFromSec = NaN;
    let previousEpochMs = NaN;
    let predictionPending = false;
    let recoveryFailure = null;
    let disposed = false;

    function runStage(stage, operation) {
        try {
            return operation();
        } catch (cause) {
            const detail = cause instanceof Error ? cause.message : String(cause);
            const failure = new Error("prediction " + stage + " failed: " + detail);
            failure.predictionStage = stage;
            failure.cause = cause;
            throw failure;
        }
    }

    function remember(key, result) {
        predictionCache.set(key, result);
        while (predictionCache.size > 8) predictionCache.delete(predictionCache.keys().next().value);
    }

    function publishResult(result) {
        runStage("publish", () => publish(result));
        firstRowSec = (result?.rows || []).reduce(
            (earliestSec, row) => Number.isFinite(row.tSimSec)
                ? Math.min(earliestSec, row.tSimSec)
                : earliestSec,
            Infinity,
        );
    }

    function recoveryIdentity(live) {
        return predictionCacheKey(live.fromSec, live.perturbed) + ":" + live.epochMs;
    }

    function diagnosticResult(error) {
        const stage = error?.predictionStage || "unknown";
        const message = error instanceof Error ? error.message : String(error);
        return Object.freeze({
            suppressed: false,
            diagnostic: Object.freeze({ stage, message }),
            rows: Object.freeze([Object.freeze({
                id: "predictions-error",
                label: "PREDICTIONS UNAVAILABLE — " + stage + " failed; bounded retry scheduled.",
                tier: "modeled",
                diagnostic: true,
            })]),
        });
    }

    function settleFailure(job, error) {
        if (disposed || job.generation !== generation) return;
        predictionPending = false;
        const live = readState();
        recoveryFailure = {
            identity: recoveryIdentity(live),
            retryAtMs: nowMs() + PREDICTION_RECOVERY_DELAY_MS,
        };
        const result = diagnosticResult(error);
        try {
            publishDiagnostic(result);
            firstRowSec = Infinity;
        } catch {
            firstRowSec = Infinity;
        }
    }

    function queueJob(job) {
        queueIdle(deadline => {
            try {
                runSlice(job, deadline);
            } catch (error) {
                if (disposed || job.generation !== generation) return;
                if (job.retryCount < 1) {
                    job.retryCount++;
                    job.scan = null;
                    job.now = null;
                    job.promptPublished = false;
                    predictionPending = true;
                    queueJob(job);
                    return;
                }
                settleFailure(job, error);
            }
        });
    }

    function syncJobToLive(job) {
        const live = readState();
        const invalidated = live.perturbed !== job.perturbed || live.epochMs !== job.epochMs ||
            live.fromSec < job.liveFromSec ||
            (job.scan && live.fromSec > job.coverageEndSec);
        if (invalidated) return { live, valid: false };
        if (!job.scan) {
            job.fromSec = live.fromSec;
            job.coverageEndSec = live.fromSec + spanSec;
        }
        job.liveFromSec = live.fromSec;
        job.key = predictionCacheKey(live.fromSec, live.perturbed);
        return { live, valid: true };
    }

    function restartStaleJob(job, live = readState()) {
        if (job.generation !== generation) return;
        if (live.epochMs !== job.epochMs || live.fromSec < job.liveFromSec) predictionCache.clear();
        recompute("stale lifecycle", true);
    }

    function finish(job) {
        if (disposed || job.generation !== generation) return;
        let liveState = syncJobToLive(job);
        if (!liveState.valid) {
            restartStaleJob(job, liveState.live);
            return;
        }
        const approaches = runStage("result", () => job.scan.result());
        liveState = syncJobToLive(job);
        if (!liveState.valid) {
            restartStaleJob(job, liveState.live);
            return;
        }
        job.now = runStage("findNow", () => findNow({ fromSec: job.liveFromSec }));
        const rows = Object.freeze([
            ...(job.now ? [job.now] : []),
            ...approaches.filter(row => row.tSimSec > job.liveFromSec).slice(0, rowLimit),
        ]);
        const result = Object.freeze({ suppressed: false, rows });
        publishResult(result);
        remember(job.key, result);
        predictionPending = false;
        recoveryFailure = null;
    }

    function sliceBudget(deadline) {
        const remainingMs = Number(deadline?.timeRemaining?.()) || 0;
        const cap = Math.max(1, Math.floor(maxSamplesPerSlice));
        if (deadline?.didTimeout || remainingMs <= 0) return Math.min(PREDICTION_TIMEOUT_SAMPLES, cap);
        return cap;
    }

    function runScanUnits(job, deadline) {
        const startedMs = nowMs();
        const elapsedLimitMs = Number.isFinite(maxCallbackMs) && maxCallbackMs > 0
            ? maxCallbackMs
            : PREDICTION_IDLE_MS;
        const starved = deadline?.didTimeout === true;
        const singleUnit = !starved && !(Number(deadline?.timeRemaining?.()) > 0);
        let units = 0;
        do {
            runStage("step", () => job.scan.step(sliceBudget(deadline)));
            units++;
            if (job.scan.done || singleUnit) break;
            if (nowMs() - startedMs >= elapsedLimitMs) break;
            if (!starved && !(Number(deadline?.timeRemaining?.()) > 1)) break;
        } while (units < PREDICTION_MAX_UNITS_PER_CALLBACK);
    }

    function runSlice(job, deadline) {
        if (disposed || job.generation !== generation) return;
        let liveState = syncJobToLive(job);
        if (!liveState.valid) {
            restartStaleJob(job, liveState.live);
            return;
        }
        if (job.pendingResult) {
            publishResult(job.pendingResult);
            predictionPending = false;
            recoveryFailure = null;
            return;
        }
        if (!job.promptPublished) {
            job.now = runStage("findNow", () => findNow({ fromSec: job.fromSec }));
            job.promptPublished = true;
            publishResult(Object.freeze({
                suppressed: false,
                rows: Object.freeze(job.now ? [job.now] : []),
            }));
            queueJob(job);
            return;
        }
        if (!job.scan) {
            job.scan = runStage(
                "createScan",
                () => createScan({ fromSec: job.fromSec, spanSec, perturbed: false }),
            );
        }
        if (!job.scan.done) runScanUnits(job, deadline);
        liveState = syncJobToLive(job);
        if (!liveState.valid) {
            restartStaleJob(job, liveState.live);
            return;
        }
        if (job.scan.done) finish(job);
        else queueJob(job);
    }

    function publishWithIdleRetry(result, live) {
        try {
            publishResult(result);
            return true;
        } catch {
            predictionPending = true;
            queueJob({
                generation,
                key: predictionCacheKey(live.fromSec, live.perturbed),
                fromSec: live.fromSec,
                liveFromSec: live.fromSec,
                coverageEndSec: live.fromSec + spanSec,
                epochMs: live.epochMs,
                perturbed: live.perturbed,
                now: null,
                promptPublished: true,
                scan: null,
                retryCount: 1,
                pendingResult: result,
            });
            return false;
        }
    }

    function recompute(cause, force = false) {
        if (disposed) return;
        void cause;
        const live = readState();
        const fromSec = live.fromSec;
        const perturbed = live.perturbed;
        const key = predictionCacheKey(fromSec, perturbed);
        initialized = true;
        previousPerturbed = perturbed;
        previousFromSec = fromSec;
        previousEpochMs = live.epochMs;
        firstRowSec = Infinity;
        generation++;
        predictionPending = false;
        recoveryFailure = null;
        if (force) predictionCache.delete(key);

        if (perturbed) {
            const result = Object.freeze({ suppressed: true });
            remember(key, result);
            publishWithIdleRetry(result, live);
            return;
        }
        const cached = predictionCache.get(key);
        if (cached) {
            publishWithIdleRetry(cached, live);
            return;
        }
        predictionPending = true;
        const job = {
            generation,
            key,
            fromSec,
            liveFromSec: fromSec,
            coverageEndSec: fromSec + spanSec,
            epochMs: live.epochMs,
            perturbed,
            now: null,
            promptPublished: false,
            scan: null,
            retryCount: 0,
        };
        queueJob(job);
    }

    return {
        update(status = {}) {
            if (disposed) return;
            if (status.outcome !== "arrive") arrivalHandled = false;
            const arrived = status.outcome === "arrive" && !arrivalHandled;
            if (arrived) arrivalHandled = true;
            const live = readState();
            const rewound = initialized && live.fromSec < previousFromSec;
            const epochChanged = initialized && live.epochMs !== previousEpochMs;
            if (rewound || epochChanged) predictionCache.clear();
            const currentRecoveryIdentity = recoveryIdentity(live);
            const recoveryDue = recoveryFailure &&
                (recoveryFailure.identity !== currentRecoveryIdentity || nowMs() >= recoveryFailure.retryAtMs);
            const lifecycleCause = predictionRecomputeCause(
                initialized,
                arrived,
                live.fromSec,
                predictionPending ? Infinity : firstRowSec,
                previousPerturbed,
                live.perturbed,
            );
            const cause = epochChanged
                ? "epoch"
                : rewound
                    ? "rewind"
                    : lifecycleCause || (recoveryDue ? "recovery" : "");
            previousFromSec = live.fromSec;
            previousEpochMs = live.epochMs;
            if (cause) recompute(cause, cause !== "init");
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            generation++;
            predictionPending = false;
            predictionCache.clear();
            recoveryFailure = null;
        },
    };
}

function setText(node, text) {
    const value = String(text);
    if (node.textContent !== value) node.textContent = value;
}

function setHidden(node, hidden) {
    if (node.hidden !== hidden) node.hidden = hidden;
}

function setClass(node, name, enabled) {
    if (node.classList.contains(name) !== enabled) node.classList.toggle(name, enabled);
}

export function hasUnreadRecent(revision, lastSeen, open) {
    return !open && revision > lastSeen;
}

export function keepJumpEndVisible(active, endUntilMs, nowMs) {
    return active || endUntilMs > nowMs;
}

function wallNowMs() {
    return performance.now();
}

function setEventsOpen(open) {
    controller?.setOpen(open);
}

function hiddenEventsMode() {
    const body = document.body;
    return !eventSurfaceAllowed(
        G.uiMode,
        body.classList.contains("mode-cabin"),
        body.classList.contains("mode-clean"),
        body.classList.contains("mode-xr"),
    );
}

function badge(tier = "modeled", qualifier = "") {
    const definition = EPISTEMIC_TIERS[tier] || EPISTEMIC_TIERS.modeled;
    const node = document.createElement("span");
    node.className = "epi epi--" + definition.id;
    node.textContent = definition.label + (qualifier ? " · " + qualifier : "");
    return node;
}

function updateBadge(node, tier = "modeled", qualifier = "") {
    const definition = EPISTEMIC_TIERS[tier] || EPISTEMIC_TIERS.modeled;
    const className = "epi epi--" + definition.id;
    if (node.className !== className) node.className = className;
    setText(node, definition.label + (qualifier ? " · " + qualifier : ""));
}

function eventRow(id, tier, qualifier = "") {
    const node = document.createElement("article");
    node.className = "evRow";
    node.dataset.eventId = id;
    const top = document.createElement("div");
    top.className = "evRow__top";
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    meta.className = "evRow__meta";
    const badgeNode = badge(tier, qualifier);
    top.append(badgeNode, title);
    node.append(top, meta);
    return { node, badge: badgeNode, title, meta };
}

function initPredictedSection() {
    const existing = els.panel.querySelector?.("#evPredicted");
    if (existing) {
        els.predicted = existing;
        return;
    }
    const section = document.createElement("section");
    section.className = "evSection";
    section.setAttribute("aria-labelledby", "evPredictedHead");
    const heading = document.createElement("h2");
    heading.id = "evPredictedHead";
    heading.textContent = "PREDICTED";
    const rows = document.createElement("div");
    rows.id = "evPredicted";
    section.append(heading, rows);
    const recentSection = els.recent.parentElement;
    els.panel.insertBefore(section, recentSection);
    els.predicted = rows;
}

function blockedReason(row) {
    if (row.tSimSec <= G.t) return "";
    if (G.dead) return "jump unavailable while the vehicle is lost";
    if (G.landed) return "on the surface — deep time needs a free trajectory";
    if (GS.length > 0 && (row.tSimSec - G.t) / 600 > 60) {
        return "deep time blocked: absorbed matter's gravity ghosts force step-by-step physics";
    }
    return null;
}

function beginTimelineJump(view) {
    const reason = blockedReason(view.row);
    if (reason !== null) return;
    const feasibility = maxFeasibleWarp({
        gsCount: GS.length,
        landed: !!G.landed,
        dead: G.dead,
        bhN: BH.n,
    });
    const plan = planJump(G.t, view.row.tSimSec, feasibility);
    if (!plan.ok) return;
    if (startTimeJump(plan, { label: view.row.label, focus: view.row.focus })) {
        controller.beginJump(view.row.tSimSec);
        renderJump();
        controller.closeForAction();
    }
}

function beginPredictedJump(view) {
    const reason = blockedReason(view.row);
    if (reason !== null) return;
    const feasibility = maxFeasibleWarp({
        gsCount: GS.length,
        landed: !!G.landed,
        dead: G.dead,
        bhN: BH.n,
    });
    const lead = predictedLead(view.row);
    const plan = planJump(G.t, view.row.tSimSec, feasibility, lead);
    if (!plan.ok) return;
    if (startTimeJump(plan, { label: view.row.label, focus: view.row.focus })) {
        controller.beginJump(view.row.tSimSec);
        renderJump();
        controller.closeForAction();
    }
}

function createTimelineView(row) {
    const view = { row, ...eventRow(row.id, row.tier, row.qualifier) };
    setText(view.title, row.label);
    setText(view.meta, row.displayTime || fmtCivil(civilDateAt(getEpochMs(), row.tSimSec)));
    view.action = document.createElement("button");
    view.action.type = "button";
    view.action.className = "evJump";
    view.action.textContent = "⏩ JUMP";
    view.action.setAttribute("aria-label", "Jump to " + row.label);
    view.action.addEventListener(
        "click",
        () => beginTimelineJump(view),
        { signal: eventBindingAbort.signal },
    );
    view.reason = document.createElement("span");
    view.reason.className = "evRow__reason";
    view.node.append(view.action, view.reason);
    els.timeline.appendChild(view.node);
    timelineViews.push(view);
}

function createPredictedView(row) {
    const view = { row, ...eventRow(row.id, row.tier) };
    view.action = document.createElement("button");
    view.action.type = "button";
    view.action.className = "evJump";
    view.action.textContent = "⏩ JUMP";
    view.action.addEventListener(
        "click",
        () => beginPredictedJump(view),
        { signal: eventBindingAbort.signal },
    );
    view.reason = document.createElement("span");
    view.reason.className = "evRow__reason";
    view.node.append(view.action, view.reason);
    return view;
}

function updatePredictedView(view, row) {
    view.row = row;
    updateBadge(view.badge, row.tier);
    setText(view.title, row.label);
    const suppressed = row.id === "predictions-off";
    const diagnostic = row.diagnostic === true;
    const inert = suppressed || diagnostic;
    setText(view.meta, inert ? "" : fmtCivil(civilDateAt(getEpochMs(), row.tSimSec)));
    if (!inert) view.action.setAttribute("aria-label", "Jump to " + row.label);
    setHidden(view.action, inert);
    setHidden(view.reason, true);
}

function renderPredictedRows(rows) {
    reconcileKeyedRows(els.predicted, rows, predictedNodes, createPredictedView, updatePredictedView);
}

function renderPredictedState() {
    for (const view of predictedNodes.values()) {
        if (view.row.id === "predictions-off" || view.row.diagnostic) continue;
        const past = view.row.tSimSec <= G.t;
        const reason = blockedReason(view.row);
        setClass(view.node, "evRow--past", past);
        setHidden(view.action, past || reason !== null);
        setHidden(view.reason, past || reason === null);
        if (!past && reason !== null) setText(view.reason, reason);
    }
}

function applyPredictionResult(result) {
    if (result?.suppressed) {
        renderPredictedRows([Object.freeze({
            id: "predictions-off",
            label: PREDICTION_OFF_LABEL,
            tier: "modeled",
        })]);
        return;
    }
    const rows = result?.rows || [];
    renderPredictedRows(rows);
    renderPredictedState();
}

function applyPredictionDiagnostic(result) {
    const row = result?.rows?.find(candidate => candidate.diagnostic === true);
    if (!row || !els?.predicted) return;
    const view = createPredictedView(row);
    updatePredictedView(view, row);
    view.node.setAttribute("role", "status");
    view.node.setAttribute("aria-live", "polite");
    while (els.predicted.firstChild) els.predicted.firstChild.remove();
    predictedNodes.clear();
    els.predicted.appendChild(view.node);
    predictedNodes.set(row.id, view);
}

function updatePredictionSchedule(status) {
    predictionScheduler?.update(status);
}

function syncDiscoveryRows() {
    const source = getRecentDiscoverySnapshot();
    if (controller.syncDiscovery(source.revision, source.change) !== 0) {
        const snapshot = discoverySync.update(source.entries);
        discoveryRows = snapshot.rows;
        recentDirty = true;
    }
}

function createRecentView(entry) {
    return eventRow(entry.id, entry.tier);
}

function updateRecentView(view, entry) {
    updateBadge(view.badge, entry.tier);
    setText(view.title, entry.label);
    setText(view.meta, entry.date || fmtCivil(civilDateAt(getEpochMs(), entry.tSimSec)));
}

function renderRecent() {
    if (!recentDirty) return;
    recentDirty = false;
    const rows = mergeRecentRows(discoveryRows, recentEvents, RECENT_LIMIT).reverse();
    reconcileKeyedRows(els.recent, rows, recentNodes, createRecentView, updateRecentView);
    setHidden(els.recentEmpty, rows.length > 0);
}

function renderTimeline() {
    for (let i = 0; i < timelineViews.length; i++) {
        const view = timelineViews[i];
        const past = view.row.tSimSec <= G.t;
        const reason = blockedReason(view.row);
        setClass(view.node, "evRow--past", past);
        setHidden(view.action, past || reason !== null);
        setHidden(view.reason, past || reason === null);
        if (!past && reason !== null) setText(view.reason, reason);
    }
}

function renderLive() {
    const tde = activeTde();
    controller.setLive(!!tde);
    if (!tde) {
        setHidden(els.liveRow.node, true);
        setHidden(els.liveEmpty, false);
        return;
    }
    setHidden(els.liveEmpty, true);
    setHidden(els.liveRow.node, false);
    setText(els.liveRow.title, tde.targetName + " tidal disruption");
    const ratio = tde.tFbSec > 0 ? tde.ageSec / tde.tFbSec : 0;
    setText(els.liveRow.meta, "L " + tde.LnowW.toExponential(2) + " W · t/t_fb " + ratio.toFixed(2));
    els.liveWatch.dataset.bh = String(tde.bh);
}

function renderJump(status = jumpStatus()) {
    controller.renderJump(status.active, status.label, status.etaWallSec, G.t, wallNowMs(), status.outcome);
}

export function noteEvent(kindOrLabel, labelOrTier = "modeled", sourceTier = "modeled") {
    const hasKind = arguments.length >= 2 && !EPISTEMIC_TIERS[labelOrTier];
    const label = hasKind ? labelOrTier : kindOrLabel;
    const tier = hasKind ? sourceTier : labelOrTier;
    recentEvents.push({
        id: "event:" + (++eventSerial),
        label: String(label || kindOrLabel),
        tSimSec: G.t,
        tier,
        source: "event",
        sequence: eventSerial,
    });
    if (recentEvents.length > RECENT_LIMIT) recentEvents.splice(0, recentEvents.length - RECENT_LIMIT);
    recentDirty = true;
    controller?.noteActivity();
}

export function initEvents({ mergerState } = {}) {
    const nextEls = {
        panel: document.getElementById("evPanel"),
        button: document.getElementById("evBtn"),
        close: document.getElementById("evClose"),
        live: document.getElementById("evLive"),
        liveEmpty: document.getElementById("evLiveEmpty"),
        timeline: document.getElementById("evTimeline"),
        recent: document.getElementById("evRecent"),
        recentEmpty: document.getElementById("evRecentEmpty"),
        jump: document.getElementById("tdJump"),
        jumpLabel: document.getElementById("tdJumpLabel"),
        jumpChip: document.getElementById("evJumpChip"),
        jumpChipLabel: document.getElementById("evJumpChipLabel"),
        jumpChipEta: document.getElementById("evJumpChipEta"),
        jumpCancel: document.getElementById("evJumpCancel"),
    };
    if (!nextEls.panel) return;
    if (boundPanel === nextEls.panel && boundDocument === document && controller) {
        updateEvents();
        return;
    }

    eventBindingAbort?.abort();
    modeUnsubscribe?.();
    predictionScheduler?.dispose();
    eventBindingAbort = new AbortController();
    modeUnsubscribe = null;
    predictionScheduler = null;
    controller = null;
    predictedNodes.clear();
    recentNodes.clear();
    timelineViews.length = 0;
    recentDirty = true;
    els = nextEls;
    boundPanel = els.panel;
    boundDocument = document;
    initPredictedSection();
    predictionScheduler = createPredictionScheduler({
        readState: () => ({ fromSec: G.t, perturbed: BH.n > 0, epochMs: getEpochMs() }),
        scheduleIdle: schedulePredictionWork,
        createScan: createCloseApproachScan,
        findNow: nextConjunction,
        publish: applyPredictionResult,
        publishDiagnostic: applyPredictionDiagnostic,
    });
    controller = createEventController({
        panel: els.panel,
        button: els.button,
        close: els.close,
        jumpDock: els.jump,
        jumpDockLabel: els.jumpLabel,
        jumpChip: els.jumpChip,
        jumpChipLabel: els.jumpChipLabel,
        jumpChipEta: els.jumpChipEta,
        cancelJump: () => cancelTimeJump("cancel button"),
        endLatchMs: JUMP_END_LATCH_MS,
    });
    const listenerOptions = { signal: eventBindingAbort.signal };
    els.button.addEventListener("click", () => controller.toggleOpen(), listenerOptions);
    els.close.addEventListener("click", () => setEventsOpen(false), listenerOptions);
    els.jumpCancel.addEventListener(
        "click",
        () => controller.requestCancel(G.t, wallNowMs()),
        listenerOptions,
    );
    document.addEventListener("keydown", event => {
        controller.handleEscape(event.key);
    }, listenerOptions);
    modeUnsubscribe = onModeChange(() => setEventsOpen(false));
    els.liveRow = eventRow("live-tde", "modeled");
    els.liveWatch = document.createElement("button");
    els.liveWatch.type = "button";
    els.liveWatch.className = "evWatch";
    els.liveWatch.textContent = "WATCH";
    els.liveWatch.setAttribute("aria-label", "Watch tidal disruption");
    els.liveWatch.addEventListener("click", () => {
        setWarp(Math.min(G.warp, 600), "events");
        setFocus("bh:" + els.liveWatch.dataset.bh);
        controller.closeForAction();
    }, listenerOptions);
    els.liveRow.node.appendChild(els.liveWatch);
    els.live.appendChild(els.liveRow.node);
    setHidden(els.liveRow.node, true);

    const timeline = buildTimeline({ nowSec: G.t, merger: mergerState?.() });
    for (let i = 0; i < timeline.length; i++) createTimelineView(timeline[i]);
    syncDiscoveryRows();
    updateEvents();
}

export function updateEvents() {
    if (!els) return;
    const status = jumpStatus();
    if (controller.isOpen() && hiddenEventsMode()) setEventsOpen(false);
    updatePredictionSchedule(status);
    syncDiscoveryRows();
    renderLive();
    renderTimeline();
    renderPredictedState();
    renderRecent();
    renderJump(status);
}
