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

// 7. Procedural stars move through the arms and follow them: the pool bound
// holds wherever a star of an epoch goes during the epoch, so thinning by
// m / B leaves the model's density at every time.
{
    rf.poolBounds();
    let n = 0, viol = 0, visY = 0, nY = 0, visO = 0, nO = 0;
    const s = {};
    for (const e of [0, 1, 7, -3, 40]) {
        const ctx = rf.epochContext(e);
        for (const [x, y] of [[6100, 2300], [4200, -3900], [9400, 1500], [-7300, 3800], [11800, -6000]]) {
            const [bi, bj, bk] = boxAt(21, x, y, 10);
            const box = rf.generateBox(3, rf.FAMILY_DISK, 21, bi, bj, bk, null, null, e);
            for (let st = 0; st < box.n; st++) {
                const o = st * rf.REC, thr = box.rec[o + 9];
                if (thr === 0) continue;
                const qx = box.ox + box.rec[o], qy = box.oy + box.rec[o + 1], R = Math.hypot(qx, qy);
                for (const f of [-1, -0.5, 0, 0.5, 1]) {
                    const tMyr = e * L + f * dyn.EPOCH_REACH_MYR;
                    const a = ctx.phi + dyn.omegaRadMyr(R) * (tMyr - e * L);
                    m.structureAt(Math.cos(a) * qx - Math.sin(a) * qy, Math.sin(a) * qx + Math.cos(a) * qy, m.patternAngles(tMyr * MYR, {}), s);
                    const bound = rf.poolModBound(ctx, qx, qy, [0, 0]);
                    const mod = thr > 0 ? s.young : s.old, B = thr > 0 ? bound[0] : bound[1];
                    n++;
                    if (mod > B * 1.0001) viol++;
                    if (f === 0) { if (thr > 0) { nY++; if (mod > thr) visY++; } else { nO++; if (mod > -thr) visO++; } }
                }
            }
        }
    }
    check(n > 2000 && viol / n < 0.01, `pool bound holds along the stars' orbits through each epoch (${viol} of ${n} samples exceed it)`);
    check(nY > 50 && visY / nY > 0.3 && visO / nO > 0.6, `the pools are economical: ${(100 * visY / nY).toFixed(0)} % of young and ${(100 * visO / nO).toFixed(0)} % of thin-disk candidates show`);
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

if (failures) { console.error(`smoke-galaxy-dynamics: ${failures} failure(s)`); process.exit(1); }
console.log("smoke-galaxy-dynamics passed");
