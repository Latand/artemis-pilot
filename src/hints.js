// Contextual hint cards: milestone-triggered, top-center, auto-fade,
// one at a time, each shown once ever (persisted in browser storage).
import { SOI_M } from "./constants.js";
import { G } from "./state.js";
import { cam } from "./scene.js";

const LS = "ap_hints.v1";
let seen = {};
try { seen = JSON.parse(localStorage.getItem(LS) || "{}") || {}; } catch (e) { seen = {}; }

const HINTS = [
    { id: "controls", text: "W thrust · A/D rotate · scroll zoom · H all controls", when: () => performance.now() - t0 > 2500 },
    { id: "predict", text: "P — prediction shows your future path", when: oi => oi.r - oi.R > 1000 },
    { id: "river", text: "river view G shows spacetime flowing", when: () => G.warp > 3600 },
    { id: "circ", text: "⇧C circularizes this orbit", when: oi => oi.rM < SOI_M },
    { id: "travel", text: "⇧T lets the autopilot fly you there", when: () => typeof G.focus === "number" },
    { id: "cosmic", text: "C cycles cosmic scale · U cycles star destinations", when: () => cam.dist > 1e7 },
    { id: "cabin", text: "drag to look around the cockpit", when: () => G.cabin },
];

let el = null, hideAt = 0, t0 = performance.now();

export function initHints() {
    el = document.createElement("div");
    el.id = "hintCard";
    document.getElementById("root").appendChild(el);
}

// re-arm every hint (used by the beginner scenario)
export function resetHints() {
    seen = {};
    t0 = performance.now();
    try { localStorage.setItem(LS, "{}"); } catch (e) { }
    if (el) el.classList.remove("on");
}

export function hintTick(oi) {
    if (!el || G.dead) return;
    const now = performance.now();
    if (el.classList.contains("on")) {
        if (now > hideAt) el.classList.remove("on");
        return;
    }
    // hold back while a modal or a scenario physics card owns the screen
    if (document.body.classList.contains("ui-modal")) return;
    const pc = document.getElementById("physCard");
    if (pc && pc.style.display === "block") return;
    for (const h of HINTS) {
        if (seen[h.id] || !h.when(oi)) continue;
        seen[h.id] = 1;
        try { localStorage.setItem(LS, JSON.stringify(seen)); } catch (e) { }
        el.textContent = h.text;
        el.classList.add("on");
        hideAt = now + 7000;
        return;
    }
}
