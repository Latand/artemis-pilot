// Volumetric Milky Way light model (src/universe/galaxyModel.js): physical
// sanity of the analytic emissivity/dust model and the resolved/unresolved
// handoff that keeps the diffuse layer from double-counting the star layers.
//
// Run: node scripts/smoke-galaxy-model.mjs
const m = await import("../src/universe/galaxyModel.js");
const maps = await import("../src/universe/galaxyMaps.js");
const { MILKY_WAY } = await import("../src/universe/galaxyPopulation.js");
// the model as rendered: with the face-on structure maps (arms, knots, lanes)
const gm = maps.ensureGalaxyMaps();

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "PASS " : "FAIL ") + msg); if (!ok) failures++; };

// 1. Unresolved fraction: monotone, ~0 next to the camera, ~1 across the Galaxy.
let prev = -1, mono = true;
for (let lg = 0; lg <= 5; lg += 0.05) {
    const f = m.unresolvedFraction(Math.pow(10, lg));
    if (f < prev - 1e-12) mono = false;
    prev = f;
}
check(mono, "unresolved fraction is non-decreasing with camera distance");
check(m.unresolvedFraction(10) < 0.005, `stars within 10 pc are resolved (f=${m.unresolvedFraction(10).toFixed(4)})`);
check(m.unresolvedFraction(30000) > 0.99, `the far side of the Galaxy is unresolved (f=${m.unresolvedFraction(30000).toFixed(3)})`);
const f1k = m.unresolvedFraction(1000);
check(f1k > 0.1 && f1k < 0.5, `about a fifth of the light at 1 kpc is unresolved (f=${f1k.toFixed(3)})`);

// 2. The Sun sits at the inner edge of the Local Arm (Reid+2019; arm profile
// 0.3-0.8 rather than on a centerline or far between arms).
const armSun = m.armProfile(m.MW.R0, 0);
check(armSun > 0.3 && armSun < 0.8, `Sun near the Local Arm edge (profile ${armSun.toFixed(3)})`);

// 3. Dust columns from the Sun (V band): heavily obscured toward the Galactic
// centre, nearly transparent toward the pole (Local Bubble + thin dust layer).
const r = {};
const AV = (dx, dy, dz) => { m.integrateRay(m.MW.R0, 0, 20.8, dx, dy, dz, 0, null, 0, r, 400); return r.tau / (0.4 * Math.LN10); };
const avPole = AV(0, 0, 1);
const avGC = AV(-1, 0, 0);
check(avPole > 0.02 && avPole < 0.25, `A_V toward the NGP ${avPole.toFixed(3)} mag`);
check(avGC > 20, `A_V through the disk toward the Galactic centre ${avGC.toFixed(1)} mag (opaque in V)`);
const b10 = 10 * Math.PI / 180;
const avB10 = AV(-Math.cos(b10), 0, Math.sin(b10));
check(avB10 > 0.5 && avB10 < 4, `A_V at b=+10 deg toward the bulge ${avB10.toFixed(2)} mag (Sagittarius star clouds visible)`);

// 4. Brightness structure seen from the Sun: the band outshines the pole, the
// bulge above the dust lane outshines the in-plane direction behind it.
// Total starlight (resolved + unresolved, magLimit -30 resolves nothing).
const I = (dx, dy, dz, mag = -30) => { m.integrateRay(m.MW.R0, 0, 20.8, dx, dy, dz, 0, null, 0, r, 400, null, mag); return r.young + r.old + r.bar; };
const iPole = I(0, 0, 1), iB10 = I(-Math.cos(b10), 0, Math.sin(b10)), iCyg = I(0, 1, 0.035);
check(iB10 > 5 * iPole, `bulge above the dust lane ${iB10.toFixed(2)} >> pole ${iPole.toFixed(3)} (total light)`);
check(iCyg > 1.2 * iPole, `the band toward Cygnus (l=90, b=2) ${iCyg.toFixed(3)} outshines the pole (total light)`);
// The diffuse layer alone carries only light no star layer draws, so near
// the Sun it is a small part of the total.
const uPole = I(0, 0, 1, m.RESOLVED_MAG_LIMIT);
check(uPole < iPole, `diffuse (unresolved) light toward the pole ${uPole.toFixed(3)} < total ${iPole.toFixed(3)}`);

// 5. Face-on from outside: the centre outshines the solar circle, which
// outshines the outer disk (exponential disk + bar).
const faceOn = (x) => { m.integrateRay(x, 0, 60000, 0, 0, -1, 0, null, 0, r, 400); return r.young + r.old + r.bar; };
const c0 = faceOn(0), c8 = faceOn(8000), c15 = faceOn(15000);
check(c0 > c8 && c8 > c15 && c15 > 0, `face-on surface brightness falls outward (${c0.toFixed(1)} > ${c8.toFixed(2)} > ${c15.toFixed(3)})`);

// 6. Merger / era modulation keep the integral finite and reduce the disk.
const dis = {};
m.integrateRay(0, 0, 60000, 0.3, 0, -1, 0, null, 1, dis, 200);
check(Number.isFinite(dis.old) && dis.young === 0, "fully disrupted disk has no young light and finite old light");

// 7. GLSL mirrors the JS parameters it was generated from.
const glsl = m.GALAXY_MODEL_GLSL;
for (const [name, v] of [["hzYoung", m.MW.hzYoung], ["hzThin", m.MW.hzThin], ["hrDust", m.MW.hrDust], ["hzDust", m.MW.hzDust]]) {
    check(glsl.includes(v.toFixed(1)), `GLSL carries ${name}=${v}`);
}
const u = m.galaxyModelUniformValues();
check(u.uFaintY.length === m.FAINT_TABLES.young.length && u.uFaintO.length === m.FAINT_TABLES.old.length, "uniform arrays match the faint-light tables");
// Young light is carried by far more luminous stars than old light: at any
// resolving distance the young component is resolved first.
check(m.unresolvedFraction(1000, m.RESOLVED_MAG_LIMIT, "young") < m.unresolvedFraction(1000, m.RESOLVED_MAG_LIMIT, "old"), "young light resolves before old light at 1 kpc");

// 8. Structure maps: the local calibration survives the arms (the mean young
// and old modulation within 1 kpc of the Sun is 1), the young light is
// concentrated in arms, the old stars carry the two major arms, and dust
// lanes lie on the inner (concave) edge of the young arms.
const smp = {};
let my = 0, mo = 0, nn = 0;
for (let x = m.MW.R0 - 1000; x <= m.MW.R0 + 1000; x += 40) for (let y = -1000; y <= 1000; y += 40) {
    if (Math.hypot(x - m.MW.R0, y) > 1000) continue;
    maps.sampleGalaxyMapsInto(gm, x, y, smp); my += smp.young; mo += smp.old; nn++;
}
check(Math.abs(my / nn - 1) < 0.05 && Math.abs(mo / nn - 1) < 0.05, `solar neighbourhood keeps its calibration (young ${(my / nn).toFixed(3)}, old ${(mo / nn).toFixed(3)})`);
// azimuthal profile at R = 6.5 kpc: young arms vs interarm
const ring = [], ringO = [];
for (let a = 0; a < 360; a += 0.5) {
    maps.sampleGalaxyMapsInto(gm, 6500 * Math.cos(a * Math.PI / 180), 6500 * Math.sin(a * Math.PI / 180), smp);
    ring.push(smp.young); ringO.push(smp.old);
}
const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.floor(p * (arr.length - 1))];
const yContrast = pct(ring, 0.95) / pct(ring, 0.3), oContrast = pct(ringO, 0.95) / pct(ringO, 0.3);
check(yContrast > 4, `young light concentrated in the arms at 6.5 kpc (p95/p30 ${yContrast.toFixed(1)})`);
check(oContrast > 1.3 && oContrast < 3, `old stellar arms are moderate (p95/p30 ${oContrast.toFixed(2)})`);
// dust lanes on the concave side: across each young-arm crossing of a
// radial cut, the dust peak lies at smaller radius than the young peak
const lines = maps.armCenterlines();
let inner = 0, total = 0;
for (const t of lines.filter(l => l.name === "Sct-Cen" || l.name === "Perseus")) {
    for (let k = 10; k < t.n - 10; k += 40) {
        const R = Math.exp(t.lnR[k]);
        if (R < 5000 || R > 12000) continue;
        const b = (t.beta0 + k * 0.25) * Math.PI / 180;
        let yBest = -1, yR = 0, dBest = -1, dR = 0;
        for (let dr = -500; dr <= 500; dr += 10) {
            maps.sampleGalaxyMapsInto(gm, (R + dr) * Math.cos(b), (R + dr) * Math.sin(b), smp);
            if (smp.young > yBest) { yBest = smp.young; yR = dr; }
            if (smp.dust > dBest) { dBest = smp.dust; dR = dr; }
        }
        total++;
        if (dR < yR) inner++;
    }
}
check(total > 5 && inner / total > 0.7, `dust lanes on the inner edge of the major arms (${inner}/${total})`);

// 9. Photometry: the Galaxy's V luminosity (measured M_V -21.5 +- 0.4,
// Licquia+2015) and the population's Milky Way entry (the sprite the
// volume hands over to) carry the same light.
const ang0 = m.patternAngles(0, {});
let LV = 0;
const dxy = 250;
for (let x = -25000 + dxy / 2; x < 25000; x += dxy) for (let y = -25000 + dxy / 2; y < 25000; y += dxy) {
    if (x * x + y * y > 25000 * 25000) continue;
    let z0 = 0;
    for (let k = 1; k <= 60; k++) {
        const z1 = 6000 * Math.pow(k / 60, 3), zm = 0.5 * (z0 + z1), dz = z1 - z0;
        for (const sg of [1, -1]) {
            m.mwSample(x, y, sg * zm, ang0, null, 0, smp);
            LV += (smp.young + smp.thin + smp.thick + smp.halo + smp.bar) * dxy * dxy * dz;
        }
        z0 = z1;
    }
}
const MV = 4.83 - 2.5 * Math.log10(LV);
check(MV > -22.2 && MV < -21.2, `Milky Way M_V ${MV.toFixed(2)} (L_V ${LV.toExponential(2)})`);
check(Math.abs(MILKY_WAY.MV - MV) < 0.08, `population Milky Way entry M_V ${MILKY_WAY.MV.toFixed(2)} matches the volume integral`);

// 10. Detail below the maps' texel keeps the mean: the dust cascade divides
// each octave's lognormal factor exp(t v / std(v)) by exp(K(t)), K fitted to
// the GLSL gradient noise (gmNoise, ported here). If the noise or the fit
// changes, zooming would change the Galaxy's brightness.
{
    const fract = x => x - Math.floor(x);
    const h33 = (x, y, z, o) => {
        let px = fract(x * 0.1031), py = fract(y * 0.1030), pz = fract(z * 0.0973);
        const d = px * (py + 33.33) + py * (px + 33.33) + pz * (pz + 33.33);
        px += d; py += d; pz += d;
        o[0] = fract((px + py) * pz) * 2 - 1; o[1] = fract((px + px) * py) * 2 - 1; o[2] = fract((py + px) * px) * 2 - 1;
    };
    const g = [0, 0, 0];
    const noise = (x, y, z) => {
        const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
        const q = t => t * t * t * (t * (t * 6 - 15) + 10), L = (a, b, t) => a + (b - a) * t;
        const c = (a, b, e) => { h33(ix + a, iy + b, iz + e, g); return g[0] * (fx - a) + g[1] * (fy - b) + g[2] * (fz - e); };
        const ux = q(fx), uy = q(fy), uz = q(fz);
        return L(L(L(c(0, 0, 0), c(1, 0, 0), ux), L(c(0, 1, 0), c(1, 1, 0), ux), uy), L(L(c(0, 0, 1), c(1, 0, 1), ux), L(c(0, 1, 1), c(1, 1, 1), ux), uy), uz);
    };
    const kFit = glsl.match(/float gdKg\(float t\) \{ return t \* \(([-\d.]+) \+ t \* \(([-\d.]+) \+ t \* \(([-\d.]+) - ([-\d.]+) \* t\)\)\); \}/);
    check(!!kFit, "GLSL carries the dust cascade's K(t) fit");
    if (kFit) {
        const [c1, c2, c3, c4] = kFit.slice(1, 5).map(Number);
        const K = t => t * (c1 + t * (c2 + t * (c3 - c4 * t)));
        let seed = 0x9e3779b9;
        const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
        const N = 200000, v = new Float64Array(N);
        for (let i = 0; i < N; i++) v[i] = noise(rnd() * 5000 + 0.5, rnd() * 5000 + 0.5, rnd() * 5000 + 0.5) * 5.2247;
        let worst = 0;
        for (const t of [0.45, 0.9, 1.4, 1.75]) {
            let s = 0;
            for (let i = 0; i < N; i++) s += Math.exp(t * v[i]);
            worst = Math.max(worst, Math.abs(s / N / Math.exp(K(t)) - 1));
        }
        check(worst < 0.03, `dust cascade octaves keep unit mean (worst deviation ${(100 * worst).toFixed(2)} %)`);
    }
}

if (failures) { console.error(`smoke-galaxy-model: ${failures} failure(s)`); process.exit(1); }
console.log("smoke-galaxy-model passed");
