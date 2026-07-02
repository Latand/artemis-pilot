const glProxy = new Proxy({}, {
  get(target, prop) {
    if (prop === "canvas") return target.canvas;
    if (prop === "VERSION") return 0x1F02;
    if (prop === "SHADING_LANGUAGE_VERSION") return 0x8B8C;
    if (prop === "VENDOR") return 0x1F00;
    if (prop === "RENDERER") return 0x1F01;
    if (prop === "getExtension") return () => null;
    if (prop === "getParameter") return p => {
      if (p === 0x1F02) return "WebGL 2.0";
      if (p === 0x8B8C) return "WebGL GLSL ES 3.00";
      if (p === 0x1F00 || p === 0x1F01) return "smoke";
      return 16;
    };
    if (prop === "getShaderPrecisionFormat") return () => ({ precision: 23, rangeMin: 127, rangeMax: 127 });
    if (prop === "createShader" || prop === "createProgram" || prop === "createBuffer" || prop === "createTexture" ||
        prop === "createFramebuffer" || prop === "createRenderbuffer" || prop === "createVertexArray") return () => ({});
    if (prop === "checkFramebufferStatus") return () => 0x8CD5;
    if (prop === "getProgramParameter" || prop === "getShaderParameter") return () => true;
    if (prop === "getProgramInfoLog" || prop === "getShaderInfoLog") return () => "";
    if (prop === "getAttribLocation") return () => 0;
    if (prop === "getUniformLocation") return () => ({});
    if (prop === "drawingBufferWidth" || prop === "drawingBufferHeight") return 1;
    if (!(prop in target)) target[prop] = () => {};
    return target[prop];
  },
});
function makeCanvas() {
  const canvas = {
    style: {},
    width: 1,
    height: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
    getContext: () => glProxy,
  };
  glProxy.canvas = canvas;
  return canvas;
}

globalThis.window = {
  devicePixelRatio: 1,
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
};
globalThis.document = {
  getElementById: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {}, removeEventListener: () => {} }),
  createElement: () => makeCanvas(),
  createElementNS: () => makeCanvas(),
  addEventListener: () => {},
  body: { appendChild: () => {} },
};
globalThis.location = { search: "" };
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const rel = await import("../src/relTravel.js");
const constants = await import("../src/constants.js");
const state = await import("../src/state.js");
const ephemeris = await import("../src/ephemeris.js");
const autopilot = await import("../src/autopilot.js");

const {
  G_ACCEL_KMS2,
  REL,
  betaAtCoordTime,
  brachistochronePlan,
  brachistochroneSample,
  coordTimeForDistance,
  coordTimeForProperTime,
  distAtCoordTime,
  properTimeAtCoordTime,
  relResetState,
  relTravelStep,
  relTravelToFocus,
} = rel;
const { LY_KM, SEC_YEAR, STARS } = constants;
const { G, resetShip } = state;
const { resetEphem } = ephemeris;
const { targetState } = autopilot;

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? "   " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "   " + detail : ""}`); }
};
const approx = (actual, expected, relTol, label) => {
  const err = Math.abs(actual - expected);
  ok(err <= relTol * Math.abs(expected), label, `got ${actual}`);
};
const hr = (t) => console.log("\n" + "-".repeat(60) + "\n  " + t + "\n" + "-".repeat(60));

hr("4.3 ly 1g brachistochrone gate");
const p = brachistochronePlan(4.3 * LY_KM);
approx(p.properTotal / SEC_YEAR, 3.559, 0.02, "ship proper time ~= 3.559 yr");
approx(p.coordTotal / SEC_YEAR, 5.928, 0.02, "Earth coordinate time ~= 5.928 yr");
approx(p.peakGamma, 3.219, 0.02, "peak gamma ~= 3.219");

hr("Closed-form inverse identities");
for (const t of [1e5, 1e7, 1e8]) {
  approx(coordTimeForDistance(G_ACCEL_KMS2, distAtCoordTime(G_ACCEL_KMS2, t)), t, 1e-9, `distance inverse at t=${t}`);
  approx(coordTimeForProperTime(G_ACCEL_KMS2, properTimeAtCoordTime(G_ACCEL_KMS2, t)), t, 1e-9, `proper-time inverse at t=${t}`);
}

hr("Brachistochrone endpoints");
ok(brachistochroneSample(p, 0).beta === 0, "departure beta is exactly zero");
ok(brachistochroneSample(p, p.T).beta <= 1e-9, "arrival beta is near zero");
approx(brachistochroneSample(p, p.tHalf).gamma, p.peakGamma, 1e-9, "midpoint gamma matches peak gamma");
approx(brachistochroneSample(p, p.T).properElapsed, p.properTotal, 1e-9, "arrival proper elapsed matches plan");

hr("Monotonicity and sub-c samples");
const samples = 64;
let prevBeta = -Infinity, prevDist = -Infinity;
let monotonic = true, subC = true;
for (let i = 0; i <= samples; i++) {
  const s = p.T * i / samples;
  const sample = brachistochroneSample(p, s);
  subC = subC && sample.beta < 1 && betaAtCoordTime(p.a, Math.min(s, p.T - s)) < 1;
  if (i > 0) monotonic = monotonic && sample.distKm > prevDist;
  if (s <= p.tHalf) monotonic = monotonic && sample.beta >= prevBeta;
  else monotonic = monotonic && sample.beta <= prevBeta;
  prevBeta = sample.beta;
  prevDist = sample.distKm;
}
ok(monotonic, "beta rises then falls and distance strictly increases");
ok(subC, "sampled beta remains below c");

hr("27000 ly Sgr A* lore gate");
const sgrA = brachistochronePlan(27000 * LY_KM);
const sgrShipYr = sgrA.properTotal / SEC_YEAR;
const sgrEarthYr = sgrA.coordTotal / SEC_YEAR;
ok(sgrShipYr > 10 && sgrShipYr < 60, "27000 ly ship time is decades", `got ${sgrShipYr}`);
approx(sgrEarthYr, 27002, 0.001, "27000 ly Earth time ~= 27002 yr");

function addSyntheticStar(distanceKm) {
  STARS.push({
    x: distanceKm, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    R: 696000, mu: 1.32712440018e11,
    name: "SMOKE REL TARGET", id: "smoke-rel-target",
  });
  return "star:" + (STARS.length - 1);
}

function resetForTrip(distanceKm) {
  resetEphem();
  resetShip();
  relResetState();
  G.x = 0; G.y = 0; G.z = 0;
  G.vx = 0; G.vy = 0; G.vz = 0;
  G.focus = addSyntheticStar(distanceKm);
  const toasts = [];
  relTravelToFocus(msg => toasts.push(msg));
  ok(REL.active, "relativistic trip starts", toasts[toasts.length - 1] || "");
  return { startTau: G.tau, startCoord: G.t, target: G.focus };
}

function runTrip(steps) {
  const dt = REL.plan.T / steps;
  const peakGamma = REL.plan.peakGamma;
  let midGamma = 1, midBeta = 0;
  const cap = steps * 2;
  for (let i = 0; REL.active && i < cap; i++) {
    relTravelStep(dt);
    if (i === Math.floor(steps / 2) - 1) {
      midGamma = REL.gamma;
      midBeta = REL.beta;
    }
  }
  return { midGamma, midBeta, peakGamma };
}

hr("Stateful loop trip");
const trip = resetForTrip(4.3 * LY_KM);
const loop = runTrip(500);
const targetAfter = targetState(trip.target);
approx((G.tau - trip.startTau) / SEC_YEAR, 3.559, 0.02, "loop ship proper time ~= 3.559 yr");
approx((G.t - trip.startCoord) / SEC_YEAR, 5.928, 0.02, "loop Earth coordinate time ~= 5.928 yr");
ok(Math.hypot(G.x - targetAfter.x, G.y - targetAfter.y, G.z - targetAfter.z) <= 1, "ship snaps to target within 1 km");
ok(REL.active === false, "REL inactive after arrival");
ok(loop.midBeta > 0, "mid-trip beta is positive");
approx(loop.midGamma, loop.peakGamma, 1e-6, "mid-trip gamma matches peak");

hr("Step-size independence");
resetForTrip(4.3 * LY_KM);
const startTauA = G.tau, startCoordA = G.t;
runTrip(250);
const coordA = G.t - startCoordA, tauA = G.tau - startTauA;
resetForTrip(4.3 * LY_KM);
const startTauB = G.tau, startCoordB = G.t;
runTrip(1000);
const coordB = G.t - startCoordB, tauB = G.tau - startTauB;
approx(coordA, coordB, 1e-6, "coordinate delta is step-size invariant");
approx(tauA, tauB, 1e-6, "proper-time delta is step-size invariant");

console.log("\n" + "=".repeat(60));
console.log(`  ${pass} PASSED   ${fail} FAILED   (${pass + fail} checks)`);
console.log("=".repeat(60));
process.exit(fail ? 1 : 0);
