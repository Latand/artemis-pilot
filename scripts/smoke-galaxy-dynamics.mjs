// Time-dependent Milky Way structure (src/universe/galaxyDynamics.js and its
// use by galaxyModel.js / resolvedField.js): arms that shear, fade and recur
// without winding into strips or dissolving, material that shears with the
// disk for a bounded time, the same galaxy at every epoch, exact present-day
// structure, determinism and reverse time, and procedural stars that follow
// the arms they move through.
//
// Run: node scripts/smoke-galaxy-dynamics.mjs
const dyn = await import("../src/universe/galaxyDynamics.js");
const m = await import("../src/universe/galaxyModel.js");
const maps = await import("../src/universe/galaxyMaps.js");
const rf = await import("../src/universe/resolvedField.js");
const { vCirc } = await import("../src/universe/astroConstants.js");
const gm = maps.ensureGalaxyMaps();
// box indices (i, j, k) of bin b holding the frame point (x, y, z)
const boxAt = (b, x, y, z) => {
    const c = rf.binBoxPc(b), ze = rf.zEdgesFor(c);
    let k = 0;
    while (k + 2 < ze.length && ze[k + 1] <= z) k++;
    return [Math.floor(x / c), Math.floor(y / c), k];
};

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "PASS " : "FAIL ") + msg); if (!ok) failures++; };
const MYR = dyn.MYR_S, P = dyn.SPIRAL.periodMyr, L = dyn.EPOCH.lengthMyr;
const DEG = Math.PI / 180;

// 1. Present day: generation 0 and epoch 0 alone, unrotated, unsalted, so
// t = 0 is the measured structure exactly (the rigid model's t = 0).
{
    const u = dyn.dynamicsUniformValues(0);
    check(u.uGenW[0] === 1 && u.uGenW[1] === 0 && u.uGenW[2] === 1 && u.uGenW[3] === 0 && u.uGenA[0] === 0 && u.uGenA[1] === 0,
        "t = 0: only the present-day spiral generation, unrotated");
    check(u.uEpW[0] === 1 && u.uEpW[1] === 0 && u.uEpA[0] === 0 && u.uEpA[1] === 0 && u.uEpCell.every(v => v === 0) && u.uEpNoise0.every(v => v === 0),
        "t = 0: only the present-day material epoch, unsheared and unsalted");
    const a0 = m.patternAngles(0, {}), s1 = {}, s2 = {};
    let worst = 0;
    for (let k = 0; k < 4000; k++) {
        const R = 1500 + 20000 * ((k * 0.618034) % 1), b = 2 * Math.PI * ((k * 0.414214) % 1);
        const x = R * Math.cos(b), y = R * Math.sin(b);
        m.structureAt(x, y, a0, s1); m.structureAt(x, y, { spiral: 0, bar: 0 }, s2);
        for (const c of ["young", "old", "dust", "hii"]) worst = Math.max(worst, Math.abs(s1[c] - s2[c]));
    }
    check(worst === 0, `t = 0 structure is the rigid model's exactly (max difference ${worst})`);
}

// 2. Weights: the two generations and the two epochs alive always sum to one
// and change continuously, in both time directions.
{
    let sumErr = 0, jumpG = 0, jumpE = 0, prevG = null, prevE = null, reach = 0;
    const gs = { gens: [{}, {}] }, es = { epochs: [{}, {}] };
    const wOf = (st, key) => { const w = new Map(); for (const x of st) w.set(x[key], (w.get(x[key]) || 0) + x.w); return w; };
    for (let t = -1200; t <= 1200; t += 0.05) {
        dyn.generationState(t * MYR, gs); dyn.epochState(t * MYR, es);
        const g = gs.gens, e = es.epochs;
        sumErr = Math.max(sumErr, Math.abs(g[0].w + g[1].w - 1), Math.abs(g[0].wGas + g[1].wGas - 1), Math.abs((e[0].e === e[1].e ? e[0].w : e[0].w + e[1].w) - 1));
        const wg = wOf(g.map(x => ({ k: x.k, w: x.w })), "k"), we = wOf(e.filter(x => x.w > 0), "e");
        if (prevG) for (const k of new Set([...wg.keys(), ...prevG.keys()])) jumpG = Math.max(jumpG, Math.abs((wg.get(k) || 0) - (prevG.get(k) || 0)));
        if (prevE) for (const k of new Set([...we.keys(), ...prevE.keys()])) jumpE = Math.max(jumpE, Math.abs((we.get(k) || 0) - (prevE.get(k) || 0)));
        prevG = wg; prevE = we;
        for (const x of e) if (x.w > 0) reach = Math.max(reach, Math.abs(x.tau));
    }
    check(sumErr < 1e-12, `generation and epoch weights sum to one (worst ${sumErr.toExponential(1)})`);
    check(jumpG < 0.01 && jumpE < 0.03, `weights are continuous across hand-overs (max step per 50 kyr: arms ${jumpG.toFixed(4)}, material ${jumpE.toFixed(4)})`);
    check(reach <= dyn.EPOCH_REACH_MYR + 1e-9, `material is sheared for at most ${dyn.EPOCH_REACH_MYR} Myr (bounded phase mixing; seen ${reach.toFixed(2)})`);
}

// 3. Determinism and reverse time: the state is a pure function of t.
{
    const pts = [[8178, 0], [-4000, 5200], [12000, -3000], [2500, 2500]];
    const times = [-3700, -480, -31, 0, 7, 129.5, 260, 3000, 9500];
    const sample = t => { const a = m.patternAngles(t * MYR, {}), s = {}; return pts.flatMap(([x, y]) => { m.mwSample(x, y, 30, a, null, 0, s); return [s.young, s.thin, s.kappa, s.hii]; }); };
    const fwd = times.map(sample), back = [...times].reverse().map(sample).reverse();
    check(JSON.stringify(fwd) === JSON.stringify(back), "the model at a time is the same reached forward or in reverse");
    const c1 = rf.createFieldCache(), c2 = rf.createFieldCache();
    const [bi, bj, bk] = boxAt(20, 6100, 2300, 10);
    const bx1 = rf.generateBox(7, rf.FAMILY_DISK, 20, bi, bj, bk, null, null, 13), bx2 = rf.generateBox(7, rf.FAMILY_DISK, 20, bi, bj, bk, null, null, 13);
    check(bx1.n > 0 && bx1.n === bx2.n && bx1.rec.every((v, i) => v === bx2.rec[i]), `a disk box of an epoch is a pure function of (seed, bin, box, epoch) (${bx1.n} stars)`);
    void c1; void c2;
}

// 4. The same galaxy at every epoch: rotations about the centre move the
// arms, not the light; the azimuthal mean of every map channel and the
// total luminosity are unchanged.
const EPOCHS = [-2000, -500, -125, -60, 0, 33, 90, 125, 160, 250, 333, 610, 1000, 3170, 9999];
{
    const ringMean = (t, R, ch) => {
        const a = m.patternAngles(t * MYR, {}), s = {};
        let sum = 0;
        for (let k = 0; k < 2048; k++) { const b = 2 * Math.PI * k / 2048; m.structureAt(R * Math.cos(b), R * Math.sin(b), a, s); sum += s[ch]; }
        return sum / 2048;
    };
    let worst = 0;
    for (const R of [4500, 6500, 8178, 11000, 15000]) for (const ch of ["young", "old", "dust"]) {
        const ref = ringMean(0, R, ch);
        for (const t of EPOCHS) worst = Math.max(worst, Math.abs(ringMean(t, R, ch) / ref - 1));
    }
    check(worst < 0.03, `azimuthal means of young, old and dust are the same at every epoch (worst ${(100 * worst).toFixed(2)} %)`);
    const LV = t => {
        const a = m.patternAngles(t * MYR, {}), s = {};
        let sum = 0;
        for (let x = -24750; x < 25000; x += 500) for (let y = -24750; y < 25000; y += 500) {
            if (x * x + y * y > 25000 * 25000) continue;
            for (const [z, dz] of [[25, 50], [100, 100], [300, 300], [900, 900], [2500, 2400]]) {
                m.mwSample(x, y, z, a, null, 0, s);
                sum += 2 * (s.young + s.thin + s.thick + s.halo + s.bar) * dz;
            }
        }
        return sum * 500 * 500;
    };
    const L0 = LV(0);
    const dev = Math.max(...[125, 610, 3170].map(t => Math.abs(LV(t) / L0 - 1)));
    check(dev < 0.01, `the Galaxy's V luminosity is the same at 125 Myr, 610 Myr and 3.2 Gyr (worst ${(100 * dev).toFixed(2)} %)`);
}

// 5. Arms at every epoch: young light stays concentrated in arms (an
// isolated disk does not dissolve), arms change from generation to
// generation, and they never wind into strips.
{
    const ring = (t, R) => {
        const a = m.patternAngles(t * MYR, {}), s = {}, v = [];
        for (let k = 0; k < 720; k++) { const b = k * 0.5 * DEG; m.structureAt(R * Math.cos(b), R * Math.sin(b), a, s); v.push(s.young); }
        return v;
    };
    const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.floor(p * (arr.length - 1))];
    let minC = Infinity, maxC = 0;
    for (const t of EPOCHS) for (const R of [6500, 9000]) {
        const v = ring(t, R), c = pct(v, 0.95) / Math.max(pct(v, 0.3), 1e-3);
        minC = Math.min(minC, c); maxC = Math.max(maxC, c);
    }
    check(minC > 3, `young arms persist at every epoch, through hand-overs and 10 Gyr (p95/p30 contrast ${minC.toFixed(1)}-${maxC.toFixed(1)})`);
    // Winding: arm crossings along radial lines from 5 to 15 kpc. A log
    // spiral of pitch p crosses m ln(R2/R1) / (2 pi tan p) times, so the count
    // measures 1/tan p; a material (fully winding) spiral's count grows
    // without bound, a rigid one's never changes.
    const crossings = t => {
        const a = m.patternAngles(t * MYR, {}), s = {};
        let n = 0;
        for (let k = 0; k < 36; k++) {
            const b = k * 10 * DEG;
            let prev = null, above = false;
            for (let lnR = Math.log(5000); lnR <= Math.log(15000); lnR += 0.004) {
                const R = Math.exp(lnR);
                m.structureAt(R * Math.cos(b), R * Math.sin(b), a, s);
                const on = s.dust > 2.2;
                if (prev !== null && on && !above) n++;
                above = on; prev = s.dust;
            }
        }
        return n / 36;
    };
    const c0 = crossings(0), cs = EPOCHS.map(crossings);
    const worst = Math.max(...cs) / c0;
    check(worst < 2.2, `arms never wind into strips: dust-lane crossings per radial line ${c0.toFixed(2)} today, at most ${Math.max(...cs).toFixed(2)} at any epoch (x${worst.toFixed(2)})`);
    check(Math.max(...[3170, 9999].map(crossings)) < 2.2 * c0, "winding does not accumulate over Gyr");
    // generation peaks: arms re-formed elsewhere, not a rotated copy of today
    const corr = (t1, t2) => {
        const a1 = m.patternAngles(t1 * MYR, {}), a2 = m.patternAngles(t2 * MYR, {}), s = {}, A = [], B = [];
        // compare in the frame turning at the pattern speed
        for (let k = 0; k < 3000; k++) {
            const R = 4000 + 10000 * ((k * 0.618034) % 1), b = 2 * Math.PI * ((k * 0.414214) % 1);
            const p1 = b + dyn.OMEGA_P * t1, p2 = b + dyn.OMEGA_P * t2;
            m.structureAt(R * Math.cos(p1), R * Math.sin(p1), a1, s); A.push(s.young);
            m.structureAt(R * Math.cos(p2), R * Math.sin(p2), a2, s); B.push(s.young);
        }
        const mean = v => v.reduce((x, y) => x + y, 0) / v.length, ma = mean(A), mb = mean(B);
        let sab = 0, saa = 0, sbb = 0;
        for (let i = 0; i < A.length; i++) { sab += (A[i] - ma) * (B[i] - mb); saa += (A[i] - ma) ** 2; sbb += (B[i] - mb) ** 2; }
        return sab / Math.sqrt(saa * sbb);
    };
    const near = corr(0, 2), mid = corr(0, 125), gens = [1, 2, 3, -1, -2].map(k => corr(0, k * P));
    check(near > 0.9, `over 2 Myr the arms barely change in the pattern frame (correlation ${near.toFixed(3)})`);
    check(mid < 0.75 && Math.max(...gens.map(Math.abs)) < 0.6, `arms change: correlation with today ${mid.toFixed(2)} after 125 Myr, |${Math.max(...gens.map(Math.abs)).toFixed(2)}| at later generation peaks`);
}

// 6. Material structure: the epoch frame turns at Omega(R); the circular
// rate is the rotation curve's, and the GLSL rate is exact for it.
{
    let worst = 0;
    for (const Rk of [0.5, 2, 4.9, 5, 6, 8.178, 12, 19, 25, 30]) {
        const om = dyn.omegaRadMyr(Rk * 1000), ref = vCirc(Rk) / Rk * dyn.KMS_KPC_RAD_MYR;
        worst = Math.max(worst, Math.abs(om / ref - 1));
    }
    const k = dyn.VCIRC_GLSL_KNOTS;
    const lin = Math.abs(vCirc(15) - 0.5 * (k.v5 + k.v25)) < 1e-9 && Math.abs(vCirc(9.3) - (k.v5 + (k.v25 - k.v5) * 4.3 / 20)) < 1e-9;
    check(worst < 1e-12 && lin, "circular rate is v_c(R)/R of the rotation curve, linear on 5-25 kpc as the GLSL assumes");
    const sunOrbit = 2 * Math.PI / dyn.omegaRadMyr(8178);
    check(sunOrbit > 200 && sunOrbit < 250, `material at the solar circle orbits in ${sunOrbit.toFixed(0)} Myr`);
}

// 7. Young procedural stars move through the arms and follow them: the
// pool bound holds wherever a young star of an epoch goes during the epoch,
// so thinning by m / B leaves the model's density at every time. (Old
// thin-disk stars are not thinned: they crowd, section 9.)
{
    rf.poolBounds();
    let n = 0, viol = 0, visY = 0, nY = 0, nO = 0;
    const s = {};
    for (const e of [0, 1, 7, -3, 40]) {
        const ctx = rf.epochContext(e);
        for (const [x, y] of [[6100, 2300], [4200, -3900], [9400, 1500], [-7300, 3800], [11800, -6000]]) {
            const [bi, bj, bk] = boxAt(21, x, y, 10);
            const box = rf.generateBox(3, rf.FAMILY_DISK, 21, bi, bj, bk, null, null, e);
            for (let st = 0; st < box.n; st++) {
                const o = st * rf.REC, thr = box.rec[o + 9];
                if (thr < 0) nO++;
                if (!(thr > 0)) continue;
                const qx = box.ox + box.rec[o], qy = box.oy + box.rec[o + 1], R = Math.hypot(qx, qy);
                for (const f of [-1, -0.5, 0, 0.5, 1]) {
                    const tMyr = e * L + f * dyn.EPOCH_REACH_MYR;
                    const a = ctx.phi + dyn.omegaRadMyr(R) * (tMyr - e * L);
                    m.structureAt(Math.cos(a) * qx - Math.sin(a) * qy, Math.sin(a) * qx + Math.cos(a) * qy, m.patternAngles(tMyr * MYR, {}), s);
                    const mod = s.young, B = rf.poolModBound(ctx, qx, qy, [0, 0])[0];
                    n++;
                    if (mod > B * 1.0001) viol++;
                    if (f === 0) { nY++; if (mod > thr) visY++; }
                }
            }
        }
    }
    check(n > 1000 && viol / n < 0.01, `pool bound holds along the young stars' orbits through each epoch (${viol} of ${n} samples exceed it)`);
    check(nY > 50 && visY / nY > 0.3, `the young pools are economical: ${(100 * visY / nY).toFixed(0)} % of candidates show`);
    check(nO > 1000, `old thin-disk stars carry their crowding label (${nO})`);
}

// 8. The drawn stars follow the arms of THEIR time: a camera 1.5 kpc above
// the Sun at +-50 Myr; the young stars it resolves (moved along their
// orbits, thinned by the arms where they are) sit where that epoch's young
// arms are, not where the arms were 120 Myr apart or where they would be in
// a rigidly rotating disk.
{
    const { solarGalacticStateAt } = await import("../src/universe/solarOrbit.js");
    const { LF_NU } = await import("../src/universe/resolvedLF.js");
    for (const tMyr of [50, -50]) {
        const sun = solarGalacticStateAt(tMyr * MYR, {});
        const cam = [sun.x, sun.y, 1500];
        const es = dyn.epochState(tMyr * MYR, { epochs: [{}, {}] });
        const aNow = m.patternAngles(tMyr * MYR, {}), aOff = m.patternAngles((tMyr + 120) * MYR, {});
        // a rigid disk: today's arms turned at the pattern speed
        const rigid = { spiral: dyn.OMEGA_P * tMyr, bar: 0 };
        const cache = rf.createFieldCache(8e6), st = {};
        let n = 0, sumNow = 0, sumOff = 0, sumRigid = 0, pool = 0, poolNow = 0;
        for (const ep of es.epochs) {
            if (!(ep.w > 0)) continue;
            const ctx = rf.epochContext(ep.e);
            for (let b = 0; b < rf.FIELD_BINS; b++) {
                if (!(LF_NU.young[b] > 0)) continue;
                const sel = rf.buildBin(cache, 5, rf.FAMILY_DISK, b, { cam, sun: [1e6, 1e6, 0], ref: [0, 0, 0], active: null, activeR: 0, magLimit: 9, catalogMagLimit: null, epoch: ep.e, tauB: ep.tau, wMax: ep.w });
                for (let i = 0; i < sel.n; i++) {
                    const thr = sel.evo[2 * i];
                    if (!(thr > 0) || 0.92 * sel.evo[2 * i + 1] >= ep.w) continue;
                    const qx = sel.pos[3 * i], qy = sel.pos[3 * i + 1];
                    const a = ctx.phi + dyn.omegaRadMyr(Math.hypot(qx, qy)) * ep.tau;
                    const x = Math.cos(a) * qx - Math.sin(a) * qy, y = Math.sin(a) * qx + Math.cos(a) * qy;
                    const now = m.structureAt(x, y, aNow, st).young;
                    pool++; poolNow += now;
                    if (now <= thr) continue;
                    n++; sumNow += now;
                    sumOff += m.structureAt(x, y, aOff, st).young;
                    sumRigid += m.structureAt(x, y, rigid, st).young;
                }
            }
        }
        const mNow = sumNow / n, mOff = sumOff / n, mRigid = sumRigid / n, mPool = poolNow / pool;
        check(n > 2000 && mNow > 1.4 * mOff && mNow > 1.1 * mRigid,
            `${tMyr} Myr: ${n} resolved young stars sit in that epoch's young arms (mean modulation ${mNow.toFixed(2)}; ${mOff.toFixed(2)} in the arms 120 Myr later, ${mRigid.toFixed(2)} in a rigidly rotated disk; ${mPool.toFixed(2)} over the pool before thinning)`);
    }
}

// 9. Old stars crowd in the arms (armTransport.js): a kinematic density
// wave. Stars keep moving on their rings, slower in the arms, so their
// density follows the old arms' modulation of each moment while no star
// appears or fades.
{
    const at = await import("../src/universe/armTransport.js");
    const T = at.armTransport(gm);
    // (a) the table: each ring's mhat has mean 1 and its cumulative excess P
    // closes around the ring
    let worstMean = 0, worstWrap = 0;
    const sa = [0, 0], sb = [0, 0];
    for (let i = 0; i < T.nr; i += 5) {
        let sum = 0;
        for (let j = 0; j < T.nb; j++) sum += T.H[i * T.nb + j];
        worstMean = Math.max(worstMean, Math.abs(sum / T.nb - 1));
        const R = T.rmax * (i + 0.5) / T.nr;
        worstWrap = Math.max(worstWrap, Math.abs(at.armSample(T, R, -1e-7, sa)[0] - at.armSample(T, R, 1e-7, sb)[0]));
    }
    check(worstMean < 1e-3 && worstWrap < 1e-5, `transport table: ring means of mhat within ${worstMean.toExponential(1)} of 1, P continuous around each ring (${worstWrap.toExponential(1)})`);
    // (b) half floats round to nearest, carrying into the exponent
    let worstHalf = 0;
    for (const v of [0.0312499, 0.0624999, 0.1249999, 0.2499999, 0.9999999, 1.9999, -0.0312499, 0.0123, 0.3]) worstHalf = Math.max(worstHalf, Math.abs(at.halfValue(at.halfBits(v)) / v - 1));
    check(worstHalf <= 2 ** -11, `table values round to the nearest half float, also just below powers of two (${worstHalf.toExponential(2)})`);
    // (c) the solve: no displacement at the epoch's centre; the two Newton
    // steps CPU and GPU take are within 0.5 pc of the root; the inverse used
    // to find boxes is within 2 pc
    let z0 = 0, newton = 0, inv = 0;
    const { makeRNG } = await import("../src/universe/prng.js");
    const rnd = makeRNG(17);
    const speeds = [];
    for (let q = 0; q < 6000; q++) {
        const e = Math.floor(rnd() * 400) - 200, ctx = rf.epochContext(e), tau = (rnd() * 2 - 1) * dyn.EPOCH_REACH_MYR;
        const R = 2500 + rnd() * 20000, bq = rnd() * 2 * Math.PI, om = dyn.omegaRadMyr(R), W = dyn.windRadMyr(R);
        const gt = t => at.armGens(dyn.generationState((ctx.tE + t) * MYR, { gens: [{}, {}] }), ctx.phi);
        const GT = gt(tau), dc = at.armLabel(T, R, bq, W, ctx.GE);
        z0 = Math.max(z0, Math.abs(at.armDelta(T, R, bq, om, W, 0, dc, ctx.GE)) * R);
        const d2 = at.armDelta(T, R, bq, om, W, tau, dc, GT), d8 = at.armDelta(T, R, bq, om, W, tau, dc, GT, 8);
        newton = Math.max(newton, Math.abs(d2 - d8) * R);
        const bNow = bq + om * tau + d2;
        inv = Math.max(inv, Math.abs(bNow - om * tau - at.armDeltaAt(T, R, bNow, om, W, tau, ctx.GE, GT) - bq) * R);
        const v = Math.abs(at.armDelta(T, R, bq, om, W, tau + 0.25, dc, gt(tau + 0.25)) - at.armDelta(T, R, bq, om, W, tau - 0.25, dc, gt(tau - 0.25))) / 0.5 * R;
        speeds.push(v * 0.9778);   // pc/Myr -> km/s
    }
    check(z0 < 1e-6 && newton < 0.5 && inv < 2, `crowding solve: ${z0.toExponential(1)} pc at the epoch's centre, two Newton steps within ${newton.toFixed(2)} pc of the root, inverse within ${inv.toFixed(2)} pc`);
    speeds.sort((a, b) => a - b);
    const p50 = speeds[speeds.length >> 1], p99 = speeds[Math.floor(speeds.length * 0.99)];
    check(p50 > 1 && p50 < 15 && p99 < 60, `streaming through the arms: median ${p50.toFixed(1)} km/s, p99 ${p99.toFixed(1)} km/s (observed streaming motions ~10-20 km/s)`);

    // (d) the stars of an epoch in a 1.4 kpc x 1.1 rad sector of the inner
    // disk, at the epoch's edges: the star-weighted mean of the old arms'
    // modulation of that moment equals int m^2 / int m (density
    // proportional to m(t)); stars left on circular orbits drift off it
    const e = 3, ctx = rf.epochContext(e), b = 21, c = rf.binBoxPc(b), ze = rf.zEdgesFor(c);
    const R0 = 5800, R1 = 7200, beta0 = 0.4, span = 1.1, st = {};
    const sw = a => dyn.wrapAngle(a + Math.PI) - Math.PI;
    const stars = [];
    for (let i = -Math.ceil(R1 / c) - 1; i <= Math.ceil(R1 / c); i++) for (let j = -Math.ceil(R1 / c) - 1; j <= Math.ceil(R1 / c); j++) {
        const qx = (i + 0.5) * c, qy = (j + 0.5) * c, Rq = Math.hypot(qx, qy);
        if (Rq < R0 - c || Rq > R1 + c || Math.abs(sw(Math.atan2(qy, qx) - beta0 - span / 2)) > span / 2 + c / Rq) continue;
        for (let k = 0; k < ze.length - 1; k++) {
            if (Math.abs(ze[k]) > 400) continue;
            const box = rf.generateBox(9, rf.FAMILY_DISK, b, i, j, k, null, null, e);
            for (let q = 0; q < box.n; q++) {
                const o = q * rf.REC;
                if (!at.isArmLabel(box.rec[o + 9])) continue;
                const x = box.ox + box.rec[o], y = box.oy + box.rec[o + 1], R = Math.hypot(x, y);
                if (R >= R0 && R <= R1) stars.push(R, Math.atan2(y, x), at.armLabelOf(box.rec[o + 9]));
            }
        }
    }
    for (const tau of [-19.5, 19.5]) {
        const t = (ctx.tE + tau) * MYR, ang = m.patternAngles(t, {});
        const GT = at.armGens(dyn.generationState(t, { gens: [{}, {}] }), ctx.phi);
        const inWin = (R, bNow) => Math.abs(sw(bNow - dyn.omegaRadMyr(R) * tau - beta0 - span / 2)) < span / 2 - 0.12;
        let nC = 0, sC = 0, sC2 = 0, nO = 0, sO = 0;
        for (let q = 0; q < stars.length; q += 3) {
            const R = stars[q], bq = stars[q + 1], om = dyn.omegaRadMyr(R);
            const bC = bq + om * tau + at.armDelta(T, R, bq, om, dyn.windRadMyr(R), tau, stars[q + 2], GT), bO = bq + om * tau;
            if (inWin(R, bC)) { const v = m.structureAt(R * Math.cos(ctx.phi + bC), R * Math.sin(ctx.phi + bC), ang, st).old; nC++; sC += v; sC2 += v * v; }
            if (inWin(R, bO)) { nO++; sO += m.structureAt(R * Math.cos(ctx.phi + bO), R * Math.sin(ctx.phi + bO), ang, st).old; }
        }
        let w1 = 0, w2 = 0;
        for (let q = 0; q < 400000; q++) {
            const R = R0 + (R1 - R0) * rnd(), bNow = beta0 + span / 2 + (rnd() - 0.5) * (span - 0.24) + dyn.omegaRadMyr(R) * tau;
            const wgt = R * Math.exp(-R / m.MW.hrThin), v = m.structureAt(R * Math.cos(ctx.phi + bNow), R * Math.sin(ctx.phi + bNow), ang, st).old;
            w1 += wgt * v; w2 += wgt * v * v;
        }
        const crowd = sC / nC, circ = sO / nO, expect = w2 / w1;
        const sigma = Math.sqrt(Math.max(sC2 / nC - crowd * crowd, 0) / nC) * 1.5;   // stars and the area sum
        check(nC > 100000 && Math.abs(crowd - expect) < 4 * sigma && Math.abs(circ - expect) > 2 * Math.abs(crowd - expect),
            `${tau > 0 ? "+" : ""}${tau} Myr into an epoch, ${nC} old stars follow that moment's arms: mean modulation ${crowd.toFixed(4)} vs ${expect.toFixed(4)} for density prop. to m(t) (sigma ${sigma.toFixed(4)}); on circular orbits alone ${circ.toFixed(4)}`);
    }

    // (e) selection: buildBin finds every old star a brute-force scan of a
    // much larger area selects, wherever its crowding has taken it
    {
        const b2 = 26, cam = [4200, -3900, 0], e2 = -2, tauB = -18, ctx2 = rf.epochContext(e2);
        const p = { cam, sun: [1e7, 1e7, 0], ref: [0, 0, 0], active: null, activeR: 0, magLimit: 11, catalogMagLimit: 11, epoch: e2, tauB, wMax: 1 };
        const sel = rf.buildBin(rf.createFieldCache(2e7), 4, rf.FAMILY_DISK, b2, p);
        const key = (o, i) => o.pos[3 * i].toFixed(3) + "," + o.pos[3 * i + 1].toFixed(3) + "," + o.pos[3 * i + 2].toFixed(3);
        const got = new Set();
        for (let i = 0; i < sel.n; i++) if (at.isArmLabel(sel.evo[2 * i])) got.add(key(sel, i));
        const c2 = rf.binBoxPc(b2), ze2 = rf.zEdgesFor(c2), r = rf.binRadiusPc(b2, 11), M = r + 1500;
        const a = -(ctx2.phi + dyn.omegaRadMyr(Math.hypot(cam[0], cam[1])) * tauB);
        const px = Math.cos(a) * cam[0] - Math.sin(a) * cam[1], py = Math.sin(a) * cam[0] + Math.cos(a) * cam[1];
        const all = rf.makeSelectionOut(), pf = { ...p, ctx: ctx2, arm: rf.armAtBuild(ctx2, tauB) };
        for (let i = Math.floor((px - M) / c2); i <= Math.floor((px + M) / c2); i++) for (let j = Math.floor((py - M) / c2); j <= Math.floor((py + M) / c2); j++)
            for (let k = 0; k < ze2.length - 1; k++) {
                if (Math.max(ze2[k] - cam[2], 0, cam[2] - ze2[k + 1]) > r) continue;
                rf.selectBox(rf.generateBox(4, rf.FAMILY_DISK, b2, i, j, k, null, 11, e2), pf, all);
            }
        let old = 0, missing = 0;
        for (let i = 0; i < all.n; i++) if (at.isArmLabel(all.evo[2 * i])) { old++; if (!got.has(key(all, i))) missing++; }
        check(old > 20000 && missing === 0 && got.size === old, `selection: every one of ${old} old stars a brute-force scan finds is selected (${missing} missing); the renderer rebuilds before they drift (${sel.drift.toFixed(1)} pc/Myr here)`);
    }
}

if (failures) { console.error(`smoke-galaxy-dynamics: ${failures} failure(s)`); process.exit(1); }
console.log("smoke-galaxy-dynamics passed");
