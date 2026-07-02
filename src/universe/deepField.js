// Extragalactic deep field: the universe beyond the Local Group (WP24).
//
// Pure, deterministic, Node-testable population model -- no THREE/DOM import
// here (src/render/deepFieldRender.js owns the GPU side). Everything below is
// a function of (seed, shell definition) only, per src/universe/prng.js's
// hashInts/makeRNG/splitSeed convention (no Math.random anywhere).
//
// Scope, per research/astro-population-model.md §8 and the full-universe
// plan's WP24: this is a statistically-correct DECORATIVE background, not a
// cosmological N-body simulation (halo formation, mergers, etc. stay out of
// scope per plan §A9). McConnachie 2012 catalog objects (M31, M33, LMC, SMC,
// ...) stay authoritative out to INNER_RADIUS_MPC -- this module generates
// nothing inside that radius.
//
// Units: Mpc and solar luminosities (Lsun) throughout. Galaxy positions are
// plain Sol-centered cartesian Mpc coordinates (xMpc,yMpc,zMpc) -- deliberately
// NOT converted to world-frame kilometres or scene units here. At Gly scales
// a literal km/scene conversion overflows float32 (1 Gly * K ~ 1e19 scene
// units) for no benefit: nothing in this game ever travels outside the Local
// Group, so there is no real parallax budget to spend on literal distances
// beyond it. deepFieldRender.js maps (direction, distance-within-shell) to a
// compressed, float32-safe display radius per shell instead -- see the long
// comment there for why that is the right trade, not a shortcut.

import { hashInts, makeRNG, splitSeed, samplePoisson } from "./prng.js";

// --- Cosmology (astro report §8) --------------------------------------------
export const H0_KM_S_MPC = 70;
export const C_KM_S = 299792.458;

// The Local Group (McConnachie 2012 catalog) stays authoritative inside this
// radius; the deep field generates nothing here (its own smoke asserts this).
export const INNER_RADIUS_MPC = 3;
// "~1 Gly" per the plan; 1 Gly = 1e9 ly / 3.2615637771674e6 ly-per-Mpc.
export const OUTER_RADIUS_MPC = 1e9 / 3.2615637771674e6; // ~306.6 Mpc

// Hubble-law redshift. Non-relativistic (z = H0 d / c) is accurate to <1%
// out to the full 306.6 Mpc deep-field radius (z_max ~ 0.0716), so no need
// for a relativistic distance-redshift relation for a decorative field.
export function redshiftForDistance(distMpc) {
    return H0_KM_S_MPC * distMpc / C_KM_S;
}
// Cosmological (Tolman) surface-brightness dimming, (1+z)^-4.
export function dimmingFactor(z) {
    return Math.pow(1 + z, -4);
}

// --- Schechter luminosity function (astro report §8) ------------------------
// phi(L) dL = phi* (L/L*)^alpha exp(-L/L*) dL/L*. Only the SHAPE (alpha) and
// the lower cutoff (xMin) matter for per-galaxy sampling; phi* itself is
// folded into N0_PER_MPC3 below (the WP's "Schechter integral ~= 0.01
// galaxies/Mpc^3 above 0.1 L*" is the number density this module targets
// directly, rather than re-deriving it from phi*/alpha by integration).
export const SCHECHTER_ALPHA = -1.2;
export const SCHECHTER_MSTAR_B = -20.8;
export const SCHECHTER_LMIN_X = 0.1; // generate only L >= 0.1 L*
export const SCHECHTER_LMAX_X = 40;  // exp(-40) is negligible; safe hard cutoff
// Number density of galaxies with L >= 0.1 L*, galaxies/Mpc^3.
export const N0_PER_MPC3 = 0.01;

// Johnson B-band solar absolute magnitude, used only to give generated
// galaxies a plausible solar-luminosity scale (M*_B -> L* in Lsun); no
// dynamics depend on this, it is purely a display-luminosity anchor.
const M_B_SUN = 5.48;
export const L_STAR_LSUN = Math.pow(10, 0.4 * (M_B_SUN - SCHECHTER_MSTAR_B));

// Build an inverse-CDF table for x=L/L* on [xMin,xMax] with Schechter shape
// x^alpha * exp(-x): trapezoid-integrate the (unnormalized) PDF into a
// monotone CDF once, then invert by binary search per draw. Pure numerics,
// no RNG in this step -- deterministic and reused across all draws.
function buildSchechterTable(alpha, xMin, xMax, steps) {
    const xs = new Float64Array(steps + 1);
    const cdf = new Float64Array(steps + 1);
    const dx = (xMax - xMin) / steps;
    let prevPdf = Math.pow(xMin, alpha) * Math.exp(-xMin);
    xs[0] = xMin;
    for (let i = 1; i <= steps; i++) {
        const x = xMin + i * dx;
        const pdf = Math.pow(x, alpha) * Math.exp(-x);
        xs[i] = x;
        cdf[i] = cdf[i - 1] + 0.5 * (pdf + prevPdf) * dx;
        prevPdf = pdf;
    }
    const total = cdf[steps];
    for (let i = 0; i <= steps; i++) cdf[i] /= total;
    return { xs, cdf };
}

let _schechterTable = null;
function schechterTable() {
    if (!_schechterTable) {
        _schechterTable = buildSchechterTable(SCHECHTER_ALPHA, SCHECHTER_LMIN_X, SCHECHTER_LMAX_X, 4096);
    }
    return _schechterTable;
}

function invertTable(table, u) {
    const { xs, cdf } = table;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < u) lo = mid + 1; else hi = mid;
    }
    if (lo === 0) return xs[0];
    const c0 = cdf[lo - 1], c1 = cdf[lo];
    const t = c1 > c0 ? (u - c0) / (c1 - c0) : 0;
    return xs[lo - 1] + t * (xs[lo] - xs[lo - 1]);
}

// Draw x = L/L* from the Schechter shape via inverse-CDF table lookup.
export function sampleSchechterX(rng) {
    return invertTable(schechterTable(), rng());
}

// --- Cosmic-web density field (astro report §8: cheap deterministic --------
// low-res value-noise/Voronoi-style modulation, NOT a cosmological
// simulation). A coarse lattice of hashed node values, trilinearly
// interpolated and summed across 3 octaves for filament/void contrast, then
// exponentiated into a strictly-positive density multiplier (the standard
// "log-normal field" trick for turning signed noise into density contrast:
// voids near-empty, filaments/nodes over-dense).
const NOISE_CELL_MPC = 12;

function noiseNode(seed, ix, iy, iz) {
    const h = hashInts(seed, 0x00c05171, ix | 0, iy | 0, iz | 0);
    return (h / 0x100000000) * 2 - 1; // [-1, 1)
}
function smooth(t) { return t * t * (3 - 2 * t); }

function latticeNoise3(seed, x, y, z, cellMpc) {
    const gx = x / cellMpc, gy = y / cellMpc, gz = z / cellMpc;
    const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
    const fx = smooth(gx - ix), fy = smooth(gy - iy), fz = smooth(gz - iz);
    const n000 = noiseNode(seed, ix, iy, iz), n100 = noiseNode(seed, ix + 1, iy, iz);
    const n010 = noiseNode(seed, ix, iy + 1, iz), n110 = noiseNode(seed, ix + 1, iy + 1, iz);
    const n001 = noiseNode(seed, ix, iy, iz + 1), n101 = noiseNode(seed, ix + 1, iy, iz + 1);
    const n011 = noiseNode(seed, ix, iy + 1, iz + 1), n111 = noiseNode(seed, ix + 1, iy + 1, iz + 1);
    const c00 = n000 * (1 - fx) + n100 * fx;
    const c10 = n010 * (1 - fx) + n110 * fx;
    const c01 = n001 * (1 - fx) + n101 * fx;
    const c11 = n011 * (1 - fx) + n111 * fx;
    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;
    return c0 * (1 - fz) + c1 * fz;
}

// 3-octave fractal sum -- more filament/void contrast than one lattice.
function cosmicWebNoise(seed, x, y, z) {
    const n1 = latticeNoise3(seed, x, y, z, NOISE_CELL_MPC);
    const n2 = latticeNoise3(seed ^ 0x51ed270b, x, y, z, NOISE_CELL_MPC * 0.42);
    const n3 = latticeNoise3(seed ^ 0x2545f491, x, y, z, NOISE_CELL_MPC * 0.17);
    return n1 + n2 * 0.55 + n3 * 0.28;
}

const CLUSTER_AMP = 1.35;
// Strictly-positive density weight at a point, mean ~O(1) but with heavy-
// tailed excursions (filaments/nodes) and near-zero troughs (voids) -- this
// is what makes counts-in-cells over-dispersed vs Poisson.
export function densityWeight(seed, x, y, z) {
    return Math.exp(CLUSTER_AMP * cosmicWebNoise(seed, x, y, z));
}

// --- Shell definitions -------------------------------------------------------
// Three distance-shell LOD tiers (src/render/deepFieldRender.js consumes
// these 1:1). `sampleFrac` thins the true Schechter density for mid/far:
// full census beyond ~50 Mpc runs into 1e5-1e6 galaxies (N0 * shell volume),
// far beyond any sane point budget for a decorative background layer, so
// mid/far are generated as a uniformly-thinned, STATISTICALLY REPRESENTATIVE
// subsample of the true Poisson process (a uniform thinning of a Poisson
// process is itself Poisson at the reduced rate, so the Schechter L-shape,
// the clustering pattern and every per-galaxy physical property stay exact --
// only the raw galaxy COUNT is reduced). The near shell (the only one the
// smoke suite checks against the literal Schechter integral) is full census.
export const SHELLS = [
    { key: "near", rMinMpc: INNER_RADIUS_MPC, rMaxMpc: 50, voxelMpc: 5, sampleFrac: 1 },
    { key: "mid", rMinMpc: 50, rMaxMpc: 150, voxelMpc: 10, sampleFrac: 0.25 },
    { key: "far", rMinMpc: 150, rMaxMpc: OUTER_RADIUS_MPC, voxelMpc: 16, sampleFrac: 0.03 },
];

export function shellVolumeMpc3(rMinMpc, rMaxMpc) {
    return (4 / 3) * Math.PI * (rMaxMpc ** 3 - rMinMpc ** 3);
}

// The literal Schechter-integral galaxy count (>=0.1 L*) for an arbitrary
// [rMin,rMax] shell, independent of any shell's sampleFrac -- what the smoke
// suite compares the near shell's generated count against.
export function rawSchechterCount(rMinMpc, rMaxMpc) {
    return N0_PER_MPC3 * shellVolumeMpc3(rMinMpc, rMaxMpc);
}

// Representative color temperature per Hubble type (astro report: 70%
// spiral/irregular = bluer/younger-looking, 30% elliptical = redder/older
// population), with a little per-galaxy jitter. These are DISPLAY Teffs for
// a whole galaxy's integrated light, not a single star's -- deliberately
// simple (no isochrone population synthesis; explicitly out of scope, A9).
function typeTeffK(rng, isSpiral) {
    const jitter = (rng() - 0.5) * 700;
    return (isSpiral ? 7800 : 4400) + jitter;
}

// Generate one shell's galaxy catalog: deterministic pure function of
// (seed, shell). Voxelizes the containing cube at `voxelMpc` resolution
// (explicitly "low-res" per the WP), keeps only voxels whose center falls
// inside [rMinMpc, rMaxMpc), weights each voxel by the cosmic-web density
// field, then normalizes so the EXPECTED total count over the whole shell
// matches the (sampleFrac-thinned) Schechter integral exactly while
// individual voxel counts still vary with the density field.
export function generateShell(seed, shell) {
    const { key, rMinMpc, rMaxMpc, voxelMpc, sampleFrac } = shell;
    const shellSeed = splitSeed(seed, hashInts(0x5eed0000, Math.round(rMinMpc * 100), Math.round(rMaxMpc * 100)));

    const half = Math.ceil(rMaxMpc / voxelMpc);
    const voxels = [];
    let sumWeightVol = 0;
    for (let ix = -half; ix < half; ix++) {
        const cx = (ix + 0.5) * voxelMpc;
        for (let iy = -half; iy < half; iy++) {
            const cy = (iy + 0.5) * voxelMpc;
            for (let iz = -half; iz < half; iz++) {
                const cz = (iz + 0.5) * voxelMpc;
                const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
                if (d < rMinMpc || d >= rMaxMpc) continue;
                const w = densityWeight(shellSeed, cx, cy, cz);
                voxels.push({ cx, cy, cz, w });
                sumWeightVol += w;
            }
        }
    }

    const voxelVol = voxelMpc ** 3;
    const targetDensity = N0_PER_MPC3 * sampleFrac;
    const targetTotal = targetDensity * shellVolumeMpc3(rMinMpc, rMaxMpc);
    const scale = sumWeightVol > 0 ? targetTotal / (sumWeightVol * voxelVol) : 0;

    const galRng = makeRNG(splitSeed(shellSeed, 0x9a1a5eed));
    const table = schechterTable();
    const galaxies = [];
    for (const v of voxels) {
        const lambda = v.w * scale * voxelVol;
        const n = samplePoisson(galRng, lambda);
        for (let k = 0; k < n; k++) {
            const jx = v.cx + (galRng() - 0.5) * voxelMpc;
            const jy = v.cy + (galRng() - 0.5) * voxelMpc;
            const jz = v.cz + (galRng() - 0.5) * voxelMpc;
            const dist = Math.sqrt(jx * jx + jy * jy + jz * jz);
            // Jitter can push a galaxy just outside its voxel's shell
            // membership; drop rather than clip so no galaxy ever lands
            // inside INNER_RADIUS_MPC or outside its shell's true bounds.
            if (dist < rMinMpc || dist >= rMaxMpc) continue;

            const x = invertTable(table, galRng());
            const isSpiral = galRng() < 0.7;
            const z = redshiftForDistance(dist);
            galaxies.push({
                xMpc: jx, yMpc: jy, zMpc: jz, distMpc: dist,
                Lx: x, Lsun: x * L_STAR_LSUN,
                type: isSpiral ? "spiral" : "elliptical",
                // Isotropic random inclination for disks (0 = face-on); a
                // pure elliptical has no disk plane, so 0 is a no-op there.
                inclination: isSpiral ? Math.acos(1 - galRng()) : 0,
                teffK: typeTeffK(galRng, isSpiral),
                // Size grows weakly with luminosity -- a plausible few-to-
                // tens-of-kpc range, not a fitted physical relation.
                sizeKpc: 4 + 22 * Math.pow(Math.max(x, 0.02), 0.32),
                z,
                dimming: dimmingFactor(z),
            });
        }
    }
    return { key, rMinMpc, rMaxMpc, sampleFrac, targetCount: targetTotal, galaxies };
}

// Generate the full deep field: all shells, in SHELLS order.
export function generateDeepField(seed) {
    const s = seed >>> 0;
    return { seed: s, shells: SHELLS.map(shell => generateShell(s, shell)) };
}
