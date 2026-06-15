// "Go to" navigator: a single searchable list of every focusable destination —
// ship, Earth + Moon, Sun, the planets with their moons nested under them, any
// active black holes, and the nearby named stars. Picking a row flies the
// camera there. Replaces the cycle-only focus model (F / ⇧F / U) with direct
// selection, and works the same on desktop and as a mobile bottom sheet.
import { PL, STARS, K } from "./constants.js";
import { MOONS, moonFocusValue } from "./moons.js";
import { BH, G } from "./state.js";
import { fmtKm } from "./format.js";

const $ = id => document.getElementById(id);
const hex = c => "#" + (c >>> 0).toString(16).padStart(6, "0").slice(-6);
// curated named stars (skip the appended HYG physical bulk — that has the catalog search)
const CURATED = STARS.map((s, i) => ({ s, i })).filter(o => o.s.catalog === "nearby-real");

let hooks = { flyTo() {} };
let panel = null, listEl = null, queryEl = null, open = false;

function makeRow(name, sub, focusValue, depth, color) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "navItem" + (depth ? " navItem--sub" : "");
    if (sameFocus(focusValue)) b.classList.add("navItem--active");
    const dot = document.createElement("i");
    dot.className = "navDot";
    if (color) dot.style.background = color;
    const nm = document.createElement("b");
    nm.textContent = name;
    const sb = document.createElement("span");
    sb.textContent = sub;
    b.append(dot, nm, sb);
    b.addEventListener("click", () => { hooks.flyTo(focusValue); setOpen(false); });
    return b;
}

function sameFocus(fv) {
    return G.focus === fv || (typeof fv === "number" && G.focus === fv);
}

function rebuild() {
    if (!listEl) return;
    const f = (queryEl?.value || "").trim().toUpperCase();
    const has = name => !f || name.toUpperCase().includes(f);
    listEl.textContent = "";
    const add = (...a) => listEl.appendChild(makeRow(...a));

    if (has("SHIP")) add("SHIP", "your vehicle", "ship", 0, "#ffd9d1");
    if (has("EARTH")) add("EARTH", "home planet", "earth", 0, "#9fe8ff");
    if (has("MOON")) add("MOON", "Earth's moon", "moon", 1, "#cdd6df");
    if (has("SUN")) add("SUN", "home star", "sun", 0, "#ffe3a8");

    for (let i = 0; i < PL.length; i++) {
        const p = PL[i];
        const moons = MOONS.map((m, mi) => ({ m, mi })).filter(o => o.m.p === i);
        const planetHit = has(p.name);
        const moonHits = moons.filter(o => has(o.m.name));
        if (planetHit || moonHits.length) {
            add(p.name, "planet" + (moons.length ? " · " + moons.length + (moons.length === 1 ? " moon" : " moons") : ""), i, 0, hex(p.color));
            for (const o of (planetHit ? moons : moonHits)) add(o.m.name, p.name + " moon", moonFocusValue(o.mi), 1, hex(o.m.color));
        }
    }

    for (let i = 0; i < BH.n; i++) if (has("BLACK HOLE") || has("BH")) add("BLACK HOLE " + (i + 1), "r_s " + fmtKm(BH.rs[i]), "bh:" + i, 0, "#c9b6ff");

    let starHdr = false;
    for (const o of CURATED) if (has(o.s.name)) {
        if (!starHdr) { const h = document.createElement("div"); h.className = "navSecHdr"; h.textContent = "NEARBY STARS"; listEl.appendChild(h); starHdr = true; }
        add(o.s.name, o.s.dLy.toFixed(o.s.dLy < 100 ? 1 : 0) + " ly" + (o.s.bh ? " · black hole" : ""), "star:" + o.i, 0, hex(o.s.color));
    }
}

function setOpen(v) {
    open = !!v;
    if (!panel) return;
    panel.classList.toggle("open", open);
    if (open) { rebuild(); queryEl?.focus?.(); }
}

export function toggleNavigator() { setOpen(!open); }
export function openNavigator() { setOpen(true); }
export function isNavigatorOpen() { return open; }

export function initNavigator(h) {
    hooks = h || hooks;
    panel = $("navPanel");
    listEl = $("navList");
    queryEl = $("navQuery");
    if (!panel) return;
    $("navClose")?.addEventListener("click", () => setOpen(false));
    $("navBtn")?.addEventListener("click", () => toggleNavigator());
    queryEl?.addEventListener("input", rebuild);
    queryEl?.addEventListener("keydown", e => {
        if (e.key === "Escape") setOpen(false);
        // enter picks the first row
        if (e.key === "Enter") { listEl?.querySelector(".navItem")?.click(); }
    });
    window.addEventListener("keydown", e => {
        if (e.code === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const tag = (e.target?.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea") return;
            e.preventDefault();
            toggleNavigator();
        }
    });
}
