import { AU_KM, PL, R_SUN, SEC_YEAR } from "../constants.js";
import { PHASE_BOUNDARIES_GYR, sunMaxRadiusReachedRsunAt } from "./sunEvolution.js";

const GYR_SEC = 1e9 * SEC_YEAR;
const ENGULFMENT_TARGETS = [
    { name: "Mercury", aKm: PL[0].a, focus: 0 },
    { name: "Venus", aKm: PL[1].a, focus: 1 },
    { name: "Earth", aKm: AU_KM, focus: "earth" },
    { name: "Mars", aKm: PL[2].a, focus: 2 },
];

const PHASE_EVENTS = Object.freeze([
    Object.freeze({
        id: "sun-ms-end",
        label: "Sun leaves the main sequence",
        tSimSec: PHASE_BOUNDARIES_GYR.msEnd * GYR_SEC,
        focus: "sun",
        tier: "modeled",
    }),
    Object.freeze({
        id: "sun-rgb-tip",
        label: "Sun reaches the red-giant tip",
        tSimSec: PHASE_BOUNDARIES_GYR.rgbTip * GYR_SEC,
        focus: "sun",
        tier: "modeled",
    }),
    Object.freeze({
        id: "sun-agb-tip",
        label: "Sun reaches the AGB tip",
        tSimSec: PHASE_BOUNDARIES_GYR.agbTip * GYR_SEC,
        focus: "sun",
        tier: "modeled",
    }),
    Object.freeze({
        id: "sun-wd-start",
        label: "Sun becomes a white dwarf",
        tSimSec: PHASE_BOUNDARIES_GYR.wdStart * GYR_SEC,
        focus: "sun",
        tier: "modeled",
    }),
]);

let engulfmentCache = null;

export function sunPhaseEvents() {
    return PHASE_EVENTS;
}

export function engulfmentEvents() {
    if (engulfmentCache) return engulfmentCache;
    const endSec = PHASE_BOUNDARIES_GYR.agbTip * GYR_SEC;
    const maximumKm = sunMaxRadiusReachedRsunAt(endSec) * R_SUN;
    const rows = [];
    for (const target of ENGULFMENT_TARGETS) {
        if (maximumKm < target.aKm) continue;
        let lo = 0;
        let hi = endSec;
        for (let i = 0; i < 64; i++) {
            const mid = (lo + hi) * 0.5;
            if (sunMaxRadiusReachedRsunAt(mid) * R_SUN >= target.aKm) hi = mid;
            else lo = mid;
        }
        const earthScenario = target.name === "Earth";
        rows.push(Object.freeze({
            id: "sun-engulfs-" + target.name.toLowerCase(),
            label: earthScenario ? "Sun may engulf Earth" : "Sun engulfs " + target.name,
            tSimSec: hi,
            focus: target.focus,
            tier: "modeled",
            qualifier: earthScenario ? "contingent scenario" : undefined,
            displayTime: earthScenario
                ? "around " + (hi / GYR_SEC).toFixed(1) + " billion years from now · depends on solar mass loss and tidal drag"
                : undefined,
        }));
    }
    rows.sort((a, b) => a.tSimSec - b.tSimSec || a.id.localeCompare(b.id));
    engulfmentCache = Object.freeze(rows);
    return engulfmentCache;
}
