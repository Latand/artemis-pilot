import * as THREE from "three";
import { BH_MAX, C_LIGHT, DARK_ENERGY, FLOW, LY_SCENE, MU_E, MU_M, MU_S, PL, K, R_EARTH, R_MOON, SOI_E, SOI_M, SUN_RADIUS } from "./constants.js";
import { G, BH, WORLD } from "./state.js";
import { mulberry32, smooth01 } from "./format.js";
import { dotTexture } from "./textures.js";
import { scene, renderer, camera, cam, renderQuality } from "./scene.js";
import { ACTIVE_STARS } from "./universe/activeStars.js";
import { flowCtx } from "./flowfield.js";
import { PERF, markPerf } from "./perf.js";
import { pulsePhaseRate, shellStep, shellOuterRadius, shellDotSize, frameBlendW, shipFrameW, frameVelToScene, RIVER_VIS } from "./riverMath.js";
import { eph } from "./ephemeris.js";

// GPU river: one particle volume that follows the camera at solar-system scale.
// Positions live in a float texture advected by a compute pass; the analytic
// flow field v(r) = sum(-rhat * C_i / sqrt(r_i)) matches flowfield.js.
// Streaks are drawn as SEGS connected line segments instead of one straight
// extrapolation, so they can bend along the local field ("дужки" — curved
// arcs per the redesign brief). Fixed at init per quality tier (not adjusted
// live) since vertex count is baked into the geometry; mobile/VR keeps the
// cheaper single straight segment.
//
// Deep-time / float32 precision: the GPU position texture and every uniform
// are float32, but a warped ship can sit at scene coordinates many orders of
// magnitude beyond float32's ~7-digit precision (e.g. after tens of Gyr of
// dark-energy expansion). So nothing scene-absolute ever reaches the GPU:
// every position (bodies, camera, the dark-energy origin, the particles
// themselves) is expressed relative to `smoothCenter`, a float64 JS number
// that tracks the camera and is subtracted on the CPU before upload. Because
// `smoothCenter` itself moves every frame, the persistent particle-position
// texture is re-based each frame by `uCenterShift` (this frame's center minus
// last frame's, computed in float64) so stored positions keep meaning across
// frames instead of drifting. See WP22 deep-time fix.
const SEGS = renderQuality.mobile ? 1 : 2;
// Desktop's default particle count is traded down (176 -> 124, ~1/sqrt(2))
// so total line-vertex-shader work (particles * VPP, each vertex running the
// same per-source color loop) stays roughly at parity with the pre-redesign
// single-segment baseline instead of ~doubling it — measured on a loaded
// headless run: unadjusted this cost went from a ~15% river frame-time hit
// to ~27%; with the trade it's back near the original. `np=` still overrides.
const TEXW = (() => {
    const m = location.search.match(/np=(\d+)/);
    const v = m ? +m[1] : renderQuality.mobile ? 136 : 124;
    return Math.min(1024, Math.max(64, v));
})();
const NPART = TEXW * TEXW;
const RIVER_QUALITY_TEXW = renderQuality.mobile ? 136 : 124;
const RIVER_DENSITY_GAIN = Math.min(1.12, Math.sqrt(RIVER_QUALITY_TEXW / TEXW));
const VPP = SEGS * 2; // vertices per particle (SEGS segments × 2 endpoints)
const RIVER_STAR_SOURCE_MAX = 24;
const RIVER_STAR_SOURCE_START_R = LY_SCENE * 0.01;
const MAXB = 3 + PL.length + BH_MAX + RIVER_STAR_SOURCE_MAX;

export const river = {
    enabled: false,
    radius: 22,
    count: NPART,
    drawCount: NPART,
    computeEvery: 1,
    skippedCompute: false,
    renderShed: 0,
    sourceCount: 0,
    starSources: 0,
    starRefreshed: false,
    sinkSources: 0,
    texW: TEXW,
    frame: 0,
    dtAccum: 0,
    computeMs: 0,
    computeEveryAdaptive: 1,
    vRefRefreshed: false,
    vRefCadence: 1,
};
if (typeof window !== "undefined") window.__river = river;

let rtA, rtB, computeScene, computeCam, computeMat, lineMat, lines;
const bodyVals = [], sinkVals = new Array(MAXB).fill(0), rsVals = new Array(MAXB).fill(0), holeVals = new Array(MAXB).fill(0), soiVals = new Array(MAXB).fill(0);
const colorVals = [];
for (let i = 0; i < MAXB; i++) bodyVals.push(new THREE.Vector4());
for (let i = 0; i < MAXB; i++) colorVals.push(new THREE.Vector3(0.32, 0.58, 0.9));
const colorTmp = new THREE.Color();
const plColors = PL.map(p => new THREE.Color(p.color));
const C2 = C_LIGHT * C_LIGHT;
const rsScene = mu => 2 * mu / C2 * K;
const uniformsShared = {
    uPos: { value: null },
    uDtSim: { value: 0 },
    uCenterShift: { value: new THREE.Vector3() },
    uOrigin: { value: new THREE.Vector3() },
    uRadius: { value: 22 },
    uCam: { value: new THREE.Vector3() },
    uTick: { value: 0 },
    uRespawn: { value: 1 },
    uNB: { value: 10 },
    uSinkNB: { value: 10 },
    uBody: { value: bodyVals },
    uSink: { value: sinkVals },
    uRs: { value: rsVals },
    uHole: { value: holeVals },
    uColor: { value: colorVals },
    uVRef: { value: .01 },
    uOpacity: { value: 0 },
    uDE: { value: 0 },
    uPlaneBias: { value: 0 },
    uTimeRate: { value: 1 },
    uLoadShed: { value: 0 },
    uLocalFocus: { value: 0 },
    uSegs: { value: SEGS },
    uPhase: { value: 0 },
    uSoi: { value: soiVals },
    uFrameVel: { value: new THREE.Vector3() },
    uFrameW: { value: 0 },
};

const FLOW_GLSL = /* glsl */`
uniform int uNB;
uniform int uSinkNB;
uniform vec4 uBody[${MAXB}];
uniform float uSink[${MAXB}];
uniform float uRs[${MAXB}];
uniform float uHole[${MAXB}];
uniform vec3 uColor[${MAXB}];
uniform float uRadius;
uniform vec3 uOrigin;
uniform float uDE;
uniform float uPlaneBias;
uniform float uTimeRate;
uniform float uLoadShed;
uniform float uLocalFocus;
uniform float uSoi[${MAXB}];
uniform vec3 uFrameVel;
uniform float uFrameW;
float sourceCore(float sink, float isHole) {
    // Tiny holes get a display core so their local flow direction stays visible.
    float visualBH = min(max(uRadius * 0.0008, 0.45), 64.0);
    return mix(sink, max(sink, visualBH), isHole);
}
float sourceSoft(float sink, float isHole) {
    float core = sourceCore(sink, isHole);
    return mix(sink * 0.5, max(sink * 0.5, core * 0.35), isHole);
}
vec3 flowField(vec3 p) {
    vec3 v = vec3(0.0);
    vec3 pull = vec3(0.0);
    for (int i = 0; i < ${MAXB}; i++) {
        if (i >= uNB) break;
        vec3 d = p - uBody[i].xyz;
        float rSoft = sourceSoft(uSink[i], uHole[i]);
        float r = max(rSoft, length(d));
        float invR = 1.0 / r;
        float s = uBody[i].w * inversesqrt(r) / r;
        v += -d * s;
        pull += -d * (uBody[i].w * uBody[i].w) * invR * invR * invR;
    }
    vec3 de = (p - uOrigin) * uDE;
    vec3 raw = v + de;
    float rawLen = length(raw);
    float pullLen = length(pull);
    if (rawLen < 1e-12 || pullLen < 1e-18) return raw - uFrameVel * uFrameW;
    float deShare = length(de) / max(rawLen, 1e-12);
    float deInk = smoothstep(0.45, 0.92, deShare);
    // Relative-frame display: near the focus body/ship the same field is
    // drawn (and advected) in that body's rest frame — an exact boost of the
    // universal contraction field, giving the "carried by the current"
    // reading without adding any field component. uFrameW is 0 at survey
    // zoom, so the wide view stays the Sun-frame river.
    return mix(normalize(pull) * rawLen, raw, deInk) - uFrameVel * uFrameW;
}
float hash13(vec3 p3) {
    p3 = fract(p3 * .1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}`;

const COMPUTE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uPos;
uniform float uDtSim, uTick, uRespawn;
uniform vec3 uCam;
uniform vec3 uCenterShift;
varying vec2 vUv;
${FLOW_GLSL}
void main() {
    // Positions are stored relative to the river's own float64 center
    // (see uCenterShift's declaration site in river.js), never in absolute
    // scene coordinates, so they stay small — and float32-precise — no
    // matter how far that center has drifted in world space. The center
    // itself moves every frame (it tracks the camera), so before reusing
    // last frame's stored position it is re-expressed relative to THIS
    // frame's center by subtracting the frame-to-frame shift (computed in
    // float64 on the CPU, where large-magnitude drift is lossless).
    vec3 p = texture2D(uPos, vUv).xyz - uCenterShift;
    vec3 v = flowField(p);
    vec3 stp = v * uDtSim;
    float sl = length(stp);
    float cap = uRadius * 0.05;
    if (sl > cap) stp *= cap / sl;
    p += stp;
    bool kill = hash13(vec3(vUv * 719.3, uTick + 9.7)) < uRespawn;
    if (length(p) > uRadius * 1.04) kill = true;
    for (int i = 0; i < ${MAXB}; i++) {
        if (i >= uSinkNB) break;
        float sink = sourceCore(uSink[i], uHole[i]);
        if (distance(p, uBody[i].xyz) < sink) { kill = true; break; }
    }
    if (hash13(vec3(vUv * 913.7, uTick)) < 0.002) kill = true;
    if (kill) {
        float h1 = hash13(vec3(vUv * 127.1, uTick + 0.17));
        float h2 = hash13(vec3(vUv * 311.7, uTick + 1.31));
        float h3 = hash13(vec3(vUv * 74.7, uTick + 2.07));
        float h4 = hash13(vec3(vUv * 601.1, uTick + 3.3));
        float th = 6.2831853 * h2;
        float yy = h1 * 2.0 - 1.0;
        float rr = sqrt(max(0.0, 1.0 - yy * yy));
        // Bias most respawns toward a mass-weighted gravity well instead of
        // spreading uniformly through the whole volume, so particle DENSITY
        // concentrates where there's something to fall toward — the reported
        // "activity looks weak near masses" bug (the old uniform-in-volume
        // spawn plus fast infall near strong sources left them depleted).
        // sqrt-weighted pick: linear C let the Sun hog ~94% of biased spawns
        // (starved halos, empty inter-orbit space); sqrt gives ~62/11/8% for
        // Sun/Jupiter/Saturn (see riverMath pickWeight + the smoke's table).
        float totalW = 0.0;
        for (int i = 0; i < ${MAXB}; i++) {
            if (i >= uSinkNB) break;
            totalW += sqrt(max(uBody[i].w, 0.0));
        }
        int chosen = -1;
        if (totalW > 1e-6 && h4 < 0.68) {
            float pick = hash13(vec3(vUv * 811.3, uTick + 4.7)) * totalW;
            float acc = 0.0;
            for (int i = 0; i < ${MAXB}; i++) {
                if (i >= uSinkNB) break;
                acc += sqrt(max(uBody[i].w, 0.0));
                if (pick <= acc) { chosen = i; break; }
            }
        }
        if (chosen >= 0) {
            float sink = sourceCore(uSink[chosen], uHole[chosen]);
            // Universal halo rule (one formula, every source): fill at most
            // 1.5x the source's sphere of influence where one is defined
            // (uSoi > 0); where none is (Sun, stars, holes: uSoi = 0) the
            // volume-fraction cap governs. min/max instead of clamp: the lo
            // floor can exceed the SOI cap at survey zoom, and GLSL clamp is
            // undefined for minVal > maxVal.
            float lo = uRadius * 0.02;
            float hi = uSoi[chosen] > 0.0 ? min(uSoi[chosen] * 1.5, uRadius * 0.22) : uRadius * 0.22;
            float reach = min(max(sink * 30.0, lo), max(hi, sink * 2.0));
            float rad = sink * 1.2 + max(reach - sink * 1.2, 0.0) * pow(h3, 1.6);
            p = uBody[chosen].xyz + vec3(cos(th) * rr, yy, sin(th) * rr) * rad;
        } else {
            float rad = uRadius * pow(h3, 0.3333333);
            p = vec3(cos(th) * rr, yy, sin(th) * rr) * rad;
        }
        // never spawn inside a sink: push out radially
        for (int i = 0; i < ${MAXB}; i++) {
            if (i >= uSinkNB) break;
            vec3 d = p - uBody[i].xyz;
            float r = length(d);
            float sink = sourceCore(uSink[i], uHole[i]);
            if (r < sink * 1.15)
                p = uBody[i].xyz + d / max(r, 1e-6) * (sink * (1.2 + 2.0 * h2));
        }
    }
    gl_FragColor = vec4(p, 1.0);
}`;

const LINE_VERT = /* glsl */`
uniform sampler2D uPos;
uniform float uVRef, uOpacity, uPhase;
uniform vec3 uCam;
uniform int uSegs;
attribute vec2 ref;
attribute float aSeg;
varying vec3 vColor;
${FLOW_GLSL}
void main() {
    vec3 p = texture2D(uPos, ref).xyz;
    vec3 v = flowField(p);
    float spd = max(length(v), 1e-12);
    vec3 vDir = v / spd;
    float rel = spd / max(uVRef, 1e-9);
    float t = clamp(log2(1.0 + rel) * 0.72, 0.0, 1.0);
    float warpInk = clamp(log2(max(uTimeRate, 1.0)) / 16.0, 0.0, 1.0);
    float timeInk = smoothstep(0.0, 1.0, log2(max(uTimeRate, 1.0)) / 13.0);
    float visibleTime = max(timeInk, max(uLocalFocus * 0.58, 0.18));
    float tVis = smoothstep(mix(0.004, 0.0015, uPlaneBias), mix(0.20, 0.09, uPlaneBias), t);
    float loadTrim = mix(1.0, 0.46, uLoadShed);
    float timeTrim = mix(0.32, 1.0, visibleTime);
    // Streak length is now normalized by distance-to-CAMERA, not by uRadius
    // (the river's local view radius, which grows with camera zoom-out) — a
    // streak's projected on-screen length stays roughly constant instead of
    // exploding into long straight streaks whenever the view is far from any
    // mass (the reported bug; that scaling made a cosmic-scale dark-energy
    // flow, whose absolute speed grows with r, draw enormous raw lengths).
    // Relative flow speed (tVis) now mostly modulates BRIGHTNESS further
    // below rather than raw length.
    float camDist = max(distance(p, uCam), 1e-4);
    float lenSpeedMod = mix(0.25, 2.6, pow(tVis, 0.6));
    float minL = camDist * 0.0006;
    float maxL = camDist * 0.028 * loadTrim * timeTrim;
    float L = clamp(camDist * 0.01 * mix(0.5, 1.6, warpInk) * loadTrim * timeTrim * lenSpeedMod, minL, maxL);
    // fades: volume edge, camera proximity, sink proximity
    // (p is already relative to the river's own center — see uCenterShift)
    float fade = clamp(1.0 - (length(p) - uRadius * 0.52) / (uRadius * 0.48), 0.0, 1.0);
    float camBlind = mix(uRadius * 0.045, uRadius * 0.018, uLocalFocus);
    float camFadeBand = mix(uRadius * 0.30, uRadius * 0.16, uLocalFocus);
    fade *= clamp((distance(p, uCam) - camBlind) / max(1e-6, camFadeBand), 0.0, 1.0);
    fade *= 0.55 + 0.45 * hash13(vec3(ref * 53.7, 7.77)); // per-streak variety
    // golden when the Sun's river dominates locally, violet when expansion wins
    float dSun = distance(p, uBody[2].xyz);
    float sunPart = uBody[2].w * inversesqrt(max(uSink[2] * 0.5, dSun));
    // gold = Sun-dominated infall as palette language, confined to the inner
    // system (full inside ~0.47 AU, gone by ~1.07 AU): at survey scale
    // sunPart dominates the whole field and painted everything gold ("the
    // Sun is on fire"); outside, the neutral blue field color takes over
    float gold = smoothstep(0.5, 0.95, clamp(sunPart / spd, 0.0, 1.0)) * (1.0 - smoothstep(7.0e4, 1.6e5, dSun));
    float expPart = length((p - uOrigin) * uDE);
    // only tint where expansion truly dominates the local flow — with the
    // Earth-centered origin a loose threshold painted the whole 1 AU shell
    float violet = smoothstep(0.62, 0.97, clamp(expPart / spd, 0.0, 1.0));
    float curv = 0.0;
    float holePart = 0.0;
    float localPull = 0.0;
    float localBest = 0.0;
    float localFunnel = 0.0;
    float holeCrowd = 0.0;
    float holeHalo = 0.0;
    vec3 localColor = vec3(0.32, 0.58, 0.9);
    for (int i = 0; i < ${MAXB}; i++) {
        if (i >= uNB) break;
        float dSrc = distance(p, uBody[i].xyz);
        float bhCore = sourceCore(uSink[i], uHole[i]);
        float bandMul = i == 2 ? 3.0 : 1.0;
        float surfaceBand = mix((uSink[i] * 1.5 + uRadius * 0.02) * bandMul, max(uRadius * 0.035, uSink[i] * 0.055), uLocalFocus);
        float regularSinkFade = clamp((dSrc - uSink[i]) / max(1e-6, surfaceBand), 0.0, 1.0);
        float bhSinkFade = smoothstep(bhCore * 0.9, max(bhCore * 9.0, uRadius * 0.13), dSrc);
        fade *= mix(regularSinkFade, bhSinkFade, uHole[i]);
        curv += uRs[i] / max(uSink[i], dSrc);
        float gSrc = (uBody[i].w * uBody[i].w) / max(uSink[i] * uSink[i], dSrc * dSrc);
        localPull += gSrc;
        if (i != 2 && uHole[i] < 0.5 && gSrc > localBest) {
            localBest = gSrc;
            localColor = uColor[i];
        }
        if (i != 2 && uHole[i] < 0.5) {
            vec3 toBody = uBody[i].xyz - p;
            float nearReach = max(uSink[i] * 18.0, uRadius * 0.16);
            float nearBody = 1.0 - smoothstep(uSink[i] * 1.25, nearReach, dSrc);
            float align = dot(vDir, toBody / max(dSrc, 1e-6));
            float inward = smoothstep(0.22, 0.92, align);
            localFunnel = max(localFunnel, nearBody * inward);
        }
        if (uHole[i] > 0.5) {
            float rBH = max(bhCore * 0.42, dSrc);
            holePart = max(holePart, uBody[i].w * inversesqrt(rBH));
            float outer = max(bhCore * 18.0, uRadius * 0.30);
            holeCrowd = max(holeCrowd, 1.0 - smoothstep(bhCore * 1.0, max(bhCore * 8.0, uRadius * 0.08), dSrc));
            holeHalo = max(holeHalo, smoothstep(bhCore * 1.5, max(bhCore * 8.0, uRadius * 0.08), dSrc) * (1.0 - smoothstep(outer * 0.42, outer, dSrc)));
        }
    }
    float lapseInk = smoothstep(0.000001, 0.08, curv);
    float localInk = max(smoothstep(0.08, 0.42, localBest / max(localPull, 1e-18)), localFunnel * 0.82);
    float holeInk = smoothstep(0.08, 0.92, clamp(holePart / spd, 0.0, 1.0));
    float localViewInk = max(localInk, uLocalFocus * mix(0.20, 0.46, timeInk));
    tVis = max(max(tVis, holeInk * 0.62), max(localInk * 0.86, uLocalFocus * 0.22));
    // near-source emphasis still lengthens the streak a bit, but re-clamped
    // to the same camera-distance-relative bounds so it can't run away back
    // into the old "explodes with scale" failure mode
    L = clamp(L * mix(1.0, 2.2, localViewInk) * mix(1.0, 0.55, lapseInk) * mix(1.0, 0.55, holeInk), minL, maxL * 1.6);
    // Walk the arc backward from the head, SEGS short legs, resampling the
    // flow direction at each leg's start — a low-order streamline integrator
    // (Heun/midpoint-style) so multi-segment streaks visibly bend along the
    // field instead of extrapolating one straight line from the head's
    // instantaneous direction ("дужки" per the redesign brief). Every vertex
    // independently re-walks from the head up to its own segment index since
    // vertex shader invocations can't share state.
    int segIdx = int(aSeg + 0.5);
    vec3 cur = p;
    vec3 dir = vDir;
    float stepLen = L / float(uSegs);
    for (int s = 0; s < 2; s++) {
        if (s >= segIdx) break;
        cur -= dir * stepLen;
        if (s + 1 < uSegs) {
            vec3 vv = flowField(cur);
            float vvLen = length(vv);
            if (vvLen > 1e-9) dir = vv / vvLen;
        }
    }
    vec3 pos = cur;
    float segT = float(segIdx) / float(uSegs);
    // Brightness band traveling tail→head along each streak (with the flow,
    // toward the sink) at a rate floored in REAL elapsed time (uPhase is fed
    // from dtReal in updateRiver), so the contraction direction stays visible
    // even at warp 0 where the field itself barely moves. Per-particle hash
    // offset ph kills global strobing; kq gives faster streaks integer-
    // multiple pulse rates (integer so fract() stays continuous when uPhase
    // wraps at 64).
    float ph = hash13(vec3(ref * 91.7, 3.1));
    float kq = 1.0 + floor(2.9 * clamp(tVis + ph * 0.34, 0.0, 0.999));
    float wave = fract(ph + uPhase * kq + segT * 0.5);
    float pulse = 0.72 + 0.55 * pow(0.5 + 0.5 * cos(6.2831853 * wave), 3.0);
    vec3 cBlue = vec3(0.16 + 0.5 * t, 0.4 + 0.45 * t, 0.6 + 0.4 * t);
    vec3 cHole = vec3(0.14 + 0.42 * t, 0.62 + 0.30 * t, 1.0);
    vec3 cGold = vec3(0.6 + 0.4 * t, 0.34 + 0.42 * t, 0.12 + 0.26 * t);
    vec3 cViolet = vec3(0.38 + 0.3 * t, 0.22 + 0.26 * t, 0.85 + 0.15 * t);
    float fieldInk = max(pow(tVis, mix(0.85, 0.48, uPlaneBias)), uPlaneBias * 0.18) * mix(0.82, 1.35, warpInk) * (1.0 + lapseInk * 0.55 + holeInk * 0.62 + holeHalo * 1.2 + localViewInk * mix(1.15, 0.8, uLocalFocus));
    fieldInk *= mix(1.0, 0.48, holeCrowd);
    fieldInk = max(fieldInk, uLocalFocus * localInk * 0.72);
    vec3 fieldColor = mix(mix(cBlue, cGold, gold), cViolet, violet);
    vec3 localBright = max(localColor * 1.22, vec3(0.30, 0.34, 0.40));
    fieldColor = mix(fieldColor, localBright, localInk * 0.74);
    fieldColor = mix(fieldColor, cHole, holeInk);
    // comet-tail fade: bright head, nonlinear falloff to a faint tail (a
    // steeper, smoother gradient than the old linear head/tail mix)
    float cometFade = mix(0.94, 0.08, pow(segT, 0.8));
    vColor = fieldColor * fade * fieldInk * (1.0 + localInk * mix(1.7, 1.0, uLocalFocus) + uLocalFocus * 0.4) * mix(0.85, 1.24, tVis) * cometFade * uOpacity * mix(1.0, 0.74, uLoadShed) * mix(0.46, 1.0, visibleTime) * pulse;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}`;

const LINE_FRAG = /* glsl */`
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

export function initRiver() {
    if (location.search.includes("river=0")) return;
    if (!renderer.capabilities.isWebGL2 || !renderer.extensions.get("EXT_color_buffer_float")) {
        console.warn("river: float render targets unavailable, GPU flow disabled");
        return;
    }
    const opts = {
        type: THREE.FloatType, format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: false, stencilBuffer: false,
    };
    rtA = new THREE.WebGLRenderTarget(TEXW, TEXW, opts);
    rtB = new THREE.WebGLRenderTarget(TEXW, TEXW, opts);
    // seed texture: random volume, replaced on the first forced respawn anyway
    const seed = new Float32Array(NPART * 4);
    const rnd = mulberry32(20260612);
    for (let i = 0; i < NPART; i++) {
        const th = rnd() * Math.PI * 2;
        const y = rnd() * 2 - 1;
        const rr = Math.sqrt(Math.max(0, 1 - y * y));
        const r = 22 * Math.cbrt(rnd());
        seed[i * 4] = r * rr * Math.cos(th);
        seed[i * 4 + 1] = r * y;
        seed[i * 4 + 2] = r * rr * Math.sin(th);
        seed[i * 4 + 3] = 1;
    }
    const seedTex = new THREE.DataTexture(seed, TEXW, TEXW, THREE.RGBAFormat, THREE.FloatType);
    seedTex.needsUpdate = true;
    uniformsShared.uPos.value = seedTex;

    computeScene = new THREE.Scene();
    computeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    computeMat = new THREE.ShaderMaterial({
        uniforms: uniformsShared,
        vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }",
        fragmentShader: COMPUTE_FRAG,
        depthTest: false, depthWrite: false,
    });
    computeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), computeMat));

    // SEGS connected legs per particle = SEGS line segments = VPP vertices,
    // laid out as consecutive endpoint pairs (0,1),(1,2)...(SEGS-1,SEGS) so
    // LineSegments draws a connected (bent, when SEGS>1) arc per particle.
    const refs = new Float32Array(NPART * VPP * 2);
    const segs = new Float32Array(NPART * VPP);
    for (let i = 0; i < NPART; i++) {
        const u = ((i % TEXW) + .5) / TEXW, v = (Math.floor(i / TEXW) + .5) / TEXW;
        for (let s = 0; s < SEGS; s++) {
            const base = i * VPP + s * 2;
            refs[base * 2] = u; refs[base * 2 + 1] = v;
            refs[(base + 1) * 2] = u; refs[(base + 1) * 2 + 1] = v;
            segs[base] = s; segs[base + 1] = s + 1;
        }
    }
    const geom = new THREE.BufferGeometry();
    // positions come from the texture; the attribute only exists so three.js
    // has a draw count
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NPART * VPP * 3), 3));
    geom.setAttribute("ref", new THREE.BufferAttribute(refs, 2));
    geom.setAttribute("aSeg", new THREE.BufferAttribute(segs, 1));
    lineMat = new THREE.ShaderMaterial({
        uniforms: uniformsShared,
        vertexShader: LINE_VERT,
        fragmentShader: LINE_FRAG,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    });
    lines = new THREE.LineSegments(geom, lineMat);
    lines.frustumCulled = false;
    lines.renderOrder = 1;
    scene.add(lines);
    river.enabled = true;
}

export function warmRiverCompute() {
    if (!river.enabled || !rtA || !rtB || !computeScene || !computeCam) return false;
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(rtB);
    renderer.render(computeScene, computeCam);
    renderer.setRenderTarget(prevRT);
    const sw = rtA; rtA = rtB; rtB = sw;
    uniformsShared.uPos.value = rtA.texture;
    return true;
}

// Test/diagnostic only (see scripts/smoke-river-deeptime.mjs): reads back a
// strip of the live particle-position render target so a headless smoke can
// assert the GPU-side simulation hasn't degenerated (gone all-NaN, all-zero,
// or frozen to a single quantized point — the deep-time float32 collapse this
// module's uCenterShift design exists to prevent). Not used by the render path.
export function riverDebugReadPositions(rows = 4) {
    if (!river.enabled || !rtA) return null;
    const w = TEXW;
    const h = Math.max(1, Math.min(rows, TEXW));
    const px = new Float32Array(w * h * 4);
    renderer.readRenderTargetPixels(rtA, 0, 0, w, h, px);
    let finite = true, nonZero = 0, distinct = 0;
    let hash = 2166136261;
    let firstX = px[0], firstY = px[1], firstZ = px[2];
    for (let i = 0; i < w * h; i++) {
        const x = px[i * 4], y = px[i * 4 + 1], z = px[i * 4 + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) finite = false;
        if (x !== 0 || y !== 0 || z !== 0) nonZero++;
        if (Math.abs(x - firstX) > 1e-6 || Math.abs(y - firstY) > 1e-6 || Math.abs(z - firstZ) > 1e-6) distinct++;
        hash = Math.imul(hash ^ (Math.round(x * 1000) & 0xffff), 16777619) >>> 0;
        hash = Math.imul(hash ^ (Math.round(y * 1000) & 0xffff), 16777619) >>> 0;
        hash = Math.imul(hash ^ (Math.round(z * 1000) & 0xffff), 16777619) >>> 0;
    }
    return {
        finite, nonZero, distinct, sampled: w * h, hash,
        center: { x: smoothCenter.x, y: smoothCenter.y, z: smoothCenter.z }, radius: smoothR,
        // render placement: the lines mesh must carry the center back into
        // world space (review C1 — particles are center-relative; a mesh left
        // at origin renders the river displaced by -smoothCenter)
        meshPos: lines ? { x: lines.position.x, y: lines.position.y, z: lines.position.z } : null,
        visible: lines ? lines.visible : false,
    };
}

let lastR = 0, lastCx = 0, lastCz = 0;
const shellAnchorPos = new THREE.Vector3();
const shellAnchorColor = new THREE.Color();
let shellAnchorC = 0, shellAnchorSink = 1, shellAnchorROut = 170;
let shellAnchorIdx = -1, shellAnchorLive = false, shellAnchorSwitched = false;
const shellRnd = mulberry32(20260702);
let frameW = 0, lastFrameKind = -1, lastFrameIdx = -1;
const frameVelScene = [0, 0, 0];
const smoothCenter = new THREE.Vector3();
// Absolute (scene-space, float64-as-JS-number) center from the previous
// frame, used only to compute uCenterShift — never uploaded to the GPU
// itself. Kept equal to smoothCenter on any frame that resets/snaps the
// center so the shift is exactly zero instead of a stale, possibly huge
// jump on the frame where the center relocates.
const prevCenter = new THREE.Vector3();
let smoothR = 0;
const bhRiverPos = new THREE.Vector3();
const riverStarPickIndex = new Int32Array(RIVER_STAR_SOURCE_MAX);
const riverStarPickScore = new Float64Array(RIVER_STAR_SOURCE_MAX);
const riverStarPickRefs = new Array(RIVER_STAR_SOURCE_MAX);
let riverStarPickCountCached = 0;
let riverStarPickFrame = -9999;
let riverStarPickActiveCount = -1;
let riverStarPickCx = Infinity, riverStarPickCy = Infinity, riverStarPickCz = Infinity, riverStarPickR = 0;
let riverStarPickRefreshed = true;
let riverStarUniformOffset = -1, riverStarUniformCount = -1;
let riverVRefFrame = -9999;
let riverVRefCx = Infinity, riverVRefCy = Infinity, riverVRefCz = Infinity, riverVRefR = 0;
const typSamples = new Float64Array(MAXB);
function insertRiverStarPick(index, score, count) {
    if (count >= RIVER_STAR_SOURCE_MAX && score <= riverStarPickScore[count - 1]) return count;
    const nextCount = count < RIVER_STAR_SOURCE_MAX ? count + 1 : count;
    let p = Math.min(count, RIVER_STAR_SOURCE_MAX - 1);
    while (p > 0 && score > riverStarPickScore[p - 1]) {
        riverStarPickScore[p] = riverStarPickScore[p - 1];
        riverStarPickIndex[p] = riverStarPickIndex[p - 1];
        p--;
    }
    riverStarPickScore[p] = score;
    riverStarPickIndex[p] = index;
    return nextCount;
}
function insertTypSample(typ, count) {
    let p = count;
    while (p > 0 && typSamples[p - 1] > typ) {
        typSamples[p] = typSamples[p - 1];
        p--;
    }
    typSamples[p] = typ;
    return count + 1;
}
function clearRiverStarPick() {
    riverStarPickRefreshed = riverStarPickCountCached > 0 || riverStarUniformCount > 0;
    for (let p = 0; p < riverStarPickCountCached; p++) riverStarPickRefs[p] = null;
    riverStarPickCountCached = 0;
    riverStarPickActiveCount = ACTIVE_STARS.length;
    riverStarPickFrame = river.frame;
    return 0;
}
function refreshRiverStarPick(smoothCenter, smoothR, localFocus, renderShed) {
    const move2 = Math.max(
        Math.abs(smoothCenter.x - riverStarPickCx),
        Math.abs(smoothCenter.y - riverStarPickCy),
        Math.abs(smoothCenter.z - riverStarPickCz),
    );
    const radiusDelta = Math.abs(Math.log(Math.max(1e-9, smoothR / Math.max(1e-9, riverStarPickR))));
    const cadence = localFocus > .05 ? 8 : renderShed > .2 ? 16 : 12;
    const moved = move2 > Math.max(80, smoothR * (localFocus > .05 ? .018 : .045));
    if (ACTIVE_STARS.length === riverStarPickActiveCount &&
        river.frame - riverStarPickFrame < cadence &&
        !moved && radiusDelta < .08) {
        riverStarPickRefreshed = false;
        return riverStarPickCountCached;
    }

    riverStarPickRefreshed = true;
    let count = 0;
    for (let i = 0; i < ACTIVE_STARS.length; i++) {
        const s = ACTIVE_STARS[i];
        const sx = s.x * K, sy = (s.z || 0) * K, sz = -s.y * K;
        const sink = (s.bh ? s.rs : s.R) * K;
        const dx = smoothCenter.x - sx, dy = smoothCenter.y - sy, dz = smoothCenter.z - sz;
        const d2 = Math.max(sink * sink, dx * dx + dy * dy + dz * dz);
        const muRank = s.mu * s.mu * (s.bh ? 256 : 1);
        count = insertRiverStarPick(i, muRank / Math.max(1e-18, d2), count);
    }
    for (let p = 0; p < count; p++) riverStarPickRefs[p] = ACTIVE_STARS[riverStarPickIndex[p]];
    for (let p = count; p < riverStarPickCountCached; p++) riverStarPickRefs[p] = null;
    riverStarPickCountCached = count;
    riverStarPickFrame = river.frame;
    riverStarPickActiveCount = ACTIVE_STARS.length;
    riverStarPickCx = smoothCenter.x;
    riverStarPickCy = smoothCenter.y;
    riverStarPickCz = smoothCenter.z;
    riverStarPickR = smoothR;
    return count;
}
// bodies: 0 earth, 1 moon, 2 sun, 3..9 planets, then player holes and stars
export function updateRiver(dtSim, fB, earthV, moonV, sunPosV, plPos, dtReal = 0) {
    river.dtVis = dtSim;
    if (!river.enabled) return;
    river.frame++;
    shellAnchorLive = false;
    const riverFocusT0 = PERF.enabled ? performance.now() : 0;
    // Fade the river out as the camera zooms past the local system into
    // interstellar/cosmic scale. Out there every body's inflow collapses onto a
    // sub-pixel point and the additive streaks pile into a blinding white core
    // (the reported bug). Folding the fade into fEff also makes lines.visible go
    // false below, which short-circuits the expensive 64-source GPU compute — so
    // zoomed-out frames cost nothing. The river stays fully on through the whole
    // solar-system survey and whenever the camera is near a star/system.
    const zoomFade = 1 - smooth01(LY_SCENE * 0.004, LY_SCENE * 0.02, cam.dist);
    const fEff = fB * zoomFade;
    lines.visible = fEff > .01;
    if (!lines.visible) {
        river.computeEvery = 1;
        river.skippedCompute = false;
        return;
    }
    const planeBias = smooth01(6000, 420000, cam.dist);
    let localFocus = 0;
    let frameKind = -1, frameIdx = -1;  // 0 earth, 1 moon, 2 sun, 3 planet i, 4 hole i, 5 ship
    const earthCamD = WORLD.earthDestroyed ? Infinity : camera.position.distanceTo(earthV);
    const earthClear = Math.max(0, earthCamD - R_EARTH * K);
    if (!WORLD.earthDestroyed) {
        const orbitalView = 1 - smooth01(0.06, 9.5, earthClear);
        const lowOrbitView = 1 - smooth01(0.18, 80, earthClear);
        const cand = Math.max(orbitalView, lowOrbitView * .92); if (cand > localFocus) { localFocus = cand; frameKind = 0; }
    }
    if (!WORLD.moonDestroyed) {
        const clear = Math.max(0, camera.position.distanceTo(moonV) - R_MOON * K);
        const cand = 0.82 * (1 - smooth01(16, 180, clear)); if (cand > localFocus) { localFocus = cand; frameKind = 1; }
    }
    if (!WORLD.sunDestroyed) {
        const clear = Math.max(0, camera.position.distanceTo(sunPosV) - SUN_RADIUS);
        const cand = 0.96 * (1 - smooth01(SUN_RADIUS * 0.18, SUN_RADIUS * 7.5, clear)); if (cand > localFocus) { localFocus = cand; frameKind = 2; }
    }
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        const sink = PL[i].R * K;
        const clear = Math.max(0, camera.position.distanceTo(plPos[i]) - sink);
        const cand = 0.95 * (1 - smooth01(Math.max(8, sink * 1.5), Math.max(90, sink * 34), clear)); if (cand > localFocus) { localFocus = cand; frameKind = 3; frameIdx = i; }
    }
    for (let i = 0; i < BH.n; i++) {
        bhRiverPos.set(earthV.x + BH.sx[i], earthV.y, earthV.z + BH.sz[i]);
        const sink = Math.max(BH.sinkS[i], .45);
        const clear = Math.max(0, camera.position.distanceTo(bhRiverPos) - sink);
        const cand = 0.97 * (1 - smooth01(Math.max(16, sink * 3), Math.max(220, sink * 120), clear)); if (cand > localFocus) { localFocus = cand; frameKind = 4; frameIdx = i; }
    }
    // Frame velocity from EXACT ephemeris state (never finite differences —
    // those alias at high warp): world km/s = Earth world velocity + the
    // body's Earth-relative velocity (eph fields, ephemeris.js:48-54), then
    // the same axis map main.js applies to positions: (x,y,z)→(x·K, z·K, −y·K).
    let frameTargetW = frameBlendW(localFocus);
    let fvx = eph.earthVx, fvy = eph.earthVy, fvz = eph.earthVz;
    if (frameKind === 1) { fvx += eph.moonVx; fvy += eph.moonVy; fvz += eph.moonVz; }
    else if (frameKind === 2) { fvx += eph.sunVx; fvy += eph.sunVy; fvz += eph.sunVz; }
    else if (frameKind === 3) { fvx += eph.plVx[frameIdx]; fvy += eph.plVy[frameIdx]; fvz += eph.plVz[frameIdx]; }
    else if (frameKind === 4) { fvx += BH.vx[frameIdx]; fvy += BH.vy[frameIdx]; }
    else if (frameKind === -1) {
        // no body dominates: ship focus gives the first-person "carried by
        // the river" frame, fading out toward the survey view (planeBias→1)
        if (G.focus === "ship") { frameKind = 5; fvx += G.vx; fvy += G.vy; fvz += G.vz; frameTargetW = shipFrameW(planeBias); }
        else { fvx = 0; fvy = 0; fvz = 0; frameTargetW = 0; }
    }
    if (frameKind !== lastFrameKind || frameIdx !== lastFrameIdx) frameW = 0; // snap on target switch, then ease in
    lastFrameKind = frameKind; lastFrameIdx = frameIdx;
    frameW += (frameTargetW - frameW) * Math.min(1, dtReal * RIVER_VIS.FRAME_EASE);
    frameVelToScene(fvx, fvy, fvz, frameVelScene);
    uniformsShared.uFrameVel.value.set(frameVelScene[0], frameVelScene[1], frameVelScene[2]);
    uniformsShared.uFrameW.value = frameW;
    const nearEarthLoad = (1 - smooth01(38, 760, earthClear)) * (1 - smooth01(R_EARTH * K * 28, R_EARTH * K * 150, earthCamD));
    const loadShed = Math.max(0, Math.min(1, nearEarthLoad * (1 - localFocus * .78)));
    const zoomShed = smooth01(2.0e7, LY_SCENE * .18, cam.dist) * (1 - localFocus * .72);
    const renderShed = Math.max(loadShed, zoomShed);
    uniformsShared.uLoadShed.value = loadShed;
    uniformsShared.uLocalFocus.value = localFocus;
    const mobileOpacity = renderQuality.mobile ? 1.08 : 1;
    uniformsShared.uOpacity.value = .44 * mobileOpacity * RIVER_DENSITY_GAIN * fEff * (1 + planeBias * .62 + localFocus * .7) * (1 - loadShed * .12);
    river.renderShed = renderShed;
    let drawFrac = Math.max(.52, .56 + localFocus * .30, 1 - renderShed * .44);
    if (renderQuality.mobile) drawFrac = Math.min(drawFrac, renderQuality.loadShed >= 2 ? .72 : .84);
    const drawCount = Math.max(256, Math.min(NPART, Math.floor(NPART * drawFrac)));
    if (drawCount !== river.drawCount) {
        lines.geometry.setDrawRange(0, drawCount * VPP);
        river.drawCount = drawCount;
    }
    if (PERF.enabled) markPerf("river.focus", performance.now() - riverFocusT0, { renderShed, localFocus, drawCount });

    const riverVolumeT0 = PERF.enabled ? performance.now() : 0;
    const cd = camera.position.distanceTo(cam.tgt);
    const localMinR = localFocus > .05 ? Math.max(10, Math.min(72, earthClear * 5.5 + 9)) : 16;
    const targetR = Math.min(1.2e8, Math.max(localMinR, cd * (localFocus > .05 ? 4.2 : 2.8)));
    const c = cam.tgt;
    let respawn = .006;
    if (smoothR === 0) {
        smoothCenter.copy(c);
        smoothR = targetR;
        respawn = 1;
        prevCenter.copy(smoothCenter); // first frame: no prior center to shift from
    } else {
        const move = Math.hypot(c.x - smoothCenter.x, c.y - smoothCenter.y, c.z - smoothCenter.z);
        const zoomDelta = Math.abs(Math.log(Math.max(1e-9, targetR / smoothR)));
        const dtSmooth = Math.min(dtReal, 1 / 30);
        const easeC = Math.min(1, .08 + dtSmooth * 8);
        const easeR = Math.min(1, .05 + dtSmooth * 5);
        smoothCenter.lerp(c, easeC);
        smoothR += (targetR - smoothR) * easeR;
        respawn = Math.min(.09, .006 + zoomDelta * .025 + move / Math.max(smoothR, 1) * .045);
        if (zoomDelta > 2.2 || move > targetR * 2.5) {
            smoothCenter.copy(c);
            smoothR = targetR;
            respawn = .28;
            prevCenter.copy(smoothCenter); // hard snap: treat as a fresh center, zero shift
        }
    }
    respawn = Math.min(.18, respawn + localFocus * .075);
    river.radius = smoothR;
    lastR = smoothR; lastCx = smoothCenter.x; lastCz = smoothCenter.z;
    // Particle positions live in the smoothCenter-relative frame (float32-safe
    // at deep-time magnitudes); the mesh itself must carry the center back so
    // the river renders around the focus, not at scene origin. The view*model
    // translation cancels in float64 before any float32 upload, preserving the
    // precision win (review C1).
    lines.position.copy(smoothCenter);
    lines.updateMatrixWorld();
    // Everything handed to the GPU below is expressed relative to smoothCenter
    // (float64 on the CPU) rather than in absolute scene coordinates, so it
    // stays small and float32-precise regardless of how far smoothCenter has
    // drifted in deep time/space. uCenterShift re-bases the persistent
    // particle-position texture onto this frame's center (see COMPUTE_FRAG).
    uniformsShared.uCenterShift.value.set(
        smoothCenter.x - prevCenter.x,
        smoothCenter.y - prevCenter.y,
        smoothCenter.z - prevCenter.z,
    );
    prevCenter.copy(smoothCenter);
    uniformsShared.uOrigin.value.set(earthV.x - smoothCenter.x, earthV.y - smoothCenter.y, earthV.z - smoothCenter.z);
    uniformsShared.uRadius.value = smoothR;
    uniformsShared.uCam.value.set(camera.position.x - smoothCenter.x, camera.position.y - smoothCenter.y, camera.position.z - smoothCenter.z);
    uniformsShared.uRespawn.value = respawn;
    const deFade = G.darkEnergy ? smooth01(DARK_ENERGY.VISIBLE_START_KM * K, DARK_ENERGY.VISIBLE_FULL_KM * K, smoothR) : 0;
    uniformsShared.uDE.value = DARK_ENERGY.H_PHYS * deFade;
    uniformsShared.uPlaneBias.value = planeBias;
    uniformsShared.uTimeRate.value = dtReal > 0 ? Math.max(1, dtSim / dtReal) : 1;
    // Render-only pulse clock: accumulated REAL time (dtReal), never sim
    // state — determinism smokes see no new randomness or sim-time consumers.
    const dtPulse = Math.max(0, Math.min(dtReal, 0.1));
    uniformsShared.uPhase.value = (uniformsShared.uPhase.value + dtPulse * pulsePhaseRate(uniformsShared.uTimeRate.value)) % 64;
    uniformsShared.uTick.value = (uniformsShared.uTick.value + .618) % 64;
    if (PERF.enabled) markPerf("river.volume", performance.now() - riverVolumeT0, { radius: smoothR, respawn });

    const riverSourcesT0 = PERF.enabled ? performance.now() : 0;
    // Every body position below is written relative to smoothCenter (see the
    // uCenterShift comment above) rather than in absolute scene coordinates.
    bodyVals[0].set(earthV.x - smoothCenter.x, earthV.y - smoothCenter.y, earthV.z - smoothCenter.z, WORLD.earthDestroyed ? 0 : FLOW.CE);
    sinkVals[0] = R_EARTH * K + .6;
    rsVals[0] = rsScene(MU_E);
    holeVals[0] = 0;
    soiVals[0] = SOI_E * K;
    colorVals[0].set(0.22, 0.48, 1.0);
    bodyVals[1].set(moonV.x - smoothCenter.x, moonV.y - smoothCenter.y, moonV.z - smoothCenter.z, WORLD.moonDestroyed ? 0 : FLOW.CM);
    sinkVals[1] = R_MOON * K + .5;
    rsVals[1] = rsScene(MU_M);
    holeVals[1] = 0;
    soiVals[1] = SOI_M * K;
    colorVals[1].set(0.72, 0.76, 0.82);
    bodyVals[2].set(sunPosV.x - smoothCenter.x, sunPosV.y - smoothCenter.y, sunPosV.z - smoothCenter.z, WORLD.sunDestroyed ? 0 : FLOW.CS);
    sinkVals[2] = SUN_RADIUS * 1.08;
    rsVals[2] = rsScene(MU_S);
    holeVals[2] = 0;
    soiVals[2] = 0;
    colorVals[2].set(1.0, 0.55, 0.13);
    for (let i = 0; i < PL.length; i++) {
        bodyVals[3 + i].set(plPos[i].x - smoothCenter.x, plPos[i].y - smoothCenter.y, plPos[i].z - smoothCenter.z, WORLD.plDestroyed[i] ? 0 : .001 * Math.sqrt(2 * PL[i].mu / 1000));
        sinkVals[3 + i] = PL[i].R * K;
        rsVals[3 + i] = rsScene(PL[i].mu);
        holeVals[3 + i] = 0;
        soiVals[3 + i] = PL[i].soi * K;
        colorVals[3 + i].set(plColors[i].r, plColors[i].g, plColors[i].b);
    }
    let nb = 3 + PL.length;
    for (let i = 0; i < BH.n && nb < MAXB; i++, nb++) {
        bodyVals[nb].set(earthV.x + BH.sx[i] - smoothCenter.x, earthV.y - smoothCenter.y, earthV.z + BH.sz[i] - smoothCenter.z, BH.c[i] * Math.max(.08, BH.obsT[i] || 1));
        sinkVals[nb] = BH.sinkS[i];
        rsVals[nb] = BH.rs[i] * K;
        holeVals[nb] = 1;
        soiVals[nb] = 0;
        colorVals[nb].set(0.5, 0.72, 1.0);
    }
    const sinkSourceCount = nb;
    const starFieldRelevant =
        Math.hypot(smoothCenter.x, smoothCenter.y, smoothCenter.z) + smoothR > RIVER_STAR_SOURCE_START_R;
    const riverStarPickCount = starFieldRelevant
        ? refreshRiverStarPick(smoothCenter, smoothR, localFocus, renderShed)
        : clearRiverStarPick();
    const starCapacity = Math.max(0, MAXB - sinkSourceCount);
    const starSourceCount = Math.min(riverStarPickCount, starCapacity);
    const starUniformDirty = riverStarPickRefreshed ||
        sinkSourceCount !== riverStarUniformOffset ||
        starSourceCount !== riverStarUniformCount;
    if (starUniformDirty) {
        let flowStarCount = 0;
        for (let p = 0; p < starSourceCount; p++) {
            const s = riverStarPickRefs[p];
            if (!s) continue;
            const slot = sinkSourceCount + flowStarCount;
            const sx = s.x * K, sy = (s.z || 0) * K, sz = -s.y * K;
            const cStar = .001 * Math.sqrt(2 * s.mu / 1000);
            const sink = (s.bh ? s.rs : s.R) * K;
            sinkVals[slot] = sink;
            rsVals[slot] = (s.bh ? s.rs : 2 * s.mu / C2) * K;
            holeVals[slot] = s.bh ? 1 : 0;
            soiVals[slot] = 0;
            colorTmp.setHex(s.color);
            colorVals[slot].set(colorTmp.r, colorTmp.g, colorTmp.b);
            flowCtx.starX[flowStarCount] = sx;
            flowCtx.starY[flowStarCount] = sy;
            flowCtx.starZ[flowStarCount] = sz;
            flowCtx.starC[flowStarCount] = cStar;
            flowCtx.starSink[flowStarCount] = sink;
            flowStarCount++;
        }
        flowCtx.starCount = flowStarCount;
        riverStarUniformOffset = sinkSourceCount;
        riverStarUniformCount = flowStarCount;
    } else {
        flowCtx.starCount = starSourceCount;
    }
    // flowCtx.star{X,Y,Z} are cached ABSOLUTE positions (also consumed by
    // flowfield.js's CPU-side flowVel(), which needs absolute coordinates),
    // refreshed only when the star selection itself changes above. smoothCenter
    // moves every frame though, so the GPU-facing residual is re-derived here
    // unconditionally — reusing a stale residual between cache refreshes would
    // silently drift each star's apparent position in the flow field.
    for (let p = 0; p < flowCtx.starCount; p++) {
        const slot = sinkSourceCount + p;
        bodyVals[slot].set(flowCtx.starX[p] - smoothCenter.x, flowCtx.starY[p] - smoothCenter.y, flowCtx.starZ[p] - smoothCenter.z, flowCtx.starC[p]);
    }
    nb = sinkSourceCount + flowCtx.starCount;
    uniformsShared.uNB.value = nb;
    uniformsShared.uSinkNB.value = nb;
    river.sourceCount = nb;
    river.starSources = flowCtx.starCount;
    river.starRefreshed = starUniformDirty;
    river.sinkSources = nb;
    // Universal shell anchor: the source whose river dominates at the volume
    // center (bodyVals are center-relative, and the center tracks cam.tgt).
    // One dominance rule for Moon/Earth/planets/Sun/holes/stars — the shells
    // are the law v = √(2μ/r) made visible around whatever wins locally.
    let shellBest = -1, shellBestScore = 0;
    for (let i = 0; i < nb; i++) {
        const w = bodyVals[i].w;
        if (w <= 0) continue;
        const d2 = Math.max(sinkVals[i] * sinkVals[i], bodyVals[i].x * bodyVals[i].x + bodyVals[i].y * bodyVals[i].y + bodyVals[i].z * bodyVals[i].z);
        const score = w * w / d2;
        if (score > shellBestScore) { shellBestScore = score; shellBest = i; }
    }
    if (shellBest >= 0) {
        const wx = bodyVals[shellBest].x + smoothCenter.x;
        const wy = bodyVals[shellBest].y + smoothCenter.y;
        const wz = bodyVals[shellBest].z + smoothCenter.z;
        const moved = Math.abs(wx - shellAnchorPos.x) + Math.abs(wy - shellAnchorPos.y) + Math.abs(wz - shellAnchorPos.z);
        shellAnchorSwitched = shellBest !== shellAnchorIdx || moved > shellAnchorROut * 4;
        shellAnchorPos.set(wx, wy, wz);
        shellAnchorC = bodyVals[shellBest].w;
        shellAnchorSink = sinkVals[shellBest];
        shellAnchorROut = shellOuterRadius(sinkVals[shellBest], soiVals[shellBest], smoothR);
        shellAnchorColor.setRGB(colorVals[shellBest].x, colorVals[shellBest].y, colorVals[shellBest].z);
        shellAnchorIdx = shellBest;
        shellAnchorLive = true;
    }
    const vRefCadence = renderQuality.mobile ? 4 : G.warp > 600 ? 3 : 1;
    const vRefMove = Math.max(
        Math.abs(smoothCenter.x - riverVRefCx),
        Math.abs(smoothCenter.y - riverVRefCy),
        Math.abs(smoothCenter.z - riverVRefCz),
    );
    const vRefRadiusDelta = Math.abs(Math.log(Math.max(1e-9, smoothR / Math.max(1e-9, riverVRefR))));
    const vRefDue = riverVRefFrame < 0 || vRefCadence <= 1 ||
        river.frame - riverVRefFrame >= vRefCadence ||
        starUniformDirty || respawn > .08 ||
        vRefMove > Math.max(12, smoothR * .025) || vRefRadiusDelta > .05;
    if (vRefDue) {
        // Color/length normalization follows the same field as the shader,
        // using a local representative radius for each source. bodyVals[i]
        // already holds each body's position relative to smoothCenter (see
        // above), so its own length IS the distance from smoothCenter to the
        // body — no separate subtraction needed here.
        let best = 0, bestS = -1, bestTyp = .01;
        let typSampleCount = 0;
        for (let i = 0; i < nb; i++) {
            const dC = Math.max(sinkVals[i], Math.hypot(bodyVals[i].x, bodyVals[i].y, bodyVals[i].z));
            const typ = bodyVals[i].w / Math.sqrt(Math.max(sinkVals[i], Math.max(dC - smoothR, sinkVals[i])));
            typSampleCount = insertTypSample(typ, typSampleCount);
            if (typ > bestS) { bestS = typ; best = i; bestTyp = typ; }
        }
        const robustTyp = typSamples[Math.max(0, Math.floor(typSampleCount * .72))] || bestTyp;
        uniformsShared.uVRef.value = Math.max(.01, Math.min(bestTyp, robustTyp * 6));
        riverVRefFrame = river.frame;
        riverVRefCx = smoothCenter.x;
        riverVRefCy = smoothCenter.y;
        riverVRefCz = smoothCenter.z;
        riverVRefR = smoothR;
    }
    river.vRefRefreshed = vRefDue;
    river.vRefCadence = vRefCadence;
    if (PERF.enabled) markPerf("river.sources", performance.now() - riverSourcesT0, { nb, starUniformDirty, vRefRefreshed: vRefDue, vRefCadence });
    // River motion follows simulated time. At real time the field is almost
    // still at solar-system scale; higher warp advances it proportionally,
    // while the compute shader caps per-frame displacement inside the volume.
    const dtVis = dtSim > 0 ? dtSim : 0;
    river.dtVis = dtVis;
    uniformsShared.uRespawn.value = respawn;
    const adaptiveComputeEvery = renderQuality.mobile ? (river.computeEveryAdaptive || 1) : 1;
    const baseComputeEvery = renderQuality.mobile && renderQuality.loadShed >= 2 ? 2 : 1;
    const computeEvery = Math.max(baseComputeEvery, adaptiveComputeEvery);
    river.computeEvery = computeEvery;
    river.dtAccum += dtVis;
    const shouldCompute = (dtVis > 0 || respawn > .001) &&
        (computeEvery <= 1 || river.frame % computeEvery === 0 || respawn > .08);
    river.skippedCompute = !shouldCompute;
    if (shouldCompute) {
        const computeDt = Math.max(dtVis, river.dtAccum);
        uniformsShared.uDtSim.value = computeDt;
        river.dtVis = computeDt;
        river.dtAccum = 0;
        const computeT0 = performance.now();
        const prevRT = renderer.getRenderTarget();
        renderer.setRenderTarget(rtB);
        renderer.render(computeScene, computeCam);
        renderer.setRenderTarget(prevRT);
        const computeMs = performance.now() - computeT0;
        river.computeMs = computeMs;
        if (renderQuality.mobile && computeMs > 24) river.computeEveryAdaptive = Math.min(4, Math.max(river.computeEveryAdaptive || 1, Math.ceil(computeMs / 18)));
        else if (renderQuality.mobile && computeMs < 6 && river.computeEveryAdaptive > 1) river.computeEveryAdaptive = Math.max(1, river.computeEveryAdaptive - 1);
        else if (!renderQuality.mobile) river.computeEveryAdaptive = 1;
        const sw = rtA; rtA = rtB; rtB = sw;
        uniformsShared.uPos.value = rtA.texture;
    } else uniformsShared.uDtSim.value = 0;
}

// ---- collapsing dot-shells near Earth ----
function makeShellSet(n, rOut, color) {
    const set = [];
    const NPTS = 240, GA = Math.PI * (3 - Math.sqrt(5));
    for (let s = 0; s < n; s++) {
        const pos = new Float32Array(NPTS * 3);
        for (let k = 0; k < NPTS; k++) {
            const yy = 1 - 2 * (k + .5) / NPTS, rr = Math.sqrt(1 - yy * yy), th = GA * k;
            pos[k * 3] = rr * Math.cos(th);
            pos[k * 3 + 1] = yy;
            pos[k * 3 + 2] = rr * Math.sin(th);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        const obj = new THREE.Points(g, new THREE.PointsMaterial({ color, size: .95, sizeAttenuation: true, map: dotTexture("rgba(220,240,255,1)", "rgba(140,190,230,0.4)"), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true }));
        obj.visible = false;
        obj.renderOrder = 1;
        scene.add(obj);
        set.push({ obj, r: rOut * (0.25 + 0.75 * (s + 1) / n), rOut });
    }
    return set;
}
const shellsE = makeShellSet(4, 170, 0x5fb0e8);
let shellAnchorWas = false;
export function updateShells(dtSim, fB) {
    // Universal contracting shells: the SAME law the streaks show, made
    // legible as whole fronts — space contracting at v = √(2μ/r) toward the
    // locally dominant source (anchor chosen in updateRiver). Replaces the
    // old Earth-only shells; deterministic through mulberry32.
    const show = fB > .01 && shellAnchorLive && cam.dist < shellAnchorROut * RIVER_VIS.SHELL_VIS_CAMDIST;
    if (show && (shellAnchorSwitched || !shellAnchorWas)) {
        for (const sh of shellsE) sh.r = shellAnchorROut * (.3 + .7 * shellRnd());
    }
    shellAnchorWas = show;
    if (!show) {
        for (const sh of shellsE) sh.obj.visible = false;
        return;
    }
    const rOut = shellAnchorROut;
    const sink = Math.max(shellAnchorSink, 1e-6);
    for (const sh of shellsE) {
        sh.r = shellStep(sh.r, shellAnchorC, sink, dtSim);
        if (sh.r < sink || sh.r > rOut * 1.2) sh.r = rOut * (0.86 + 0.26 * shellRnd());
        sh.obj.position.copy(shellAnchorPos);
        sh.obj.scale.setScalar(sh.r);
        sh.obj.material.size = shellDotSize(rOut, cam.dist);
        sh.obj.material.color.copy(shellAnchorColor);
        sh.obj.visible = true;
        const oo = fB * RIVER_VIS.SHELL_OPACITY * Math.min(1, (rOut - sh.r) / (rOut * RIVER_VIS.SHELL_FADE_IN)) * Math.min(1, (sh.r - sink) / (rOut * .041));
        sh.obj.material.opacity = Math.max(0, oo);
    }
}
