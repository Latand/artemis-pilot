import { toast } from "./achievements.js";
import { setCineOpen } from "./cinematic.js";
import { G } from "./state.js";

export const UI_MODES = ["observe", "pilot", "direct"];

const MODE_LABELS = {
    observe: "OBSERVE",
    pilot: "PILOT",
    direct: "DIRECT",
};
const MODE_TOASTS = {
    observe: "OBSERVE - the universe runs itself",
    pilot: "PILOT - you have the stick",
    direct: "DIRECT - stage the spectacle",
};

const subscribers = new Set();
let xrPresenting = false;

function validMode(mode) {
    return UI_MODES.includes(mode) ? mode : "observe";
}

function applyBodyClasses(mode) {
    if (typeof document === "undefined") return;
    document.body?.classList.toggle("mode-observe", mode === "observe");
    document.body?.classList.toggle("mode-pilot", mode === "pilot");
    document.body?.classList.toggle("mode-direct", mode === "direct");
    const brandMode = document.getElementById("brandMode");
    if (brandMode) brandMode.textContent = MODE_LABELS[mode];
}

function persistMode(mode) {
    try { localStorage.setItem("ap_uiMode", mode); } catch (e) { }
}

function notify(mode, previous) {
    for (const fn of subscribers) {
        try { fn(mode, previous); } catch (e) { console.warn("uiMode subscriber failed", e); }
    }
}

export function setUiMode(next, announce = true) {
    if (xrPresenting) return G.uiMode;
    const mode = validMode(next);
    const previous = validMode(G.uiMode);
    if (previous === mode) {
        G.uiMode = mode;
        applyBodyClasses(mode);
        persistMode(mode);
        return mode;
    }
    if (previous === "direct" && mode !== "direct") setCineOpen(false);
    G.uiMode = mode;
    applyBodyClasses(mode);
    persistMode(mode);
    notify(mode, previous);
    if (announce) toast(MODE_TOASTS[mode]);
    return mode;
}

export function cycleUiMode() {
    if (xrPresenting) return G.uiMode;
    const i = UI_MODES.indexOf(validMode(G.uiMode));
    return setUiMode(UI_MODES[(i + 1) % UI_MODES.length]);
}

export function initUiMode() {
    let mode = "observe";
    try { mode = validMode(localStorage.getItem("ap_uiMode")); } catch (e) { }
    G.uiMode = mode;
    applyBodyClasses(mode);
    return mode;
}

export function onModeChange(fn) {
    if (typeof fn !== "function") return () => { };
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

export function setXrPresenting(presenting) {
    xrPresenting = !!presenting;
    if (typeof document !== "undefined") document.body?.classList.toggle("mode-xr", xrPresenting);
}

export function isXrPresenting() {
    return xrPresenting;
}
