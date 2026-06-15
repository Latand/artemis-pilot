import { PL, warpLabel, WARP_MAX } from "./constants.js";
import { G, keys } from "./state.js";
import { fmtDist, fmtMET } from "./format.js";
import { apOff, apTravelToFocus } from "./autopilot.js";
import { toast } from "./achievements.js";
import { computePrediction } from "./trails.js";
import { setConstellationsVisible } from "./realSky.js";
import { requestRealSkyLoad } from "./bodies.js";
import { toggleHelp } from "./hud.js";

const $ = id => document.getElementById(id);

const deck = $("mobileDeck");
const mMet = $("mMet"), mVel = $("mVel"), mAlt = $("mAlt"), mFocus = $("mFocus"), mWarp = $("mWarp"), mMode = $("mMode");
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
const holdButtons = [
    ["mYawL", "KeyA"], ["mYawR", "KeyD"], ["mRcsL", "KeyQ"], ["mRcsR", "KeyE"],
    ["mMain", "KeyW"], ["mReverse", "KeyS"], ["mBoost", "ShiftLeft"],
];

function pressKey(code) {
    keys.add(code);
}

function releaseKey(code) {
    keys.delete(code);
}

function bindHold(id, code) {
    const el = $(id);
    if (!el) return;
    const down = e => {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch (err) { }
        pressKey(code);
        el.classList.add("active");
    };
    const up = e => {
        e.preventDefault();
        releaseKey(code);
        el.classList.remove("active");
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("lostpointercapture", () => {
        releaseKey(code);
        el.classList.remove("active");
    });
}

function bindTap(id, fn) {
    const el = $(id);
    if (!el) return;
    el.addEventListener("click", e => {
        e.preventDefault();
        fn();
        syncMobileButtons();
    });
}

function focusName() {
    if (G.focus === "ship") return "SHIP";
    if (G.focus === "earth") return "EARTH";
    if (G.focus === "moon") return "MOON";
    if (G.focus === "sun") return "SUN";
    if (G.focus === "free") return "FREE";
    if (typeof G.focus === "number") return PL[G.focus]?.name || "PLANET";
    if (typeof G.focus === "string" && G.focus.startsWith("bh:")) return "BLACK HOLE";
    if (typeof G.focus === "string" && (G.focus.startsWith("star:") || G.focus.startsWith("proc:") || G.focus.startsWith("hyg:"))) return "STAR";
    return String(G.focus || "SHIP").toUpperCase();
}

export function syncMobileButtons() {
    if (!deck) return;
    setActive(btnPredict, G.predict);
    setActive(btnRiver, G.gr);
    setActive(btnConst, G.constellations);
    setActive(btnPause, G.paused);
}

export function updateMobileControls(oi, sp, aMag) {
    if (!deck) return;
    setText(mMet, "T+ " + fmtMET(G.t));
    setText(mVel, sp.toFixed(2) + " km/s");
    setText(mAlt, fmtDist(Math.max(0, oi.r - oi.R)));
    setText(mFocus, focusName());
    setText(mWarp, warpLabel(G.warp));
    if (mMode) {
        setText(mMode, G.dead ? "LOST" : G.paused ? "PAUSED" : aMag > 0 ? "BURN" : G.landed ? "LANDED" : "COAST");
        setClass(mMode, aMag > 0 ? "burn" : G.paused || G.dead ? "warn" : "");
    }
    syncMobileButtons();
}

export function initMobileControls({ restart, cycleFocus, cycleScale }) {
    if (!deck) return;
    for (const [id, code] of holdButtons) bindHold(id, code);
    bindTap("mWarpDown", () => { G.warp = Math.max(1, G.warp / 2); });
    bindTap("mWarpUp", () => { G.warp = Math.min(WARP_MAX, G.warp * 2); });
    bindTap("mPause", () => { G.paused = !G.paused; });
    bindTap("mPredict", () => { G.predict = !G.predict; computePrediction(); });
    bindTap("mRiver", () => { G.gr = !G.gr; });
    bindTap("mConst", () => {
        G.constellations = !G.constellations;
        if (G.constellations) requestRealSkyLoad(0);
        setConstellationsVisible(G.constellations);
    });
    bindTap("mFocusBtn", cycleFocus);
    bindTap("mScaleBtn", cycleScale);
    bindTap("mAuto", () => apTravelToFocus(toast));
    bindTap("mApOff", () => apOff("cancelled", toast));
    bindTap("mReset", restart);
    bindTap("mHelpBtn", toggleHelp);
    window.addEventListener("blur", () => {
        for (const [, code] of holdButtons) releaseKey(code);
        deck.querySelectorAll(".active").forEach(el => el.classList.remove("active"));
        activeCache = new WeakMap();
        syncMobileButtons();
    });
    syncMobileButtons();
}
