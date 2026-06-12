import * as THREE from "three";
import {
    R_EARTH, R_MOON, R_SUN, SUN_RADIUS, PL, K, SOI_M, BH_MAX,
    MAIN_A, RCS_A, BOOST, ROT_RATE, MU_E, MU_M, MU_S,
} from "./constants.js";
import { G, WORLD, keys, BH, resetShip, destroyBody, isBodyDestroyed, addGhost, rebaseBHEvents } from "./state.js";
import { eph, moonState, planetVel, sunVel, resetEphem, advanceEphem } from "./ephemeris.js";
import { initPhysicsHooks, advance, snapLanded, orbitInfo, sampleAero } from "./physics.js";
import { fmtMET, fmtKm, clamp01, smooth01, speedColor } from "./format.js";
import { loadAllMaps } from "./textures.js";
import { scene, camera, composer, cam, applyCamera, cvHost, put, project, lastPtr } from "./scene.js";
import {
    buildBodies, sunPos, sunLight, sunCore, sunGlow, sky, earthG, clouds, moon, moonOrbitRing, moonSoiRing,
    plGroups, plGlows, plOrbitRings, plLabels,
} from "./bodies.js";
import {
    shipG, craft, dot, flame, plasma, updateHeadingArrow,
    EXN, exPos, exVel, exLife, exMax, exCol, exPosAttr, exColAttr, exMat, spawnExhaust,
    XPN, xpPos, xpVel, xpLife, xpCol, xpPosAttr, xpColAttr, xpMat, explosion, xpFlash, xp, triggerExplosion,
} from "./ship.js";
import {
    pushTrail, pushJourney, setJourneyOpacity, clearTrail, computePrediction,
    computeBodyPrediction, clearBodyPrediction,
    arrPos, arrAttr, arrow, flArrPos, flArrAttr, flowArrow, tipV, tipF,
} from "./trails.js";
import { flowCtx, flowVel } from "./flowfield.js";
import { initRiver, updateRiver, updateShells, river } from "./river.js";
import { initBHHooks, updateBHVisuals, addBlackHole, bhAdvance } from "./blackholes.js";
import { thrustGain, boom } from "./audio.js";
import { award, toast, renderObjectives } from "./achievements.js";
import {
    showBanner, hideBanner, updateHUD, updateEscapeTracker, hideHelp,
    fFlow, lblE, lblM, lblO, lblS,
} from "./hud.js";
import { initInput, setFocus, blackHoleFocusIndex } from "./input.js";

// ============================ WIRING ============================
function die(reason, swallowed) {
    if (G.dead) return;
    G.dead = true; G.deadReason = reason;
    G.deathT = G.t;
    G.deathRt = performance.now();
    G.observerMode = false;
    if (!swallowed) { // black-hole loss suppresses the explosion effect
        const cd = camera.position.distanceTo(shipG.position);
        const cs = Math.min(2.4, Math.max(.012, cd * .02));
        triggerExplosion(G.x * K, 0, -G.y * K, cs);
        boom();
    }
    showBanner("VEHICLE LOST", reason + " · MET " + fmtMET(G.t) + " · max Earth distance " + fmtKm(G.maxRE) + " · Δv used " + Math.round(G.dvUsed) + " m/s", "R TO REBUILD SHIP");
}
function restart() {
    resetEphem();
    resetShip();
    rebaseBHEvents(); // clock rewound to 0: surviving holes count as long-established
    clearTrail();
    hideBanner();
    explosion.visible = false; xpFlash.visible = false; xp.t = -1;
    pushTrail(true);
    computePrediction();
}
initPhysicsHooks({ die, award, banner: showBanner, hideBanner });
initBHHooks({
    toast, predict: computePrediction,
    cataclysm(target, rs, mode, bi = -1) {
        const name = markBodyDestroyed(target, mode + " by r_s " + fmtKm(rs), true, false);
        award("bh");
        if (bi >= 0) focusBlackHole(bi);
        if (name) toast(name + " absorbed by black hole · r_s now " + fmtKm(rs));
    },
    // blackholes.js carries the mass through phantom → hole event → ghost,
    // so the BH paths skip the generic destruction ghost
    disrupt(target, rs, mode, bi = -1) {
        const name = markBodyDestroyed(target, mode + " by r_s " + fmtKm(rs), false, false) || bodyName(target);
        award("bh");
        if (bi >= 0) focusBlackHole(bi);
        if (name) toast(name + " is being tidally shredded");
        return name;
    },
    absorbed(target, rs, bi = -1) {
        const name = markBodyDestroyed(target, "mass absorbed by r_s " + fmtKm(rs), false, false) || bodyName(target);
        if (bi >= 0) focusBlackHole(bi);
        toast((name || "Body") + " mass absorbed · r_s now " + fmtKm(rs));
    },
});
initInput({ restart });

// ============================ INIT ============================
const maps = await loadAllMaps();
buildBodies(maps);
const plPosArr = plGroups.map(g => g.position);
initRiver();
resetEphem();
resetShip();
renderObjectives();
pushTrail(true);
computePrediction();

const BODY_NONE = -99, BODY_EARTH = -3, BODY_MOON = -2, BODY_SUN = -1;
let hoverBodyTarget = BODY_NONE, lockedBodyTarget = BODY_NONE, labelHoverTarget = BODY_NONE, labelPtr = null;
function bodyScenePos(target) {
    return target === BODY_EARTH ? earthG.position : target === BODY_MOON ? moon.position : target === BODY_SUN ? sunCore.position : target >= 0 ? plGroups[target].position : null;
}
function bodyName(target) {
    return target === "earth" || target === BODY_EARTH ? "Earth" :
        target === "moon" || target === BODY_MOON ? "Moon" :
            target === "sun" || target === BODY_SUN ? "Sun" :
                typeof target === "number" && target >= 0 ? PL[target].name : "";
}
function bodyKey(target) {
    return target === BODY_EARTH ? "earth" :
        target === BODY_MOON ? "moon" :
            target === BODY_SUN ? "sun" : target;
}
function isTargetDestroyed(target) { return isBodyDestroyed(bodyKey(target)); }
function lockBodyPrediction(target) {
    if (isTargetDestroyed(target)) return;
    lockedBodyTarget = target;
    const minTrackDist = target === BODY_EARTH ? R_EARTH * K * 80 : target === BODY_MOON ? R_MOON * K * 80 : target === BODY_SUN ? SUN_RADIUS * 12 : PL[target].R * K * 65;
    cam.dist = Math.max(cam.dist, minTrackDist);
    computeBodyPrediction(target, true);
}
function focusAndLockBody(target, focusValue) {
    const keepDist = cam.dist;
    setFocus(focusValue);
    cam.dist = Math.max(cam.dist, keepDist);
    lockBodyPrediction(target);
}
function unlockBodyPrediction() {
    lockedBodyTarget = BODY_NONE;
    clearBodyPrediction();
}
function bodyPhys(target) {
    const key = bodyKey(target);
    if (key === "earth") return { x: 0, y: 0, vx: 0, vy: 0, mu: MU_E, R: R_EARTH };
    if (key === "moon") return { x: eph.moonX, y: eph.moonY, vx: eph.moonVx, vy: eph.moonVy, mu: MU_M, R: R_MOON };
    if (key === "sun") return { x: eph.sunX, y: eph.sunY, vx: eph.sunVx, vy: eph.sunVy, mu: MU_S, R: R_SUN };
    if (typeof key === "number") return { x: eph.plX[key], y: eph.plY[key], vx: eph.plVx[key], vy: eph.plVy[key], mu: PL[key].mu, R: PL[key].R };
    return null;
}
function markBodyDestroyed(target, reason, refocus = true, ghost = true) {
    const key = bodyKey(target);
    if (isBodyDestroyed(key)) return "";
    // the news that the mass is gone expands outward at c; far regions keep
    // feeling the old field until the front reaches them
    const phys = ghost ? bodyPhys(target) : null;
    destroyBody(key);
    if (phys) addGhost(phys.x, phys.y, phys.vx, phys.vy, phys.mu, phys.R, G.t);
    const name = bodyName(target);
    if (lockedBodyTarget !== BODY_NONE && bodyKey(lockedBodyTarget) === key) unlockBodyPrediction();
    if (G.landed && ((key === "earth" && G.landed.body === "earth") ||
        (key === "moon" && G.landed.body === "moon") ||
        (typeof key === "number" && G.landed.body === "planet" && G.landed.i === key))) {
        G.landed = null;
        die("Surface body destroyed: " + name + " · " + reason, true);
    }
    if (refocus && ((G.focus === "earth" && key === "earth") || (G.focus === "moon" && key === "moon") ||
        (G.focus === "sun" && key === "sun") || (typeof G.focus === "number" && G.focus === key))) {
        setTimeout(() => focusNearestSurvivor(), 0);
    }
    return name;
}
const _focusOrigin = new THREE.Vector3(), _focusPos = new THREE.Vector3();
const _bhFocusPos = new THREE.Vector3(), _bhLabelPos = new THREE.Vector3();
const bhFocusValue = i => "bh:" + i;
function bhScenePos(i, out = _bhFocusPos) {
    return out.set((eph.earthX + BH.x[i]) * K, 0, -(eph.earthY + BH.y[i]) * K);
}
function isBHTarget(target) { return blackHoleFocusIndex(target) >= 0; }
function targetBHIndex(target) { return blackHoleFocusIndex(target); }
function addFocusCandidate(list, target, focus, pos, minDist) {
    if (!isTargetDestroyed(target)) list.push({ name: bodyName(target), target, focus, pos: pos.clone(), minDist });
}
function focusNearestSurvivor() {
    const sx = (eph.earthX + G.x) * K, sz = -(eph.earthY + G.y) * K;
    _focusOrigin.set(sx, 0, sz);
    const cands = [];
    addFocusCandidate(cands, BODY_EARTH, "earth", earthG.position, R_EARTH * K * 18);
    addFocusCandidate(cands, BODY_MOON, "moon", moon.position, R_MOON * K * 32);
    addFocusCandidate(cands, BODY_SUN, "sun", sunCore.position, SUN_RADIUS * 4);
    for (let i = 0; i < PL.length; i++) addFocusCandidate(cands, i, i, plGroups[i].position, PL[i].R * K * 18);
    for (let i = 0; i < BH.n; i++) {
        bhScenePos(i, _focusPos);
        cands.push({ name: "Black hole", target: bhFocusValue(i), focus: bhFocusValue(i), pos: _focusPos.clone(), minDist: Math.max(80, BH.rs[i] * K * 16) });
    }
    let best = null, bestD = Infinity;
    for (const c of cands) {
        const d = c.pos.distanceTo(_focusOrigin);
        if (d < bestD) { bestD = d; best = c; }
    }
    if (!best) return null;
    if (isBHTarget(best.focus)) focusBlackHole(targetBHIndex(best.focus));
    else focusAndLockBody(best.target, best.focus);
    return best.name;
}
function focusBlackHole(i) {
    if (i < 0 || i >= BH.n) return;
    G.focus = bhFocusValue(i);
    cam.tgt.copy(bhScenePos(i));
    // keep the player's zoom level; only push out far enough to stay outside
    // the hole (clamping the distance down reset the view scale on every
    // absorption/disruption event)
    cam.dist = Math.max(cam.dist, Math.max(80, BH.rs[i] * K * 12));
    unlockBodyPrediction();
}
function enterObserverMode() {
    if (!G.dead || G.observerMode) return;
    G.observerMode = true;
    hideBanner();
    const name = focusNearestSurvivor();
    toast("Observer mode" + (name ? " · watching " + name : "") + " · R rebuilds the ship");
}
function bindBodyLabel(el, target, onClick) {
    el.onclick = onClick;
    el.addEventListener("pointerenter", e => { labelHoverTarget = target; labelPtr = [e.clientX, e.clientY]; });
    el.addEventListener("pointermove", e => { labelHoverTarget = target; labelPtr = [e.clientX, e.clientY]; });
    el.addEventListener("pointerleave", () => { if (labelHoverTarget === target) { labelHoverTarget = BODY_NONE; labelPtr = null; } });
}

// label click → camera focus + body prediction lock
bindBodyLabel(lblE, BODY_EARTH, () => focusAndLockBody(BODY_EARTH, "earth"));
bindBodyLabel(lblM, BODY_MOON, () => focusAndLockBody(BODY_MOON, "moon"));
bindBodyLabel(lblS, BODY_SUN, () => focusAndLockBody(BODY_SUN, "sun"));
lblO.onclick = () => { setFocus("ship"); unlockBodyPrediction(); };
plLabels.forEach((sp, i) => { bindBodyLabel(sp, i, () => focusAndLockBody(i, i)); });
const bhLabels = Array.from({ length: BH_MAX }, (_, i) => {
    const el = document.createElement("span");
    el.className = "lbl bhLbl";
    el.style.color = "#c9b6ff";
    el.textContent = "BH " + (i + 1);
    document.getElementById("root").appendChild(el);
    bindBodyLabel(el, bhFocusValue(i), () => focusBlackHole(i));
    return el;
});

function bodyContactList() {
    const list = [];
    if (!WORLD.earthDestroyed) list.push({ target: "earth", name: "Earth", x: 0, y: 0, vx: 0, vy: 0, R: R_EARTH, mu: MU_E });
    if (!WORLD.moonDestroyed) list.push({ target: "moon", name: "Moon", x: eph.moonX, y: eph.moonY, vx: eph.moonVx, vy: eph.moonVy, R: R_MOON, mu: MU_M });
    if (!WORLD.sunDestroyed) list.push({ target: "sun", name: "Sun", x: eph.sunX, y: eph.sunY, vx: eph.sunVx, vy: eph.sunVy, R: R_SUN, mu: MU_S });
    for (let i = 0; i < PL.length; i++) if (!WORLD.plDestroyed[i]) list.push({ target: i, name: PL[i].name, x: eph.plX[i], y: eph.plY[i], vx: eph.plVx[i], vy: eph.plVy[i], R: PL[i].R, mu: PL[i].mu });
    return list;
}
function rocheLimit(big, small) {
    const rhoRatio = (big.mu / Math.pow(big.R, 3)) / Math.max(1e-12, small.mu / Math.pow(small.R, 3));
    return Math.min(big.R * 60, 2.44 * big.R * Math.cbrt(rhoRatio));
}
function checkBodyContacts() {
    const bodies = bodyContactList();
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const rel = Math.hypot(a.vx - b.vx, a.vy - b.vy);
        const sumR = a.R + b.R;
        const big = a.mu >= b.mu ? a : b;
        const small = big === a ? b : a;
        if (d <= sumR) {
            const esc = Math.sqrt(2 * (a.mu + b.mu) / Math.max(1, sumR));
            const ratio = small.mu / big.mu;
            const smallName = markBodyDestroyed(small.target, "impact with " + big.name);
            if (smallName) toast(smallName + " destroyed by impact with " + big.name + " · " + rel.toFixed(2) + " km/s");
            if (ratio > .2 || rel > esc) {
                const bigName = markBodyDestroyed(big.target, "high-energy impact with " + small.name);
                if (bigName) toast(bigName + " destroyed by high-energy impact · " + rel.toFixed(2) + " km/s");
            }
            return;
        }
        const roche = rocheLimit(big, small);
        if (d < roche) {
            const smallName = markBodyDestroyed(small.target, "tidal disruption near " + big.name);
            if (smallName) toast(smallName + " torn apart near " + big.name + " · Roche " + fmtKm(roche));
            return;
        }
    }
}

// ---- URL test/share harness: ?dist=&yaw=&pitch=&warp=&vmul=&simt=&bh=&hidehelp=1 ----
{
    const q = new URLSearchParams(location.search);
    if (q.get("bh")) for (const s of q.get("bh").split(";")) {
        const [bx, by, brs] = s.split(":").map(Number);
        if (isFinite(bx) && isFinite(by) && brs > 0) addBlackHole(bx, by, brs);
    }
    if (q.get("vmul")) { const m = +q.get("vmul"); G.vx *= m; G.vy *= m; }
    if (q.get("simt")) {
        const target = +q.get("simt");
        let guard = 0;
        while (G.t < target && !G.dead && !G.landed && guard++ < 4000) {
            advance(Math.min(21600, target - G.t), 0, 0, 0);
            pushTrail(false); pushJourney();
        }
        computePrediction();
    }
    if (q.get("warp")) G.warp = +q.get("warp");
    if (q.get("focus")) { const f = q.get("focus"); G.focus = /^\d+$/.test(f) ? +f : f; }
    if (q.get("dist")) cam.dist = +q.get("dist");
    if (q.get("yaw")) cam.yaw = +q.get("yaw");
    if (q.get("pitch")) cam.pitch = +q.get("pitch");
    if (q.get("hidehelp")) hideHelp();
    if (q.get("probe")) setInterval(() => {
        const bhD = [];
        for (let i = 0; i < BH.n; i++) bhD.push(Math.round(Math.hypot(BH.x[i], BH.y[i])));
        document.getElementById("hint").textContent = "PROBE " + JSON.stringify({
            t: Math.round(G.t), rE: Math.round(Math.hypot(G.x, G.y)),
            v: +Math.hypot(G.vx, G.vy).toFixed(4), dv: Math.round(G.dvUsed),
            dead: G.dead, bhRE: bhD, bhN: BH.n,
        });
    }, 400);
}

// ---- hover: body velocity readout + direction arrow ----
const hoverTipEl = document.getElementById("hoverTip");
const hovLinePos = new Float32Array(6);
const hovLineGeom = new THREE.BufferGeometry();
const hovLineAttr = new THREE.BufferAttribute(hovLinePos, 3);
hovLineAttr.setUsage(THREE.DynamicDrawUsage);
hovLineGeom.setAttribute("position", hovLineAttr);
const hovLine = new THREE.Line(hovLineGeom, new THREE.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: .9, depthTest: false }));
hovLine.frustumCulled = false; hovLine.renderOrder = 6; hovLine.visible = false;
const hovCone = new THREE.Mesh(new THREE.ConeGeometry(1, 2.6, 10), new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: .9, depthTest: false }));
hovCone.frustumCulled = false; hovCone.renderOrder = 6; hovCone.visible = false;
scene.add(hovLine, hovCone);
const _hv = { vx: 0, vy: 0 };
const upHover = new THREE.Vector3(0, 1, 0);
const hovDir = new THREE.Vector3();
// candidates: negative indices are Earth/Moon/Sun; 0..6 are planets
function hoverVelocity(idx, out) {
    if (idx === BODY_EARTH) { out.vx = eph.earthVx; out.vy = eph.earthVy; }
    else if (idx === BODY_SUN) { sunVel(out); out.vx += eph.earthVx; out.vy += eph.earthVy; }
    else if (idx === BODY_MOON) { moonState(G.t, _m); out.vx = eph.earthVx + _m.vmx; out.vy = eph.earthVy + _m.vmy; }
    else { planetVel(idx, G.t, out); out.vx += eph.earthVx; out.vy += eph.earthVy; }
    return out;
}
function updateHover(w, h) {
    let best = BODY_NONE, bestD = 18, bestPos = null;
    const ptr = labelPtr || lastPtr;
    if (labelHoverTarget !== BODY_NONE && (isBHTarget(labelHoverTarget) ? targetBHIndex(labelHoverTarget) < BH.n : !isTargetDestroyed(labelHoverTarget))) {
        best = labelHoverTarget;
        bestPos = isBHTarget(best) ? bhScenePos(targetBHIndex(best), _bhFocusPos) : bodyScenePos(best);
    } else if (lastPtr) {
        const cands = [];
        if (!WORLD.earthDestroyed) cands.push([BODY_EARTH, earthG.position]);
        if (!WORLD.sunDestroyed) cands.push([BODY_SUN, sunCore.position]);
        if (!WORLD.moonDestroyed) cands.push([BODY_MOON, moon.position]);
        for (let i = 0; i < PL.length; i++) if (!WORLD.plDestroyed[i]) cands.push([i, plGroups[i].position]);
        for (let i = 0; i < BH.n; i++) cands.push([bhFocusValue(i), bhScenePos(i, _bhLabelPos).clone()]);
        for (const [idx, pos] of cands) {
            const pr = project(pos, w, h);
            if (!pr) continue;
            const d = Math.hypot(pr[0] - lastPtr[0], pr[1] - lastPtr[1]);
            if (d < bestD) { bestD = d; best = idx; bestPos = pos; }
        }
    }
    if (best === BODY_NONE || !bestPos) {
        hoverBodyTarget = BODY_NONE;
        hoverTipEl.style.display = "none";
        hovLine.visible = false; hovCone.visible = false;
        return;
    }
    hoverBodyTarget = best;
    if (isBHTarget(best)) {
        const bi = targetBHIndex(best);
        _hv.vx = eph.earthVx + BH.vx[bi];
        _hv.vy = eph.earthVy + BH.vy[bi];
    } else hoverVelocity(best, _hv);
    const v = Math.hypot(_hv.vx, _hv.vy);
    const name = isBHTarget(best) ? "BH " + (targetBHIndex(best) + 1) :
        best === BODY_EARTH ? "EARTH" : best === BODY_SUN ? "SUN" : best === BODY_MOON ? "MOON" : PL[best].name;
    let txt = name + " — " + v.toFixed(2) + " km/s";
    if (best >= 0) txt += " · helio " + Math.hypot(_hv.vx - (eph.earthVx + eph.sunVx), _hv.vy - (eph.earthVy + eph.sunVy)).toFixed(2) + " km/s";
    if (isBHTarget(best)) txt += " · r_s " + fmtKm(BH.rs[targetBHIndex(best)]);
    if (lockedBodyTarget === best) txt += " · LOCKED";
    if (G.focus === best) txt += " · FOCUS";
    hoverTipEl.textContent = txt;
    hoverTipEl.style.display = "block";
    hoverTipEl.style.left = (ptr[0] + 16) + "px";
    hoverTipEl.style.top = (ptr[1] + 12) + "px";
    // direction arrow: where the body is heading in this frame
    const dCam = camera.position.distanceTo(bestPos);
    const len = dCam * .15;
    hovDir.set(_hv.vx, 0, -_hv.vy).normalize();
    hovLinePos[0] = bestPos.x; hovLinePos[1] = bestPos.y; hovLinePos[2] = bestPos.z;
    hovLinePos[3] = bestPos.x + hovDir.x * len; hovLinePos[4] = bestPos.y; hovLinePos[5] = bestPos.z + hovDir.z * len;
    hovLineAttr.needsUpdate = true;
    hovCone.position.set(hovLinePos[3], hovLinePos[4], hovLinePos[5]);
    hovCone.scale.setScalar(dCam * .006);
    hovCone.quaternion.setFromUnitVectors(upHover, hovDir);
    hovLine.visible = true; hovCone.visible = true;
}

// ============================ MAIN LOOP ============================
const clock = new THREE.Clock();
const earthV = new THREE.Vector3(), moonV = new THREE.Vector3(), velV = new THREE.Vector3(), upV = new THREE.Vector3(0, 1, 0), dirV = new THREE.Vector3();
const camPrevTgt = new THREE.Vector3(), camDelta = new THREE.Vector3();
let camPrevFocus = null;
const _m = { mx: 0, my: 0, vmx: 0, vmy: 0, ang: 0 };
const arrC = [0, 0, 0];
const fv = [0, 0, 0];
let placed = false, frameNo = 0, grB = 0, exAcc = 0;
const DIR_FADE_START_KMS = 55, DIR_FADE_END_KMS = 90;

function frame() {
    requestAnimationFrame(frame);
    const dtR = Math.min(.06, clock.getDelta());
    frameNo++;
    if (G.dead && !G.observerMode && performance.now() - G.deathRt >= 2000) enterObserverMode();
    // ---- input → attitude & thrust ----
    const rotIn = ((keys.has("KeyA") || keys.has("ArrowLeft")) ? 1 : 0) - ((keys.has("KeyD") || keys.has("ArrowRight")) ? 1 : 0);
    if (rotIn) { G.hold = null; G.heading += rotIn * ROT_RATE * dtR; }
    if (!G.landed) {
        if (G.hold === "pro") G.heading = Math.atan2(G.vy, G.vx);
        else if (G.hold === "retro") G.heading = Math.atan2(-G.vy, -G.vx);
    }
    const mainIn = (keys.has("KeyW") || keys.has("ArrowUp")) ? 1 : ((keys.has("KeyS") || keys.has("ArrowDown")) ? -1 : 0);
    const latIn = (keys.has("KeyE") ? 1 : 0) - (keys.has("KeyQ") ? 1 : 0);
    G.boost = keys.has("ShiftLeft") || keys.has("ShiftRight");
    let atx = 0, aty = 0, aMag = 0;
    const canThrust = !G.dead && !G.paused && (G.infinite || G.fuel > 0);
    if (canThrust && (mainIn || latIn)) {
        const mult = G.boost ? BOOST : 1;
        const hx = Math.cos(G.heading), hy = Math.sin(G.heading);
        if (mainIn) { const a = MAIN_A * G.throttle * mult * mainIn; atx += a * hx; aty += a * hy; }
        if (latIn) { const a = RCS_A * mult * latIn; atx += -a * hy; aty += a * hx; }
        aMag = Math.hypot(atx, aty);
        if (G.landed && mainIn > 0) {
            // liftoff: nudge off the surface and hand back to physics
            let radial;
            if (G.landed.body === "earth") radial = Math.atan2(G.y, G.x);
            else if (G.landed.body === "planet") radial = Math.atan2(G.y - eph.plY[G.landed.i], G.x - eph.plX[G.landed.i]);
            else { moonState(G.t, _m); radial = Math.atan2(G.y - _m.my, G.x - _m.mx); }
            G.x += 0.03 * Math.cos(radial); G.y += 0.03 * Math.sin(radial);
            G.landed = null;
            hideBanner();
        }
    }
    // ---- physics ----
    let advanced = 0;
    if (!G.paused) {
        if (G.dead) {
            advanced = dtR * G.warp;
            advanceEphem(advanced);
            bhAdvance(advanced, G.t);
            G.t += advanced;
        } else if (G.landed) {
            advanced = dtR * G.warp;
            advanceEphem(advanced);
            bhAdvance(advanced, G.t);
            G.t += advanced;
        } else advanced = advance(dtR * G.warp, atx, aty, aMag);
    }
    snapLanded();
    const oi = orbitInfo();
    checkBodyContacts();
    // achievements
    if (!G.dead) {
        if (!oi.domMoon && oi.E < 0 && oi.ra > 100000 + R_EARTH) award("highE");
        if (oi.rE > 400171) award("record");
        if (oi.rM < SOI_M) award("soi");
        if (oi.rM < R_MOON + 5000) award("flyby");
        if (oi.domMoon && oi.E < 0 && oi.ra < SOI_M) award("orbitM");
        if (oi.rE > 1e6) award("interplanetary");
        if (oi.domPl) award("planet");
        if (oi.rS < R_SUN * 3) award("sun");
    }
    // ---- scene positions ----
    const earthX = eph.earthX * K, earthZ = -eph.earthY * K;
    earthV.set(earthX, 0, earthZ);
    earthG.position.copy(earthV);
    earthG.visible = !WORLD.earthDestroyed;
    clouds.visible = !WORLD.earthDestroyed;
    moonOrbitRing.position.copy(earthV);
    moonOrbitRing.visible = !WORLD.earthDestroyed && !WORLD.moonDestroyed;
    moonState(G.t, _m);
    moonV.set((eph.earthX + _m.mx) * K, 0, -(eph.earthY + _m.my) * K);
    moon.position.copy(moonV);
    moon.visible = !WORLD.moonDestroyed;
    moon.rotation.y = _m.ang + Math.PI * .5;
    moonSoiRing.position.copy(moonV);
    // sun & planets follow the live ephemeris (cache refreshed by orbitInfo above)
    sunPos.set((eph.earthX + eph.sunX) * K, 0, -(eph.earthY + eph.sunY) * K);
    sunCore.position.copy(sunPos);
    sunGlow.position.copy(sunPos);
    sunLight.position.copy(sunPos);
    sunCore.visible = !WORLD.sunDestroyed;
    sunGlow.visible = !WORLD.sunDestroyed;
    sunLight.visible = !WORLD.sunDestroyed;
    flowCtx.earthScX = earthX; flowCtx.earthScZ = earthZ;
    flowCtx.sunScX = sunPos.x; flowCtx.sunScZ = sunPos.z;
    for (let i = 0; i < PL.length; i++) {
        const px = (eph.earthX + eph.plX[i]) * K, pz = -(eph.earthY + eph.plY[i]) * K;
        plGroups[i].position.set(px, 0, pz);
        plGlows[i].position.set(px, 0, pz);
        plOrbitRings[i].position.copy(sunPos);
        plGroups[i].visible = !WORLD.plDestroyed[i];
        plGlows[i].visible = !WORLD.plDestroyed[i];
        plOrbitRings[i].visible = !WORLD.plDestroyed[i] && !WORLD.sunDestroyed;
        flowCtx.plScX[i] = px; flowCtx.plScZ[i] = pz;
        const dCamP = camera.position.distanceTo(plGroups[i].position);
        plGlows[i].scale.setScalar(Math.max(PL[i].R * K * 3, dCamP * .011));
    }
    updateBHVisuals(dtR, earthX, earthZ);
    const focusBH = blackHoleFocusIndex(G.focus);
    if (focusBH >= BH.n) setFocus("ship");
    const oriX = (eph.earthX + G.x) * K, oriZ = -(eph.earthY + G.y) * K;
    shipG.position.set(oriX, 0, oriZ);
    shipG.visible = !G.dead;
    clouds.rotation.y += dtR * .01;
    // ---- camera ----
    // "free" focus: the target stays wherever panning put it
    const activeBHFocus = focusBH >= 0 && focusBH < BH.n;
    const tgt = activeBHFocus ? bhScenePos(focusBH) : G.focus === "free" ? cam.tgt : typeof G.focus === "number" ? plGroups[G.focus].position :
        G.focus === "moon" ? moon.position : G.focus === "earth" ? earthG.position : G.focus === "sun" ? sunCore.position : shipG.position;
    if (G.focus !== "free") {
        // rigid-follow the focus body's frame-to-frame motion so fast targets
        // stay centered at any warp; the lerp only glides out the residual
        // offset left by focus transitions and pans
        if (placed && camPrevFocus === G.focus) cam.tgt.add(camDelta.copy(tgt).sub(camPrevTgt));
        cam.tgt.lerp(tgt, placed ? Math.min(1, dtR * 6) : 1);
        camPrevTgt.copy(tgt);
        camPrevFocus = G.focus;
    } else camPrevFocus = null;
    const minD = activeBHFocus ? Math.max(.05, BH.rs[focusBH] * K * 1.3) :
        G.focus === "free" ? .03 : typeof G.focus === "number" ? PL[G.focus].R * K * 1.3 :
        G.focus === "earth" ? R_EARTH * K * 1.3 : G.focus === "moon" ? R_MOON * K * 1.3 : G.focus === "sun" ? SUN_RADIUS * 1.25 : .05;
    cam.dist = Math.max(minD, cam.dist);
    applyCamera();
    placed = true;
    if (sky) sky.position.copy(camera.position);
    const dSun = camera.position.distanceTo(sunPos);
    sunGlow.scale.setScalar(Math.max(SUN_RADIUS * 6, dSun * .018));
    // ---- craft pose & adaptive size ----
    dirV.set(Math.cos(G.heading), 0, -Math.sin(G.heading));
    craft.quaternion.setFromUnitVectors(upV, dirV);
    const cd = camera.position.distanceTo(shipG.position);
    const cs = Math.min(2.4, Math.max(.012, cd * .02));
    const shipSpeed = Math.hypot(G.vx, G.vy);
    const directionAlpha = 1 - smooth01(DIR_FADE_START_KMS, DIR_FADE_END_KMS, shipSpeed);
    craft.scale.setScalar(cs);
    dot.scale.setScalar(cd * .014);
    dot.material.opacity = G.dead ? 0 : (cd > 4 ? 1 : Math.max(0, (cd - 1.2) / 2.8));
    updateHeadingArrow(oriX, oriZ, dirV, cd, !G.dead, directionAlpha);
    // ---- engine flame & exhaust ----
    const thrustingMain = aMag > 0 && mainIn !== 0;
    flame.visible = thrustingMain && !G.dead;
    if (flame.visible) {
        const thrVis = Math.min(2, G.throttle); // visuals saturate; physics doesn't
        const off = -mainIn * cs * 1.05;
        flame.position.set(dirV.x * off, 0, dirV.z * off);
        flame.scale.setScalar(cs * (.7 + .6 * thrVis * (G.boost ? 1.7 : 1)) * (1 + .2 * Math.sin(performance.now() * .03)));
        flame.material.opacity = .9;
        exAcc = Math.min(20, exAcc + Math.min(280, (G.boost ? 170 : 95) * thrVis) * dtR);
        const epx = oriX + dirV.x * off * 1.05, epz = oriZ + dirV.z * off * 1.05;
        while (exAcc > 1) {
            exAcc--;
            spawnExhaust(epx, 0, epz, -dirV.x * mainIn, 0, -dirV.z * mainIn, cs, G.boost);
        }
    }
    // advect exhaust (real-time, cosmetic)
    for (let i = 0; i < EXN; i++) {
        if (exLife[i] > 0) {
            exLife[i] -= dtR;
            exPos[i * 3] += exVel[i * 3] * dtR;
            exPos[i * 3 + 1] += exVel[i * 3 + 1] * dtR;
            exPos[i * 3 + 2] += exVel[i * 3 + 2] * dtR;
            const a = Math.max(0, exLife[i] / exMax[i]);
            exCol[i * 3] = a; exCol[i * 3 + 1] = a * .72; exCol[i * 3 + 2] = a * .4;
        } else { exCol[i * 3] = 0; exCol[i * 3 + 1] = 0; exCol[i * 3 + 2] = 0; }
    }
    exPosAttr.needsUpdate = true;
    exColAttr.needsUpdate = true;
    exMat.size = Math.max(.002, cs * .4);
    // ---- explosion ----
    if (xp.t >= 0) {
        xp.t += dtR;
        for (let i = 0; i < XPN; i++) {
            if (xpLife[i] > 0) {
                xpLife[i] -= dtR;
                xpPos[i * 3] += xpVel[i * 3] * dtR;
                xpPos[i * 3 + 1] += xpVel[i * 3 + 1] * dtR;
                xpPos[i * 3 + 2] += xpVel[i * 3 + 2] * dtR;
                const damp = 1 - .5 * dtR;
                xpVel[i * 3] *= damp; xpVel[i * 3 + 1] *= damp; xpVel[i * 3 + 2] *= damp;
                const a = Math.max(0, Math.min(1, xpLife[i]));
                xpCol[i * 3] = a; xpCol[i * 3 + 1] = a * .65; xpCol[i * 3 + 2] = a * .35;
            } else { xpCol[i * 3] = 0; xpCol[i * 3 + 1] = 0; xpCol[i * 3 + 2] = 0; }
        }
        xpPosAttr.needsUpdate = true;
        xpColAttr.needsUpdate = true;
        xpFlash.scale.setScalar(xpMat.size * 8 * (1 + 7 * xp.t));
        xpFlash.material.opacity = Math.max(0, 1 - xp.t / .7);
        if (xp.t > 3) { explosion.visible = false; xpFlash.visible = false; xp.t = -1; }
    }
    // ---- plasma / aero shake (any atmosphere: Earth, Venus, Mars, giants) ----
    let shake = 0;
    const aero = sampleAero();
    if (aero.aD > 0 && !G.landed && !G.dead) {
        const I = clamp01(aero.aD / 35);
        if (I > .02) {
            plasma.visible = true;
            velV.set(aero.vx, 0, -aero.vy).normalize();
            plasma.position.copy(velV).multiplyScalar(cs * .9);
            plasma.scale.setScalar(cs * (1.6 + 3.4 * I) * (1 + .15 * Math.sin(performance.now() * .05)));
            plasma.material.opacity = Math.min(1, .25 + I);
            shake = I;
        } else plasma.visible = false;
    } else plasma.visible = false;
    if (shake > .03 || (G.boost && aMag > 0)) {
        const s = Math.max(shake, .12) * cam.dist * .006;
        camera.position.x += (Math.random() - .5) * s;
        camera.position.y += (Math.random() - .5) * s;
        camera.position.z += (Math.random() - .5) * s;
    }
    // ---- trails & prediction ----
    if (!G.paused && !G.dead && advanced > 0) { pushTrail(false); pushJourney(); }
    setJourneyOpacity(.85 * smooth01(40, 320, cd));
    if (frameNo % 8 === 0 || aMag > 0) computePrediction();
    // ---- spacetime river (GPU) ----
    const grT = G.gr ? 1 : 0;
    grB += (grT - grB) * Math.min(1, dtR * 3.4);
    if (Math.abs(grT - grB) < .004) grB = grT;
    const fB = grB;
    updateRiver(advanced, fB, earthV, moonV, sunPos, plPosArr, dtR);
    updateShells(river.dtVis ?? advanced, fB, sunPos);
    if (fB > .01) fFlow.textContent = (flowVel(oriX, 0, oriZ, moonV.x, moonV.y, moonV.z, fv) * 1000).toFixed(2) + " km/s";
    moonSoiRing.visible = fB > .01 && !WORLD.moonDestroyed;
    moonSoiRing.material.opacity = fB * (.14 + .1 * Math.sin(performance.now() * .002));
    // ---- velocity & flow vectors (one shared scale) ----
    velV.set(G.vx, 0, -G.vy);
    const sp = shipSpeed;
    let kVLoc = sp;
    if (sp > 1e-9 && !G.dead) {
        const dMo = oi.rM * K;
        const qLoc = fB * (1 - smooth01(14, 56, dMo));
        const lvx = G.vx - qLoc * _m.vmx, lvy = G.vy - qLoc * _m.vmy;
        const kV = Math.hypot(lvx, lvy);
        kVLoc = kV;
        speedColor(kV, arrC);
        arrow.material.color.setRGB(arrC[0], arrC[1], arrC[2]);
        arrow.material.opacity = .92 * directionAlpha;
        const SCL = cd * .06, MAXL = cd * .55;
        const aL = Math.min(MAXL, SCL * kV) / Math.max(1e-9, kV);
        arrPos[0] = oriX; arrPos[1] = 0; arrPos[2] = oriZ;
        arrPos[3] = oriX + lvx * aL; arrPos[4] = 0; arrPos[5] = oriZ - lvy * aL;
        arrAttr.needsUpdate = true;
        arrow.visible = directionAlpha > .03;
        tipV.visible = directionAlpha > .03;
        tipV.position.set(arrPos[3], arrPos[4], arrPos[5]);
        tipV.scale.setScalar(cd * .013);
        tipV.material.color.setRGB(arrC[0], arrC[1], arrC[2]);
        tipV.material.opacity = directionAlpha;
        if (fB > .02) {
            const kF = flowVel(oriX, 0, oriZ, moonV.x, moonV.y, moonV.z, fv) * 1000;
            const fL = Math.min(MAXL, SCL * kF) / Math.max(1e-12, kF * .001);
            flArrPos[0] = oriX; flArrPos[1] = 0; flArrPos[2] = oriZ;
            flArrPos[3] = oriX + fv[0] * fL;
            flArrPos[4] = fv[1] * fL;
            flArrPos[5] = oriZ + fv[2] * fL;
            flArrAttr.needsUpdate = true;
            flowArrow.material.opacity = .95 * fB;
            flowArrow.visible = true;
            tipF.visible = true;
            tipF.position.set(flArrPos[3], flArrPos[4], flArrPos[5]);
            tipF.scale.setScalar(cd * .013);
            tipF.material.opacity = fB;
        } else { flowArrow.visible = false; tipF.visible = false; }
    } else {
        arrow.visible = false; flowArrow.visible = false;
        tipV.visible = false; tipF.visible = false;
    }
    // ---- audio ----
    if (thrustGain) {
        const target = (aMag > 0 && !G.muted) ? Math.min(.22, .04 + .12 * G.throttle * (G.boost ? 1.8 : 1)) : 0;
        thrustGain.gain.value += (target - thrustGain.gain.value) * Math.min(1, dtR * 12);
    }
    // ---- HUD & labels ----
    updateHUD(oi, aMag, mainIn, sp, kVLoc, fB);
    if (frameNo % 5 === 0) updateEscapeTracker(oi);
    const w = cvHost.clientWidth, h = cvHost.clientHeight;
    updateHover(w, h);
    if (frameNo % 18 === 0) {
        if (lockedBodyTarget !== BODY_NONE && isTargetDestroyed(lockedBodyTarget)) unlockBodyPrediction();
        if (lockedBodyTarget !== BODY_NONE) computeBodyPrediction(lockedBodyTarget, true);
        else clearBodyPrediction();
    }
    if (WORLD.earthDestroyed) lblE.style.opacity = "0"; else put(lblE, earthG.position, -8, w, h);
    if (WORLD.moonDestroyed) lblM.style.opacity = "0"; else put(lblM, moon.position, -8, w, h);
    if (WORLD.sunDestroyed) lblS.style.opacity = "0"; else put(lblS, sunCore.position, -8, w, h);
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) plLabels[i].style.opacity = "0";
        else put(plLabels[i], plGroups[i].position, -8, w, h);
    }
    for (let i = 0; i < BH_MAX; i++) {
        if (i >= BH.n) {
            bhLabels[i].style.display = "none";
            bhLabels[i].style.opacity = "0";
        }
        else {
            bhLabels[i].style.display = "block";
            bhLabels[i].textContent = "BH " + (i + 1);
            put(bhLabels[i], bhScenePos(i, _bhLabelPos), -10, w, h);
        }
    }
    if (G.dead) lblO.style.opacity = "0";
    else put(lblO, shipG.position, -22, w, h);
    composer.render();
}
frame();
