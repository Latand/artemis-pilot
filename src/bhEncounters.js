// Black-hole encounter pipeline (headless: no THREE, no DOM).
//
// Holes are integrated inside the ephemeris leapfrog (ephemeris.js) with the
// same pair laws as the bodies. This module owns everything that turns a
// close approach into an outcome:
//
//  * detection — once a body comes within WATCH_FACTOR·max(r_t, r_capture)
//    of a hole, its osculating two-body orbit about the hole is classified
//    (tde.js classifyTidalEncounter: none / distort / partial / full /
//    captured) from the pericentre r_p, beta = r_t/r_p and the relativistic
//    (Paczyński–Wiita) capture test;
//  * scheduling — a disruptive outcome is booked at the analytic pericentre
//    time (captures: when the conic reaches 3 r_capture). The ephemeris never
//    steps across a booked time (setLiveEventHooks.nextEvent), so the event
//    resolves on the same orbit at the same instant at any warp or frame rate;
//  * resolution — full: the body is removed, the bound half (M*/2) feeds the
//    hole as M_acc(t) = (M*/2)[1 - (t/t_fb)^(-2/3)] with its pericentre
//    momentum, the unbound half leaves; partial: the Guillochon &
//    Ramirez-Ruiz (2013) stripped fraction dM leaves the same way and the core
//    keeps (1 - dM/M) of the mass; captured: the whole body and its momentum
//    are swallowed at once, no flare;
//  * safety — any live body whose step segment crosses the capture sphere
//    (2 r_s, or a neutron star's surface) is captured before the closing kick,
//    and hole pairs whose relative segment crosses their merge radius merge;
//    no step floor is involved.
import { MU_E, MU_M, MU_S, R_EARTH, R_MOON, R_SUN, PL, C_LIGHT, K } from "./constants.js";
import { G, BH, WORLD, EPHT, bhRegister, destroyBody, isBodyDestroyed, bodyScaleIndex } from "./state.js";
import { eph, setLiveEventHooks, LF_SEG, IDX_MOON, IDX_SUN, IDX_PLANETS } from "./ephemeris.js";
import {
    classifyTidalEncounter, captureRadiusKm, WATCH_FACTOR, Q_MIN_TDE, gammaForBody,
    accretedFraction, tdeLuminosityW, L_EDD_PER_MSUN,
} from "./tde.js";
import { makeConic, conicFromState, propagateState, timeToRadiusInbound } from "./universe/keplerTools.js";
import { segmentSphereHit } from "./geometry.js";
import { sunStateAt } from "./universe/sunEvolution.js";
import { hashInts } from "./universe/prng.js";

const G_KM = 6.674e-20;          // km^3 kg^-1 s^-2
const SPEED_CAP = .5 * C_LIGHT;   // numerical safety net only
export const DEBRIS_COUNT = 3000;

// ---- hooks (presentation layer) ----
let H = {
    toast() { }, predict() { }, event() { },
    disrupt() { return ""; }, cataclysm() { }, absorbed() { },
    onRemove() { }, onMerged() { }, onResize() { },
};
export function initEncounterHooks(hooks) { H = { ...H, ...hooks }; }

// ---- bodies as encounter targets ----
export const BODY_TARGETS = ["earth", "moon", "sun", ...PL.map((_, i) => i)];
export function bodyLabel(target) {
    return target === "earth" ? "Earth" : target === "moon" ? "Moon" : target === "sun" ? "Sun" :
        typeof target === "number" && PL[target] ? PL[target].name.charAt(0) + PL[target].name.slice(1).toLowerCase() : "Body";
}
export function bodyTargetIndex(target) {
    return target === "earth" ? 0 : target === "moon" ? 1 : target === "sun" ? 2 : 3 + target;
}
function baseMu(target) {
    return target === "earth" ? MU_E : target === "moon" ? MU_M : target === "sun" ? MU_S : PL[target].mu;
}
let _sunRT = NaN, _sunRF = 1;
function sunRadiusFactor(t) {
    if (!(Math.abs(t - _sunRT) < 3e7)) { _sunRT = t; _sunRF = sunStateAt(t).R_Rsun || 1; }
    return _sunRF;
}
export function bodyMuLive(target) {
    if (isBodyDestroyed(target)) return 0;
    return baseMu(target) * WORLD.muScale[bodyScaleIndex(target)];
}
export function bodyRadiusLive(target, t = EPHT.t) {
    const base = target === "earth" ? R_EARTH : target === "moon" ? R_MOON :
        target === "sun" ? R_SUN * sunRadiusFactor(t) : PL[target].R;
    return base * WORLD.rScale[bodyScaleIndex(target)];
}
export function bodyKind(target) {
    return target === "sun" ? "star" : typeof target === "number" && PL[target]?.gas ? "gas" : "rock";
}
// Earth-frame state of a body from the live ephemeris cache (Earth = origin)
export function bodyState(target, out) {
    if (target === "earth") { out.x = 0; out.y = 0; out.z = 0; out.vx = 0; out.vy = 0; out.vz = 0; }
    else if (target === "moon") { out.x = eph.moonX; out.y = eph.moonY; out.z = eph.moonZ; out.vx = eph.moonVx; out.vy = eph.moonVy; out.vz = eph.moonVz; }
    else if (target === "sun") { out.x = eph.sunX; out.y = eph.sunY; out.z = eph.sunZ; out.vx = eph.sunVx; out.vy = eph.sunVy; out.vz = eph.sunVz; }
    else { out.x = eph.plX[target]; out.y = eph.plY[target]; out.z = eph.plZ[target]; out.vx = eph.plVx[target]; out.vy = eph.plVy[target]; out.vz = eph.plVz[target]; }
    return out;
}
function segIndex(target) {
    return target === "moon" ? IDX_MOON : target === "sun" ? IDX_SUN : typeof target === "number" ? IDX_PLANETS + target : -1;
}

// ---- hole data lifecycle ----
export function updateHoleSize(i) {
    BH.rs[i] = 2 * BH.mu[i] / (C_LIGHT * C_LIGHT);
    BH.c[i] = .001 * Math.sqrt(2 * BH.mu[i] / 1000);
    // a neutron star swallows at its ~12 km surface, never at a horizon
    BH.sinkS[i] = BH.kind[i] === 2 ? 12 * K : BH.rs[i] * K;
}
export function syncHoleScene() {
    for (let i = 0; i < BH.n; i++) {
        BH.sx[i] = BH.x[i] * K; BH.sy[i] = BH.z[i] * K; BH.sz[i] = -BH.y[i] * K;
    }
}
export function addHoleData(xKm, yKm, rsKm, vx0 = 0, vy0 = 0, events = null, kind = 0, period = 0, zKm = 0, vz0 = 0) {
    if (BH.n >= BH.x.length) return -1;
    const i = BH.n;
    bhRegister(i, xKm, yKm, rsKm, vx0, vy0, events, kind, period, zKm, vz0);
    BH.n++;
    updateHoleSize(i);
    return i;
}
export function removeHoleData(i) {
    if (i < 0 || i >= BH.n) return;
    H.onRemove(i);
    for (let k = ENC.length - 1; k >= 0; k--) {
        if (ENC[k].bh === i) ENC.splice(k, 1);
        else if (ENC[k].bh > i) ENC[k].bh--;
    }
    for (let k = TDES.length - 1; k >= 0; k--) {
        if (TDES[k].bh === i) TDES.splice(k, 1);
        else if (TDES[k].bh > i) TDES[k].bh--;
    }
    for (let k = CAPTURES.length - 1; k >= 0; k--) {
        if (CAPTURES[k].bh === i) CAPTURES.splice(k, 1);
        else if (CAPTURES[k].bh > i) CAPTURES[k].bh--;
    }
    for (let k = i; k < BH.n - 1; k++) {
        BH.x[k] = BH.x[k + 1]; BH.y[k] = BH.y[k + 1]; BH.z[k] = BH.z[k + 1];
        BH.vx[k] = BH.vx[k + 1]; BH.vy[k] = BH.vy[k + 1]; BH.vz[k] = BH.vz[k + 1];
        BH.mu[k] = BH.mu[k + 1]; BH.rs[k] = BH.rs[k + 1];
        BH.sx[k] = BH.sx[k + 1]; BH.sy[k] = BH.sy[k + 1]; BH.sz[k] = BH.sz[k + 1];
        BH.c[k] = BH.c[k + 1]; BH.sinkS[k] = BH.sinkS[k + 1];
        BH.obsT[k] = BH.obsT[k + 1];
        BH.kind[k] = BH.kind[k + 1]; BH.period[k] = BH.period[k + 1];
        BH.ev[k] = BH.ev[k + 1];
    }
    BH.ev[BH.n - 1] = null;
    BH.kind[BH.n - 1] = 0; BH.period[BH.n - 1] = 0;
    BH.n--;
    syncTdeFlag();
}

// ---- encounter records ----
// ENC: one record per (hole, body) pair inside the watch radius.
// TDES: accretion flares (full and partial disruptions) feeding a hole.
// CAPTURES: bodies swallowed whole (kept briefly for the plunge visual).
export const ENC = [];
export const TDES = [];
export const CAPTURES = [];
let encSerial = 0;
window.__BH_ENC = ENC;
window.__BH_TDES = TDES;

function findEnc(bh, target) {
    for (let k = 0; k < ENC.length; k++) if (ENC[k].bh === bh && ENC[k].target === target) return ENC[k];
    return null;
}
function newEnc(bh, target, t) {
    const rec = {
        bh, target, name: bodyLabel(target), serial: ++encSerial,
        tCreated: t, regime: "none", cls: null, el: makeConic(),
        relX: 0, relY: 0, relZ: 0, relVx: 0, relVy: 0, relVz: 0, tRel: t, mu: 0,
        R: 0, rt: 0, rCap: 0, rWatch: 0, rs: 0, muBody: 0, muHole: 0,
        tPeri: Infinity, tTidal: -Infinity, tEvent: Infinity, pending: false, lastResolved: -Infinity,
        debris: null, flybyNoted: false, minBeta: 0,
    };
    ENC.push(rec);
    return rec;
}
// Finer integration around a hole while a disruptive encounter is on its
// way in: the pericentre is booked from the integrated orbit, so its phase
// error (~(h/t_dyn)^2) must stay far below a second at any warp.
const STEP_FINE = 6;
export function syncTdeFlag() {
    let busy = false;
    for (let i = 0; i < BH.n; i++) BH.stepFine[i] = 1;
    for (let k = 0; k < ENC.length; k++) {
        const r = ENC[k];
        if (r.pending && r.el.inbound) {
            busy = true;
            if (r.bh >= 0 && r.bh < BH.n) BH.stepFine[r.bh] = STEP_FINE;
        }
    }
    WORLD.tdeInProgress = busy;
}
export function tdeInProgress() { return WORLD.tdeInProgress; }
export function nextEncounterTime(t) {
    let best = Infinity;
    for (let k = 0; k < ENC.length; k++) {
        const r = ENC[k];
        if (r.pending && r.tEvent > t && r.tEvent < best) best = r.tEvent;
    }
    return best;
}

const _bs = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
const _ps = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, chi: 0 };
const _cls = {};

function classifyRecord(rec, rpUse, E, L, rNow) {
    const cls = classifyTidalEncounter({
        mBh: rec.muHole, mStar: rec.muBody, rStar: rec.R, rp: rpUse, rs: rec.rs,
        kind: BH.kind[rec.bh], gamma: gammaForBody(rec.muBody, bodyKind(rec.target)),
        E, L, rNow,
    });
    rec.cls = cls;
    rec.regime = cls.regime;
    return cls;
}
function disruptive(regime) { return regime === "full" || regime === "partial" || regime === "captured"; }

// Refresh a record from the current relative state (body - hole).
function updateEnc(rec, t, dt, rx, ry, rz, vx, vy, vz) {
    const el = conicFromState(rx, ry, rz, vx, vy, vz, rec.mu, rec.el);
    rec.relX = rx; rec.relY = ry; rec.relZ = rz; rec.relVx = vx; rec.relVy = vy; rec.relVz = vz; rec.tRel = t;
    const Epw = .5 * el.v * el.v - rec.mu / Math.max(1e-30, el.r - rec.rs);
    const fresh = rec.tCreated === t;
    let tPeri = el.inbound || el.bound ? t + el.tToPeri : Infinity;
    let cls, due = Infinity;
    if (el.inbound) {
        cls = classifyRecord(rec, el.rp, Epw, el.h, el.r);
    } else if (fresh && el.tSincePeri <= Math.abs(dt) * (1 + 1e-9) + 1e-9) {
        // the whole close pass fell inside the last step: book it where it was
        tPeri = t - el.tSincePeri;
        cls = classifyRecord(rec, el.rp, Epw, el.h, el.r);
        if (disruptive(cls.regime)) due = tPeri;
    } else if (fresh) {
        // a hole appeared next to a receding body: the tide acts from here on
        cls = classifyRecord(rec, el.r, NaN, NaN, el.r);
        if (disruptive(cls.regime)) { due = t; tPeri = t; }
        else if (el.bound) cls = classifyRecord(rec, el.rp, Epw, el.h, el.r);
    } else {
        cls = classifyRecord(rec, el.rp, Epw, el.h, el.r);
        if (!el.bound) { rec.pending = false; rec.tPeri = Infinity; rec.tEvent = Infinity; return rec; }
    }
    rec.tPeri = tPeri;
    rec.minBeta = Math.max(rec.minBeta, cls.beta);
    if (disruptive(cls.regime)) {
        if (due === Infinity) {
            if (cls.regime === "captured") {
                const rTrig = 3 * rec.rCap;
                const lead = el.r <= rTrig ? 0 : timeToRadiusInbound(el.r, el.sigma0, el.alpha, rec.mu, rTrig);
                due = t + (Number.isFinite(lead) ? lead : el.tToPeri);
            } else due = tPeri;
        }
        // the same pericentre is never resolved twice (partials repeat on the
        // NEXT passage of a bound orbit): two passages are at least a
        // circular period at r_p apart
        const rpS = Math.max(el.rp, rec.rCap);
        const passage = 2 * Math.PI * Math.sqrt(rpS * rpS * rpS / rec.mu);
        if (Math.abs(due - rec.lastResolved) < .5 * passage) {
            rec.pending = false; rec.tEvent = Infinity;
        } else {
            rec.pending = Number.isFinite(due);
            rec.tEvent = due;
        }
        // inbound crossing of r_t: where the frozen-in debris starts
        if (rec.pending && cls.regime !== "partial") rec.tTidal = tidalCrossTime(rec, cls);
    } else {
        rec.pending = false; rec.tEvent = Infinity;
    }
    return rec;
}
// Time at which the relative conic crosses r_t on the way in (or the event
// time itself when r_t lies inside the pericentre / capture trigger).
function tidalCrossTime(rec, cls) {
    const el = rec.el;
    const rFreeze = cls.regime === "captured" ? Math.max(cls.rt, 3 * rec.rCap) : cls.rt;
    if (cls.regime === "captured" && cls.rt <= 3 * rec.rCap) return rec.tEvent;
    if (el.r <= rFreeze) return rec.tRel; // already inside: frozen now
    const lead = timeToRadiusInbound(el.r, el.sigma0, el.alpha, rec.mu, rFreeze);
    return Number.isFinite(lead) ? rec.tRel + lead : rec.tEvent;
}

// ---- debris specification (consumed by the renderer) ----
// The fluid elements move ballistically from the moment the tide overwhelms
// self-gravity (the inbound crossing of r_t): positions spread over the body,
// velocities equal to the centre of mass. Their specific energies then span
// eps_cm + (GM R / r_t^2)(x.r_hat / R) — the frozen-in spread — and the
// stream, the bound/unbound split and the t^-5/3 return all follow from the
// individual Kepler orbits.
function makeDebrisSpec(rec, tEpoch, kind) {
    propagateState(rec.relX, rec.relY, rec.relZ, rec.relVx, rec.relVy, rec.relVz, rec.mu, tEpoch - rec.tRel, _ps);
    const cls = rec.cls;
    const r = Math.hypot(_ps.x, _ps.y, _ps.z);
    const s = Math.pow(cls.rt / Math.max(1e-30, r), 3);
    return {
        kind, seed: hashInts(0x54444501, bodyTargetIndex(rec.target), rec.serial) >>> 0,
        count: DEBRIS_COUNT, t0: tEpoch, mu: rec.mu, R: rec.R, rt: cls.rt, rs: rec.rs, rCap: rec.rCap,
        x: _ps.x, y: _ps.y, z: _ps.z, vx: _ps.vx, vy: _ps.vy, vz: _ps.vz,
        tPeri: rec.tPeri, rp: cls.rpRel || rec.el.rp, beta: cls.beta, gamma: cls.gamma,
        massLossFrac: cls.massLossFrac, strain: s, target: rec.target, bh: rec.bh,
        tFb: cls.tFbSec, rCirc: 2 * (cls.rpRel || rec.el.rp),
    };
}

// ---- resolution ----
function resolveEnc(rec, tEv) {
    const i = rec.bh;
    if (i < 0 || i >= BH.n || isBodyDestroyed(rec.target)) { rec.pending = false; return; }
    propagateState(rec.relX, rec.relY, rec.relZ, rec.relVx, rec.relVy, rec.relVz, rec.mu, tEv - rec.tRel, _ps);
    const cls = rec.cls;
    rec.pending = false;
    rec.lastResolved = tEv;
    rec.tEvent = Infinity;
    WORLD.irreversibleFloorT = Math.max(WORLD.irreversibleFloorT, tEv);
    if (cls.regime === "captured") captureBody(rec, tEv, _ps.x, _ps.y, _ps.z, _ps.vx, _ps.vy, _ps.vz, cls.reason);
    else disruptBody(rec, tEv, _ps);
    syncTdeFlag();
}
function captureBody(rec, tEv, rx, ry, rz, vx, vy, vz, reason) {
    const i = rec.bh, target = rec.target;
    const m = bodyMuLive(target), mu0 = BH.mu[i], mu = mu0 + m;
    if (!(m > 0)) return;
    // perfectly inelastic: the hole takes the body's mass and momentum
    BH.x[i] += m * rx / mu; BH.y[i] += m * ry / mu; BH.z[i] += m * rz / mu;
    BH.vx[i] += m * vx / mu; BH.vy[i] += m * vy / mu; BH.vz[i] += m * vz / mu;
    BH.mu[i] = mu;
    updateHoleSize(i);
    BH.ev[i].push({ x: BH.x[i], y: BH.y[i], z: BH.z[i], t: tEv, dmu: m }); // mass gain spreads at c
    const spec = rec.debris || makeDebrisSpec(rec, tEv, "captured");
    spec.kind = "captured";
    CAPTURES.push({ bh: i, target, name: rec.name, t: tEv, debris: spec, reason, massMu: m });
    if (CAPTURES.length > 8) CAPTURES.shift();
    H.cataclysm(target, BH.rs[i], reason, i);
    if (!isBodyDestroyed(target)) destroyBody(target);
    H.onResize(i);
    H.event?.("tde-captured", rec.name + " " + reason);
}
// A core stripped below this fraction of its original mass on repeated
// passages is shredded outright on the next one (a partially disrupted
// remnant is out of equilibrium and only easier to strip).
const REMNANT_FLOOR = .05;
function disruptBody(rec, tEv, ps) {
    const i = rec.bh, target = rec.target, cls = rec.cls;
    const muB = bodyMuLive(target);
    const si = bodyScaleIndex(target);
    let f = cls.massLossFrac;
    let full = cls.regime === "full";
    if (!full && WORLD.muScale[si] * (1 - f) < REMNANT_FLOOR) {
        full = true; f = 1;
        cls.regime = "full";
        cls.reason = "remnant core shredded after repeated partial disruptions (beta " + cls.beta.toFixed(2) + ")";
    }
    const dM = f * muB, boundMass = .5 * dM;
    const spec = full ? (rec.debris || makeDebrisSpec(rec, rec.tTidal > -Infinity && rec.tTidal <= tEv ? rec.tTidal : tEv, "full"))
        : makeDebrisSpec(rec, tEv, "partial");
    spec.kind = full ? "full" : "partial";
    spec.massLossFrac = f;
    spec.tPeri = tEv;
    const mBhMsun = BH.mu[i] / MU_S;
    const tde = {
        bh: i, target, name: rec.name, regime: cls.regime, beta: cls.beta, rp: cls.rpRel, rt: cls.rt,
        t0: tEv, tFb: cls.tFbSec, boundMass, accreted: 0, massLossFrac: f,
        vRelX: ps.vx, vRelY: ps.vy, vRelZ: ps.vz,
        mStarKg: dM / G_KM, mBhMsun, LEddW: L_EDD_PER_MSUN * mBhMsun,
        LpeakW: tdeLuminosityW(cls.tFbSec, cls.tFbSec, dM / G_KM, mBhMsun),
        rCirc: 2 * cls.rpRel, debris: spec, active: true, jetted: false,
    };
    TDES.push(tde);
    BH.ev[i].push({ x: BH.x[i], y: BH.y[i], z: BH.z[i], t: tEv, dmu: boundMass, tFb: cls.tFbSec });
    if (full) {
        H.disrupt(target, BH.rs[i], cls.reason, i);
        if (!isBodyDestroyed(target)) destroyBody(target);
    } else {
        WORLD.muScale[si] *= 1 - f;
        WORLD.rScale[si] *= Math.cbrt(1 - f);
        const label = rec.name + " partially disrupted · β " + cls.beta.toFixed(2) + " · " + (100 * f).toFixed(1) + "% stripped · core survives";
        H.toast(label);
        H.event?.("tde-partial", label);
    }
}

// ---- accretion of the bound debris ----
function updateAccretion(t) {
    for (let k = 0; k < TDES.length; k++) {
        const d = TDES[k];
        const i = d.bh;
        if (i < 0 || i >= BH.n) continue;
        const target = d.boundMass * accretedFraction(t - d.t0, d.tFb);
        const dm = target - d.accreted;
        if (dm === 0) continue;
        d.accreted = target;
        const mu = BH.mu[i] + dm;
        // returning debris arrives with the pericentre momentum it left with
        BH.vx[i] += dm * d.vRelX / mu; BH.vy[i] += dm * d.vRelY / mu; BH.vz[i] += dm * d.vRelZ / mu;
        BH.mu[i] = mu;
        updateHoleSize(i);
    }
}
export function accretionUpdate(t = EPHT.t) { updateAccretion(t); }

// ---- merges ----
function mergePair(i, j, t) {
    if (j < i) { const s = i; i = j; j = s; }
    const muI = BH.mu[i], muJ = BH.mu[j], muTotal = muI + muJ;
    const x = (BH.x[i] * muI + BH.x[j] * muJ) / muTotal;
    const y = (BH.y[i] * muI + BH.y[j] * muJ) / muTotal;
    const z = (BH.z[i] * muI + BH.z[j] * muJ) / muTotal;
    const vx = (BH.vx[i] * muI + BH.vx[j] * muJ) / muTotal;
    const vy = (BH.vy[i] * muI + BH.vy[j] * muJ) / muTotal;
    const vz = (BH.vz[i] * muI + BH.vz[j] * muJ) / muTotal;
    const eta = muI * muJ / (muTotal * muTotal);
    const gwLossFrac = Math.min(.06, Math.max(0, .192 * eta));
    const muLoss = muTotal * gwLossFrac;
    const ev = BH.ev[i].concat(BH.ev[j]);
    if (muLoss > 0) ev.push({ x, y, z, t, dmu: -muLoss });
    // the merged hole inherits every running flare and pending record
    for (let k = 0; k < TDES.length; k++) if (TDES[k].bh === j) TDES[k].bh = i;
    for (let k = 0; k < CAPTURES.length; k++) if (CAPTURES[k].bh === j) CAPTURES[k].bh = i;
    for (let k = ENC.length - 1; k >= 0; k--) if (ENC[k].bh === i || ENC[k].bh === j) ENC.splice(k, 1);
    removeHoleData(j);
    BH.x[i] = x; BH.y[i] = y; BH.z[i] = z;
    BH.vx[i] = vx; BH.vy[i] = vy; BH.vz[i] = vz;
    BH.mu[i] = muTotal - muLoss;
    BH.kind[i] = 0; BH.period[i] = 0;
    BH.ev[i] = ev;
    updateHoleSize(i);
    WORLD.irreversibleFloorT = Math.max(WORLD.irreversibleFloorT, t);
    syncHoleScene();
    H.onMerged(i);
    const label = "⚫ Black-hole merger → r_s " + fmtKmShort(BH.rs[i]) + " · GW loss " + (gwLossFrac * 100).toFixed(1) + "%";
    H.toast(label);
    H.event?.("merger", label);
}
function fmtKmShort(km) {
    return km >= 1e6 ? (km / 1e6).toFixed(2) + " M km" : km >= 1 ? km.toFixed(km >= 100 ? 0 : 2) + " km" : (km * 1000).toFixed(1) + " m";
}
function mergeRadius(i, j) { return (BH.rs[i] + BH.rs[j]) * 1.2; }
function mergeBySegment(t) {
    for (let i = 0; i < BH.n; i++)
        for (let j = i + 1; j < BH.n; j++) {
            const r = mergeRadius(i, j);
            const pre = i < LF_SEG.n && j < LF_SEG.n;
            const x1 = BH.x[i] - BH.x[j], y1 = BH.y[i] - BH.y[j], z1 = BH.z[i] - BH.z[j];
            const x0 = pre ? LF_SEG.hx[i] - LF_SEG.hx[j] : x1, y0 = pre ? LF_SEG.hy[i] - LF_SEG.hy[j] : y1, z0 = pre ? LF_SEG.hz[i] - LF_SEG.hz[j] : z1;
            if (segmentSphereHit(x0, y0, z0, x1, y1, z1, r)) { mergePair(i, j, t); return true; }
        }
    return false;
}
export function mergeByDistance(t = EPHT.t) {
    for (let i = 0; i < BH.n; i++)
        for (let j = i + 1; j < BH.n; j++) {
            const d = Math.hypot(BH.x[i] - BH.x[j], BH.y[i] - BH.y[j], BH.z[i] - BH.z[j]);
            if (d < mergeRadius(i, j)) { mergePair(i, j, t); return true; }
        }
    return false;
}

// ---- live hooks ----
// After every live drift (ephemeris.js), before the closing kick: only the
// emergency paths that must pre-empt a kick from inside the capture sphere.
// Booked encounters resolve after the full step (postStep), where every
// velocity — the Earth frame's included — is the complete one at t_event.
let speedWarned = false;
function preKick(t, dt) {
    // 1. capture sphere: any hole-dominated body whose relative path in this
    //    step crossed it is swallowed before it can be kicked from inside
    for (let i = 0; i < BH.n; i++) {
        const rCap = captureRadiusKm(BH.rs[i], BH.kind[i]);
        const pre = i < LF_SEG.n;
        const hx0 = pre ? LF_SEG.hx[i] : BH.x[i], hy0 = pre ? LF_SEG.hy[i] : BH.y[i], hz0 = pre ? LF_SEG.hz[i] : BH.z[i];
        for (let b = 0; b < BODY_TARGETS.length; b++) {
            const target = BODY_TARGETS[b];
            if (isBodyDestroyed(target)) continue;
            const muB = bodyMuLive(target);
            if (!(BH.mu[i] / muB >= Q_MIN_TDE)) continue;
            bodyState(target, _bs);
            const si = segIndex(target);
            const bx0 = si >= 0 ? LF_SEG.bx[si] : 0, by0 = si >= 0 ? LF_SEG.by[si] : 0, bz0 = si >= 0 ? LF_SEG.bz[si] : 0;
            if (!segmentSphereHit(bx0 - hx0, by0 - hy0, bz0 - hz0, _bs.x - BH.x[i], _bs.y - BH.y[i], _bs.z - BH.z[i], rCap)) continue;
            let rec = findEnc(i, target);
            if (!rec) { rec = newEnc(i, target, t); fillRecordScales(rec, i, target, t); }
            WORLD.irreversibleFloorT = Math.max(WORLD.irreversibleFloorT, t);
            rec.pending = false; rec.lastResolved = t;
            const rs = BH.rs[i];
            const reason = BH.kind[i] === 2 ? "impacts the neutron-star surface" :
                rec.rt <= rCap ? "swallowed whole — tidal radius inside the horizon" : "swallowed whole — crossed the capture radius 2 r_s";
            rec.relX = _bs.x - BH.x[i]; rec.relY = _bs.y - BH.y[i]; rec.relZ = _bs.z - BH.z[i];
            rec.relVx = _bs.vx - BH.vx[i]; rec.relVy = _bs.vy - BH.vy[i]; rec.relVz = _bs.vz - BH.vz[i]; rec.tRel = t;
            if (!rec.cls) rec.cls = classifyTidalEncounter({ mBh: rec.muHole, mStar: rec.muBody, rStar: rec.R, rp: 0, rs, kind: BH.kind[i] });
            captureBody(rec, t, rec.relX, rec.relY, rec.relZ, rec.relVx, rec.relVy, rec.relVz, reason);
        }
    }
    // 2. hole pairs whose relative path crossed the merge radius
    for (let guard = 0; guard < 8 && mergeBySegment(t); guard++) { }
    // 3. fallback accretion to this instant
    updateAccretion(t);
    // 4. numerical safety net: no hole may approach c in the world frame (the
    //    Earth-centred frame itself can coast fast after Earth is swallowed)
    for (let i = 0; i < BH.n; i++) {
        const wx = BH.vx[i] + eph.earthVx, wy = BH.vy[i] + eph.earthVy, wz = BH.vz[i];
        const v = Math.hypot(wx, wy, wz);
        if (v > SPEED_CAP) {
            const f = SPEED_CAP / v;
            BH.vx[i] = wx * f - eph.earthVx; BH.vy[i] = wy * f - eph.earthVy; BH.vz[i] = wz * f;
            if (!speedWarned) { speedWarned = true; console.warn("black-hole speed capped at 0.5c (numerical safety net)"); }
        }
    }
    syncTdeFlag();
}
function fillRecordScales(rec, i, target, t) {
    rec.muHole = BH.mu[i];
    rec.muBody = bodyMuLive(target);
    rec.mu = rec.muHole + rec.muBody;
    rec.rs = BH.rs[i];
    rec.R = bodyRadiusLive(target, t);
    rec.rt = rec.R * Math.cbrt(rec.muHole / Math.max(1e-30, rec.muBody));
    rec.rCap = captureRadiusKm(BH.rs[i], BH.kind[i]);
    rec.rWatch = WATCH_FACTOR * Math.max(rec.rt, rec.rCap);
    // inside r_t the fluid elements move ballistically (frozen-in) and deep
    // in the well the Newtonian conic is only an approximation: a booked
    // encounter keeps the conic it had on entry
    rec.freezeR = Math.max(rec.rt, 4.5 * rec.rCap);
}
function freezeDebrisIfDue(rec, t) {
    if (rec.pending && !rec.debris && rec.regime !== "partial" && rec.cls && t >= rec.tTidal) {
        rec.debris = makeDebrisSpec(rec, rec.tTidal, rec.regime === "captured" ? "captured" : "full");
    }
    if (!rec.pending && rec.debris && rec.lastResolved === -Infinity) rec.debris = null;
}
function resolveDue(t) {
    const tol = 1e-9 * Math.max(1, Math.abs(t));
    for (let guard = 0; guard < 64; guard++) {
        let rec = null;
        for (let k = 0; k < ENC.length; k++) {
            const r = ENC[k];
            if (r.pending && r.tEvent <= t + tol && (!rec || r.tEvent < rec.tEvent)) rec = r;
        }
        if (!rec) break;
        resolveEnc(rec, rec.tEvent);
    }
}
// After every full live step: resolve what is due (the step was clipped to
// end on it), then detect, classify and (re)book encounters.
function postStep(t, dt) {
    resolveDue(t);
    for (let i = 0; i < BH.n; i++) {
        const muH = BH.mu[i];
        const rCap = captureRadiusKm(BH.rs[i], BH.kind[i]);
        for (let b = 0; b < BODY_TARGETS.length; b++) {
            const target = BODY_TARGETS[b];
            let rec = findEnc(i, target);
            if (isBodyDestroyed(target)) { if (rec) ENC.splice(ENC.indexOf(rec), 1); continue; }
            const muB = bodyMuLive(target);
            if (!(muH / muB >= Q_MIN_TDE)) { if (rec) ENC.splice(ENC.indexOf(rec), 1); continue; }
            const R = bodyRadiusLive(target, t);
            const rt = R * Math.cbrt(muH / muB);
            const rWatch = WATCH_FACTOR * Math.max(rt, rCap);
            bodyState(target, _bs);
            const rx = _bs.x - BH.x[i], ry = _bs.y - BH.y[i], rz = _bs.z - BH.z[i];
            const d2 = rx * rx + ry * ry + rz * rz;
            if (d2 > rWatch * rWatch) {
                if (rec && d2 > rWatch * rWatch * 1.5625) ENC.splice(ENC.indexOf(rec), 1);
                if (!rec || d2 > rWatch * rWatch * 1.5625) continue;
            }
            // a disruptive record past its predicted r_t crossing freezes its
            // debris on the orbit it was booked on (exact crossing time, not
            // wherever this step happened to end)
            if (rec) freezeDebrisIfDue(rec, t);
            const fresh = !rec;
            if (!rec) rec = newEnc(i, target, t);
            // refresh cadence: every 2% of the local dynamical time while a
            // disruptive outcome is booked (every step once it is a few steps
            // away), every 10% for a harmless flyby — its conic barely moves
            const r = Math.sqrt(d2);
            const tDyn = Math.sqrt(r * r * r / (muH + muB));
            const frozen = !fresh && rec.pending && r < rec.freezeR;
            const due = fresh || (!frozen && (!rec.cls || (t - rec.tRel) >= (rec.pending ? .02 : .1) * tDyn ||
                (rec.pending && rec.tEvent - t < 4 * Math.abs(dt) + 1e-6) || Math.abs(t - rec.tRel) > 1e7));
            if (!due) continue;
            fillRecordScales(rec, i, target, t);
            let rvx = _bs.vx - BH.vx[i], rvy = _bs.vy - BH.vy[i], rvz = _bs.vz - BH.vz[i];
            let px = rx, py = ry, pz = rz;
            if (!(r > 1e-6)) { px = 1e-6; py = 0; pz = 0; } // hole dropped on the body's centre
            updateEnc(rec, t, dt, px, py, pz, rvx, rvy, rvz);
            freezeDebrisIfDue(rec, t);
            if (!rec.flybyNoted && rec.regime === "distort" && rec.el.inbound && rec.el.tToPeri < Math.abs(dt) * 2 + 1) {
                rec.flybyNoted = true;
                H.event?.("tde-flyby", rec.name + " tidal flyby · β " + rec.cls.beta.toFixed(2) + " · elongation only");
            }
        }
    }
    // a pericentre booked in the past (whole pass inside one step) resolves now
    resolveDue(t);
    syncTdeFlag();
}
setLiveEventHooks({ preKick, nextEvent: nextEncounterTime, guard: postStep });

// Called after every ephemeris advance (physics.js / main.js): the holes
// already moved inside the leapfrog; this only settles bookkeeping that must
// hold even when that advance was a no-op.
export function bhAdvance(_dtTotal, _tEnd) {
    if (!BH.n) return;
    const t = EPHT.t;
    for (let guard = 0; guard < 8 && mergeByDistance(t); guard++) { }
    updateAccretion(t);
    syncHoleScene();
}

// ---- flare readout ----
const _tdeOut = {
    bh: 0, targetName: "", regime: "", beta: 0, LnowW: 0, LpeakW: 0, LEddW: 0, ageSec: 0, tFbSec: 0,
    pastPeak: false, accretedMsun: 0, boundMsun: 0, massLossFrac: 0, timeBase: "coordinate",
};
export function tdeLuminosityNow(d, t = EPHT.t) {
    return tdeLuminosityW(t - d.t0, d.tFb, d.mStarKg, d.mBhMsun);
}
export function activeTde(t = EPHT.t) {
    let best = null, bestL = -1;
    for (let k = 0; k < TDES.length; k++) {
        const d = TDES[k];
        if (!d.active || d.bh < 0 || d.bh >= BH.n) continue;
        const age = t - d.t0;
        if (age < 0) continue;
        // retire once the flare has faded far below Eddington and the stream is spent
        if (age > d.tFb * 3e4) { d.active = false; continue; }
        const L = tdeLuminosityW(age, d.tFb, d.mStarKg, d.mBhMsun);
        if (L > bestL) { bestL = L; best = d; }
    }
    if (!best) return null;
    const age = t - best.t0;
    const o = _tdeOut;
    o.bh = best.bh; o.targetName = best.name; o.regime = best.regime; o.beta = best.beta;
    o.LnowW = bestL; o.LpeakW = best.LpeakW; o.LEddW = best.LEddW;
    o.ageSec = age; o.tFbSec = best.tFb; o.pastPeak = age >= best.tFb;
    o.accretedMsun = best.accreted / MU_S; o.boundMsun = best.boundMass / MU_S; o.massLossFrac = best.massLossFrac;
    return o;
}
