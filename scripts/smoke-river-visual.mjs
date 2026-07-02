import { readFileSync } from "node:fs";

globalThis.window = {};   // state.js expects a window handle (same shim as smoke-core.mjs)

const { keplerInit3 } = await import("../src/ephemeris.js");
const { FLOW, PL, K, MU_S, SUN_RADIUS, SOI_E, SOI_M, R_EARTH, R_MOON } = await import("../src/constants.js");
const rm = await import("../src/riverMath.js");
const V = rm.RIVER_VIS;

function assert(ok, message, ctx) {
  if (!ok) throw new Error(message + (ctx ? " " + JSON.stringify(ctx) : ""));
}

// 1) pulse: floor > 0 at warp 0, bounded, pinned shape, travels tail→head
let minB = Infinity, maxB = -Infinity, sumB = 0;
for (let i = 0; i < 512; i++) {
  const b = rm.pulseBright(i / 512);
  minB = Math.min(minB, b); maxB = Math.max(maxB, b); sumB += b;
}
assert(minB >= V.PULSE_FLOOR - 1e-9 && minB > 0.7, "pulse floor broken", { minB });
assert(maxB <= V.PULSE_FLOOR + V.PULSE_AMP + 1e-9, "pulse max broken", { maxB });
assert(Math.abs(sumB / 512 - (V.PULSE_FLOOR + V.PULSE_AMP * 0.3125)) < 0.01, "pulse mean drifted", { mean: sumB / 512 });
assert(rm.pulsePhaseRate(1) === V.PULSE_RATE_BASE, "pulse rate floor at warp<=1 must be exactly base");
assert(rm.pulsePhaseRate(1e9) > V.PULSE_RATE_BASE, "pulse must speed up with warp");
// tail→head: brightness is a function of (phase·kq + segT·PULSE_SEG_K), so the
// band position moves toward segT=0 (the head, with the flow) as phase grows
for (const [phi, s, d] of [[0.1, 0.8, 0.05], [0.7, 0.5, 0.11], [3.2, 0.9, 0.2]]) {
  const a = rm.pulseWave(0.3, phi, 1, s);
  const b = rm.pulseWave(0.3, phi + d, 1, s - d / V.PULSE_SEG_K);
  assert(Math.abs(a - b) < 1e-9 || Math.abs(Math.abs(a - b) - 1) < 1e-9,
    "pulse band must travel tail->head", { a, b });
}

// 2) universal respawn reach: ONE formula, checked over every body and zoom
const bodies = [
  { name: "EARTH", sink: R_EARTH * K + 0.6, soi: SOI_E * K },
  { name: "MOON", sink: R_MOON * K + 0.5, soi: SOI_M * K },
  { name: "SUN", sink: SUN_RADIUS * 1.08, soi: 0 },
  ...PL.map(p => ({ name: p.name, sink: p.R * K, soi: p.soi * K })),
];
for (const uR of [1e4, 1e5, 1e6, 6e6, 1.2e8]) {
  for (const b of bodies) {
    const reach = rm.spawnReach(b.sink, b.soi, uR);
    const hiCap = b.soi > 0 ? Math.max(b.soi * V.REACH_SOI_MUL, b.sink * 2) : Math.max(uR * V.REACH_HI_FRAC, b.sink * 2);
    assert(reach <= hiCap + 1e-9, "reach exceeds cap for " + b.name + " at uRadius " + uR, { reach, hiCap });
    assert(reach > b.sink * 1.2, "reach must clear the sink for " + b.name, { reach, sink: b.sink });
  }
}
// pinned emergent values at survey zoom (uRadius = 6e6)
assert(Math.abs(rm.spawnReach(SUN_RADIUS * 1.08, 0, 6e6) - 6e6 * V.REACH_LO_FRAC) < 1e-9,
  "Sun (no SOI) must spread over the lo floor at survey zoom");
const sat = bodies.find(b => b.name === "SATURN");
assert(Math.abs(rm.spawnReach(sat.sink, sat.soi, 6e6) - sat.soi * V.REACH_SOI_MUL) < 1e-6,
  "Saturn halo must hug exactly 1.5·SOI at survey zoom");

// 3) pick-weight share table (sqrt weighting)
const cs = [FLOW.CE, FLOW.CM, FLOW.CS, ...PL.map(p => 0.001 * Math.sqrt(2 * p.mu / 1000))];
const ws = cs.map(rm.pickWeight);
const tot = ws.reduce((a, b) => a + b, 0);
const share = i => ws[i] / tot;
assert(share(2) > 0.55 && share(2) < 0.68, "Sun share out of band", { sun: share(2) });
assert(share(3 + 3) > 0.09, "Jupiter share too small", { jup: share(3 + 3) });
assert(share(3 + 4) > 0.06, "Saturn share too small", { sat: share(3 + 4) });
console.log("shares: sun=" + share(2).toFixed(3) + " jup=" + share(3 + 3).toFixed(3) + " sat=" + share(3 + 4).toFixed(3));

// 4) length dynamic range
assert(rm.lenSpeedMod(0) === V.LEN_MIN && rm.lenSpeedMod(1) === V.LEN_MAX, "lenSpeedMod range");

// 5) universal shells: contraction speed IS the law's v = C/√r, monotone
for (const [r, C, sink] of [[100, 0.0282, 7], [5000, 16.29, 752], [50, 0.00313, 2.2]]) {
  const r2 = rm.shellStep(r, C, sink, 1);
  assert(Math.abs((r - r2) - C / Math.sqrt(r)) < 1e-12, "shellStep speed != C/sqrt(r)", { r, C });
  assert(r2 < r, "shells must contract", { r, r2 });
}
// outer radius: >= 6·sink, <= volR/2, equals SOI when SOI is inside those bounds
assert(rm.shellOuterRadius(7, 924, 1e6) === 924, "shell rOut should sit at the SOI when defined");
assert(rm.shellOuterRadius(752, 0, 1e6) === 752 * V.SHELL_NOSOI_MUL, "no-SOI rOut = 40·sink");
assert(rm.shellOuterRadius(7, 924, 100) === 50, "rOut capped at half the volume radius");
assert(rm.shellOuterRadius(1000, 100, 1e9) === 6000, "rOut floored at 6·sink");

// 6) relative-frame blend + velocity-mapping handedness
assert(rm.frameBlendW(0) === 0 && rm.frameBlendW(1) === 1, "frameBlendW endpoints");
assert(rm.frameBlendW(0.5) < 0.5, "frameBlendW must ease in (quadratic)");
assert(rm.shipFrameW(1) === 0, "ship frame must vanish at survey zoom (planeBias=1)");
assert(Math.abs(rm.shipFrameW(0) - V.FRAME_SHIP_W) < 1e-12, "ship frame max weight");
// velocity mapping sign proof: a planet's scene-mapped velocity must be
// prograde — positive along tangent (d.z, 0, -d.x) from its scene offset.
// keplerInit velocity is CCW in ecliptic x,y (vt = c(1+e·cosν) > 0,
// ephemeris.js:88-94); scene maps (x,y,z)→(x·K, z·K, −y·K). If frameVelToScene
// used +vy the dot flips negative and this fails.
const st = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
const v3 = [0, 0, 0];
for (const p of PL) {
  for (const M0 of [0, 1.5, 3.0, 4.6]) {
    keplerInit3(p.a, p.e, p.i, p.Om, p.varpi, M0, MU_S, st);
    const dx = st.x * K, dz = -st.y * K;                 // scene offset from Sun
    rm.frameVelToScene(st.vx, st.vy, st.vz, v3);         // scene velocity
    const tl = Math.hypot(dx, dz);
    const dot = ((dz / tl) * v3[0] + (-dx / tl) * v3[2]) / Math.hypot(v3[0], v3[2]);
    assert(dot > 0.9, "scene velocity mapping not prograde at " + p.name + " M0=" + M0, { dot });
  }
}

// 7) universal-law guard: the compute-pass spawn block must contain NO
// per-body index special cases — only uniform data (uSoi) may differentiate
const src = readFileSync(new URL("../src/river.js", import.meta.url), "utf8");
const computeFrag = src.slice(src.indexOf("const COMPUTE_FRAG"), src.indexOf("const LINE_VERT"));
assert(computeFrag.length > 100, "COMPUTE_FRAG extraction failed");
assert(!computeFrag.includes("chosen == 2") && !computeFrag.includes("chosen==2"),
  "spawn rule must stay universal: no Sun index special case in COMPUTE_FRAG");

// 8) GLSL <-> JS literal sync (entries appended by WP-R2..R6)
const GLSL_SYNC = [
  // WP-R2..R6 append exact literals here
  "float wave = fract(ph + uPhase * kq + segT * 0.5)",
  "0.72 + 0.55 * pow(0.5 + 0.5 * cos(6.2831853 * wave), 3.0)",
  "totalW += sqrt(max(uBody[i].w, 0.0))",
  "float lo = uRadius * 0.02",
  "uSoi[chosen] > 0.0 ? min(uSoi[chosen] * 1.5, uRadius * 0.22) : uRadius * 0.22",
  "min(max(sink * 30.0, lo), max(hi, sink * 2.0))",
  "pow(h3, 1.6)",
  "mix(0.25, 2.6, pow(tVis, 0.6))",
  "mix(uRadius * 0.045, uRadius * 0.018, uLocalFocus)",
  "(1.0 - smoothstep(7.0e4, 1.6e5, dSun))",
  "float bandMul = i == 2 ? 3.0 : 1.0",
];
for (const lit of GLSL_SYNC) {
  assert(src.includes(lit), "river.js GLSL out of sync with riverMath, missing literal: " + lit);
}

console.log("river visual smoke passed (" + GLSL_SYNC.length + " sync literals)");
