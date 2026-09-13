import { WARPS, SEC_YEAR, warpLabel } from "./constants.js";
import { civilDateAt, fmtCivil, getEpochMs } from "./epoch.js";
import { fmtCivilDate } from "./format.js";
import { G, GS, WORLD } from "./state.js";
import { cancelTimeJump, setPaused, setWarp, stepWarp } from "./timeCtl.js";

const $ = id => document.getElementById(id);

let els = null;
const sampled = {
    blockedKind: 0,
    blockedFloorT: -Infinity,
    blockedUntil: 0,
    blockedVisible: false,
};

function setText(el, value) {
    if (el && el.textContent !== value) el.textContent = value;
}

function setHidden(el, hidden) {
    if (el && el.hidden !== hidden) el.hidden = hidden;
}

function setAttribute(el, name, value) {
    if (!el) return;
    if (value === null) {
        if (el.hasAttribute(name)) el.removeAttribute(name);
        return;
    }
    const next = String(value);
    if (el.getAttribute(name) !== next) el.setAttribute(name, next);
}

function setClass(el, name, enabled) {
    if (el && el.classList.contains(name) !== enabled) el.classList.toggle(name, enabled);
}

function setStyleProperty(style, name, value) {
    if (style && style.getPropertyValue(name) !== value) style.setProperty(name, value);
}

function nearestWarpIndex(warp) {
    const mag = Math.abs(warp);
    const logMag = Math.log(Math.max(mag, Number.MIN_VALUE));
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < WARPS.length; i++) {
        const diff = Math.abs(Math.log(WARPS[i]) - logMag);
        if (diff < bestDiff) {
            best = i;
            bestDiff = diff;
        }
    }
    return best;
}

function speedDescription(warp) {
    if (warp === 1) return "Real time";
    if (warp >= SEC_YEAR) return (warp / SEC_YEAR).toLocaleString("en", {maximumFractionDigits:2}) + (warp === SEC_YEAR ? " year / second" : " years / second");
    if (warp >= 86400) return (warp / 86400).toLocaleString("en", {maximumFractionDigits:2}) + (warp === 86400 ? " day / second" : " days / second");
    if (warp >= 3600) return (warp / 3600).toLocaleString("en", {maximumFractionDigits:2}) + (warp === 3600 ? " hour / second" : " hours / second");
    if (warp >= 60) return (warp / 60).toLocaleString("en", {maximumFractionDigits:2}) + (warp === 60 ? " minute / second" : " minutes / second");
    return warp.toLocaleString("en", {maximumSignificantDigits:3}) + " seconds / second";
}

function tickLabel(warp) {
    return warp < 1 || warp >= SEC_YEAR ? warpLabel(warp) : "";
}

function sampledBlockedMessage() {
    if (sampled.blockedKind === 1) {
        return "REVERSE BLOCKED — matter in flight (debris and gravity ghosts cannot un-happen)";
    }
    if (sampled.blockedKind === 2) {
        return "REVERSE BLOCKED — cannot rewind past " + fmtCivilDate(getEpochMs(), sampled.blockedFloorT);
    }
    return "";
}

export function initTimeDock() {
    const rail = $("tdRail");
    els = {
        dock: $("timeDock"),
        date: $("tdDate"),
        pause: $("tdPause"),
        stepDown: $("tdStepDown"),
        stepUp: $("tdStepUp"),
        warpLabel: $("tdWarpLabel"),
        rev: $("tdRev"),
        rail,
        speed: $("tdSpeed"),
        direction: $("tdDirection"),
        ticks: [],
        blocked: $("tdBlocked"),
        jump: $("tdJump"),
        cancel: $("tdCancel"),
    };
    if (!rail) return;
    if (els.speed) {
        els.speed.textContent = "";
        for (const warp of WARPS) {
            const option = document.createElement("option");
            option.value = String(warp);
            option.textContent = speedDescription(warp);
            els.speed.appendChild(option);
        }
        els.speed.addEventListener("change", () => setWarp(Number(els.speed.value) * (G.warp < 0 ? -1 : 1), "dock"));
    }
    rail.textContent = "";
    rail.style.gridTemplateColumns = `repeat(${WARPS.length}, minmax(0, 1fr))`;
    WARPS.forEach((warp, i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tdTick";
        btn.dataset.warpIndex = String(i);
        btn.setAttribute("aria-label", warpLabel(warp));
        const dot = document.createElement("span");
        dot.className = "tdTickDot";
        const label = document.createElement("span");
        label.className = "tdTickLabel";
        label.textContent = tickLabel(warp);
        btn.append(dot, label);
        btn.addEventListener("click", () => setWarp(WARPS[i], "dock"));
        els.ticks.push(btn);
        rail.appendChild(btn);
    });
    els.stepDown?.addEventListener("click", () => stepWarp(-1, "dock"));
    els.stepUp?.addEventListener("click", () => stepWarp(1, "dock"));
    els.pause?.addEventListener("click", () => {
        if (G.warp === 0) { setWarp(1, "dock"); setPaused(false, "dock"); }
        else setPaused(!G.paused, "dock");
    });
    els.rev?.addEventListener("click", () => setWarp(G.warp === 0 ? -1 : -G.warp, "dock"));
    els.cancel?.addEventListener("click", () => cancelTimeJump("cancel button"));
    sampleTimeDock();
    renderTimeDock();
}

export function sampleTimeDock() {
    if (!els) return;
    const now = performance.now();
    if (WORLD.reverseBlocked) {
        if (GS.length > 0 || WORLD.tdeInProgress) {
            sampled.blockedKind = 1;
            sampled.blockedFloorT = -Infinity;
            sampled.blockedUntil = now + 1500;
        } else if (Number.isFinite(WORLD.irreversibleFloorT)) {
            sampled.blockedKind = 2;
            sampled.blockedFloorT = WORLD.irreversibleFloorT;
            sampled.blockedUntil = now + 1500;
        }
    }
    sampled.blockedVisible = sampled.blockedKind !== 0 && now < sampled.blockedUntil;
    if (!sampled.blockedVisible) {
        sampled.blockedKind = 0;
        sampled.blockedFloorT = -Infinity;
    }
}

export function renderTimeDock() {
    if (!els) return;
    setText(els.date, fmtCivil(civilDateAt(getEpochMs(), G.t)));
    setText(els.warpLabel, warpLabel(G.warp));
    const stopped = G.paused || G.warp === 0;
    setText(els.pause, stopped ? "Play" : "Pause");
    setAttribute(els.pause, "aria-label", stopped ? "Play" : "Pause");
    setAttribute(els.pause, "aria-pressed", G.paused);
    const reversing = G.warp < 0;
    setClass(els.rev, "active", reversing);
    setAttribute(els.rev, "aria-pressed", reversing);
    const activeWarp = nearestWarpIndex(G.warp);
    setText(els.direction, stopped ? "Paused" : reversing ? "Rewinding" : "Forward");
    if (els.speed) {
        const exact = WARPS.includes(Math.abs(G.warp));
        let custom = els.speed.querySelector('[data-custom]');
        if (!exact) {
            if (!custom) { custom = document.createElement('option'); custom.dataset.custom = 'true'; els.speed.appendChild(custom); }
            if (custom.value !== String(Math.abs(G.warp))) custom.value = String(Math.abs(G.warp));
            setText(custom, speedDescription(Math.abs(G.warp)));
        } else custom?.remove();
        const value = String(Math.abs(G.warp));
        if (els.speed.value !== value) els.speed.value = value;
    }
    for (let i = 0; i < els.ticks.length; i++) {
        const tick = els.ticks[i];
        const active = i === activeWarp;
        setClass(tick, "active", active);
        setAttribute(tick, "aria-current", active ? "true" : null);
    }

    if (sampled.blockedVisible) {
        setText(els.blocked, sampledBlockedMessage());
        setHidden(els.blocked, false);
    } else {
        setHidden(els.blocked, true);
    }

    const dockHeight = els.dock?.offsetHeight || 0;
    if (dockHeight > 0) {
        setStyleProperty(document.documentElement.style, "--time-dock-height", dockHeight + "px");
    }
}
