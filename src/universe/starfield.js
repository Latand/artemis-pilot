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
import { galToSceneUnitsInto } from "./coords.js";
import { GALAXY_STRUCT } from "./galaxy.js";
import { sampleKroupaMass, deriveStarVisualInto } from "./stellar.js";
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
    galToSceneUnitsInto(gx, gy, gz, out, o, K);
}

// Galactocentric scene position of the Galactic centre (for camera focus).
export function galacticCenterScene() {
    const out = [0, 0, 0];
    galPcToScene(0, 0, 0, out, 0);
    return out;
}

// Build a representative galaxy point cloud (positions + colors as Float32Arrays
// ready for THREE.BufferAttribute). Deterministic in `seed`.
//
// `era` (optional, from cosmicEra.js's eraModulation()) thins the young-arm
// blue-star population by `era.blueFrac` at generation time — this is the
// only era effect baked into the buffer. Overall tint/luminosity are cheap
// per-frame material uniforms applied afterward via applyEraToCloud(), not
// baked here, so regenerating is only needed for a population-composition
// change (a large `blueFrac` jump), not every frame. Passing no `era` (the
// default) reproduces the exact pre-WP23c output byte-for-byte.
export function makeGalaxyCloud(n = 160000, seed = 0x6d57, era = null) {
    const S = GALAXY_STRUCT;
    const TAN = Math.tan(S.ARM_PITCH);
    const rng = makeRNG(hashInts(seed, 0xa17));
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const d = [0, 0, 0];
    const visual = { L: 1, color: 0xffffff };

    for (let i = 0; i < n; i++) {
        writeGalaxyPoint(rng, S, TAN, pos, col, i, d, visual, era);
    }
    return { pos, col };
}

export async function makeGalaxyCloudAsync(n = 160000, seed = 0x6d57, chunk = 8192, yieldFn = null, era = null) {
    const S = GALAXY_STRUCT;
    const TAN = Math.tan(S.ARM_PITCH);
    const rng = makeRNG(hashInts(seed, 0xa17));
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const d = [0, 0, 0];
    const visual = { L: 1, color: 0xffffff };

    for (let i = 0; i < n; i++) {
        writeGalaxyPoint(rng, S, TAN, pos, col, i, d, visual, era);
        if (yieldFn && chunk > 0 && (i + 1) % chunk === 0) await yieldFn();
    }
    return { pos, col };
}

function writeGalaxyPoint(rng, S, TAN, pos, col, i, d, visual, era) {
    const u = rng();
    let gx, gy, gz, kind;
    if (u < 0.70) {            // thin disc
        const R = expTrunc(rng, S.HR_THIN, S.R_DISC_MAX);
        const z = laplace(rng, S.HZ_THIN);
        discPosInto(rng, R, z, S, TAN, true, d);
        gx = d[0]; gy = d[1]; gz = d[2];
        kind = "arm-disc";
    } else if (u < 0.82) {     // thick disc
        const R = expTrunc(rng, S.HR_THICK, S.R_DISC_MAX);
        const z = laplace(rng, S.HZ_THICK);
        discPosInto(rng, R, z, S, TAN, false, d);
        gx = d[0]; gy = d[1]; gz = d[2];
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
    starColor(rng, kind, col, i * 3, visual, era);
}

// Disc position: optionally snap a fraction of stars onto a spiral arm so the
// arms are visible. Writes [gx, gy, gz] in pc to avoid per-point allocations.
function discPosInto(rng, R, z, S, TAN, allowArm, out) {
    let theta = rng() * TAU;
    if (allowArm && R > 800 && rng() < 0.6) {
        const arm = Math.floor(rng() * S.N_ARMS);
        const thetaArm = (arm * TAU / S.N_ARMS) + Math.log(R / S.ARM_R0) / TAN;
        const sigAng = Math.min(0.7, S.ARM_SIGMA / Math.max(R, 500));
        theta = thetaArm + randNormal(rng) * sigAng;
    }
    out[0] = R * Math.cos(theta);
    out[1] = R * Math.sin(theta);
    out[2] = z;
    return out;
}

// Assign a luminosity-weighted colour for a galaxy point of a given population.
// `era` (optional) scales down the young-hot-tracer draw probability by
// era.blueFrac, so as star formation declines (post-Milkomeda-merger, see
// cosmicEra.js) the arm population statistically shifts toward the older
// field IMF instead of staying eternally blue.
function starColor(rng, kind, col, o, visual, era) {
    let mass;
    const blueFrac = era ? era.blueFrac : 1;
    if (kind === "arm-disc" && rng() < 0.12 * blueFrac) {
        mass = 3 + rng() * 12;               // young hot tracer in spiral arms
    } else if (kind === "bulge") {
        mass = 0.5 + rng() * 0.8;            // old, cool bulge population
    } else {
        mass = sampleKroupaMass(rng);        // field IMF
    }
    deriveStarVisualInto(mass, visual);
    // Brightness gain ∝ log luminosity (clamped): hot luminous stars dominate.
    const gain = Math.max(0.32, Math.min(1.5, 0.55 + 0.2 * Math.log10(Math.max(visual.L, 1e-3))));
    col[o] = Math.min(1, ((visual.color >> 16) & 255) / 255 * gain);
    col[o + 1] = Math.min(1, ((visual.color >> 8) & 255) / 255 * gain);
    col[o + 2] = Math.min(1, (visual.color & 255) / 255 * gain);
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

// Cheap per-frame deep-time tint for an already-built galaxy cloud (a
// THREE.Points/Group as produced by cosmic.js's `points()`/`milkyWayHalo()`
// helpers around this module's cloud data), driven by cosmicEra.js's
// eraModulation(). Mutates only material.color/opacity (a uniform-level
// multiply against the baked vertex colors/alpha) — no buffer touch, no GPU
// upload, safe to call every frame. Recurses into `.children` so a caller can
// pass either a single Points object or the group that contains the cloud,
// the halo, and the plane rings. Population-level effects (fewer young blue
// stars as era.blueFrac falls) require a buffer rebuild — the caller triggers
// that separately and rarely (see makeGalaxyCloudAsync's `era` argument),
// throttled to large era changes since a full regenerate is comparatively
// expensive.
export function applyEraToCloud(cloud, era) {
    if (!cloud || !era) return;
    if (cloud.material) tintMaterial(cloud.material, era);
    if (cloud.children && cloud.children.length) {
        for (const child of cloud.children) applyEraToCloud(child, era);
    }
}

function tintMaterial(mat, era) {
    // Redden toward a cool ember as the aggregate population ages (F/G stars
    // fading out, K/M dwarfs left dominating the light).
    if (mat.color && typeof mat.color.setRGB === "function") {
        mat.color.setRGB(1, 1 - era.redshiftTint * 0.55, 1 - era.redshiftTint * 0.85);
    }
    // Fold total field luminosity into opacity; a small floor keeps the
    // degenerate-era field a sparse dim glow rather than a hard cut to zero.
    const lum = Math.max(0.004, era.lumFactor);
    if (mat.uniforms?.uOpacity) {
        const base = mat.userData.baseOpacity ?? mat.uniforms.uOpacity.value;
        mat.uniforms.uOpacity.value = base * lum;
    } else if (typeof mat.opacity === "number") {
        const base = mat.userData.baseOpacity ?? mat.opacity;
        mat.opacity = base * lum;
    }
}
