// Deterministic procedural Milky Way generator.
//
// Space is divided into CELL_PC cubes in the galactocentric frame. Each cell's
// contents are a pure function of (global seed, cell coords): the same cell
// always yields the same stars, so the galaxy is consistent on every revisit
// without storing anything. Star counts follow a Milky-Way stellar-density model
// (thin + thick disc + halo + bulge, with spiral-arm enhancement); masses follow
// the Kroupa IMF; physical properties follow Eker 2018 (see stellar.js).
//
// Density references (see research spec): McMillan 2017, Jurić et al. 2008,
// Vallée 2013. The model is normalised so density = 1 at the Sun, and the local
// number density there is N_SUN_PC3 = 0.14 stars/pc³.

import { hashInts, makeRNG, samplePoisson } from "./prng.js";
import { sampleKroupaMass, deriveStar, msLifetimeWeight } from "./stellar.js";
import { R0_PC, Z_SUN_PC, galToEquatorialKm } from "./coords.js";

export const CELL_PC = 100;                 // cell edge, parsecs
const CELL_VOL = CELL_PC * CELL_PC * CELL_PC; // pc³
export const LOCAL_CELL_PC = 4;             // streaming cell edge, parsecs
const LOCAL_CELL_VOL = LOCAL_CELL_PC * LOCAL_CELL_PC * LOCAL_CELL_PC;
export const N_SUN_PC3 = 0.14;              // local stellar number density
const LEVEL_STAR = 3;                       // hierarchy level id for hashing
const LEVEL_LOCAL_STAR = 4;                 // fine streaming level id

// Disc / halo structural parameters (parsecs).
const HR_THIN = 2600, HZ_THIN = 300;
const HR_THICK = 2600, HZ_THICK = 900, F_THICK = 0.12;
const Q_HALO = 0.64, N_HALO = 2.8, F_HALO = 0.005;
const R_BULGE = 600, A_BULGE = 60;          // central enhancement (approx)
const R_DISC_MAX = 22000;                   // disc sampling cutoff
const Z_DISC_MAX = 3500;                    // vertical sampling cutoff
const MATERIALISE_MAX = 300000;             // max stars instantiated per cell
const LOCAL_MATERIALISE_MAX = 80;           // max stars instantiated per local cell

// Spiral arms: 4 logarithmic arms, mean pitch 12.8°, Gaussian cross-section.
const N_ARMS = 4, ARM_PITCH = 12.8 * Math.PI / 180;
const ARM_R0 = 3000, ARM_SIGMA = 350, ARM_AMP = 1.6;
const TAN_PITCH = Math.tan(ARM_PITCH);

// Structural parameters, exported so the visual galaxy-cloud sampler
// (starfield.js) draws from the same Milky Way model the per-star generator uses.
export const GALAXY_STRUCT = {
    R0_PC, Z_SUN_PC,
    HR_THIN, HZ_THIN, HR_THICK, HZ_THICK, F_THICK,
    Q_HALO, N_HALO, F_HALO, R_BULGE, A_BULGE,
    R_DISC_MAX, Z_DISC_MAX,
    N_ARMS, ARM_PITCH, ARM_R0, ARM_SIGMA, ARM_AMP,
};

let SEED = 0x9e3779b9 >>> 0;
export function setSeed(seed) { SEED = seed >>> 0; }
export function getSeed() { return SEED; }

// Relative stellar number density at galactocentric (gx,gy,gz) in pc,
// normalised so the Sun's neighbourhood ≈ 1.
export function densityAt(gx, gy, gz) {
    const R = Math.hypot(gx, gy);
    const z = gz;
    const thin = Math.exp(-(R - R0_PC) / HR_THIN) * Math.exp(-Math.abs(z) / HZ_THIN);
    const thick = F_THICK * Math.exp(-(R - R0_PC) / HR_THICK) * Math.exp(-Math.abs(z) / HZ_THICK);
    const rEff = Math.hypot(R, z / Q_HALO);
    const halo = F_HALO * Math.pow(R0_PC / Math.max(rEff, 100), N_HALO);
    let disc = thin + thick;
    // Spiral-arm enhancement applies to the (young) disc population.
    if (R > 1000 && R < R_DISC_MAX) disc *= armFactor(R, Math.atan2(gy, gx));
    // Central bulge: a soft exponential that dominates the inner few kpc.
    const r3d = Math.hypot(R, z);
    const bulge = A_BULGE * Math.exp(-r3d / R_BULGE);
    return disc + halo + bulge;
}

// Multiplicative arm enhancement: 1 + amp·exp(-d²/2σ²), d = perpendicular
// distance to the nearest logarithmic-spiral arm at this radius.
function armFactor(R, theta) {
    // Arm crosses angle θ_arm(R) = θ_i + ln(R/ARM_R0)/tan(pitch).
    const base = Math.log(R / ARM_R0) / TAN_PITCH;
    let best = Infinity;
    for (let i = 0; i < N_ARMS; i++) {
        const thetaArm = (i * 2 * Math.PI / N_ARMS) + base;
        let d = theta - thetaArm;
        d = Math.atan2(Math.sin(d), Math.cos(d));        // wrap to [-π,π]
        const perp = Math.abs(d) * R * Math.cos(ARM_PITCH); // ≈ perpendicular pc
        if (perp < best) best = perp;
    }
    return 1 + ARM_AMP * Math.exp(-(best * best) / (2 * ARM_SIGMA * ARM_SIGMA));
}

// Per-cell generation cache (revisits are pure but caching avoids recompute).
const cache = new Map();
const CACHE_MAX = 4096;
function cacheKey(seed, ci, cj, ck) { return (seed >>> 0) + "," + ci + "," + cj + "," + ck; }
const localCache = new Map();
const LOCAL_CACHE_MAX = 8192;
function localCacheKey(seed, ci, cj, ck) { return (seed >>> 0) + "," + ci + "," + cj + "," + ck; }

// Generate the stars in one galactocentric cell. Pure in (SEED, ci, cj, ck).
// Returns an array of star objects:
//   { gx,gy,gz (pc, galactocentric), x,y,z (km, Sol-centred equatorial),
//     mass,L,R(R⊙),Teff,color,cls, id }
export function starsInCell(ci, cj, ck) {
    const seed = SEED >>> 0;
    const key = cacheKey(seed, ci, cj, ck);
    const hit = cache.get(key);
    if (hit) return hit;

    const ox = ci * CELL_PC, oy = cj * CELL_PC, oz = ck * CELL_PC;
    const cx = ox + CELL_PC / 2, cy = oy + CELL_PC / 2, cz = oz + CELL_PC / 2;
    const R = Math.hypot(cx, cy);

    let out;
    if (R > R_DISC_MAX + 500 || Math.abs(cz) > Z_DISC_MAX) {
        out = [];
    } else {
        const dens = densityAt(cx, cy, cz);
        let expected = N_SUN_PC3 * dens * CELL_VOL;
        // Materialisation cap: a memory guard for the dense inner galaxy/bulge,
        // set well above the local-disc count (~1.3e5/cell) so the Solar
        // neighbourhood is never throttled. Inner-galaxy LOD subsampling (which
        // renders dense regions without materialising every star) is task #10.
        if (expected > MATERIALISE_MAX) expected = MATERIALISE_MAX;
        const rng = makeRNG(hashInts(seed, LEVEL_STAR, ci, cj, ck));
        const n = samplePoisson(rng, expected);
        out = new Array(n);
        let w = 0;
        const densCenter = Math.max(dens, 1e-9);
        for (let k = 0; k < n; k++) {
            const gx = ox + rng() * CELL_PC;
            const gy = oy + rng() * CELL_PC;
            const gz = oz + rng() * CELL_PC;
            // Light rejection against the local density so the within-cell
            // distribution follows the gradient (esp. the vertical falloff).
            if (rng() > densityAt(gx, gy, gz) / densCenter) continue;
            const mass = sampleKroupaMass(rng);
            // Convert the birth IMF to a present-day population: short-lived
            // massive stars have mostly evolved off the main sequence.
            if (mass > 1 && rng() > msLifetimeWeight(mass)) continue;
            const props = deriveStar(mass);
            const eq = galToEquatorialKm(gx, gy, gz);
            out[w++] = {
                gx, gy, gz,
                x: eq[0], y: eq[1], z: eq[2],
                mass: props.mass, L: props.L, R: props.R, Teff: props.Teff,
                color: props.color, cls: props.cls,
                id: "g:" + seed + ":" + ci + ":" + cj + ":" + ck + ":" + k,
            };
        }
        out.length = w;
    }

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, out);
    return out;
}

// All procedurally generated stars within radiusPc of a galactocentric point.
export function sampleStarsNear(gx, gy, gz, radiusPc) {
    const ciLo = Math.floor((gx - radiusPc) / CELL_PC), ciHi = Math.floor((gx + radiusPc) / CELL_PC);
    const cjLo = Math.floor((gy - radiusPc) / CELL_PC), cjHi = Math.floor((gy + radiusPc) / CELL_PC);
    const ckLo = Math.floor((gz - radiusPc) / CELL_PC), ckHi = Math.floor((gz + radiusPc) / CELL_PC);
    const r2 = radiusPc * radiusPc;
    const found = [];
    for (let ci = ciLo; ci <= ciHi; ci++)
        for (let cj = cjLo; cj <= cjHi; cj++)
            for (let ck = ckLo; ck <= ckHi; ck++) {
                const stars = starsInCell(ci, cj, ck);
                for (let s = 0; s < stars.length; s++) {
                    const st = stars[s];
                    const dx = st.gx - gx, dy = st.gy - gy, dz = st.gz - gz;
                    if (dx * dx + dy * dy + dz * dz <= r2) found.push(st);
                }
            }
    return found;
}

// Fine-grained deterministic sample for the active ship neighbourhood. It uses
// 4 pc cells so runtime streaming never materialises a full 100 pc catalogue
// cell just to find the few stars around the ship.
export function sampleLocalStarsNear(gx, gy, gz, radiusPc, limit = 512) {
    const ciLo = Math.floor((gx - radiusPc) / LOCAL_CELL_PC), ciHi = Math.floor((gx + radiusPc) / LOCAL_CELL_PC);
    const cjLo = Math.floor((gy - radiusPc) / LOCAL_CELL_PC), cjHi = Math.floor((gy + radiusPc) / LOCAL_CELL_PC);
    const ckLo = Math.floor((gz - radiusPc) / LOCAL_CELL_PC), ckHi = Math.floor((gz + radiusPc) / LOCAL_CELL_PC);
    const r2 = radiusPc * radiusPc;
    const found = [];
    for (let ci = ciLo; ci <= ciHi; ci++)
        for (let cj = cjLo; cj <= cjHi; cj++)
            for (let ck = ckLo; ck <= ckHi; ck++) {
                for (const st of localStarsInCell(ci, cj, ck)) {
                    const dx = st.gx - gx, dy = st.gy - gy, dz = st.gz - gz;
                    const d2 = dx * dx + dy * dy + dz * dz;
                    if (d2 <= r2) found.push({ ...st, d2 });
                }
            }
    found.sort((a, b) => a.d2 - b.d2 || (a.id < b.id ? -1 : 1));
    if (found.length > limit) found.length = limit;
    for (const st of found) delete st.d2;
    return found;
}

export function localStarsInCell(ci, cj, ck, seed = SEED) {
    seed >>>= 0;
    const key = localCacheKey(seed, ci, cj, ck);
    const hit = localCache.get(key);
    if (hit) return hit;
    const ox = ci * LOCAL_CELL_PC, oy = cj * LOCAL_CELL_PC, oz = ck * LOCAL_CELL_PC;
    const cx = ox + LOCAL_CELL_PC / 2, cy = oy + LOCAL_CELL_PC / 2, cz = oz + LOCAL_CELL_PC / 2;
    const R = Math.hypot(cx, cy);
    let out = [];
    if (R <= R_DISC_MAX + 500 && Math.abs(cz) <= Z_DISC_MAX) {
        const dens = densityAt(cx, cy, cz);
        if (dens > 0) {
            const expected = Math.min(LOCAL_MATERIALISE_MAX, N_SUN_PC3 * dens * LOCAL_CELL_VOL);
            const rng = makeRNG(hashInts(seed, LEVEL_LOCAL_STAR, ci, cj, ck));
            const n = samplePoisson(rng, expected);
            const densCenter = Math.max(dens, 1e-9);
            out = [];
            for (let k = 0; k < n; k++) {
                const sx = ox + rng() * LOCAL_CELL_PC;
                const sy = oy + rng() * LOCAL_CELL_PC;
                const sz = oz + rng() * LOCAL_CELL_PC;
                if (rng() > densityAt(sx, sy, sz) / densCenter) continue;
                const mass = sampleKroupaMass(rng);
                if (mass > 1 && rng() > msLifetimeWeight(mass)) continue;
                const props = deriveStar(mass);
                const eq = galToEquatorialKm(sx, sy, sz);
                out.push({
                    gx: sx, gy: sy, gz: sz,
                    x: eq[0], y: eq[1], z: eq[2],
                    mass: props.mass, L: props.L, R: props.R, Teff: props.Teff,
                    color: props.color, cls: props.cls,
                    id: "p:" + seed + ":" + ci + ":" + cj + ":" + ck + ":" + k,
                });
            }
        }
    }
    if (localCache.size >= LOCAL_CACHE_MAX) localCache.clear();
    localCache.set(key, out);
    return out;
}

export function localStarById(id) {
    const m = String(id || "").match(/^p:(\d+):(-?\d+):(-?\d+):(-?\d+):(\d+)$/);
    if (!m) return null;
    const seed = Number(m[1]) >>> 0;
    const ci = Number(m[2]), cj = Number(m[3]), ck = Number(m[4]);
    const stars = localStarsInCell(ci, cj, ck, seed);
    return stars.find(st => st.id === id) || null;
}

export function clearCache() { cache.clear(); localCache.clear(); }
