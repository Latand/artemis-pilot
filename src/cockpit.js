import * as THREE from "three";

// First-person cockpit, rendered as a SEPARATE scene composited after the
// world pass (renderer.clearDepth + render on top). Keeps the interior out
// of the bloom pass, immune to world-scale z-precision, and fixed to the
// ship: the world camera rotates to match head direction, the cockpit only
// rotates with the head's look offsets.
export const cockpitScene = new THREE.Scene();
export const cockpitCam = new THREE.PerspectiveCamera(56, 1, .01, 12);
cockpitScene.add(cockpitCam);

// head-look state, written by scene.js pointer handlers in cabin mode
export const look = { yaw: 0, pitch: 0 };
export const LOOK_YAW_MAX = 2.7, LOOK_PITCH_MIN = -.75, LOOK_PITCH_MAX = .95;

const mPanel = new THREE.MeshPhongMaterial({ color: 0x222b36, shininess: 18, specular: 0x33404e });
const mFrame = new THREE.MeshPhongMaterial({ color: 0x39434f, shininess: 55, specular: 0x6b7886 });
const mDark = new THREE.MeshPhongMaterial({ color: 0x12161c, shininess: 8 });
const mSill = new THREE.MeshPhongMaterial({ color: 0x1a2129, shininess: 12 });

function box(w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    cockpitScene.add(m);
    return m;
}

// ---- shell: REAR hull arc only — the forward 210° stays open glass ----
// (cylinder theta 0 faces +Z = behind the pilot; camera looks down -Z)
{
    const hull = new THREE.Mesh(
        new THREE.CylinderGeometry(1.45, 1.45, 2.3, 24, 1, true, -1.3, 2.6),
        new THREE.MeshPhongMaterial({ color: 0x171d25, shininess: 6, side: THREE.BackSide }));
    hull.position.set(0, .35, .35);
    cockpitScene.add(hull);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.45, 24),
        new THREE.MeshPhongMaterial({ color: 0x10151b, shininess: 4 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -.78, .35);
    cockpitScene.add(floor);
    // rear bulkhead with hatch outline
    box(1.2, 1.5, .06, mPanel, 0, .3, 1.5);
    box(.62, .98, .02, mDark, 0, .25, 1.46);
}

// ---- canopy frame ----
{
    box(2.0, .1, .16, mSill, 0, -.34, -.95);                      // sill under the window
    box(1.7, .09, .3, mFrame, 0, .78, -.62, .5);                  // header bar, slanted back
    box(.09, 1.3, .12, mFrame, -.96, .2, -.78, 0, 0, .2);         // A-pillar L
    box(.09, 1.3, .12, mFrame, .96, .2, -.78, 0, 0, -.2);         // A-pillar R
    box(.07, 1.16, .1, mFrame, -.34, .26, -.92, 0, 0, .06);       // center mullions
    box(.07, 1.16, .1, mFrame, .34, .26, -.92, 0, 0, -.06);
    // side window frames
    box(.1, .9, 1.3, mFrame, -1.18, .25, -.1, 0, 0, 0);
    box(.1, .9, 1.3, mFrame, 1.18, .25, -.1, 0, 0, 0);
    box(.1, .12, 1.5, mSill, -1.16, -.3, -.1);
    box(.1, .12, 1.5, mSill, 1.16, -.3, -.1);
}

// ---- dashboard ----
export const mfdScreens = [];
let throttleLever = null;
{
    box(2.0, .3, .5, mPanel, 0, -.44, -.82, .28);                 // main console slab
    box(2.0, .1, .4, mSill, 0, -.3, -.72, .55);                   // brow / glareshield
    box(.5, .26, .42, mPanel, 0, -.56, -.46, .5);                 // center pedestal
    // throttle lever on the pedestal
    const lever = new THREE.Group();
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(.012, .012, .14, 8), mFrame);
    stalk.position.y = .07;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(.028, 12, 8), new THREE.MeshPhongMaterial({ color: 0xb33c24, shininess: 40 }));
    knob.position.y = .15;
    lever.add(stalk, knob);
    lever.position.set(.14, -.52, -.48);
    cockpitScene.add(lever);
    throttleLever = lever;
    // three MFD screens angled toward the pilot's eye
    for (const [x, tilt] of [[-.52, .14], [0, 0], [.52, -.14]]) {
        const scr = new THREE.Mesh(
            new THREE.PlaneGeometry(.42, .315),
            new THREE.MeshBasicMaterial({ color: 0xffffff })); // map assigned by instruments.js
        scr.position.set(x, -.315, -.66);
        scr.rotation.set(-.46, tilt, 0, "YXZ");
        cockpitScene.add(scr);
        const bezel = box(.48, .375, .025, mDark, x, -.317, -.675, -.46, tilt);
        bezel.rotation.order = "YXZ";
        mfdScreens.push(scr);
    }
}

// ---- overhead annunciator strip ----
const warnLights = {};
{
    box(.9, .07, .26, mPanel, 0, .69, -.5, .9);
    const defs = [["AP", 0x39d98a, -.3], ["ALT", 0xff5040, -.1], ["FUEL", 0xffb13d, .1], ["WARP", 0x6fa8ff, .3]];
    for (const [key, color, x] of defs) {
        const l = new THREE.Mesh(new THREE.SphereGeometry(.022, 10, 8),
            new THREE.MeshBasicMaterial({ color }));
        l.position.set(x, .665, -.41);
        l.material.transparent = true;
        l.material.opacity = .12;
        cockpitScene.add(l);
        warnLights[key] = l;
    }
}

// ---- interior lighting ----
const ambient = new THREE.AmbientLight(0x4c5c74, .9);
const sunInterior = new THREE.DirectionalLight(0xfff2dc, 1.1);
const panelGlow = new THREE.PointLight(0x6fd8e8, .55, 1.9);
panelGlow.position.set(0, -.25, -.55);
const thrustLight = new THREE.PointLight(0xff8a4a, 0, 4);
thrustLight.position.set(0, -.2, 1.4);
cockpitScene.add(ambient, sunInterior, panelGlow, thrustLight);

const _sunLocal = new THREE.Vector3();
// sunDirWorld: world-space Earth-frame sun direction; heading: ship heading.
// The interior light direction = sun direction expressed in cockpit axes
// (cockpit -Z = ship nose), so sunlight sweeps the cabin as the ship rotates.
export function updateCockpit(dtR, sunDirWorld, heading, aMag, boost, warn) {
    const c = Math.cos(heading), s = Math.sin(heading);
    // world (x, z) → cockpit frame: nose dir (c, -s) maps to -Z
    _sunLocal.set(sunDirWorld.x * -s * -1 - sunDirWorld.z * c * -1, .35, -(sunDirWorld.x * c - sunDirWorld.z * s));
    // guard degenerate vector
    if (_sunLocal.lengthSq() < 1e-9) _sunLocal.set(0, 1, 0);
    sunInterior.position.copy(_sunLocal.normalize().multiplyScalar(5));
    thrustLight.intensity = aMag > 0 ? (boost ? 1.6 : .8) * (0.85 + .3 * Math.sin(performance.now() * .04)) : 0;
    for (const key of Object.keys(warnLights)) {
        const on = !!warn[key];
        const m = warnLights[key].material;
        m.opacity += ((on ? 1 : .12) - m.opacity) * Math.min(1, dtR * 10);
    }
    // head orientation: cockpit fixed, head rotates
    cockpitCam.rotation.order = "YXZ";
    cockpitCam.rotation.set(look.pitch, -look.yaw, 0);
    cockpitCam.position.set(0, 0, 0);
}

export function setCockpitAspect(aspect) {
    cockpitCam.aspect = aspect;
    cockpitCam.updateProjectionMatrix();
}

export function setLeverThrottle(throttle) {
    if (throttleLever) throttleLever.rotation.x = -.5 + Math.min(1, throttle / 3) * 1.0;
}
