// Visual galaxy rendering built from the procedural Milky Way model.
//
// makeGalaxyCloud samples a representative point cloud of the whole Galaxy from
// the same structural model the per-star generator (galaxy.js) uses, then maps
// each point through the galactocentric→equatorial transform (coords.js) into
// the Sol-centred equatorial scene frame that the rest of the sim uses. This
// replaces the old hand-tuned, ~87°-misaligned decorative spiral: the band now
// lines up with the real HYG catalog and Sgr A* sits at the true Galactic centre.
//
// Points are luminosity-weighted (a galaxy's light is dominated by its rare hot
// stars, not its many red dwarfs), so spiral arms read blue-white and the bulge
// reads warm — the physically-correct appearance.

import { K } from "../constants.js";
import { galToEquatorialKm } from "./coords.js";
import { GALAXY_STRUCT } from "./galaxy.js";
import { sampleKroupaMass, deriveStar } from "./stellar.js";
import { makeRNG, hashInts, randNormal } from "./prng.js";

const TAU = Math.PI * 2;

// Truncated exponential sample on [0, max] with scale h (inverse-CDF).
function expTrunc(rng, h, max) {
    const cap = 1 - Math.exp(-max / h);
    return -h * Math.log(1 - rng() * cap);
}
// Two-sided exponential (Laplace) for disc height.
function laplace(rng, h) {
    return (rng() < 0.5 ? -1 : 1) * (-h * Math.log(1 - rng()));
}

// Map a galactocentric position (pc) into absolute scene units, using the same
// (eqX, eqZ, -eqY)·K axis convention as constants.js STARS and the HYG cloud.
function galPcToScene(gx, gy, gz, out, o) {
    const eq = galToEquatorialKm(gx, gy, gz); // km, Sol-centred equatorial
    out[o] = eq[0] * K;
    out[o + 1] = eq[2] * K;
    out[o + 2] = -eq[1] * K;
}

// Galactocentric scene position of the Galactic centre (for camera focus).
export function galacticCenterScene() {
    const out = [0, 0, 0];
    galPcToScene(0, 0, 0, out, 0);
    return out;
}

// Build a representative galaxy point cloud (positions + colors as Float32Arrays
// ready for THREE.BufferAttribute). Deterministic in `seed`.
export function makeGalaxyCloud(n = 160000, seed = 0x6d57) {
    const S = GALAXY_STRUCT;
    const TAN = Math.tan(S.ARM_PITCH);
    const rng = makeRNG(hashInts(seed, 0xa17));
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
        const u = rng();
        let gx, gy, gz, kind;
        if (u < 0.70) {            // thin disc
            const R = expTrunc(rng, S.HR_THIN, S.R_DISC_MAX);
            const z = laplace(rng, S.HZ_THIN);
            [gx, gy, gz] = discPos(rng, R, z, S, TAN, true);
            kind = "arm-disc";
        } else if (u < 0.82) {     // thick disc
            const R = expTrunc(rng, S.HR_THICK, S.R_DISC_MAX);
            const z = laplace(rng, S.HZ_THICK);
            [gx, gy, gz] = discPos(rng, R, z, S, TAN, false);
            kind = "disc";
        } else if (u < 0.95) {     // bulge (flattened spheroid)
            const r = expTrunc(rng, S.R_BULGE, 3500);
            const ct = 2 * rng() - 1, st = Math.sqrt(1 - ct * ct), ph = rng() * TAU;
            gx = r * st * Math.cos(ph); gy = r * st * Math.sin(ph); gz = r * ct * 0.6;
            kind = "bulge";
        } else {                   // stellar halo (extended, near-spherical)
            const r = S.R0_PC * Math.pow(rng(), -1 / (S.N_HALO - 1)); // power-law tail
            const rr = Math.min(r, 60000);
            const ct = 2 * rng() - 1, st = Math.sqrt(1 - ct * ct), ph = rng() * TAU;
            gx = rr * st * Math.cos(ph); gy = rr * st * Math.sin(ph); gz = rr * ct * S.Q_HALO;
            kind = "halo";
        }

        galPcToScene(gx, gy, gz, pos, i * 3);
        starColor(rng, kind, col, i * 3);
    }
    return { pos, col };
}

// Disc position: optionally snap a fraction of stars onto a spiral arm so the
// arms are visible. Returns [gx, gy, gz] in pc.
function discPos(rng, R, z, S, TAN, allowArm) {
    let theta = rng() * TAU;
    if (allowArm && R > 800 && rng() < 0.6) {
        const arm = Math.floor(rng() * S.N_ARMS);
        const thetaArm = (arm * TAU / S.N_ARMS) + Math.log(R / S.ARM_R0) / TAN;
        const sigAng = Math.min(0.7, S.ARM_SIGMA / Math.max(R, 500));
        theta = thetaArm + randNormal(rng) * sigAng;
    }
    return [R * Math.cos(theta), R * Math.sin(theta), z];
}

// Assign a luminosity-weighted colour for a galaxy point of a given population.
function starColor(rng, kind, col, o) {
    let mass;
    if (kind === "arm-disc" && rng() < 0.12) {
        mass = 3 + rng() * 12;               // young hot tracer in spiral arms
    } else if (kind === "bulge") {
        mass = 0.5 + rng() * 0.8;            // old, cool bulge population
    } else {
        mass = sampleKroupaMass(rng);        // field IMF
    }
    const sp = deriveStar(mass);
    // Brightness gain ∝ log luminosity (clamped): hot luminous stars dominate.
    const gain = Math.max(0.32, Math.min(1.5, 0.55 + 0.2 * Math.log10(Math.max(sp.L, 1e-3))));
    col[o] = Math.min(1, ((sp.color >> 16) & 255) / 255 * gain);
    col[o + 1] = Math.min(1, ((sp.color >> 8) & 255) / 255 * gain);
    col[o + 2] = Math.min(1, (sp.color & 255) / 255 * gain);
}

// A ring in the Galactic plane at galactocentric radius Rpc, returned as scene
// positions (Float32Array of segs*3) for a THREE.LineLoop.
export function galacticRingPositions(Rpc, segs = 480) {
    const pos = new Float32Array(segs * 3);
    for (let i = 0; i < segs; i++) {
        const a = i / segs * TAU;
        galPcToScene(Rpc * Math.cos(a), Rpc * Math.sin(a), 0, pos, i * 3);
    }
    return pos;
}
