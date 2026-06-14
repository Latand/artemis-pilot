import * as THREE from "three";
import {
    R_EARTH, R_MOON, R_SUN, SUN_RADIUS, PL, K, SOI_M, BH_MAX,
    MAIN_A, RCS_A, BOOST, ROT_RATE, MU_E, MU_M, MU_S, DARK_ENERGY, LY_SCENE, LY_KM, STARS,
    OMEGA_EARTH, FUEL_DV0, warpLabel,
} from "./constants.js";
import { G, WORLD, keys, BH, resetShip, destroyBody, isBodyDestroyed, addGhost, rebaseBHEvents } from "./state.js";
import { eph, moonState, planetVel, sunVel, resetEphem, advanceEphem } from "./ephemeris.js";
import { initPhysicsHooks, advance, snapLanded, orbitInfo, sampleAero } from "./physics.js";
import { fmtMET, fmtKm, fmtDist, clamp01, smooth01, speedColor } from "./format.js";
import { loadAllMaps } from "./textures.js";
import { scene, camera, composer, renderer, bloomPass, cam, applyCamera, cvHost, put, project, lastPtr } from "./scene.js";
import {
    buildBodies, sunPos, sunLight, sunCore, sunGlow, sunCorona, sky, skyStars, earth, earthG, clouds, moon, moonOrbitRing, moonSoiRing,
    plGroups, plSurfaces, plGlows, plOrbitRings, plLabels, galaxyBackdrop, sunDirW, updateBodyShaders,
} from "./bodies.js";
import { addStarVisual, buildStars, updateStars } from "./stars.js";
import { cockpitScene, cockpitCam, look, updateCockpit, setCockpitAspect, mfdScreens, setLeverThrottle } from "./cockpit.js";
import { updateInstruments, mfdTextures } from "./instruments.js";
import { AP, apStep, apOff } from "./autopilot.js";
import {
    shipG, craft, dot, flame, plasma, updateHeadingArrow,
    EXN, exPos, exVel, exLife, exMax, exCol, exPosAttr, exColAttr, exMat, spawnExhaust,
    XPN, xpPos, xpVel, xpLife, xpCol, xpPosAttr, xpColAttr, xpMat, explosion, xpFlash, xp, triggerExplosion,
} from "./ship.js";
import {
    pushTrail, pushJourney, setJourneyOpacity, clearTrail, computePrediction,
    computeBodyPrediction, clearBodyPrediction,
    arrPos, arrAttr, arrow, flArrPos, flArrAttr, flowArrow, deArrPos, deArrAttr, darkEnergyArrow, tipV, tipF, tipDE,
} from "./trails.js";
import { flowCtx, flowVel } from "./flowfield.js";
import { initRiver, updateRiver, updateShells, river } from "./river.js";
import { initCosmicLayer, updateCosmicLayer } from "./cosmic.js";
import { updateLensing } from "./lensing.js";
import { initBHHooks, updateBHVisuals, addBlackHole, bhAdvance } from "./blackholes.js";
import { thrustGain, boom } from "./audio.js";
import { award, toast, renderObjectives } from "./achievements.js";
import {
    showBanner, hideBanner, updateHUD, updateEscapeTracker, hideHelp,
    fFlow, fDark, lblE, lblM, lblO, lblS,
} from "./hud.js";
import { initInput, setFocus, blackHoleFocusIndex, starFocusIndex } from "./input.js";
import { initScenarios } from "./scenarios.js";
import { initHints, hintTick } from "./hints.js";
import { VR, initVR, vrPoll, vrUpdateRigs, renderVRFrame, vrHaptics } from "./vr.js";
import { initCatalogSearch } from "./catalogSearch.js";
import {
    ACTIVE_STARS, activeStarFocusValue, activeStarForFocus, hygCatalogFocusId, hygCatalogFocusValue, hygCatalogStats, nearestActiveStar, proceduralFocusId,
    refreshActiveStars,
} from "./universe/activeStars.js";

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
        triggerExplosion(G.x * K, G.z * K, -G.y * K, cs);
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
initScenarios({ restart });
initHints();
initVR({ restart });

// ============================ INIT ============================
const maps = await loadAllMaps();
buildBodies(maps);
buildStars();
initCosmicLayer(scene);
// hook the live instrument textures onto the cockpit MFD screens
mfdScreens.forEach((scr, i) => {
    scr.material.map = mfdTextures[i];
    scr.material.color.set(0xffffff);
    scr.material.needsUpdate = true;
});
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
    const st = stellarTarget(target);
    return target === "earth" || target === BODY_EARTH ? "Earth" :
        target === "moon" || target === BODY_MOON ? "Moon" :
            target === "sun" || target === BODY_SUN ? "Sun" :
                st ? st.name :
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
    if (key === "earth") return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, mu: MU_E, R: R_EARTH };
    if (key === "moon") return { x: eph.moonX, y: eph.moonY, z: 0, vx: eph.moonVx, vy: eph.moonVy, vz: 0, mu: MU_M, R: R_MOON };
    if (key === "sun") return { x: eph.sunX, y: eph.sunY, z: 0, vx: eph.sunVx, vy: eph.sunVy, vz: 0, mu: MU_S, R: R_SUN };
    if (typeof key === "number") return { x: eph.plX[key], y: eph.plY[key], z: 0, vx: eph.plVx[key], vy: eph.plVy[key], vz: 0, mu: PL[key].mu, R: PL[key].R };
    return null;
}
function markBodyDestroyed(target, reason, refocus = true, ghost = true) {
    const key = bodyKey(target);
    if (isBodyDestroyed(key)) return "";
    // the news that the mass is gone expands outward at c; far regions keep
    // feeling the old field until the front reaches them
    const phys = ghost ? bodyPhys(target) : null;
    destroyBody(key);
    if (phys) addGhost(phys.x, phys.y, phys.z, phys.vx, phys.vy, phys.vz, phys.mu, phys.R, G.t);
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
const _starFocusPos = new THREE.Vector3(), _starLabelPos = new THREE.Vector3();
const bhFocusValue = i => "bh:" + i;
const starFocusValue = i => "star:" + i;
function bhScenePos(i, out = _bhFocusPos) {
    return out.set((eph.earthX + BH.x[i]) * K, 0, -(eph.earthY + BH.y[i]) * K);
}
function starScenePos(i, out = _starFocusPos) {
    return out.set(STARS[i].x * K, (STARS[i].z || 0) * K, -STARS[i].y * K);
}
function activeStarScenePos(star, out = _starFocusPos) {
    return out.set(star.x * K, (star.z || 0) * K, -star.y * K);
}
function isBHTarget(target) { return blackHoleFocusIndex(target) >= 0; }
function targetBHIndex(target) { return blackHoleFocusIndex(target); }
function isStarTarget(target) { return starFocusIndex(target) >= 0; }
function targetStarIndex(target) { return starFocusIndex(target); }
function isDynamicStarTarget(target) { return !!(proceduralFocusId(target) || hygCatalogFocusId(target)); }
function stellarTarget(target) {
    const si = targetStarIndex(target);
    if (si >= 0 && si < STARS.length) return STARS[si];
    return activeStarForFocus(target);
}
function stellarScenePos(target, out = _starFocusPos) {
    const si = targetStarIndex(target);
    if (si >= 0 && si < STARS.length) return starScenePos(si, out);
    const st = activeStarForFocus(target);
    return st ? activeStarScenePos(st, out) : null;
}
function velocityForTarget(target, out) {
    if (isBHTarget(target)) {
        const bi = targetBHIndex(target);
        out.vx = eph.earthVx + BH.vx[bi];
        out.vy = eph.earthVy + BH.vy[bi];
    } else if (stellarTarget(target)) {
        out.vx = 0;
        out.vy = 0;
    } else hoverVelocity(target, out);
    return out;
}
function focusTarget(target) {
    if (isBHTarget(target)) focusBlackHole(targetBHIndex(target));
    else if (stellarTarget(target)) { setFocus(target); unlockBodyPrediction(); }
    else focusAndLockBody(target, target === BODY_EARTH ? "earth" : target === BODY_MOON ? "moon" : target === BODY_SUN ? "sun" : target);
}
function addFocusCandidate(list, target, focus, pos, minDist) {
    if (!isTargetDestroyed(target)) list.push({ name: bodyName(target), target, focus, pos: pos.clone(), minDist });
}
function focusNearestSurvivor() {
    const sx = (eph.earthX + G.x) * K, sy = G.z * K, sz = -(eph.earthY + G.y) * K;
    _focusOrigin.set(sx, sy, sz);
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
const starLabels = [];
function ensureStarLabel(i) {
    if (starLabels[i]) return starLabels[i];
    const star = STARS[i];
    if (!star) return null;
    const el = document.createElement("span");
    el.className = "lbl starLbl";
    el.style.color = "#" + star.color.toString(16).padStart(6, "0");
    el.textContent = star.name;
    document.getElementById("root").appendChild(el);
    bindBodyLabel(el, starFocusValue(i), () => { setFocus(starFocusValue(i)); unlockBodyPrediction(); });
    starLabels[i] = el;
    return el;
}
for (let i = 0; i < STARS.length; i++) ensureStarLabel(i);
initCatalogSearch({
    toast,
    getActiveOrigin() {
        return { wx: eph.earthX + G.x, wy: eph.earthY + G.y, wz: G.z, focus: G.focus };
    },
    onPromote(i, star, existing, reason = "promote") {
        addStarVisual(star);
        ensureStarLabel(i);
        if (reason === "restore") return;
        setFocus(starFocusValue(i));
        unlockBodyPrediction();
        computePrediction();
        toast((existing ? "HYG destination focused · " : "HYG destination promoted · ") + star.name + " · " + star.dLy.toFixed(2) + " ly");
    },
    onFocusCatalog(index, star) {
        addStarVisual(star);
        setFocus(hygCatalogFocusValue(index));
        unlockBodyPrediction();
        computePrediction();
        toast("HYG destination focused · " + star.name + " · " + star.dLy.toFixed(2) + " ly");
    },
    onFocusActive(focus, star, row) {
        addStarVisual(star);
        setFocus(focus);
        unlockBodyPrediction();
        computePrediction();
        toast(row.source + " focused · " + star.name + " · " + (row.dKm / LY_KM).toFixed(2) + " ly");
    },
});

let pickDown = null;
function targetPickRadius(target, pos) {
    const d = camera.position.distanceTo(pos);
    if (isBHTarget(target)) return Math.max(24, Math.min(64, BH.rs[targetBHIndex(target)] * K / Math.max(1e-9, d) * 1200 + 30));
    if (stellarTarget(target)) return 22;
    const r = target === BODY_EARTH ? R_EARTH * K : target === BODY_MOON ? R_MOON * K : target === BODY_SUN ? SUN_RADIUS : PL[target].R * K;
    return Math.max(target === BODY_SUN ? 52 : 24, Math.min(target === BODY_SUN ? 92 : 54, r / Math.max(1e-9, d) * 1500 + 18));
}
function pickSceneTarget(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const w = rect.width || 1, h = rect.height || 1;
    const cands = [];
    if (!WORLD.earthDestroyed) cands.push([BODY_EARTH, earthG.position]);
    if (!WORLD.sunDestroyed) cands.push([BODY_SUN, sunCore.position]);
    if (!WORLD.moonDestroyed) cands.push([BODY_MOON, moon.position]);
    for (let i = 0; i < PL.length; i++) if (!WORLD.plDestroyed[i]) cands.push([i, plGroups[i].position]);
    for (let i = 0; i < BH.n; i++) cands.push([bhFocusValue(i), bhScenePos(i, _bhLabelPos).clone()]);
    if (cam.dist > LY_SCENE * .001) for (let i = 0; i < STARS.length; i++) cands.push([starFocusValue(i), starScenePos(i, _starLabelPos).clone()]);
    if (cam.dist > LY_SCENE * .001) for (const star of ACTIVE_STARS)
        if (star.procedural || star.activeCatalog) cands.push([activeStarFocusValue(star), activeStarScenePos(star, _starLabelPos).clone()]);
    let best = BODY_NONE, bestD = Infinity;
    for (const [target, pos] of cands) {
        const pr = project(pos, w, h);
        if (!pr) continue;
        const d = Math.hypot(pr[0] - x, pr[1] - y);
        if (d < targetPickRadius(target, pos) && d < bestD) { best = target; bestD = d; }
    }
    return best;
}
renderer.domElement.addEventListener("pointerdown", e => {
    if (e.button === 0) pickDown = { x: e.clientX, y: e.clientY, t: performance.now() };
});
renderer.domElement.addEventListener("pointerup", e => {
    if (!pickDown || e.button !== 0 || G.cabin) { pickDown = null; return; }
    const moved = Math.hypot(e.clientX - pickDown.x, e.clientY - pickDown.y);
    const shortClick = moved < 7 && performance.now() - pickDown.t < 420;
    pickDown = null;
    if (!shortClick) return;
    const target = pickSceneTarget(e.clientX, e.clientY);
    if (target !== BODY_NONE) focusTarget(target);
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

// ---- camera persistence: scale / orientation / focus survive a refresh ----
{
    try {
        const saved = JSON.parse(localStorage.getItem("ap_cam") || "null");
        if (saved && isFinite(saved.dist)) {
            cam.dist = saved.dist;
            cam.yaw = saved.yaw ?? cam.yaw;
            cam.pitch = saved.pitch ?? cam.pitch;
            if (saved.focus !== undefined && saved.focus !== "free") G.focus = saved.focus;
            if (isFinite(saved.warp) && saved.warp >= 1) G.warp = saved.warp;
        }
    } catch (e) { }
    const saveCam = () => {
        try {
            localStorage.setItem("ap_cam", JSON.stringify({ dist: cam.dist, yaw: cam.yaw, pitch: cam.pitch, focus: G.focus, warp: G.warp }));
        } catch (e) { }
    };
    setInterval(saveCam, 2500);
    window.addEventListener("beforeunload", saveCam);
}

// ---- URL test/share harness: ?dist=&yaw=&pitch=&warp=&vmul=&simt=&bh=&hidehelp=1 ----
{
    const q = new URLSearchParams(location.search);
    if (q.get("bh")) for (const s of q.get("bh").split(";")) {
        const [bx, by, brs] = s.split(":").map(Number);
        if (isFinite(bx) && isFinite(by) && brs > 0) addBlackHole(bx, by, brs);
    }
    if (q.get("vmul")) { const m = +q.get("vmul"); G.vx *= m; G.vy *= m; G.vz *= m; }
    if (q.get("z")) G.z = +q.get("z");
    if (q.get("vz")) G.vz = +q.get("vz");
    if (q.get("simt")) {
        const target = +q.get("simt");
        let guard = 0;
        while (G.t < target && !G.dead && !G.landed && guard++ < 4000) {
            advance(Math.min(21600, target - G.t), 0, 0, 0, 0);
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
            t: Math.round(G.t), rE: Math.round(Math.hypot(G.x, G.y, G.z)),
            z: +G.z.toFixed(4), vz: +G.vz.toFixed(6),
            v: +Math.hypot(G.vx, G.vy, G.vz).toFixed(4), dv: Math.round(G.dvUsed),
            dead: G.dead, bhRE: bhD, bhN: BH.n,
        });
    }, 400);
}

// ---- hover: body velocity readout + direction arrow ----
const hoverTipEl = document.getElementById("hoverTip");
const cabinHudEl = document.getElementById("cabinHud");
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
const focusVelPos = new Float32Array(6);
const focusVelGeom = new THREE.BufferGeometry();
const focusVelAttr = new THREE.BufferAttribute(focusVelPos, 3);
focusVelAttr.setUsage(THREE.DynamicDrawUsage);
focusVelGeom.setAttribute("position", focusVelAttr);
const focusVelLine = new THREE.Line(focusVelGeom, new THREE.LineBasicMaterial({ color: 0xffc778, transparent: true, opacity: .86, depthTest: false }));
focusVelLine.frustumCulled = false; focusVelLine.renderOrder = 6; focusVelLine.visible = false;
const focusVelCone = new THREE.Mesh(new THREE.ConeGeometry(1, 2.6, 12), new THREE.MeshBasicMaterial({ color: 0xffc778, transparent: true, opacity: .9, depthTest: false }));
focusVelCone.frustumCulled = false; focusVelCone.renderOrder = 6; focusVelCone.visible = false;
scene.add(focusVelLine, focusVelCone);
const _hv = { vx: 0, vy: 0 };
const upHover = new THREE.Vector3(0, 1, 0);
const hovDir = new THREE.Vector3();
const focusVel = { vx: 0, vy: 0 };
const focusVelDir = new THREE.Vector3();
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
    if (labelHoverTarget !== BODY_NONE && (isBHTarget(labelHoverTarget) ? targetBHIndex(labelHoverTarget) < BH.n :
        stellarTarget(labelHoverTarget) ? true : !isTargetDestroyed(labelHoverTarget))) {
        best = labelHoverTarget;
        bestPos = isBHTarget(best) ? bhScenePos(targetBHIndex(best), _bhFocusPos) :
            stellarTarget(best) ? stellarScenePos(best, _starFocusPos) : bodyScenePos(best);
    } else if (lastPtr) {
        const cands = [];
        if (!WORLD.earthDestroyed) cands.push([BODY_EARTH, earthG.position]);
        if (!WORLD.sunDestroyed) cands.push([BODY_SUN, sunCore.position]);
        if (!WORLD.moonDestroyed) cands.push([BODY_MOON, moon.position]);
        for (let i = 0; i < PL.length; i++) if (!WORLD.plDestroyed[i]) cands.push([i, plGroups[i].position]);
        for (let i = 0; i < BH.n; i++) cands.push([bhFocusValue(i), bhScenePos(i, _bhLabelPos).clone()]);
        if (cam.dist > LY_SCENE * .001) for (let i = 0; i < STARS.length; i++) cands.push([starFocusValue(i), starScenePos(i, _starLabelPos).clone()]);
        if (cam.dist > LY_SCENE * .001) for (const star of ACTIVE_STARS)
            if (star.procedural || star.activeCatalog) cands.push([activeStarFocusValue(star), activeStarScenePos(star, _starLabelPos).clone()]);
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
    } else if (stellarTarget(best)) {
        _hv.vx = 0;
        _hv.vy = 0;
    } else hoverVelocity(best, _hv);
    const v = Math.hypot(_hv.vx, _hv.vy);
    const st = stellarTarget(best);
    const name = isBHTarget(best) ? "BH " + (targetBHIndex(best) + 1) :
        st ? st.name :
        best === BODY_EARTH ? "EARTH" : best === BODY_SUN ? "SUN" : best === BODY_MOON ? "MOON" : PL[best].name;
    let txt = name + " — " + v.toFixed(2) + " km/s";
    if (best >= 0) txt += " · helio " + Math.hypot(_hv.vx - (eph.earthVx + eph.sunVx), _hv.vy - (eph.earthVy + eph.sunVy)).toFixed(2) + " km/s";
    if (st) txt += " · " + st.dLy.toFixed(2) + " ly";
    if (isBHTarget(best)) txt += " · r_s " + fmtKm(BH.rs[targetBHIndex(best)]);
    if (lockedBodyTarget === best) txt += " · LOCKED";
    if (G.focus === best) txt += " · FOCUS";
    hoverTipEl.textContent = txt;
    hoverTipEl.style.display = "block";
    hoverTipEl.style.left = (ptr[0] + 16) + "px";
    hoverTipEl.style.top = (ptr[1] + 12) + "px";
    if (v < 1e-9) {
        hovLine.visible = false; hovCone.visible = false;
        return;
    }
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
function focusTargetValue() {
    const bi = blackHoleFocusIndex(G.focus);
    if (bi >= 0 && bi < BH.n) return G.focus;
    const si = starFocusIndex(G.focus);
    if (si >= 0 && si < STARS.length) return G.focus;
    if (activeStarForFocus(G.focus)) return G.focus;
    if (G.focus === "earth") return BODY_EARTH;
    if (G.focus === "moon") return BODY_MOON;
    if (G.focus === "sun") return BODY_SUN;
    if (typeof G.focus === "number" && G.focus >= 0 && G.focus < PL.length && !WORLD.plDestroyed[G.focus]) return G.focus;
    return BODY_NONE;
}
function updateFocusVelocityVector(alpha = 1) {
    const target = focusTargetValue();
    if (target === BODY_NONE || stellarTarget(target)) {
        focusVelLine.visible = false; focusVelCone.visible = false;
        return;
    }
    const pos = isBHTarget(target) ? bhScenePos(targetBHIndex(target), _bhFocusPos) : bodyScenePos(target);
    if (!pos) {
        focusVelLine.visible = false; focusVelCone.visible = false;
        return;
    }
    velocityForTarget(target, focusVel);
    const v = Math.hypot(focusVel.vx, focusVel.vy);
    if (v < 1e-9) {
        focusVelLine.visible = false; focusVelCone.visible = false;
        return;
    }
    const dCam = camera.position.distanceTo(pos);
    const len = Math.min(dCam * .48, Math.max(dCam * .13, dCam * .018 * v));
    focusVelDir.set(focusVel.vx, 0, -focusVel.vy).normalize();
    focusVelPos[0] = pos.x; focusVelPos[1] = pos.y; focusVelPos[2] = pos.z;
    focusVelPos[3] = pos.x + focusVelDir.x * len; focusVelPos[4] = pos.y; focusVelPos[5] = pos.z + focusVelDir.z * len;
    focusVelAttr.needsUpdate = true;
    focusVelCone.position.set(focusVelPos[3], focusVelPos[4], focusVelPos[5]);
    focusVelCone.scale.setScalar(dCam * .009);
    focusVelCone.quaternion.setFromUnitVectors(upHover, focusVelDir);
    focusVelLine.material.opacity = .74 * alpha;
    focusVelCone.material.opacity = .88 * alpha;
    focusVelLine.visible = alpha > .03; focusVelCone.visible = alpha > .03;
}

// ============================ MAIN LOOP ============================
const clock = new THREE.Clock();
const earthV = new THREE.Vector3(), moonV = new THREE.Vector3(), velV = new THREE.Vector3(), upV = new THREE.Vector3(0, 1, 0), dirV = new THREE.Vector3();
const camPrevTgt = new THREE.Vector3(), camDelta = new THREE.Vector3();
const cabinEye = new THREE.Vector3(), cabinLook = new THREE.Vector3();
let camPrevFocus = null;
const _m = { mx: 0, my: 0, vmx: 0, vmy: 0, ang: 0 };
const arrC = [0, 0, 0];
const fv = [0, 0, 0];
let placed = false, frameNo = 0, grB = 0, exAcc = 0;
const DIR_FADE_START_KMS = 55, DIR_FADE_END_KMS = 90;
let prevHeadingVis = null, prevVelAngleVis = null;
function angleDelta(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
}
function expansionSpeedLabel(kmps) {
    if (kmps >= 1) return kmps.toFixed(2) + " km/s";
    if (kmps >= .001) return kmps.toFixed(4) + " km/s";
    const mps = kmps * 1000;
    return mps >= .001 ? mps.toFixed(3) + " m/s" : mps.toExponential(2) + " m/s";
}
function nearestStarInfo() {
    const wx = eph.earthX + G.x, wy = eph.earthY + G.y, wz = G.z;
    const nearest = nearestActiveStar(wx, wy, wz);
    return { star: nearest.star, d: nearest.d };
}
function updateCabinHUD(cosmicView, oi) {
    const cabinActive = G.cabin && !G.dead && !cosmicView;
    document.body.classList.toggle("mode-cabin", cabinActive);
    if (cabinHudEl) cabinHudEl.setAttribute("aria-hidden", cabinActive ? "false" : "true");
    // glass HUD: the always-readable line the 3D panels can't show at a glance
    if (cabinActive && frameNo % 5 === 0) {
        const apOn = AP.mode !== "off";
        cabinHudEl.innerHTML =
            '<span class="chMain">T+ ' + fmtMET(G.t) +
            ' · ⏩ ' + warpLabel(G.warp) + (G.paused ? " ❚❚" : "") +
            ' · VEL ' + Math.hypot(G.vx, G.vy, G.vz).toFixed(2) + " km/s" +
            ' · ALT ' + fmtDist(Math.max(0, oi.r - oi.R)) + " · " + oi.body +
            (apOn ? ' · <span class="chAp">AP ' + AP.mode.toUpperCase() + "</span>" : "") +
            "</span><br><span class=\"chHint\">DRAG TO LOOK · J EXTERNAL VIEW</span>";
    }
    return cabinActive;
}

function renderFrame(showCockpit) {
    if (VR.active) { renderVRFrame(showCockpit && VR.mode === "ship"); return; }
    composer.render();
    if (showCockpit) {
        // interior composited over the world: depth cleared, color kept, no bloom
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(cockpitScene, cockpitCam);
        renderer.autoClear = true;
    }
}

function frame() {
    const dtR = Math.min(.06, clock.getDelta());
    frameNo++;
    if (G.dead && !G.observerMode && performance.now() - G.deathRt >= 2000) enterObserverMode();
    // ---- input → attitude & thrust (keyboard merged with VR controllers) ----
    const vrIn = vrPoll(dtR);
    let rotIn = ((keys.has("KeyA") || keys.has("ArrowLeft")) ? 1 : 0) - ((keys.has("KeyD") || keys.has("ArrowRight")) ? 1 : 0);
    if (!rotIn) rotIn = vrIn.rot;
    if (rotIn) { G.hold = null; G.heading += rotIn * ROT_RATE * dtR; }
    if (!G.landed) {
        const vh = Math.hypot(G.vx, G.vy);
        if (G.hold === "pro") { G.heading = Math.atan2(G.vy, G.vx); G.pitch = Math.atan2(G.vz, vh); }
        else if (G.hold === "retro") { G.heading = Math.atan2(-G.vy, -G.vx); G.pitch = Math.atan2(-G.vz, vh); }
    }
    let mainIn = (keys.has("KeyW") || keys.has("ArrowUp")) ? 1 : ((keys.has("KeyS") || keys.has("ArrowDown")) ? -1 : 0);
    if (!mainIn) mainIn = vrIn.main;
    let latIn = (keys.has("KeyE") ? 1 : 0) - (keys.has("KeyQ") ? 1 : 0);
    if (!latIn) latIn = vrIn.lat;
    G.boost = keys.has("ShiftLeft") || keys.has("ShiftRight") || vrIn.boost;
    // the pilot always outranks the flight computer
    if ((rotIn || mainIn || latIn) && AP.mode !== "off") apOff("pilot override", toast);
    let atx = 0, aty = 0, atz = 0, aMag = 0;
    const canThrust = !G.dead && !G.paused && (G.infinite || G.fuel > 0);
    if (canThrust && AP.mode !== "off" && !mainIn && !latIn) {
        const ap = apStep(dtR, dtR * G.warp, orbitInfo(), { toast });
        if (ap && ap.aMag > 0) { atx = ap.atx; aty = ap.aty; atz = ap.atz || 0; aMag = ap.aMag; mainIn = ap.mainIn; }
    }
    if (canThrust && (mainIn || latIn) && aMag === 0) {
        const mult = G.boost ? BOOST : 1;
        const cp = Math.cos(G.pitch || 0), hx = cp * Math.cos(G.heading), hy = cp * Math.sin(G.heading), hz = Math.sin(G.pitch || 0);
        if (mainIn) { const a = MAIN_A * G.throttle * mult * mainIn; atx += a * hx; aty += a * hy; atz += a * hz; }
        if (latIn) { const a = RCS_A * mult * latIn; atx += -a * hy; aty += a * hx; }
        aMag = Math.hypot(atx, aty, atz);
        if (G.landed && mainIn > 0) {
            // liftoff: nudge off the surface and hand back to physics
            let radial;
            if (G.landed.body === "earth") radial = Math.atan2(G.y, G.x);
            else if (G.landed.body === "planet") radial = Math.atan2(G.y - eph.plY[G.landed.i], G.x - eph.plX[G.landed.i]);
            else { moonState(G.t, _m); radial = Math.atan2(G.y - _m.my, G.x - _m.mx); }
            G.x += 0.03 * Math.cos(radial); G.y += 0.03 * Math.sin(radial); G.z = 0;
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
        } else advanced = advance(dtR * G.warp, atx, aty, atz, aMag);
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
    sunCorona.position.copy(sunPos);
    sunCore.visible = !WORLD.sunDestroyed;
    sunGlow.visible = !WORLD.sunDestroyed;
    sunLight.visible = !WORLD.sunDestroyed;
    sunCorona.visible = !WORLD.sunDestroyed;
    // shader sun direction (Earth-frame) + sidereal Earth spin, kept in [0, 2π)
    sunDirW.set(sunPos.x - earthX, 0, sunPos.z - earthZ).normalize();
    earth.rotation.y = (OMEGA_EARTH * G.t) % (Math.PI * 2);
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
        plGroups[i].rotation.z = PL[i].visualTilt || 0;
        plSurfaces[i].rotation.y = (PL[i].spin * G.t) % (Math.PI * 2);
        flowCtx.plScX[i] = px; flowCtx.plScZ[i] = pz;
        const dCamP = camera.position.distanceTo(plGroups[i].position);
        const glowNear = PL[i].R * K * (PL[i].gas ? 2.7 : 2.25);
        const glowFar = PL[i].R * K * (PL[i].gas ? 8.5 : 6.5);
        plGlows[i].scale.setScalar(Math.min(glowFar, Math.max(glowNear, dCamP * .0018)));
        plGlows[i].material.opacity = .12 * smooth01(PL[i].R * K * 35, PL[i].R * K * 160, dCamP);
    }
    updateBHVisuals(dtR, earthX, earthZ);
    const focusBH = blackHoleFocusIndex(G.focus);
    if (focusBH >= BH.n) setFocus("ship");
    const focusStar = starFocusIndex(G.focus);
    if (focusStar >= STARS.length) setFocus("ship");
    if (proceduralFocusId(G.focus) && !activeStarForFocus(G.focus)) setFocus("ship");
    if (hygCatalogFocusId(G.focus) && hygCatalogStats().loaded && !activeStarForFocus(G.focus)) setFocus("ship");
    refreshActiveStars(eph.earthX + G.x, eph.earthY + G.y, G.z, G.focus);
    const oriX = (eph.earthX + G.x) * K, oriY = G.z * K, oriZ = -(eph.earthY + G.y) * K;
    shipG.position.set(oriX, oriY, oriZ);
    const cosmicView = cam.dist > LY_SCENE * .2;
    shipG.visible = !G.dead && !cosmicView && !G.cabin;
    clouds.rotation.y += dtR * .01;
    // ---- camera ----
    // "free" focus: the target stays wherever panning put it
    const activeBHFocus = focusBH >= 0 && focusBH < BH.n;
    const activeStarFocus = focusStar >= 0 && focusStar < STARS.length;
    const activeDynamicFocus = activeStarForFocus(G.focus);
    {
        const cp = Math.cos(G.pitch || 0);
        dirV.set(cp * Math.cos(G.heading), Math.sin(G.pitch || 0), -cp * Math.sin(G.heading));
    }
    const tgt = activeBHFocus ? bhScenePos(focusBH) : activeStarFocus ? starScenePos(focusStar) :
        activeDynamicFocus ? activeStarScenePos(activeDynamicFocus) :
        G.focus === "free" ? cam.tgt : typeof G.focus === "number" ? plGroups[G.focus].position :
        G.focus === "moon" ? moon.position : G.focus === "earth" ? earthG.position : G.focus === "sun" ? sunCore.position : shipG.position;
    if (G.focus !== "free") {
        // rigid-follow the focus body's frame-to-frame motion so fast targets
        // stay centered at any warp; the lerp only glides out the residual
        // offset left by focus transitions and pans
        if (placed && camPrevFocus === G.focus) cam.tgt.add(camDelta.copy(tgt).sub(camPrevTgt));
        // interstellar focus jumps snap: gliding 26,000 ly takes forever
        const glide = placed && cam.tgt.distanceTo(tgt) < 1e8;
        cam.tgt.lerp(tgt, glide ? Math.min(1, dtR * 6) : 1);
        camPrevTgt.copy(tgt);
        camPrevFocus = G.focus;
    } else camPrevFocus = null;
    const minD = activeBHFocus ? Math.max(.05, BH.rs[focusBH] * K * 1.3) :
        activeStarFocus ? STARS[focusStar].R * K * 1.8 :
        activeDynamicFocus ? activeDynamicFocus.R * K * 1.8 :
        G.focus === "free" ? .03 : typeof G.focus === "number" ? PL[G.focus].R * K * 1.3 :
        G.focus === "earth" ? R_EARTH * K * 1.3 : G.focus === "moon" ? R_MOON * K * 1.3 : G.focus === "sun" ? SUN_RADIUS * 1.25 : .05;
    cam.dist = Math.max(minD, cam.dist);
    const cabinActive = updateCabinHUD(cosmicView, oi);
    if (VR.active) {
        // rigs follow the ship (or the god transform); the desktop camera is
        // re-pointed at the VR eye so camera-dependent systems keep working
        vrUpdateRigs(oriX, oriZ, dtR, oriY);
    } else if (cabinActive) {
        // head direction = ship heading + look offsets (drag to look around)
        const a = G.heading - look.yaw;
        const cp = Math.cos(look.pitch);
        cabinEye.set(oriX, oriY + .03, oriZ);
        cabinLook.set(oriX + Math.cos(a) * cp, oriY + .03 + Math.sin(look.pitch), oriZ - Math.sin(a) * cp);
        camera.position.copy(cabinEye);
        camera.lookAt(cabinLook);
    } else applyCamera();
    placed = true;
    // near plane tracks clearance to the nearest surface: the fixed 20 km
    // near (kept for depth precision in space) clipped the entire ground
    // when landed, so stars and the river shone through the planet
    let clearU = Infinity;
    if (!WORLD.earthDestroyed) clearU = Math.min(clearU, camera.position.distanceTo(earthG.position) - R_EARTH * K);
    if (!WORLD.moonDestroyed) clearU = Math.min(clearU, camera.position.distanceTo(moon.position) - R_MOON * K);
    if (!WORLD.sunDestroyed) clearU = Math.min(clearU, camera.position.distanceTo(sunCore.position) - SUN_RADIUS);
    for (let i = 0; i < PL.length; i++) if (!WORLD.plDestroyed[i]) clearU = Math.min(clearU, camera.position.distanceTo(plGroups[i].position) - PL[i].R * K);
    for (const star of ACTIVE_STARS) {
        _starLabelPos.set(star.x * K, (star.z || 0) * K, -star.y * K);
        clearU = Math.min(clearU, camera.position.distanceTo(_starLabelPos) - (star.bh ? star.rs : star.R) * K);
    }
    for (let i = 0; i < BH.n; i++) clearU = Math.min(clearU, camera.position.distanceTo(bhScenePos(i)) - BH.rs[i] * K);
    const nearWant = Math.min(.02, Math.max(2e-6, clearU * .5));
    if (Math.abs(nearWant - camera.near) > camera.near * .1) {
        camera.near = nearWant;
        camera.updateProjectionMatrix();
    }
    if (sky) { sky.position.copy(camera.position); sky.visible = !cosmicView; }
    if (skyStars) { skyStars.position.copy(camera.position); skyStars.visible = !cosmicView; }
    if (galaxyBackdrop) { galaxyBackdrop.position.copy(camera.position); galaxyBackdrop.visible = !cosmicView; }
    updateLensing(camera, camera.aspect);
    updateCosmicLayer();
    bloomPass.enabled = !location.search.includes("bloom=0") && cam.dist < LY_SCENE * 400;
    updateBodyShaders(camera, G.t);
    updateStars(camera, dtR);
    const dSun = camera.position.distanceTo(sunPos);
    const nearSunGlow = 1 - smooth01(SUN_RADIUS * 8, SUN_RADIUS * 90, dSun);
    const farSunGlow = smooth01(SUN_RADIUS * 16, SUN_RADIUS * 600, dSun);
    sunGlow.scale.setScalar(Math.min(
        SUN_RADIUS * 180,
        Math.max(SUN_RADIUS * (2.1 + 2.2 * nearSunGlow), dSun * (.0019 + .055 * farSunGlow)),
    ));
    sunGlow.material.opacity = Math.min(.65, .045 + .38 * nearSunGlow + .5 * farSunGlow);
    // ---- craft pose & adaptive size ----
    craft.quaternion.setFromUnitVectors(upV, dirV);
    const cd = camera.position.distanceTo(shipG.position);
    const cs = Math.min(2.4, Math.max(.012, cd * .02));
    const shipSpeed = Math.hypot(G.vx, G.vy, G.vz);
    const directionAlpha = 1 - smooth01(DIR_FADE_START_KMS, DIR_FADE_END_KMS, shipSpeed);
    const velAngle = shipSpeed > 1e-9 ? Math.atan2(G.vy, G.vx) : G.heading;
    const headingRate = prevHeadingVis === null || dtR <= 0 ? 0 : Math.abs(angleDelta(G.heading, prevHeadingVis)) / dtR;
    const velAngleRate = prevVelAngleVis === null || dtR <= 0 ? 0 : Math.abs(angleDelta(velAngle, prevVelAngleVis)) / dtR;
    prevHeadingVis = G.heading;
    prevVelAngleVis = velAngle;
    const directionVisualActive = G.warp <= 600 && headingRate < 7 && velAngleRate < 7;
    craft.scale.setScalar(cs);
    dot.scale.setScalar(cd * .014);
    dot.material.opacity = G.dead ? 0 : (cd > 4 ? 1 : Math.max(0, (cd - 1.2) / 2.8));
    updateHeadingArrow(oriX, oriY, oriZ, dirV, cd, directionVisualActive && !G.dead && !cosmicView && !cabinActive, directionAlpha);
    // ---- engine flame & exhaust ----
    const thrustingMain = aMag > 0 && mainIn !== 0;
    flame.visible = thrustingMain && !G.dead;
    if (flame.visible) {
        const thrVis = Math.min(2, G.throttle); // visuals saturate; physics doesn't
        const off = -mainIn * cs * 1.05;
        flame.position.set(dirV.x * off, dirV.y * off, dirV.z * off);
        flame.scale.setScalar(cs * (.7 + .6 * thrVis * (G.boost ? 1.7 : 1)) * (1 + .2 * Math.sin(performance.now() * .03)));
        flame.material.opacity = .9;
        exAcc = Math.min(20, exAcc + Math.min(280, (G.boost ? 170 : 95) * thrVis) * dtR);
        const epx = oriX + dirV.x * off * 1.05, epy = oriY + dirV.y * off * 1.05, epz = oriZ + dirV.z * off * 1.05;
        while (exAcc > 1) {
            exAcc--;
            spawnExhaust(epx, epy, epz, -dirV.x * mainIn, -dirV.y * mainIn, -dirV.z * mainIn, cs, G.boost);
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
            velV.set(aero.vx, aero.vz || 0, -aero.vy).normalize();
            plasma.position.copy(velV).multiplyScalar(cs * .9);
            plasma.scale.setScalar(cs * (1.6 + 3.4 * I) * (1 + .15 * Math.sin(performance.now() * .05)));
            plasma.material.opacity = Math.min(1, .25 + I);
            shake = I;
        } else plasma.visible = false;
    } else plasma.visible = false;
    let cabinShake = 0;
    if ((shake > .03 || (G.boost && aMag > 0)) && !VR.active) {
        // in the cabin the camera sits at cockpit scale: a fixed micro-jitter
        // reads as engine rumble, while cam.dist-scaled shake (external zoom)
        // would hurl the world around the window. In VR the same events go
        // to the controllers as haptic rumble — visual shake is nauseating.
        const s = cabinActive ? Math.max(shake, .12) * .004 : Math.max(shake, .12) * cam.dist * .006;
        cabinShake = cabinActive ? Math.max(shake, .12) : 0;
        camera.position.x += (Math.random() - .5) * s;
        camera.position.y += (Math.random() - .5) * s;
        camera.position.z += (Math.random() - .5) * s;
    }
    vrHaptics(aMag, shake);
    // ---- trails & prediction ----
    if (!G.paused && !G.dead && advanced > 0) { pushTrail(false); pushJourney(); }
    setJourneyOpacity(.48 * smooth01(40, 320, cd));
    const predEvery = G.warp > 600 ? 48 : G.warp > 60 ? 18 : 8;
    if (frameNo % predEvery === 0 || (aMag > 0 && G.warp <= 600)) computePrediction();
    // ---- spacetime river (GPU) ----
    const grT = G.gr ? 1 : 0;
    grB += (grT - grB) * Math.min(1, dtR * 3.4);
    if (Math.abs(grT - grB) < .004) grB = grT;
    const fB = grB;
    const fRiver = fB * (1 - smooth01(2.0e7, 7.0e7, cam.dist));
    updateRiver(advanced, fB, earthV, moonV, sunPos, plPosArr, dtR);
    updateShells(river.dtVis ?? advanced, fRiver);
    if (fRiver > .01) {
        fFlow.textContent = (flowVel(oriX, oriY, oriZ, moonV.x, moonV.y, moonV.z, fv) * 1000).toFixed(2) + " km/s";
        const deShip = G.darkEnergy ? Math.hypot(oriX - earthX, oriY, oriZ - earthZ) * DARK_ENERGY.H_SIM * 1000 : 0;
        fDark.textContent = G.darkEnergy ? expansionSpeedLabel(deShip) : "OFF";
    }
    moonSoiRing.visible = fRiver > .01 && !WORLD.moonDestroyed;
    moonSoiRing.material.opacity = fRiver * (.14 + .1 * Math.sin(performance.now() * .002));
    // ---- velocity & flow vectors (one shared scale) ----
    velV.set(G.vx, G.vz, -G.vy);
    const sp = shipSpeed;
    let kVLoc = sp;
    if (directionVisualActive && sp > 1e-9 && !G.dead && !cosmicView && !cabinActive) {
        const dMo = oi.rM * K;
        const qLoc = fRiver * (1 - smooth01(14, 56, dMo));
        const lvx = G.vx - qLoc * _m.vmx, lvy = G.vy - qLoc * _m.vmy, lvz = G.vz;
        const kV = Math.hypot(lvx, lvy, lvz);
        kVLoc = kV;
        speedColor(kV, arrC);
        arrow.material.color.setRGB(arrC[0], arrC[1], arrC[2]);
        arrow.material.opacity = .92 * directionAlpha;
        const SCL = cd * .06, MAXL = cd * .55;
        const aL = Math.min(MAXL, SCL * kV) / Math.max(1e-9, kV);
        arrPos[0] = oriX; arrPos[1] = oriY; arrPos[2] = oriZ;
        arrPos[3] = oriX + lvx * aL; arrPos[4] = oriY + lvz * aL; arrPos[5] = oriZ - lvy * aL;
        arrAttr.needsUpdate = true;
        arrow.visible = directionAlpha > .03;
        tipV.visible = directionAlpha > .03;
        tipV.position.set(arrPos[3], arrPos[4], arrPos[5]);
        tipV.scale.setScalar(cd * .013);
        tipV.material.color.setRGB(arrC[0], arrC[1], arrC[2]);
        tipV.material.opacity = directionAlpha;
        if (fRiver > .02) {
            const kF = flowVel(oriX, oriY, oriZ, moonV.x, moonV.y, moonV.z, fv) * 1000;
            const fL = Math.min(MAXL, SCL * kF) / Math.max(1e-12, kF * .001);
            flArrPos[0] = oriX; flArrPos[1] = oriY; flArrPos[2] = oriZ;
            flArrPos[3] = oriX + fv[0] * fL;
            flArrPos[4] = oriY + fv[1] * fL;
            flArrPos[5] = oriZ + fv[2] * fL;
            flArrAttr.needsUpdate = true;
            flowArrow.material.opacity = .95 * fRiver;
            flowArrow.visible = true;
            tipF.visible = true;
            tipF.position.set(flArrPos[3], flArrPos[4], flArrPos[5]);
            tipF.scale.setScalar(cd * .013);
            tipF.material.opacity = fRiver;
            if (G.darkEnergy) {
                const deVX = (oriX - earthX) * DARK_ENERGY.H_SIM;
                const deVY = oriY * DARK_ENERGY.H_SIM;
                const deVZ = (oriZ - earthZ) * DARK_ENERGY.H_SIM;
                const deScene = Math.hypot(deVX, deVY, deVZ);
                if (deScene > 1e-12) {
                    const deK = deScene * 1000;
                    const deL = Math.min(MAXL, SCL * deK) / deScene;
                    deArrPos[0] = oriX; deArrPos[1] = oriY; deArrPos[2] = oriZ;
                    deArrPos[3] = oriX + deVX * deL;
                    deArrPos[4] = oriY + deVY * deL;
                    deArrPos[5] = oriZ + deVZ * deL;
                    deArrAttr.needsUpdate = true;
                    darkEnergyArrow.material.opacity = .9 * fRiver;
                    darkEnergyArrow.visible = true;
                    tipDE.visible = true;
                    tipDE.position.set(deArrPos[3], deArrPos[4], deArrPos[5]);
                    tipDE.scale.setScalar(cd * .013);
                    tipDE.material.opacity = fRiver;
                } else { darkEnergyArrow.visible = false; tipDE.visible = false; }
            } else { darkEnergyArrow.visible = false; tipDE.visible = false; }
        } else { flowArrow.visible = false; tipF.visible = false; darkEnergyArrow.visible = false; tipDE.visible = false; }
    } else {
        arrow.visible = false; flowArrow.visible = false; darkEnergyArrow.visible = false;
        tipV.visible = false; tipF.visible = false; tipDE.visible = false;
    }
    updateFocusVelocityVector(cabinActive || cosmicView ? 0 : 1);
    // ---- audio ----
    if (thrustGain) {
        const target = (aMag > 0 && !G.muted) ? Math.min(.22, .04 + .12 * G.throttle * (G.boost ? 1.8 : 1)) : 0;
        thrustGain.gain.value += (target - thrustGain.gain.value) * Math.min(1, dtR * 12);
    }
    // ---- HUD & labels ----
    updateHUD(oi, aMag, mainIn, sp, kVLoc, fRiver);
    hintTick(oi);
    if (cabinActive) {
        const fuelWarn = !G.infinite && G.fuel < FUEL_DV0 * .15;
        const altWarn = !G.landed && oi.r - oi.R < 25;
        updateCockpit(dtR, sunDirW, G.heading, aMag, G.boost,
            { AP: AP.mode !== "off", ALT: altWarn, FUEL: fuelWarn, WARP: G.warp > 600 }, cabinShake);
        updateInstruments(oi, eph);
        setLeverThrottle(G.throttle);
        if (cockpitCam.aspect !== camera.aspect) setCockpitAspect(camera.aspect);
    }
    if (frameNo % 5 === 0) updateEscapeTracker(oi);
    const w = cvHost.clientWidth, h = cvHost.clientHeight;
    const showStarLabels = (cam.dist > LY_SCENE * .001 && cam.dist < LY_SCENE * 180) || activeStarFocus;
    for (let i = 0; i < STARS.length; i++) {
        const starLabel = ensureStarLabel(i);
        if (!starLabel) continue;
        if (showStarLabels) put(starLabel, starScenePos(i, _starLabelPos), -8, w, h);
        else starLabel.style.opacity = "0";
    }
    if (cosmicView || cabinActive || VR.active) {
        hoverTipEl.style.display = "none";
        hovLine.visible = false; hovCone.visible = false;
    } else updateHover(w, h);
    const bodyPredEvery = G.warp > 600 ? 90 : G.warp > 60 ? 42 : 18;
    if (!cosmicView && frameNo % bodyPredEvery === 0) {
        if (lockedBodyTarget !== BODY_NONE && isTargetDestroyed(lockedBodyTarget)) unlockBodyPrediction();
        if (lockedBodyTarget !== BODY_NONE) computeBodyPrediction(lockedBodyTarget, true);
        else clearBodyPrediction();
    }
    if (cosmicView) {
        lblE.style.opacity = "0"; lblM.style.opacity = "0"; lblS.style.opacity = "0"; lblO.style.opacity = "0";
        for (let i = 0; i < PL.length; i++) plLabels[i].style.opacity = "0";
        for (let i = 0; i < BH_MAX; i++) { bhLabels[i].style.display = "none"; bhLabels[i].style.opacity = "0"; }
        clearBodyPrediction();
        renderFrame(false);
        return;
    }
    if (WORLD.earthDestroyed) lblE.style.opacity = "0"; else put(lblE, earthG.position, -8, w, h);
    if (WORLD.moonDestroyed) lblM.style.opacity = "0"; else put(lblM, moon.position, -8, w, h);
    if (WORLD.sunDestroyed || camera.position.distanceTo(sunCore.position) < SUN_RADIUS * 18) lblS.style.opacity = "0";
    else put(lblS, sunCore.position, -8, w, h);
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
    renderFrame(cabinActive);
}
// setAnimationLoop lets WebXR sessions drive the frame callback when presenting.
renderer.setAnimationLoop(frame);
