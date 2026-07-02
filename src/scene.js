import * as THREE from "three";
import { G } from "./state.js";
import { CAM_DIST_MAX, K, LY_SCENE } from "./constants.js";
import { eph } from "./ephemeris.js";
import { look, LOOK_YAW_MAX, LOOK_PITCH_MIN, LOOK_PITCH_MAX } from "./cockpit.js";
import { apOff } from "./autopilot.js";
import {
    SHIP_GRAB_FOLLOW_GAIN, SHIP_GRAB_HOLD_MS, SHIP_GRAB_MAX_SPEED,
    SHIP_GRAB_PICK_MAX_PX, SHIP_GRAB_PICK_MIN_PX, SHIP_GRAB_THROW_SCALE, shipGrabPendingIntent,
} from "./shipGrabPolicy.js";

export const cvHost = document.getElementById("gl");
// A6 depth-precision decision (WP17): `reversedDepthBuffer` isn't a
// constructor option in the installed three@0.164.1 (checked against
// node_modules/three's WebGLRenderer source — no match), so that A6
// alternative to logarithmicDepthBuffer isn't available here; the
// multi-frustum tiering below (`renderSceneTiered`) is the whole fix.
// logarithmicDepthBuffer itself stays off per A6 (fill-rate cost).
export const renderer = new THREE.WebGLRenderer({ antialias: true });
const q = new URLSearchParams(location.search);
const dprOverride = Number(q.get("dpr") || q.get("pixelRatio"));
export const renderQuality = { mobile: false, dpr: 1, loadShed: 0, bloomScale: 1 };
export const viewportSize = { w: 1, h: 1, pxScale: 1 };
window.__renderQuality = renderQuality;
let pixelLoadShed = 0;
function isMobileLike() {
    return window.matchMedia?.("(max-width: 760px), (hover: none) and (pointer: coarse)")?.matches || false;
}
function choosePixelRatio() {
    const device = window.devicePixelRatio || 1;
    const mobile = isMobileLike();
    renderQuality.mobile = mobile;
    if (Number.isFinite(dprOverride) && dprOverride > 0) return Math.max(.5, Math.min(2.5, dprOverride));
    let cap = mobile ? 1.15 : 1.5;
    if (pixelLoadShed >= 2) cap = Math.min(cap, mobile ? .92 : 1.1);
    else if (pixelLoadShed >= 1) cap = Math.min(cap, mobile ? 1.0 : 1.25);
    return Math.min(device, cap);
}
function applyPixelRatio() {
    const next = choosePixelRatio();
    if (Math.abs(next - renderQuality.dpr) > .01) {
        renderQuality.dpr = next;
        renderer.setPixelRatio(next);
    }
    return renderQuality.dpr;
}
applyPixelRatio();
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.setClearColor(0x000000, 1);
renderer.domElement.style.display = "block";
renderer.domElement.style.touchAction = "none";
cvHost.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(48, 1, .02, CAM_DIST_MAX * 1.35);

// ---- multi-frustum scale tiers (WP17 / plan A6) ----
// The single camera spans a clearance-based near plane (main.js shrinks it
// to ~2e-6 units, ~2 m, when the ship sits right at a surface) out to
// `camera.far` (CAM_DIST_MAX*1.35, ~5.1e16 units, galactic/extragalactic
// scale) in one non-logarithmic depth buffer. That near:far ratio can
// exceed 1e18, which starves a standard depth buffer for anything past the
// first few units from the camera -- exactly why depth-tested-but-not-depth-
// written (`depthWrite:false, depthTest:true`) light-year-scale content (the
// tier-1 star field in athygStars.js, the HYG/procedural galaxy clouds in
// cosmic.js) sparkles/z-fights against itself and against near-field bodies
// once the ship leaves the immediate cockpit vicinity.
//
// Fix: split the frame into two passes, depth cleared between, drawn
// back-to-front, each with its own near/far so its own ratio stays small:
//   pass 1 (far):  [TIER_SPLIT_UNITS, camera.far]  -- galactic/interstellar field
//   pass 2 (near): [dynamic near, TIER_SPLIT_UNITS] -- solar system + ship
// A single split is enough here (not the full cockpit/system/interstellar/
// galactic 4-way tiering the plan sketches) because it already removes
// ~13-14 orders of magnitude from the worst-case ratio; escalate to a third
// pass only if the shoot-lod.mjs before/after comparison still shows
// fighting.
//
// Content is NOT manually bucketed per pass by category: three.js clips
// per-vertex against whatever near/far is active when a draw call is
// issued, regardless of which pass issued it, so an object simply produces
// no visible pixels in a pass whose range doesn't contain it -- correct
// occlusion falls out of "farther content drawn first, nearer content drawn
// on top of a freshly cleared depth buffer" for free. The one cost: a
// handful of always-near objects (ship/trail/river visuals) opt out of
// CPU-side frustum culling (`frustumCulled = false`, so they survive
// camera-relative repositioning tricks) and would otherwise still cost one
// wasted, GPU-clipped-to-nothing draw call in the far pass every frame;
// `registerNearTierOnly` hides those for that one pass instead. A few
// objects that are always near-field but aren't exported by their owning
// module this wave (river.js's particle `lines`, trails.js's `predLine`/
// `bodyPredLine`/`bodyPredDots`) aren't reachable from here without editing
// files owned by other WPs this wave; they keep costing one harmless (fully
// clipped, invisible) extra draw call in the far pass -- flagged as a small
// follow-up for whichever WP next touches those files.
export const farTierGroup = new THREE.Group();
farTierGroup.name = "scaleTier.far";
scene.add(farTierGroup);
export const TIER_SPLIT_UNITS = LY_SCENE * .02; // ~1265 AU: past Neptune/Oort-inner, short of Proxima (4.24 ly)

const nearTierOnly = [];
export function registerNearTierOnly(...objects) {
    for (const o of objects) if (o && !nearTierOnly.includes(o)) nearTierOnly.push(o);
}

const tierSavedVis = [];
export function renderSceneTiered(rendererArg, sceneArg, cameraArg) {
    const savedNear = cameraArg.near, savedFar = cameraArg.far;
    tierSavedVis.length = 0;
    for (let i = 0; i < nearTierOnly.length; i++) {
        tierSavedVis.push(nearTierOnly[i].visible);
        nearTierOnly[i].visible = false;
    }
    farTierGroup.visible = true;
    cameraArg.near = Math.min(savedFar, Math.max(savedNear, TIER_SPLIT_UNITS));
    cameraArg.far = savedFar;
    cameraArg.updateProjectionMatrix();
    rendererArg.render(sceneArg, cameraArg);
    for (let i = 0; i < nearTierOnly.length; i++) nearTierOnly[i].visible = tierSavedVis[i];
    farTierGroup.visible = false;
    // autoClear defaults to true, so an un-flagged second render() call would
    // clear pass 1's color buffer right back to black before drawing the
    // near tier on top of it -- same guard the existing cockpit-overlay pass
    // already uses (see renderFrame in main.js).
    const oldAutoClear = rendererArg.autoClear;
    rendererArg.autoClear = false;
    rendererArg.clearDepth();
    cameraArg.near = savedNear;
    cameraArg.far = Math.min(savedFar, TIER_SPLIT_UNITS);
    cameraArg.updateProjectionMatrix();
    rendererArg.render(sceneArg, cameraArg);
    rendererArg.autoClear = oldAutoClear;
    farTierGroup.visible = true;
    cameraArg.near = savedNear;
    cameraArg.far = savedFar;
    cameraArg.updateProjectionMatrix();
}

// ---- post-processing: bloom / lensing ----
const composerHdr = q.get("hdr") === "1" || q.get("composer") === "hdr";
const bloomParam = q.get("bloom");
const legacyBloom = bloomParam === "legacy" || q.get("fastbloom") === "0";
const bloomRequested = bloomParam !== "0" && (bloomParam === "1" || legacyBloom);
export let composer = null;
export let bloomPass = { enabled: false, isFastBloomPass: !legacyBloom, setSize() { } };
let composerPixelRatio = renderer.getPixelRatio();
let postProcessingReady = null;
let activeLensingPass = null;

function addLensingPass(pass) {
    if (!pass || activeLensingPass === pass) return;
    activeLensingPass = pass;
    if (!composer) return;
    const before = composer.passes.indexOf(bloomPass);
    composer.passes.splice(before >= 0 ? before : Math.max(1, composer.passes.length - 1), 0, pass);
}

export async function ensurePostProcessing(lensingPass = null) {
    if (composer) {
        addLensingPass(lensingPass);
        return composer;
    }
    if (postProcessingReady) {
        const ready = await postProcessingReady;
        addLensingPass(lensingPass);
        return ready;
    }
    postProcessingReady = (async () => {
        const [{ EffectComposer }, { RenderPass }, { OutputPass }] = await Promise.all([
            import("three/addons/postprocessing/EffectComposer.js"),
            import("three/addons/postprocessing/RenderPass.js"),
            import("three/addons/postprocessing/OutputPass.js"),
        ]);
        const composerTarget = new THREE.WebGLRenderTarget(1, 1, {
            type: composerHdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
            depthBuffer: true,
            stencilBuffer: false,
            samples: 0,
        });
        composerTarget.texture.name = composerHdr ? "Composer.hdr" : "Composer.ldr";
        composer = new EffectComposer(renderer, composerTarget);
        composerPixelRatio = renderer.getPixelRatio();
        // Same multi-frustum tiering as the non-composer path (renderSceneTiered
        // above), just swapped in for RenderPass's single renderer.render() call
        // so the bloom/lensing pipeline gets the same depth-precision fix.
        class TieredRenderPass extends RenderPass {
            render(rendererArg, writeBuffer, readBuffer) {
                const oldAutoClear = rendererArg.autoClear;
                rendererArg.autoClear = false;
                let oldClearAlpha, oldOverrideMaterial;
                if (this.overrideMaterial !== null) {
                    oldOverrideMaterial = this.scene.overrideMaterial;
                    this.scene.overrideMaterial = this.overrideMaterial;
                }
                if (this.clearColor !== null) {
                    rendererArg.getClearColor(this._oldClearColor);
                    rendererArg.setClearColor(this.clearColor);
                }
                if (this.clearAlpha !== null) {
                    oldClearAlpha = rendererArg.getClearAlpha();
                    rendererArg.setClearAlpha(this.clearAlpha);
                }
                if (this.clearDepth === true) rendererArg.clearDepth();
                rendererArg.setRenderTarget(this.renderToScreen ? null : readBuffer);
                if (this.clear === true) rendererArg.clear(rendererArg.autoClearColor, rendererArg.autoClearDepth, rendererArg.autoClearStencil);
                renderSceneTiered(rendererArg, this.scene, this.camera);
                if (this.clearColor !== null) rendererArg.setClearColor(this._oldClearColor);
                if (this.clearAlpha !== null) rendererArg.setClearAlpha(oldClearAlpha);
                if (this.overrideMaterial !== null) this.scene.overrideMaterial = oldOverrideMaterial;
                rendererArg.autoClear = oldAutoClear;
            }
        }
        composer.addPass(new TieredRenderPass(scene, camera));
        addLensingPass(lensingPass); // bend the world before bloom: warped disk light still glows
        if (legacyBloom) {
            const { UnrealBloomPass } = await import("three/addons/postprocessing/UnrealBloomPass.js");
            bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), .38, .42, .9);
        } else {
            const { FastBloomPass } = await import("./fastBloomPass.js");
            bloomPass = new FastBloomPass(new THREE.Vector2(1, 1), .58, 1.35, .74);
        }
        bloomPass.enabled = bloomRequested;
        composer.addPass(bloomPass);
        composer.addPass(new OutputPass());
        resizePostProcessing();
        return composer;
    })();
    return postProcessingReady;
}

// ---- orbit-style camera ----
export const cam = { yaw: -.95, pitch: .46, dist: 2.6, tgt: new THREE.Vector3(), distTarget: null };
window.__cam = cam; // debug/testing handle
window.__gl = {
    renderer, scene, camera,
    get composer() { return composer; },
    get bloomPass() { return bloomPass; },
    fastBloom: !legacyBloom, composerHdr, bloomRequested,
}; // debug/testing handle
if (bloomRequested) await ensurePostProcessing();
const tmpV = new THREE.Vector3();
let camRoll = 0;
export function setCamRoll(r) {
    camRoll = Number.isFinite(r) ? r : 0;
}
export function applyCameraRoll() {
    if (camRoll) camera.rotateZ(camRoll);
}
export function applyCamera() {
    const cp = Math.cos(cam.pitch), spc = Math.sin(cam.pitch);
    camera.position.set(
        cam.tgt.x + cam.dist * cp * Math.cos(cam.yaw),
        cam.tgt.y + cam.dist * spc,
        cam.tgt.z + cam.dist * cp * Math.sin(cam.yaw));
    camera.lookAt(cam.tgt);
    applyCameraRoll();
}
const ptrs = new Map();
let pinchD = 0;
export let lastPtr = null;
const lastPtrPos = [0, 0];
const el = renderer.domElement;
const grabPlane = new THREE.Plane();
const grabRay = new THREE.Raycaster();
const grabNdc = new THREE.Vector2();
const grabHit = new THREE.Vector3();
const grabShip = new THREE.Vector3();
const grabScreen = [0, 0];
const grabNormal = new THREE.Vector3();
const shipGrab = {
    active: false, pending: false, armed: false, id: -1, btn: 0,
    startX: 0, startY: 0, startT: 0,
    timer: 0,
    offset: new THREE.Vector3(),
    lastX: 0, lastY: 0, lastZ: 0, lastT: 0,
    vx: 0, vy: 0, vz: 0,
};
// pan moves the orbit target in the view plane and detaches the camera from
// its focus body ("free" mode); F / 0 / clicking a label re-attaches it
function panBy(dx, dy) {
    const k = cam.dist * .0011;
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    // right = (sy, 0, -cy), camera-up = (-sp·cy, cp, -sp·sy)
    cam.tgt.x += (-sy * dx - sp * cy * dy) * k;
    cam.tgt.y += cp * dy * k;
    cam.tgt.z += (cy * dx - sp * sy * dy) * k;
    G.focus = "free";
}
function shipScenePoint(out = grabShip) {
    return out.set((eph.earthX + G.x) * K, G.z * K, -(eph.earthY + G.y) * K);
}
function pointerToPlane(e, out = grabHit) {
    const rect = el.getBoundingClientRect();
    grabNdc.set(((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1, -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1);
    grabRay.setFromCamera(grabNdc, camera);
    return grabRay.ray.intersectPlane(grabPlane, out);
}
function pointerNearShip(e) {
    shipScenePoint(grabShip);
    const rect = el.getBoundingClientRect();
    const p = projectTo(grabShip, rect.width, rect.height, grabScreen);
    if (!p) return false;
    const sx = rect.left + p[0];
    const sy = rect.top + p[1];
    const hitPx = Math.hypot(e.clientX - sx, e.clientY - sy);
    const grabPx = Math.max(SHIP_GRAB_PICK_MIN_PX, Math.min(SHIP_GRAB_PICK_MAX_PX, 18 + Math.log10(Math.max(1, cam.dist)) * 2.2));
    return hitPx <= grabPx;
}
function clampShipGrabVelocity() {
    const vmax = SHIP_GRAB_MAX_SPEED;
    const v = Math.hypot(shipGrab.vx, shipGrab.vy, shipGrab.vz);
    if (v <= vmax || v <= 0) return;
    const f = vmax / v;
    shipGrab.vx *= f; shipGrab.vy *= f; shipGrab.vz *= f;
}
function resetShipGrab() {
    if (shipGrab.timer) {
        clearTimeout(shipGrab.timer);
        shipGrab.timer = 0;
    }
    shipGrab.active = false;
    shipGrab.pending = false;
    shipGrab.armed = false;
    shipGrab.id = -1;
}
function startShipGrab(e) {
    if (G.cabin || G.dead || e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || !pointerNearShip(e)) return false;
    shipScenePoint(grabShip);
    grabNormal.copy(camera.position).sub(grabShip).normalize();
    grabPlane.setFromNormalAndCoplanarPoint(grabNormal, grabShip);
    const hit = pointerToPlane(e);
    if (!hit) return false;
    try { el.setPointerCapture(e.pointerId); } catch (err) { }
    shipGrab.pending = true;
    shipGrab.active = false;
    shipGrab.armed = false;
    shipGrab.id = e.pointerId;
    shipGrab.btn = e.button;
    shipGrab.startX = e.clientX;
    shipGrab.startY = e.clientY;
    shipGrab.startT = performance.now();
    shipGrab.offset.copy(grabShip).sub(hit);
    shipGrab.lastX = G.x;
    shipGrab.lastY = G.y;
    shipGrab.lastZ = G.z;
    shipGrab.lastT = performance.now() * .001;
    shipGrab.vx = G.vx;
    shipGrab.vy = G.vy;
    shipGrab.vz = G.vz;
    shipGrab.timer = window.setTimeout(() => {
        if (shipGrab.pending && shipGrab.id === e.pointerId) {
            shipGrab.armed = true;
            shipGrab.timer = 0;
        }
    }, SHIP_GRAB_HOLD_MS);
    e.preventDefault();
    return true;
}
function activateShipGrab(e = null) {
    if (shipGrab.timer) {
        clearTimeout(shipGrab.timer);
        shipGrab.timer = 0;
    }
    shipGrab.pending = false;
    shipGrab.active = true;
    shipGrab.lastX = G.x;
    shipGrab.lastY = G.y;
    shipGrab.lastZ = G.z;
    shipGrab.lastT = performance.now() * .001;
    shipGrab.vx = G.vx;
    shipGrab.vy = G.vy;
    shipGrab.vz = G.vz;
    G.landed = null;
    G.hold = null;
    G.focus = "ship";
    apOff("mouse grab");
    e?.preventDefault?.();
    return true;
}
function cancelPendingShipGrabToCamera(e) {
    const start = { x: shipGrab.startX, y: shipGrab.startY, btn: shipGrab.btn };
    resetShipGrab();
    ptrs.set(e.pointerId, start);
}
function updateShipGrab(e) {
    if ((!shipGrab.active && !shipGrab.pending) || e.pointerId !== shipGrab.id) return false;
    if (shipGrab.pending) {
        const movedPx = Math.hypot(e.clientX - shipGrab.startX, e.clientY - shipGrab.startY);
        const heldMs = shipGrab.armed ? SHIP_GRAB_HOLD_MS : performance.now() - shipGrab.startT;
        const intent = shipGrabPendingIntent(movedPx, heldMs);
        if (intent === "camera") {
            cancelPendingShipGrabToCamera(e);
            return false;
        }
        if (intent === "pending") {
            e.preventDefault();
            return true;
        }
        activateShipGrab(e);
    }
    const hit = pointerToPlane(e);
    if (!hit) return true;
    hit.add(shipGrab.offset);
    const tx = hit.x / K - eph.earthX;
    const ty = -hit.z / K - eph.earthY;
    const tz = hit.y / K;
    const now = performance.now() * .001;
    const dt = Math.max(1 / 240, now - shipGrab.lastT);
    let dx = (tx - shipGrab.lastX) * SHIP_GRAB_FOLLOW_GAIN;
    let dy = (ty - shipGrab.lastY) * SHIP_GRAB_FOLLOW_GAIN;
    let dz = (tz - shipGrab.lastZ) * SHIP_GRAB_FOLLOW_GAIN;
    const step = Math.hypot(dx, dy, dz);
    const maxStep = SHIP_GRAB_MAX_SPEED * dt;
    if (step > maxStep && step > 0) {
        const f = maxStep / step;
        dx *= f; dy *= f; dz *= f;
    }
    const nx = shipGrab.lastX + dx;
    const ny = shipGrab.lastY + dy;
    const nz = shipGrab.lastZ + dz;
    shipGrab.vx = (dx / dt) * SHIP_GRAB_THROW_SCALE;
    shipGrab.vy = (dy / dt) * SHIP_GRAB_THROW_SCALE;
    shipGrab.vz = (dz / dt) * SHIP_GRAB_THROW_SCALE;
    clampShipGrabVelocity();
    G.x = nx; G.y = ny; G.z = nz;
    G.vx = shipGrab.vx; G.vy = shipGrab.vy; G.vz = shipGrab.vz;
    const h = Math.hypot(G.vx, G.vy);
    if (Math.hypot(h, G.vz) > 1e-5) { G.heading = Math.atan2(G.vy, G.vx); G.pitch = Math.atan2(G.vz, h); }
    shipGrab.lastX = nx;
    shipGrab.lastY = ny;
    shipGrab.lastZ = nz;
    shipGrab.lastT = now;
    e.preventDefault();
    return true;
}
function finishShipGrab(e) {
    if (shipGrab.pending && e.pointerId === shipGrab.id) {
        resetShipGrab();
        e.preventDefault();
        return true;
    }
    if (!shipGrab.active || e.pointerId !== shipGrab.id) return false;
    clampShipGrabVelocity();
    G.vx = shipGrab.vx;
    G.vy = shipGrab.vy;
    G.vz = shipGrab.vz;
    const h = Math.hypot(G.vx, G.vy);
    if (Math.hypot(h, G.vz) > 1e-5) { G.heading = Math.atan2(G.vy, G.vx); G.pitch = Math.atan2(G.vz, h); }
    resetShipGrab();
    e.preventDefault();
    return true;
}
function onDown(e) {
    try { el.setPointerCapture(e.pointerId); } catch (err) { }
    if (startShipGrab(e)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, btn: e.button });
    if (ptrs.size === 2) {
        const it = ptrs.values();
        const a = it.next().value, b = it.next().value;
        pinchD = Math.hypot(a.x - b.x, a.y - b.y);
    }
}
function onMove(e) {
    if (updateShipGrab(e)) return;
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId);
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;
    if (ptrs.size === 1) {
        if (G.cabin) {
            // head-look inside the cockpit; the world camera follows in main.js
            look.yaw = Math.min(LOOK_YAW_MAX, Math.max(-LOOK_YAW_MAX, look.yaw + dx * .0042));
            look.pitch = Math.min(LOOK_PITCH_MAX, Math.max(LOOK_PITCH_MIN, look.pitch - dy * .0042));
        } else if (prev.btn === 1 || prev.btn === 2) panBy(dx, dy);
        else {
            cam.yaw += dx * .0052;
            cam.pitch = Math.min(1.45, Math.max(-1.45, cam.pitch + dy * .0052));
        }
    } else if (ptrs.size === 2) {
        const it = ptrs.values();
        const a = it.next().value, b = it.next().value;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchD > 0) { cam.dist = Math.min(CAM_DIST_MAX, Math.max(.03, cam.dist * pinchD / d)); cam.distTarget = null; }
        pinchD = d;
        panBy(dx * .5, dy * .5); // two-finger drag pans too
    }
}
function onUp(e) {
    if (finishShipGrab(e)) { ptrs.delete(e.pointerId); pinchD = 0; return; }
    ptrs.delete(e.pointerId); pinchD = 0;
}
function onWheel(e) {
    e.preventDefault();
    if (G.cabin) return; // zoom is meaningless inside the cabin and would silently trip cosmic scale
    cam.dist = Math.min(CAM_DIST_MAX, Math.max(.03, cam.dist * Math.exp(e.deltaY * .0011)));
    cam.distTarget = null; // manual zoom cancels any in-progress fly-in
}
el.addEventListener("pointermove", e => {
    lastPtrPos[0] = e.clientX;
    lastPtrPos[1] = e.clientY;
    lastPtr = lastPtrPos;
});
el.addEventListener("pointerdown", onDown);
el.addEventListener("contextmenu", e => e.preventDefault());
window.addEventListener("pointermove", onMove);
window.addEventListener("pointerup", onUp);
window.addEventListener("pointercancel", onUp);
el.addEventListener("wheel", onWheel, { passive: false });

function resize() {
    if (renderer.xr.isPresenting) return; // XR owns the framebuffer size
    const pr = applyPixelRatio();
    const w = cvHost.clientWidth || 1, h = cvHost.clientHeight || 1;
    viewportSize.w = w;
    viewportSize.h = h;
    viewportSize.pxScale = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * .5));
    renderer.setSize(w, h);
    resizePostProcessing(w, h, pr);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
function resizePostProcessing(w = viewportSize.w, h = viewportSize.h, pr = renderer.getPixelRatio()) {
    if (composer) {
        if (Math.abs(pr - composerPixelRatio) > .01) {
            composerPixelRatio = pr;
            composer.setPixelRatio(pr);
        }
        composer.setSize(w, h);
    }
    const bloomScale = renderQuality.mobile ? 0.5 : 0.52;
    renderQuality.bloomScale = bloomScale;
    bloomPass?.setSize?.(Math.max(1, Math.round(w * bloomScale)), Math.max(1, Math.round(h * bloomScale)));
    activeLensingPass?.uniforms?.uTexel?.value?.set(1 / Math.max(1, w * pr), 1 / Math.max(1, h * pr));
}
resize();
new ResizeObserver(resize).observe(cvHost);

export function setRenderLoadShed(level = 0) {
    const next = Math.max(0, Math.min(2, level | 0));
    if (next === pixelLoadShed) return;
    pixelLoadShed = next;
    renderQuality.loadShed = next;
    resize();
}

// ---- HTML label helpers ----
const labelState = new WeakMap();
function setLabelState(elRef, opacity, transform = "") {
    let s = labelState.get(elRef);
    if (!s) {
        s = { opacity: "", transform: "" };
        labelState.set(elRef, s);
    }
    if (s.opacity !== opacity) {
        elRef.style.opacity = opacity;
        s.opacity = opacity;
    }
    if (s.transform !== transform) {
        elRef.style.transform = transform;
        s.transform = transform;
    }
}
export function hideLabel(elRef) {
    if (elRef) setLabelState(elRef, "0");
}
export function setLabelDisplay(elRef, value) {
    if (elRef && elRef.style.display !== value) elRef.style.display = value;
}
const labelProject = [0, 0];
export function projectTo(v3, w, h, out) {
    tmpV.copy(v3).project(camera);
    if (tmpV.z >= 1) return null;
    out[0] = (tmpV.x * .5 + .5) * w;
    out[1] = (-tmpV.y * .5 + .5) * h;
    return out;
}
export const project = (v3, w, h) => {
    return projectTo(v3, w, h, [0, 0]);
};
export const put = (elRef, v3, dy, w, h, opacity = "1") => {
    const p = projectTo(v3, w, h, labelProject);
    if (!p || p[0] < -40 || p[0] > w + 40 || p[1] < 0 || p[1] > h) { hideLabel(elRef); return; }
    const x = Math.round(p[0] + 10), y = Math.round(p[1] + dy);
    setLabelState(elRef, opacity, "translate(" + x + "px," + y + "px)");
};
