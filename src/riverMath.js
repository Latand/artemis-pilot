import { K } from "./constants.js";

// Pure display-math for the spacetime-river redesign: pulse animation,
// universal respawn distribution, length/color response, universal
// contracting shells, and the relative-frame display blend. GLSL-mirrored
// constants live in RIVER_VIS and scripts/smoke-river-visual.mjs greps
// river.js for the same literals; the JS-side functions (shells, frame) are
// imported by river.js directly — no duplication. No DOM, no three.js: this
// module must stay importable by a bare node smoke.
//
// Design law (owner): one universal rule — at every point space contracts
// toward every mass, superposed (flowField's v = -r̂·C/√r per source; the
// Gullstrand–Painlevé river, Hamilton & Lisle, Am.J.Phys 76, 519 (2008)).
// Everything here makes that field VISIBLE or picks the frame it is drawn
// in — it adds no field components.

export const RIVER_VIS = {
    PULSE_FLOOR: 0.72,       // brightness between pulse bands
    PULSE_AMP: 0.55,         // band amplitude on top of the floor
    PULSE_SEG_K: 0.5,        // phase advance per unit segT (band travels tail→head)
    PULSE_RATE_BASE: 0.55,   // cycles/s of real time at warp <= 1 (the perceptual floor)
    PULSE_RATE_WARP: 1.3,    // extra cycles/s at fully saturated warp ink
    PULSE_WRAP: 64,          // uPhase wraps at an integer so fract() stays continuous
    REACH_LO_FRAC: 0.02,     // respawn reach floor, fraction of uRadius
    REACH_HI_FRAC: 0.22,     // respawn reach cap, fraction of uRadius
    REACH_SOI_MUL: 1.5,      // sources with a defined SOI fill at most 1.5·SOI
    PROF_EXP: 1.6,           // radial spawn profile exponent (was 3.0: too core-hogging)
    BIASED_FRAC: 0.68,       // kept: 68% mass-biased spawns, 32% uniform ambient
    LEN_MIN: 0.25,           // lenSpeedMod range (was 0.6..1.3 — length now encodes speed)
    LEN_MAX: 2.6,
    GOLD_R0: 7.0e4,          // gold tint full inside ~0.47 AU of the Sun
    GOLD_R1: 1.6e5,          // gold gone beyond ~1.07 AU
    SHELL_SINK_MIN: 6,       // shell outer radius at least 6·sink
    SHELL_NOSOI_MUL: 40,     // ...and 40·sink where no SOI is defined
    SHELL_VOL_FRAC: 0.18,    // ...capped so the outer shell stays inside the focused view
                             // (0.18·smoothR ≈ 0.76·cam.dist — camera outside the shell sphere)
    SHELL_DOT_FRAC: 0.006,   // dot size as a fraction of rOut (~5 px at the Jupiter test case)
    SHELL_OPACITY: 0.30,     // peak shell opacity (was a .42 literal — read as fog over planets)
    SHELL_FADE_IN: 0.30,     // fraction of contraction spent fading in (staggers the 4 shells)
    SHELL_VIS_CAMDIST: 24,   // shells drawn only when cam.dist < rOut·24
    FRAME_SHIP_W: 0.85,      // max relative-frame weight in ship focus
    FRAME_EASE: 3,           // frame-weight easing rate, 1/s of real time
};

export const smoothstepJs = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
};

// ---- pulse (P1) ----
export const pulseWave = (ph, phase, kq, segT) => {
    const x = ph + phase * kq + segT * RIVER_VIS.PULSE_SEG_K;
    return x - Math.floor(x);
};
export const pulseBright = wave =>
    RIVER_VIS.PULSE_FLOOR + RIVER_VIS.PULSE_AMP * Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * wave), 3);
export const pulsePhaseRate = timeRate => {
    const warpNorm = Math.min(1, Math.max(0, Math.log2(Math.max(1, timeRate)) / 16));
    return RIVER_VIS.PULSE_RATE_BASE + RIVER_VIS.PULSE_RATE_WARP * warpNorm;
};

// ---- universal respawn (P3): ONE formula for every source; soi = 0 means
// "no sphere of influence defined" (Sun, stars, holes) and leaves the
// volume-fraction cap in charge — no per-body branches anywhere. ----
export function spawnReach(sink, soi, uRadius) {
    const V = RIVER_VIS;
    const lo = uRadius * V.REACH_LO_FRAC;
    const hi = soi > 0 ? Math.min(soi * V.REACH_SOI_MUL, uRadius * V.REACH_HI_FRAC) : uRadius * V.REACH_HI_FRAC;
    return Math.min(Math.max(sink * 30, lo), Math.max(hi, sink * 2));
}
export const pickWeight = c => Math.sqrt(Math.max(0, c));

// ---- streak length (P4) ----
export const lenSpeedMod = tVis =>
    RIVER_VIS.LEN_MIN + (RIVER_VIS.LEN_MAX - RIVER_VIS.LEN_MIN) * Math.pow(tVis, 0.6);

// ---- color (P5) ----
export const goldNearSunFade = dSun => 1 - smoothstepJs(RIVER_VIS.GOLD_R0, RIVER_VIS.GOLD_R1, dSun);

// ---- universal contracting shells (P2-A): the law itself, dr/dt = -C/√r,
// instantiated around whichever source locally dominates. ----
export const shellStep = (r, C, sink, dtSim) =>
    r - (C / Math.sqrt(Math.max(sink, r))) * dtSim;
export const shellOuterRadius = (sink, soi, volR) =>
    Math.min(Math.max(sink * RIVER_VIS.SHELL_SINK_MIN, soi > 0 ? soi : sink * RIVER_VIS.SHELL_NOSOI_MUL), volR * RIVER_VIS.SHELL_VOL_FRAC);

// ---- relative-frame display (P2-C): v_display = v_field − v_frame near the
// focus body/ship. A frame choice over the SAME field — "тебе уносить". ----
export const frameBlendW = localFocus => localFocus * localFocus;
export const shipFrameW = planeBias => RIVER_VIS.FRAME_SHIP_W * (1 - planeBias);
// ephemeris km/s (x, y, z-north) → scene units/s (X = x·K, Y = z·K, Z = −y·K);
// the SAME axis mapping main.js applies to positions (main.js:1517).
export function frameVelToScene(vx, vy, vz, out3) {
    out3[0] = vx * K; out3[1] = vz * K; out3[2] = -vy * K;
    return out3;
}
