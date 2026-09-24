// Physical optics of a placed black hole, all in simulation time:
//
//  * shadow — a black disc of radius sqrt(27)/2 r_s ~ 2.6 r_s (the critical
//    impact parameter), i.e. angular radius 2.6 r_s / d from afar;
//  * photon ring — the thin bright rim just outside it, lit by the disk (or,
//    faintly, by starlight);
//  * accretion disk — an annulus from the ISCO (3 r_s) outward with a
//    Novikov–Thorne-like temperature T ~ r^-3/4 (1 - sqrt(r_in/r))^1/4 scaled
//    by the accretion rate, rotating at the local circular (Paczynski–Wiita)
//    angular velocity in sim time, seen with Doppler beaming and
//    gravitational redshift: colour from the observed temperature T g,
//    brightness x g^4, g = sqrt(1 - 3 r_s / 2r) / (1 - beta cos psi). Where an
//    orbit is shorter than the sim time a rendered frame spans, the disk shows
//    the orbit-averaged ring instead of a strobing pattern;
//  * jet — only for an explicitly jetted source, launched once the disk
//    exists and growing at ~c in sim time.
//
// Everything lives under holeRoot. The screen-space lens (lensing.js) bends
// the world rendered WITHOUT holeRoot and then draws holeRoot unbent on top,
// so a hole never lenses its own disk as if it were a background source.
// Occlusion by the shadow is analytic (behind the hole's plane of the sky and
// inside its apparent radius), not a depth-buffer test: at interplanetary
// distances one depth quantum spans the whole disk.
import * as THREE from "three";
import { K } from "./constants.js";
import { scene } from "./scene.js";

export const SHADOW_RS = Math.sqrt(27) / 2; // shadow radius / r_s
export const holeRoot = new THREE.Group();
holeRoot.name = "hole.optics";
scene.add(holeRoot);

// ---- GLSL ----
const GLSL_BLACKBODY = /* glsl */`
    // Tanner Helland blackbody fit, linear RGB, max component 1
    vec3 blackbody(float T) {
        float t = clamp(T / 100.0, 10.0, 400.0);
        float r, g, b;
        if (t <= 66.0) { r = 1.0; g = (99.4708025861 * log(t) - 161.1195681661) / 255.0; }
        else { r = 329.698727446 * pow(t - 60.0, -0.1332047592) / 255.0; g = 288.1221695283 * pow(t - 60.0, -0.0755148492) / 255.0; }
        if (t >= 66.0) b = 1.0; else if (t <= 19.0) b = 0.0; else b = (138.5177312231 * log(t - 10.0) - 305.0447927307) / 255.0;
        return pow(clamp(vec3(r, g, b), 0.0, 1.0), vec3(2.2));
    }`;
const GLSL_NOISE = /* glsl */`
    float hash3(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float vnoise(vec3 x) {
        vec3 i = floor(x), f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x),
                       mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x),
                       mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
    }
    float fbm(vec3 p) {
        float a = 0.5, s = 0.0;
        for (int k = 0; k < 4; k++) { s += a * vnoise(p); p = p * 2.03 + vec3(11.7, 3.1, 5.3); a *= 0.5; }
        return s / 0.9375;
    }`;
// Analytic occlusion by the shadow. rel: world offset from the hole centre;
// uCamRel: camera minus hole centre (computed on the CPU in doubles).
export const GLSL_SHADOW_OCCLUSION = /* glsl */`
    uniform vec3 uCamRel;
    uniform float uShadowR;
    float shadowed(vec3 rel) {
        float D = length(uCamRel);
        vec3 v = -uCamRel / max(D, 1e-30);   // camera -> hole
        float s = dot(rel, v);                // > 0: beyond the hole's plane of the sky
        if (s <= 0.0) return 0.0;
        vec3 perp = rel - s * v;
        return length(perp) * D / (D + s) < uShadowR ? 1.0 : 0.0;
    }`;

// camera-facing quad of half-size uR (scene units) centred on the object
const BILLBOARD_VS = /* glsl */`
    uniform float uR;
    varying vec2 vP;
    void main() {
        vP = position.xy;
        vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        gl_Position = projectionMatrix * (c + vec4(position.xy * uR, 0.0, 0.0));
    }`;

function makeShadow() {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        uniforms: { uR: { value: 1 } },
        vertexShader: BILLBOARD_VS,
        fragmentShader: /* glsl */`
            varying vec2 vP;
            void main() {
                if (dot(vP, vP) > 1.0) discard;
                gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            }`,
        // drawn after the (transparent) sky behind it and before the hole's own
        // additive light, which is occluded analytically; it writes no depth
        transparent: true, depthWrite: false, depthTest: true,
    }));
    m.frustumCulled = false;
    m.renderOrder = 6;
    return m;
}

const RING_SPAN = 1.3; // quad half-size in shadow radii
function makeRing() {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        uniforms: { uR: { value: 1 }, uColor: { value: new THREE.Vector3() }, uWidth: { value: .035 } },
        vertexShader: BILLBOARD_VS,
        fragmentShader: /* glsl */`
            uniform vec3 uColor;
            uniform float uWidth;
            varying vec2 vP;
            void main() {
                float rho = length(vP) * ${RING_SPAN.toFixed(2)}; // in shadow radii
                // the n = 1, 2 ... images pile up just outside the critical curve
                float d = (rho - 1.02) / uWidth;
                float a = exp(-d * d) + 0.35 * exp(-pow((rho - 1.08) / (2.5 * uWidth), 2.0));
                if (rho < 1.0 || a < 0.002) discard;
                gl_FragColor = vec4(uColor * a, a);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }`,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    }));
    m.frustumCulled = false;
    m.renderOrder = 8;
    return m;
}

function makeDisk() {
    // a square in the disk plane (local xy, normal +z), in units of r_in;
    // the fragment shader cuts the annulus
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        uniforms: {
            uRout: { value: 20 }, uRsL: { value: 1 / 3 }, uTmax: { value: 1e5 }, uGain: { value: 1 },
            uTauA: { value: 0 }, uTauB: { value: 0 }, uWA: { value: 1 }, uOmegaIn: { value: 1e-3 }, uFrameDt: { value: 0 },
            uAxisX: { value: new THREE.Vector3(1, 0, 0) }, uAxisY: { value: new THREE.Vector3(0, 0, -1) },
            uCamRel: { value: new THREE.Vector3(0, 1, 0) }, uShadowR: { value: 0 },
        },
        vertexShader: /* glsl */`
            uniform float uRout;
            varying vec2 vL;      // disk-plane position, units of r_in
            varying vec3 vRel;    // world offset from the hole centre (scene units)
            void main() {
                vL = position.xy * uRout;
                vec3 p = vec3(vL, 0.0);
                vRel = mat3(modelMatrix) * p;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
            }`,
        fragmentShader: /* glsl */`
            uniform float uRout, uRsL, uTmax, uGain, uTauA, uTauB, uWA, uOmegaIn, uFrameDt;
            uniform vec3 uAxisX, uAxisY;
            varying vec2 vL;
            varying vec3 vRel;
            ${GLSL_BLACKBODY}
            ${GLSL_NOISE}
            ${GLSL_SHADOW_OCCLUSION}
            void main() {
                float x = length(vL);                     // r / r_in
                if (x < 1.0 || x > uRout) discard;
                if (shadowed(vRel) > 0.5) discard;
                float phi = atan(vL.y, vL.x);
                // Novikov-Thorne-like profile, normalised to its peak at 49/36 r_in
                float f = pow(x, -0.75) * pow(max(0.0, 1.0 - inversesqrt(x)), 0.25) / 0.48805;
                float T = uTmax * f;
                // circular speed seen by a static observer sqrt(r_s / 2(r - r_s)),
                // Doppler + gravitational shift of that orbit toward the camera
                float beta = min(0.95, sqrt(uRsL / (2.0 * max(x - uRsL, 1e-3))));
                vec3 vdir = -sin(phi) * uAxisX + cos(phi) * uAxisY;
                vec3 n = normalize(uCamRel - vRel);
                float g = sqrt(max(0.0, 1.0 - 1.5 * uRsL / x)) / (1.0 - beta * dot(vdir, n));
                // Paczynski-Wiita circular angular velocity, relative to r_in
                float om = uOmegaIn * sqrt(1.0 / x) * (1.0 - uRsL) / (x - uRsL);
                // turbulence carried round at the local rate: two noise layers
                // cross-faded over a cycle (flow noise) so the shear never winds up
                float lr = log(x) * 7.0;
                float aA = phi - om * uTauA, aB = phi - om * uTauB;
                float nA = fbm(vec3(cos(aA) * 3.0, sin(aA) * 3.0, lr));
                float nB = fbm(vec3(cos(aB) * 3.0 + 7.1, sin(aB) * 3.0 - 3.3, lr + 1.7));
                float n0 = mix(nB, nA, uWA);
                // an orbit shorter than this frame's sim-time step: orbit-averaged ring
                float contrast = clamp(1.0 - om * uFrameDt / 3.0, 0.0, 1.0);
                float tex = max(0.0, 1.0 + 1.1 * contrast * (n0 - 0.5));
                float edge = smoothstep(uRout, uRout * 0.75, x);
                float g2 = g * g, f2 = f * f;
                float I = uGain * g2 * g2 * f2 * f2 * tex * edge;
                vec3 col = blackbody(T * g) * I;
                gl_FragColor = vec4(col, 1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }`,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    m.frustumCulled = false;
    m.renderOrder = 7;
    return m;
}

// twin cones along local +/-y, apex at the hole, opening half-angle ~3 deg
function makeJet() {
    const geo = new THREE.CylinderGeometry(.055, 0, 1, 24, 16, true);
    geo.translate(0, .5, 0);
    const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Vector3(.55, .75, 1) }, uI: { value: 0 }, uCamRel: { value: new THREE.Vector3(0, 1, 0) }, uShadowR: { value: 0 } },
        vertexShader: /* glsl */`
            varying float vS;
            varying vec3 vRel;
            varying vec3 vN;
            void main() {
                vS = position.y;
                vRel = mat3(modelMatrix) * position;
                vN = normalize(mat3(modelMatrix) * vec3(position.x + 1e-6, 0.0, position.z));
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: /* glsl */`
            uniform vec3 uColor;
            uniform float uI;
            varying float vS;
            varying vec3 vRel;
            varying vec3 vN;
            ${GLSL_SHADOW_OCCLUSION}
            void main() {
                if (shadowed(vRel) > 0.5) discard;
                vec3 view = normalize(uCamRel - vRel);
                float rim = 1.0 - abs(dot(vN, view));       // brighter toward the limbs
                float a = uI * (0.25 + 0.75 * rim * rim) * (1.0 - vS) * (1.0 - vS);
                gl_FragColor = vec4(uColor * a, a);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }`,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const g = new THREE.Group();
    const up = new THREE.Mesh(geo, mat), down = new THREE.Mesh(geo, mat);
    down.rotation.x = Math.PI;
    up.frustumCulled = down.frustumCulled = false;
    up.renderOrder = down.renderOrder = 9;
    g.add(up, down);
    g.userData.mat = mat;
    return g;
}

// The camera's offset from the hole, taken from the camera actually rendering
// (the frame's camera is placed after the visuals update). `holeOf` returns the
// Object3D sitting at the hole centre.
export function trackCameraRel(mesh, uniforms, holeOf) {
    mesh.onBeforeRender = (r, sc, cam) => {
        const h = holeOf(mesh);
        if (!h) return;
        h.getWorldPosition(_hw);
        cam.getWorldPosition(_cw);
        uniforms.uCamRel.value.set(_cw.x - _hw.x, _cw.y - _hw.y, _cw.z - _hw.z);
    };
}
const _hw = new THREE.Vector3(), _cw = new THREE.Vector3();

export function makeHoleOptics() {
    const shadow = makeShadow(), ring = makeRing(), disk = makeDisk(), jet = makeJet();
    disk.visible = false;
    jet.visible = false;
    trackCameraRel(disk, disk.material.uniforms, m => m.parent);
    for (const cone of jet.children) trackCameraRel(cone, jet.userData.mat.uniforms, m => m.parent?.parent);
    return { shadow, ring, disk, jet, flowC: 0 };
}

const _q = new THREE.Quaternion(), _ax = new THREE.Vector3(), _ay = new THREE.Vector3(), _up = new THREE.Vector3(0, 0, 1), _yUp = new THREE.Vector3(0, 1, 0);
const _c3 = new THREE.Vector3();
function tannerLinear(T, out) {
    const t = Math.max(10, Math.min(400, T / 100));
    let r, g, b;
    if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
    else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
    if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    return out.set(Math.pow(Math.min(1, Math.max(0, r / 255)), 2.2), Math.pow(Math.min(1, Math.max(0, g / 255)), 2.2), Math.pow(Math.min(1, Math.max(0, b / 255)), 2.2));
}

// Per frame. p: {
//   rsKm, muKm3,            the hole
//   t, frameDt,             sim time (s) of the state shown, sim seconds this frame spans
//   camRelX/Y/Z,            camera minus hole centre, scene units (doubles)
//   diskOn, TmaxK, gain, routOverRin, axisX/Y/Z (scene; disk normal),
//   jetOn, jetLenKm, jetI }
export function updateHoleOptics(o, p) {
    const rsU = p.rsKm * K;
    const shadowR = SHADOW_RS * rsU;
    o.shadow.material.uniforms.uR.value = shadowR;
    const ru = o.ring.material.uniforms;
    ru.uR.value = shadowR * RING_SPAN;
    // camera-relative geometry, in doubles on the CPU
    const dU = Math.hypot(p.camRelX, p.camRelY, p.camRelZ);
    // ---- disk ----
    const du = o.disk.material.uniforms;
    o.disk.visible = !!p.diskOn;
    let ringI = .045; // lensed starlight
    tannerLinear(6500, _c3);
    if (p.diskOn) {
        const rIn = 3 * p.rsKm;
        const rOut = Math.max(2, p.routOverRin);
        o.disk.scale.setScalar(rIn * K);
        du.uRout.value = rOut;
        du.uRsL.value = 1 / 3;
        du.uTmax.value = p.TmaxK;
        du.uGain.value = p.gain;
        // orientation: local +z along the disk normal
        _ax.set(p.axisX, p.axisY, p.axisZ).normalize();
        _q.setFromUnitVectors(_up, _ax);
        o.disk.quaternion.copy(_q);
        du.uAxisX.value.set(1, 0, 0).applyQuaternion(_q);
        du.uAxisY.value.set(0, 1, 0).applyQuaternion(_q);
        // Paczynski-Wiita circular rate at r_in; flow-noise cycle = one orbit there
        const omIn = Math.sqrt(p.muKm3 / rIn) / (rIn - p.rsKm);
        const C = 2 * Math.PI / omIn;
        const s = p.t / C;
        const fa = s - Math.floor(s), fb = (s + .5) - Math.floor(s + .5);
        du.uTauA.value = fa * C;
        du.uTauB.value = fb * C;
        du.uWA.value = 1 - Math.abs(2 * fa - 1);
        du.uOmegaIn.value = omIn;
        du.uFrameDt.value = p.frameDt;
        ringI += .4 * p.gain;
        tannerLinear(p.TmaxK, _c3);
    }
    du.uCamRel.value.set(p.camRelX, p.camRelY, p.camRelZ);
    du.uShadowR.value = shadowR;
    ru.uColor.value.copy(_c3).multiplyScalar(ringI);
    // a ring thinner than a pixel still reads as one pixel of light
    ru.uWidth.value = Math.max(.035, 1.2 / Math.max(1e-9, shadowR * p.pxScale / Math.max(dU, 1e-30)));
    // ---- jet ----
    const jet = o.jet, ju = jet.userData.mat.uniforms;
    jet.visible = !!p.jetOn && p.jetLenKm > 0;
    if (jet.visible) {
        _ay.set(p.axisX, p.axisY, p.axisZ).normalize();
        jet.quaternion.setFromUnitVectors(_yUp, _ay);
        const L = p.jetLenKm * K;
        jet.scale.set(L, L, L);
        ju.uI.value = p.jetI;
        ju.uCamRel.value.set(p.camRelX, p.camRelY, p.camRelZ);
        ju.uShadowR.value = shadowR;
    }
}
