// Old disk stars crowd in the spiral arms instead of appearing and fading
// there: a kinematic density wave (Lin & Shu 1964; Kalnajs 1973). Stars on
// circular orbits slow down where the arms are and hurry between them, so
// the arms are a traffic jam that stars pass through, not a ribbon of
// material.
//
// Along each ring of radius R the old stars' arm modulation m(R, psi) (the
// structure maps' old channel, psi the angle in the base map's frame) is
// divided by its ring mean: mhat, with mean 1. Its cumulative excess
//     P(R, psi) = integral_0^psi (mhat - 1) dpsi'   (periodic, zero mean)
// defines a transport of each ring onto itself. A star with label Lambda --
// the angle it would have on its circular orbit, which turns at Omega(R)
// -- is at the angle phi that solves
//     phi + sum_g w_g(t) P(R, phi - A_g(R, t)) = Lambda(t)
// over the spiral generations g (weights w_g, map-frame angles A_g; see
// galaxyDynamics.js). The left side is increasing in phi (its derivative is
// sum_g w_g mhat_g > 0), so the map is a bijection of the ring, continuous
// in time, and stars uniform in Lambda have density proportional to
// sum_g w_g mhat_g -- exactly the arm modulation of the diffuse light, at
// every moment, for every generation and weight. A star's speed relative to
// the arms is (Omega - Omega_arm) / mhat: slower in the arms, faster
// between them; the azimuthal streaming that results is ~7 km/s typical,
// ~25-40 km/s at the strongest arms (measured: docs/galaxy-dynamics.md).
//
// The field (resolvedField.js) draws the stars of a material epoch at
// their density at the epoch's centre t_e; a star at epoch-frame angle
// beta_q then has Lambda - phi_circ = delta_c = sum_g w_g(t_e) P(...at t_e)
// (its label offset, computed once when the star is drawn and carried with
// it), and at t = t_e + tau it is displaced from its circular orbit by Delta,
//     Delta + sum_g w_g(t) P(R, beta_q + Omega tau + Delta + G_g(t)) = delta_c,
// G_g the generation's offset from the epoch frame. The CPU (selection) and
// the GPU (drawing) take the same two Newton steps from 0, which are within
// 0.3 pc of the root.
//
// The table is a polar texture (ARM_NB angles x ARM_NR radii, texel
// centres at psi = 2 pi (j + 1/2) / ARM_NB, R = rmax (i + 1/2) / ARM_NR)
// of (P, mhat) as half floats, sampled bilinearly. The maps worker sends it
// to the GPU (galaxyVolume.js); the field worker builds the same table from
// the same deterministic maps and samples it exactly as the GPU does, so
// selection and drawing agree.
import { MAP_EXTENT_PC } from "./galaxyMaps.js";

export const ARM_NR = 512, ARM_NB = 2048;   // ARM_NB: a power of two
const SUB = 2;
const TWO_PI = 2 * Math.PI;
// Newton steps, on the GPU and the CPU alike.
export const ARM_NEWTON = 2;
// A star's label offset travels in its arm field (resolvedField.js R_THR,
// the shader's evo.x) as ARM_LABEL_BIAS - delta_c: always < -1.5 (|delta_c|
// < 0.3), apart from young stars' thresholds (> 0) and "no arms" (0).
export const ARM_LABEL_BIAS = -2;
export function armLabelField(dc) { return ARM_LABEL_BIAS - dc; }
export function armLabelOf(field) { return ARM_LABEL_BIAS - field; }
export function isArmLabel(field) { return field < -1; }
// Derivative floor (mhat is >= 0.75 in the maps; this only guards the
// Newton step).
const H_FLOOR = 0.2;

// IEEE half float bits of v, rounded to nearest (the mantissa's carry
// propagates into the exponent), and the value such bits hold.
const _f32 = new Float32Array(1), _u32 = new Uint32Array(_f32.buffer);
export function halfBits(v) {
    _f32[0] = v;
    const x = _u32[0], sign = (x >>> 16) & 0x8000;
    const e = ((x >>> 23) & 0xff) - 127 + 15, mant = x & 0x7fffff;
    if (e <= 0) {
        if (e < -10) return sign;
        return sign | (((mant | 0x800000) >> (1 - e)) + 0x1000 >> 13);
    }
    if (e >= 31) return sign | 0x7c00;
    return sign | Math.min(0x7c00, (e << 10) + ((mant + 0x1000) >> 13));
}
export function halfValue(h) {
    const sign = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return sign * f * 2 ** -24;
    if (e === 31) return f ? NaN : sign * Infinity;
    return sign * (1 + f / 1024) * 2 ** (e - 15);
}

function oldAt(m, x, y) {
    const N = m.size, u = (x + m.extentPc) / m.texelPc - 0.5, v = (y + m.extentPc) / m.texelPc - 0.5;
    if (!(u >= 0 && v >= 0 && u < N - 1 && v < N - 1)) return m.norm.old;
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j, k = j * N + i;
    return Math.max(0, m.old[k] * (1 - fu) * (1 - fv) + m.old[k + 1] * fu * (1 - fv) + m.old[k + N] * (1 - fu) * fv + m.old[k + N + 1] * fu * fv);
}

// (P, mhat) at the texel centres from the structure maps: the GPU payload
// (half floats, RG interleaved) and the same values as float32.
export function buildArmTransport(m) {
    const nr = ARM_NR, nb = ARM_NB, rmax = MAP_EXTENT_PC, n = nb * SUB, db = TWO_PI / nb;
    const half = new Uint16Array(nr * nb * 2), P = new Float32Array(nr * nb), H = new Float32Array(nr * nb);
    const row = new Float64Array(n), h = new Float64Array(nb), p = new Float64Array(nb);
    for (let i = 0; i < nr; i++) {
        const R = rmax * (i + 0.5) / nr;
        let s = 0;
        for (let j = 0; j < n; j++) {
            const b = TWO_PI * (j + 0.5) / n;
            row[j] = oldAt(m, R * Math.cos(b), R * Math.sin(b));
            s += row[j];
        }
        const mean = s > 0 ? s / n : 1;
        for (let j = 0; j < nb; j++) {
            let a = 0;
            for (let q = 0; q < SUB; q++) a += row[j * SUB + q];
            h[j] = s > 0 ? a / SUB / mean : 1;
        }
        // P at bin centres: cumulative of (mhat - 1) over the bins before,
        // plus half of this one; then zero mean (any constant would do)
        let c = 0, pm = 0;
        for (let j = 0; j < nb; j++) {
            p[j] = c + 0.5 * (h[j] - 1) * db;
            c += (h[j] - 1) * db;
            pm += p[j];
        }
        pm /= nb;
        for (let j = 0; j < nb; j++) {
            const k = i * nb + j, hp = halfBits(p[j] - pm), hh = halfBits(h[j]);
            half[2 * k] = hp; half[2 * k + 1] = hh;
            P[k] = halfValue(hp); H[k] = halfValue(hh);
        }
    }
    return { nr, nb, rmax, half, P, H };
}

// Bilinear (P, mhat) at (R, psi), as the GPU's linear filter samples the
// texture (repeat in psi, clamped in R); (0, 1) beyond the maps.
export function armSample(T, R, psi, out) {
    if (!(R < T.rmax)) { out[0] = 0; out[1] = 1; return out; }
    const nr = T.nr, nb = T.nb;
    const fr = Math.min(Math.max(R / T.rmax * nr - 0.5, 0), nr - 1);
    const i = Math.min(Math.floor(fr), nr - 2), ti = fr - i;
    const fb = psi / TWO_PI * nb - 0.5, jf = Math.floor(fb), tj = fb - jf;
    const j0 = jf & (nb - 1), j1 = (j0 + 1) & (nb - 1);         // nb: a power of two
    const a = i * nb, b = a + nb;
    const w00 = (1 - ti) * (1 - tj), w01 = (1 - ti) * tj, w10 = ti * (1 - tj), w11 = ti * tj;
    out[0] = T.P[a + j0] * w00 + T.P[a + j1] * w01 + T.P[b + j0] * w10 + T.P[b + j1] * w11;
    out[1] = T.H[a + j0] * w00 + T.H[a + j1] * w01 + T.H[b + j0] * w10 + T.H[b + j1] * w11;
    return out;
}

// Spiral generations as the transport uses them, relative to an epoch
// frame (galaxyDynamics.generationState gens, epoch frame angle phiE): per
// generation its weight and the offset c = phiE - base, with tau the time
// since its peak (Myr): its map-frame angle at radius R is psi = (epoch-frame
// angle) + c - W(R) tau. Writes [w0, c0, tau0, w1, c1, tau1].
export function armGens(gs, phiE, out = new Float64Array(6)) {
    for (let k = 0; k < 2; k++) {
        const g = gs.gens[k];
        out[3 * k] = g.w;
        out[3 * k + 1] = phiE - g.base;
        out[3 * k + 2] = g.tau;
    }
    return out;
}

const _s = [0, 0];
// sum_g w_g P(R, a + c_g - W tau_g) and its derivative in a.
function mix(T, R, a, W, G, out) {
    let p = 0, h = 0;
    for (let k = 0; k < 6; k += 3) {
        const w = G[k];
        if (!(w > 0)) continue;
        armSample(T, R, a + G[k + 1] - W * G[k + 2], _s);
        p += w * _s[0]; h += w * _s[1];
    }
    out[0] = p; out[1] = h;
    return out;
}
const _m = [0, 0];
// The epoch's label offset delta_c of a star at epoch-frame angle bq (its
// position at the epoch's centre), generations at the centre GE.
export function armLabel(T, R, bq, W, GE) {
    return mix(T, R, bq, W, GE, _m)[0];
}
// Azimuthal displacement Delta (rad) from the circular orbit of a star at
// epoch-frame (R, bq) at the epoch's centre with label offset dc, tau Myr
// later (generations GT at that time); om = Omega(R), W = windRadMyr(R).
export function armDelta(T, R, bq, om, W, tau, dc, GT, steps = ARM_NEWTON) {
    if (!(R < T.rmax)) return 0;
    const a = bq + om * tau;
    let d = 0;
    for (let it = 0; it < steps; it++) {
        mix(T, R, a + d, W, GT, _m);
        d -= (d + _m[0] - dc) / Math.max(_m[1], H_FLOOR);
    }
    return d;
}
// Inverse: the displacement Delta* of the star that is at epoch-frame-
// rotated angle bNow (its current angle minus phiE, i.e. bq + om tau +
// Delta) at tau, generations GE at the epoch's centre; bq = bNow - om tau -
// Delta*. Fixed point (the transport is a contraction of the displacement:
// |dDelta/dbq| < 1 in practice; ~1 pc after four).
export function armDeltaAt(T, R, bNow, om, W, tau, GE, GT, iters = 4) {
    if (!(R < T.rmax)) return 0;
    let d = 0;
    for (let it = 0; it < iters; it++) {
        const bq = bNow - om * tau - d;
        d = armDelta(T, R, bq, om, W, tau, armLabel(T, R, bq, W, GE), GT);
    }
    return d;
}

// Shared copy per maps object (field worker, node).
let _tab = null, _tabMaps = null;
export function armTransport(m) {
    if (!m) return null;
    if (_tab && _tabMaps === m) return _tab;
    _tab = buildArmTransport(m);
    _tabMaps = m;
    return _tab;
}

// GLSL: the same solve in the star shader. Needs DYNAMICS_FN_GLSL (dynWind)
// and uniforms: uArmP (RG texture above), uGenC/uGenWv (generations now,
// as resolvedFieldStars.js sets them), uTau.
export const ARM_TRANSPORT_GLSL = /* glsl */ `
uniform sampler2D uArmP;
vec2 armPH(float R, float psi) {
    return textureLod(uArmP, vec2(psi * ${(1 / TWO_PI).toPrecision(10)}, R * ${(1 / MAP_EXTENT_PC).toPrecision(10)}), 0.0).xy;
}
// Azimuthal displacement of an old disk star from its circular orbit
// (armTransport.js): q its epoch-frame position at the epoch's centre, dc
// its label offset.
float armDelta(vec2 q, float R, float om, float dc) {
    if (R >= ${MAP_EXTENT_PC.toFixed(1)}) return 0.0;
    float W = dynWind(om), bq = atan(q.y, q.x);
    float a = bq + om * uTau, a0 = a + uGenC.x - W * uGenC.y, a1 = a + uGenC.z - W * uGenC.w;
    float d = 0.0;
    for (int it = 0; it < ${ARM_NEWTON}; it++) {
        vec2 s = uGenWv.x * armPH(R, a0 + d);
        if (uGenWv.y > 0.0) s += uGenWv.y * armPH(R, a1 + d);
        d -= (d + s.x - dc) / max(s.y, ${H_FLOOR.toFixed(2)});
    }
    return d;
}
`;
