import * as THREE from "three";
import {
    K, CAM_DIST_MAX, WARP_MAX, BH_SIZES, PL, STARS,
    R_EARTH, R_MOON, SUN_RADIUS, warpLabel,
} from "./constants.js";
import { G, BH, WORLD } from "./state.js";
import { renderer, scene, camera, cam } from "./scene.js";
import { cockpitScene } from "./cockpit.js";
import { setFocus } from "./input.js";
import { toast } from "./achievements.js";
import { initAudio } from "./audio.js";
import { addBlackHole } from "./blackholes.js";
import { eph } from "./ephemeris.js";
import { earthG, moon, sunCore, plGroups, sky, galaxyBackdrop } from "./bodies.js";
import { shipG } from "./ship.js";
import { fmtMET, fmtDist } from "./format.js";
import { AP, apTravelToFocus, apOff } from "./autopilot.js";

// WebXR (PSVR2 / any xr-standard headset) support. Two modes:
//
//   ship — seated in the 3D cockpit. The cockpit scene renders at 1:1 human
//   scale around the head; the world scene renders through a rig parked at
//   the ship's scene position, rotated to the ship heading, and uniformly
//   scaled DOWN so one metre of head motion is only a few kilometres of
//   world — stereo parallax on planets goes to zero and they read as huge.
//   The cockpit is the rest frame: it never moves, the world does (comfort
//   pattern — the sim itself stays in float64 km; three.js composes the
//   model-view in float64, so no GPU-precision rebase is needed).
//
//   god — a free observer. The world rig becomes a grabbable model: one grip
//   drags space, both grips zoom/twist it, sticks fly, the left trigger
//   drops black holes on the ecliptic, and a wrist panel shows sim state.
//
// Input follows the xr-standard gamepad mapping: axes 2/3 = thumbstick,
// buttons 0/1 = trigger/grip, 3 = stick click, 4/5 = A/B (right) X/Y (left).

const SHIP_WORLD_SCALE = 0.004;       // ship view: 1 m of head motion = 4 km
const GOD_SCALE_MIN = 0.002, GOD_SCALE_MAX = 1e15;
const FLY_SPEED = 3.4;                // god-mode stick flight, apparent m/s
const SNAP_ANGLE = Math.PI / 6;       // 30° snap turns

export const VR = {
    active: false,
    mode: "ship",                     // 'ship' | 'god'
    god: { pos: new THREE.Vector3(), yaw: 0, scale: 250 },
    input: { rot: 0, main: 0, lat: 0, boost: false },
};

// ---- rigs: world-scene rig (scaled) and cockpit-scene rig (1:1) ----
// Hierarchy per scene: rig (game-driven) → offset (recenter) → camera.
// WebXR poses compose with camera.parent.matrixWorld, so a uniform rig
// scale S makes the world appear 1/S-sized while head motion spans S.
const worldRig = new THREE.Group();
const worldOffset = new THREE.Group();
const vrWorldCam = new THREE.PerspectiveCamera(50, 1, .07, CAM_DIST_MAX * 1.35);
worldRig.add(worldOffset);
worldOffset.add(vrWorldCam);
scene.add(worldRig);

const cockpitRig = new THREE.Group();
const cockpitOffset = new THREE.Group();
// near/far must match the world camera: both passes share one XR session
// depth state (updateRenderState applies per frame, not per render call)
const vrCockpitCam = new THREE.PerspectiveCamera(50, 1, .07, CAM_DIST_MAX * 1.35);
cockpitRig.add(cockpitOffset);
cockpitOffset.add(vrCockpitCam);
cockpitScene.add(cockpitRig);

const _Y = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _qYaw = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

// ---- controllers ----
const ctrls = [];
let panel = null, panelCtx = null, panelTex = null;
let rayL = null;
const reticle = new THREE.Mesh(
    new THREE.RingGeometry(.62, 1, 32),
    new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: .9, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
reticle.rotation.x = -Math.PI / 2;
reticle.renderOrder = 8;
reticle.visible = false;
scene.add(reticle);

function buildHandViz(hand) {
    const g = new THREE.Group();
    const col = hand === "left" ? 0x6fd8e8 : 0xffb46a;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(.012, .015, .1, 12),
        new THREE.MeshBasicMaterial({ color: 0x222b36 }));
    body.rotation.x = Math.PI / 2;
    body.position.z = .03;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.024, .005, 8, 20),
        new THREE.MeshBasicMaterial({ color: col }));
    ring.position.z = -.005;
    const nub = new THREE.Mesh(new THREE.SphereGeometry(.007, 8, 6),
        new THREE.MeshBasicMaterial({ color: col }));
    nub.position.z = -.05;
    g.add(body, ring, nub);
    return g;
}

function buildPanel() {
    const cv = document.createElement("canvas");
    cv.width = 520; cv.height = 210;
    panelCtx = cv.getContext("2d");
    panelTex = new THREE.CanvasTexture(cv);
    panel = new THREE.Mesh(
        new THREE.PlaneGeometry(.26, .105),
        new THREE.MeshBasicMaterial({ map: panelTex, transparent: true, depthTest: false }));
    panel.position.set(0, .05, -.1);
    panel.rotation.x = -.65;
    panel.renderOrder = 9;
    panel.visible = false;
}

let panelMsg = "", panelMsgRt = 0;
function say(msg) { toast(msg); panelMsg = msg; panelMsgRt = performance.now(); }

function focusName() {
    const f = G.focus;
    if (typeof f === "number") return PL[f] ? PL[f].name : "";
    if (typeof f === "string") {
        if (f.startsWith("bh:")) return "BH " + (+f.slice(3) + 1);
        if (f.startsWith("star:")) return STARS[+f.slice(5)]?.name ?? "";
        return f.toUpperCase();
    }
    return "";
}

function drawPanel() {
    const c = panelCtx;
    if (!c) return;
    c.clearRect(0, 0, 520, 210);
    c.fillStyle = "rgba(8,12,18,.86)";
    c.strokeStyle = "#2a4a5e";
    c.lineWidth = 3;
    c.beginPath();
    c.roundRect(2, 2, 516, 206, 14);
    c.fill(); c.stroke();
    c.font = "600 26px ui-monospace, Menlo, monospace";
    c.fillStyle = "#9fe8ff";
    c.fillText("GOD MODE · T+ " + fmtMET(G.t), 20, 38);
    c.font = "24px ui-monospace, Menlo, monospace";
    c.fillStyle = "#cfe8f8";
    c.fillText("WARP " + warpLabel(G.warp) + (G.paused ? " ❚❚" : "") + " · VEL " + Math.hypot(G.vx, G.vy).toFixed(2) + " km/s", 20, 74);
    c.fillText("FOCUS " + focusName() + " · 1 m = " + fmtDist(VR.god.scale / K), 20, 108);
    c.fillStyle = "#5d7587";
    c.font = "20px ui-monospace, Menlo, monospace";
    c.fillText("Y NEXT BODY · A/B WARP · TRIGGER = BLACK HOLE", 20, 144);
    if (performance.now() - panelMsgRt < 6000 && panelMsg) {
        c.fillStyle = "#9fe8b8";
        c.fillText(panelMsg.slice(0, 42), 20, 184);
    }
    panelTex.needsUpdate = true;
}

const seenSrc = new WeakSet();
function detectProfile(src) {
    if (seenSrc.has(src)) return;
    seenSrc.add(src);
    if (/sony|psvr/i.test((src.profiles || []).join(" "))) say("PSVR2 SENSE CONTROLLERS DETECTED");
}

function attachControllers(parent) {
    for (const c of ctrls) parent.add(c);
}
function ctrlByHand(hand) {
    for (const c of ctrls) if (c.userData.hand === hand) return c;
    return null;
}

// ---- input helpers (xr-standard polling) ----
const dz = (v, t = .15) => Math.abs(v) < t ? 0 : (v - Math.sign(v) * t) / (1 - t);
const prevB = new Map();
function justPressed(key, btn) {
    const now = btn?.pressed ?? false;
    const was = prevB.get(key) ?? false;
    prevB.set(key, now);
    return now && !was;
}
const heldT = new Map();
// fires on press, then autorepeats ~3.5 Hz after a 0.45 s delay
function repeatFire(key, pressed, dt) {
    if (!pressed) { heldT.delete(key); return false; }
    if (!heldT.has(key)) { heldT.set(key, 0); return true; }
    let t = heldT.get(key) + dt;
    if (t > .45) { heldT.set(key, .17); return true; }
    heldT.set(key, t);
    return false;
}

function pulseHand(hand, val, ms) {
    if (val <= .01) return;
    const session = renderer.xr.getSession();
    if (!session) return;
    for (const src of session.inputSources) {
        if (src.handedness !== hand) continue;
        const a = src.gamepad?.hapticActuators?.[0];
        if (a?.pulse) try { a.pulse(Math.min(1, val), ms); } catch (e) { }
    }
}

// thrust rumble in the right hand, aero buffeting in both — replaces the
// desktop camera shake, which would be nauseating in stereo
export function vrHaptics(aMag, shake) {
    if (!VR.active || VR.mode !== "ship") return;
    const thrust = aMag > 0 ? Math.min(1, .25 + aMag * 90) : 0;
    const sh = Math.min(1, shake);
    pulseHand("right", Math.max(thrust, sh), 40);
    if (sh > .05) pulseHand("left", sh, 40);
}

// ---- god-mode spatial math ----
// world map: scene = god.pos + god.scale · Ry(god.yaw) · rigPoint
function godMap(rigV, out) {
    _qYaw.setFromAxisAngle(_Y, VR.god.yaw);
    return out.copy(rigV).multiplyScalar(VR.god.scale).applyQuaternion(_qYaw).add(VR.god.pos);
}
function handRigPos(hand, out) {
    const c = ctrlByHand(hand);
    if (!c) return null;
    return out.copy(c.position).applyMatrix4(worldOffset.matrix);
}
function headRigPos(out) {
    return out.copy(renderer.xr.getCamera().position).applyMatrix4(worldOffset.matrix);
}

function snapTurn(d) {
    const headRig = headRigPos(_v1);
    const headScene = godMap(headRig, _v2);
    VR.god.yaw += d;
    _qYaw.setFromAxisAngle(_Y, VR.god.yaw);
    VR.god.pos.copy(headScene).sub(_v3.copy(headRig).multiplyScalar(VR.god.scale).applyQuaternion(_qYaw));
}

// grab state: anchors are scene points pinned under the hands at grip start
let grabKey = "";
const grabA = { left: new THREE.Vector3(), right: new THREE.Vector3() };
function pollGrab(lg, rg) {
    const hl = lg ? handRigPos("left", _v4) : null;
    const hr = rg ? handRigPos("right", _v5) : null;
    const key = (hl ? "L" : "") + (hr ? "R" : "");
    if (key !== grabKey) {
        grabKey = key;
        if (hl) godMap(hl, grabA.left);
        if (hr) godMap(hr, grabA.right);
        return key !== "";
    }
    if (!key) return false;
    const g = VR.god;
    if (hl && hr) {
        // two hands: solve scale + yaw + position so both anchors stay pinned
        const hd = _v1.copy(hr).sub(hl);
        const ad = _v2.copy(grabA.right).sub(grabA.left);
        const hLen = hd.length();
        if (hLen > 1e-4) {
            const s = Math.min(GOD_SCALE_MAX, Math.max(GOD_SCALE_MIN, ad.length() / hLen));
            if (Math.hypot(hd.x, hd.z) > .05 && Math.hypot(ad.x, ad.z) > 1e-9) {
                g.yaw = Math.atan2(-ad.z, ad.x) - Math.atan2(-hd.z, hd.x);
            }
            g.scale = s;
            _qYaw.setFromAxisAngle(_Y, g.yaw);
            g.pos.copy(grabA.left).sub(_v3.copy(hl).multiplyScalar(s).applyQuaternion(_qYaw));
        }
    } else {
        const h = hl || hr, a = hl ? grabA.left : grabA.right;
        _qYaw.setFromAxisAngle(_Y, g.yaw);
        g.pos.copy(a).sub(_v3.copy(h).multiplyScalar(g.scale).applyQuaternion(_qYaw));
    }
    return true;
}

// ---- god tour: Y cycles ship, bodies, stars, framing each at arm scale ----
let tourIdx = 0;
function tourList() {
    const l = [{ name: "SHIP", focus: "ship", pos: shipG.position, S: .0025 }];
    if (!WORLD.earthDestroyed) l.push({ name: "EARTH", focus: "earth", pos: earthG.position, R: R_EARTH * K });
    if (!WORLD.moonDestroyed) l.push({ name: "MOON", focus: "moon", pos: moon.position, R: R_MOON * K });
    if (!WORLD.sunDestroyed) l.push({ name: "SUN", focus: "sun", pos: sunCore.position, R: SUN_RADIUS });
    for (let i = 0; i < PL.length; i++) if (!WORLD.plDestroyed[i])
        l.push({ name: PL[i].name, focus: i, pos: plGroups[i].position, R: PL[i].R * K });
    for (let i = 0; i < STARS.length; i++)
        l.push({ name: STARS[i].name, focus: "star:" + i, pos: new THREE.Vector3(STARS[i].x * K, 0, -STARS[i].y * K), R: STARS[i].R * K });
    return l;
}
function godAnchor(e) {
    const g = VR.god;
    g.scale = Math.min(GOD_SCALE_MAX, Math.max(GOD_SCALE_MIN, e.S ?? e.R / .45));
    g.yaw = 0;
    // body lands 2.6 m ahead and 1.1 m below the eye — a tabletop world
    g.pos.copy(e.pos).add(_v1.set(0, 1.1 * g.scale, 2.6 * g.scale));
}
function tourNext() {
    const l = tourList();
    tourIdx = (tourIdx + 1) % l.length;
    const e = l[tourIdx];
    godAnchor(e);
    setFocus(e.focus);
    say("VIEWING " + e.name);
}
function godAnchorToFocus() {
    const l = tourList();
    let i = l.findIndex(e => e.focus === G.focus);
    if (i < 0) i = 0;
    tourIdx = i;
    godAnchor(l[i]);
}

export function setVRMode(mode) {
    VR.mode = mode;
    grabKey = "";
    if (mode === "ship") {
        G.cabin = true;
        setFocus("ship");
        attachControllers(cockpitOffset);
        reticle.visible = false;
        if (rayL) rayL.visible = false;
        if (panel) panel.visible = false;
        say("IN-SHIP · R-STICK THRUST · L-STICK YAW · L-STICK CLICK = GOD MODE");
    } else {
        G.cabin = false;
        godAnchorToFocus();
        attachControllers(worldOffset);
        if (panel) panel.visible = true;
        say("GOD MODE · GRIP DRAGS SPACE · BOTH GRIPS ZOOM · L-STICK CLICK = SHIP");
    }
}

// ---- recenter: cancel head yaw + position so the pose maps to rig origin ----
export function recenter() {
    const xrCam = renderer.xr.getCamera();
    _v1.set(0, 0, -1).applyQuaternion(xrCam.quaternion);
    const fl = Math.hypot(_v1.x, _v1.z);
    const oy = fl > 1e-4 ? -Math.atan2(-_v1.x, -_v1.z) : 0;
    for (const off of [worldOffset, cockpitOffset]) {
        off.rotation.set(0, oy, 0);
        off.position.copy(xrCam.position).applyAxisAngle(_Y, oy).multiplyScalar(-1);
        off.updateMatrix();
    }
}

// ---- per-frame input polling ----
let snapArmed = true, wantPlaceBH = false, aiming = false, restartHeld = 0;
let lGripWas = false, rGripWas = false;
let H = { restart: () => { } };

function pollShip(L, R, dtR) {
    const inp = VR.input;
    if (L) {
        const sx = dz(L.axes[2] ?? 0), sy = dz(L.axes[3] ?? 0);
        inp.rot = -sx;                                   // stick left = yaw left (KeyA)
        if (sy) G.throttle = Math.min(100, Math.max(.05, G.throttle * Math.exp(-sy * dtR * 1.1)));
        const grip = L.buttons[1]?.pressed ?? false;
        if (grip && !lGripWas) G.hold = "retro";
        if (!grip && lGripWas && G.hold === "retro") G.hold = null;
        lGripWas = grip;
        if (justPressed("lTrig", L.buttons[0])) {
            if (AP.mode !== "off") apOff("cancelled", toast);
            else apTravelToFocus(toast);
        }
    }
    if (R) {
        const sx = dz(R.axes[2] ?? 0), sy = dz(R.axes[3] ?? 0);
        inp.main = -sy;                                  // push forward = thrust
        inp.lat = -sx;                                   // stick right = strafe right
        inp.boost = (R.buttons[0]?.value ?? 0) > .35;
        const grip = R.buttons[1]?.pressed ?? false;
        if (grip && !rGripWas) G.hold = "pro";
        if (!grip && rGripWas && G.hold === "pro") G.hold = null;
        rGripWas = grip;
    }
}

function pollGod(L, R, dtR) {
    const g = VR.god;
    const grabbing = pollGrab(L?.buttons[1]?.pressed ?? false, R?.buttons[1]?.pressed ?? false);
    const rTrig = R ? (R.buttons[0]?.value ?? 0) : 0;
    const spd = FLY_SPEED * (1 + 8 * rTrig);
    if (R && !grabbing) {
        const sx = dz(R.axes[2] ?? 0), sy = dz(R.axes[3] ?? 0);
        if (sx || sy) {
            // head-relative flight on the rig's horizontal plane
            _q1.copy(worldOffset.quaternion).multiply(renderer.xr.getCamera().quaternion);
            _v1.set(0, 0, -1).applyQuaternion(_q1);
            _v1.y = 0;
            if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, -1);
            _v1.normalize();
            _v2.set(-_v1.z, 0, _v1.x);                   // right of forward
            _v3.copy(_v1).multiplyScalar(-sy * spd).addScaledVector(_v2, sx * spd);
            _qYaw.setFromAxisAngle(_Y, g.yaw);
            g.pos.addScaledVector(_v3.applyQuaternion(_qYaw), g.scale * dtR);
        }
    }
    if (L) {
        const sx = dz(L.axes[2] ?? 0), sy = dz(L.axes[3] ?? 0);
        if (sy && !grabbing) g.pos.y += -sy * spd * g.scale * dtR;
        if (snapArmed && Math.abs(sx) > .72) { snapTurn(Math.sign(sx) * SNAP_ANGLE); snapArmed = false; }
        else if (Math.abs(sx) < .3) snapArmed = true;
        aiming = (L.buttons[0]?.value ?? 0) > .08;
        if (justPressed("lTrigGod", L.buttons[0])) wantPlaceBH = true;
    } else aiming = false;
}

export function vrPoll(dtR) {
    const inp = VR.input;
    inp.rot = 0; inp.main = 0; inp.lat = 0; inp.boost = false;
    if (!VR.active) return inp;
    const session = renderer.xr.getSession();
    if (!session) return inp;
    let L = null, R = null;
    for (const src of session.inputSources) {
        if (!src.gamepad) continue;
        detectProfile(src);
        if (src.handedness === "left") L = src.gamepad;
        else if (src.handedness === "right") R = src.gamepad;
    }
    // shared bindings
    if (repeatFire("warpUp", R?.buttons[4]?.pressed ?? false, dtR)) {
        G.warp = Math.min(WARP_MAX, G.warp * 2);
        say("WARP " + warpLabel(G.warp));
    }
    if (repeatFire("warpDn", R?.buttons[5]?.pressed ?? false, dtR)) {
        G.warp = Math.max(1, G.warp / 2);
        say("WARP " + warpLabel(G.warp));
    }
    if (justPressed("lX", L?.buttons[4])) { G.gr = !G.gr; say("RIVER " + (G.gr ? "ON" : "OFF")); }
    if (justPressed("lStick", L?.buttons[3])) setVRMode(VR.mode === "ship" ? "god" : "ship");
    if (justPressed("lY", L?.buttons[5])) {
        if (VR.mode === "god") tourNext();
        else {
            setFocus(G.focus === "ship" ? "moon" : G.focus === "moon" ? "earth" : G.focus === "earth" ? "sun" : "ship");
            say("FOCUS " + focusName());
        }
    }
    // right stick click: recenter; held while dead = rebuild the ship
    const rsDown = R?.buttons[3]?.pressed ?? false;
    if (G.dead && rsDown) {
        restartHeld += dtR;
        if (restartHeld > 1) {
            restartHeld = -99;                            // fire once per hold
            H.restart();
            setVRMode("ship");
            say("SHIP REBUILT");
        }
    } else {
        if (justPressed("rStick", R?.buttons[3])) { recenter(); say("VIEW RECENTERED"); }
        restartHeld = 0;
    }
    if (VR.mode === "ship") pollShip(L, R, dtR);
    else pollGod(L, R, dtR);
    return inp;
}

// ---- aim ray → ecliptic plane: reticle + deferred BH placement ----
const _rayO = new THREE.Vector3(), _rayD = new THREE.Vector3();
function updateAim() {
    const show = VR.mode === "god" && aiming;
    if (rayL) rayL.visible = show;
    let hit = null;
    if (show || wantPlaceBH) {
        const c = ctrlByHand("left");
        if (c) {
            _m1.identity().extractRotation(c.matrixWorld);
            _rayO.setFromMatrixPosition(c.matrixWorld);
            _rayD.set(0, 0, -1).applyMatrix4(_m1).normalize();
            const t = -_rayO.y / _rayD.y;
            if (isFinite(t) && t > 0) hit = _v1.copy(_rayO).addScaledVector(_rayD, t);
        }
    }
    reticle.visible = show && !!hit;
    if (hit) {
        reticle.position.copy(hit);
        reticle.scale.setScalar(Math.max(1e-9, hit.distanceTo(camera.position) * .03));
    }
    if (wantPlaceBH) {
        wantPlaceBH = false;
        if (hit) {
            addBlackHole(hit.x / K - eph.earthX, -hit.z / K - eph.earthY, BH_SIZES[BH.sizeIdx]);
            say("BLACK HOLE PLACED · r_s " + fmtDist(BH_SIZES[BH.sizeIdx]));
            pulseHand("left", 1, 120);
        } else say("AIM AT THE ORBITAL PLANE");
    }
}

// ---- per-frame rig update + shadow camera ----
let pendRecenter = 0, panelT = 0;
export function vrUpdateRigs(oriX, oriZ, dtR) {
    if (!VR.active) return;
    if (pendRecenter > 0 && --pendRecenter === 0) recenter();
    if (VR.mode === "ship" && G.dead) {
        setVRMode("god");
        say("VEHICLE LOST · OBSERVER MODE · HOLD R-STICK TO REBUILD");
    }
    if (VR.mode === "ship") {
        worldRig.position.set(oriX, 0, oriZ);
        worldRig.rotation.y = G.heading - Math.PI / 2;   // rig -Z = ship nose
        worldRig.scale.setScalar(SHIP_WORLD_SCALE);
        if (sky) sky.scale.setScalar(1);
        if (galaxyBackdrop) galaxyBackdrop.scale.setScalar(1);
    } else {
        worldRig.position.copy(VR.god.pos);
        worldRig.rotation.y = VR.god.yaw;
        worldRig.scale.setScalar(VR.god.scale);
        // drive the desktop zoom state so cosmic layers (and the view you
        // return to on exit) track the god scale
        cam.dist = Math.min(CAM_DIST_MAX, Math.max(.03, VR.god.scale * 3));
        cam.tgt.copy(VR.god.pos);
        // keep the camera-attached sky dome outside the near plane at any
        // scale (its 4e6-unit radius near-clips once 1 m exceeds ~70 units)
        const skyK = Math.max(1, VR.god.scale * 1.2e-5);
        if (sky) sky.scale.setScalar(skyK);
        if (galaxyBackdrop) galaxyBackdrop.scale.setScalar(skyK);
    }
    worldRig.updateMatrixWorld(true);
    cockpitRig.updateMatrixWorld(true);
    // shadow the desktop camera with the VR eye: every existing system that
    // reads camera.position (shaders, glow scaling, star LOD, craft sizing,
    // BH observer time) keeps working untouched
    const xrCam = renderer.xr.getCamera();
    camera.position.copy(xrCam.position).applyMatrix4(worldOffset.matrixWorld);
    worldOffset.getWorldQuaternion(camera.quaternion).multiply(xrCam.quaternion);
    camera.updateMatrixWorld(true);
    updateAim();
    if (VR.mode === "god" && panel && (panelT += dtR) > .15) { panelT = 0; drawPanel(); }
}

// world pass first, then the cockpit composited over it (depth cleared,
// color kept) — same trick as the desktop path, but without the bloom
// composer, which does not support XR rendering
export function renderVRFrame(showCockpit) {
    renderer.render(scene, vrWorldCam);
    if (showCockpit) {
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(cockpitScene, vrCockpitCam);
        renderer.autoClear = true;
    }
}

// ---- session + entry button ----
async function setupButton() {
    if (!("xr" in navigator)) return;
    let ok = false;
    try { ok = await navigator.xr.isSessionSupported("immersive-vr"); } catch (e) { }
    if (!ok) return;
    const b = document.createElement("button");
    b.id = "vrBtn";
    b.className = "uiBtn";
    b.textContent = "ENTER VR";
    b.onclick = async () => {
        initAudio();
        if (renderer.xr.isPresenting) { renderer.xr.getSession()?.end(); return; }
        try {
            const s = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
            await renderer.xr.setSession(s);
        } catch (e) { toast("VR session failed: " + (e.message || e)); }
    };
    (document.getElementById("root") || document.body).appendChild(b);
    renderer.xr.addEventListener("sessionstart", () => { b.textContent = "EXIT VR"; });
    renderer.xr.addEventListener("sessionend", () => { b.textContent = "ENTER VR"; });
}

export function initVR(hooks) {
    H = hooks;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local");          // seated: head starts at rig origin
    for (let i = 0; i < 2; i++) {
        const c = renderer.xr.getController(i);
        c.addEventListener("connected", e => {
            c.userData.hand = e.data.handedness;
            if (!c.userData.viz) {
                c.userData.viz = buildHandViz(e.data.handedness);
                c.add(c.userData.viz);
                if (e.data.handedness === "left") {
                    // aim ray (god mode) + wrist panel live on the left hand
                    const rg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
                    rayL = new THREE.Line(rg, new THREE.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: .6 }));
                    rayL.scale.z = 600;
                    rayL.visible = false;
                    c.add(rayL);
                    buildPanel();
                    c.add(panel);
                }
            }
        });
        ctrls.push(c);
        cockpitOffset.add(c);
    }
    renderer.xr.addEventListener("sessionstart", () => {
        VR.active = true;
        initAudio();
        pendRecenter = 14;                               // wait for valid poses
        setVRMode(G.dead ? "god" : "ship");
    });
    renderer.xr.addEventListener("sessionend", () => {
        VR.active = false;
        reticle.visible = false;
        if (sky) sky.scale.setScalar(1);
        if (galaxyBackdrop) galaxyBackdrop.scale.setScalar(1);
    });
    setupButton();
}

window.__vr = { VR, setVRMode, recenter }; // debug/testing handle
