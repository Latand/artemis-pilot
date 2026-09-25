// Face-on structure maps of the Milky Way's disk, in the frame that
// co-rotates with the spiral pattern: where the young stars, the star-forming
// knots, the dust and the old stellar arms are. The volumetric renderer
// (render/galaxyVolume.js) samples them as textures along every view ray,
// the JS reference model (galaxyModel.js mwSample) and the procedural star
// field (resolvedField.js) sample the same arrays, so the arms, dust lanes
// and star clusters a camera sees from outside the Galaxy are the ones its
// stars are drawn from inside it.
//
// Spiral structure. The measured part is Reid et al. (2019, ApJ 885, 131):
// maser-parallax log spirals over the azimuth ranges where they are
// observed (Table 2). Beyond those ranges the arms are extrapolated with a
// pitch angle that relaxes to the Galaxy's mean pitch (~12.5 deg; Vallee
// 2017, Astron. Rev. 13, 113; Hou & Han 2014, A&A 569, A125) instead of
// continuing the local, sometimes nearly circular segments (Sagittarius-
// Carina's outer pitch is 1 deg), which would wind into rings. The two major
// arms, Scutum-Centaurus and Perseus, begin near the two ends of the bar and
// carry the old stellar arms seen in the infrared (Benjamin et al. 2005;
// Churchwell et al. 2009); Sagittarius-Carina and Norma-Outer are gas and
// young-star arms with little old-star contrast; the Local Arm is a short
// spur. Arms fade in beyond the bar and out past the star-forming disk.
//
// Arm cross-section (young stars and dust): the shock of the density wave
// sits on the concave (inner) edge of a trailing arm inside corotation, so
// the dust lane lies along the inner edge and the star formation just
// downstream (e.g. Roberts 1969; Vogel et al. 1988 for M51); dust feathers
// trail from the lanes into the interarm (La Vigne et al. 2006). Star
// formation is clumpy along the arms (complexes of ~100-300 pc, e.g. Efremov
// & Elmegreen 1998) and arms break up into segments. These small-scale
// features are statistical (PROCEDURAL), not a map of real clusters.
//
// Pure module (no THREE/DOM), deterministic in (seed, size): the same maps
// are generated in every context that needs them (main-thread upload, the
// resolved-field worker, node smokes).
import { REID_ARMS, armWidth } from "./astroConstants.js";
import { hashInts, makeRNG, gaussian } from "./prng.js";

const DEG = Math.PI / 180;
export const MAP_SIZE = 1024;
export const MAP_EXTENT_PC = 24000;          // half-width of the square map (pc)
export const MAP_SEED = 0x6d57a2;
const R0_PC = 8178;
const PITCH_GLOBAL = 12.5;                   // deg, mean Milky Way pitch
const PITCH_RELAX_DEG = 35;                  // e-folding of the relaxation outside the observed range

// Role of each Reid arm in the maps: amplitudes of its young stars, old
// stars and dust; radial extent (kpc) of its star-forming part; for the
// Local Arm, the azimuth range of the spur.
const ARM_ROLES = {
    "Sct-Cen": { young: 1.0, old: 1.0, dust: 1.0, rIn: 3.6, rOut: 17.5 },
    "Sgr-Car": { young: 0.9, old: 0.14, dust: 0.85, rIn: 3.6, rOut: 15.5 },
    "Local": { young: 0.35, old: 0.05, dust: 0.5, rIn: 6.5, rOut: 11, spur: [-30, 55] },
    "Perseus": { young: 0.9, old: 1.0, dust: 1.0, rIn: 3.6, rOut: 18.5 },
    "Outer": { young: 0.65, old: 0.14, dust: 0.7, rIn: 3.6, rOut: 20 },
};

// --- Arm centrelines ---------------------------------------------------------
// ln R(beta) integrated from the kink with d lnR / d beta = -tan psi(beta):
// Reid's inner/outer pitch inside the observed range, relaxing to the global
// pitch outside it. Tables are sampled every STEP_DEG from R = 1.5 to 26 kpc.
const STEP_DEG = 0.25;
function pitchAt(arm, beta) {
    const inner = beta > arm.betaKinkDeg;           // trailing: beta up = R down
    const psi0 = inner ? arm.pitchInner : arm.pitchOuter;
    let over = 0;
    if (beta > arm.betaMaxDeg) over = beta - arm.betaMaxDeg;
    else if (beta < arm.betaMinDeg) over = arm.betaMinDeg - beta;
    return PITCH_GLOBAL + (psi0 - PITCH_GLOBAL) * Math.exp(-over / PITCH_RELAX_DEG);
}
function buildCenterline(arm) {
    const role = ARM_ROLES[arm.name];
    const lnRk = Math.log(arm.rKinkKpc * 1000);
    const lnMin = Math.log(1500), lnMax = Math.log(26000);
    const out = [], inn = [];
    // outward: beta decreasing
    let b = arm.betaKinkDeg, lnR = lnRk, u = 0;
    while (lnR < lnMax) {
        const psi = pitchAt(arm, b - STEP_DEG / 2) * DEG;
        const R = Math.exp(lnR);
        lnR += Math.tan(psi) * STEP_DEG * DEG;
        u += R * STEP_DEG * DEG / Math.cos(psi);
        b -= STEP_DEG;
        out.push([b, lnR, u, psi]);
    }
    b = arm.betaKinkDeg; lnR = lnRk; u = 0;
    while (lnR > lnMin) {
        const psi = pitchAt(arm, b + STEP_DEG / 2) * DEG;
        const R = Math.exp(lnR);
        lnR -= Math.tan(psi) * STEP_DEG * DEG;
        u -= R * STEP_DEG * DEG / Math.cos(psi);
        b += STEP_DEG;
        inn.push([b, lnR, u, psi]);
    }
    const rows = out.reverse().concat([[arm.betaKinkDeg, lnRk, 0, pitchAt(arm, arm.betaKinkDeg) * DEG]], inn);
    const n = rows.length;
    const t = { name: arm.name, role, arm, n, beta0: rows[0][0], lnR: new Float64Array(n), u: new Float64Array(n), psi: new Float64Array(n) };
    for (let i = 0; i < n; i++) { t.lnR[i] = rows[i][1]; t.u[i] = rows[i][2]; t.psi[i] = rows[i][3]; }
    t.beta1 = t.beta0 + (n - 1) * STEP_DEG;
    t.wRef = arm.widthKpc * 1000 / armWidth(8.15);
    return t;
}
let _lines = null;
export function armCenterlines() {
    if (!_lines) _lines = REID_ARMS.map(buildCenterline);
    return _lines;
}

// Crossings of arm `t` near the point (R, beta), one per winding that covers
// beta: signed distance across the arm s (pc, + outward), arc length along
// it u (pc), pitch, centreline radius and unwrapped azimuth, written into
// out.list[0 .. out.n-1] (windings farther than `maxS` across are skipped).
function armCrossings(t, R, beta, maxS, out) {
    out.n = 0;
    const kLo = Math.ceil((t.beta0 - beta) / 360), kHi = Math.floor((t.beta1 - beta) / 360);
    for (let k = kLo; k <= kHi; k++) {
        const x = (beta + 360 * k - t.beta0) / STEP_DEG;
        const i = Math.min(t.n - 2, Math.max(0, Math.floor(x))), f = x - i;
        const Rc = Math.exp(t.lnR[i] + (t.lnR[i + 1] - t.lnR[i]) * f);
        const psi = t.psi[i];
        const s = (R - Rc) * Math.cos(psi);
        if (Math.abs(s) > maxS) continue;
        const c = out.list[out.n++];
        c.s = s; c.psi = psi; c.Rc = Rc; c.beta = beta + 360 * k;
        c.u = t.u[i] + (t.u[i + 1] - t.u[i]) * f;
    }
    return out.n;
}

// --- Noise -------------------------------------------------------------------
// Integer lattice hash (murmur3-style mixing, exact in 32-bit JS integer ops).
function hash2(ix, iy, salt) {
    let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
    h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}
function smoothT(t) { return t * t * (3 - 2 * t); }
// Value noise in [-1, 1] on an integer lattice.
function vnoise2(x, y, salt) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = smoothT(x - ix), fy = smoothT(y - iy);
    const a = hash2(ix, iy, salt), b = hash2(ix + 1, iy, salt), c = hash2(ix, iy + 1, salt), d = hash2(ix + 1, iy + 1, salt);
    return ((a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy) * 2 - 1;
}
function vnoise1(x, salt) {
    const ix = Math.floor(x), f = smoothT(x - ix);
    const a = hash2(ix, 0x51ed, salt), b = hash2(ix + 1, 0x51ed, salt);
    return (a + (b - a) * f) * 2 - 1;
}
function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}
// Dust lane across an arm of width w: centred LANE_OFFSET w inside the
// arm's crest, Gaussian of width laneWidth(w).
export const LANE_OFFSET = 0.62;
export function laneWidth(w) { return Math.max(45, 0.3 * w); }
export function laneProfile(s, w) {
    const d = (s + LANE_OFFSET * w) / laneWidth(w);
    return Math.exp(-0.5 * d * d);
}
// Along-arm brightness: arms break up into segments of a few kpc (noise in
// arm coordinates, so the breaks are ragged rather than straight cuts).
function armSegment(u, s, a, S) {
    const su = u / 1000, ss = s / 1000;
    return Math.min(1.35, Math.max(0.12, 0.66 + 0.55 * vnoise2(su / 2.6 + a * 17.3, ss / 1.6, S + a) + 0.25 * vnoise2(su / 0.9 + a * 5.1, ss / 0.7, S + 31 + a)));
}

// --- Generation ------------------------------------------------------------------
// Returns { size, extentPc, texelPc, young, old, dust, hii, norm } with one
// Float32Array(size * size) per channel, row-major, x fastest; texel centres
// at -extent + (i + 0.5) * texel. Channels are dimensionless modulations of
// the smooth model (galaxyModel.js), normalized in galaxyModel through
// `norm` so the solar neighbourhood keeps its measured calibration.
export function generateGalaxyMaps({ size = MAP_SIZE, extentPc = MAP_EXTENT_PC, seed = MAP_SEED } = {}) {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const N = size, E = extentPc, texel = 2 * E / N;
    const young = new Float32Array(N * N), old = new Float32Array(N * N), dust = new Float32Array(N * N), hii = new Float32Array(N * N);
    // the nearest dust lane, for an analytic (sharp at any zoom) profile:
    // across-arm distance s and width w (pc) of its arm, its peak dust and
    // the lane dust this texel's `dust` already holds
    const laneS = new Float32Array(N * N), laneW = new Float32Array(N * N).fill(200), laneA = new Float32Array(N * N), laneV = new Float32Array(N * N);
    const lines = armCenterlines();
    const cross = { n: 0, list: Array.from({ length: 8 }, () => ({ s: 0, u: 0, psi: 0, Rc: 0, beta: 0 })) };
    const S = seed >>> 0;
    for (let j = 0; j < N; j++) {
        const y = -E + (j + 0.5) * texel;
        for (let i = 0; i < N; i++) {
            const x = -E + (i + 0.5) * texel;
            const R = Math.hypot(x, y);
            const k = j * N + i;
            // the gas-poor bar region: young stars and dust taper in over
            // 1.5-3.5 kpc (galaxyModel's disk hole); the central molecular
            // zone is galaxyModel's analytic ring in the bar's frame
            const yHole = smoothstep(1500, 3500, R), dHole = smoothstep(1440, 3200, R);
            if (yHole <= 0 && dHole <= 0) {
                young[k] = 0; old[k] = 1; dust[k] = 0; hii[k] = 0;
                continue;
            }
            const lnR = Math.log(R);
            const beta = Math.atan2(y, x) / DEG;
            let yArm = 0, oArm = 0, dArm = 0, lBest = 0, lScore = 0, lS = 1e4, lW = 200, lAmp = 0;
            for (let a = 0; a < lines.length; a++) {
                const t = lines[a];
                const role = t.role;
                if (!armCrossings(t, R, beta, 5000, cross)) continue;
                for (let q = 0; q < cross.n; q++) {
                    const c = cross.list[q];
                    const Rk = c.Rc / 1000;
                    let pres = smoothstep(role.rIn, role.rIn + 1.0, Rk) * (1 - smoothstep(role.rOut, role.rOut + 3, Rk));
                    if (role.spur) pres *= smoothstep(role.spur[0] - 15, role.spur[0], c.beta) * (1 - smoothstep(role.spur[1], role.spur[1] + 15, c.beta));
                    if (pres <= 0) continue;
                    const w = Math.min(420, Math.max(90, t.wRef * armWidth(Rk)));
                    const s = c.s;
                    // segments: arms fragment along their length
                    const seg = armSegment(c.u, s, a, S);
                    const ys = s - 0.12 * w;
                    yArm = Math.max(yArm, role.young * pres * seg * Math.exp(-(ys * ys) / (2 * w * w)));
                    const W = Math.max(650, 2.6 * w);
                    const segO = 0.82 + 0.18 * vnoise1(c.u / 4000 + a * 3.7, S + 61 + a);
                    oArm = Math.max(oArm, role.old * pres * segO * Math.exp(-(s * s) / (2 * W * W)));
                    // dust: narrow lane on the inner edge + broad envelope + feathers
                    const wl = laneWidth(w);
                    const dl = s + LANE_OFFSET * w;
                    const amp = role.dust * pres * (0.55 + 0.45 * seg);
                    const lane = amp * Math.exp(-(dl * dl) / (2 * wl * wl));
                    const score = amp * Math.exp(-(dl * dl) / (2 * 9 * wl * wl));
                    if (score > lScore) { lScore = score; lBest = lane; lS = s; lW = w; lAmp = amp; }
                    const env = 0.35 * Math.exp(-(s * s) / (2 * (1.5 * w) * (1.5 * w))) * seg;
                    let feath = 0;
                    if (s > -0.3 * w && s < 6 * w) {
                        // feathers trail outward from the lane at a steep angle to the arm
                        const r = 1 - Math.abs(vnoise2((c.u + 1.7 * s) / 950, s / 2400, S + 101 + a));
                        feath = 0.6 * Math.pow(r, 6) * Math.exp(-Math.max(0, s) / (2.4 * w)) * seg;
                    }
                    dArm = Math.max(dArm, role.dust * pres * (env + feath));
                }
            }
            // flocculent interarm star formation and dust
            const fl = vnoise2(x / 900, y / 900, S + 7) + 0.5 * vnoise2(x / 330, y / 330, S + 8);
            const floc = Math.exp(1.1 * fl - 0.35);
            const dn = vnoise2(x / 520, y / 520, S + 9) + 0.55 * vnoise2(x / 190, y / 190, S + 10) + 0.3 * vnoise2(x / 80, y / 80, S + 11);
            const dClump = Math.exp(1.0 * dn - 0.28);
            // inner ring at the bar ends (the 3-kpc arms / molecular ring region)
            const ring = 0.35 * Math.exp(-((R - 4300) * (R - 4300)) / (2 * 450 * 450));
            young[k] = yHole * (0.1 * floc + ring + 4 * yArm);
            old[k] = 1 + 0.9 * oArm;
            dust[k] = dHole * (0.1 * floc + 0.6 * ring + 1.9 * (dArm + lBest)) * dClump;
            laneS[k] = lS; laneW[k] = lW;
            laneA[k] = dHole * 1.9 * lAmp * dClump;
            laneV[k] = dHole * 1.9 * lBest * dClump;
            hii[k] = yHole * 0.25 * yArm * yArm;
        }
    }
    // Where the nearest lane switches from one arm (or winding) to another,
    // its across-arm coordinate jumps; interpolating across the jump would
    // draw a false lane, so those texels keep only the sampled lane.
    const jump = 3 * texel;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const r = i + 1 < N ? k + 1 : -1, u = j + 1 < N ? k + N : -1;
        for (const q of [r, u]) {
            if (q < 0 || Math.abs(laneS[q] - laneS[k]) <= jump) continue;
            laneA[k] = laneV[k] = 0; laneA[q] = laneV[q] = 0;
        }
    }
    // Star-forming complexes along the arms: three levels of knots (young
    // stars + HII emission), splatted as Gaussians.
    const rng = makeRNG(hashInts(S, 0x4b4e4f54));
    const LEVELS = [
        { spacing: 850, sig: [90, 230], amp: 4.5, hii: 7 },
        { spacing: 320, sig: [40, 95], amp: 2.4, hii: 3.5 },
        { spacing: 120, sig: [20, 45], amp: 1.2, hii: 1.2 },
    ];
    for (const t of lines) {
        const role = t.role;
        const uMin = t.u[t.n - 1], uMax = t.u[0];
        for (const L of LEVELS) {
            for (let u = uMin; u < uMax; u += L.spacing) {
                const uk = u + rng() * L.spacing;
                // centreline point at arc length uk (tables are monotone in u, decreasing with index)
                let lo = 0, hi = t.n - 1;
                while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t.u[m] > uk) lo = m; else hi = m; }
                const f = (t.u[lo] - uk) / Math.max(1e-9, t.u[lo] - t.u[hi]);
                const lnRc = t.lnR[lo] + (t.lnR[hi] - t.lnR[lo]) * f;
                const Rc = Math.exp(lnRc), Rk = Rc / 1000;
                const bc = (t.beta0 + (lo + f) * STEP_DEG) * DEG;
                let pres = smoothstep(role.rIn, role.rIn + 1.0, Rk) * (1 - smoothstep(role.rOut, role.rOut + 3, Rk));
                if (role.spur) { const bd = bc / DEG; pres *= smoothstep(role.spur[0] - 15, role.spur[0], bd) * (1 - smoothstep(role.spur[1], role.spur[1] + 15, bd)); }
                const g1 = gaussian(rng), g2 = gaussian(rng), g3 = gaussian(rng), r1 = rng();
                if (pres <= 0.02) continue;
                const seg = armSegment(uk, 0, lines.indexOf(t), S);
                const w = Math.min(420, Math.max(90, t.wRef * armWidth(Rk)));
                const sOff = (0.2 + 0.45 * g1) * w;
                const psi = t.psi[lo];
                // across-arm unit vector (outward) and position
                const cx = Rc * Math.cos(bc), cy = Rc * Math.sin(bc);
                const ex = Math.cos(bc), ey = Math.sin(bc);
                const px = cx + ex * sOff / Math.cos(psi), py = cy + ey * sOff / Math.cos(psi);
                const sig = L.sig[0] * Math.pow(L.sig[1] / L.sig[0], r1) * Math.exp(0.15 * g3);
                const b = role.young * pres * seg * Math.exp(0.75 * g2 - 0.28) * L.amp;
                splat(young, N, E, texel, px, py, sig, b);
                splat(hii, N, E, texel, px, py, sig * 0.8, b * L.hii / L.amp * (0.35 + 0.65 * r1));
            }
        }
    }
    const maps = { size: N, extentPc: E, texelPc: texel, young, old, dust, hii, laneS, laneW, laneA, laneV, norm: null, ms: 0 };
    maps.norm = mapNorms(maps);
    maps.ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    return maps;
}

// Add a normalized-peak Gaussian blob (peak b at the centre) to a channel.
function splat(ch, N, E, texel, px, py, sig, b) {
    const r = 3 * sig;
    const i0 = Math.max(0, Math.floor((px - r + E) / texel)), i1 = Math.min(N - 1, Math.floor((px + r + E) / texel));
    const j0 = Math.max(0, Math.floor((py - r + E) / texel)), j1 = Math.min(N - 1, Math.floor((py + r + E) / texel));
    // a sub-texel blob keeps its light: spread over at least a texel
    const s2 = Math.max(sig * sig, 0.18 * texel * texel);
    const peak = b * sig * sig / s2;
    for (let j = j0; j <= j1; j++) {
        const dy = -E + (j + 0.5) * texel - py;
        for (let i = i0; i <= i1; i++) {
            const dx = -E + (i + 0.5) * texel - px;
            const q = (dx * dx + dy * dy) / (2 * s2);
            if (q < 4.5) ch[j * N + i] += peak * Math.exp(-q);
        }
    }
}

// Normalizers: the mean young, old and dust modulation within 1 kpc of the
// Sun, where the model is calibrated (local light, local extinction).
function mapNorms(m) {
    let ny = 0, no = 0, nd = 0, nn = 0;
    const N = m.size, E = m.extentPc, tx = m.texelPc;
    for (let j = 0; j < N; j++) {
        const y = -E + (j + 0.5) * tx;
        for (let i = 0; i < N; i++) {
            const x = -E + (i + 0.5) * tx;
            const k = j * N + i;
            if (Math.hypot(x - R0_PC, y) < 1000) { ny += m.young[k]; no += m.old[k]; nd += m.dust[k]; nn++; }
        }
    }
    return { young: ny / Math.max(1, nn), old: no / Math.max(1, nn), dust: nd / Math.max(1, nn) };
}

// Bilinear sample of every channel at pattern-frame (x, y) pc into `out`
// ({ young, old, dust, hii }); outside the map: the smooth model (1, 1, ...).
export function sampleGalaxyMapsInto(m, x, y, out) {
    const N = m.size, u = (x + m.extentPc) / m.texelPc - 0.5, v = (y + m.extentPc) / m.texelPc - 0.5;
    if (!(u >= 0 && v >= 0 && u < N - 1 && v < N - 1)) {
        out.young = 0; out.old = 1; out.dust = 0; out.hii = 0;
        return out;
    }
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const k = j * N + i;
    const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
    out.young = (m.young[k] * w00 + m.young[k + 1] * w10 + m.young[k + N] * w01 + m.young[k + N + 1] * w11) / m.norm.young;
    out.old = (m.old[k] * w00 + m.old[k + 1] * w10 + m.old[k + N] * w01 + m.old[k + N + 1] * w11) / m.norm.old;
    // the dust lane evaluated analytically from its interpolated arm
    // coordinates (sharp at any resolution), replacing the texels' sampled one
    const bl = a => a[k] * w00 + a[k + 1] * w10 + a[k + N] * w01 + a[k + N + 1] * w11;
    const lane = bl(m.laneA) * laneProfile(bl(m.laneS), bl(m.laneW));
    out.dust = (bl(m.dust) - bl(m.laneV) + lane) / m.norm.dust;
    out.hii = (m.hii[k] * w00 + m.hii[k + 1] * w10 + m.hii[k + N] * w01 + m.hii[k + N + 1] * w11) / m.norm.young;
    return out;
}

// GPU payload: RGBA (young, old, dust, hii) as IEEE half floats with a full
// box-filtered mip chain (so distant views average the knots instead of
// aliasing them), and the normalizers the shader divides by.
export function packGalaxyMapsHalf(m) {
    const levels = [];
    let n = m.size;
    let cur = new Float32Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
        cur[i * 4] = m.young[i]; cur[i * 4 + 1] = m.old[i]; cur[i * 4 + 2] = m.dust[i]; cur[i * 4 + 3] = m.hii[i];
    }
    for (;;) {
        const half = new Uint16Array(n * n * 4);
        for (let i = 0; i < half.length; i++) half[i] = toHalf(cur[i]);
        levels.push({ width: n, height: n, data: half });
        if (n === 1) break;
        const h = n >> 1, next = new Float32Array(h * h * 4);
        for (let j = 0; j < h; j++) for (let i = 0; i < h; i++) for (let c = 0; c < 4; c++) {
            const a = ((2 * j) * n + 2 * i) * 4 + c, b = a + n * 4;
            next[(j * h + i) * 4 + c] = 0.25 * (cur[a] + cur[a + 4] + cur[b] + cur[b + 4]);
        }
        cur = next; n = h;
    }
    // arm-lane coordinates (kpc), peak and sampled lane dust: level 0 only
    // (the coarse levels of the main texture already hold the lane dust)
    const lane = new Uint16Array(m.size * m.size * 4);
    for (let i = 0; i < m.size * m.size; i++) {
        lane[i * 4] = toHalf(m.laneS[i] / 1000); lane[i * 4 + 1] = toHalf(m.laneW[i] / 1000);
        lane[i * 4 + 2] = toHalf(m.laneA[i]); lane[i * 4 + 3] = toHalf(m.laneV[i]);
    }
    return { levels, lane, size: m.size, extentPc: m.extentPc, norm: m.norm };
}
const _f32 = new Float32Array(1), _u32 = new Uint32Array(_f32.buffer);
function toHalf(v) {
    _f32[0] = v;
    const x = _u32[0];
    const sign = (x >>> 16) & 0x8000;
    let e = ((x >>> 23) & 0xff) - 127 + 15;
    let mant = x & 0x7fffff;
    if (e <= 0) {
        if (e < -10) return sign;
        mant = (mant | 0x800000) >> (1 - e);
        return sign | ((mant + 0x1000) >> 13);
    }
    if (e >= 31) return sign | 0x7c00;
    const r = sign | (e << 10) | ((mant + 0x1000) >> 13);
    return r;
}

// One shared copy per context: generated on demand (workers, node) or
// installed after an off-thread build (main thread).
let _maps = null;
export function galaxyMaps() { return _maps; }
export function installGalaxyMaps(m) { _maps = m; return m; }
export function ensureGalaxyMaps() {
    if (!_maps) _maps = generateGalaxyMaps();
    return _maps;
}
