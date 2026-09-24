// Volumetric Milky Way light model (src/universe/galaxyModel.js): physical
// sanity of the analytic emissivity/dust model and the resolved/unresolved
// handoff that keeps the diffuse layer from double-counting the star layers.
//
// Run: node scripts/smoke-galaxy-model.mjs
const m = await import("../src/universe/galaxyModel.js");
const { REID_ARMS } = await import("../src/universe/astroConstants.js");

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
check(u.uArmRk.length === REID_ARMS.length && u.uFaintY.length === m.FAINT_TABLES.young.length && u.uFaintO.length === m.FAINT_TABLES.old.length, "uniform arrays match the arm table and faint-light tables");
// Young light is carried by far more luminous stars than old light: at any
// resolving distance the young component is resolved first.
check(m.unresolvedFraction(1000, m.RESOLVED_MAG_LIMIT, "young") < m.unresolvedFraction(1000, m.RESOLVED_MAG_LIMIT, "old"), "young light resolves before old light at 1 kpc");
check(Math.abs(u.uYoungNorm * (0.15 + m.MW.armAmpYoung * armSun) - 1) < 1e-12, "young light is normalized to its local share at the Sun");

if (failures) { console.error(`smoke-galaxy-model: ${failures} failure(s)`); process.exit(1); }
console.log("smoke-galaxy-model passed");
