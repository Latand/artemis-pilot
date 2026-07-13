import { activeTde } from "./blackholes.js";
import { getRecentDiscoverySnapshot } from "./discoveryLog.js";
import { civilDateAt, fmtCivil, getEpochMs } from "./epoch.js";
import { setFocus } from "./input.js";
import { G, GS, BH } from "./state.js";
import { cancelTimeJump, jumpStatus, maxFeasibleWarp, setWarp, startTimeJump } from "./timeCtl.js";
import { onModeChange } from "./uiMode.js";
import { buildTimeline, planJump } from "./universe/eventTimeline.js";
import { createEventController, eventSurfaceAllowed } from "./universe/eventController.js";
import {
    createDiscoveryRecentSync,
    EPISTEMIC_TIERS,
    mergeRecentRows,
    reconcileKeyedRows,
} from "./universe/epistemic.js";

const RECENT_LIMIT = 12;
export const JUMP_END_LATCH_MS = 1500;
const discoverySync = createDiscoveryRecentSync(RECENT_LIMIT);
const recentEvents = [];
const recentNodes = new Map();
const timelineViews = [];
let discoveryRows = [];
let eventSerial = 0;
let recentDirty = true;
let els = null;
let controller = null;

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

function createTimelineView(row) {
    const view = { row, ...eventRow(row.id, row.tier, row.qualifier) };
    setText(view.title, row.label);
    setText(view.meta, row.displayTime || fmtCivil(civilDateAt(getEpochMs(), row.tSimSec)));
    view.action = document.createElement("button");
    view.action.type = "button";
    view.action.className = "evJump";
    view.action.textContent = "⏩ JUMP";
    view.action.setAttribute("aria-label", "Jump to " + row.label);
    view.action.addEventListener("click", () => beginTimelineJump(view));
    view.reason = document.createElement("span");
    view.reason.className = "evRow__reason";
    view.node.append(view.action, view.reason);
    els.timeline.appendChild(view.node);
    timelineViews.push(view);
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

function renderJump() {
    const status = jumpStatus();
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
    els = {
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
    if (!els.panel) return;
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
    els.button.addEventListener("click", () => controller.toggleOpen());
    els.close.addEventListener("click", () => setEventsOpen(false));
    els.jumpCancel.addEventListener("click", () => controller.requestCancel(G.t, wallNowMs()));
    document.addEventListener("keydown", event => {
        controller.handleEscape(event.key);
    });
    onModeChange(() => setEventsOpen(false));
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
    });
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
    if (controller.isOpen() && hiddenEventsMode()) setEventsOpen(false);
    syncDiscoveryRows();
    renderLive();
    renderTimeline();
    renderRecent();
    renderJump();
}
