import * as THREE from "three";
import { R_EARTH, R_MOON, R_SUN, PL, K, SOI_M, STARS, LY_KM } from "./constants.js";
import {
    eph, moonState,
    snapshotEphem, loadEphemSnapshot, advanceEphemSnapshot, advanceEphemSnapshotKepler,
    bodyStateForTarget,
    beginPredictionBH, endPredictionBH, predBHX, predBHY,
    beginPredictionStars, endPredictionStars,
} from "./ephemeris.js";
import { G, BH } from "./state.js";
import { speedColor } from "./format.js";
import { rk4Step, stepSize } from "./physics.js";
import { dotTexture, ringTexture } from "./textures.js";
import { scene, renderQuality } from "./scene.js";
import { segmentSphereHit } from "./geometry.js";
import { PERF, markPerf } from "./perf.js";
import { ACTIVE_STARS, activeStarForFocus } from "./universe/activeStars.js";

const _m = { mx: 0, my: 0, vmx: 0, vmy: 0, ang: 0 };

// ---- detailed trail (recent path, fine resolution near bodies) ----
const TRN = 8000;
const trPos = new Float32Array(TRN * 3), trCol = new Float32Array(TRN * 3);
const trGeom = new THREE.BufferGeometry();
const trPosAttr = new THREE.BufferAttribute(trPos, 3); trPosAttr.setUsage(THREE.DynamicDrawUsage);
const trColAttr = new THREE.BufferAttribute(trCol, 3); trColAttr.setUsage(THREE.DynamicDrawUsage);
trGeom.setAttribute("position", trPosAttr);
trGeom.setAttribute("color", trColAttr);
trGeom.setDrawRange(0, 0);
const trail = new THREE.Line(trGeom, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .62 }));
trail.frustumCulled = false;
trail.renderOrder = 3;
scene.add(trail);
let trN = 0;
const _tc = [0, 0, 0];
function markAttrRange(attr, startItem, itemCount) {
    const count = itemCount * attr.itemSize;
    if (count <= 0) return;
    if (attr.addUpdateRange) attr.addUpdateRange(startItem * attr.itemSize, count);
    else {
        attr.updateRange.offset = startItem * attr.itemSize;
        attr.updateRange.count = count;
    }
    attr.needsUpdate = true;
}
function markAttrFull(attr, itemCount) {
    if (attr.clearUpdateRanges) attr.clearUpdateRanges();
    markAttrRange(attr, 0, itemCount);
}
export function pushTrail(force) {
    const sx = (eph.earthX + G.x) * K, sy = G.z * K, sz = -(eph.earthY + G.y) * K;
    if (trN > 0 && !force) {
        const lx = trPos[(trN - 1) * 3], ly = trPos[(trN - 1) * 3 + 1], lz = trPos[(trN - 1) * 3 + 2];
        moonState(G.t, _m);
        let rNear = Math.min(Math.hypot(G.x, G.y, G.z), Math.hypot(G.x - _m.mx, G.y - _m.my, G.z) * 2.5, Math.hypot(G.x - eph.sunX, G.y - eph.sunY, G.z));
        for (let i = 0; i < PL.length; i++) rNear = Math.min(rNear, Math.hypot(G.x - eph.plX[i], G.y - eph.plY[i], G.z));
        const thr = Math.max(.012, Math.min(400, rNear * K * .02));
        if (Math.hypot(sx - lx, sy - ly, sz - lz) < thr) {
            // refresh last point so the line always touches the ship
            trPos[(trN - 1) * 3] = sx; trPos[(trN - 1) * 3 + 1] = sy; trPos[(trN - 1) * 3 + 2] = sz;
            markAttrRange(trPosAttr, trN - 1, 1);
            return;
        }
    }
    let compacted = false;
    if (trN >= TRN) { // keep newest half, decimated
        const t0 = PERF.enabled ? performance.now() : 0;
        const keep = TRN / 2, src = keep * 3, end = TRN * 3;
        trPos.copyWithin(0, src, end);
        trCol.copyWithin(0, src, end);
        trN = keep;
        compacted = true;
        if (PERF.enabled) markPerf("trail.compact", performance.now() - t0, { kind: "detail", keep });
    }
    speedColor(Math.hypot(G.vx, G.vy, G.vz), _tc);
    const idx = trN;
    trPos[idx * 3] = sx; trPos[idx * 3 + 1] = sy; trPos[idx * 3 + 2] = sz;
    trCol[idx * 3] = _tc[0]; trCol[idx * 3 + 1] = _tc[1]; trCol[idx * 3 + 2] = _tc[2];
    trN++;
    if (compacted) {
        markAttrFull(trPosAttr, trN);
        markAttrFull(trColAttr, trN);
    } else {
        markAttrRange(trPosAttr, idx, 1);
        markAttrRange(trColAttr, idx, 1);
    }
    trGeom.setDrawRange(0, trN);
}

// ---- journey trail: the whole flight, coarse spacing, readable when zoomed
// far out (the detailed trail is subpixel at interplanetary scale) ----
const JRN = 6000;
const jrPos = new Float32Array(JRN * 3), jrCol = new Float32Array(JRN * 3);
const jrGeom = new THREE.BufferGeometry();
const jrPosAttr = new THREE.BufferAttribute(jrPos, 3); jrPosAttr.setUsage(THREE.DynamicDrawUsage);
const jrColAttr = new THREE.BufferAttribute(jrCol, 3); jrColAttr.setUsage(THREE.DynamicDrawUsage);
jrGeom.setAttribute("position", jrPosAttr);
jrGeom.setAttribute("color", jrColAttr);
jrGeom.setDrawRange(0, 0);
const journey = new THREE.Line(jrGeom, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false }));
journey.frustumCulled = false;
journey.renderOrder = 3;
scene.add(journey);
let jrN = 0;
export function pushJourney() {
    const sx = (eph.earthX + G.x) * K, sy = G.z * K, sz = -(eph.earthY + G.y) * K;
    if (jrN > 0) {
        const lx = jrPos[(jrN - 1) * 3], ly = jrPos[(jrN - 1) * 3 + 1], lz = jrPos[(jrN - 1) * 3 + 2];
        // spacing scales with distance from Earth: fine in cislunar space,
        // coarse on interplanetary arcs — 6000 points cover ~10 AU of path
        const thr = Math.max(1.2, Math.hypot(sx, sz) * .01);
        if (Math.hypot(sx - lx, sy - ly, sz - lz) < thr) {
            jrPos[(jrN - 1) * 3] = sx; jrPos[(jrN - 1) * 3 + 1] = sy; jrPos[(jrN - 1) * 3 + 2] = sz;
            markAttrRange(jrPosAttr, jrN - 1, 1);
            return;
        }
    }
    let compacted = false;
    if (jrN >= JRN) {
        const t0 = PERF.enabled ? performance.now() : 0;
        const keep = JRN / 2, src = keep * 3, end = JRN * 3;
        jrPos.copyWithin(0, src, end);
        jrCol.copyWithin(0, src, end);
        jrN = keep;
        compacted = true;
        if (PERF.enabled) markPerf("trail.compact", performance.now() - t0, { kind: "journey", keep });
    }
    speedColor(Math.hypot(G.vx, G.vy, G.vz), _tc);
    const idx = jrN;
    jrPos[idx * 3] = sx; jrPos[idx * 3 + 1] = sy; jrPos[idx * 3 + 2] = sz;
    // Keep a low floor for deep-space readability without turning dense
    // repeated orbits into a white bloom mass.
    jrCol[idx * 3] = .12 + .46 * _tc[0]; jrCol[idx * 3 + 1] = .12 + .42 * _tc[1]; jrCol[idx * 3 + 2] = .14 + .44 * _tc[2];
    jrN++;
    if (compacted) {
        markAttrFull(jrPosAttr, jrN);
        markAttrFull(jrColAttr, jrN);
    } else {
        markAttrRange(jrPosAttr, idx, 1);
        markAttrRange(jrColAttr, idx, 1);
    }
    jrGeom.setDrawRange(0, jrN);
}
function densityFade(n, softStart, halfAt) {
    return 1 / Math.sqrt(1 + Math.max(0, n - softStart) / halfAt);
}
export function setJourneyOpacity(o) {
    const jrFade = densityFade(jrN, 700, 520);
    const trFade = densityFade(trN, 1200, 1100);
    journey.material.opacity = Math.min(.34, o * jrFade);
    trail.material.opacity = .62 * trFade;
}
export function clearTrail() {
    trN = 0; trGeom.setDrawRange(0, 0);
    jrN = 0; jrGeom.setDrawRange(0, 0);
}

// ---- prediction ----
const PRN = 2400;
const prPos = new Float32Array(PRN * 3);
const prGeom = new THREE.BufferGeometry();
const prPosAttr = new THREE.BufferAttribute(prPos, 3); prPosAttr.setUsage(THREE.DynamicDrawUsage);
prGeom.setAttribute("position", prPosAttr);
prGeom.setDrawRange(0, 0);
const predLine = new THREE.Line(prGeom, new THREE.LineBasicMaterial({ color: 0x6fd8c8, transparent: true, opacity: .28 }));
predLine.frustumCulled = false;
predLine.renderOrder = 2;
scene.add(predLine);
const impactSpr = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture("rgba(255,80,60,0.95)"), transparent: true, depthWrite: false, opacity: .95 }));
impactSpr.visible = false;
scene.add(impactSpr);
export { impactSpr };
const ghostMoon = (() => {
    const segs = 96, pos = new Float32Array(segs * 3);
    for (let i = 0; i < segs; i++) {
        const a = i / segs * Math.PI * 2;
        pos[i * 3] = R_MOON * K * Math.cos(a);
        pos[i * 3 + 2] = R_MOON * K * Math.sin(a);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const ring = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x86c8ea, transparent: true, opacity: .4, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.visible = false;
    scene.add(ring);
    return ring;
})();
const caDot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(140,220,255,1)", "rgba(100,180,255,0.4)"), transparent: true, depthWrite: false }));
caDot.visible = false;
scene.add(caDot);
const _ps = [0, 0, 0, 0, 0, 0];
const predictionLiveEphem = snapshotEphem();
const predictionEphem = snapshotEphem();
const bodyPredictionEphem = snapshotEphem();
const PRED_STAR_LIMIT = 48;
const PRED_STELLAR_GRAVITY_MIN_R = LY_KM * .02; // keep Solar System predictions local.
const EMPTY_PRED_STARS = [];
const predStarRefs = [];
const predStarScores = new Float64Array(PRED_STAR_LIMIT);
const predStarD2 = new Float64Array(PRED_STAR_LIMIT);
function focusedPredictionStar() {
    if (typeof G.focus === "string") {
        const m = G.focus.match(/^star:(\d+)$/);
        if (m) return STARS[Number(m[1])] || null;
    }
    return activeStarForFocus(G.focus);
}
function insertPredictionStar(star, score, d2, count) {
    if (count >= PRED_STAR_LIMIT) {
        const last = PRED_STAR_LIMIT - 1;
        if (score < predStarScores[last] || (score === predStarScores[last] && d2 >= predStarD2[last])) return count;
    }
    const nextCount = count < PRED_STAR_LIMIT ? count + 1 : count;
    let p = Math.min(count, PRED_STAR_LIMIT - 1);
    while (p > 0 && (score > predStarScores[p - 1] || (score === predStarScores[p - 1] && d2 < predStarD2[p - 1]))) {
        predStarScores[p] = predStarScores[p - 1];
        predStarD2[p] = predStarD2[p - 1];
        predStarRefs[p] = predStarRefs[p - 1];
        p--;
    }
    predStarScores[p] = score;
    predStarD2[p] = d2;
    predStarRefs[p] = star;
    return nextCount;
}
function predictionStars(wx, wy, wz) {
    if (Math.hypot(wx, wy, wz) < PRED_STELLAR_GRAVITY_MIN_R) return EMPTY_PRED_STARS;
    if (ACTIVE_STARS.length <= PRED_STAR_LIMIT) return ACTIVE_STARS;
    const focusStar = focusedPredictionStar();
    let count = 0;
    for (let i = 0; i < ACTIVE_STARS.length; i++) {
        const star = ACTIVE_STARS[i];
        const dx = wx - star.x, dy = wy - star.y, dz = wz - (star.z || 0);
        const d2 = Math.max(1, dx * dx + dy * dy + dz * dz);
        let score = star.mu / d2;
        if (star.bh) score *= 1e6;
        if (star === focusStar) score = Infinity;
        count = insertPredictionStar(star, score, d2, count);
    }
    predStarRefs.length = count;
    return predStarRefs;
}
// per-call time cap so long predictions never hitch a frame — but only after a
// guaranteed minimum of steps, so near-field impact warnings are never starved
// (a cold, un-JITed first call can be slow enough to truncate otherwise)
const PRED_BUDGET_MS_DESKTOP = 1.1, PRED_BUDGET_MS_MOBILE = 0.75;
const PRED_MIN_STEPS_DESKTOP = 64, PRED_MIN_STEPS_MOBILE = 48;
export function computePrediction() {
    if (!G.predict || G.dead || G.landed) { prGeom.setDrawRange(0, 0); impactSpr.visible = false; ghostMoon.visible = false; caDot.visible = false; return; }
    const liveEphem = snapshotEphem(predictionLiveEphem);
    const predEphem = snapshotEphem(predictionEphem);
    _ps[0] = G.x; _ps[1] = G.y; _ps[2] = G.z; _ps[3] = G.vx; _ps[4] = G.vy; _ps[5] = G.vz;
    let pt = G.t, n = 0, minRM = Infinity, caT = 0, caX = 0, caY = 0, caZ = 0, caMX = 0, caMY = 0, caEX = 0, caEY = 0, impact = 0;
    const t0 = performance.now();
    const predBudgetMs = renderQuality.mobile ? PRED_BUDGET_MS_MOBILE : PRED_BUDGET_MS_DESKTOP;
    const predMinSteps = renderQuality.mobile ? PRED_MIN_STEPS_MOBILE : PRED_MIN_STEPS_DESKTOP;
    const predStars = predictionStars(eph.earthX + G.x, eph.earthY + G.y, G.z);
    let truncated = false;
    try {
        loadEphemSnapshot(predEphem);
        beginPredictionBH(); // holes coast linearly from their snapshot state
        beginPredictionStars(predStars);
        const far = Math.hypot(G.x, G.y, G.z) > 2e6;
        const tMax = G.t + 86400 * (far ? 160 : 8);
        let pmx = 0, pmy = 0, pmz = 0, pex = 0, pey = 0, pez = 0, hasPrev = false, plNear = false;
        while (n < PRN && pt < tMax) {
            prPos[n * 3] = (predEphem.earthX + _ps[0]) * K; prPos[n * 3 + 1] = _ps[2] * K; prPos[n * 3 + 2] = -(predEphem.earthY + _ps[1]) * K;
            n++;
            if (n > predMinSteps && (n & 31) === 0 && performance.now() - t0 > predBudgetMs) {
                truncated = true;
                break;
            }
            const rE = Math.sqrt(_ps[0] * _ps[0] + _ps[1] * _ps[1] + _ps[2] * _ps[2]);
            moonState(pt, _m);
            const dmx = _ps[0] - _m.mx, dmy = _ps[1] - _m.my, dmz = _ps[2];
            const rM = Math.sqrt(dmx * dmx + dmy * dmy + dmz * dmz);
            if (rM < minRM) { minRM = rM; caT = pt; caX = _ps[0]; caY = _ps[1]; caZ = _ps[2]; caMX = _m.mx; caMY = _m.my; caEX = predEphem.earthX; caEY = predEphem.earthY; }
            const dsx = _ps[0] - eph.sunX, dsy = _ps[1] - eph.sunY, dsz = _ps[2];
            const rSp = Math.sqrt(dsx * dsx + dsy * dsy + dsz * dsz);
            if (rE < R_EARTH) { impact = 1; break; }
            if (rM < R_MOON) { impact = 2; break; }
            // grazing chords: a step can jump across a body between samples, so
            // near Earth/Moon also test the closest approach along the segment
            if (hasPrev) {
                if (rM < SOI_M && segmentSphereHit(pmx, pmy, pmz, dmx, dmy, dmz, R_MOON)) { impact = 2; break; }
                if (rE < 60000 && segmentSphereHit(pex, pey, pez, _ps[0], _ps[1], _ps[2], R_EARTH)) { impact = 1; break; }
            }
            pmx = dmx; pmy = dmy; pmz = dmz; pex = _ps[0]; pey = _ps[1]; pez = _ps[2]; hasPrev = true;
            if (rSp < R_SUN) { impact = 3; break; }
            plNear = false;
            for (let pi = 0; pi < PL.length; pi++) {
                const dx = _ps[0] - eph.plX[pi], dy = _ps[1] - eph.plY[pi], dz = _ps[2];
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 <= PL[pi].R * PL[pi].R) { impact = 5; break; }
                if (d2 < PL[pi].soi * PL[pi].soi * .25) plNear = true;
            }
            if (impact) break;
            const wx = predEphem.earthX + _ps[0], wy = predEphem.earthY + _ps[1], wz = _ps[2];
            for (let si = 0; si < predStars.length; si++) {
                const st = predStars[si];
                const dx = wx - st.x, dy = wy - st.y, dz = wz - (st.z || 0);
                if (dx * dx + dy * dy + dz * dz <= st.R * st.R) { impact = 6; break; }
            }
            if (impact) break;
            for (let bi = 0; bi < BH.n; bi++) {
                const dx = _ps[0] - predBHX(bi, pt), dy = _ps[1] - predBHY(bi, pt), dz = _ps[2];
                const lim = BH.rs[bi] * 1.5;
                if (dx * dx + dy * dy + dz * dz <= lim * lim) { impact = 4; break; }
            }
            if (impact) break;
            // full fidelity through flybys: the post-encounter path is too
            // sensitive for coarsened steps near the Moon or a planet
            const mult = (rM < SOI_M * 1.5 || plNear) ? 1 : far ? 14 : 3;
            let dt = stepSize(rE, rM, rSp, rE - R_EARTH, Math.hypot(_ps[3], _ps[4], _ps[5]), _ps[0], _ps[1], _ps[2], _ps[3], _ps[4], _ps[5]) * mult;
            dt = Math.max(.5, Math.min(far ? 3200 : 600, dt));
            rk4Step(_ps, 0, dt, 0, 0, 0);
            advanceEphemSnapshot(predEphem, dt);
            pt += dt;
        }
    } finally {
        endPredictionStars();
        endPredictionBH();
        loadEphemSnapshot(liveEphem);
    }
    if (PERF.enabled) {
        markPerf("prediction", performance.now() - t0, {
            steps: n,
            activeStars: ACTIVE_STARS.length,
            gravityStars: predStars.length,
            truncated,
            impact,
            budget: predBudgetMs,
        });
    }
    markAttrFull(prPosAttr, n);
    prGeom.setDrawRange(0, n);
    if (impact) {
        const impactIdx = (n - 1) * 3;
        impactSpr.visible = true;
        impactSpr.position.set(prPos[impactIdx], prPos[impactIdx + 1], prPos[impactIdx + 2]);
    } else impactSpr.visible = false;
    if (minRM < 120000 && caT > G.t + 30) {
        ghostMoon.visible = true;
        ghostMoon.position.set((caEX + caMX) * K, 0, -(caEY + caMY) * K);
        caDot.visible = true;
        caDot.position.set((caEX + caX) * K, caZ * K, -(caEY + caY) * K);
    } else { ghostMoon.visible = false; caDot.visible = false; }
}

// ---- hovered / locked body prediction ----
const BPN = 240;
const bpPos = new Float32Array(BPN * 3);
const bpGeom = new THREE.BufferGeometry();
const bpPosAttr = new THREE.BufferAttribute(bpPos, 3); bpPosAttr.setUsage(THREE.DynamicDrawUsage);
bpGeom.setAttribute("position", bpPosAttr);
bpGeom.setDrawRange(0, 0);
const bodyPredLine = new THREE.Line(bpGeom, new THREE.LineBasicMaterial({ color: 0xf1d36b, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true }));
bodyPredLine.frustumCulled = false;
bodyPredLine.renderOrder = 0;
bodyPredLine.visible = false;
const bodyPredDots = new THREE.Points(bpGeom, new THREE.PointsMaterial({ color: 0x86c8ea, size: 1.7, sizeAttenuation: false, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true }));
bodyPredDots.frustumCulled = false;
bodyPredDots.renderOrder = 0;
bodyPredDots.visible = false;
scene.add(bodyPredLine, bodyPredDots);
const _bs = { x: 0, y: 0, vx: 0, vy: 0 };
function bodyPredStep(target) {
    if (target === -3) return 86400;
    if (target === -2) return 1800;
    if (target === -1) return 86400;
    const p = PL[target];
    const period = 2 * Math.PI / Math.max(1e-12, p.n);
    return Math.max(21600, Math.min(86400 * 7, period / BPN));
}
export function clearBodyPrediction() {
    bpGeom.setDrawRange(0, 0);
    bodyPredLine.visible = false;
    bodyPredDots.visible = false;
}
export function computeBodyPrediction(target, locked = false) {
    if (target < -3 || target >= PL.length) { clearBodyPrediction(); return; }
    const t0 = PERF.enabled ? performance.now() : 0;
    const predEphem = snapshotEphem(bodyPredictionEphem);
    const step = bodyPredStep(target);
    const nMax = target === -2 ? 420 : target === -1 ? 520 : BPN;
    let n = 0;
    try {
        beginPredictionBH(); // holes coast linearly from their snapshot state
        while (n < nMax) {
            bodyStateForTarget(target, _bs, predEphem);
            bpPos[n * 3] = _bs.x * K;
            bpPos[n * 3 + 1] = 0;
            bpPos[n * 3 + 2] = -_bs.y * K;
            n++;
            advanceEphemSnapshotKepler(predEphem, step, false);
        }
    } finally {
        endPredictionBH();
    }
    const col = locked ? 0x5f7f98 : target === -2 ? 0xb7d8ff : target === -1 ? 0xffdc8a : 0xf1d36b;
    bodyPredLine.material.opacity = locked ? .18 : .28;
    bodyPredLine.material.color.set(col);
    bodyPredDots.material.opacity = locked ? .1 : .16;
    bodyPredDots.material.color.set(col);
    bodyPredLine.visible = n > 1;
    bodyPredDots.visible = n > 1;
    markAttrFull(bpPosAttr, n);
    bpGeom.setDrawRange(0, n);
    if (PERF.enabled) markPerf("bodyPrediction", performance.now() - t0, { target, steps: n, locked });
}

// ---- velocity & flow arrows ----
export const arrPos = new Float32Array(6);
const arrG = new THREE.BufferGeometry();
export const arrAttr = new THREE.BufferAttribute(arrPos, 3); arrAttr.setUsage(THREE.DynamicDrawUsage);
arrG.setAttribute("position", arrAttr);
export const arrow = new THREE.Line(arrG, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .92 }));
arrow.renderOrder = 4; arrow.frustumCulled = false;
scene.add(arrow);
export const flArrPos = new Float32Array(6);
const flArrG = new THREE.BufferGeometry();
export const flArrAttr = new THREE.BufferAttribute(flArrPos, 3); flArrAttr.setUsage(THREE.DynamicDrawUsage);
flArrG.setAttribute("position", flArrAttr);
export const flowArrow = new THREE.Line(flArrG, new THREE.LineBasicMaterial({ color: 0x8fd8ff, transparent: true, opacity: 0 }));
flowArrow.renderOrder = 4; flowArrow.frustumCulled = false;
scene.add(flowArrow);
export const deArrPos = new Float32Array(6);
const deArrG = new THREE.BufferGeometry();
export const deArrAttr = new THREE.BufferAttribute(deArrPos, 3); deArrAttr.setUsage(THREE.DynamicDrawUsage);
deArrG.setAttribute("position", deArrAttr);
export const darkEnergyArrow = new THREE.Line(deArrG, new THREE.LineBasicMaterial({ color: 0xbd72ff, transparent: true, opacity: 0 }));
darkEnergyArrow.renderOrder = 4; darkEnergyArrow.frustumCulled = false;
scene.add(darkEnergyArrow);
export const haloArrPos = new Float32Array(6);
const haloArrG = new THREE.BufferGeometry();
export const haloArrAttr = new THREE.BufferAttribute(haloArrPos, 3); haloArrAttr.setUsage(THREE.DynamicDrawUsage);
haloArrG.setAttribute("position", haloArrAttr);
export const haloArrow = new THREE.Line(haloArrG, new THREE.LineBasicMaterial({ color: 0x62e0a8, transparent: true, opacity: 0 }));
haloArrow.renderOrder = 4; haloArrow.frustumCulled = false;
scene.add(haloArrow);
export const tipV = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(255,120,80,1)", "rgba(255,80,40,0.4)"), transparent: true, depthWrite: false }));
export const tipF = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(160,225,255,1)", "rgba(120,200,255,0.4)"), transparent: true, depthWrite: false }));
export const tipDE = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(215,150,255,1)", "rgba(165,90,255,0.4)"), transparent: true, depthWrite: false }));
export const tipHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(125,255,190,1)", "rgba(60,190,135,0.35)"), transparent: true, depthWrite: false }));
tipV.renderOrder = 5; tipF.renderOrder = 5; tipDE.renderOrder = 5; tipHalo.renderOrder = 5;
scene.add(tipV, tipF, tipDE, tipHalo);
