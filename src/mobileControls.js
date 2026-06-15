import { PL, warpLabel, WARP_MAX } from "./constants.js";
import { MOONS } from "./moons.js";
import { G, keys } from "./state.js";
import { fmtDist, fmtMET } from "./format.js";
import { apOff, apTravelToFocus } from "./autopilot.js";
import { toast } from "./achievements.js";
import { computePrediction } from "./trails.js";
import { setConstellationsVisible } from "./realSky.js";
import { requestRealSkyLoad } from "./bodies.js";
import { toggleHelp } from "./hud.js";
import { toggleScenarioMenu } from "./scenarios.js";
import { toggleBHPlacementMode } from "./blackholes.js";

const $ = id => document.getElementById(id);

const ui = $("mobileUI");
const mMet = $("mMet"), mVel = $("mVel"), mAlt = $("mAlt"), mFocus = $("mFocus"), mWarp = $("mWarp"), mMode = $("mMode"), mWarpVal = $("mWarpVal");
const menu = $("mMenu");
const btnPredict = $("mPredict"), btnRiver = $("mRiver"), btnConst = $("mConst"), btnPause = $("mPause");

const textCache = new WeakMap(), classCache = new WeakMap();
let activeCache = new WeakMap();
function setText(el, value) {
    if (!el || textCache.get(el) === value) return;
    el.textContent = value;
    textCache.set(el, value);
}
function setClass(el, value) {
    if (!el || classCache.get(el) === value) return;
    el.className = value;
    classCache.set(el, value);
}
function setActive(el, active) {
    if (!el || activeCache.get(el) === active) return;
    el.classList.toggle("active", active);
    activeCache.set(el, active);
}

// ---- hold buttons: rotate / RCS / boost map straight onto the key set ----
const holdButtons = [
    ["mYawL", "KeyA"], ["mYawR", "KeyD"],
    ["mRcsL", "KeyQ"], ["mRcsR", "KeyE"],
    ["mBoost", "ShiftLeft"],
];
function bindHold(id, code) {
    const el = $(id);
    if (!el) return;
    const down = e => {
        e.preventDefault(); e.stopPropagation();
        try { el.setPointerCapture(e.pointerId); } catch (err) { }
        keys.add(code);
        el.classList.add("active");
    };
    const up = e => {
        e.preventDefault();
        keys.delete(code);
        el.classList.remove("active");
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("lostpointercapture", () => { keys.delete(code); el.classList.remove("active"); });
}

function bindTap(id, fn) {
    const el = $(id);
    if (!el) return;
    el.addEventListener("click", e => { e.preventDefault(); fn(); syncMobileButtons(); });
}

// ---- throttle lever: drag up = main engine, down = retro; springs back on release.
// vertical offset sets the throttle level so it reads like a real analog lever ----
function initThrottle() {
    const track = $("mThrTrack"), knob = $("mThrKnob"), fill = $("mThrFill"), cap = $("mThrCap");
    if (!track || !knob) return;
    let dragging = false, half = 1;
    const reset = () => {
        keys.delete("KeyW"); keys.delete("KeyS");
        knob.style.top = "50%";              // CSS transform keeps it horizontally centered
        if (fill) { fill.style.height = "0%"; fill.style.top = "50%"; }
        knob.classList.remove("up", "down");
        if (cap) cap.textContent = "COAST";
    };
    const apply = clientY => {
        const r = track.getBoundingClientRect();
        half = r.height / 2;
        const mid = r.top + half;
        let off = (mid - clientY) / half;          // +1 top … -1 bottom
        off = Math.max(-1, Math.min(1, off));
        const knobTop = (50 - off * 46) + "%";
        knob.style.top = knobTop;
        const dead = 0.06;
        const pctOf = Math.round((Math.abs(off) - dead) / (1 - dead) * 100);
        keys.delete("KeyW"); keys.delete("KeyS");
        knob.classList.remove("up", "down");
        if (off > dead) {
            keys.add("KeyW");
            knob.classList.add("up");
            G.throttle = Math.max(.05, Math.min(100, (off - dead) / (1 - dead) * 2.4 + 0.12));
            if (cap) cap.textContent = "THRUST " + pctOf + "%";
        } else if (off < -dead) {
            keys.add("KeyS");
            knob.classList.add("down");
            G.throttle = Math.max(.05, Math.min(100, (-off - dead) / (1 - dead) * 2.4 + 0.12));
            if (cap) cap.textContent = "RETRO " + pctOf + "%";
        } else if (cap) cap.textContent = "COAST";
        if (fill) {
            const pct = Math.abs(off) * 46;
            fill.style.height = pct + "%";
            fill.style.top = off > 0 ? (50 - pct) + "%" : "50%";
        }
    };
    knob.addEventListener("pointerdown", e => {
        e.preventDefault(); e.stopPropagation();
        dragging = true;
        try { knob.setPointerCapture(e.pointerId); } catch (err) { }
        apply(e.clientY);
    });
    track.addEventListener("pointerdown", e => {
        e.preventDefault(); e.stopPropagation();
        dragging = true;
        try { knob.setPointerCapture(e.pointerId); } catch (err) { }
        apply(e.clientY);
    });
    const move = e => { if (dragging) { e.preventDefault(); apply(e.clientY); } };
    const end = e => { if (!dragging) return; dragging = false; reset(); };
    knob.addEventListener("pointermove", move);
    knob.addEventListener("pointerup", end);
    knob.addEventListener("pointercancel", end);
    knob.addEventListener("lostpointercapture", end);
    reset();
}

// ---- slide-up flight systems sheet ----
function setMenu(open) {
    if (!menu) return;
    menu.classList.toggle("open", open);
}
function initMenu(hooks) {
    bindTap("mMenuBtn", () => setMenu(true));
    $("mMenuClose")?.addEventListener("click", () => setMenu(false));
    menu?.addEventListener("click", e => { if (e.target === menu) setMenu(false); });

    bindTap("mWarpDown", () => { G.warp = Math.max(1, G.warp / 2); });
    bindTap("mWarpUp", () => { G.warp = Math.min(WARP_MAX, G.warp * 2); });
    bindTap("mPause", () => { G.paused = !G.paused; });
    bindTap("mFocusBtn", hooks.cycleFocus);
    bindTap("mScaleBtn", hooks.cycleScale);
    bindTap("mPredict", () => { G.predict = !G.predict; computePrediction(); });
    bindTap("mRiver", () => { G.gr = !G.gr; });
    bindTap("mConst", () => {
        G.constellations = !G.constellations;
        if (G.constellations) requestRealSkyLoad(0);
        setConstellationsVisible(G.constellations);
    });
    bindTap("mNav", () => { setMenu(false); hooks.openNavigator?.(); });
    bindTap("mBH", () => { setMenu(false); toggleBHPlacementMode(); });
    bindTap("mCatalog", () => { setMenu(false); hooks.openCatalogSearch?.(); });
    bindTap("mAuto", () => { setMenu(false); apTravelToFocus(toast); });
    bindTap("mApOff", () => apOff("cancelled", toast));
    bindTap("mSims", () => { setMenu(false); toggleScenarioMenu(); });
    bindTap("mReset", () => { setMenu(false); hooks.restart(); });
    bindTap("mHelpBtn", () => { setMenu(false); toggleHelp(); });
}

function focusName() {
    if (G.focus === "ship") return "SHIP";
    if (G.focus === "earth") return "EARTH";
    if (G.focus === "moon") return "MOON";
    if (G.focus === "sun") return "SUN";
    if (G.focus === "free") return "FREE";
    if (typeof G.focus === "number") return PL[G.focus]?.name || "PLANET";
    if (typeof G.focus === "string" && G.focus.startsWith("moon:")) return MOONS[Number(G.focus.slice(5))]?.name || "MOON";
    if (typeof G.focus === "string" && G.focus.startsWith("bh:")) return "BLACK HOLE";
    if (typeof G.focus === "string" && (G.focus.startsWith("star:") || G.focus.startsWith("proc:") || G.focus.startsWith("hyg:"))) return "STAR";
    return String(G.focus || "SHIP").toUpperCase();
}

export function syncMobileButtons() {
    if (!ui) return;
    setActive(btnPredict, G.predict);
    setActive(btnRiver, G.gr);
    setActive(btnConst, G.constellations);
    setActive(btnPause, G.paused);
}

export function updateMobileControls(oi, sp, aMag) {
    if (!ui) return;
    setText(mMet, fmtMET(G.t));
    setText(mVel, sp.toFixed(2) + " km/s");
    setText(mAlt, fmtDist(Math.max(0, oi.r - oi.R)));
    setText(mFocus, focusName());
    setText(mWarp, warpLabel(G.warp));
    setText(mWarpVal, warpLabel(G.warp));
    if (mMode) {
        setText(mMode, G.dead ? "LOST" : G.paused ? "PAUSED" : aMag > 0 ? "BURN" : G.landed ? "LANDED" : "COAST");
        setClass(mMode, aMag > 0 ? "burn" : G.paused || G.dead ? "warn" : "");
    }
    syncMobileButtons();
}

export function initMobileControls(hooks) {
    if (!ui) return;
    for (const [id, code] of holdButtons) bindHold(id, code);
    initThrottle();
    initMenu(hooks);
    window.addEventListener("blur", () => {
        for (const [, code] of holdButtons) keys.delete(code);
        keys.delete("KeyW"); keys.delete("KeyS");
        ui.querySelectorAll(".active").forEach(el => el.classList.remove("active"));
        activeCache = new WeakMap();
        syncMobileButtons();
    });
    syncMobileButtons();
}
