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

// faint glass pane: barely-there tint + specular sheen from interior lights
const mGlass = new THREE.MeshPhongMaterial({
    color: 0x9fc8ff, transparent: true, opacity: .045, shininess: 180,
    specular: 0xdef0ff, side: THREE.DoubleSide, depthWrite: false,
});
function pane(w, h, x, y, z, rx = 0, ry = 0) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mGlass);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    m.renderOrder = 2;
    cockpitScene.add(m);
    return m;
}

// ---- shell: REAR hull arc only — everything forward and above is glass ----
// (cylinder theta 0 faces +Z = behind the pilot; camera looks down -Z)
{
    const hull = new THREE.Mesh(
        new THREE.CylinderGeometry(1.55, 1.55, 2.1, 24, 1, true, -1.05, 2.1),
        new THREE.MeshPhongMaterial({ color: 0x171d25, shininess: 6, side: THREE.BackSide }));
    hull.position.set(0, .35, .45);
    cockpitScene.add(hull);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.55, 24),
        new THREE.MeshPhongMaterial({ color: 0x10151b, shininess: 4 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -.78, .45);
    cockpitScene.add(floor);
    // rear bulkhead with hatch outline
    box(1.2, 1.5, .06, mPanel, 0, .3, 1.55);
    box(.62, .98, .02, mDark, 0, .25, 1.51);
}

// ---- panoramic canopy: 3 front panes, big side windows, overhead skylight ----
{
    box(2.7, .08, .14, mSill, 0, -.3, -.98);                       // slim sill under the windshield
    // slim A-pillars far out + two thin mullions → three wide front panes
    box(.06, 1.5, .1, mFrame, -1.34, .3, -.86, 0, 0, .26);
    box(.06, 1.5, .1, mFrame, 1.34, .3, -.86, 0, 0, -.26);
    box(.04, 1.42, .08, mFrame, -.45, .34, -.96, 0, 0, .08);
    box(.04, 1.42, .08, mFrame, .45, .34, -.96, 0, 0, -.08);
    pane(.86, 1.4, -.9, .32, -.93, -.1, .12);
    pane(.88, 1.42, 0, .34, -.97, -.1, 0);
    pane(.86, 1.4, .9, .32, -.93, -.1, -.12);
    // overhead: two slim transverse ribs frame a skylight band — look up, see stars
    box(2.5, .06, .12, mFrame, 0, 1.0, -.52, .35);
    box(2.6, .06, .12, mFrame, 0, 1.18, .18, 0);
    pane(2.4, .72, 0, 1.12, -.18, 1.25, 0);
    // side windows: long glass with one slim B-pillar per side
    box(.08, .08, 1.9, mSill, -1.42, -.28, -.15);                  // side sills
    box(.08, .08, 1.9, mSill, 1.42, -.28, -.15);
    box(.08, 1.2, .07, mFrame, -1.43, .3, -.12, 0, 0, .04);        // B-pillars
    box(.08, 1.2, .07, mFrame, 1.43, .3, -.12, 0, 0, -.04);
    box(.08, .07, 1.9, mFrame, -1.4, .92, -.15, 0, 0, .06);        // side top rails
    box(.08, .07, 1.9, mFrame, 1.4, .92, -.15, 0, 0, -.06);
    pane(.85, 1.1, -1.41, .3, -.6, 0, Math.PI / 2);
    pane(.85, 1.1, -1.43, .3, .35, 0, Math.PI / 2);
    pane(.85, 1.1, 1.41, .3, -.6, 0, -Math.PI / 2);
    pane(.85, 1.1, 1.43, .3, .35, 0, -Math.PI / 2);
}

// ---- dashboard ----
export const mfdScreens = [];
let throttleLever = null;
{
    box(2.6, .3, .5, mPanel, 0, -.46, -.8, .28);                  // main console slab
    box(2.6, .07, .34, mSill, 0, -.31, -.72, .58);                // slim brow / glareshield
    box(.5, .26, .42, mPanel, 0, -.56, -.46, .5);                 // center pedestal
    // angled side consoles give the bay depth
    box(.5, .2, 1.0, mPanel, -1.08, -.52, -.15, 0, .14, .3);
    box(.5, .2, 1.0, mPanel, 1.08, -.52, -.15, 0, -.14, -.3);
    box(.4, .015, .26, new THREE.MeshBasicMaterial({ color: 0x14333f }), -1.06, -.41, -.3, -.3, .14);
    box(.4, .015, .26, new THREE.MeshBasicMaterial({ color: 0x3f2914 }), 1.06, -.41, -.3, -.3, -.14);
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
    for (const [x, tilt] of [[-.56, .16], [0, 0], [.56, -.16]]) {
        const scr = new THREE.Mesh(
            new THREE.PlaneGeometry(.46, .345),
            new THREE.MeshBasicMaterial({ color: 0xffffff })); // map assigned by instruments.js
        scr.position.set(x, -.305, -.64);
        scr.rotation.set(-.56, tilt, 0, "YXZ");
        cockpitScene.add(scr);
        const bezel = box(.52, .405, .025, mDark, x, -.307, -.655, -.56, tilt);
        bezel.rotation.order = "YXZ";
        mfdScreens.push(scr);
    }
}

// ---- annunciators ride the forward skylight rib ----
const warnLights = {};
{
    const defs = [["AP", 0x39d98a, -.3], ["ALT", 0xff5040, -.1], ["FUEL", 0xffb13d, .1], ["WARP", 0x6fa8ff, .3]];
    for (const [key, color, x] of defs) {
        const l = new THREE.Mesh(new THREE.SphereGeometry(.02, 10, 8),
            new THREE.MeshBasicMaterial({ color }));
        l.position.set(x, .965, -.49);
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
