import { readFileSync } from "node:fs";

globalThis.window = {};

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

const { BH, GS, bhRegister, bhMuAt, addPhantom, gsPull } = await import("../src/state.js");
const { C_LIGHT } = await import("../src/constants.js");
const { segmentSphereHit } = await import("../src/geometry.js");
const {
  SHIP_GRAB_CANCEL_PX, SHIP_GRAB_HOLD_MS, SHIP_GRAB_MAX_SPEED,
  SHIP_GRAB_PICK_MAX_PX, SHIP_GRAB_PICK_MIN_PX, SHIP_GRAB_THROW_SCALE, shipGrabPendingIntent,
} = await import("../src/shipGrabPolicy.js");

BH.n = 1;
bhRegister(0, 0, 0, 1, 0, 0, [{ x: 0, y: 0, z: 0, t: 0, dmu: 123 }]);

const near = bhMuAt(0, 0, 0, 0, 0.5);
const offPlane = bhMuAt(0, 0, 0, C_LIGHT, 0.5);
assert(near === 123, "3D black-hole light front should include points inside the front");
assert(offPlane === 0, "3D black-hole light front should exclude off-plane points outside the front");

GS.length = 0;
addPhantom(0, 0, 0, 0, 0, 0, 1, 0);
const ghostPull = [0, 0, 0];
gsPull(0, 0, 10, 0, ghostPull);
assert(ghostPull[2] < 0, "phantom and ghost gravity should pull off-plane points in z");
assert(Math.abs(ghostPull[0]) < 1e-12 && Math.abs(ghostPull[1]) < 1e-12, "axis-aligned ghost pull should not create lateral drift");

const blackholesSrc = readFileSync(new URL("../src/blackholes.js", import.meta.url), "utf8");
const hudSrc = readFileSync(new URL("../src/hud.js", import.meta.url), "utf8");
const mainSrc = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const physicsSrc = readFileSync(new URL("../src/physics.js", import.meta.url), "utf8");
const sceneSrc = readFileSync(new URL("../src/scene.js", import.meta.url), "utf8");
assert(blackholesSrc.includes("sci(msun * SOLAR_MASS_KG"), "small black-hole mass labels should use kg");
assert(blackholesSrc.includes("pwAccelMs2(mu, rs * 3, rs)"), "black-hole selector gravity should match the runtime Paczynski-Wiita field");
assert(
  blackholesSrc.includes("export function pwAccelMs2") &&
    blackholesSrc.includes("1000 * mu / Math.max(1e-30, eff * eff)") &&
    !blackholesSrc.includes("accelMs2(mu, Math.max(rKm - rsKm"),
  "black-hole selector gravity should avoid the kilometer floor for sub-km holes",
);
assert(
  hudSrc.includes("pwAccelMs2(BH.mu[focusBH], dShip, BH.rs[focusBH])") &&
    !hudSrc.includes("fmtAccel(accelMs2(BH.mu[focusBH]"),
  "focused black-hole HUD should share the unclamped Paczynski-Wiita acceleration readout",
);
assert(
  !mainSrc.includes("Time warp capped at 30 d/s while black holes exist") &&
    !mainSrc.includes("G.warp = 2592000; toast") &&
    physicsSrc.includes("function tryBHBridgeJump") &&
    physicsSrc.includes("function bhBridgeWindow") &&
    physicsSrc.includes("bhAccelAtShip(0, _bhKick)") &&
    physicsSrc.includes("shipDeepJump(jump)") &&
    physicsSrc.includes("bhAdvance(ok, G.t)"),
  "black-hole time warp should use the adaptive bridge path without the old 30 d/s cap",
);
assert(
  blackholesSrc.includes("function ensureBHPlacementPreview()") &&
    blackholesSrc.includes("function updateBHPlacementUI") &&
    blackholesSrc.includes("commitBHPlacement(e.clientX, e.clientY)") &&
    blackholesSrc.includes("body.classList.toggle(\"bh-place-mode\", BH_PLACE.active)"),
  "black-hole placement should keep the cursor preview, panel UI, and click placement wired",
);

const inputSrc = readFileSync(new URL("../src/input.js", import.meta.url), "utf8");
assert(
  inputSrc.includes('case "KeyB": toggleBHPlacementMode(); break;') &&
    inputSrc.includes('case "Escape":') &&
    inputSrc.includes("cancelBHPlacementMode()"),
  "B should arm black-hole placement mode and Escape should cancel it",
);

const indexSrc = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const styleSrc = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
assert(
  indexSrc.includes('id="bhPlacer"') &&
    indexSrc.includes('id="bhPreviewCanvas"') &&
    indexSrc.includes('id="bhSizeRail"') &&
    styleSrc.includes("body.bh-place-mode #gl canvas { cursor: crosshair; }"),
  "black-hole selector panel should expose preview canvas, size rail, and placement cursor styling",
);

const trailsSrc = readFileSync(new URL("../src/trails.js", import.meta.url), "utf8");
assert(
  trailsSrc.includes("impactSpr.position.set(prPos[impactIdx], prPos[impactIdx + 1], prPos[impactIdx + 2])"),
  "prediction impact marker should keep the 3D y coordinate",
);
assert(segmentSphereHit(2, 0, 3, -2, 0, -3, 1), "3D segment-sphere helper should detect a crossing segment");
assert(!segmentSphereHit(2, 0, 3, 2, 0, -3, 1), "3D segment-sphere helper should reject a parallel miss");
assert(
  trailsSrc.includes("segmentSphereHit(pmx, pmy, pmz, dmx, dmy, dmz, R_MOON)") &&
    trailsSrc.includes("segmentSphereHit(pex, pey, pez, _ps[0], _ps[1], _ps[2], R_EARTH)") &&
    !trailsSrc.includes("function segHit("),
  "prediction grazing impact checks should use 3D segment-sphere tests",
);
assert(
    shipGrabPendingIntent(0, 0) === "pending" &&
    shipGrabPendingIntent(SHIP_GRAB_CANCEL_PX + 1, SHIP_GRAB_HOLD_MS - 1) === "camera" &&
    shipGrabPendingIntent(SHIP_GRAB_CANCEL_PX + 1, SHIP_GRAB_HOLD_MS + 80) === "camera" &&
    shipGrabPendingIntent(SHIP_GRAB_CANCEL_PX - 1, SHIP_GRAB_HOLD_MS + 1) === "activate" &&
    SHIP_GRAB_HOLD_MS >= 200 &&
    SHIP_GRAB_CANCEL_PX <= 8 &&
    SHIP_GRAB_MAX_SPEED <= 40 &&
    SHIP_GRAB_THROW_SCALE <= .2 &&
    SHIP_GRAB_PICK_MIN_PX >= 12 &&
    SHIP_GRAB_PICK_MAX_PX <= 30 &&
    sceneSrc.includes("shipGrabPendingIntent") &&
    sceneSrc.includes("window.setTimeout") &&
    sceneSrc.includes("shipGrab.armed = true") &&
    !sceneSrc.includes("setTimeout(() => activateShipGrab") &&
    sceneSrc.includes("cancelPendingShipGrabToCamera") &&
    indexSrc.includes("hold-drag ship"),
  "ship mouse grab should require deliberate hold, send pre-hold movement to camera control, and keep a low velocity cap",
);

console.log("core smoke passed");
