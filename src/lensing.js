import * as THREE from "three";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { K } from "./constants.js";
import { BH } from "./state.js";
import { eph } from "./ephemeris.js";
import { ACTIVE_STARS } from "./universe/activeStars.js";
import { composer, renderer, TIER_SPLIT_UNITS } from "./scene.js";
import { holeRoot } from "./holeOptics.js";

// Gravitational lensing as a screen-space post pass, applied to the world
// render before bloom. Up to four strongest lenses per frame, each a point
// lens for sources far behind it: a pixel at angle theta from the lens shows
// the sky at beta = theta - theta_E^2 / theta, theta_E = sqrt(2 r_s / d).
//
// Only what lies behind a lens is lensed. The holes' own light (shadow,
// photon ring, accretion disk, tidal debris: holeRoot) sits at the lens, so
// the pass renders the world without holeRoot, bends it, and then draws
// holeRoot unbent on top; a body in front of a hole (the star it is about to
// disrupt, say) is left alone by comparing the world pass's depth with the
// lens's distance. The shadow itself (angular radius sqrt(27)/2 r_s / d) is
// geometry in holeRoot.
const MAXL = 4;

class LensPass extends ShaderPass {
    constructor(material) {
        super(material);
        this.camera = null;
    }
    render(rendererArg, writeBuffer, readBuffer, deltaTime, maskActive) {
        const u = this.uniforms;
        u.tDepth.value = readBuffer.depthTexture || null;
        u.uHasDepth.value = readBuffer.depthTexture ? 1 : 0;
        super.render(rendererArg, writeBuffer, readBuffer, deltaTime, maskActive);
        if (!this.camera) { holeRoot.visible = true; return; }
        // the holes' own optics over the lensed world (their depth relations are
        // analytic, so a cleared depth buffer is all they need)
        const oldAutoClear = rendererArg.autoClear;
        rendererArg.autoClear = false;
        rendererArg.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        rendererArg.clearDepth();
        holeRoot.visible = true;
        rendererArg.render(holeRoot, this.camera);
        rendererArg.autoClear = oldAutoClear;
    }
}

export const lensingPass = new LensPass(new THREE.ShaderMaterial({
    uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uHasDepth: { value: 0 },
        uNear: { value: .02 },
        uFar: { value: 1e8 },
        uDist: { value: new Float32Array(MAXL) },
        uN: { value: 0 },
        uC: { value: Array.from({ length: MAXL }, () => new THREE.Vector2()) },
        uT2: { value: new Float32Array(MAXL) },
        uAspect: { value: 1 },
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform int uHasDepth;
        uniform float uNear, uFar;
        uniform float uDist[${MAXL}];
        uniform int uN;
        uniform vec2 uC[${MAXL}];
        uniform float uT2[${MAXL}];
        uniform float uAspect;
        varying vec2 vUv;
        void main(){
            vec2 p = vUv * 2.0 - 1.0;
            p.x *= uAspect;
            vec2 q = p;
            // view depth of what the world pass drew here (the near tier's
            // projection; the far tier leaves the cleared depth, i.e. "far")
            float zv = 1e30;
            if (uHasDepth == 1) {
                float dz = texture2D(tDepth, vUv).x;
                if (dz < 1.0) zv = uNear * uFar / (uFar - dz * (uFar - uNear));
            }
            for (int i = 0; i < ${MAXL}; i++) {
                if (i >= uN) break;
                if (zv < uDist[i]) continue;          // in front of this lens
                vec2 d = p - uC[i];
                float r2 = max(dot(d, d), 1e-9);
                q -= d * (uT2[i] / r2);
            }
            q.x /= uAspect;
            gl_FragColor = texture2D(tDiffuse, clamp(q * 0.5 + 0.5, 0.0, 1.0));
        }`,
}));
lensingPass.enabled = false;

const _v = new THREE.Vector3();
const _cand = [];
function consider(cands, wx, wy, wz, rsU, camera, f) {
    _v.set(wx, wy, wz).applyMatrix4(camera.matrixWorldInverse);
    if (_v.z > -1e-9) return;
    const d = _v.length();
    if (d < rsU * 1.5) return;
    const t = Math.min(f * Math.tan(Math.min(Math.sqrt(2 * rsU / d), .6)), .55);
    if (t < .004) return;
    const cx = f * (_v.x / -_v.z), cy = f * (_v.y / -_v.z);
    if (Math.hypot(cx, cy) > 4) return;
    cands.push({ cx, cy, t2: t * t, z: -_v.z });
}

// ?lens=0 disables the pass (inspection and captures of the unlensed scene)
const lensOff = typeof location !== "undefined" && new URLSearchParams(location.search).get("lens") === "0";
export function updateLensing(camera, aspect) {
    _cand.length = 0;
    holeRoot.visible = true;
    if (lensOff || renderer.xr.isPresenting) { lensingPass.enabled = false; return false; }
    const f = 1 / Math.tan(camera.fov * Math.PI / 360);
    for (let i = 0; i < BH.n; i++) {
        consider(_cand, (eph.earthX + BH.x[i]) * K, BH.z[i] * K, -(eph.earthY + BH.y[i]) * K, BH.rs[i] * K, camera, f);
    }
    for (const s of ACTIVE_STARS) {
        if (s.bh) consider(_cand, s.x * K, (s.z || 0) * K, -s.y * K, s.rs * K, camera, f);
    }
    _cand.sort((a, b) => b.t2 - a.t2);
    const n = Math.min(MAXL, _cand.length);
    lensingPass.enabled = n > 0;
    if (!n) return false;
    const u = lensingPass.uniforms;
    u.uN.value = n;
    u.uAspect.value = aspect;
    for (let i = 0; i < n; i++) {
        u.uC.value[i].set(_cand[i].cx, _cand[i].cy);
        u.uT2.value[i] = _cand[i].t2;
        u.uDist.value[i] = _cand[i].z;
    }
    // the near tier's projection, which wrote the depth the pass reads
    u.uNear.value = camera.near;
    u.uFar.value = Math.min(camera.far, TIER_SPLIT_UNITS);
    lensingPass.camera = camera;
    // the world pass leaves the holes' optics out only when this pass will
    // draw them (the composer is built and carries it)
    if (composer && composer.passes.includes(lensingPass)) holeRoot.visible = false;
    return true;
}
