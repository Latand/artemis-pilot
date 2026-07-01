import { readFileSync } from "node:fs";

globalThis.window = {};

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

const { BH, GS, bhRegister, bhMuAt, addPhantom, gsPull } = await import("../src/state.js");
const { C_LIGHT } = await import("../src/constants.js");
const { segmentSphereHit } = await import("../src/geometry.js");
const { hashInts, makeRNG, splitSeed, gaussian, randNormal, samplePoisson } = await import("../src/universe/prng.js");
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
const constantsSrc = readFileSync(new URL("../src/constants.js", import.meta.url), "utf8");
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
assert(
  mainSrc.includes('perfEnd("frame.total"') &&
    mainSrc.includes("function finishFramePerf") &&
    mainSrc.includes("loadShed: renderQuality.loadShed"),
  "frame loop should expose total-frame perf samples for browser bottleneck tracing",
);
assert(
    constantsSrc.includes("OMEGA_LAMBDA: 0.6889") &&
    constantsSrc.includes("H0_KM_S_MPC: 67.66") &&
    !constantsSrc.includes("H_SIM") &&
    physicsSrc.includes("shipCosmologyJump") &&
    physicsSrc.includes("smoothCosmologyAccelAt") &&
    physicsSrc.includes("cosmologyJumpClear") &&
    physicsSrc.includes("stellarJumpClear") &&
    physicsSrc.includes("osculatingPeriapsis") &&
    physicsSrc.includes("segmentSphereHit") &&
    mainSrc.includes("darkMatterRelativeAccel"),
    "cosmology should use physical Lambda, a differential NFW halo, and a contact-gated smooth-field jump path",
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

// PRNG golden-vector determinism: compares individual draws' exact bit
// patterns (not running sums, which can drift a ULP between JS engines
// through associativity/FMA differences in the JIT) against constants
// hard-coded from a known-seed run, verified bit-identical across Node and
// Bun before being committed here.
function f64Hex(n) {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = n;
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const goldenSeed = hashInts(0x9e3779b9, 42, -7, 1000000007);
assert(goldenSeed === 1901773389, "golden PRNG seed hash is stable");
const goldenRng = makeRNG(goldenSeed);
const goldenUniform = [];
for (let i = 0; i < 10000; i++) {
  const v = goldenRng();
  if (i === 0 || i === 1 || i === 4999 || i === 9998 || i === 9999) goldenUniform.push(f64Hex(v));
}
assert(
  goldenUniform.join(",") ===
    "000080c580deca3f,0000806dd729d73f,000000dd95a7bd3f,0000009c1e50a63f,0000e02e9480e83f",
  "makeRNG 10k-draw golden vector matches (unchanged behaviour)",
);
const goldenSubA = splitSeed(goldenSeed, 7);
const goldenSubB = splitSeed(goldenSeed, 8);
assert(goldenSubA === 1936291253 && goldenSubB === 2816320190 && goldenSubA !== goldenSubB && goldenSubA !== goldenSeed,
  "splitSeed derives distinct, stable 32-bit sub-seeds");

// gaussian/randNormal now share the AS 241 (Wichura PPND16) inverse-normal-CDF
// implementation: one uniform draw per call, no spare caching, no trig.
// Goldens below were regenerated and confirmed bit-identical (full f64 hex
// pattern) under both `node` and `bun` before being hardcoded here.
const goldenGaussRng = makeRNG(goldenSubA);
const goldenGaussian = [];
for (let i = 0; i < 10000; i++) {
  const g = gaussian(goldenGaussRng);
  if (i === 0 || i === 1 || i === 4999 || i === 9998 || i === 9999) goldenGaussian.push(f64Hex(g));
}
assert(
  goldenGaussian.join(",") ===
    "c2f8445956dfe03f,bc10d14448d60040,ed7e193cc321d4bf,88e114f22806983f,a763a3717111d63f",
  "gaussian 10k-draw golden vector matches (AS 241, one uniform per draw)",
);
const goldenNormalRng = makeRNG(goldenSubB);
const goldenNormal = [];
for (let i = 0; i < 10000; i++) {
  const g = randNormal(goldenNormalRng);
  if (i === 0 || i === 1 || i === 4999 || i === 9998 || i === 9999) goldenNormal.push(f64Hex(g));
}
assert(
  goldenNormal.join(",") ===
    "bf2052b6484ff33f,f01417e4194ade3f,519d1c1d5331f53f,57f075115ee9e03f,433862f7d0c3e33f",
  "randNormal 10k-draw golden vector matches (AS 241, one uniform per draw)",
);
const goldenPoissonRng = makeRNG(goldenSeed);
const goldenPoisson = [];
for (let i = 0; i < 1000; i++) {
  const p = samplePoisson(goldenPoissonRng, 5);
  if (i === 0 || i === 999) goldenPoisson.push(p);
}
assert(goldenPoisson.join(",") === "4,8", "samplePoisson golden vector unchanged (small-λ Knuth branch untouched)");
// Large-λ branch (λ >= 30) takes the Gaussian-approximation path through the
// now-AS-241-based randNormal; a separate stream/seed than the λ=5 draw above
// so the two goldens can't mask a regression in either branch.
const goldenPoissonRng50 = makeRNG(goldenSeed);
const goldenPoisson50 = [];
for (let i = 0; i < 1000; i++) {
  const p = samplePoisson(goldenPoissonRng50, 50);
  if (i === 0 || i === 999) goldenPoisson50.push(p);
}
assert(goldenPoisson50.join(",") === "44,49", "samplePoisson(λ=50) large-branch golden vector matches");

// Forbidden-source scan: none of these files may reach for non-deterministic
// or non-portable primitives that would break reproducible procedural
// generation across engines/runs. Comments are stripped first so words like
// "Math.random" inside an explanatory comment don't trip the scan.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const prngSrc = readFileSync(new URL("../src/universe/prng.js", import.meta.url), "utf8");
const prngCode = stripComments(prngSrc);
const scanTargets = [
  ["prng.js", prngCode],
  ["astroConstants.js", stripComments(readFileSync(new URL("../src/universe/astroConstants.js", import.meta.url), "utf8"))],
  ["renderOrigin.js", stripComments(readFileSync(new URL("../src/universe/renderOrigin.js", import.meta.url), "utf8"))],
  ["validate-astro.mjs", stripComments(readFileSync(new URL("../scripts/validate-astro.mjs", import.meta.url), "utf8"))],
];
for (const [name, code] of scanTargets) {
  assert(!/Math\.random/.test(code), `${name} must not use Math.random (breaks determinism)`);
  assert(!/Date\.now/.test(code), `${name} must not use Date.now (breaks determinism)`);
  assert(!/performance\.now/.test(code), `${name} must not use performance.now (breaks determinism)`);
}
// \b\d+n\b (not the looser [0-9]n\b) so a digit-ending identifier followed by
// an unrelated "n" can't false-positive; only a standalone BigInt literal
// (e.g. "42n") or the BigInt constructor matches.
assert(!/\bBigInt\b|\b\d+n\b/.test(prngCode), "prng.js must not use BigInt (breaks cross-engine 32-bit parity)");

console.log("core smoke passed");
