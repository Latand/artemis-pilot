import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { G } from "./state.js";
import { CAM_DIST_MAX, C_LIGHT, K } from "./constants.js";
import { eph } from "./ephemeris.js";
import { look, LOOK_YAW_MAX, LOOK_PITCH_MIN, LOOK_PITCH_MAX } from "./cockpit.js";
import { lensingPass } from "./lensing.js";
import { apOff } from "./autopilot.js";

export const cvHost = document.getElementById("gl");
export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.setClearColor(0x04060a, 1);
renderer.domElement.style.display = "block";
renderer.domElement.style.touchAction = "none";
cvHost.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(48, 1, .02, CAM_DIST_MAX * 1.35);

// ---- post-processing: bloom ----
export const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(lensingPass); // bend the world before bloom: warped disk light still glows
export const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), .38, .42, .9);
if (location.search.includes("bloom=0")) bloomPass.enabled = false;
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ---- orbit-style camera ----
export const cam = { yaw: -.95, pitch: .46, dist: 2.6, tgt: new THREE.Vector3() };
window.__cam = cam; // debug/testing handle
window.__gl = { renderer, scene, camera, composer, bloomPass }; // debug/testing handle
const tmpV = new THREE.Vector3();
export function applyCamera() {
    const cp = Math.cos(cam.pitch), spc = Math.sin(cam.pitch);
    camera.position.set(
        cam.tgt.x + cam.dist * cp * Math.cos(cam.yaw),
        cam.tgt.y + cam.dist * spc,
        cam.tgt.z + cam.dist * cp * Math.sin(cam.yaw));
    camera.lookAt(cam.tgt);
}
const ptrs = new Map();
let pinchD = 0;
export let lastPtr = null;
const el = renderer.domElement;
const grabPlane = new THREE.Plane();
const grabRay = new THREE.Raycaster();
const grabNdc = new THREE.Vector2();
const grabHit = new THREE.Vector3();
const grabShip = new THREE.Vector3();
const grabNormal = new THREE.Vector3();
const shipGrab = {
    active: false, id: -1,
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
    const p = grabShip.clone().project(camera);
    if (p.z >= 1) return false;
    const sx = rect.left + (p.x * .5 + .5) * rect.width;
    const sy = rect.top + (-p.y * .5 + .5) * rect.height;
    const hitPx = Math.hypot(e.clientX - sx, e.clientY - sy);
    const grabPx = Math.max(24, Math.min(58, 32 + Math.log10(Math.max(1, cam.dist)) * 4));
    return hitPx <= grabPx;
}
function clampShipGrabVelocity() {
    const vmax = C_LIGHT * .95;
    const v = Math.hypot(shipGrab.vx, shipGrab.vy, shipGrab.vz);
    if (v <= vmax || v <= 0) return;
    const f = vmax / v;
    shipGrab.vx *= f; shipGrab.vy *= f; shipGrab.vz *= f;
}
function startShipGrab(e) {
    if (G.cabin || G.dead || e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || !pointerNearShip(e)) return false;
    shipScenePoint(grabShip);
    grabNormal.copy(camera.position).sub(grabShip).normalize();
    grabPlane.setFromNormalAndCoplanarPoint(grabNormal, grabShip);
    const hit = pointerToPlane(e);
    if (!hit) return false;
    try { el.setPointerCapture(e.pointerId); } catch (err) { }
    shipGrab.active = true;
    shipGrab.id = e.pointerId;
    shipGrab.offset.copy(grabShip).sub(hit);
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
    e.preventDefault();
    return true;
}
function updateShipGrab(e) {
    if (!shipGrab.active || e.pointerId !== shipGrab.id) return false;
    const hit = pointerToPlane(e);
    if (!hit) return true;
    hit.add(shipGrab.offset);
    const nx = hit.x / K - eph.earthX;
    const ny = -hit.z / K - eph.earthY;
    const nz = hit.y / K;
    const now = performance.now() * .001;
    const dt = Math.max(1 / 240, now - shipGrab.lastT);
    shipGrab.vx = (nx - shipGrab.lastX) / dt;
    shipGrab.vy = (ny - shipGrab.lastY) / dt;
    shipGrab.vz = (nz - shipGrab.lastZ) / dt;
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
    if (!shipGrab.active || e.pointerId !== shipGrab.id) return false;
    clampShipGrabVelocity();
    G.vx = shipGrab.vx;
    G.vy = shipGrab.vy;
    G.vz = shipGrab.vz;
    const h = Math.hypot(G.vx, G.vy);
    if (Math.hypot(h, G.vz) > 1e-5) { G.heading = Math.atan2(G.vy, G.vx); G.pitch = Math.atan2(G.vz, h); }
    shipGrab.active = false;
    shipGrab.id = -1;
    e.preventDefault();
    return true;
}
function onDown(e) {
    try { el.setPointerCapture(e.pointerId); } catch (err) { }
    if (startShipGrab(e)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, btn: e.button });
    if (ptrs.size === 2) {
        const a = [...ptrs.values()];
        pinchD = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
    }
}
function onMove(e) {
    if (updateShipGrab(e)) return;
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId);
    const cur = { x: e.clientX, y: e.clientY, btn: prev.btn };
    ptrs.set(e.pointerId, cur);
    const dx = cur.x - prev.x, dy = cur.y - prev.y;
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
        const a = [...ptrs.values()];
        const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (pinchD > 0) cam.dist = Math.min(CAM_DIST_MAX, Math.max(.03, cam.dist * pinchD / d));
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
}
el.addEventListener("pointermove", e => { lastPtr = [e.clientX, e.clientY]; });
el.addEventListener("pointerdown", onDown);
el.addEventListener("contextmenu", e => e.preventDefault());
window.addEventListener("pointermove", onMove);
window.addEventListener("pointerup", onUp);
window.addEventListener("pointercancel", onUp);
el.addEventListener("wheel", onWheel, { passive: false });

function resize() {
    if (renderer.xr.isPresenting) return; // XR owns the framebuffer size
    const w = cvHost.clientWidth || 1, h = cvHost.clientHeight || 1;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    const pr = renderer.getPixelRatio();
    lensingPass.uniforms.uTexel.value.set(1 / Math.max(1, w * pr), 1 / Math.max(1, h * pr));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
resize();
new ResizeObserver(resize).observe(cvHost);

// ---- HTML label helpers ----
export const project = (v3, w, h) => {
    tmpV.copy(v3).project(camera);
    return tmpV.z < 1 ? [(tmpV.x * .5 + .5) * w, (-tmpV.y * .5 + .5) * h] : null;
};
export const put = (elRef, v3, dy, w, h) => {
    const p = project(v3, w, h);
    if (!p || p[0] < -40 || p[0] > w + 40 || p[1] < 0 || p[1] > h) { elRef.style.opacity = "0"; return; }
    elRef.style.opacity = "1";
    elRef.style.transform = "translate(" + (p[0] + 10) + "px," + (p[1] + dy) + "px)";
};
