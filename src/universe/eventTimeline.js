import {
    AU_KM,
    PL,
    SEC_YEAR,
    WARPS,
    WARP_MAX,
} from "../constants.js";
import { meanElementsAt, tableKeyForPlanet } from "./planetElements.js";
import { epochOffsetSeconds, meanAnomalyAdvance } from "../epoch.js";
import { resolveJumpFrameDelivery } from "./jumpFrame.js";
import { engulfmentEvents, sunPhaseEvents } from "./sunTimeline.js";

const GYR_SEC = 1e9 * SEC_YEAR;
export const JUMP_HOLD_WARP = 1e6 * SEC_YEAR;
export const JUMP_LEAD_SEC = 1e7 * SEC_YEAR;
export const CRUISE_WALL_S = 6;
export const RUNG_WALL_S = 0.7;

const FIRST_LADDER_RUNG = WARPS.indexOf(1);
const GHOST_REASON = "deep time blocked: absorbed matter's gravity ghosts force step-by-step physics";
const TWO_PI = 2 * Math.PI;
const GOLDEN_TOLERANCE_SEC = 3600;
const DEFAULT_SCAN_SAMPLE_BUDGET = 256;
// Deep-time guards. Every refinement loop terminates on an ulp-aware
// tolerance AND a hard iteration cap: at |t| >= 2^64 s the spacing of
// float64 seconds exceeds GOLDEN_TOLERANCE_SEC, so `right - left > 3600`
// could never become false and the idle prediction scheduler hung the app.
// Scans additionally run in local time (offsets from the scan epoch, with the
// conics re-phased to that epoch), so they never evaluate phase + n*t at a
// huge t, where the mean anomaly itself has lost all precision.
export const REFINE_MAX_ITERATIONS = 200;
export const LEAD_SCAN_MAX_STEPS = 4096;
// Diagnostics for smokes: the largest iteration count any refinement loop
// needed, and how often a loop stopped at its cap instead of its tolerance.
export const REFINE_STATS = { maxIterations: 0, maxLeadSteps: 0, capped: 0 };
function noteRefine(iterations, cap) {
    if (iterations > REFINE_STATS.maxIterations) REFINE_STATS.maxIterations = iterations;
    if (iterations > cap) REFINE_STATS.capped++;
}
function noteLeadSteps(steps) {
    if (steps > REFINE_STATS.maxLeadSteps) REFINE_STATS.maxLeadSteps = steps;
    if (steps > LEAD_SCAN_MAX_STEPS) REFINE_STATS.capped++;
}
const _ulpView = new DataView(new ArrayBuffer(8));
// Spacing of float64 values at |x| (the gap to the next representable one).
export function ulp(x) {
    const ax = Math.abs(x);
    if (!Number.isFinite(ax)) return Infinity;
    _ulpView.setFloat64(0, ax);
    const exponent = (_ulpView.getUint32(0) >>> 20) & 0x7ff;
    return exponent === 0 ? Number.MIN_VALUE : Math.pow(2, exponent - 1075);
}
function timeTolerance(a, b) {
    return Math.max(GOLDEN_TOLERANCE_SEC, 8 * ulp(Math.max(Math.abs(a), Math.abs(b))));
}
// Dekker/Veltkamp exact product: a*b === hi + lo exactly (barring overflow).
const SPLITTER = 134217729; // 2^27 + 1
function twoProductLo(a, b, hi) {
    const ca = SPLITTER * a, ah = ca - (ca - a), al = a - ah;
    const cb = SPLITTER * b, bh = cb - (cb - b), bl = b - bh;
    return ((ah * bh - hi) + ah * bl + al * bh) + al * bl;
}
// The body's mean anomaly at `epochSec`, phase + n*epoch, reduced modulo its
// period in TIME (t - q*P with q*P formed exactly) so the result keeps full
// precision at any epoch instead of the ~0.1 rad noise of a direct n*t at
// 1e21 s. Deterministic and smooth in the epoch.
function phaseAtEpoch(body, epochSec) {
    if (epochSec === 0) return body.phase;
    const period = TWO_PI / body.n;
    const q = Math.round(epochSec / period);
    const qpHi = q * period;
    const qpLo = twoProductLo(q, period, qpHi);
    const remainder = (epochSec - qpHi) - qpLo;
    const phase = body.phase + body.n * remainder;
    return phase - TWO_PI * Math.round(phase / TWO_PI);
}
// A copy of `body` whose conic is re-phased so that local time 0 is epochSec.
function rebasedBody(body, epochSec) {
    if (epochSec === 0) return body;
    return Object.freeze({ ...body, phase: phaseAtEpoch(body, epochSec) });
}
const PHYSICAL_PLANET_ORDER = Object.freeze([
    "MERCURY",
    "VENUS",
    "EARTH",
    "MARS",
    "JUPITER",
    "SATURN",
    "URANUS",
    "NEPTUNE",
]);

function conicPosition(body, tSec) {
    const meanAnomaly = Math.atan2(
        Math.sin(body.phase + body.n * tSec),
        Math.cos(body.phase + body.n * tSec),
    );
    let eccentricAnomaly = meanAnomaly;
    for (let i = 0; i < 8; i++) {
        eccentricAnomaly -= (
            eccentricAnomaly - body.e * Math.sin(eccentricAnomaly) - meanAnomaly
        ) / (1 - body.e * Math.cos(eccentricAnomaly));
    }
    const xOrbit = body.a * (Math.cos(eccentricAnomaly) - body.e);
    const yOrbit = body.a * Math.sqrt(1 - body.e * body.e) * Math.sin(eccentricAnomaly);
    const cosVarpi = Math.cos(body.varpi);
    const sinVarpi = Math.sin(body.varpi);
    return {
        x: xOrbit * cosVarpi - yOrbit * sinVarpi,
        y: xOrbit * sinVarpi + yOrbit * cosVarpi,
    };
}

export function pairDistanceAt(bodyA, bodyB, tSec) {
    const a = conicPosition(bodyA, tSec);
    const b = conicPosition(bodyB, tSec);
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizedBody(body) {
    const normalized = {
        name: String(body?.name || "BODY").toUpperCase(),
        a: Number(body?.a),
        e: Number(body?.e),
        varpi: Number(body?.varpi),
        phase: Number(body?.phase),
        n: Number(body?.n),
    };
    if (!(normalized.a > 0) || !(normalized.e >= 0 && normalized.e < 1) ||
        !Number.isFinite(normalized.varpi) || !Number.isFinite(normalized.phase) || !(normalized.n > 0)) {
        throw new TypeError("close-approach bodies require finite elliptical elements");
    }
    return Object.freeze(normalized);
}

// Analytic conics for close-approach predictions, seeded from the same JPL
// J2000 mean elements (planetElements.js) as ephemeris.js resetEphem, with
// the tabulated mean motions, so predictions and the live n-body sky agree.
function defaultElements() {
    const epochOffsetSec = epochOffsetSeconds();
    const elements = PL.map(planet => {
        const key = tableKeyForPlanet(planet.name);
        if (!key) {
            return normalizedBody({
                ...planet,
                phase: meanAnomalyAdvance(epochOffsetSec, TWO_PI / planet.n),
            });
        }
        const el = meanElementsAt(key, epochOffsetSec, AU_KM);
        return normalizedBody({ name: planet.name, a: el.a, e: el.e, varpi: el.varpi, phase: el.M, n: el.n });
    });
    const emb = meanElementsAt("EMB", epochOffsetSec, AU_KM);
    elements.push(normalizedBody({
        name: "EARTH",
        a: emb.a,
        e: emb.e,
        varpi: emb.varpi,
        phase: emb.M,
        n: emb.n,
    }));
    return elements;
}

function normalizedPairs(pairs, bodies) {
    const bodyCount = bodies.length;
    const source = pairs || Array.from({ length: bodyCount }, (_, i) =>
        Array.from({ length: bodyCount - i - 1 }, (__, offset) => [i, i + offset + 1])
    ).flat();
    const unique = new Map();
    for (const pair of source) {
        const first = Number(pair?.[0]);
        const second = Number(pair?.[1]);
        if (!Number.isInteger(first) || !Number.isInteger(second) || first === second ||
            first < 0 || second < 0 || first >= bodyCount || second >= bodyCount) {
            throw new TypeError("close-approach pairs require two distinct body indices");
        }
        const low = Math.min(first, second);
        const high = Math.max(first, second);
        const firstBody = bodies[first];
        const secondBody = bodies[second];
        const bodyOrder = firstBody.a - secondBody.a ||
            firstBody.name.localeCompare(secondBody.name) || first - second;
        if (!unique.has(low + ":" + high)) {
            unique.set(low + ":" + high, bodyOrder <= 0 ? [first, second] : [second, first]);
        }
    }
    return [...unique.values()];
}

function minimumPossibleDistance(bodyA, bodyB) {
    const inner = bodyA.a <= bodyB.a ? bodyA : bodyB;
    const outer = inner === bodyA ? bodyB : bodyA;
    return Math.max(0, outer.a * (1 - outer.e) - inner.a * (1 + inner.e));
}

function refineMinimum(bodyA, bodyB, leftSec, rightSec) {
    const ratio = (Math.sqrt(5) - 1) / 2;
    let left = leftSec;
    let right = rightSec;
    let innerLeft = right - ratio * (right - left);
    let innerRight = left + ratio * (right - left);
    let leftDistance = pairDistanceAt(bodyA, bodyB, innerLeft);
    let rightDistance = pairDistanceAt(bodyA, bodyB, innerRight);
    const tolerance = timeTolerance(left, right);
    let iterations = 0;
    while (right - left > tolerance && iterations++ < REFINE_MAX_ITERATIONS) {
        if (leftDistance <= rightDistance) {
            right = innerRight;
            innerRight = innerLeft;
            rightDistance = leftDistance;
            innerLeft = right - ratio * (right - left);
            leftDistance = pairDistanceAt(bodyA, bodyB, innerLeft);
        } else {
            left = innerLeft;
            innerLeft = innerRight;
            leftDistance = rightDistance;
            innerRight = left + ratio * (right - left);
            rightDistance = pairDistanceAt(bodyA, bodyB, innerRight);
        }
    }
    noteRefine(iterations, REFINE_MAX_ITERATIONS);
    const tSimSec = (left + right) / 2;
    return { tSimSec, distKm: pairDistanceAt(bodyA, bodyB, tSimSec) };
}

function approachId(bodyA, bodyB, tSimSec) {
    const pairName = [bodyA.name, bodyB.name]
        .map(name => name.toLowerCase().replace(/[^a-z0-9]+/g, "-"))
        .join("-");
    const relativeLongitude = bodyA.phase + bodyA.varpi - bodyB.phase - bodyB.varpi +
        (bodyA.n - bodyB.n) * tSimSec;
    return "approach:" + pairName + ":" + Math.round(relativeLongitude / TWO_PI);
}

// Scans run in local time: [0, spanSec] from the epoch fromSec, on conics
// re-phased to that epoch (rebasedBody). Rows report absolute sim time.
function createPairScan(bodyA, bodyB, pair, fromSec, spanSec, threshold) {
    const localA = rebasedBody(bodyA, fromSec);
    const localB = rebasedBody(bodyB, fromSec);
    const coarseSec = Math.min(TWO_PI / bodyA.n, TWO_PI / bodyB.n) / 64;
    const leftSec = -2 * coarseSec;
    const centerSec = -coarseSec;
    return {
        bodyA,
        bodyB,
        localA,
        localB,
        pair,
        epochSec: fromSec,
        fromSec: 0,
        endSec: spanSec,
        threshold,
        coarseSec,
        leftSec,
        centerSec,
        leftDistance: pairDistanceAt(localA, localB, leftSec),
        centerDistance: pairDistanceAt(localA, localB, centerSec),
        rowsById: new Map(),
    };
}

function stepPairScan(scan, sampleBudget) {
    let samples = 0;
    while (samples < sampleBudget && scan.centerSec <= scan.endSec + scan.coarseSec) {
        const rightSec = scan.centerSec + scan.coarseSec;
        if (!(rightSec > scan.centerSec)) { // cannot progress: finish instead of spinning
            scan.centerSec = Infinity;
            break;
        }
        const bodyA = scan.bodyA;
        const bodyB = scan.bodyB;
        const rightDistance = pairDistanceAt(scan.localA, scan.localB, rightSec);
        if (scan.centerDistance <= scan.leftDistance && scan.centerDistance <= rightDistance &&
            (scan.centerDistance < scan.leftDistance || scan.centerDistance < rightDistance)) {
            const refined = refineMinimum(scan.localA, scan.localB, scan.leftSec, rightSec);
            if (refined.tSimSec >= scan.fromSec && refined.tSimSec <= scan.endSec &&
                refined.distKm <= scan.threshold) {
                const tSimSec = scan.epochSec + refined.tSimSec;
                const id = approachId(bodyA, bodyB, tSimSec);
                const previous = scan.rowsById.get(id);
                if (!previous || refined.distKm < previous.distKm) {
                    scan.rowsById.set(id, Object.freeze({
                        id,
                        label: bodyA.name + "–" + bodyB.name + " close approach · " +
                            (refined.distKm / AU_KM).toFixed(3) + " AU (two-body estimate)",
                        tier: "modeled",
                        tSimSec,
                        distKm: refined.distKm,
                        pair: Object.freeze([bodyA, bodyB]),
                        pairIndices: Object.freeze(scan.pair.slice()),
                    }));
                }
            }
        }
        scan.leftSec = scan.centerSec;
        scan.leftDistance = scan.centerDistance;
        scan.centerSec = rightSec;
        scan.centerDistance = rightDistance;
        samples++;
    }
    return samples;
}

const SUPPRESSED_APPROACHES = Object.freeze({ suppressed: true });

function sortedApproachRows(rows) {
    rows.sort((a, b) => a.tSimSec - b.tSimSec || a.id.localeCompare(b.id));
    return Object.freeze(rows);
}

export function createCloseApproachScan(options = {}) {
    if (options.perturbed) {
        return Object.freeze({
            done: true,
            step() { return true; },
            result() { return SUPPRESSED_APPROACHES; },
        });
    }

    const elements = options.bodies ? options.bodies.map(normalizedBody) : defaultElements();
    const selectedPairs = normalizedPairs(options.pairs, elements);
    const fromSec = Number(options.fromSec ?? 0);
    const spanSec = Number(options.spanSec ?? 0);
    const threshold = options.threshold;
    const rows = [];
    let pairIndex = 0;
    let pairScan = null;
    let completedRows = null;
    let lastStepSamples = 0;
    const scan = {
        get done() { return pairIndex >= selectedPairs.length && pairScan === null; },
        get lastStepSamples() { return lastStepSamples; },
        step(sampleBudget = DEFAULT_SCAN_SAMPLE_BUDGET) {
            lastStepSamples = 0;
            if (scan.done) return true;
            const budget = Number.isFinite(sampleBudget)
                ? Math.max(1, Math.floor(sampleBudget))
                : DEFAULT_SCAN_SAMPLE_BUDGET;
            if (!pairScan) {
                const pair = selectedPairs[pairIndex];
                const bodyA = elements[pair[0]];
                const bodyB = elements[pair[1]];
                const pairThreshold = threshold === undefined
                    ? 1.2 * minimumPossibleDistance(bodyA, bodyB)
                    : Number(threshold);
                pairScan = createPairScan(bodyA, bodyB, pair, fromSec, spanSec, pairThreshold);
            }
            lastStepSamples = stepPairScan(pairScan, budget);
            if (pairScan.centerSec > pairScan.endSec + pairScan.coarseSec) {
                rows.push(...pairScan.rowsById.values());
                pairIndex++;
                pairScan = null;
            }
            return scan.done;
        },
        result() {
            if (!scan.done) return null;
            if (!completedRows) completedRows = sortedApproachRows(rows);
            return completedRows;
        },
    };
    return scan;
}

export function closeApproaches(options = {}) {
    const scan = createCloseApproachScan(options);
    while (!scan.done) scan.step();
    return scan.result();
}

export function nextConjunction({ fromSec = 0, spanSec = 3 * SEC_YEAR, bodies } = {}) {
    const elements = bodies ? bodies.map(normalizedBody) : defaultElements();
    const indexByName = new Map(elements.map((body, index) => [body.name, index]));
    const pairs = [];
    for (let i = 1; i < PHYSICAL_PLANET_ORDER.length; i++) {
        const innerIndex = indexByName.get(PHYSICAL_PLANET_ORDER[i - 1]);
        const outerIndex = indexByName.get(PHYSICAL_PLANET_ORDER[i]);
        if (innerIndex !== undefined && outerIndex !== undefined) pairs.push([innerIndex, outerIndex]);
    }
    const rows = closeApproaches({
        fromSec,
        spanSec,
        pairs,
        threshold: Infinity,
        bodies: elements,
    });
    const approach = rows[0];
    if (!approach) return null;
    const days = Math.max(1, Math.round((approach.tSimSec - fromSec) / 86400));
    return Object.freeze({
        ...approach,
        id: "now:" + approach.id,
        label: "NOW · next conjunction: " + approach.pair[0].name + "–" + approach.pair[1].name +
            " in " + days + " d (two-body estimate)",
    });
}

function approachClosingLead(row) {
    const bodyA = row?.pair?.[0];
    const bodyB = row?.pair?.[1];
    const minimumSec = Number(row?.tSimSec);
    const minimumKm = Number(row?.distKm);
    if (!bodyA || !bodyB || !Number.isFinite(minimumSec) || !(minimumKm > 0)) return 0;

    const targetKm = 3 * minimumKm;
    const stepSec = Math.min(TWO_PI / bodyA.n, TWO_PI / bodyB.n) / 64;
    const relativeRate = Math.abs(bodyA.n - bodyB.n);
    const searchSpanSec = relativeRate > 0
        ? TWO_PI / relativeRate
        : Math.max(TWO_PI / bodyA.n, TWO_PI / bodyB.n);
    // local time around the minimum (re-phased conics), so the backward
    // walk and the bisection stay exact however late the minimum is
    const localA = rebasedBody(bodyA, minimumSec);
    const localB = rebasedBody(bodyB, minimumSec);
    let laterSec = 0;
    let earlierSec = -stepSec;
    const limitSec = -searchSpanSec;
    let steps = 0;
    while (earlierSec >= limitSec - stepSec && steps++ < LEAD_SCAN_MAX_STEPS) {
        const distanceKm = pairDistanceAt(localA, localB, earlierSec);
        if (distanceKm >= targetKm) {
            let outsideSec = earlierSec;
            let insideSec = laterSec;
            const tolerance = timeTolerance(outsideSec, insideSec);
            let iterations = 0;
            while (insideSec - outsideSec > tolerance && iterations++ < REFINE_MAX_ITERATIONS) {
                const middleSec = (outsideSec + insideSec) / 2;
                if (pairDistanceAt(localA, localB, middleSec) >= targetKm) outsideSec = middleSec;
                else insideSec = middleSec;
            }
            noteRefine(iterations, REFINE_MAX_ITERATIONS);
            noteLeadSteps(steps);
            return -(outsideSec + insideSec) / 2;
        }
        laterSec = earlierSec;
        earlierSec -= stepSec;
    }
    noteLeadSteps(steps);
    return 0;
}

function holdWarpForLead(leadSec) {
    let bestWarp = WARPS[0];
    let bestError = Infinity;
    for (const warp of WARPS) {
        if (!(warp > 0) || warp > WARP_MAX) continue;
        const error = Math.abs(leadSec / warp - 8);
        if (error < bestError) {
            bestError = error;
            bestWarp = warp;
        }
    }
    return bestWarp;
}

export function predictedLead(row) {
    const leadSec = Math.max(30 * 86400, approachClosingLead(row));
    return Object.freeze({ leadSec, holdWarp: holdWarpForLead(leadSec) });
}

function mergerRows(merger) {
    if (!merger) return [];
    const uncertainty = "modeled scenario; the real encounter is uncertain — Sawala et al. 2025";
    return [
        {
            id: "m31-first-passage",
            label: "MW–M31 first passage (" + uncertainty + ")",
            tSimSec: merger.firstPassageGyr * GYR_SEC,
            focus: "m31",
            tier: "modeled",
            qualifier: "contingent scenario",
        },
        {
            id: "m31-merger-scenario",
            label: "MW–M31 coalescence (" + uncertainty + ")",
            tSimSec: merger.mergedGyr * GYR_SEC,
            focus: "m31",
            tier: "modeled",
            qualifier: "contingent scenario",
        },
    ].filter(row => Number.isFinite(row.tSimSec));
}

export function buildTimeline({ nowSec = 0, merger } = {}) {
    void nowSec;
    return [...sunPhaseEvents(), ...engulfmentEvents(), ...mergerRows(merger)]
        .sort((a, b) => a.tSimSec - b.tSimSec || a.id.localeCompare(b.id));
}

export function maxFeasibleWarpScalar(gsCount = 0, landed = false, dead = false, bhN = 0) {
    void bhN;
    if (dead) return 0;
    if (gsCount > 0 || landed) return Math.min(600, WARP_MAX);
    return WARP_MAX;
}

export function maxFeasibleWarp({ gsCount = 0, landed = false, dead = false, bhN = 0 } = {}) {
    return maxFeasibleWarpScalar(gsCount, landed, dead, bhN);
}

export function pickJumpWarp(spanSec, feas) {
    if (!(spanSec > 0) || !(feas > 0)) return 0;
    const required = spanSec / CRUISE_WALL_S;
    for (const warp of WARPS) {
        if (warp >= required) return Math.min(warp, feas);
        if (warp >= feas) return feas;
    }
    return Math.min(WARP_MAX, feas);
}

function shortJumpPlan(nowSec, targetSec, feas, preferredHoldWarp = JUMP_HOLD_WARP) {
    const remaining = targetSec - nowSec;
    let warp = Math.min(preferredHoldWarp, feas);
    if (remaining / warp < 1) {
        warp = WARPS[0];
        for (const rung of WARPS) {
            if (rung > feas || rung > remaining) break;
            warp = rung;
        }
    }
    return {
        ok: true,
        targetSec,
        legs: [{ kind: "hold", warp, fromSimT: nowSec, toSimT: targetSec, wallSec: remaining / warp }],
        holdWarp: warp,
        etaWallSec: remaining / warp,
    };
}

function enforceCappedJumpEta(plan, feas) {
    if (feas <= 600 && plan.etaWallSec > 60) return { ok: false, reason: GHOST_REASON };
    return plan;
}

export function planJump(nowSec, targetSec, feas, options = undefined) {
    if (!Number.isFinite(nowSec) || !Number.isFinite(targetSec) || !(targetSec > nowSec)) {
        return { ok: false, reason: "jump target must be in the future" };
    }
    if (!(feas > 0)) return { ok: false, reason: "jump unavailable while the vehicle is lost" };
    const leadSec = Number.isFinite(options?.leadSec) && options.leadSec > 0
        ? options.leadSec
        : JUMP_LEAD_SEC;
    const preferredHoldWarp = WARPS.includes(options?.holdWarp) && options.holdWarp > 0
        ? options.holdWarp
        : JUMP_HOLD_WARP;
    const span = targetSec - leadSec - nowSec;
    if (span <= 0) {
        return enforceCappedJumpEta(shortJumpPlan(nowSec, targetSec, feas, preferredHoldWarp), feas);
    }

    const cruiseWarp = pickJumpWarp(span, feas);
    const cruiseEnd = targetSec - leadSec;
    const legs = [];
    let cursor = nowSec;
    let etaWallSec = 0;
    const cruiseIndex = WARPS.indexOf(cruiseWarp);
    const lastRung = cruiseIndex >= 0 ? cruiseIndex : WARPS.findIndex(warp => warp >= cruiseWarp);
    for (let i = Math.max(0, FIRST_LADDER_RUNG); i <= lastRung && cursor < cruiseEnd; i++) {
        const warp = Math.min(WARPS[i], cruiseWarp);
        const toSimT = Math.min(cruiseEnd, cursor + warp * RUNG_WALL_S);
        if (!(toSimT > cursor)) continue;
        const wallSec = (toSimT - cursor) / warp;
        legs.push({ kind: "rung", warp, fromSimT: cursor, toSimT, wallSec });
        cursor = toSimT;
        etaWallSec += wallSec;
    }
    if (cursor < cruiseEnd) {
        const wallSec = (cruiseEnd - cursor) / cruiseWarp;
        legs.push({ kind: "cruise", warp: cruiseWarp, fromSimT: cursor, toSimT: cruiseEnd, wallSec });
        cursor = cruiseEnd;
        etaWallSec += wallSec;
    }
    const holdWarp = Math.min(preferredHoldWarp, feas);
    const holdWallSec = (targetSec - cursor) / holdWarp;
    legs.push({ kind: "hold", warp: holdWarp, fromSimT: cursor, toSimT: targetSec, wallSec: holdWallSec });
    etaWallSec += holdWallSec;
    return enforceCappedJumpEta({ ok: true, targetSec, legs, holdWarp, etaWallSec }, feas);
}

function nearlyEqual(a, b) {
    return Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 1e-12;
}

function validJumpPlan(plan, { simTimeSec, feasibleWarp } = {}) {
    if (!plan || plan.ok !== true || !Number.isFinite(plan.targetSec) ||
        !Number.isFinite(plan.etaWallSec) || plan.etaWallSec < 0 ||
        !Number.isFinite(plan.holdWarp) || plan.holdWarp <= 0 ||
        !Array.isArray(plan.legs) || !plan.legs.length) return false;

    const validateLiveOrigin = Number.isFinite(simTimeSec);
    const validateFeasibility = Number.isFinite(feasibleWarp);
    if (!WARPS.includes(plan.holdWarp) || plan.holdWarp > WARP_MAX ||
        (validateFeasibility && (!(feasibleWarp > 0) || plan.holdWarp > feasibleWarp)) ||
        (validateLiveOrigin && !(plan.targetSec > simTimeSec)) ||
        (validateFeasibility && feasibleWarp <= 600 && plan.etaWallSec > 60)) return false;

    let previousToSimT = null;
    let totalWallSec = 0;
    let sawCruise = false;
    let lastRungWarp = null;
    for (let i = 0; i < plan.legs.length; i++) {
        const leg = plan.legs[i];
        if (!leg || (leg.kind !== "rung" && leg.kind !== "cruise" && leg.kind !== "hold") ||
            !Number.isFinite(leg.warp) || leg.warp <= 0 || leg.warp > WARP_MAX || !WARPS.includes(leg.warp) ||
            (validateFeasibility && leg.warp > feasibleWarp) ||
            !Number.isFinite(leg.fromSimT) || !Number.isFinite(leg.toSimT) || leg.toSimT <= leg.fromSimT ||
            !Number.isFinite(leg.wallSec) || leg.wallSec < 0) return false;
        if (i === 0 && validateLiveOrigin && leg.fromSimT !== simTimeSec) return false;
        if (leg.kind === "rung") {
            if (sawCruise || (lastRungWarp !== null && leg.warp < lastRungWarp)) return false;
            lastRungWarp = leg.warp;
        }
        if (leg.kind === "cruise") {
            if (sawCruise || (lastRungWarp !== null && leg.warp !== lastRungWarp)) return false;
            sawCruise = true;
        }
        if (leg.kind === "hold" && i !== plan.legs.length - 1) return false;
        if (previousToSimT !== null && leg.fromSimT !== previousToSimT) return false;
        if (!nearlyEqual(leg.wallSec, (leg.toSimT - leg.fromSimT) / leg.warp)) return false;
        previousToSimT = leg.toSimT;
        totalWallSec += leg.wallSec;
    }

    const lastLeg = plan.legs[plan.legs.length - 1];
    return lastLeg.kind === "hold" && lastLeg.warp === plan.holdWarp &&
        lastLeg.toSimT === plan.targetSec && nearlyEqual(totalWallSec, plan.etaWallSec);
}

function snapshotJumpPlan(plan) {
    const sourceLegs = Array.isArray(plan?.legs) ? plan.legs : [];
    const legs = new Array(sourceLegs.length);
    for (let i = 0; i < sourceLegs.length; i++) {
        const leg = sourceLegs[i];
        legs[i] = Object.freeze({
            kind: leg?.kind,
            warp: leg?.warp,
            fromSimT: leg?.fromSimT,
            toSimT: leg?.toSimT,
            wallSec: leg?.wallSec,
        });
    }
    Object.freeze(legs);
    return Object.freeze({
        ok: plan?.ok,
        targetSec: plan?.targetSec,
        etaWallSec: plan?.etaWallSec,
        holdWarp: plan?.holdWarp,
        legs,
    });
}

export function safeJumpRestoreWarp(value, feasibleWarp = WARP_MAX) {
    const feasibility = Number(feasibleWarp);
    if (Number.isFinite(feasibility) && feasibility <= 0) return WARPS[0];
    const limit = Number.isFinite(feasibility) && feasibility > 0
        ? Math.min(WARP_MAX, feasibility)
        : 1;
    const requested = Number(value);
    const ceiling = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, limit)
        : Math.min(1, limit);
    let safe = WARPS[0];
    for (let i = 0; i < WARPS.length && WARPS[i] <= ceiling; i++) safe = WARPS[i];
    return safe;
}

export function createJumpRuntime(plan, meta = {}, {
    currentWarp = 0,
    tdeInProgress = false,
    simTimeSec,
    feasibleWarp,
} = {}) {
    const runtimePlan = snapshotJumpPlan(plan);
    return {
        active: true,
        validPlan: validJumpPlan(runtimePlan, { simTimeSec, feasibleWarp }),
        plan: runtimePlan,
        meta,
        legIndex: 0,
        legWallSec: 0,
        elapsedWallSec: 0,
        physicsWallRate: 1,
        advanceDebtSec: 0,
        tdeAtStart: !!tdeInProgress,
        restoreWarp: safeJumpRestoreWarp(currentWarp, feasibleWarp),
        expectedWarp: currentWarp,
        pending: false,
        pendingWallDeltaSec: 0,
        pendingWarp: 0,
        delivery: {
            requestedAdvanceSec: 0,
            deliveredAdvanceSec: 0,
            fullyDelivered: false,
            syncTimeSec: NaN,
            postSimTimeSec: NaN,
        },
        result: {
            kind: "run",
            warp: currentWarp,
            etaWallSec: Number.isFinite(runtimePlan.etaWallSec) ? runtimePlan.etaWallSec : 0,
            advanceSec: 0,
            targetSimTimeSec: NaN,
            deliveredAdvanceSec: 0,
            syncTimeSec: NaN,
            reason: "",
        },
    };
}

function terminalFeasibleWarp(feasibleWarp, tdeInProgress, dead, landed, thrusting) {
    const numeric = Number(feasibleWarp);
    const liveCeiling = Number.isFinite(numeric) ? Math.max(0, Math.min(WARP_MAX, numeric)) : WARP_MAX;
    if (dead) return 0;
    if (tdeInProgress || landed || thrusting) return Math.min(600, liveCeiling);
    return liveCeiling;
}

function finishJumpRuntime(runtime, kind, reason = "", feasibleWarp = WARP_MAX) {
    const warp = safeJumpRestoreWarp(runtime.restoreWarp, feasibleWarp);
    runtime.active = false;
    runtime.expectedWarp = warp;
    runtime.result.kind = kind;
    runtime.result.warp = warp;
    runtime.result.etaWallSec = 0;
    runtime.result.advanceSec = 0;
    runtime.result.targetSimTimeSec = NaN;
    runtime.result.deliveredAdvanceSec = 0;
    runtime.result.syncTimeSec = NaN;
    runtime.result.reason = reason;
    return runtime.result;
}

function estimateJumpRemainingWallSec(runtime, simTimeSec) {
    const legs = runtime.plan.legs;
    const rate = Math.max(Number.EPSILON, runtime.physicsWallRate);
    let predictedAdvanceSec = Math.max(0, runtime.advanceDebtSec);
    let etaWallSec = 0;
    for (let i = runtime.legIndex; i < legs.length; i++) {
        const leg = legs[i];
        const legEndAdvanceSec = Math.max(0, leg.toSimT - simTimeSec);
        if (leg.kind === "rung") {
            const scheduledWallSec = Math.max(0, leg.wallSec - (i === runtime.legIndex ? runtime.legWallSec : 0));
            etaWallSec += scheduledWallSec;
            predictedAdvanceSec += leg.warp * scheduledWallSec * rate;
            continue;
        }
        const remainingSimSec = Math.max(0, legEndAdvanceSec - predictedAdvanceSec);
        etaWallSec += remainingSimSec / Math.max(Number.EPSILON, leg.warp * rate);
        predictedAdvanceSec = Math.max(predictedAdvanceSec, legEndAdvanceSec);
    }
    return etaWallSec;
}

export function stepJumpRuntime(runtime, {
    wallDeltaSec = 0,
    physicsDeltaSec = wallDeltaSec,
    simTimeSec = 0,
    currentWarp = runtime?.expectedWarp,
    tdeInProgress = false,
    externalTimeDriver = false,
    dead = false,
    landed = false,
    thrusting = false,
    feasibleWarp = WARP_MAX,
} = {}) {
    if (!runtime?.active) return runtime?.result;
    const restoreFeasibleWarp = terminalFeasibleWarp(
        feasibleWarp,
        runtime.tdeAtStart || tdeInProgress,
        dead,
        landed,
        thrusting,
    );
    if (!runtime.validPlan) return finishJumpRuntime(runtime, "cancel", "invalid jump plan", restoreFeasibleWarp);
    if (runtime.pending) return finishJumpRuntime(runtime, "cancel", "unsettled jump frame", restoreFeasibleWarp);
    if (externalTimeDriver) return finishJumpRuntime(runtime, "cancel", "external time", restoreFeasibleWarp);
    if (currentWarp !== runtime.expectedWarp) return finishJumpRuntime(runtime, "cancel", "time changed", restoreFeasibleWarp);
    if (runtime.tdeAtStart || tdeInProgress) return finishJumpRuntime(runtime, "tde", "", restoreFeasibleWarp);
    if (dead) return finishJumpRuntime(runtime, "cancel", "vehicle lost", restoreFeasibleWarp);
    if (landed) return finishJumpRuntime(runtime, "cancel", "vehicle landed", restoreFeasibleWarp);
    if (thrusting) return finishJumpRuntime(runtime, "cancel", "thrust active", restoreFeasibleWarp);

    const legs = runtime.plan.legs;

    const wallDelta = Math.max(0, Number(wallDeltaSec) || 0);
    runtime.elapsedWallSec += wallDelta;
    let leg = legs[runtime.legIndex];
    while (leg && simTimeSec >= leg.toSimT) {
        runtime.legIndex++;
        runtime.legWallSec = 0;
        leg = legs[runtime.legIndex];
    }
    if (!leg) return finishJumpRuntime(runtime, "arrive", "", restoreFeasibleWarp);

    let wallRemaining = wallDelta;
    while (leg?.kind === "rung") {
        const rungRemaining = Math.max(0, leg.wallSec - runtime.legWallSec);
        if (wallRemaining < rungRemaining) {
            runtime.legWallSec += wallRemaining;
            wallRemaining = 0;
            break;
        }
        wallRemaining -= rungRemaining;
        runtime.legIndex++;
        runtime.legWallSec = 0;
        leg = legs[runtime.legIndex];
    }
    if (!leg) return finishJumpRuntime(runtime, "arrive", "", restoreFeasibleWarp);

    const physicsDelta = Math.max(0, Number(physicsDeltaSec) || 0);
    if (wallDelta > 0 && physicsDelta > 0) {
        runtime.physicsWallRate = Math.min(1, physicsDelta / wallDelta);
    }
    const remaining = Math.max(0, leg.toSimT - simTimeSec);
    const warp = physicsDelta > 0 ? Math.min(leg.warp, remaining / physicsDelta) : leg.warp;
    if (physicsDelta > 0) runtime.advanceDebtSec += warp * physicsDelta;
    let nextSimTimeSec = simTimeSec;
    if (runtime.advanceDebtSec > 0) {
        const candidate = Math.min(leg.toSimT, simTimeSec + runtime.advanceDebtSec);
        const emittedAdvanceSec = candidate - simTimeSec;
        if (emittedAdvanceSec > 0 && runtime.advanceDebtSec >= emittedAdvanceSec) {
            nextSimTimeSec = candidate;
        }
    }
    const etaWallSec = estimateJumpRemainingWallSec(runtime, simTimeSec);
    runtime.expectedWarp = warp;
    runtime.result.kind = "run";
    runtime.result.warp = warp;
    runtime.result.etaWallSec = etaWallSec > 0
        ? etaWallSec
        : Math.max(Number.EPSILON, Math.min(runtime.result.etaWallSec, wallDelta || Number.EPSILON));
    runtime.result.advanceSec = nextSimTimeSec - simTimeSec;
    runtime.result.targetSimTimeSec = nextSimTimeSec;
    runtime.result.deliveredAdvanceSec = 0;
    runtime.result.syncTimeSec = NaN;
    runtime.result.reason = "";
    runtime.pending = true;
    runtime.pendingWallDeltaSec = wallDelta;
    runtime.pendingWarp = warp;
    return runtime.result;
}

export function settleJumpRuntime(runtime, {
    deliveredAdvanceSec = 0,
    simTimeSec = NaN,
    tdeInProgress = false,
    dead = false,
    landed = false,
    thrusting = false,
    feasibleWarp = WARP_MAX,
} = {}) {
    if (!runtime?.active || !runtime.pending) return runtime?.result;
    const result = runtime.result;
    const delivery = resolveJumpFrameDelivery(result, deliveredAdvanceSec, simTimeSec, runtime.delivery);
    runtime.pending = false;
    runtime.advanceDebtSec = Math.max(0, runtime.advanceDebtSec - delivery.deliveredAdvanceSec);
    if (delivery.requestedAdvanceSec > 0 && runtime.pendingWallDeltaSec > 0 && runtime.pendingWarp > 0) {
        runtime.physicsWallRate = Math.min(
            1,
            delivery.deliveredAdvanceSec / (runtime.pendingWarp * runtime.pendingWallDeltaSec),
        );
    }
    const settledSimTimeSec = Number.isFinite(delivery.syncTimeSec)
        ? delivery.syncTimeSec
        : delivery.postSimTimeSec;
    result.deliveredAdvanceSec = delivery.deliveredAdvanceSec;
    result.syncTimeSec = delivery.syncTimeSec;
    result.etaWallSec = estimateJumpRemainingWallSec(runtime, settledSimTimeSec);

    const restoreFeasibleWarp = terminalFeasibleWarp(feasibleWarp, tdeInProgress, dead, landed, thrusting);
    let terminal = null;
    if (tdeInProgress) terminal = finishJumpRuntime(runtime, "tde", "", restoreFeasibleWarp);
    else if (dead) terminal = finishJumpRuntime(runtime, "cancel", "vehicle lost", restoreFeasibleWarp);
    else if (landed) terminal = finishJumpRuntime(runtime, "cancel", "vehicle landed", restoreFeasibleWarp);
    else if (thrusting) terminal = finishJumpRuntime(runtime, "cancel", "thrust active", restoreFeasibleWarp);
    else if (settledSimTimeSec >= runtime.plan.targetSec) {
        terminal = finishJumpRuntime(runtime, "arrive", "", restoreFeasibleWarp);
    }
    if (terminal) {
        terminal.deliveredAdvanceSec = delivery.deliveredAdvanceSec;
        terminal.syncTimeSec = delivery.syncTimeSec;
        return terminal;
    }

    result.kind = "run";
    result.etaWallSec = result.etaWallSec > 0 ? result.etaWallSec : Number.EPSILON;
    return result;
}
