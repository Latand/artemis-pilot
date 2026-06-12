import * as THREE from "three";

// First-person cockpit, rendered as a SEPARATE scene composited after the
// world pass (renderer.clearDepth + render on top). Keeps the interior out
// of the bloom pass, immune to world-scale z-precision, and fixed to the
// ship: the world camera rotates to match head direction, the cockpit only
// rotates with the head's look offsets.
//
// v3 layout: the pilot sits inside a continuous glass bubble (one BackSide
// sphere — no seams or gaps at any look angle), with an opaque rear shell,
// a full floor, and a curved wraparound console. Frame ribs are torus arcs
// lying ON the dome, so structure and glass can never separate.
export const cockpitScene = new THREE.Scene();
export const cockpitCam = new THREE.PerspectiveCamera(56, 1, .01, 12);
cockpitScene.add(cockpitCam);

// head-look state, written by scene.js pointer handlers in cabin mode
export const look = { yaw: 0, pitch: 0 };
export const LOOK_YAW_MAX = 2.7, LOOK_PITCH_MIN = -.75, LOOK_PITCH_MAX = .95;

const DOME_R = 1.6, DOME_CY = -.1;      // glass bubble: radius, center height
const FLOOR_Y = -.74;

const mPanel = new THREE.MeshPhongMaterial({ color: 0x222b36, shininess: 18, specular: 0x33404e, side: THREE.DoubleSide, emissive: 0x0a0f15 });
const mFrame = new THREE.MeshPhongMaterial({ color: 0x39434f, shininess: 55, specular: 0x6b7886 });
const mDark = new THREE.MeshPhongMaterial({ color: 0x12161c, shininess: 8 });
const mGlass = new THREE.MeshPhongMaterial({
    color: 0x9fc8ff, transparent: true, opacity: .05, shininess: 180,
    specular: 0xdef0ff, side: THREE.BackSide, depthWrite: false,
});

// dome-circle radius at a given height (ribs must hug the glass)
const domeR = y => Math.sqrt(Math.max(.01, DOME_R * DOME_R - (y - DOME_CY) * (y - DOME_CY)));

// ---- enclosure ----
{
    // the canopy: one closed glass sphere around the pilot
    const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_R, 48, 32), mGlass);
    dome.position.y = DOME_CY;
    dome.renderOrder = 1;
    cockpitScene.add(dome);
    // opaque rear shell: cylinder arc hugging the dome behind the pilot
    // (cylinder theta 0 faces +Z = backwards; camera looks down -Z)
    const shell = new THREE.Mesh(
        new THREE.CylinderGeometry(DOME_R * .985, DOME_R * .985, 2.1, 32, 1, true, -1.25, 2.5),
        new THREE.MeshPhongMaterial({ color: 0x232c38, shininess: 10, side: THREE.BackSide }));
    shell.position.y = DOME_CY + .25;
    cockpitScene.add(shell);
    // rear shell cap above head height: sphere sector matching the dome
    const cap = new THREE.Mesh(
        new THREE.SphereGeometry(DOME_R * .98, 32, 12, Math.PI / 2 - 1.25, 2.5, 0, 1.05),
        new THREE.MeshPhongMaterial({ color: 0x141a21, shininess: 6, side: THREE.BackSide }));
    cap.position.y = DOME_CY;
    cockpitScene.add(cap);
    // full floor disc seals the bottom
    const floor = new THREE.Mesh(new THREE.CircleGeometry(domeR(FLOOR_Y) * 1.01, 40),
        new THREE.MeshPhongMaterial({ color: 0x10151b, shininess: 4 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    cockpitScene.add(floor);
    // rear bulkhead detail: hatch outline on the shell
    const hatch = new THREE.Mesh(new THREE.PlaneGeometry(.6, .95), mDark);
    hatch.position.set(0, .12, DOME_R * .96);
    hatch.rotation.y = Math.PI;
    cockpitScene.add(hatch);
}

// ---- frame ribs: torus arcs lying on the glass ----
{
    const rib = (tube, arcRadius, y, arc, rotY, vertical = false) => {
        const t = new THREE.Mesh(new THREE.TorusGeometry(arcRadius, tube, 8, 40, arc), mFrame);
        if (vertical) {
            // circle in a vertical plane through the center, azimuth rotY
            t.rotation.y = rotY;
            t.position.y = DOME_CY;
        } else {
            t.rotation.x = Math.PI / 2;
            t.rotation.z = rotY;
            t.position.y = y;
        }
        cockpitScene.add(t);
        return t;
    };
    // horizontal rails: sill ring (full), brow ring (front sector)
    rib(.028, domeR(-.18), -.18, Math.PI * 2, 0);
    rib(.024, domeR(.92), .92, 2.4, Math.PI / 2 - 1.2);
    // vertical ribs every ~50° around the front and sides; arc spans
    // from below the sill up over the crown — structure reads at any angle
    for (const az of [-2.0, -1.2, -.45, .45, 1.2, 2.0]) {
        const t = new THREE.Mesh(new THREE.TorusGeometry(DOME_R * .995, .022, 8, 32, 2.1), mFrame);
        t.rotation.y = Math.PI / 2 - az;      // torus arc starts at +X: place it at azimuth az (0 = dead ahead)
        t.rotation.z = -.35;                   // start the arc below the horizon
        t.position.y = DOME_CY;
        cockpitScene.add(t);
    }
}

// ---- wraparound console: one curved band + top deck, sealed to the floor ----
export const mfdScreens = [];
let throttleLever = null;
{
    // console face: tapered cylinder sector facing the pilot
    const band = new THREE.Mesh(
        new THREE.CylinderGeometry(.8, 1.05, FLOOR_Y * -1 - .22, 40, 1, true, Math.PI - 1.35, 2.7),
        mPanel);
    band.position.y = (FLOOR_Y - .22) / 2;
    cockpitScene.add(band);
    // top deck: flat ring sector capping the console
    const deckGeom = new THREE.RingGeometry(.52, .82, 40, 1, Math.PI / 2 - 1.35, 2.7);
    const deck = new THREE.Mesh(deckGeom, mPanel);
    deck.rotation.x = -Math.PI / 2;
    deck.position.y = -.22;
    cockpitScene.add(deck);
    // inner kick wall under the deck so glancing down never shows a gap
    const kick = new THREE.Mesh(
        new THREE.CylinderGeometry(.52, .52, -.22 - FLOOR_Y, 32, 1, true, Math.PI - 1.35, 2.7),
        mPanel);
    kick.position.y = (FLOOR_Y - .22) / 2;
    cockpitScene.add(kick);
    // three MFDs standing on the deck, each facing the pilot's head
    for (const az of [-.62, 0, .62]) {
        const sx = Math.sin(az), cz = Math.cos(az);
        const bezel = new THREE.Mesh(new THREE.BoxGeometry(.5, .39, .035), mDark);
        bezel.position.set(sx * .68, -.215, -cz * .68);
        bezel.rotation.set(-.48, -az, 0, "YXZ");
        cockpitScene.add(bezel);
        const scr = new THREE.Mesh(
            new THREE.PlaneGeometry(.45, .34),
            new THREE.MeshBasicMaterial({ color: 0xffffff })); // map assigned by instruments.js
        scr.position.set(sx * .664, -.206, -cz * .664);
        scr.rotation.set(-.48, -az, 0, "YXZ");
        cockpitScene.add(scr);
        mfdScreens.push(scr);
    }
    // throttle: base block + lever on the deck, outboard of the SYS screen
    const base = new THREE.Mesh(new THREE.BoxGeometry(.14, .06, .18), mDark);
    base.position.set(Math.sin(1.08) * .7, -.2, -Math.cos(1.08) * .7);
    base.rotation.y = -1.08;
    cockpitScene.add(base);
    const lever = new THREE.Group();
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(.01, .01, .09, 8), mFrame);
    stalk.position.y = .045;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(.022, 12, 8), new THREE.MeshPhongMaterial({ color: 0xb33c24, shininess: 40 }));
    knob.position.y = .095;
    lever.add(stalk, knob);
    lever.position.set(Math.sin(1.08) * .7, -.18, -Math.cos(1.08) * .7);
    cockpitScene.add(lever);
    throttleLever = lever;
}

// ---- annunciators ride the brow rib ----
const warnLights = {};
{
    const r = domeR(.92) - .04;
    const defs = [["AP", 0x39d98a, -.27], ["ALT", 0xff5040, -.09], ["FUEL", 0xffb13d, .09], ["WARP", 0x6fa8ff, .27]];
    for (const [key, color, az] of defs) {
        const l = new THREE.Mesh(new THREE.SphereGeometry(.022, 10, 8),
            new THREE.MeshBasicMaterial({ color }));
        l.position.set(Math.sin(az) * r, .9, -Math.cos(az) * r);
        l.material.transparent = true;
        l.material.opacity = .12;
        cockpitScene.add(l);
        warnLights[key] = l;
    }
}

// ---- interior lighting: even ambient, sun direction, tucked accents ----
const ambient = new THREE.AmbientLight(0x4c5c74, .95);
const sunInterior = new THREE.DirectionalLight(0xfff2dc, 1.05);
// console accent: small, tucked under the deck lip — a glow line, not a blob
const panelGlow = new THREE.PointLight(0x6fd8e8, .28, .9);
panelGlow.position.set(0, -.2, -.62);
const thrustLight = new THREE.PointLight(0xff8a4a, 0, 4);
thrustLight.position.set(0, -.2, 1.4);
// dim warm dome light so the rear cabin reads instead of vanishing
const domeLight = new THREE.PointLight(0xffd9b0, .4, 3.4);
domeLight.position.set(0, .75, .7);
cockpitScene.add(ambient, sunInterior, panelGlow, thrustLight, domeLight);

const _sunLocal = new THREE.Vector3();
// sunDirWorld: world-space Earth-frame sun direction; heading: ship heading.
// The interior light direction = sun direction expressed in cockpit axes
// (cockpit -Z = ship nose), so sunlight sweeps the cabin as the ship rotates.
export function updateCockpit(dtR, sunDirWorld, heading, aMag, boost, warn, shake = 0) {
    const c = Math.cos(heading), s = Math.sin(heading);
    _sunLocal.set(sunDirWorld.x * s + sunDirWorld.z * c, .35, -(sunDirWorld.x * c - sunDirWorld.z * s));
    if (_sunLocal.lengthSq() < 1e-9) _sunLocal.set(0, 1, 0);
    sunInterior.position.copy(_sunLocal.normalize().multiplyScalar(5));
    thrustLight.intensity = aMag > 0 ? (boost ? 1.6 : .8) * (0.85 + .3 * Math.sin(performance.now() * .04)) : 0;
    for (const key of Object.keys(warnLights)) {
        const on = !!warn[key];
        const m = warnLights[key].material;
        m.opacity += ((on ? 1 : .12) - m.opacity) * Math.min(1, dtR * 10);
    }
    // head orientation: cockpit fixed, head rotates; thrust/aero rumble is a
    // millimetre-scale head jitter, matched to the world camera's micro-shake
    cockpitCam.rotation.order = "YXZ";
    cockpitCam.rotation.set(look.pitch, -look.yaw, 0);
    const j = shake * .006;
    cockpitCam.position.set((Math.random() - .5) * j, (Math.random() - .5) * j, (Math.random() - .5) * j);
}

export function setCockpitAspect(aspect) {
    cockpitCam.aspect = aspect;
    cockpitCam.updateProjectionMatrix();
}

export function setLeverThrottle(throttle) {
    if (throttleLever) throttleLever.rotation.x = -.5 + Math.min(1, throttle / 3) * 1.0;
}
