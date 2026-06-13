import * as THREE from "three";
import { BH_MAX, C_LIGHT, DARK_ENERGY, FLOW, MU_E, MU_M, MU_S, PL, K, R_EARTH, R_MOON, STARS, SUN_RADIUS } from "./constants.js";
import { G, BH, WORLD } from "./state.js";
import { mulberry32, smooth01 } from "./format.js";
import { dotTexture } from "./textures.js";
import { scene, renderer, camera, cam } from "./scene.js";

// GPU river: one particle volume that follows the camera at solar-system scale.
// Positions live in a float texture advected by a compute pass; the analytic
// flow field v(r) = sum(-rhat * C_i / sqrt(r_i)) matches flowfield.js.
const TEXW = (() => {
    const m = location.search.match(/np=(\d+)/);
    const v = m ? +m[1] : 176; // ~31k streaks ≈ double the original CPU density
    return Math.min(1024, Math.max(64, v));
})();
const NPART = TEXW * TEXW;
const RIVER_STAR_SOURCE_MAX = 48;
const MAXB = 3 + PL.length + BH_MAX + RIVER_STAR_SOURCE_MAX;

export const river = { enabled: false, radius: 22, count: NPART };

let rtA, rtB, computeScene, computeCam, computeMat, lineMat, lines;
const bodyVals = [], sinkVals = new Array(MAXB).fill(0), rsVals = new Array(MAXB).fill(0), holeVals = new Array(MAXB).fill(0);
const colorVals = [];
for (let i = 0; i < MAXB; i++) bodyVals.push(new THREE.Vector4());
for (let i = 0; i < MAXB; i++) colorVals.push(new THREE.Vector3(0.32, 0.58, 0.9));
const colorTmp = new THREE.Color();
const C2 = C_LIGHT * C_LIGHT;
const rsScene = mu => 2 * mu / C2 * K;
const uniformsShared = {
    uPos: { value: null },
    uDtSim: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uOrigin: { value: new THREE.Vector3() },
    uRadius: { value: 22 },
    uCam: { value: new THREE.Vector3() },
    uTick: { value: 0 },
    uRespawn: { value: 1 },
    uNB: { value: 10 },
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
};

const FLOW_GLSL = /* glsl */`
uniform int uNB;
uniform vec4 uBody[${MAXB}];
uniform float uSink[${MAXB}];
uniform float uRs[${MAXB}];
uniform float uHole[${MAXB}];
uniform vec3 uColor[${MAXB}];
uniform float uRadius;
uniform vec3 uCenter;
uniform vec3 uOrigin;
uniform float uDE;
uniform float uPlaneBias;
uniform float uTimeRate;
uniform float uLoadShed;
uniform float uLocalFocus;
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
    if (rawLen < 1e-12 || pullLen < 1e-18) return raw;
    float deShare = length(de) / max(rawLen, 1e-12);
    float deInk = smoothstep(0.45, 0.92, deShare);
    return mix(normalize(pull) * rawLen, raw, deInk);
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
varying vec2 vUv;
${FLOW_GLSL}
void main() {
    vec3 p = texture2D(uPos, vUv).xyz;
    vec3 v = flowField(p);
    vec3 stp = v * uDtSim;
    float sl = length(stp);
    float cap = uRadius * 0.05;
    if (sl > cap) stp *= cap / sl;
    p += stp;
    bool kill = hash13(vec3(vUv * 719.3, uTick + 9.7)) < uRespawn;
    if (distance(p, uCenter) > uRadius * 1.04) kill = true;
    for (int i = 0; i < ${MAXB}; i++) {
        if (i >= uNB) break;
        float sink = sourceCore(uSink[i], uHole[i]);
        if (distance(p, uBody[i].xyz) < sink) { kill = true; break; }
    }
    if (hash13(vec3(vUv * 913.7, uTick)) < 0.002) kill = true;
    if (kill) {
        float h1 = hash13(vec3(vUv * 127.1, uTick + 0.17));
        float h2 = hash13(vec3(vUv * 311.7, uTick + 1.31));
        float h3 = hash13(vec3(vUv * 74.7, uTick + 2.07));
        float th = 6.2831853 * h2;
        float yy = h1 * 2.0 - 1.0;
        float rr = sqrt(max(0.0, 1.0 - yy * yy));
        float rad = uRadius * pow(h3, 0.3333333);
        p = uCenter + vec3(cos(th) * rr, yy, sin(th) * rr) * rad;
        // never spawn inside a sink: push out radially
        for (int i = 0; i < ${MAXB}; i++) {
            if (i >= uNB) break;
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
uniform float uVRef, uOpacity;
uniform vec3 uCam;
attribute vec2 ref;
attribute float aEnd;
varying vec3 vColor;
${FLOW_GLSL}
void main() {
    vec3 p = texture2D(uPos, ref).xyz;
    vec3 v = flowField(p);
    float spd = max(length(v), 1e-12);
    float rel = spd / max(uVRef, 1e-9);
    float t = clamp(log2(1.0 + rel) * 0.72, 0.0, 1.0);
    float warpInk = clamp(log2(max(uTimeRate, 1.0)) / 16.0, 0.0, 1.0);
    float timeInk = smoothstep(0.0, 1.0, log2(max(uTimeRate, 1.0)) / 13.0);
    float visibleTime = max(timeInk, max(uLocalFocus * 0.58, 0.18));
    float tVis = smoothstep(mix(0.004, 0.0015, uPlaneBias), mix(0.20, 0.09, uPlaneBias), t);
    float loadTrim = mix(1.0, 0.46, uLoadShed);
    float timeTrim = mix(0.32, 1.0, visibleTime);
    float maxL = mix(760.0, uRadius * 0.055, uPlaneBias) * loadTrim * timeTrim;
    float L = clamp(uRadius * mix(0.032, 0.0055, pow(tVis, 0.72)) * mix(0.22, 1.85, warpInk) * loadTrim * timeTrim, uRadius * 0.0012, maxL);
    vec3 tail = p - v / spd * L;
    vec3 pos = mix(p, tail, aEnd);
    // fades: volume edge, camera proximity, sink proximity
    float fade = clamp(1.0 - (distance(p, uCenter) - uRadius * 0.52) / (uRadius * 0.48), 0.0, 1.0);
    float camBlind = mix(uRadius * 0.10, uRadius * 0.018, uLocalFocus);
    float camFadeBand = mix(uRadius * 0.45, uRadius * 0.16, uLocalFocus);
    fade *= clamp((distance(p, uCam) - camBlind) / max(1e-6, camFadeBand), 0.0, 1.0);
    fade *= 0.55 + 0.45 * hash13(vec3(ref * 53.7, 7.77)); // per-streak variety
    for (int i = 0; i < ${MAXB}; i++) {
        if (i >= uNB) break;
        float dB = distance(p, uBody[i].xyz);
        float surfaceBand = mix(uSink[i] * 1.5 + uRadius * 0.02, max(uRadius * 0.035, uSink[i] * 0.055), uLocalFocus);
        float regularSinkFade = clamp((dB - uSink[i]) / max(1e-6, surfaceBand), 0.0, 1.0);
        float bhCore = sourceCore(uSink[i], uHole[i]);
        float bhSinkFade = smoothstep(bhCore * 0.9, max(bhCore * 9.0, uRadius * 0.13), dB);
        fade *= mix(regularSinkFade, bhSinkFade, uHole[i]);
    }
    // golden when the Sun's river dominates locally, violet when expansion wins
    float sunPart = uBody[2].w * inversesqrt(max(uSink[2] * 0.5, distance(p, uBody[2].xyz)));
    float gold = smoothstep(0.5, 0.95, clamp(sunPart / spd, 0.0, 1.0));
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
            float align = dot(normalize(v), normalize(toBody));
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
    L *= mix(1.0, 3.4, localViewInk) * mix(1.0, 0.45, lapseInk) * mix(1.0, 0.45, holeInk);
    tail = p - v / spd * L;
    pos = mix(p, tail, aEnd);
    vec3 cBlue = vec3(0.16 + 0.5 * t, 0.4 + 0.45 * t, 0.6 + 0.4 * t);
    vec3 cHole = vec3(0.14 + 0.42 * t, 0.62 + 0.30 * t, 1.0);
    vec3 cGold = vec3(0.6 + 0.4 * t, 0.34 + 0.42 * t, 0.12 + 0.26 * t);
    vec3 cViolet = vec3(0.38 + 0.3 * t, 0.22 + 0.26 * t, 0.85 + 0.15 * t);
    float fieldInk = max(pow(tVis, mix(0.85, 0.48, uPlaneBias)), uPlaneBias * 0.18) * mix(0.82, 1.35, warpInk) * (1.0 + lapseInk * 0.55 + holeInk * 0.62 + holeHalo * 1.2 + localViewInk * 1.15);
    fieldInk *= mix(1.0, 0.48, holeCrowd);
    fieldInk = max(fieldInk, uLocalFocus * localInk * 0.72);
    vec3 fieldColor = mix(mix(cBlue, cGold, gold), cViolet, violet);
    vec3 localBright = max(localColor * 1.22, vec3(0.30, 0.34, 0.40));
    fieldColor = mix(fieldColor, localBright, localInk * 0.74);
    fieldColor = mix(fieldColor, cHole, holeInk);
    vColor = fieldColor * fade * fieldInk * (1.0 + localInk * 1.7 + uLocalFocus * 0.65) * mix(0.85, 1.24, tVis) * mix(0.9, 0.14, aEnd) * uOpacity * mix(1.0, 0.74, uLoadShed) * mix(0.46, 1.0, visibleTime);
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

    const refs = new Float32Array(NPART * 2 * 2);
    const ends = new Float32Array(NPART * 2);
    for (let i = 0; i < NPART; i++) {
        const u = ((i % TEXW) + .5) / TEXW, v = (Math.floor(i / TEXW) + .5) / TEXW;
        refs[i * 4] = u; refs[i * 4 + 1] = v;
        refs[i * 4 + 2] = u; refs[i * 4 + 3] = v;
        ends[i * 2] = 0; ends[i * 2 + 1] = 1;
    }
    const geom = new THREE.BufferGeometry();
    // positions come from the texture; the attribute only exists so three.js
    // has a draw count
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NPART * 2 * 3), 3));
    geom.setAttribute("ref", new THREE.BufferAttribute(refs, 2));
    geom.setAttribute("aEnd", new THREE.BufferAttribute(ends, 1));
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

let lastR = 0, lastCx = 0, lastCz = 0;
const smoothCenter = new THREE.Vector3();
let smoothR = 0;
const bhRiverPos = new THREE.Vector3();
const riverStarPick = [];
// bodies: 0 earth, 1 moon, 2 sun, 3..9 planets, then player holes and stars
export function updateRiver(dtSim, fB, earthV, moonV, sunPosV, plPos, dtReal = 0) {
    river.dtVis = dtSim;
    if (!river.enabled) return;
    const fEff = fB;
    lines.visible = fEff > .01;
    const planeBias = smooth01(6000, 420000, cam.dist);
    let localFocus = 0;
    const earthCamD = WORLD.earthDestroyed ? Infinity : camera.position.distanceTo(earthV);
    const earthClear = Math.max(0, earthCamD - R_EARTH * K);
    if (!WORLD.earthDestroyed) {
        const orbitalView = 1 - smooth01(0.06, 9.5, earthClear);
        const lowOrbitView = 1 - smooth01(0.18, 80, earthClear);
        localFocus = Math.max(localFocus, Math.max(orbitalView, lowOrbitView * .92));
    }
    if (!WORLD.moonDestroyed) {
        const clear = Math.max(0, camera.position.distanceTo(moonV) - R_MOON * K);
        localFocus = Math.max(localFocus, 0.82 * (1 - smooth01(16, 180, clear)));
    }
    if (!WORLD.sunDestroyed) {
        const clear = Math.max(0, camera.position.distanceTo(sunPosV) - SUN_RADIUS);
        localFocus = Math.max(localFocus, 0.96 * (1 - smooth01(SUN_RADIUS * 0.18, SUN_RADIUS * 7.5, clear)));
    }
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        const sink = PL[i].R * K;
        const clear = Math.max(0, camera.position.distanceTo(plPos[i]) - sink);
        localFocus = Math.max(localFocus, 0.95 * (1 - smooth01(Math.max(8, sink * 1.5), Math.max(90, sink * 34), clear)));
    }
    for (let i = 0; i < BH.n; i++) {
        bhRiverPos.set(earthV.x + BH.sx[i], earthV.y, earthV.z + BH.sz[i]);
        const sink = Math.max(BH.sinkS[i], .45);
        const clear = Math.max(0, camera.position.distanceTo(bhRiverPos) - sink);
        localFocus = Math.max(localFocus, 0.97 * (1 - smooth01(Math.max(16, sink * 3), Math.max(220, sink * 120), clear)));
    }
    const nearEarthLoad = (1 - smooth01(38, 760, earthClear)) * (1 - smooth01(R_EARTH * K * 28, R_EARTH * K * 150, earthCamD));
    const loadShed = Math.max(0, Math.min(1, nearEarthLoad * (1 - localFocus * .78)));
    uniformsShared.uLoadShed.value = loadShed;
    uniformsShared.uLocalFocus.value = localFocus;
    uniformsShared.uOpacity.value = .44 * fEff * (1 + planeBias * .62 + localFocus * 1.15) * (1 - loadShed * .12);
    const drawFrac = Math.max(.62, 1 - loadShed * .28, .78 + localFocus * .22);
    lines.geometry.setDrawRange(0, Math.floor(NPART * drawFrac) * 2);
    if (!lines.visible) return;

    const cd = camera.position.distanceTo(cam.tgt);
    const localMinR = localFocus > .05 ? Math.max(10, Math.min(72, earthClear * 5.5 + 9)) : 16;
    const targetR = Math.min(1.2e8, Math.max(localMinR, cd * (localFocus > .05 ? 4.2 : 2.8)));
    const c = cam.tgt;
    let respawn = .006;
    if (smoothR === 0) {
        smoothCenter.copy(c);
        smoothR = targetR;
        respawn = 1;
    } else {
        const move = Math.hypot(c.x - smoothCenter.x, c.y - smoothCenter.y, c.z - smoothCenter.z);
        const zoomDelta = Math.abs(Math.log(Math.max(1e-9, targetR / smoothR)));
        const easeC = Math.min(1, .08 + dtReal * 8);
        const easeR = Math.min(1, .05 + dtReal * 5);
        smoothCenter.lerp(c, easeC);
        smoothR += (targetR - smoothR) * easeR;
        respawn = Math.min(.09, .006 + zoomDelta * .025 + move / Math.max(smoothR, 1) * .045);
        if (zoomDelta > 2.2 || move > targetR * 2.5) {
            smoothCenter.copy(c);
            smoothR = targetR;
            respawn = .28;
        }
    }
    respawn = Math.min(.18, respawn + localFocus * .075);
    river.radius = smoothR;
    lastR = smoothR; lastCx = smoothCenter.x; lastCz = smoothCenter.z;
    uniformsShared.uCenter.value.copy(smoothCenter);
    uniformsShared.uOrigin.value.copy(earthV);
    uniformsShared.uRadius.value = smoothR;
    uniformsShared.uCam.value.copy(camera.position);
    uniformsShared.uRespawn.value = respawn;
    uniformsShared.uDE.value = G.darkEnergy ? DARK_ENERGY.H_SIM : 0;
    uniformsShared.uPlaneBias.value = planeBias;
    uniformsShared.uTimeRate.value = dtReal > 0 ? Math.max(1, dtSim / dtReal) : 1;
    uniformsShared.uTick.value = (uniformsShared.uTick.value + .618) % 64;

    bodyVals[0].set(earthV.x, earthV.y, earthV.z, WORLD.earthDestroyed ? 0 : FLOW.CE);
    sinkVals[0] = R_EARTH * K + .6;
    rsVals[0] = rsScene(MU_E);
    holeVals[0] = 0;
    colorVals[0].set(0.22, 0.48, 1.0);
    bodyVals[1].set(moonV.x, moonV.y, moonV.z, WORLD.moonDestroyed ? 0 : FLOW.CM);
    sinkVals[1] = R_MOON * K + .5;
    rsVals[1] = rsScene(MU_M);
    holeVals[1] = 0;
    colorVals[1].set(0.72, 0.76, 0.82);
    bodyVals[2].set(sunPosV.x, sunPosV.y, sunPosV.z, WORLD.sunDestroyed ? 0 : FLOW.CS);
    sinkVals[2] = SUN_RADIUS * 1.08;
    rsVals[2] = rsScene(MU_S);
    holeVals[2] = 0;
    colorVals[2].set(1.0, 0.55, 0.13);
    for (let i = 0; i < PL.length; i++) {
        bodyVals[3 + i].set(plPos[i].x, plPos[i].y, plPos[i].z, WORLD.plDestroyed[i] ? 0 : .001 * Math.sqrt(2 * PL[i].mu / 1000));
        sinkVals[3 + i] = PL[i].R * K;
        rsVals[3 + i] = rsScene(PL[i].mu);
        holeVals[3 + i] = 0;
        colorTmp.setHex(PL[i].color);
        colorVals[3 + i].set(colorTmp.r, colorTmp.g, colorTmp.b);
    }
    let nb = 3 + PL.length;
    for (let i = 0; i < BH.n && nb < MAXB; i++, nb++) {
        bodyVals[nb].set(earthV.x + BH.sx[i], earthV.y, earthV.z + BH.sz[i], BH.c[i] * Math.max(.08, BH.obsT[i] || 1));
        sinkVals[nb] = BH.sinkS[i];
        rsVals[nb] = BH.rs[i] * K;
        holeVals[nb] = 1;
        colorVals[nb].set(0.5, 0.72, 1.0);
    }
    riverStarPick.length = 0;
    for (let i = 0; i < STARS.length; i++) {
        const s = STARS[i];
        const sx = s.x * K, sy = (s.z || 0) * K, sz = -s.y * K;
        const source = .001 * Math.sqrt(2 * s.mu / 1000);
        const sink = (s.bh ? s.rs : s.R) * K;
        const d = Math.max(sink, Math.hypot(smoothCenter.x - sx, smoothCenter.y - sy, smoothCenter.z - sz));
        riverStarPick.push({ i, score: source / Math.sqrt(d) * (s.bh ? 4 : 1) });
    }
    riverStarPick.sort((a, b) => b.score - a.score);
    for (let p = 0; p < riverStarPick.length && p < RIVER_STAR_SOURCE_MAX && nb < MAXB; p++, nb++) {
        const s = STARS[riverStarPick[p].i];
        bodyVals[nb].set(s.x * K, (s.z || 0) * K, -s.y * K, .001 * Math.sqrt(2 * s.mu / 1000));
        sinkVals[nb] = (s.bh ? s.rs : s.R) * K;
        rsVals[nb] = (s.bh ? s.rs : 2 * s.mu / C2) * K;
        holeVals[nb] = s.bh ? 1 : 0;
        colorTmp.setHex(s.color);
        colorVals[nb].set(colorTmp.r, colorTmp.g, colorTmp.b);
    }
    uniformsShared.uNB.value = nb;
    // color/length normalization follows the same absolute field as the
    // shader, using a local representative radius for each source.
    let best = 0, bestS = -1, bestTyp = .01;
    const typSamples = [];
    for (let i = 0; i < nb; i++) {
        const dC = Math.max(sinkVals[i], Math.hypot(smoothCenter.x - bodyVals[i].x, smoothCenter.y - bodyVals[i].y, smoothCenter.z - bodyVals[i].z));
        const typ = bodyVals[i].w / Math.sqrt(Math.max(sinkVals[i], Math.max(dC - smoothR, sinkVals[i])));
        typSamples.push(typ);
        if (typ > bestS) { bestS = typ; best = i; bestTyp = typ; }
    }
    typSamples.sort((a, b) => a - b);
    const robustTyp = typSamples[Math.max(0, Math.floor(typSamples.length * .72))] || bestTyp;
    uniformsShared.uVRef.value = Math.max(.01, Math.min(bestTyp, robustTyp * 6));
    // River motion follows simulated time. At real time the field is almost
    // still at solar-system scale; higher warp advances it proportionally,
    // while the compute shader caps per-frame displacement inside the volume.
    const dtVis = dtSim > 0 ? dtSim : 0;
    river.dtVis = dtVis;
    uniformsShared.uDtSim.value = dtVis;

    if (dtVis > 0 || respawn > .001) {
        const prevRT = renderer.getRenderTarget();
        renderer.setRenderTarget(rtB);
        renderer.render(computeScene, computeCam);
        renderer.setRenderTarget(prevRT);
        const sw = rtA; rtA = rtB; rtB = sw;
        uniformsShared.uPos.value = rtA.texture;
    }
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
let shellAnchor = "earth";
export function updateShells(dtSim, fB) {
    const anchor = camera.position.length() < 2600 && cam.dist < 1800 ? "earth" : "none";
    if (anchor !== shellAnchor) {
        shellAnchor = anchor;
        for (const sh of shellsE) sh.r = sh.rOut * (.3 + .7 * Math.random());
    }
    if (fB > .01 && anchor !== "none") {
        const shC = FLOW.CE;
        const shSink = R_EARTH * K + .6;
        for (const sh of shellsE) {
            const rOutEff = sh.rOut;
            sh.r -= (shC / Math.sqrt(Math.max(1, sh.r))) * dtSim;
            if (sh.r < shSink || sh.r > rOutEff * 1.2) sh.r = rOutEff * (0.86 + 0.26 * Math.random());
            sh.obj.position.set(0, 0, 0);
            sh.obj.scale.setScalar(sh.r);
            sh.obj.material.size = .95;
            sh.obj.visible = true;
            const oo = fB * .42 * Math.min(1, (rOutEff - sh.r) / (rOutEff * .082)) * Math.min(1, (sh.r - shSink) / (rOutEff * .041));
            sh.obj.material.opacity = Math.max(0, oo);
        }
    } else {
        for (const sh of shellsE) sh.obj.visible = false;
    }
}
