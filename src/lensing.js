import * as THREE from "three";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { K } from "./constants.js";
import { BH } from "./state.js";
import { eph } from "./ephemeris.js";
import { ACTIVE_STARS } from "./universe/activeStars.js";

// Gravitational lensing as a screen-space post pass, applied to the world
// render before bloom. Up to four strongest lenses per frame.
const MAXL = 4;

export const lensingPass = new ShaderPass(new THREE.ShaderMaterial({
    uniforms: {
        tDiffuse: { value: null },
        uN: { value: 0 },
        uC: { value: Array.from({ length: MAXL }, () => new THREE.Vector2()) },
        uT2: { value: new Float32Array(MAXL) },
        uAspect: { value: 1 },
        uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform int uN;
        uniform vec2 uC[${MAXL}];
        uniform float uT2[${MAXL}];
        uniform float uAspect;
        uniform vec2 uTexel;
        varying vec2 vUv;
        vec4 lensSample(vec2 uv){
            uv = clamp(uv, 0.0, 1.0);
            vec2 px = uTexel;
            vec4 c = texture2D(tDiffuse, uv) * 0.40;
            c += texture2D(tDiffuse, clamp(uv + vec2(px.x, 0.0), 0.0, 1.0)) * 0.15;
            c += texture2D(tDiffuse, clamp(uv - vec2(px.x, 0.0), 0.0, 1.0)) * 0.15;
            c += texture2D(tDiffuse, clamp(uv + vec2(0.0, px.y), 0.0, 1.0)) * 0.15;
            c += texture2D(tDiffuse, clamp(uv - vec2(0.0, px.y), 0.0, 1.0)) * 0.15;
            return c;
        }
        void main(){
            vec2 p = vUv * 2.0 - 1.0;
            p.x *= uAspect;
            vec2 q = p;
            for (int i = 0; i < ${MAXL}; i++) {
                if (i >= uN) break;
                vec2 d = p - uC[i];
                float r2 = max(dot(d, d), 1e-9);
                q -= d * (uT2[i] / r2);
            }
            q.x /= uAspect;
            gl_FragColor = lensSample(q * 0.5 + 0.5);
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
    cands.push({ cx, cy, t2: t * t });
}

export function updateLensing(camera, aspect) {
    _cand.length = 0;
    const f = 1 / Math.tan(camera.fov * Math.PI / 360);
    for (let i = 0; i < BH.n; i++) {
        consider(_cand, (eph.earthX + BH.x[i]) * K, 0, -(eph.earthY + BH.y[i]) * K, BH.rs[i] * K, camera, f);
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
    }
    return true;
}
