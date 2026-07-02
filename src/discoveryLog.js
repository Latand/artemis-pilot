import { LY_KM } from "./constants.js";
import { G } from "./state.js";
import { getEpochMs, civilDateAt, fmtCivil } from "./epoch.js";
import { clockRateAtShip } from "./relativity.js";
import { toast } from "./achievements.js";
import { fmtMET } from "./format.js";

const MAX_ENTRIES = 500;
const DEFAULT_RECORDS = Object.freeze({ maxDistLy: 0, minClockRate: 1, maxDvUsed: 0 });
const seen = { bodies: new Set(), stars: new Set(), notables: new Set() };
let entries = [];
let records = { ...DEFAULT_RECORDS };
let nextRecordMilestone = { distLy: 1, dvUsed: 1000, clockDrop: 1e-6 };

let panel = null, listEl = null, recordsEl = null, open = false;

function bodyKey(kind, id) { return kind + ":" + id; }
function stamp() {
    return { civil: fmtCivil(civilDateAt(getEpochMs(), G.t)), met: G.t };
}
function pushEntry(kind, id, label, announce = true) {
    const s = stamp();
    entries.push({ kind, id, label, civil: s.civil, met: s.met });
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    if (announce) toast("Logged: " + label);
    rebuildLog();
}
function rebuildMilestones() {
    nextRecordMilestone.distLy = Math.max(1, records.maxDistLy > 0 ? records.maxDistLy * 2 : 1);
    nextRecordMilestone.dvUsed = Math.max(1000, records.maxDvUsed > 0 ? records.maxDvUsed * 2 : 1000);
    nextRecordMilestone.clockDrop = Math.max(1e-12, 1 - records.minClockRate > 0 ? (1 - records.minClockRate) * 2 : 1e-6);
}

export function clearLog() {
    seen.bodies.clear(); seen.stars.clear(); seen.notables.clear();
    entries = [];
    records = { ...DEFAULT_RECORDS };
    rebuildMilestones();
    rebuildLog();
}

export function noteBody(kind, id, label) {
    const key = bodyKey(kind, id);
    if (seen.bodies.has(key)) return false;
    seen.bodies.add(key);
    pushEntry(kind, key, label);
    return true;
}
export function noteStar(id, label) {
    if (!id || seen.stars.has(String(id))) return false;
    seen.stars.add(String(id));
    pushEntry("star", String(id), label || String(id));
    return true;
}
export function noteNotable(tag, label) {
    if (!tag || seen.notables.has(String(tag))) return false;
    seen.notables.add(String(tag));
    pushEntry("notable", String(tag), label || String(tag));
    return true;
}
export function updateRecords() {
    const distLy = Math.max(0, (G.maxRE || 0) / LY_KM);
    const rate = clockRateAtShip().rate;
    const dv = Math.max(0, G.dvUsed || 0);
    if (distLy > records.maxDistLy) {
        records.maxDistLy = distLy;
        if (distLy >= nextRecordMilestone.distLy) {
            pushEntry("record", "distance", "Range record " + distLy.toFixed(distLy < 10 ? 3 : 1) + " ly", false);
            nextRecordMilestone.distLy = Math.max(nextRecordMilestone.distLy * 2, distLy * 2);
        }
    }
    if (Number.isFinite(rate) && rate < records.minClockRate) {
        records.minClockRate = rate;
        const drop = 1 - rate;
        if (drop >= nextRecordMilestone.clockDrop) {
            pushEntry("record", "clock", "Time-dilation record " + (rate * 100).toFixed(6) + "%", false);
            nextRecordMilestone.clockDrop = Math.max(nextRecordMilestone.clockDrop * 2, drop * 2);
        }
    }
    if (dv > records.maxDvUsed) {
        records.maxDvUsed = dv;
        if (dv >= nextRecordMilestone.dvUsed) {
            pushEntry("record", "dv", "Delta-v record " + Math.round(dv).toLocaleString("en-US") + " m/s", false);
            nextRecordMilestone.dvUsed = Math.max(nextRecordMilestone.dvUsed * 2, dv * 2);
        }
    }
    rebuildLog();
}

export function serializeLog() {
    return {
        seen: {
            bodies: Array.from(seen.bodies),
            stars: Array.from(seen.stars),
            notables: Array.from(seen.notables),
        },
        entries: entries.map(e => ({ ...e })),
        records: { ...records },
    };
}
export function restoreLog(data) {
    clearLog();
    if (!data || typeof data !== "object") return;
    for (const k of data.seen?.bodies || []) seen.bodies.add(String(k));
    for (const k of data.seen?.stars || []) seen.stars.add(String(k));
    for (const k of data.seen?.notables || []) seen.notables.add(String(k));
    entries = Array.isArray(data.entries) ? data.entries.slice(-MAX_ENTRIES).map(e => ({
        kind: String(e.kind || "log"),
        id: String(e.id || ""),
        label: String(e.label || ""),
        civil: String(e.civil || ""),
        met: Number(e.met) || 0,
    })) : [];
    records = {
        maxDistLy: Number(data.records?.maxDistLy) || 0,
        minClockRate: Number.isFinite(data.records?.minClockRate) ? data.records.minClockRate : 1,
        maxDvUsed: Number(data.records?.maxDvUsed) || 0,
    };
    rebuildMilestones();
    rebuildLog();
}
export function getEntries() { return entries.map(e => ({ ...e })); }
export function getRecords() { return { ...records }; }

function setOpen(v) {
    open = !!v;
    if (!panel) return;
    panel.classList.toggle("open", open);
    panel.style.display = open ? "block" : "none";
    if (open) rebuildLog();
}
export function toggleLog() { setOpen(!open); }
export function openLog() { setOpen(true); }

function row(e) {
    const d = document.createElement("div");
    d.className = "logItem";
    const b = document.createElement("b");
    b.textContent = e.label || e.id || e.kind;
    const s = document.createElement("span");
    s.textContent = e.kind.toUpperCase() + " · MET " + fmtMET(e.met) + " · " + e.civil;
    d.append(b, s);
    return d;
}
export function rebuildLog() {
    if (!panel || !listEl || !recordsEl) return;
    const r = getRecords();
    recordsEl.textContent = "MAX RANGE " + r.maxDistLy.toFixed(r.maxDistLy < 10 ? 3 : 1) +
        " LY · MIN CLOCK " + (r.minClockRate * 100).toFixed(6) +
        "% · DV " + Math.round(r.maxDvUsed).toLocaleString("en-US") + " M/S";
    listEl.textContent = "";
    const recent = entries.slice().reverse();
    if (!recent.length) {
        const empty = document.createElement("div");
        empty.className = "logEmpty";
        empty.textContent = "NO ENTRIES YET";
        listEl.appendChild(empty);
        return;
    }
    for (const e of recent) listEl.appendChild(row(e));
}
export function initLog() {
    panel = document.getElementById("logPanel");
    listEl = document.getElementById("logList");
    recordsEl = document.getElementById("logRecords");
    if (!panel) return;
    panel.style.display = "none";
    panel.style.position = "fixed";
    panel.style.left = "14px";
    panel.style.bottom = "146px";
    panel.style.width = "340px";
    panel.style.zIndex = "18";
    panel.style.padding = "11px 13px 12px";
    if (listEl) {
        listEl.style.display = "flex";
        listEl.style.flexDirection = "column";
        listEl.style.gap = "4px";
        listEl.style.marginTop = "10px";
        listEl.style.maxHeight = "clamp(170px, 56vh, 460px)";
        listEl.style.overflowY = "auto";
    }
    document.getElementById("logClose")?.addEventListener("click", () => setOpen(false));
    rebuildLog();
}

if (typeof window !== "undefined") window.__discoveryLog = { noteBody, noteStar, noteNotable, updateRecords, serializeLog, restoreLog, clearLog };
