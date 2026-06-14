import { addRuntimeStar, CATALOG_PROMOTION_MAX, INITIAL_STAR_COUNT, LY_KM, R_SUN, STARS } from "./constants.js";
import { loadHygCatalogData, loadHygCatalogMeta } from "./universe/catalogData.js";
import {
    catalogPhysicsUsable, catalogRuntimeRadiusSolar, hygCatalogFocusValue, hygStarByIndex, registerHygCatalog,
} from "./universe/hygActiveCatalog.js";

const PC_LY = 3.261563777;
const PC_KM = LY_KM * PC_LY;
const SOLAR_TEMP_K = 5772;

let hooks = { onPromote: () => { }, onFocusCatalog: () => { }, toast: () => { } };
let ui = null;
let labelMap = null;
let searchTimer = 0;

const SERIAL_STAR_FIELDS = [
    "name", "dLy", "x", "y", "z", "color", "mass", "R", "catalog", "hygIndex",
    "hip", "hd", "hr", "spect", "mag", "absMag", "lumSolar", "tempK", "estimated",
];

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function colorMix(a, b, t) {
    return [
        a[0] * (1 - t) + b[0] * t,
        a[1] * (1 - t) + b[1] * t,
        a[2] * (1 - t) + b[2] * t,
    ];
}

function colorHexFromBV(ci) {
    const bv = Number.isFinite(ci) ? clamp(ci, -0.35, 2.0) : 0.65;
    const t = clamp((bv + .35) / 2.35, 0, 1);
    let c;
    if (t < .34) c = colorMix([.58, .68, 1.0], [.93, .96, 1.0], t / .34);
    else if (t < .58) c = colorMix([.93, .96, 1.0], [1.0, .86, .58], (t - .34) / .24);
    else c = colorMix([1.0, .86, .58], [1.0, .42, .28], (t - .58) / .42);
    const r = Math.round(clamp(c[0], 0, 1) * 255);
    const g = Math.round(clamp(c[1], 0, 1) * 255);
    const b = Math.round(clamp(c[2], 0, 1) * 255);
    return (r << 16) | (g << 8) | b;
}

function norm(v) {
    return String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normKey(v) {
    return String(v || "").toUpperCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
}

const CURATED_ALIAS_TARGETS = new Map([
    ["SIRIUS", "SIRIUS A"],
    ["PROCYON", "PROCYON A"],
    ["RIGIL KENTAURUS", "ALPHA CEN A"],
    ["TOLIMAN", "ALPHA CEN B"],
    ["RAN", "EPSILON ERIDANI"],
    ["BARNARD'S STAR", "BARNARD"],
    ["BARNARDS STAR", "BARNARD"],
    ["VAN MAANEN'S STAR", "VAN MAANEN"],
    ["VAN MAANENS STAR", "VAN MAANEN"],
]);

function canonicalDestinationName(v) {
    const key = normKey(v);
    return CURATED_ALIAS_TARGETS.get(key) || key;
}

function displayName(row, index) {
    return row?.[1] || (row?.[2] ? "HIP " + row[2] : row?.[3] ? "HD " + row[3] : "HYG " + index);
}

function fieldIndex(meta, name, fallback) {
    const i = meta.fields?.indexOf(name) ?? -1;
    return i >= 0 ? i : fallback;
}

function labelText(row) {
    return [
        row[1],
        row[2] && ("hip " + row[2]),
        row[3] && ("hd " + row[3]),
        row[4] && ("hr " + row[4]),
        row[5],
    ].filter(Boolean).join(" ").toLowerCase();
}

export function searchCatalogLabels(meta, query, limit = 8) {
    const q = norm(query);
    if (!q) return [];
    const numeric = q.match(/^#?(\d{1,6})$/);
    if (numeric) {
        const index = Number(numeric[1]);
        if (index >= 0 && index < meta.count) {
            const row = (meta.labels || []).find(r => r[0] === index);
            return [{ index, row, score: 0 }];
        }
    }
    const out = [];
    for (const row of meta.labels || []) {
        const text = labelText(row);
        if (!text.includes(q)) continue;
        const name = norm(row[1]);
        let score = 40;
        if (name === q) score = 0;
        else if (name.startsWith(q)) score = 6;
        else if (text.startsWith(q)) score = 10;
        else score += text.indexOf(q);
        const mag = Number.isFinite(row[10]) ? row[10] : 8;
        out.push({ index: row[0], row, score: score + mag * .25 });
    }
    out.sort((a, b) => a.score - b.score || a.index - b.index);
    return out.slice(0, limit);
}

export function starFromCatalogRecord(meta, vals, index, row = null) {
    const stride = meta.stride || 10;
    const base = index * stride;
    if (index < 0 || index >= meta.count || base + stride > vals.length) throw new Error("catalog index out of range");
    const iX = fieldIndex(meta, "xPc", 0);
    const iY = fieldIndex(meta, "yPc", 1);
    const iZ = fieldIndex(meta, "zPc", 2);
    const iBv = fieldIndex(meta, "bv", 3);
    const iMag = fieldIndex(meta, "mag", 4);
    const iAbsMag = fieldIndex(meta, "absMag", 5);
    const iLum = fieldIndex(meta, "lumSolar", 6);
    const iTemp = fieldIndex(meta, "tempK", 7);
    const iMass = fieldIndex(meta, "massSolar", 8);
    const iRadius = fieldIndex(meta, "radiusSolar", 9);
    const xPc = vals[base + iX], yPc = vals[base + iY], zPc = vals[base + iZ];
    const dPc = Math.hypot(xPc, yPc, zPc);
    const mass = vals[base + iMass];
    const rawRadiusSolar = vals[base + iRadius];
    const lumSolar = vals[base + iLum];
    const spect = row?.[5] || "";
    if (!(dPc > 0) || !catalogPhysicsUsable(mass, rawRadiusSolar, lumSolar, spect)) throw new Error("catalog row lacks usable physical fields");
    const bv = vals[base + iBv];
    const radiusSolar = catalogRuntimeRadiusSolar(mass, rawRadiusSolar, spect);
    return {
        name: displayName(row, index).toUpperCase(),
        dLy: dPc * PC_LY,
        x: xPc * PC_KM,
        y: yPc * PC_KM,
        z: zPc * PC_KM,
        color: colorHexFromBV(bv),
        mass,
        R: radiusSolar * R_SUN,
        catalog: "hyg-v41-promoted",
        hygIndex: index,
        hip: row?.[2] || "",
        hd: row?.[3] || "",
        hr: row?.[4] || "",
        spect,
        mag: vals[base + iMag],
        absMag: vals[base + iAbsMag],
        lumSolar,
        tempK: vals[base + iTemp] || SOLAR_TEMP_K,
        estimated: true,
    };
}

async function loadMeta() {
    const meta = await loadHygCatalogMeta();
    labelMap = new Map((meta.labels || []).map(row => [row[0], row]));
    return meta;
}

async function loadCatalog() {
    const { meta, vals } = await loadHygCatalogData();
    labelMap = new Map((meta.labels || []).map(row => [row[0], row]));
    registerHygCatalog(meta, vals, { deferIndex: true });
    return { meta, vals };
}

function formatLy(v) {
    return v >= 1000 ? (v / 1000).toFixed(1) + " kly" : v.toFixed(v < 100 ? 2 : 1) + " ly";
}

function describeStar(star) {
    const mass = Number.isFinite(star.mass) ? star.mass.toFixed(star.mass < 1 ? 3 : 2) + " M☉" : "";
    const temp = Number.isFinite(star.tempK) ? Math.round(star.tempK).toLocaleString("en-US") + " K" : "";
    return [formatLy(star.dLy), mass, temp, star.spect].filter(Boolean).join(" · ");
}

function sameNamedDestination(a, b) {
    const aa = canonicalDestinationName(a);
    const bb = canonicalDestinationName(b);
    return aa === bb || aa.startsWith(bb + " ") || bb.startsWith(aa + " ");
}

function rowFromStoredStar(star) {
    return [star.hygIndex ?? -1, star.name, star.hip || "", star.hd || "", star.hr || "", star.spect || ""];
}

function storedStar(raw) {
    if (!raw || typeof raw !== "object") return null;
    const star = {};
    for (const field of SERIAL_STAR_FIELDS) if (raw[field] !== undefined) star[field] = raw[field];
    star.name = String(star.name || "").toUpperCase();
    star.catalog = "hyg-v41-promoted";
    star.hygIndex = Number.isFinite(Number(star.hygIndex)) ? Number(star.hygIndex) : -1;
    for (const field of ["dLy", "x", "y", "z", "color", "mass", "R", "mag", "absMag", "lumSolar", "tempK"]) {
        if (star[field] !== undefined) star[field] = Number(star[field]);
    }
    for (const field of ["hip", "hd", "hr", "spect"]) star[field] = String(star[field] || "");
    star.estimated = star.estimated !== false;
    if (!star.name || star.hygIndex < 0) return null;
    if (!(star.dLy > 0) || !(star.mass > 0) || !(star.R > 0)) return null;
    if (!Number.isFinite(star.x) || !Number.isFinite(star.y) || !Number.isFinite(star.z)) return null;
    if (!Number.isFinite(star.color)) return null;
    if (!catalogPhysicsUsable(star.mass, star.R / R_SUN, star.lumSolar, star.spect)) return null;
    return star;
}

export function findExistingCatalogStar(index, row, star) {
    return STARS.findIndex(s => s.hygIndex === index ||
        (row?.[2] && s.hip === row[2]) ||
        (row?.[3] && s.hd === row[3]) ||
        (row?.[4] && s.hr === row[4]) ||
        sameNamedDestination(s.name, star.name));
}

export function serializePromotedCatalogStars() {
    return STARS.slice(INITIAL_STAR_COUNT)
        .filter(star => star.catalog === "hyg-v41-promoted" && Number.isFinite(star.hygIndex))
        .map(star => Object.fromEntries(SERIAL_STAR_FIELDS
            .filter(field => star[field] !== undefined)
            .map(field => [field, star[field]])));
}

export function restorePromotedCatalogStars(rows = []) {
    const restored = [];
    for (const raw of rows || []) {
        const star = storedStar(raw);
        if (!star) continue;
        const row = rowFromStoredStar(star);
        const existing = findExistingCatalogStar(star.hygIndex, row, star);
        if (existing >= 0) {
            hooks.onPromote(existing, STARS[existing], true, "restore");
            restored.push(existing);
            continue;
        }
        try {
            const starIndex = addRuntimeStar(star);
            hooks.onPromote(starIndex, star, false, "restore");
            restored.push(starIndex);
        } catch (err) {
            hooks.toast(err?.message || String(err));
            break;
        }
    }
    return restored;
}

function setOpen(open) {
    if (!ui) return;
    ui.panel.style.display = open ? "block" : "none";
}

function renderMessage(text) {
    if (!ui) return;
    ui.results.innerHTML = "";
    const div = document.createElement("div");
    div.className = "hygEmpty";
    div.textContent = text;
    ui.results.appendChild(div);
}

async function promoteIndex(index) {
    const { meta, vals } = await loadCatalog();
    const row = labelMap?.get(index) || null;
    const star = starFromCatalogRecord(meta, vals, index, row);
    const existing = findExistingCatalogStar(index, row, star);
    if (existing >= 0) {
        hooks.onPromote(existing, STARS[existing], true, "focus");
        setOpen(false);
        return existing;
    }
    const starIndex = addRuntimeStar(star);
    hooks.onPromote(starIndex, star, false, "promote");
    setOpen(false);
    return starIndex;
}

async function focusCatalogIndex(index) {
    const { meta, vals } = await loadCatalog();
    const row = labelMap?.get(index) || null;
    const star = starFromCatalogRecord(meta, vals, index, row);
    const existing = findExistingCatalogStar(index, row, star);
    if (existing >= 0) {
        hooks.onPromote(existing, STARS[existing], true, "focus");
        setOpen(false);
        return { existing: true, promotedIndex: existing, star: STARS[existing], focus: "" };
    }
    const activeStar = hygStarByIndex(index);
    if (!activeStar) throw new Error("catalog row is unavailable for direct focus");
    const focus = hygCatalogFocusValue(index);
    hooks.onFocusCatalog(index, activeStar, "focus");
    setOpen(false);
    return { existing: false, index, star: activeStar, focus };
}

async function renderResults() {
    if (!ui) return;
    const query = ui.input.value;
    if (!query.trim()) {
        renderMessage("TYPE NAME / HIP / HD / HR / INDEX");
        return;
    }
    renderMessage("LOADING HYG CATALOG");
    try {
        const { meta, vals } = await loadCatalog();
        const matches = searchCatalogLabels(meta, query, 8);
        ui.results.innerHTML = "";
        if (!matches.length) {
            renderMessage("NO MATCH");
            return;
        }
        for (const match of matches) {
            const star = starFromCatalogRecord(meta, vals, match.index, match.row || labelMap?.get(match.index));
            const btn = document.createElement("button");
            btn.className = "hygResult";
            btn.type = "button";
            const name = document.createElement("strong");
            name.textContent = star.name;
            const details = document.createElement("span");
            details.textContent = describeStar(star);
            btn.append(name, details);
            btn.onclick = () => focusCatalogIndex(match.index).catch(err => hooks.toast(err?.message || String(err)));
            ui.results.appendChild(btn);
        }
    } catch (err) {
        renderMessage("CATALOG UNAVAILABLE");
        hooks.toast(err?.message || String(err));
    }
}

export function openCatalogSearch(seed = "") {
    if (!ui) return;
    setOpen(true);
    if (seed) ui.input.value = seed;
    ui.input.focus();
    renderResults();
}

export function closeCatalogSearch() {
    setOpen(false);
}

export async function promoteCatalogQuery(query) {
    const { meta } = await loadCatalog();
    const match = searchCatalogLabels(meta, query, 1)[0];
    if (!match) throw new Error("catalog star not found");
    return promoteIndex(match.index);
}

export async function focusCatalogQuery(query) {
    const { meta } = await loadCatalog();
    const match = searchCatalogLabels(meta, query, 1)[0];
    if (!match) throw new Error("catalog star not found");
    return focusCatalogIndex(match.index);
}

export function initCatalogSearch(options = {}) {
    hooks = { ...hooks, ...options };
    ui = {
        panel: document.getElementById("hygSearch"),
        input: document.getElementById("hygQuery"),
        results: document.getElementById("hygResults"),
        close: document.getElementById("hygClose"),
    };
    if (!ui.panel || !ui.input || !ui.results) return;
    ui.input.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => renderResults(), 90);
    });
    ui.input.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.code === "Escape") closeCatalogSearch();
        if (e.code === "Enter") {
            focusCatalogQuery(ui.input.value).catch(err => hooks.toast(err?.message || String(err)));
        }
    });
    if (ui.close) ui.close.onclick = closeCatalogSearch;
    const urlQuery = new URLSearchParams(location.search).get("hyg");
    if (urlQuery) {
        focusCatalogQuery(urlQuery)
            .catch(err => hooks.toast(err?.message || String(err)));
    }
}

export function promotedCatalogCount() {
    return Math.max(0, STARS.length - INITIAL_STAR_COUNT);
}

export function promotionSlotsLeft() {
    return Math.max(0, CATALOG_PROMOTION_MAX - promotedCatalogCount());
}
