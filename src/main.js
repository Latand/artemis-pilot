import * as THREE from "three";
import {
    R_EARTH, R_MOON, R_SUN, SUN_RADIUS, PL, K, SOI_M, BH_MAX,
    MAIN_A, RCS_A, BOOST, ROT_RATE, MU_E, MU_M, MU_S, DARK_MATTER, LY_SCENE, LY_KM, STARS, PC_KM,
    OMEGA_EARTH, FUEL_DV0, warpLabel,
} from "./constants.js";
import { G, WORLD, keys, BH, resetShip, destroyBody, isBodyDestroyed, addGhost, rebaseBHEvents } from "./state.js";
import { eph, moonState, planetVel, sunVel, resetEphem, advanceEphem } from "./ephemeris.js";
import { initPhysicsHooks, advance, snapLanded, orbitInfo, sampleAero } from "./physics.js";
import { fmtMET, fmtKm, fmtDist, clamp01, smooth01, speedColor } from "./format.js";
import { loadAllMaps } from "./textures.js";
import {
    scene, camera, composer, renderer, bloomPass, cam, applyCamera, viewportSize, put, projectTo, lastPtr,
    renderQuality, hideLabel, setLabelDisplay, setRenderLoadShed, ensurePostProcessing,
    farTierGroup, renderSceneTiered, registerNearTierOnly,
} from "./scene.js";
import {
    buildBodies, sunPos, sunLight, sunCore, sunGlow, sunCorona, sky, skyStars, earth, earthG, clouds, earthAtmo, moon, moonOrbitRing, moonSoiRing,
    plGroups, plSurfaces, plGlows, plOrbitRings, plLabels, galaxyBackdrop, sunDirW, updateBodyShaders, scheduleDeferredRealSkyLoad, requestEarthNightTexture,
    moonGroups, moonSurfaces, moonGlows, moonLabels, updateSunView,
} from "./bodies.js";
import { MOONS, moonOffset, moonFocusValue, moonFocusIndex, MOON_LABEL_DIST } from "./moons.js";
import { addStarVisual, buildStars, updateStars } from "./stars.js";
import { cockpitScene, cockpitCam, look, updateCockpit, setCockpitAspect, mfdScreens, setLeverThrottle } from "./cockpit.js";
import { updateInstruments, mfdTextures } from "./instruments.js";
import { AP, apStep, apOff } from "./autopilot.js";
import {
    shipG, craft, dot, flame, plasma, updateHeadingArrow,
    EXN, exPos, exVel, exLife, exMax, exCol, exPosAttr, exColAttr, exMat, exhaust, spawnExhaust,
    XPN, xpPos, xpVel, xpLife, xpCol, xpPosAttr, xpColAttr, xpMat, explosion, xpFlash, xp, triggerExplosion,
} from "./ship.js";
import {
    pushTrail, pushJourney, setJourneyOpacity, clearTrail, computePrediction,
    computeBodyPrediction, clearBodyPrediction,
    arrPos, arrAttr, arrow, flArrPos, flArrAttr, flowArrow, deArrPos, deArrAttr, darkEnergyArrow, tipV, tipF, tipDE,
    haloArrPos, haloArrAttr, haloArrow, tipHalo,
} from "./trails.js";
import { flowCtx, flowVel } from "./flowfield.js";
import { initRiver, updateRiver, updateShells, river, warmRiverCompute } from "./river.js";
import { initCosmicLayer, updateCosmicLayer, cycleCosmicScale } from "./cosmic.js";
import { initBHHooks, updateBHVisuals, addBlackHole, bhAdvance, isBHPlacementMode } from "./blackholes.js";
import { thrustGain, boom } from "./audio.js";
import { award, toast, renderObjectives } from "./achievements.js";
import {
    showBanner, hideBanner, updateHUD, updateEscapeTracker, hideHelp,
    fFlow, fDark, fHalo, lblE, lblM, lblO, lblS,
    setText as setHudText,
} from "./hud.js";
import { initInput, setFocus, blackHoleFocusIndex, starFocusIndex } from "./input.js";
import { initNavigator, openNavigator } from "./navigator.js";
import { initQuickControls } from "./quickControls.js";
import { initScenarios } from "./scenarios.js";
import { initHints, hintTick } from "./hints.js";
import { VR, initVR, vrPoll, vrUpdateRigs, renderVRFrame, vrHaptics } from "./vr.js";
import {
    ACTIVE_STARS, activeStarFocusValue, activeStarForFocus, hygCatalogFocusId, hygCatalogFocusValue, hygCatalogStats, nearestActiveStar, proceduralFocusId,
    refreshActiveStars,
} from "./universe/activeStars.js";
import {
    darkEnergySpeedKmS, darkEnergyVisibleFractionKm, darkMatterRelativeAccel, darkMatterVisibleFractionPc,
} from "./cosmology.js";
import { equatorialKmToGal } from "./universe/coords.js";
import { initTier1, updateTier1, refreshResiduals as refreshTier1Residuals, tier1Stats } from "./universe/athygTier1.js";
import { getOrigin, maybeRebase } from "./universe/renderOrigin.js";
import { PERF, markPerf, sampleRendererInfo, sampleMemory } from "./perf.js";
import { initXrPerf, tickXrPerf, shouldGateBloom } from "./render/xrPerf.js";
import { initMobileControls, updateMobileControls } from "./mobileControls.js";
import { initAttitude, drawAttitude } from "./attitude.js";

// ============================ WIRING ============================
const query = new URLSearchParams(location.search);
const bloomParam = query.get("bloom");
const bloomRequested = bloomParam !== "0" && (bloomParam === "1" || bloomParam === "legacy" || query.get("fastbloom") === "0");
const bloomForced = bloomRequested;
const bloomDisabled = !bloomRequested;
const skipSceneCompile = query.get("compile") === "0" || query.get("warmcompile") === "0";
const galaxyBackdropForced = query.get("galaxy") === "1";
// WP18: sets foveation + primes the framebuffer scale factor before any XR
// session is requested; tickXrPerf() below self-inits if this is skipped, but
// calling it explicitly here means foveation is live from the very first frame.
initXrPerf(renderer);
// WP10 decision: the floating origin stays pinned at (0,0,0) this wave — every
// legacy render path (bodies, stars.js, realSky, cosmic) still assumes origin
// 0 and doesn't consume renderOrigin (that's WP16). Rebasing it now would
// offset tier-1 stars relative to everything else, so maybeRebase is only
// exercised behind this experimental flag until WP16/17 make the rest of the
// scene origin-aware too.
const tier1RebaseEnabled = query.get("rebase") === "1";
let lensingPass = { enabled: false };
let updateLensingImpl = null;
let lensingReady = null;
const lensPrecheckV = new THREE.Vector3();
function perfStart() { return PERF.enabled ? performance.now() : 0; }
function perfEnd(name, start, detail = null) {
    if (PERF.enabled) markPerf(name, performance.now() - start, detail);
}
function lensCandidateCouldBeVisible(wx, wy, wz, rsU, camera) {
    lensPrecheckV.set(wx, wy, wz).applyMatrix4(camera.matrixWorldInverse);
    if (lensPrecheckV.z > -1e-9) return false;
    const d = lensPrecheckV.length();
    if (d < rsU * 1.5) return false;
    const f = 1 / Math.tan(camera.fov * Math.PI / 360);
    const t = Math.min(f * Math.tan(Math.min(Math.sqrt(2 * rsU / d), .6)), .55);
    if (t < .004) return false;
    const cx = f * (lensPrecheckV.x / -lensPrecheckV.z);
    const cy = f * (lensPrecheckV.y / -lensPrecheckV.z);
    return Math.hypot(cx, cy) <= 4;
}
function lensingCouldBeVisible(camera) {
    for (let i = 0; i < BH.n; i++) {
        if (lensCandidateCouldBeVisible((eph.earthX + BH.x[i]) * K, 0, -(eph.earthY + BH.y[i]) * K, BH.rs[i] * K, camera)) return true;
    }
    for (const s of ACTIVE_STARS) {
        if (s.bh && lensCandidateCouldBeVisible(s.x * K, (s.z || 0) * K, -s.y * K, s.rs * K, camera)) return true;
    }
    return false;
}
function ensureLensingModule() {
    if (!lensingReady) {
        lensingReady = import("./lensing.js").then(mod => {
            lensingPass = mod.lensingPass;
            updateLensingImpl = mod.updateLensing;
            return ensurePostProcessing(lensingPass).then(() => mod);
        }).catch(err => {
            console.warn("lensing load skipped", err);
            lensingReady = null;
            return null;
        });
    }
    return lensingReady;
}
function updateLensingLazy(camera, aspect) {
    if (!lensingCouldBeVisible(camera)) {
        lensingPass.enabled = false;
        return false;
    }
    if (!updateLensingImpl) {
        lensingPass.enabled = false;
        ensureLensingModule();
        return false;
    }
    const active = updateLensingImpl(camera, aspect);
    if (active && !composer) ensurePostProcessing(lensingPass);
    return active;
}
let catalogSearchHooks = null;
let catalogSearchReady = null;
function ensureCatalogSearch() {
    if (!catalogSearchReady) {
        catalogSearchReady = import("./catalogSearch.js").then(mod => {
            if (catalogSearchHooks) mod.initCatalogSearch(catalogSearchHooks);
            return mod;
        });
    }
    return catalogSearchReady;
}
function openCatalogSearchLazy(seed = "") {
    ensureCatalogSearch()
        .then(mod => mod.openCatalogSearch(seed))
        .catch(err => toast(err?.message || String(err)));
}
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
initInput({ restart, openCatalogSearch: openCatalogSearchLazy });
initScenarios({ restart });
initHints();
initVR({ restart });
initMobileControls({
    restart,
    cycleFocus() {
        setFocus(G.focus === "ship" ? "moon" : G.focus === "moon" ? "earth" : G.focus === "earth" ? "sun" : "ship");
        unlockBodyPrediction();
    },
    cycleScale: cycleCosmicScale,
    openCatalogSearch: openCatalogSearchLazy,
    openNavigator,
});
initNavigator({ flyTo: flyFocus });
initQuickControls();

// Camera/share-state must be applied before renderer warmup; otherwise startup
// compiles the default low-orbit view, then immediately renders a different
// restored or URL-selected view on the first live frame.
function applyStartupCameraState() {
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

function installCameraPersistence() {
    const saveCam = () => {
        try {
            localStorage.setItem("ap_cam", JSON.stringify({ dist: cam.dist, yaw: cam.yaw, pitch: cam.pitch, focus: G.focus, warp: G.warp }));
        } catch (e) { }
    };
    setInterval(saveCam, 2500);
    window.addEventListener("beforeunload", saveCam);
}

function primeStartupBodyLod() {
    const cosmicView = cam.dist > LY_SCENE * .2;
    const detailShed = renderQuality.mobile || G.warp > 600;
    const distantShipView = detailShed && G.focus === "ship" && cam.dist > 1000;
    if (!cosmicView && !distantShipView) return { cosmicView, detailShed, primed: false };
    earth.visible = false;
    clouds.visible = false;
    if (earthAtmo) earthAtmo.visible = false;
    moon.visible = false;
    sunCore.visible = false;
    sunCorona.visible = false;
    for (let i = 0; i < PL.length; i++) plSurfaces[i].visible = false;
    return { cosmicView, detailShed, primed: true };
}

// ============================ INIT ============================
const mapsT0 = perfStart();
const maps = await loadAllMaps();
perfEnd("startup.loadMaps", mapsT0);
const bodiesT0 = perfStart();
buildBodies(maps);
// WP17 multi-frustum tiering (scene.js): sky dome / star sprites / galaxy
// backdrop are camera-attached, but their shell radii (sky ~4.0e6, skyStars
// ~5.9e6, galaxyBackdrop ~3.3e6 units) sit well inside TIER_SPLIT_UNITS
// (~1.89e8), i.e. near-tier scale, not "at infinity". Parenting them under
// `farTierGroup` was tried here but renderSceneTiered hides that whole group
// for the near pass (scene.js:renderSceneTiered) while their own radii get
// clipped out of the far pass's near plane, so they never drew in either
// pass -- an empty sky from anywhere inside the near tier (i.e. almost
// always). bodies.js already adds them straight to `scene`, which renders
// correctly in the near pass; leave them there.
perfEnd("startup.buildBodies", bodiesT0);
const starsT0 = perfStart();
buildStars();
perfEnd("startup.buildStars", starsT0);
const cosmicInitT0 = perfStart();
// initCosmicLayer/initTier1 just call `.add()` on whatever parent they're
// given (verified in cosmic.js/athygTier1.js — neither relies on Scene-only
// behavior), so handing them `farTierGroup` instead of `scene` buckets the
// entire cosmic layer (catalog/procedural galaxy clouds, Local Group) and
// the whole tier-1 streaming field into the far tier for free.
initCosmicLayer(farTierGroup);
perfEnd("startup.initCosmicLayer", cosmicInitT0);
// Tier-1 AT-HYG streaming star layer (WP9/WP10): fetches its manifest and
// streams tiles over ~25 minutes, so it's fired without an `await` to avoid
// gating app startup on the network; self-gates on `?tier1=0`. frame() drives
// it every tick via updateTier1 below. Exposed for the live gate probe.
initTier1({ scene: farTierGroup }).catch(err => console.error("athygTier1: init failed:", err?.message || err));
window.__tier1Stats = tier1Stats; // debug/testing handle
// hook the live instrument textures onto the cockpit MFD screens
mfdScreens.forEach((scr, i) => {
    scr.material.map = mfdTextures[i];
    scr.material.color.set(0xffffff);
    scr.material.needsUpdate = true;
});
const plPosArr = plGroups.map(g => g.position);
const riverInitT0 = perfStart();
initRiver();
perfEnd("startup.initRiver", riverInitT0);
resetEphem();
resetShip();
renderObjectives();
pushTrail(true);
const predictionInitT0 = perfStart();
computePrediction();
perfEnd("startup.computePrediction", predictionInitT0);
applyStartupCameraState();
installCameraPersistence();

async function warmRendererStartup() {
    const t0 = PERF.enabled ? performance.now() : 0;
    try {
        applyCamera();
        const bodyWarmT0 = PERF.enabled ? performance.now() : 0;
        const warmLod = primeStartupBodyLod();
        if (PERF.enabled) markPerf("startup.primeBodyLod", performance.now() - bodyWarmT0, warmLod);
        const warmBloom = !bloomDisabled && (bloomForced || !renderQuality.mobile);
        if (!warmBloom) bloomPass.enabled = false;
        const sceneCompileT0 = PERF.enabled ? performance.now() : 0;
        if (skipSceneCompile) {
            if (PERF.enabled) markPerf("startup.compileScene", performance.now() - sceneCompileT0, { skipped: true });
        } else if (renderer.compileAsync) {
            await renderer.compileAsync(scene, camera);
            if (PERF.enabled) markPerf("startup.compileScene", performance.now() - sceneCompileT0);
        } else {
            renderer.compile(scene, camera);
            if (PERF.enabled) markPerf("startup.compileScene", performance.now() - sceneCompileT0);
        }
        const riverWarmT0 = PERF.enabled ? performance.now() : 0;
        const riverWarmed = warmRiverCompute();
        if (PERF.enabled) markPerf("startup.warmRiverCompute", performance.now() - riverWarmT0, { warmed: riverWarmed });
        const composerT0 = PERF.enabled ? performance.now() : 0;
        // EffectComposer fullscreen passes compile on first render; only warm it
        // when the first live frame is expected to use post-processing.
        const warmComposer = !!(bloomPass.enabled || lensingPass.enabled);
        if (warmComposer && composer) composer.render();
        else renderSceneTiered(renderer, scene, camera);
        if (PERF.enabled) markPerf("startup.warmComposer", performance.now() - composerT0, {
            composer: warmComposer,
            bloom: !!bloomPass.enabled,
            fastBloom: !!bloomPass.isFastBloomPass,
            lensing: !!lensingPass.enabled,
        });
        const finishT0 = PERF.enabled ? performance.now() : 0;
        renderer.getContext?.().finish?.();
        if (PERF.enabled) markPerf("startup.gpuFinish", performance.now() - finishT0);
    } catch (err) {
        console.warn("renderer warmup skipped", err);
    }
    if (PERF.enabled) markPerf("startup.warmRenderer", performance.now() - t0, {
        async: !!renderer.compileAsync,
        bloom: !!bloomPass.enabled,
        dpr: renderQuality.dpr,
        compile: !skipSceneCompile,
    });
}
await warmRendererStartup();

let cockpitWarmupStarted = false;
let cockpitWarmed = false;
function warmCockpitRenderTarget(label = "startup.warmCockpitOffscreen") {
    const t0 = PERF.enabled ? performance.now() : 0;
    let rt = null;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    try {
        rt = new THREE.WebGLRenderTarget(96, 96, {
            depthBuffer: true,
            stencilBuffer: false,
            samples: 0,
        });
        renderer.setRenderTarget(rt);
        renderer.autoClear = true;
        renderer.clear(true, true, true);
        renderer.render(cockpitScene, cockpitCam);
    } catch (err) {
        console.warn("cockpit render warmup skipped", err);
    } finally {
        renderer.setRenderTarget(prevTarget);
        renderer.autoClear = prevAutoClear;
        rt?.dispose?.();
    }
    if (PERF.enabled) markPerf(label, performance.now() - t0);
}
function compileCockpitNow(label = "startup.compileCockpitFirstUse") {
    if (cockpitWarmed) return;
    cockpitWarmupStarted = true;
    const t0 = PERF.enabled ? performance.now() : 0;
    try {
        renderer.compile(cockpitScene, cockpitCam);
        cockpitWarmed = true;
    } catch (err) {
        console.warn("cockpit compile skipped", err);
    }
    if (PERF.enabled) markPerf(label, performance.now() - t0);
}
function scheduleCockpitWarmup(delayMs = 0) {
    if (cockpitWarmupStarted || cockpitWarmed) return;
    cockpitWarmupStarted = true;
    const start = async () => {
        const t0 = PERF.enabled ? performance.now() : 0;
        try {
            if (renderer.compileAsync) await renderer.compileAsync(cockpitScene, cockpitCam);
            else renderer.compile(cockpitScene, cockpitCam);
            const warmOi = orbitInfo();
            for (let i = 0; i < 3; i++) updateInstruments(warmOi, eph);
            updateCockpit(1 / 60, sunDirW, G.heading, 0, false,
                { AP: AP.mode !== "off", ALT: false, FUEL: false, WARP: G.warp > 600 }, 0);
            warmCockpitRenderTarget();
            cockpitWarmed = true;
        } catch (err) {
            console.warn("cockpit warmup skipped", err);
        }
        if (PERF.enabled) markPerf("startup.compileCockpitIdle", performance.now() - t0);
    };
    const queueIdle = () => {
        if (typeof requestIdleCallback === "function") requestIdleCallback(start, { timeout: 1200 });
        else setTimeout(start, 250);
    };
    if (delayMs > 0) setTimeout(queueIdle, delayMs);
    else queueIdle();
}

const BODY_NONE = -99, BODY_EARTH = -3, BODY_MOON = -2, BODY_SUN = -1;
let hoverBodyTarget = BODY_NONE, lockedBodyTarget = BODY_NONE, labelHoverTarget = BODY_NONE, labelPtr = null;
let bodyPredHiddenForPredictOff = true;
const labelPtrPos = [0, 0];
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
    const minTrackDist = target === BODY_EARTH ? R_EARTH * K * 80 : target === BODY_MOON ? R_MOON * K * 80 : target === BODY_SUN ? SUN_RADIUS * 12 : PL[target].R * K * 65;
    cam.dist = Math.max(cam.dist, minTrackDist);
    unlockBodyPrediction();
    lockedBodyTarget = target;
    bodyPredHiddenForPredictOff = !G.predict;
    if (G.predict) computeBodyPrediction(target, true);
}
function focusAndLockBody(target, focusValue) {
    const keepDist = cam.dist;
    setFocus(focusValue);
    cam.dist = Math.max(cam.dist, keepDist);
    lockBodyPrediction(target);
}
function unlockBodyPrediction() {
    lockedBodyTarget = BODY_NONE;
    bodyPredHiddenForPredictOff = true;
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
const _moonOff = { x: 0, y: 0 };
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
// smooth fly-in: keep the focus glide, but animate the zoom distance toward the
// framing distance setFocus() chose, so picking a body approaches it instead of
// snapping. Used by taps and the navigator.
function flyFocus(fv) {
    const from = cam.dist;
    setFocus(fv);
    unlockBodyPrediction();
    const to = cam.dist;
    cam.dist = from;
    cam.distTarget = to;
}
function focusTarget(target, approach = false) {
    const from = cam.dist;
    if (isBHTarget(target)) focusBlackHole(targetBHIndex(target));
    else if (moonFocusIndex(target) >= 0) { setFocus(target); unlockBodyPrediction(); }
    else if (stellarTarget(target)) { setFocus(target); unlockBodyPrediction(); }
    else if (approach) { setFocus(target === BODY_EARTH ? "earth" : target === BODY_MOON ? "moon" : target === BODY_SUN ? "sun" : target); unlockBodyPrediction(); }
    else focusAndLockBody(target, target === BODY_EARTH ? "earth" : target === BODY_MOON ? "moon" : target === BODY_SUN ? "sun" : target);
    const to = cam.dist;
    if (to !== from) { cam.dist = from; cam.distTarget = to; }
}
function focusNearestSurvivor() {
    const sx = (eph.earthX + G.x) * K, sy = G.z * K, sz = -(eph.earthY + G.y) * K;
    _focusOrigin.set(sx, sy, sz);
    let bestName = "", bestTarget = BODY_NONE, bestFocus = BODY_NONE, bestBH = -1, bestD = Infinity;
    const scanBody = (target, focus, pos) => {
        if (isTargetDestroyed(target)) return;
        const d = pos.distanceTo(_focusOrigin);
        if (d < bestD) { bestD = d; bestName = bodyName(target); bestTarget = target; bestFocus = focus; bestBH = -1; }
    };
    scanBody(BODY_EARTH, "earth", earthG.position);
    scanBody(BODY_MOON, "moon", moon.position);
    scanBody(BODY_SUN, "sun", sunCore.position);
    for (let i = 0; i < PL.length; i++) scanBody(i, i, plGroups[i].position);
    for (let i = 0; i < BH.n; i++) {
        bhScenePos(i, _focusPos);
        const d = _focusPos.distanceTo(_focusOrigin);
        if (d < bestD) { bestD = d; bestName = "Black hole"; bestBH = i; }
    }
    if (bestD === Infinity) return null;
    if (bestBH >= 0) focusBlackHole(bestBH);
    else focusAndLockBody(bestTarget, bestFocus);
    return bestName;
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
    const setLabelPointer = e => {
        labelHoverTarget = target;
        labelPtrPos[0] = e.clientX;
        labelPtrPos[1] = e.clientY;
        labelPtr = labelPtrPos;
    };
    el.addEventListener("pointerenter", setLabelPointer);
    el.addEventListener("pointermove", setLabelPointer);
    el.addEventListener("pointerleave", () => { if (labelHoverTarget === target) { labelHoverTarget = BODY_NONE; labelPtr = null; } });
}

// label click → camera focus + body prediction lock
bindBodyLabel(lblE, BODY_EARTH, () => focusAndLockBody(BODY_EARTH, "earth"));
bindBodyLabel(lblM, BODY_MOON, () => focusAndLockBody(BODY_MOON, "moon"));
bindBodyLabel(lblS, BODY_SUN, () => focusAndLockBody(BODY_SUN, "sun"));
lblO.onclick = () => { setFocus("ship"); unlockBodyPrediction(); };
plLabels.forEach((sp, i) => { bindBodyLabel(sp, i, () => focusAndLockBody(i, i)); });
moonLabels.forEach((sp, i) => { sp.onclick = () => flyFocus(moonFocusValue(i)); });
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
let starLabelsVisible = false, starLabelCursor = 0;
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
function hideStarLabels() {
    if (!starLabelsVisible) return;
    for (let i = 0; i < starLabels.length; i++) if (starLabels[i]) hideLabel(starLabels[i]);
    starLabelsVisible = false;
    starLabelCursor = 0;
}
function starLabelCadence() {
    if (renderQuality.mobile) return 8;
    return G.warp > 600 ? 6 : G.warp > 60 ? 3 : 2;
}
function starLabelBatchSize() {
    if (G.warp > 600) return 12;
    if (G.warp > 60) return 28;
    return 36;
}
catalogSearchHooks = {
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
};
const initialHygQuery = new URLSearchParams(location.search).get("hyg");
if (initialHygQuery) {
    const openInitialHyg = () => ensureCatalogSearch().catch(err => toast(err?.message || String(err)));
    if (window.requestIdleCallback) window.requestIdleCallback(openInitialHyg, { timeout: 900 });
    else setTimeout(openInitialHyg, 0);
}

let pickDown = null;
const pickProject = [0, 0], hoverProject = [0, 0];
const _pickProbePos = new THREE.Vector3(), _hoverProbePos = new THREE.Vector3(), _hoverBestPos = new THREE.Vector3();
function targetPickRadius(target, pos) {
    const d = camera.position.distanceTo(pos);
    if (isBHTarget(target)) return Math.max(24, Math.min(64, BH.rs[targetBHIndex(target)] * K / Math.max(1e-9, d) * 1200 + 30));
    if (stellarTarget(target)) return 22;
    const r = target === BODY_EARTH ? R_EARTH * K : target === BODY_MOON ? R_MOON * K : target === BODY_SUN ? SUN_RADIUS : PL[target].R * K;
    return Math.max(target === BODY_SUN ? 52 : 24, Math.min(target === BODY_SUN ? 92 : 54, r / Math.max(1e-9, d) * 1500 + 18));
}
function screenDistance(pos, x, y, w, h, out) {
    const pr = projectTo(pos, w, h, out);
    return pr ? Math.hypot(pr[0] - x, pr[1] - y) : Infinity;
}
function starPickRadius() { return 22; }
function pickSceneTarget(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const w = rect.width || 1, h = rect.height || 1;
    let best = BODY_NONE, bestD = Infinity;
    let d;
    if (!WORLD.earthDestroyed) {
        d = screenDistance(earthG.position, x, y, w, h, pickProject);
        if (d < targetPickRadius(BODY_EARTH, earthG.position) && d < bestD) { best = BODY_EARTH; bestD = d; }
    }
    if (!WORLD.sunDestroyed) {
        d = screenDistance(sunCore.position, x, y, w, h, pickProject);
        if (d < targetPickRadius(BODY_SUN, sunCore.position) && d < bestD) { best = BODY_SUN; bestD = d; }
    }
    if (!WORLD.moonDestroyed) {
        d = screenDistance(moon.position, x, y, w, h, pickProject);
        if (d < targetPickRadius(BODY_MOON, moon.position) && d < bestD) { best = BODY_MOON; bestD = d; }
    }
    for (let i = 0; i < PL.length; i++) if (!WORLD.plDestroyed[i]) {
        const pos = plGroups[i].position;
        d = screenDistance(pos, x, y, w, h, pickProject);
        if (d < targetPickRadius(i, pos) && d < bestD) { best = i; bestD = d; }
    }
    for (let i = 0; i < MOONS.length; i++) {
        if (WORLD.plDestroyed[MOONS[i].p] || !moonGroups[i].visible) continue;
        const pos = moonGroups[i].position;
        d = screenDistance(pos, x, y, w, h, pickProject);
        const rad = Math.max(renderQuality.mobile ? 22 : 14, Math.min(46, MOONS[i].R * K / Math.max(1e-9, camera.position.distanceTo(pos)) * 1500 + 12));
        if (d < rad && d < bestD) { best = moonFocusValue(i); bestD = d; }
    }
    for (let i = 0; i < BH.n; i++) {
        const pos = bhScenePos(i, _pickProbePos);
        const target = bhFocusValue(i);
        d = screenDistance(pos, x, y, w, h, pickProject);
        if (d < targetPickRadius(target, pos) && d < bestD) { best = target; bestD = d; }
    }
    if (cam.dist > LY_SCENE * .001) {
        for (let i = 0; i < STARS.length; i++) {
            d = screenDistance(starScenePos(i, _pickProbePos), x, y, w, h, pickProject);
            if (d < starPickRadius() && d < bestD) { best = starFocusValue(i); bestD = d; }
        }
        for (const star of ACTIVE_STARS) if (star.procedural || star.activeCatalog) {
            d = screenDistance(activeStarScenePos(star, _pickProbePos), x, y, w, h, pickProject);
            if (d < starPickRadius() && d < bestD) { best = activeStarFocusValue(star); bestD = d; }
        }
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
    if (target !== BODY_NONE) focusTarget(target, renderQuality.mobile);
});

function contactBody(target, name, R, mu) {
    return { target, name, x: 0, y: 0, vx: 0, vy: 0, R, mu, rho: mu / Math.max(1, R * R * R), rocheMax: R * 60 };
}
const CONTACT_SOURCES = [
    contactBody("earth", "Earth", R_EARTH, MU_E),
    contactBody("moon", "Moon", R_MOON, MU_M),
    contactBody("sun", "Sun", R_SUN, MU_S),
    ...PL.map((p, i) => contactBody(i, p.name, p.R, p.mu)),
];
const CONTACT_BODIES = new Array(CONTACT_SOURCES.length);
function setContactBody(slot, x, y, vx, vy) {
    slot.x = x; slot.y = y; slot.vx = vx; slot.vy = vy;
    return slot;
}
function bodyContactList() {
    let n = 0;
    if (!WORLD.earthDestroyed) CONTACT_BODIES[n++] = setContactBody(CONTACT_SOURCES[0], 0, 0, 0, 0);
    if (!WORLD.moonDestroyed) CONTACT_BODIES[n++] = setContactBody(CONTACT_SOURCES[1], eph.moonX, eph.moonY, eph.moonVx, eph.moonVy);
    if (!WORLD.sunDestroyed) CONTACT_BODIES[n++] = setContactBody(CONTACT_SOURCES[2], eph.sunX, eph.sunY, eph.sunVx, eph.sunVy);
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        const src = CONTACT_SOURCES[3 + i];
        CONTACT_BODIES[n++] = setContactBody(src, eph.plX[i], eph.plY[i], eph.plVx[i], eph.plVy[i]);
    }
    return n;
}
function rocheLimit(big, small) {
    return Math.min(big.rocheMax, 2.44 * big.R * Math.cbrt(big.rho / Math.max(1e-12, small.rho)));
}
function checkBodyContacts() {
    const count = bodyContactList();
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
        const a = CONTACT_BODIES[i], b = CONTACT_BODIES[j];
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

// ---- hover: body velocity readout + direction arrow ----
const hoverTipEl = document.getElementById("hoverTip");
const flModeEl = document.getElementById("flMode");
const navReadEl = document.getElementById("navRead");
initAttitude(document.getElementById("attCanvas"));
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
// WP17 multi-frustum tiering: these are always ship/cockpit-scale content
// (never meaningfully at galactic distance) but opt out of frustum culling
// to survive camera-relative repositioning, so without this they'd cost one
// wasted (fully clipped, invisible) draw call in the far pass every frame.
// river.js's particle `lines` and trails.js's `predLine`/`bodyPredLine`/
// `bodyPredDots` are the same kind of always-near, frustumCulled:false
// content but aren't exported by their owning module this wave, so they
// still pay that one extra draw call — a documented, harmless (invisible
// either way) follow-up.
registerNearTierOnly(
    shipG, dot, flame, plasma, exhaust, explosion, xpFlash,
    arrow, flowArrow, darkEnergyArrow, haloArrow, tipV, tipF, tipDE, tipHalo,
    hovLine, hovCone, focusVelLine, focusVelCone,
);
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
        let d;
        if (!WORLD.earthDestroyed) {
            d = screenDistance(earthG.position, lastPtr[0], lastPtr[1], w, h, hoverProject);
            if (d < bestD) { bestD = d; best = BODY_EARTH; bestPos = _hoverBestPos.copy(earthG.position); }
        }
        if (!WORLD.sunDestroyed) {
            d = screenDistance(sunCore.position, lastPtr[0], lastPtr[1], w, h, hoverProject);
            if (d < bestD) { bestD = d; best = BODY_SUN; bestPos = _hoverBestPos.copy(sunCore.position); }
        }
        if (!WORLD.moonDestroyed) {
            d = screenDistance(moon.position, lastPtr[0], lastPtr[1], w, h, hoverProject);
            if (d < bestD) { bestD = d; best = BODY_MOON; bestPos = _hoverBestPos.copy(moon.position); }
        }
        for (let i = 0; i < PL.length; i++) if (!WORLD.plDestroyed[i]) {
            const pos = plGroups[i].position;
            d = screenDistance(pos, lastPtr[0], lastPtr[1], w, h, hoverProject);
            if (d < bestD) { bestD = d; best = i; bestPos = _hoverBestPos.copy(pos); }
        }
        for (let i = 0; i < BH.n; i++) {
            const pos = bhScenePos(i, _hoverProbePos);
            d = screenDistance(pos, lastPtr[0], lastPtr[1], w, h, hoverProject);
            if (d < bestD) { bestD = d; best = bhFocusValue(i); bestPos = _hoverBestPos.copy(pos); }
        }
        if (cam.dist > LY_SCENE * .001) {
            for (let i = 0; i < STARS.length; i++) {
                const pos = starScenePos(i, _hoverProbePos);
                d = screenDistance(pos, lastPtr[0], lastPtr[1], w, h, hoverProject);
                if (d < bestD) { bestD = d; best = starFocusValue(i); bestPos = _hoverBestPos.copy(pos); }
            }
            for (const star of ACTIVE_STARS) if (star.procedural || star.activeCatalog) {
                const pos = activeStarScenePos(star, _hoverProbePos);
                d = screenDistance(pos, lastPtr[0], lastPtr[1], w, h, hoverProject);
                if (d < bestD) { bestD = d; best = activeStarFocusValue(star); bestPos = _hoverBestPos.copy(pos); }
            }
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
const tier1CamDirScene = new THREE.Vector3();
const tier1CamDirWorld = { x: 0, y: 0, z: 1 };
let camPrevFocus = null;
const _m = { mx: 0, my: 0, vmx: 0, vmy: 0, ang: 0 };
const arrC = [0, 0, 0];
const fv = [0, 0, 0];
let placed = false, frameNo = 0, grB = 0, exAcc = 0, exAnyAlive = false, hudReady = false, nearLabelsReady = false, nearVisualReady = false;
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
function accelerationLabel(kmps2) {
    const ms2 = Math.max(0, kmps2 * 1000);
    if (ms2 >= 1e-8) return (ms2 * 1e9).toFixed(2) + " nm/s²";
    return ms2.toExponential(2) + " m/s²";
}
function sceneVecFromKm(x, y, z, out) {
    out[0] = x * K;
    out[1] = z * K;
    out[2] = -y * K;
    return out;
}
const cosmoDEVec = [0, 0, 0];
const cosmoDMVec = [0, 0, 0];
const cosmoDMAcc = [0, 0, 0];
function setLineVector(pos, attr, x0, y0, z0, vx, vy, vz, lenScale, maxLen) {
    const mag = Math.hypot(vx, vy, vz);
    if (mag <= 1e-18) return false;
    const len = Math.min(maxLen, lenScale * mag) / mag;
    pos[0] = x0; pos[1] = y0; pos[2] = z0;
    pos[3] = x0 + vx * len; pos[4] = y0 + vy * len; pos[5] = z0 + vz * len;
    attr.needsUpdate = true;
    return true;
}
function hideCosmologyArrows() {
    darkEnergyArrow.visible = false; tipDE.visible = false;
    haloArrow.visible = false; tipHalo.visible = false;
}
function updateCosmologyVectors(oriX, oriY, oriZ, earthX, earthZ, cd, alpha = 1) {
    const rKm = Math.hypot(G.x, G.y, G.z);
    const maxLen = Math.max(cd * .14, LY_SCENE * .02);
    const lenScale = Math.max(cd * .035, LY_SCENE * .003);
    let any = false;
    if (G.darkEnergy) {
        const fade = darkEnergyVisibleFractionKm(rKm);
        const vx = (oriX - earthX) * fade;
        const vy = oriY * fade;
        const vz = (oriZ - earthZ) * fade;
        if (fade > .01 && setLineVector(deArrPos, deArrAttr, oriX, oriY, oriZ, vx, vy, vz, lenScale, maxLen)) {
            darkEnergyArrow.material.opacity = Math.min(.95, .18 + .72 * fade) * alpha;
            darkEnergyArrow.visible = true;
            tipDE.visible = true;
            tipDE.position.set(deArrPos[3], deArrPos[4], deArrPos[5]);
            tipDE.scale.setScalar(Math.max(cd * .01, LY_SCENE * .004));
            tipDE.material.opacity = darkEnergyArrow.material.opacity;
            any = true;
        } else {
            darkEnergyArrow.visible = false; tipDE.visible = false;
        }
    } else {
        darkEnergyArrow.visible = false; tipDE.visible = false;
    }
    if (G.darkMatter) {
        darkMatterRelativeAccel(G.x, G.y, G.z, eph.earthX, eph.earthY, 0, cosmoDMAcc);
        sceneVecFromKm(
            cosmoDMAcc[0] * DARK_MATTER.ARROW_SECONDS,
            cosmoDMAcc[1] * DARK_MATTER.ARROW_SECONDS,
            cosmoDMAcc[2] * DARK_MATTER.ARROW_SECONDS,
            cosmoDMVec,
        );
        const [gx, gy, gz] = equatorialKmToGal(eph.earthX + G.x, eph.earthY + G.y, G.z);
        const [ex, ey, ez] = equatorialKmToGal(eph.earthX, eph.earthY, 0);
        const fade = darkMatterVisibleFractionPc(Math.hypot(gx - ex, gy - ey, gz - ez));
        if (fade > .01 && setLineVector(haloArrPos, haloArrAttr, oriX, oriY, oriZ, cosmoDMVec[0], cosmoDMVec[1], cosmoDMVec[2], lenScale, maxLen)) {
            haloArrow.material.opacity = Math.min(.9, .16 + .7 * fade) * alpha;
            haloArrow.visible = true;
            tipHalo.visible = true;
            tipHalo.position.set(haloArrPos[3], haloArrPos[4], haloArrPos[5]);
            tipHalo.scale.setScalar(Math.max(cd * .01, LY_SCENE * .004));
            tipHalo.material.opacity = haloArrow.material.opacity;
            any = true;
        } else {
            haloArrow.visible = false; tipHalo.visible = false;
        }
    } else {
        haloArrow.visible = false; tipHalo.visible = false;
    }
    return any;
}
function hideNearFieldLabels() {
    nearLabelsReady = false;
    hideLabel(lblE); hideLabel(lblM); hideLabel(lblS); hideLabel(lblO);
    for (let i = 0; i < PL.length; i++) hideLabel(plLabels[i]);
    for (let i = 0; i < MOONS.length; i++) hideLabel(moonLabels[i]);
    for (let i = 0; i < BH_MAX; i++) { setLabelDisplay(bhLabels[i], "none"); hideLabel(bhLabels[i]); }
}
function nearestStarInfo() {
    const wx = eph.earthX + G.x, wy = eph.earthY + G.y, wz = G.z;
    const nearest = nearestActiveStar(wx, wy, wz);
    return { star: nearest.star, d: nearest.d };
}
let cabinModeApplied = false;
let cabinHudHtml = "";
function updateCabinHUD(cosmicView, oi) {
    const cabinActive = G.cabin && !G.dead && !cosmicView;
    if (cabinModeApplied !== cabinActive) {
        const cabinDomT0 = perfStart();
        cabinModeApplied = cabinActive;
        document.body.classList.toggle("mode-cabin", cabinActive);
        if (cabinHudEl) cabinHudEl.setAttribute("aria-hidden", cabinActive ? "false" : "true");
        if (cabinActive) {
            hideNearFieldLabels();
            hideStarLabels();
        } else cabinHudHtml = "";
        perfEnd("cockpit.modeDom", cabinDomT0, PERF.enabled ? { cabin: cabinActive } : null);
    }
    // glass HUD: the always-readable line the 3D panels can't show at a glance
    if (cabinActive && frameNo % 5 === 0) {
        const apOn = AP.mode !== "off";
        const html =
            '<span class="chMain">T+ ' + fmtMET(G.t) +
            ' · ⏩ ' + warpLabel(G.warp) + (G.paused ? " ❚❚" : "") +
            ' · VEL ' + Math.hypot(G.vx, G.vy, G.vz).toFixed(2) + " km/s" +
            ' · ALT ' + fmtDist(Math.max(0, oi.r - oi.R)) + " · " + oi.body +
            (apOn ? ' · <span class="chAp">AP ' + AP.mode.toUpperCase() + "</span>" : "") +
            "</span><br><span class=\"chHint\">DRAG TO LOOK · J EXTERNAL VIEW</span>";
        if (cabinHudEl && html !== cabinHudHtml) {
            cabinHudHtml = html;
            cabinHudEl.innerHTML = html;
        }
    }
    return cabinActive;
}
function hudCadence(cabinActive, aMag) {
    if (cabinActive || aMag > 0) return 1;
    if (renderQuality.mobile) return G.warp <= 60 ? 2 : 3;
    if (G.warp <= 60) return 2;
    return G.warp > 600 ? 6 : 2;
}
function nearLabelCadence() {
    if (renderQuality.mobile) return G.warp > 600 ? 6 : G.warp > 60 ? 4 : 2;
    if (G.warp > 3600) return 6;
    if (G.warp > 600) return 4;
    return 2;
}
const BODY_SURFACE_MIN_PX_DESKTOP = 1.35, BODY_SURFACE_MIN_PX_MOBILE = 2.0;
const BODY_DETAIL_MIN_PX = 10;
function screenRadiusPx(pos, radiusScene) {
    const d = Math.max(1e-6, camera.position.distanceTo(pos));
    return radiusScene / d * viewportSize.pxScale;
}
function screenRadiusAtLeast(pos, radiusScene, minPx, pxScale) {
    const limit = radiusScene * pxScale / Math.max(1e-6, minPx);
    return camera.position.distanceToSquared(pos) <= limit * limit;
}
function hideBodySurfaces() {
    earth.visible = false;
    clouds.visible = false;
    if (earthAtmo) earthAtmo.visible = false;
    moon.visible = false;
    sunCore.visible = false;
    sunCorona.visible = false;
    for (let i = 0; i < PL.length; i++) plSurfaces[i].visible = false;
}
function updateBodySurfaceLod(cosmicView, detailShed) {
    if (cosmicView) { hideBodySurfaces(); return; }
    if (!detailShed) {
        earth.visible = !WORLD.earthDestroyed;
        clouds.visible = !WORLD.earthDestroyed;
        if (earthAtmo) earthAtmo.visible = !WORLD.earthDestroyed;
        moon.visible = !WORLD.moonDestroyed;
        sunCore.visible = !WORLD.sunDestroyed;
        sunCorona.visible = !WORLD.sunDestroyed;
        for (let i = 0; i < PL.length; i++) plSurfaces[i].visible = !WORLD.plDestroyed[i];
        return;
    }
    const minPx = renderQuality.mobile ? BODY_SURFACE_MIN_PX_MOBILE : BODY_SURFACE_MIN_PX_DESKTOP;
    const pxScale = viewportSize.pxScale;
    const earthSurface = !WORLD.earthDestroyed && screenRadiusAtLeast(earthG.position, R_EARTH * K, minPx, pxScale);
    const earthDetails = earthSurface && screenRadiusAtLeast(earthG.position, R_EARTH * K, BODY_DETAIL_MIN_PX, pxScale);
    earth.visible = earthSurface;
    clouds.visible = earthDetails;
    if (earthAtmo) earthAtmo.visible = earthDetails;

    if (!WORLD.moonDestroyed) moon.visible = screenRadiusAtLeast(moon.position, R_MOON * K, minPx, pxScale);

    sunCore.visible = !WORLD.sunDestroyed && screenRadiusAtLeast(sunCore.position, SUN_RADIUS, minPx, pxScale);
    sunCorona.visible = !WORLD.sunDestroyed && screenRadiusAtLeast(sunCore.position, SUN_RADIUS, BODY_DETAIL_MIN_PX, pxScale);

    for (let i = 0; i < PL.length; i++) {
        plSurfaces[i].visible = !WORLD.plDestroyed[i] && screenRadiusAtLeast(plGroups[i].position, PL[i].R * K, minPx, pxScale);
    }
}
let bodyLodReady = false, bodyLodLastDist = 0, bodyLodLastFocus = null, bodyLodLastCosmic = false, bodyLodLastDetail = false;

function renderFrame(showCockpit) {
    if (VR.active) { renderVRFrame(showCockpit && VR.mode === "ship"); return; }
    const renderT0 = perfStart();
    const worldRenderT0 = perfStart();
    if ((bloomPass.enabled || lensingPass.enabled) && composer) composer.render();
    else renderSceneTiered(renderer, scene, camera);
    perfEnd("render.world", worldRenderT0, PERF.enabled ? {
        bloom: !!bloomPass.enabled,
        lensing: !!lensingPass.enabled,
    } : null);
    if (showCockpit) {
        compileCockpitNow();
        const cockpitRenderT0 = perfStart();
        // interior composited over the world: depth cleared, color kept, no bloom
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(cockpitScene, cockpitCam);
        renderer.autoClear = true;
        perfEnd("render.cockpit", cockpitRenderT0);
    }
    perfEnd("render.frame", renderT0, PERF.enabled ? {
        calls: renderer.info.render.calls,
        points: renderer.info.render.points,
        triangles: renderer.info.render.triangles,
        lines: renderer.info.render.lines,
        bloom: !!bloomPass.enabled,
        bloomScale: renderQuality.bloomScale,
        lensing: !!lensingPass.enabled,
        dpr: renderQuality.dpr,
        loadShed: renderQuality.loadShed,
    } : null);
    sampleRendererInfo(renderer);
    sampleMemory();
}

function finishFramePerf(start, dtR, rawDtR, dtRCap, cosmicView, cabinActive) {
    perfEnd("frame.total", start, PERF.enabled ? {
        dtR,
        rawDtR,
        dtRCap,
        warp: G.warp,
        cosmicView,
        cabin: cabinActive,
        mobile: renderQuality.mobile,
        loadShed: renderQuality.loadShed,
    } : null);
}

function frame() {
    const frameT0 = perfStart();
    const rawDtR = clock.getDelta();
    tickXrPerf(renderer, rawDtR * 1000);
    const highWarp = G.warp > 600;
    const dtRCap = highWarp ? (renderQuality.mobile ? 1 / 45 : 1 / 30) : .06;
    const dtR = Math.min(dtRCap, rawDtR);
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
            // liftoff: nudge off the surface along the full 3-D radial and
            // hand back to physics. Bodies carry real z since WP13/14 and
            // snapLanded preserves landing latitude — zeroing G.z here would
            // teleport a high-latitude ship back to the equatorial plane.
            let cx = 0, cy = 0, cz = 0;
            if (G.landed.body === "planet") { cx = eph.plX[G.landed.i]; cy = eph.plY[G.landed.i]; cz = eph.plZ ? eph.plZ[G.landed.i] : 0; }
            else if (G.landed.body !== "earth") { moonState(G.t, _m); cx = _m.mx; cy = _m.my; cz = eph.moonZ || 0; }
            const rdx = G.x - cx, rdy = G.y - cy, rdz = G.z - cz;
            const rlen = Math.hypot(rdx, rdy, rdz) || 1;
            G.x += 0.03 * rdx / rlen; G.y += 0.03 * rdy / rlen; G.z += 0.03 * rdz / rlen;
            G.landed = null;
            hideBanner();
        }
    }
    // ---- physics ----
    const physicsT0 = perfStart();
    let advanced = 0, activeStarsFresh = false;
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
        } else {
            advanced = advance(dtR * G.warp, atx, aty, atz, aMag);
            activeStarsFresh = true;
        }
    }
    snapLanded();
    const oi = orbitInfo();
    perfEnd("frame.physics", physicsT0, PERF.enabled ? { advanced, warp: G.warp, dtR, rawDtR, dtRCap } : null);
    const cosmicView = cam.dist > LY_SCENE * .2;
    const cosmicLod = cam.dist > LY_SCENE * 800000 ? 3 : cam.dist > LY_SCENE * 20000 ? 2 : cosmicView ? 1 : 0;
    const pixelLoadShed = renderQuality.mobile ? (G.warp > 600 && G.gr ? 2 : 1) :
        G.warp > 86400 && G.gr && cam.dist < LY_SCENE * .2 ? 1 : 0;
    setRenderLoadShed(pixelLoadShed);
    const nearFieldDue = cosmicLod === 0 || frameNo % (cosmicLod === 1 ? 6 : cosmicLod === 2 ? 18 : 45) === 0;
    const activeStarsDue = cosmicLod === 0 || frameNo % (cosmicLod === 1 ? 12 : cosmicLod === 2 ? 45 : 120) === 0;
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
    const sceneT0 = perfStart();
    const sceneBodiesT0 = perfStart();
    const detailShed = renderQuality.mobile || G.warp > 600;
    const nearVisualEvery = detailShed ? (renderQuality.mobile ? 6 : 3) : 1;
    const nearVisualDue = nearFieldDue && (!nearVisualReady || nearVisualEvery <= 1 || frameNo % nearVisualEvery === 0);
    const earthX = eph.earthX * K, earthZ = -eph.earthY * K;
    earthV.set(earthX, 0, earthZ);
    if (nearFieldDue) {
        earthG.position.copy(earthV);
        moonOrbitRing.position.copy(earthV);
        moonState(G.t, _m);
        moonV.set((eph.earthX + _m.mx) * K, 0, -(eph.earthY + _m.my) * K);
        moon.position.copy(moonV);
        moon.rotation.y = _m.ang + Math.PI * .5;
        moonSoiRing.position.copy(moonV);
    }
    const earthVisible = !WORLD.earthDestroyed && !cosmicView;
    earthG.visible = earthVisible;
    if (!earthVisible) {
        earth.visible = false;
        clouds.visible = false;
        if (earthAtmo) earthAtmo.visible = false;
    } else if (!detailShed) {
        earth.visible = true;
        clouds.visible = true;
        if (earthAtmo) earthAtmo.visible = true;
    }
    moonOrbitRing.visible = !WORLD.earthDestroyed && !WORLD.moonDestroyed && !cosmicView;
    const moonVisible = !WORLD.moonDestroyed && !cosmicView;
    if (!moonVisible) moon.visible = false;
    else if (!detailShed) moon.visible = true;
    // sun & planets follow the live ephemeris (cache refreshed by orbitInfo above)
    if (nearFieldDue) {
        sunPos.set((eph.earthX + eph.sunX) * K, 0, -(eph.earthY + eph.sunY) * K);
        sunCore.position.copy(sunPos);
        sunGlow.position.copy(sunPos);
        sunLight.position.copy(sunPos);
        sunCorona.position.copy(sunPos);
    }
    const sunVisible = !WORLD.sunDestroyed && !cosmicView;
    sunGlow.visible = sunVisible;
    sunLight.visible = sunVisible;
    if (!sunVisible) {
        sunCore.visible = false;
        sunCorona.visible = false;
    } else if (!detailShed) {
        sunCore.visible = true;
        sunCorona.visible = true;
    }
    // shader sun direction (Earth-frame) + sidereal Earth spin, kept in [0, 2π)
    if (nearFieldDue) {
        sunDirW.set(sunPos.x - earthX, 0, sunPos.z - earthZ).normalize();
        earth.rotation.y = (OMEGA_EARTH * G.t) % (Math.PI * 2);
    }
    flowCtx.earthScX = earthX; flowCtx.earthScZ = earthZ;
    flowCtx.sunScX = sunPos.x; flowCtx.sunScZ = sunPos.z;
    if (nearFieldDue) {
        for (let i = 0; i < PL.length; i++) {
            const px = (eph.earthX + eph.plX[i]) * K, pz = -(eph.earthY + eph.plY[i]) * K;
            plGroups[i].position.set(px, 0, pz);
            flowCtx.plScX[i] = px; flowCtx.plScZ[i] = pz;
            if (nearVisualDue) {
                plGlows[i].position.set(px, 0, pz);
                plOrbitRings[i].position.copy(sunPos);
                plGroups[i].rotation.z = PL[i].visualTilt || 0;
                plSurfaces[i].rotation.y = (PL[i].spin * G.t) % (Math.PI * 2);
                const dCamP = camera.position.distanceTo(plGroups[i].position);
                const glowNear = PL[i].R * K * (PL[i].gas ? 2.7 : 2.25);
                const glowFar = PL[i].R * K * (PL[i].gas ? 11.5 : 8.25);
                plGlows[i].scale.setScalar(Math.min(glowFar, Math.max(glowNear, dCamP * (PL[i].gas ? .0024 : .0021))));
                const farGlow = smooth01(PL[i].R * K * 30, PL[i].R * K * 210, dCamP);
                const tinyGlow = smooth01(PL[i].R * K * 150, PL[i].R * K * 520, dCamP);
                const glowGain = PL[i].gas ? 1.18 : 1;
                plGlows[i].material.opacity = Math.min(.34, (.055 + .16 * farGlow + .055 * tinyGlow) * glowGain);
            }
        }
        for (let i = 0; i < MOONS.length; i++) {
            const m = MOONS[i];
            moonOffset(m, G.t, _moonOff);
            const mx = (eph.earthX + eph.plX[m.p] + _moonOff.x) * K;
            const mz = -(eph.earthY + eph.plY[m.p] + _moonOff.y) * K;
            moonGroups[i].position.set(mx, 0, mz);
            if (nearVisualDue) {
                moonGlows[i].position.set(mx, 0, mz);
                const dCam = camera.position.distanceTo(moonGroups[i].position);
                // hold the beacon at a near-constant on-screen size so even tiny
                // moons (Phobos, Mimas) stay visible as dots; the true sphere
                // takes over once you close in
                moonGlows[i].scale.setScalar(Math.max(m.R * K * 1.4, dCam * .006));
                moonSurfaces[i].rotation.y = (G.t * 6e-6 * (m.retro ? -1 : 1)) % (Math.PI * 2);
            }
        }
        const bhVisualDue = BH.n > 0 || isBHPlacementMode() || !nearVisualReady || frameNo % 12 === 0;
        if (bhVisualDue) updateBHVisuals(dtR, earthX, earthZ);
    }
    if (nearVisualDue) nearVisualReady = true;
    perfEnd("scene.bodies", sceneBodiesT0, PERF.enabled ? { nearFieldDue, nearVisualDue, cosmicView } : null);
    const sceneFocusT0 = perfStart();
    for (let i = 0; i < PL.length; i++) {
        plGroups[i].visible = !WORLD.plDestroyed[i] && !cosmicView;
        plGlows[i].visible = !WORLD.plDestroyed[i] && !cosmicView;
        plOrbitRings[i].visible = !WORLD.plDestroyed[i] && !WORLD.sunDestroyed && !cosmicView;
    }
    const focusMoon = moonFocusIndex(G.focus);
    for (let i = 0; i < MOONS.length; i++) {
        const m = MOONS[i];
        const show = !WORLD.plDestroyed[m.p] && !cosmicView &&
            (focusMoon === i || camera.position.distanceTo(moonGroups[i].position) < m.a * K * 90);
        moonGroups[i].visible = show;
        moonGlows[i].visible = show;
    }
    const focusBH = blackHoleFocusIndex(G.focus);
    if (focusBH >= BH.n) setFocus("ship");
    const focusStar = starFocusIndex(G.focus);
    if (focusStar >= STARS.length) setFocus("ship");
    if (activeStarsDue) {
        if (proceduralFocusId(G.focus) && !activeStarForFocus(G.focus)) setFocus("ship");
        if (hygCatalogFocusId(G.focus) && hygCatalogStats().loaded && !activeStarForFocus(G.focus)) setFocus("ship");
        if (!activeStarsFresh) refreshActiveStars(eph.earthX + G.x, eph.earthY + G.y, G.z, G.focus, G.t);
    }
    const oriX = (eph.earthX + G.x) * K, oriY = G.z * K, oriZ = -(eph.earthY + G.y) * K;
    shipG.position.set(oriX, oriY, oriZ);
    shipG.visible = !G.dead && !cosmicView && !G.cabin;
    clouds.rotation.y += dtR * .01;
    perfEnd("scene.focus", sceneFocusT0, PERF.enabled ? { activeStarsDue, activeStarsFresh, focus: String(G.focus) } : null);
    // ---- camera ----
    const sceneCameraT0 = perfStart();
    // "free" focus: the target stays wherever panning put it
    const activeBHFocus = focusBH >= 0 && focusBH < BH.n;
    const activeStarFocus = focusStar >= 0 && focusStar < STARS.length;
    const activeMoonFocus = focusMoon >= 0;
    const activeDynamicFocus = activeStarForFocus(G.focus);
    {
        const cp = Math.cos(G.pitch || 0);
        dirV.set(cp * Math.cos(G.heading), Math.sin(G.pitch || 0), -cp * Math.sin(G.heading));
    }
    const tgt = activeBHFocus ? bhScenePos(focusBH) : activeStarFocus ? starScenePos(focusStar) :
        activeMoonFocus ? moonGroups[focusMoon].position :
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
        activeMoonFocus ? Math.max(.05, MOONS[focusMoon].R * K * 1.3) :
        activeDynamicFocus ? activeDynamicFocus.R * K * 1.8 :
        G.focus === "free" ? .03 : typeof G.focus === "number" ? PL[G.focus].R * K * 1.3 :
        G.focus === "earth" ? R_EARTH * K * 1.3 : G.focus === "moon" ? R_MOON * K * 1.3 : G.focus === "sun" ? SUN_RADIUS * 1.25 : .05;
    // smooth fly-in toward the distance a focus pick requested (manual zoom clears it)
    if (cam.distTarget != null) {
        const goal = cam.distTarget;
        cam.dist += (goal - cam.dist) * Math.min(1, dtR * 4);
        if (Math.abs(goal - cam.dist) <= goal * .02) { cam.dist = goal; cam.distTarget = null; }
    }
    cam.dist = Math.max(minD, cam.dist);
    const cabinActive = updateCabinHUD(cosmicView, oi);
    const hudEvery = hudCadence(cabinActive, aMag);
    const hudDue = !hudReady || frameNo % hudEvery === 0;
    if (hudDue) hudReady = true;
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
    perfEnd("scene.camera", sceneCameraT0, PERF.enabled ? { cabin: cabinActive, vr: VR.active, focus: String(G.focus) } : null);
    // ---- Tier-1 streaming star field (WP10) ----
    // Runs every frame, deliberately ahead of the cosmicView early-return
    // below, so the sky keeps streaming in even while zoomed out to galaxy
    // scale. camera.position is scene units relative to the render origin
    // (frozen at (0,0,0) this wave, see tier1RebaseEnabled above); invert the
    // world->scene axis map from renderOrigin.js to recover the camera's
    // world-frame (heliocentric-equatorial) km position and forward direction
    // that updateTier1/queryDisc expect.
    {
        const tier1Origin = getOrigin();
        const camWorldKmX = tier1Origin.x + camera.position.x / K;
        const camWorldKmY = tier1Origin.y - camera.position.z / K;
        const camWorldKmZ = tier1Origin.z + camera.position.y / K;
        camera.getWorldDirection(tier1CamDirScene);
        tier1CamDirWorld.x = tier1CamDirScene.x;
        tier1CamDirWorld.y = -tier1CamDirScene.z;
        tier1CamDirWorld.z = tier1CamDirScene.y;
        updateTier1(camWorldKmX, camWorldKmY, camWorldKmZ, tier1CamDirWorld, G.t);
        if (tier1RebaseEnabled) {
            const rebaseThresholdKm = Math.max(1e6, (cam.dist / K) * .5);
            if (maybeRebase(camWorldKmX, camWorldKmY, camWorldKmZ, rebaseThresholdKm)) refreshTier1Residuals();
        }
    }
    const bodyLodT0 = perfStart();
    const bodyLodEvery = detailShed ? (renderQuality.mobile ? 6 : 3) : 1;
    const bodyLodDistJump = bodyLodLastDist > 0 ? Math.abs(Math.log(Math.max(1e-9, cam.dist / bodyLodLastDist))) : Infinity;
    const bodyLodDue = !bodyLodReady || bodyLodEvery <= 1 || frameNo % bodyLodEvery === 0 ||
        bodyLodLastFocus !== G.focus || bodyLodLastCosmic !== cosmicView || bodyLodLastDetail !== detailShed || bodyLodDistJump > .06;
    if (bodyLodDue) {
        updateBodySurfaceLod(cosmicView, detailShed);
        bodyLodReady = true;
        bodyLodLastDist = cam.dist;
        bodyLodLastFocus = G.focus;
        bodyLodLastCosmic = cosmicView;
        bodyLodLastDetail = detailShed;
    }
    perfEnd("scene.bodyLod", bodyLodT0, PERF.enabled ? { cosmicView, detailShed, bodyLodDue, bodyLodEvery } : null);
    placed = true;
    // near plane tracks clearance to the nearest surface: the fixed 20 km
    // near (kept for depth precision in space) clipped the entire ground
    // when landed, so stars and the river shone through the planet
    const nearPlaneT0 = perfStart();
    let clearU = Infinity;
    let nearPlaneStarChecks = 0;
    if (!cosmicView) {
        if (!WORLD.earthDestroyed) clearU = Math.min(clearU, camera.position.distanceTo(earthG.position) - R_EARTH * K);
        if (!WORLD.moonDestroyed) clearU = Math.min(clearU, camera.position.distanceTo(moon.position) - R_MOON * K);
        if (!WORLD.sunDestroyed) clearU = Math.min(clearU, camera.position.distanceTo(sunCore.position) - SUN_RADIUS);
        for (let i = 0; i < PL.length; i++) if (!WORLD.plDestroyed[i]) clearU = Math.min(clearU, camera.position.distanceTo(plGroups[i].position) - PL[i].R * K);
        if (activeStarFocus || activeDynamicFocus || cam.dist > LY_SCENE * .02) {
            for (const star of ACTIVE_STARS) {
                nearPlaneStarChecks++;
                _starLabelPos.set(star.x * K, (star.z || 0) * K, -star.y * K);
                clearU = Math.min(clearU, camera.position.distanceTo(_starLabelPos) - (star.bh ? star.rs : star.R) * K);
            }
        }
        for (let i = 0; i < BH.n; i++) clearU = Math.min(clearU, camera.position.distanceTo(bhScenePos(i)) - BH.rs[i] * K);
    } else clearU = Math.max(.02, cam.dist * .001);
    const nearWant = Math.min(.02, Math.max(2e-6, clearU * .5));
    if (Math.abs(nearWant - camera.near) > camera.near * .1) {
        camera.near = nearWant;
        camera.updateProjectionMatrix();
    }
    perfEnd("scene.nearPlane", nearPlaneT0, PERF.enabled ? { starChecks: nearPlaneStarChecks, clearU, near: camera.near } : null);
    if (sky) { sky.position.copy(camera.position); sky.visible = !cosmicView; }
    if (skyStars) { skyStars.position.copy(camera.position); skyStars.visible = !cosmicView; }
    if (galaxyBackdrop) { galaxyBackdrop.position.copy(camera.position); galaxyBackdrop.visible = !cosmicView && (!renderQuality.mobile || galaxyBackdropForced); }
    perfEnd("scene.update", sceneT0, PERF.enabled ? {
        cosmicLod,
        activeStars: ACTIVE_STARS.length,
        nearFieldDue,
        activeStarsDue,
    } : null);
    const cosmicT0 = perfStart();
    updateCosmicLayer();
    perfEnd("cosmic.update", cosmicT0, PERF.enabled ? { cosmicView, dist: cam.dist } : null);
    if (cosmicView) {
        const cosmicSpeed = Math.hypot(G.vx, G.vy, G.vz);
        const cosmicCd = camera.position.distanceTo(shipG.position);
        updateCosmologyVectors(oriX, oriY, oriZ, earthX, earthZ, cosmicCd, 1);
        if (hudDue) {
            updateMobileControls(oi, cosmicSpeed, aMag);
            if (!renderQuality.mobile) {
                updateHUD(oi, aMag, mainIn, cosmicSpeed, cosmicSpeed, 1);
                if (flModeEl) setHudText(flModeEl, "DETAIL");
                if (fFlow) setHudText(fFlow, String(cosmicLod));
                if (fDark) setHudText(fDark, G.darkEnergy ? expansionSpeedLabel(darkEnergySpeedKmS(Math.hypot(G.x, G.y, G.z))) : "OFF");
                if (fHalo && !G.darkMatter) setHudText(fHalo, "OFF");
                hintTick(oi);
            }
        }
        hideNearFieldLabels();
        hideStarLabels();
        arrow.visible = false; flowArrow.visible = false; tipV.visible = false; tipF.visible = false;
        moonSoiRing.visible = false;
        clearBodyPrediction();
        lensingPass.enabled = false;
        bloomPass.enabled = false;
        renderFrame(false);
        return;
    }
    updateLensingLazy(camera, camera.aspect);
    const bloomLoadShed = renderQuality.mobile || shouldGateBloom() ||
        (!bloomForced && G.warp > 86400 && G.gr && grB > .18 && cam.dist > LY_SCENE * .05);
    bloomPass.enabled = !bloomDisabled && (bloomForced || !bloomLoadShed) && cam.dist < LY_SCENE * 400;
    if (bloomPass.enabled && !composer) ensurePostProcessing(lensingPass);
    updateBodyShaders(camera, G.t);
    const starsT0 = perfStart();
    updateStars(camera, dtR);
    perfEnd("stars.update", starsT0, PERF.enabled ? { entries: STARS.length, activeStars: ACTIVE_STARS.length } : null);
    // WP16 owns the Sun's view-aware brightness model; this call site is the
    // frozen handoff (see bodies.js:updateSunView) so WP17 never edits bodies.js.
    updateSunView(camera, camera.position.distanceTo(sunPos) / K / PC_KM);
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
    if (exAnyAlive || thrustingMain) {
        let nextExAnyAlive = false, exTouched = false;
        for (let i = 0; i < EXN; i++) {
            const j = i * 3;
            if (exLife[i] > 0) {
                exLife[i] -= dtR;
                exPos[j] += exVel[j] * dtR;
                exPos[j + 1] += exVel[j + 1] * dtR;
                exPos[j + 2] += exVel[j + 2] * dtR;
                const a = Math.max(0, exLife[i] / exMax[i]);
                exCol[j] = a; exCol[j + 1] = a * .72; exCol[j + 2] = a * .4;
                nextExAnyAlive = nextExAnyAlive || exLife[i] > 0;
                exTouched = true;
            } else if (exCol[j] || exCol[j + 1] || exCol[j + 2]) {
                exCol[j] = 0; exCol[j + 1] = 0; exCol[j + 2] = 0;
                exTouched = true;
            }
        }
        exAnyAlive = nextExAnyAlive || thrustingMain;
        exhaust.visible = exAnyAlive;
        if (exTouched) {
            exPosAttr.needsUpdate = true;
            exColAttr.needsUpdate = true;
        }
    } else exhaust.visible = false;
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
    const thrustPredEvery = G.warp > 60 ? 10 : 4;
    if (G.predict && frameNo % (aMag > 0 && G.warp <= 600 ? thrustPredEvery : predEvery) === 0) computePrediction();
    // ---- spacetime river (GPU) ----
    const grT = G.gr ? 1 : 0;
    grB += (grT - grB) * Math.min(1, dtR * 3.4);
    if (Math.abs(grT - grB) < .004) grB = grT;
    const fB = grB;
    const fRiver = fB * (1 - smooth01(2.0e7, 7.0e7, cam.dist));
    if (PERF.enabled) {
        const riverT0 = performance.now();
        updateRiver(advanced, fB, earthV, moonV, sunPos, plPosArr, dtR);
        markPerf("river.update", performance.now() - riverT0, {
            drawCount: river.drawCount || 0,
            computeEvery: river.computeEvery || 1,
            skippedCompute: !!river.skippedCompute,
            renderShed: river.renderShed || 0,
            sourceCount: river.sourceCount || 0,
            starSources: river.starSources || 0,
            starRefreshed: !!river.starRefreshed,
            sinkSources: river.sinkSources || 0,
            texW: river.texW || 0,
            computeMs: river.computeMs || 0,
            vRefRefreshed: !!river.vRefRefreshed,
            vRefCadence: river.vRefCadence || 1,
        });
        const shellsT0 = performance.now();
        updateShells(Math.min(river.dtVis ?? advanced, 900), fRiver);
        markPerf("river.shells", performance.now() - shellsT0, { visible: fRiver > .01 });
    } else {
        updateRiver(advanced, fB, earthV, moonV, sunPos, plPosArr, dtR);
        updateShells(Math.min(river.dtVis ?? advanced, 900), fRiver);
    }
    if (fRiver > .01 && hudDue && !renderQuality.mobile) {
        if (flModeEl) setHudText(flModeEl, "INFALL");
        setHudText(fFlow, (flowVel(oriX, oriY, oriZ, moonV.x, moonV.y, moonV.z, fv) * 1000).toFixed(2) + " km/s");
        const deShip = G.darkEnergy ? darkEnergySpeedKmS(Math.hypot(G.x, G.y, G.z)) : 0;
        setHudText(fDark, G.darkEnergy ? expansionSpeedLabel(deShip) : "OFF");
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
            updateCosmologyVectors(oriX, oriY, oriZ, earthX, earthZ, cd, fRiver);
        } else { flowArrow.visible = false; tipF.visible = false; hideCosmologyArrows(); }
    } else {
        arrow.visible = false; flowArrow.visible = false;
        tipV.visible = false; tipF.visible = false;
        hideCosmologyArrows();
    }
    updateFocusVelocityVector(cabinActive || cosmicView ? 0 : 1);
    // ---- audio ----
    if (thrustGain) {
        const target = (aMag > 0 && !G.muted) ? Math.min(.22, .04 + .12 * G.throttle * (G.boost ? 1.8 : 1)) : 0;
        thrustGain.gain.value += (target - thrustGain.gain.value) * Math.min(1, dtR * 12);
    }
    // ---- HUD & labels ----
    const hudT0 = perfStart();
    const hudUpdateT0 = perfStart();
    if (hudDue) {
        if (!renderQuality.mobile) {
            updateHUD(oi, aMag, mainIn, sp, kVLoc, fRiver);
            const va = Math.atan2(G.vy, G.vx);
            const moving = Math.hypot(G.vx, G.vy) > 1e-4;
            drawAttitude(G.heading, va, moving);
            if (navReadEl) {
                const hdg = Math.round(((G.heading * 180 / Math.PI) % 360 + 360) % 360);
                let d = va - G.heading; d = Math.atan2(Math.sin(d), Math.cos(d));
                setHudText(navReadEl, moving
                    ? "HDG " + hdg + "° · PRO Δ" + Math.round(Math.abs(d) * 180 / Math.PI) + "°"
                    : "HDG " + hdg + "° · PRO —");
            }
        }
        updateMobileControls(oi, sp, aMag);
        if (!renderQuality.mobile) hintTick(oi);
    }
    perfEnd("hud.update", hudUpdateT0, PERF.enabled ? { hudDue, hudEvery, mobile: renderQuality.mobile } : null);
    if (cabinActive) {
        const fuelWarn = !G.infinite && G.fuel < FUEL_DV0 * .15;
        const altWarn = !G.landed && oi.r - oi.R < 25;
        const cockpitUpdateT0 = perfStart();
        updateCockpit(dtR, sunDirW, G.heading, aMag, G.boost,
            { AP: AP.mode !== "off", ALT: altWarn, FUEL: fuelWarn, WARP: G.warp > 600 }, cabinShake);
        perfEnd("cockpit.update", cockpitUpdateT0);
        const cockpitInstrumentsT0 = perfStart();
        updateInstruments(oi, eph);
        perfEnd("cockpit.instruments", cockpitInstrumentsT0);
        setLeverThrottle(G.throttle);
        if (cockpitCam.aspect !== camera.aspect) setCockpitAspect(camera.aspect);
    }
    if (!renderQuality.mobile && frameNo % 5 === 0) updateEscapeTracker(oi);
    const w = viewportSize.w, h = viewportSize.h;
    const labelsSuppressed = cabinActive || VR.active;
    const showStarLabels = !labelsSuppressed && !renderQuality.mobile && ((cam.dist > LY_SCENE * .001 && cam.dist < LY_SCENE * 180) || activeStarFocus);
    const starLabelsDue = showStarLabels && (!starLabelsVisible || frameNo % starLabelCadence() === 0);
    let starLabelBatch = 0;
    const starLabelsT0 = perfStart();
    if (starLabelsDue) {
        const batch = Math.min(STARS.length, starLabelBatchSize());
        for (let n = 0; n < batch; n++) {
            const i = (starLabelCursor + n) % STARS.length;
            const starLabel = ensureStarLabel(i);
            if (starLabel) put(starLabel, starScenePos(i, _starLabelPos), -8, w, h);
            starLabelBatch++;
        }
        starLabelCursor = (starLabelCursor + batch) % STARS.length;
        starLabelsVisible = true;
    } else if (!showStarLabels) hideStarLabels();
    perfEnd("hud.starLabels", starLabelsT0, PERF.enabled ? { showStarLabels, starLabelsDue, starLabelBatch } : null);
    if (cosmicView || cabinActive || VR.active || renderQuality.mobile) {
        hoverTipEl.style.display = "none";
        hovLine.visible = false; hovCone.visible = false;
    } else {
        const hoverT0 = perfStart();
        updateHover(w, h);
        perfEnd("hud.hover", hoverT0, PERF.enabled ? { lastPtr: !!lastPtr, labelHover: labelHoverTarget !== BODY_NONE } : null);
    }
    const bodyPredEvery = G.warp > 600 ? 240 : G.warp > 60 ? 150 : 120;
    if (!G.predict && lockedBodyTarget !== BODY_NONE && !bodyPredHiddenForPredictOff) {
        clearBodyPrediction();
        bodyPredHiddenForPredictOff = true;
    }
    if (G.predict && !cosmicView && lockedBodyTarget !== BODY_NONE &&
        (bodyPredHiddenForPredictOff || frameNo % bodyPredEvery === 0)) {
        bodyPredHiddenForPredictOff = false;
        if (lockedBodyTarget !== BODY_NONE && isTargetDestroyed(lockedBodyTarget)) unlockBodyPrediction();
        if (lockedBodyTarget !== BODY_NONE) computeBodyPrediction(lockedBodyTarget, true);
    }
    if (cosmicView) {
        nearLabelsReady = false;
        hideLabel(lblE); hideLabel(lblM); hideLabel(lblS); hideLabel(lblO);
        for (let i = 0; i < PL.length; i++) hideLabel(plLabels[i]);
        for (let i = 0; i < MOONS.length; i++) hideLabel(moonLabels[i]);
        for (let i = 0; i < BH_MAX; i++) { setLabelDisplay(bhLabels[i], "none"); hideLabel(bhLabels[i]); }
        clearBodyPrediction();
        renderFrame(false);
        finishFramePerf(frameT0, dtR, rawDtR, dtRCap, cosmicView, cabinActive);
        return;
    }
    if (labelsSuppressed) {
        const nearLabelT0 = perfStart();
        if (nearLabelsReady) hideNearFieldLabels();
        perfEnd("labels.near", nearLabelT0, PERF.enabled ? {
            skipped: true,
            cabin: cabinActive,
            vr: VR.active,
            mobile: renderQuality.mobile,
        } : null);
        perfEnd("hud.labels", hudT0, PERF.enabled ? {
            hudDue,
            hudEvery,
            nearLabelsDue: false,
            labelEvery: 0,
            showStarLabels,
            starLabelsDue,
            starLabelBatch,
            cabin: cabinActive,
            vr: VR.active,
            bh: BH.n,
        } : null);
        renderFrame(cabinActive);
        finishFramePerf(frameT0, dtR, rawDtR, dtRCap, cosmicView, cabinActive);
        return;
    }
    const labelEvery = nearLabelCadence();
    const nearLabelsDue = !nearLabelsReady || frameNo % labelEvery === 0;
    const nearLabelT0 = perfStart();
    let planetLabelCount = 0, bhLabelCount = 0;
    if (nearLabelsDue) {
        if (WORLD.earthDestroyed) hideLabel(lblE); else put(lblE, earthG.position, -8, w, h);
        if (WORLD.moonDestroyed) hideLabel(lblM); else put(lblM, moon.position, -8, w, h);
        if (WORLD.sunDestroyed || camera.position.distanceTo(sunCore.position) < SUN_RADIUS * 18) hideLabel(lblS);
        else put(lblS, sunCore.position, -8, w, h);
        for (let i = 0; i < PL.length; i++) {
            if (WORLD.plDestroyed[i]) hideLabel(plLabels[i]);
            else { put(plLabels[i], plGroups[i].position, -8, w, h); planetLabelCount++; }
        }
        for (let i = 0; i < MOONS.length; i++) {
            const m = MOONS[i];
            const showMoon = !WORLD.plDestroyed[m.p] && moonGroups[i].visible &&
                (focusMoon === i || camera.position.distanceTo(moonGroups[i].position) < MOON_LABEL_DIST(i));
            if (showMoon) put(moonLabels[i], moonGroups[i].position, -7, w, h);
            else hideLabel(moonLabels[i]);
        }
        for (let i = 0; i < BH_MAX; i++) {
            const showBHLabel = i < BH.n;
            if (!showBHLabel) {
                setLabelDisplay(bhLabels[i], "none");
                hideLabel(bhLabels[i]);
            }
            else {
                setLabelDisplay(bhLabels[i], "block");
                const bhText = "BH " + (i + 1);
                if (bhLabels[i].textContent !== bhText) bhLabels[i].textContent = bhText;
                put(bhLabels[i], bhScenePos(i, _bhLabelPos), -10, w, h);
                bhLabelCount++;
            }
        }
        if (G.dead) hideLabel(lblO);
        else put(lblO, shipG.position, -22, w, h);
        nearLabelsReady = true;
    }
    perfEnd("labels.near", nearLabelT0, PERF.enabled ? { nearLabelsDue, labelEvery, mobile: renderQuality.mobile, planetLabelCount, bhLabelCount } : null);
    perfEnd("hud.labels", hudT0, PERF.enabled ? {
        hudDue,
        hudEvery,
        nearLabelsDue,
        labelEvery,
        showStarLabels,
        starLabelsDue,
        starLabelBatch,
        cabin: cabinActive,
        vr: VR.active,
        bh: BH.n,
    } : null);
    renderFrame(cabinActive);
    finishFramePerf(frameT0, dtR, rawDtR, dtRCap, cosmicView, cabinActive);
}
// setAnimationLoop lets WebXR sessions drive the frame callback when presenting.
const firstFrameT0 = perfStart();
frame();
perfEnd("startup.firstFrame", firstFrameT0);
const firstFrameFinishT0 = perfStart();
renderer.getContext?.().finish?.();
perfEnd("startup.firstFrameGpuFinish", firstFrameFinishT0);
clock.start();
window.__AP_READY = true;
requestEarthNightTexture(renderQuality.mobile ? 3600 : 2400);
if (!renderQuality.mobile && new URLSearchParams(location.search).get("cockpitwarm") === "1") scheduleCockpitWarmup(4200);
scheduleDeferredRealSkyLoad();
renderer.setAnimationLoop(frame);
