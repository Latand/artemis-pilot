import * as THREE from "three";
import { DARK_ENERGY, FLOW, PL, K, R_EARTH, R_MOON, SUN_RADIUS } from "./constants.js";
import { G, BH, WORLD } from "./state.js";
import { mulberry32 } from "./format.js";
import { dotTexture } from "./textures.js";
import { scene, renderer, camera, cam } from "./scene.js";

// GPU river: one particle volume that follows the camera at ANY scale.
// Positions live in a float texture advected by a compute pass; the analytic
// flow field v(r) = Σ −r̂·C_i/√r_i (same formula as flowfield.js) is evaluated
// in-shader, so 100k+ streaks cost the CPU nothing. Replaces the old CPU
// streaks + local bubble, which only existed near Earth or the Sun.
const TEXW = (() => {
    const m = location.search.match(/np=(\d+)/);
    const v = m ? +m[1] : 176; // ~31k streaks ≈ double the original CPU density
    return Math.min(1024, Math.max(64, v));
})();
const NPART = TEXW * TEXW;
const MAXB = 16; // earth + moon + sun + 7 planets + up to 6 black holes

export const river = { enabled: false, radius: 22, count: NPART };

let rtA, rtB, computeScene, computeCam, computeMat, lineMat, lines;
const bodyVals = [], sinkVals = new Array(MAXB).fill(0);
for (let i = 0; i < MAXB; i++) bodyVals.push(new THREE.Vector4());
const uniformsShared = {
    uPos: { value: null },
    uDtSim: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uOrigin: { value: new THREE.Vector3() },
    uRadius: { value: 22 },
    uCam: { value: new THREE.Vector3() },
    uTick: { value: 0 },
    uForce: { value: 1 },
    uNB: { value: 10 },
    uBody: { value: bodyVals },
    uSink: { value: sinkVals },
    uVRef: { value: .01 },
    uOpacity: { value: 0 },
    uDE: { value: 0 },
};

const FLOW_GLSL = /* glsl */`
uniform int uNB;
uniform vec4 uBody[${MAXB}];
uniform float uSink[${MAXB}];
uniform float uRadius;
uniform vec3 uCenter;
uniform vec3 uOrigin;
uniform float uDE;
// Relative river: bodies far outside the viewed volume contribute their tidal
// residual by subtracting bulk flow at the volume center. This keeps local
// structure readable when a distant massive body dominates the raw vector.
vec3 flowField(vec3 p) {
    vec3 v = vec3(0.0);
    float rM = length(p - uBody[1].xyz);
    float q = clamp((rM - 20.0) / 120.0, 0.0, 1.0);
    q = q * q * (3.0 - 2.0 * q);
    float earthW = 0.32 + 0.68 * q;
    for (int i = 0; i < ${MAXB}; i++) {
        if (i >= uNB) break;
        vec3 d = p - uBody[i].xyz;
        float r = max(uSink[i] * 0.5, length(d));
        float s = uBody[i].w * inversesqrt(r) / r;
        if (i == 0) s *= earthW;
        vec3 dC = uCenter - uBody[i].xyz;
        float rC = max(uSink[i] * 0.5, length(dC));
        float sC = uBody[i].w * inversesqrt(rC) / rC;
        float w = smoothstep(uRadius * 0.9, uRadius * 1.8, length(dC));
        v += -d * s + w * dC * sC;
    }
    v += (p - uOrigin) * uDE;
    return v;
}
float hash13(vec3 p3) {
    p3 = fract(p3 * .1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}`;

const COMPUTE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uPos;
uniform float uDtSim, uTick, uForce;
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
    bool kill = uForce > 0.5;
    if (distance(p, uCenter) > uRadius * 1.04) kill = true;
    for (int i = 0; i < ${MAXB}; i++) {
        if (i >= uNB) break;
        if (distance(p, uBody[i].xyz) < uSink[i]) { kill = true; break; }
    }
    if (hash13(vec3(vUv * 913.7, uTick)) < 0.002) kill = true;
    if (kill) {
        float h1 = hash13(vec3(vUv * 127.1, uTick + 0.17));
        float h2 = hash13(vec3(vUv * 311.7, uTick + 1.31));
        float h3 = hash13(vec3(vUv * 74.7, uTick + 2.07));
        float ph = acos(2.0 * h1 - 1.0), th = 6.2831853 * h2;
        float rr = uRadius * pow(h3, 0.72);
        p = uCenter + vec3(sin(ph) * cos(th), cos(ph), sin(ph) * sin(th)) * rr;
        // never spawn inside a sink: push out radially
        for (int i = 0; i < ${MAXB}; i++) {
            if (i >= uNB) break;
            vec3 d = p - uBody[i].xyz;
            float r = length(d);
            if (r < uSink[i] * 1.15)
                p = uBody[i].xyz + d / max(r, 1e-6) * (uSink[i] * (1.2 + 2.0 * h2));
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
    float t = clamp(spd / (uVRef * 0.55), 0.0, 1.0);
    float L = uRadius * (0.007 + 0.042 * t);
    vec3 tail = p - v / spd * L;
    vec3 pos = mix(p, tail, aEnd);
    // fades: volume edge, camera proximity, sink proximity
    float fade = clamp(1.0 - (distance(p, uCenter) - uRadius * 0.8) / (uRadius * 0.2), 0.0, 1.0);
    fade *= clamp((distance(p, uCam) - uRadius * 0.1) / (uRadius * 0.45), 0.0, 1.0);
    fade *= 0.55 + 0.45 * hash13(vec3(ref * 53.7, 7.77)); // per-streak variety
    for (int i = 0; i < ${MAXB}; i++) {
        if (i >= uNB) break;
        float dB = distance(p, uBody[i].xyz);
        fade *= clamp((dB - uSink[i]) / (uSink[i] * 1.5 + uRadius * 0.02), 0.0, 1.0);
    }
    // golden when the Sun's river dominates locally, violet when expansion wins
    float sunPart = uBody[2].w * inversesqrt(max(uSink[2] * 0.5, distance(p, uBody[2].xyz)));
    float gold = smoothstep(0.5, 0.95, clamp(sunPart / spd, 0.0, 1.0));
    float expPart = length((p - uOrigin) * uDE);
    // only tint where expansion truly dominates the local flow — with the
    // Earth-centered origin a loose threshold painted the whole 1 AU shell
    float violet = smoothstep(0.62, 0.97, clamp(expPart / spd, 0.0, 1.0));
    vec3 cBlue = vec3(0.16 + 0.5 * t, 0.4 + 0.45 * t, 0.6 + 0.4 * t);
    vec3 cGold = vec3(0.6 + 0.4 * t, 0.34 + 0.42 * t, 0.12 + 0.26 * t);
    vec3 cViolet = vec3(0.38 + 0.3 * t, 0.22 + 0.26 * t, 0.85 + 0.15 * t);
    vColor = mix(mix(cBlue, cGold, gold), cViolet, violet) * fade * mix(0.9, 0.12, aEnd) * uOpacity;
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
    // seed texture: random sphere, replaced on the first forced respawn anyway
    const seed = new Float32Array(NPART * 4);
    const rnd = mulberry32(20260612);
    for (let i = 0; i < NPART; i++) {
        const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1), r = 22 * Math.cbrt(rnd());
        seed[i * 4] = r * Math.sin(ph) * Math.cos(th);
        seed[i * 4 + 1] = r * Math.cos(ph);
        seed[i * 4 + 2] = r * Math.sin(ph) * Math.sin(th);
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
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    lines = new THREE.LineSegments(geom, lineMat);
    lines.frustumCulled = false;
    lines.renderOrder = 1;
    scene.add(lines);
    river.enabled = true;
}

let lastR = 0, lastCx = 0, lastCz = 0;
// bodies: 0 earth, 1 moon, 2 sun, 3..9 planets, 10+ black holes
export function updateRiver(dtSim, fB, earthV, moonV, sunPosV, plPos, dtReal = 0) {
    river.dtVis = dtSim;
    if (!river.enabled) return;
    lines.visible = fB > .01;
    uniformsShared.uOpacity.value = .26 * fB;
    if (!lines.visible) return;

    const cd = camera.position.distanceTo(cam.tgt);
    const R = Math.min(1.2e8, Math.max(16, cd * 2.8));
    river.radius = R;
    const c = cam.tgt;
    let force = 0;
    if (lastR === 0 || R > lastR * 1.45 || R < lastR * .55 ||
        Math.hypot(c.x - lastCx, c.z - lastCz) > R * .5) {
        force = 1; lastR = R; lastCx = c.x; lastCz = c.z;
    }
    uniformsShared.uCenter.value.set(c.x, c.y, c.z);
    uniformsShared.uOrigin.value.copy(earthV);
    uniformsShared.uRadius.value = R;
    uniformsShared.uCam.value.copy(camera.position);
    uniformsShared.uForce.value = force;
    uniformsShared.uDE.value = G.darkEnergy ? DARK_ENERGY.H_SIM : 0;
    uniformsShared.uTick.value = (uniformsShared.uTick.value + .618) % 64;

    bodyVals[0].set(earthV.x, earthV.y, earthV.z, WORLD.earthDestroyed ? 0 : FLOW.CE);
    sinkVals[0] = R_EARTH * K + .6;
    bodyVals[1].set(moonV.x, moonV.y, moonV.z, WORLD.moonDestroyed ? 0 : FLOW.CM);
    sinkVals[1] = R_MOON * K + .5;
    bodyVals[2].set(sunPosV.x, sunPosV.y, sunPosV.z, WORLD.sunDestroyed ? 0 : FLOW.CS);
    sinkVals[2] = SUN_RADIUS + 10;
    for (let i = 0; i < PL.length; i++) {
        bodyVals[3 + i].set(plPos[i].x, plPos[i].y, plPos[i].z, WORLD.plDestroyed[i] ? 0 : .001 * Math.sqrt(2 * PL[i].mu / 1000));
        sinkVals[3 + i] = PL[i].R * K;
    }
    let nb = 3 + PL.length;
    for (let i = 0; i < BH.n && nb < MAXB; i++, nb++) {
        bodyVals[nb].set(earthV.x + BH.sx[i], earthV.y, earthV.z + BH.sz[i], BH.c[i] * Math.max(.08, BH.obsT[i] || 1));
        sinkVals[nb] = BH.sinkS[i];
    }
    uniformsShared.uNB.value = nb;
    // color/length normalization: the body whose flow dominates the volume.
    // Bodies far outside the volume only count their tidal residual, matching
    // the relative field rendered by the shader.
    let best = 0, bestS = -1, bestTyp = .01;
    for (let i = 0; i < nb; i++) {
        const dC = Math.max(sinkVals[i], Math.hypot(c.x - bodyVals[i].x, c.y - bodyVals[i].y, c.z - bodyVals[i].z));
        const vC = bodyVals[i].w / Math.sqrt(dC);
        const far = dC > R * 1.35;
        const typ = far ? vC * Math.min(1, R / (2 * dC)) : bodyVals[i].w / Math.sqrt(Math.max(sinkVals[i], Math.max(dC - R, sinkVals[i])));
        if (typ > bestS) { bestS = typ; best = i; bestTyp = far ? typ * 4 : bodyVals[i].w / Math.sqrt(sinkVals[i]); }
    }
    uniformsShared.uVRef.value = Math.max(.01, bestTyp);
    // visualization floor: zoomed in at low warp the physical inflow moves
    // subpixel per frame — advect at least fast enough that the dominant flow
    // crosses ~8 % of the volume per real second, so the river drag reads at
    // any zoom. True sim time takes over as soon as warp makes it faster.
    const dtVis = dtSim > 0
        ? Math.max(dtSim, dtReal * R * .08 / Math.max(uniformsShared.uVRef.value, 1e-9))
        : 0;
    river.dtVis = dtVis;
    uniformsShared.uDtSim.value = dtVis;

    if (dtVis > 0 || force) {
        const prevRT = renderer.getRenderTarget();
        renderer.setRenderTarget(rtB);
        renderer.render(computeScene, computeCam);
        renderer.setRenderTarget(prevRT);
        const sw = rtA; rtA = rtB; rtB = sw;
        uniformsShared.uPos.value = rtA.texture;
    }
}

// ---- collapsing dot-shells around the dominant anchor (Earth or Sun) ----
const SUNVOL = 3200, SUN_SINK = SUN_RADIUS + 10;
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
export function updateShells(dtSim, fB, sunPosV) {
    const dCamS = camera.position.distanceTo(sunPosV);
    const anchor = dCamS < 6500 ? "sun" : (camera.position.length() < 2600 ? "earth" : "none");
    if (anchor !== shellAnchor) {
        shellAnchor = anchor;
        for (const sh of shellsE) sh.r = (anchor === "sun" ? SUNVOL * .85 : sh.rOut) * (.3 + .7 * Math.random());
    }
    if (fB > .01 && anchor !== "none") {
        const sunAnchor = anchor === "sun";
        const shC = sunAnchor ? FLOW.CS : FLOW.CE;
        const shSink = sunAnchor ? SUN_SINK : R_EARTH * K + .6;
        for (const sh of shellsE) {
            const rOutEff = sunAnchor ? SUNVOL * .85 : sh.rOut;
            sh.r -= (shC / Math.sqrt(Math.max(1, sh.r))) * dtSim;
            if (sh.r < shSink || sh.r > rOutEff * 1.2) sh.r = rOutEff * (0.86 + 0.26 * Math.random());
            sh.obj.position.set(sunAnchor ? sunPosV.x : 0, 0, sunAnchor ? sunPosV.z : 0);
            sh.obj.scale.setScalar(sh.r);
            sh.obj.material.size = sunAnchor ? 13 : .95;
            sh.obj.visible = true;
            const oo = fB * .42 * Math.min(1, (rOutEff - sh.r) / (rOutEff * .082)) * Math.min(1, (sh.r - shSink) / (rOutEff * .041));
            sh.obj.material.opacity = Math.max(0, oo);
        }
    } else {
        for (const sh of shellsE) sh.obj.visible = false;
    }
}
