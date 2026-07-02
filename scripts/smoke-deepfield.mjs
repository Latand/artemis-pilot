import {
    generateDeepField, generateShell, rawSchechterCount,
    SHELLS, INNER_RADIUS_MPC, OUTER_RADIUS_MPC,
} from "../src/universe/deepField.js";

function assert(ok, message) {
    if (!ok) throw new Error(message);
}

const SEED = 0x9e3779b9;

// --- shell galaxy count within factor 2 of the Schechter integral ----------
// Only the near shell (sampleFrac=1, full census) is checked against theory
// directly -- mid/far are deliberately thinned representative subsamples
// (see deepField.js SHELLS comment), so they are checked against their own
// sampleFrac-scaled target instead, further down.
{
    const near = SHELLS.find(s => s.key === "near");
    const raw = rawSchechterCount(near.rMinMpc, near.rMaxMpc);
    const shell = generateShell(SEED, near);
    const n = shell.galaxies.length;
    assert(n > raw / 2 && n < raw * 2,
        `near shell count (${n}) should be within factor 2 of the Schechter integral (${raw.toFixed(0)})`);
    console.log(`near shell: generated=${n} schechterIntegral=${raw.toFixed(0)} (within factor 2: ok)`);
}

// --- every shell's count tracks its own (sampleFrac-thinned) target --------
{
    const field = generateDeepField(SEED);
    for (const shell of field.shells) {
        const n = shell.galaxies.length;
        assert(n > shell.targetCount / 2 && n < shell.targetCount * 2,
            `${shell.key} shell count (${n}) should be within factor 2 of its target (${shell.targetCount.toFixed(0)})`);
        console.log(`${shell.key} shell: generated=${n} target=${shell.targetCount.toFixed(0)} sampleFrac=${shell.sampleFrac}`);
    }
}

// --- no galaxy inside the Local Group's authoritative radius ---------------
{
    const field = generateDeepField(SEED);
    for (const shell of field.shells) {
        for (const g of shell.galaxies) {
            assert(g.distMpc >= INNER_RADIUS_MPC,
                `${shell.key} shell galaxy at ${g.distMpc.toFixed(3)} Mpc is inside INNER_RADIUS_MPC (${INNER_RADIUS_MPC})`);
            assert(g.distMpc <= OUTER_RADIUS_MPC + 1e-6,
                `${shell.key} shell galaxy at ${g.distMpc.toFixed(3)} Mpc is beyond OUTER_RADIUS_MPC (${OUTER_RADIUS_MPC})`);
        }
    }
    console.log("no galaxy found inside the 3 Mpc Local Group boundary or beyond the 1 Gly outer radius");
}

// --- counts-in-cells variance/mean >= 2 (non-Poisson clustering) -----------
// Bin the mid shell (large N, single contiguous volume) into cubic cells
// well above the generation voxel size, so this measures real spatial
// clustering of the resulting POINT PATTERN, not just an artifact of the
// generation grid.
{
    const mid = SHELLS.find(s => s.key === "mid");
    const shell = generateShell(SEED, mid);
    const cellMpc = 20;
    const counts = new Map();
    for (const g of shell.galaxies) {
        const cx = Math.floor(g.xMpc / cellMpc), cy = Math.floor(g.yMpc / cellMpc), cz = Math.floor(g.zMpc / cellMpc);
        const key = cx + "," + cy + "," + cz;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    const values = Array.from(counts.values());
    const n = values.length;
    assert(n > 50, `expected a reasonable number of occupied cells for the clustering test, got ${n}`);
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const ratio = variance / mean;
    assert(ratio >= 2, `counts-in-cells variance/mean (${ratio.toFixed(2)}) should be >= 2 (non-Poisson clustering), mean=${mean.toFixed(2)} cells=${n}`);
    console.log(`mid shell counts-in-cells: cells=${n} mean=${mean.toFixed(2)} variance=${variance.toFixed(2)} variance/mean=${ratio.toFixed(2)}`);
}

// --- determinism: two independent generations agree on the first 100 galaxies
{
    const a = generateDeepField(SEED);
    const b = generateDeepField(SEED);
    const flatA = a.shells.flatMap(s => s.galaxies);
    const flatB = b.shells.flatMap(s => s.galaxies);
    assert(flatA.length === flatB.length, `two runs should generate the same total galaxy count (${flatA.length} vs ${flatB.length})`);
    const sampleN = Math.min(100, flatA.length);
    for (let i = 0; i < sampleN; i++) {
        const ga = flatA[i], gb = flatB[i];
        assert(ga.xMpc === gb.xMpc && ga.yMpc === gb.yMpc && ga.zMpc === gb.zMpc && ga.Lx === gb.Lx && ga.type === gb.type,
            `galaxy ${i} should be bit-identical across two runs with the same seed`);
    }
    console.log(`determinism: first ${sampleN} galaxies identical across two independent generateDeepField(${SEED}) calls`);
}

// --- L distribution passes a coarse Schechter shape check -------------------
// alpha=-1.2 with an exp(-x) cutoff should produce far more faint (L<L*)
// than bright (L>=L*) galaxies -- use the mid shell for a large sample.
{
    const mid = SHELLS.find(s => s.key === "mid");
    const shell = generateShell(SEED, mid);
    let faint = 0, bright = 0;
    for (const g of shell.galaxies) {
        if (g.Lx < 1) faint++; else bright++;
    }
    assert(bright > 0, "expected at least some bright (L>=L*) galaxies to make the ratio meaningful");
    const ratio = faint / bright;
    assert(ratio >= 10, `faint:bright ratio (${ratio.toFixed(1)}) should be >= 10 (Schechter shape check), faint=${faint} bright=${bright}`);
    console.log(`Schechter L shape: faint(L<L*)=${faint} bright(L>=L*)=${bright} ratio=${ratio.toFixed(1)} (>= 10: ok)`);
}

console.log("deepfield smoke passed");
