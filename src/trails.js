import * as THREE from "three";
import { R_EARTH, R_MOON, R_SUN, PL, K, SOI_M } from "./constants.js";
import {
    eph, moonState,
    snapshotEphem, loadEphemSnapshot, advanceEphemSnapshot,
    bodyStateForTarget,
} from "./ephemeris.js";
import { G, BH } from "./state.js";
import { speedColor } from "./format.js";
import { rk4Step, stepSize } from "./physics.js";
import { dotTexture, ringTexture } from "./textures.js";
import { scene } from "./scene.js";

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
const trail = new THREE.Line(trGeom, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .9 }));
trail.frustumCulled = false;
trail.renderOrder = 3;
scene.add(trail);
let trN = 0;
const _tc = [0, 0, 0];
export function pushTrail(force) {
    const sx = (eph.earthX + G.x) * K, sz = -(eph.earthY + G.y) * K;
    if (trN > 0 && !force) {
        const lx = trPos[(trN - 1) * 3], lz = trPos[(trN - 1) * 3 + 2];
        moonState(G.t, _m);
        let rNear = Math.min(Math.hypot(G.x, G.y), Math.hypot(G.x - _m.mx, G.y - _m.my) * 2.5, Math.hypot(G.x - eph.sunX, G.y - eph.sunY));
        for (let i = 0; i < PL.length; i++) rNear = Math.min(rNear, Math.hypot(G.x - eph.plX[i], G.y - eph.plY[i]));
        const thr = Math.max(.012, Math.min(400, rNear * K * .02));
        if (Math.hypot(sx - lx, sz - lz) < thr) {
            // refresh last point so the line always touches the ship
            trPos[(trN - 1) * 3] = sx; trPos[(trN - 1) * 3 + 2] = sz;
            trPosAttr.needsUpdate = true;
            return;
        }
    }
    if (trN >= TRN) { // keep newest half, decimated
        for (let i = 0; i < TRN / 2; i++) {
            trPos[i * 3] = trPos[(TRN / 2 + i) * 3];
            trPos[i * 3 + 1] = trPos[(TRN / 2 + i) * 3 + 1];
            trPos[i * 3 + 2] = trPos[(TRN / 2 + i) * 3 + 2];
            trCol[i * 3] = trCol[(TRN / 2 + i) * 3];
            trCol[i * 3 + 1] = trCol[(TRN / 2 + i) * 3 + 1];
            trCol[i * 3 + 2] = trCol[(TRN / 2 + i) * 3 + 2];
        }
        trN = TRN / 2;
    }
    speedColor(Math.hypot(G.vx, G.vy), _tc);
    trPos[trN * 3] = sx; trPos[trN * 3 + 1] = 0; trPos[trN * 3 + 2] = sz;
    trCol[trN * 3] = _tc[0]; trCol[trN * 3 + 1] = _tc[1]; trCol[trN * 3 + 2] = _tc[2];
    trN++;
    trPosAttr.needsUpdate = true;
    trColAttr.needsUpdate = true;
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
const journey = new THREE.Line(jrGeom, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
journey.frustumCulled = false;
journey.renderOrder = 3;
scene.add(journey);
let jrN = 0;
export function pushJourney() {
    const sx = (eph.earthX + G.x) * K, sz = -(eph.earthY + G.y) * K;
    if (jrN > 0) {
        const lx = jrPos[(jrN - 1) * 3], lz = jrPos[(jrN - 1) * 3 + 2];
        // spacing scales with distance from Earth: fine in cislunar space,
        // coarse on interplanetary arcs — 6000 points cover ~10 AU of path
        const thr = Math.max(1.2, Math.hypot(sx, sz) * .01);
        if (Math.hypot(sx - lx, sz - lz) < thr) {
            jrPos[(jrN - 1) * 3] = sx; jrPos[(jrN - 1) * 3 + 2] = sz;
            jrPosAttr.needsUpdate = true;
            return;
        }
    }
    if (jrN >= JRN) {
        for (let i = 0; i < JRN / 2; i++) {
            jrPos[i * 3] = jrPos[(JRN / 2 + i) * 3];
            jrPos[i * 3 + 1] = jrPos[(JRN / 2 + i) * 3 + 1];
            jrPos[i * 3 + 2] = jrPos[(JRN / 2 + i) * 3 + 2];
            jrCol[i * 3] = jrCol[(JRN / 2 + i) * 3];
            jrCol[i * 3 + 1] = jrCol[(JRN / 2 + i) * 3 + 1];
            jrCol[i * 3 + 2] = jrCol[(JRN / 2 + i) * 3 + 2];
        }
        jrN = JRN / 2;
    }
    speedColor(Math.hypot(G.vx, G.vy), _tc);
    jrPos[jrN * 3] = sx; jrPos[jrN * 3 + 1] = 0; jrPos[jrN * 3 + 2] = sz;
    // lift the floor so the line stays readable against deep space
    jrCol[jrN * 3] = .3 + .7 * _tc[0]; jrCol[jrN * 3 + 1] = .25 + .65 * _tc[1]; jrCol[jrN * 3 + 2] = .3 + .6 * _tc[2];
    jrN++;
    jrPosAttr.needsUpdate = true;
    jrColAttr.needsUpdate = true;
    jrGeom.setDrawRange(0, jrN);
}
export function setJourneyOpacity(o) { journey.material.opacity = o; }
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
const predLine = new THREE.Line(prGeom, new THREE.LineBasicMaterial({ color: 0x6fd8c8, transparent: true, opacity: .5 }));
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
const _ps = [0, 0, 0, 0];
// per-call time cap so long predictions never hitch a frame — but only after a
// guaranteed minimum of steps, so near-field impact warnings are never starved
// (a cold, un-JITed first call can be slow enough to truncate otherwise)
const PRED_BUDGET_MS = 10, PRED_MIN_STEPS = 600;
// did the segment (x0,y0)→(x1,y1), in body-relative coordinates, pass within R
// of the body center?
function segHit(x0, y0, x1, y1, R) {
    const dx = x1 - x0, dy = y1 - y0;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 1e-12 ? -(x0 * dx + y0 * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = x0 + dx * t, qy = y0 + dy * t;
    return qx * qx + qy * qy < R * R;
}
export function computePrediction() {
    if (!G.predict || G.dead || G.landed) { prGeom.setDrawRange(0, 0); impactSpr.visible = false; ghostMoon.visible = false; caDot.visible = false; return; }
    const liveEphem = snapshotEphem();
    const predEphem = snapshotEphem();
    _ps[0] = G.x; _ps[1] = G.y; _ps[2] = G.vx; _ps[3] = G.vy;
    let pt = G.t, n = 0, minRM = Infinity, caT = 0, caX = 0, caY = 0, caMX = 0, caMY = 0, caEX = 0, caEY = 0, impact = 0;
    const t0 = performance.now();
    try {
        loadEphemSnapshot(predEphem);
        const far = Math.hypot(G.x, G.y) > 2e6;
        const tMax = G.t + 86400 * (far ? 160 : 8);
        let pmx = 0, pmy = 0, pex = 0, pey = 0, hasPrev = false, plNear = false;
        while (n < PRN && pt < tMax) {
            prPos[n * 3] = (predEphem.earthX + _ps[0]) * K; prPos[n * 3 + 1] = 0; prPos[n * 3 + 2] = -(predEphem.earthY + _ps[1]) * K;
            n++;
            if (n > PRED_MIN_STEPS && (n & 31) === 0 && performance.now() - t0 > PRED_BUDGET_MS) break;
            const rE = Math.sqrt(_ps[0] * _ps[0] + _ps[1] * _ps[1]);
            moonState(pt, _m);
            const dmx = _ps[0] - _m.mx, dmy = _ps[1] - _m.my;
            const rM = Math.sqrt(dmx * dmx + dmy * dmy);
            if (rM < minRM) { minRM = rM; caT = pt; caX = _ps[0]; caY = _ps[1]; caMX = _m.mx; caMY = _m.my; caEX = predEphem.earthX; caEY = predEphem.earthY; }
            const dsx = _ps[0] - eph.sunX, dsy = _ps[1] - eph.sunY;
            const rSp = Math.sqrt(dsx * dsx + dsy * dsy);
            if (rE < R_EARTH) { impact = 1; break; }
            if (rM < R_MOON) { impact = 2; break; }
            // grazing chords: a step can jump across a body between samples, so
            // near Earth/Moon also test the closest approach along the segment
            if (hasPrev) {
                if (rM < SOI_M && segHit(pmx, pmy, dmx, dmy, R_MOON)) { impact = 2; break; }
                if (rE < 60000 && segHit(pex, pey, _ps[0], _ps[1], R_EARTH)) { impact = 1; break; }
            }
            pmx = dmx; pmy = dmy; pex = _ps[0]; pey = _ps[1]; hasPrev = true;
            if (rSp < R_SUN) { impact = 3; break; }
            plNear = false;
            for (let pi = 0; pi < PL.length; pi++) {
                const dx = _ps[0] - eph.plX[pi], dy = _ps[1] - eph.plY[pi];
                const d2 = dx * dx + dy * dy;
                if (d2 <= PL[pi].R * PL[pi].R) { impact = 5; break; }
                if (d2 < PL[pi].soi * PL[pi].soi * .25) plNear = true;
            }
            for (let bi = 0; bi < BH.n; bi++) {
                const dx = _ps[0] - BH.x[bi], dy = _ps[1] - BH.y[bi];
                const lim = BH.rs[bi] * 1.5;
                if (dx * dx + dy * dy <= lim * lim) { impact = 4; break; }
            }
            if (impact) break;
            // full fidelity through flybys: the post-encounter path is too
            // sensitive for coarsened steps near the Moon or a planet
            const mult = (rM < SOI_M * 1.5 || plNear) ? 1 : far ? 14 : 3;
            let dt = stepSize(rE, rM, rSp, rE - R_EARTH, Math.hypot(_ps[2], _ps[3]), _ps[0], _ps[1], _ps[2], _ps[3]) * mult;
            dt = Math.max(.5, Math.min(far ? 3200 : 600, dt));
            rk4Step(_ps, 0, dt, 0, 0);
            advanceEphemSnapshot(predEphem, dt);
            pt += dt;
        }
    } finally {
        loadEphemSnapshot(liveEphem);
    }
    prPosAttr.needsUpdate = true;
    prGeom.setDrawRange(0, n);
    if (impact) {
        impactSpr.visible = true;
        impactSpr.position.set(prPos[(n - 1) * 3], 0, prPos[(n - 1) * 3 + 2]);
    } else impactSpr.visible = false;
    if (minRM < 120000 && caT > G.t + 30) {
        ghostMoon.visible = true;
        ghostMoon.position.set((caEX + caMX) * K, 0, -(caEY + caMY) * K);
        caDot.visible = true;
        caDot.position.set((caEX + caX) * K, 0, -(caEY + caY) * K);
    } else { ghostMoon.visible = false; caDot.visible = false; }
}

// ---- hovered / locked body prediction ----
const BPN = 1100;
const bpPos = new Float32Array(BPN * 3);
const bpGeom = new THREE.BufferGeometry();
const bpPosAttr = new THREE.BufferAttribute(bpPos, 3); bpPosAttr.setUsage(THREE.DynamicDrawUsage);
bpGeom.setAttribute("position", bpPosAttr);
bpGeom.setDrawRange(0, 0);
const bodyPredLine = new THREE.Line(bpGeom, new THREE.LineBasicMaterial({ color: 0xf1d36b, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
bodyPredLine.frustumCulled = false;
bodyPredLine.renderOrder = 2;
const bodyPredDots = new THREE.Points(bpGeom, new THREE.PointsMaterial({ color: 0xff4fc3, size: 3.2, sizeAttenuation: false, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
bodyPredDots.frustumCulled = false;
bodyPredDots.renderOrder = 3;
scene.add(bodyPredLine, bodyPredDots);
const _bs = { x: 0, y: 0, vx: 0, vy: 0 };
function bodyPredStep(target) {
    if (target === -3) return 86400;
    if (target === -2) return 1800;
    if (target === -1) return 86400;
    const p = PL[target];
    const period = 2 * Math.PI / Math.max(1e-12, p.n);
    return Math.max(21600, Math.min(86400 * 7, period / 520));
}
export function clearBodyPrediction() {
    bpGeom.setDrawRange(0, 0);
    bodyPredLine.visible = false;
    bodyPredDots.visible = false;
}
export function computeBodyPrediction(target, locked = false) {
    if (target < -3 || target >= PL.length) { clearBodyPrediction(); return; }
    const liveEphem = snapshotEphem();
    const predEphem = snapshotEphem();
    const step = bodyPredStep(target);
    const nMax = target === -2 ? 420 : target === -1 ? 520 : BPN;
    let n = 0;
    try {
        loadEphemSnapshot(predEphem);
        while (n < nMax) {
            bodyStateForTarget(target, _bs, predEphem);
            bpPos[n * 3] = _bs.x * K;
            bpPos[n * 3 + 1] = 0;
            bpPos[n * 3 + 2] = -_bs.y * K;
            n++;
            advanceEphemSnapshot(predEphem, step, step);
        }
    } finally {
        loadEphemSnapshot(liveEphem);
    }
    const col = locked ? 0xff4fc3 : target === -2 ? 0xb7d8ff : target === -1 ? 0xffdc8a : 0xf1d36b;
    bodyPredLine.material.opacity = locked ? .95 : .42;
    bodyPredLine.material.color.set(col);
    bodyPredDots.material.opacity = locked ? .9 : .34;
    bodyPredDots.material.color.set(col);
    bodyPredLine.visible = n > 1;
    bodyPredDots.visible = n > 1;
    bpPosAttr.needsUpdate = true;
    bpGeom.setDrawRange(0, n);
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
export const tipV = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(255,120,80,1)", "rgba(255,80,40,0.4)"), transparent: true, depthWrite: false }));
export const tipF = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(160,225,255,1)", "rgba(120,200,255,0.4)"), transparent: true, depthWrite: false }));
tipV.renderOrder = 5; tipF.renderOrder = 5;
scene.add(tipV, tipF);
