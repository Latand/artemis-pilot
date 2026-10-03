// Epoch-referenced catalog orbits in the shared, smooth Galactic potential.
// Missing velocities are deterministic thin-disk draws, NOT measurements.
// This is the existing tier-0 epicycle model, shared by destinations, active
// rows and the GPU background. No per-star integration or N-body history.
import { PC_KM, SUN_GAL, W2G, worldKmToGalFromInto, galDeltaToWorldKmInto } from './coords.js';
import { DISP, vCirc } from './astroConstants.js';
import { gaussian, hashInts, makeRNG, splitSeed } from './prng.js';
import { solarGalacticStateAt } from './solarOrbit.js';

export const CATALOG_MYR_S = 1e6 * 31557600;
export const CATALOG_NU_S = Math.sqrt(4 * Math.PI * 6.674e-11 * (1.98892e30 / (PC_KM * 1000) ** 3) * .1);
export const CATALOG_EVAL_DT_S = (.001 * PC_KM) / 50;
export function catalogEvalTime(t) {
    if (!Number.isFinite(t)) return 0;
    const q = t / CATALOG_EVAL_DT_S, r = Math.round(q);
    const b = Math.abs(q - r) <= 1e-9 * Math.max(1, Math.abs(r)) ? r : Math.trunc(q);
    return b === 0 ? 0 : b * CATALOG_EVAL_DT_S;
}
const SALT = 0x54494552;
const _gal = [0, 0, 0], _delta = [0, 0, 0];
const _sun = {};
let sunTime = NaN;
const records = new WeakMap();

export function catalogMotionSeed(star) {
    for (const [tag, field] of [[1, 'hip'], [2, 'hd'], [3, 'hr']]) {
        if (Number(star[field]) > 0) return [tag, Number(star[field])];
    }
    if (Number.isInteger(star.hygIndex) && star.hygIndex >= 0) return [0, star.hygIndex];
    let h = 0;
    const key = star.companion || star.id || star.name || 'unknown';
    for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
    return [4, h];
}

export function createCatalogMotion(x, y, z, identity = {}) {
    const [tag, id] = catalogMotionSeed(identity);
    const rng = makeRNG(splitSeed(hashInts(SALT, tag, id), 1));
    const U = DISP.thin.sU * gaussian(rng);
    const V = -DISP.thin.lag + DISP.thin.sV * gaussian(rng);
    const W = DISP.thin.sW * gaussian(rng);
    worldKmToGalFromInto(x, y, z, ...SUN_GAL, _gal);
    const [gx, gy, gz] = _gal;
    const R = Math.hypot(gx, gy), safeR = Math.max(R, 50);
    const omega = Math.max(vCirc(safeR / 1000), 1e-6) / (safeR * PC_KM);
    const kappa = Math.SQRT2 * omega;
    let xp = -V / (2 * omega * PC_KM), yp = -U / (kappa * PC_KM);
    if (!(R - xp > 0) || Math.hypot(xp, yp) > .5 * (R - xp)) xp = yp = 0;
    return { x, y, z, gx, gy, gz, R, omega, kappa, xp, yp, zp: W / (CATALOG_NU_S * PC_KM) };
}

// Remember the epoch exactly once. Never seed an orbit from a moving position,
// or from the clock/camera/universe seed. epochPosition survives quicksaves.
export function catalogMotionFor(star) {
    let m = records.get(star);
    if (!m) {
        const p = star.epochPosition || [star.x, star.y, star.z || 0];
        star.epochPosition = [...p];
        m = createCatalogMotion(...p, star);
        records.set(star, m);
    }
    return m;
}

export function catalogPositionAt(m, simT, out = [0, 0, 0]) {
    const t = Number.isFinite(simT) ? simT : 0;
    if (t === 0) { out[0] = m.x; out[1] = m.y; out[2] = m.z; return out; }
    const kt = m.kappa * t, cm1 = -2 * Math.sin(kt / 2) ** 2, sk = Math.sin(kt);
    const R = m.R + m.xp * cm1 - m.yp * sk;
    const angle = m.omega * t - (Math.SQRT2 / (m.R - m.xp)) * (m.xp * sk + m.yp * cm1);
    const sa = Math.sin(angle), ca1 = -2 * Math.sin(angle / 2) ** 2;
    const dr = m.R > 0 ? (R - m.R) / m.R : 0;
    const dx = m.gx * ca1 - m.gy * sa + dr * (m.gx * (ca1 + 1) - m.gy * sa);
    const dy = m.gx * sa + m.gy * ca1 + dr * (m.gx * sa + m.gy * (ca1 + 1));
    const dz = m.gz * (-2 * Math.sin(CATALOG_NU_S * t / 2) ** 2) + m.zp * Math.sin(CATALOG_NU_S * t);
    if (sunTime !== t) { solarGalacticStateAt(t, _sun); sunTime = t; }
    galDeltaToWorldKmInto(dx - (_sun.x - SUN_GAL[0]), dy - (_sun.y - SUN_GAL[1]), dz - (_sun.z - SUN_GAL[2]), _delta);
    out[0] = m.x + _delta[0]; out[1] = m.y + _delta[1]; out[2] = m.z + _delta[2];
    return out;
}

export function updateCatalogStar(star, simT) {
    const m = catalogMotionFor(star);
    catalogPositionAt(m, simT, _delta);
    star.x = _delta[0]; star.y = _delta[1]; star.z = _delta[2];
    star.dLy = Math.hypot(star.x, star.y, star.z) / 9460730472580.8;
    star._posSimT = simT;
    star.motionModel = 'synthetic-epicycle';
    return star;
}

// Shared GPU uniforms: time in Myr, solar displacement in pc. The extra
// per-point attribute is (xp,yp,zp,omega*Myr), 16 bytes/star. Packing the
// canonical frequency avoids GPU length/division error accumulating into phase.
export const catalogMotionUniforms = {
    uCatalogMyr: { value: 0 }, uCatalogSunDelta: { value: [0, 0, 0] },
    uCatalogOriginPc: { value: [0, 0, 0] },
};
export function setCatalogMotionTime(t, origin = { x: 0, y: 0, z: 0 }) {
    t = Number.isFinite(t) ? t : 0;
    catalogMotionUniforms.uCatalogMyr.value = t / CATALOG_MYR_S;
    solarGalacticStateAt(t, _sun); sunTime = t;
    const d = catalogMotionUniforms.uCatalogSunDelta.value;
    d[0] = _sun.x - SUN_GAL[0]; d[1] = _sun.y - SUN_GAL[1]; d[2] = _sun.z - SUN_GAL[2];
    const o = catalogMotionUniforms.uCatalogOriginPc.value;
    o[0] = origin.x / PC_KM; o[1] = origin.y / PC_KM; o[2] = origin.z / PC_KM;
}
const dot = (r, v) => `dot(vec3(${r.map(x => x.toFixed(12)).join(',')}), ${v})`;
export const CATALOG_MOTION_GLSL = /* glsl */`
attribute vec4 catalogOrbit;
uniform float uCatalogMyr;
uniform vec3 uCatalogSunDelta, uCatalogOriginPc;
// Do not rely on implementation-dependent transcendental accuracy for a
// phase multiplied by kpc radii. Range-reduced Taylor polynomials (sin degree
// 13, cos degree 12) have <7e-9 truncation error on [-pi/2,pi/2].
vec2 catalogSinCos(float angle) {
    float a = mod(angle + 3.141592653589793, 6.283185307179586) - 3.141592653589793;
    float signC = 1.0;
    if (a > 1.570796326794897) { a = 3.141592653589793-a; signC = -1.0; }
    if (a < -1.570796326794897) { a = -3.141592653589793-a; signC = -1.0; }
    float z = a*a;
    float sn = a*(1.0+z*(-0.1666666666666667+z*(0.0083333333333333+z*(-0.0001984126984127+z*(0.0000027557319224+z*(-0.0000000250521084+z*0.0000000001605904))))));
    float cs = 1.0+z*(-0.5+z*(0.0416666666666667+z*(-0.0013888888888889+z*(0.0000248015873016+z*(-0.0000002755731922+z*0.0000000020876757)))));
    return vec2(sn,signC*cs);
}
vec3 catalogMotion(vec3 p) {
    if (uCatalogMyr == 0.0) return p;
    vec3 w = vec3(p.x,-p.z,p.y) / ${(PC_KM * .001).toFixed(6)} + uCatalogOriginPc;
    vec3 g = vec3(${SUN_GAL[0]}.0 - ${dot(W2G[0], 'w')}, ${dot(W2G[1], 'w')}, ${SUN_GAL[2]} + ${dot(W2G[2], 'w')});
    float r = length(g.xy), om = catalogOrbit.w;
    vec2 k = catalogSinCos(0.7071067811865476*om*uCatalogMyr);
    float cm1 = -2.0*k.x*k.x, sk = 2.0*k.x*k.y;
    float dr = catalogOrbit.x*cm1 - catalogOrbit.y*sk;
    float theta = om*uCatalogMyr - sqrt(2.0)/(r-catalogOrbit.x)*(catalogOrbit.x*sk+catalogOrbit.y*cm1);
    vec2 ph = catalogSinCos(theta*.5);
    float sa=2.0*ph.x*ph.y, ca1=-2.0*ph.x*ph.x;
    vec2 delta=vec2(g.x*ca1-g.y*sa,g.x*sa+g.y*ca1);
    delta += dr/max(r,1e-12)*vec2(g.x*(ca1+1.0)-g.y*sa,g.x*sa+g.y*(ca1+1.0));
    float nu = ${(CATALOG_NU_S * CATALOG_MYR_S).toFixed(15)}*uCatalogMyr;
    vec2 vertical = catalogSinCos(nu*.5);
    vec3 d=vec3(delta,g.z*(-2.0*vertical.x*vertical.x)+catalogOrbit.z*(2.0*vertical.x*vertical.y))-uCatalogSunDelta;
    vec3 e=vec3(-d.x,d.y,d.z);
    vec3 wd=vec3(${dot(W2G.map(r=>r[0]), 'e')},${dot(W2G.map(r=>r[1]), 'e')},${dot(W2G.map(r=>r[2]), 'e')});
    return p + vec3(wd.x,wd.z,-wd.y)*${(PC_KM * .001).toFixed(6)};
}
`;
