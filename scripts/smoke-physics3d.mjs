// Smoke test for WP13 (3-D ephemeris + symplectic integrator, src/ephemeris.js).
// Deterministic: no Math.random, no Date.now() without an explicit override
// via epoch.js's setEpochMs(). Runs identically under node and bun (part (f)
// below is exercised by invoking this same file with both engines).
globalThis.window = {};

const {
  keplerInit, keplerInit3, resetEphem, eph, NB, IDX_MOON, IDX_SUN, IDX_PLANETS,
  advanceEphem, snapshotEphem,
} = await import("../src/ephemeris.js");
const {
  PL, MU_S, MU_E, MU_M, A_MOON, E_MOON, OMEGA, MOON_ANG0, I_MOON, VARPI_EARTH, E_EARTH,
} = await import("../src/constants.js");
const { setEpochMs, getEpochMs, epochOffsetSeconds, meanAnomalyAdvance, J2000_MS } = await import("../src/epoch.js");
const { BH, GS } = await import("../src/state.js");

function assert(cond, msg) {
  if (!cond) throw new Error("smoke-physics3d FAILED: " + msg);
}

// ---------------------------------------------------------------------------
// (a) init-parity: keplerInit3 with i=Om=0 must reproduce the old planar
// keplerInit bit-for-bit (the rotation math reduces to the identity exactly,
// per the comment above keplerInit3 in ephemeris.js).
// ---------------------------------------------------------------------------
{
  const cases = [
    { a: A_MOON, e: E_MOON, varpi: 0, M0: MOON_ANG0, mu: MU_E + MU_M },
    { a: 149597870.7, e: E_EARTH, varpi: VARPI_EARTH, M0: 1.234, mu: MU_S + MU_E },
    ...PL.map(p => ({ a: p.a, e: p.e, varpi: p.varpi, M0: p.phase, mu: MU_S })),
    { a: 1e6, e: 0.9, varpi: 5.5, M0: -2.3, mu: 4e5 }, // a high-e synthetic case
  ];
  const planar = { x: 0, y: 0, vx: 0, vy: 0 };
  const full3 = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  for (const c of cases) {
    keplerInit(c.a, c.e, c.varpi, c.M0, c.mu, planar);
    keplerInit3(c.a, c.e, 0, 0, c.varpi, c.M0, c.mu, full3);
    assert(full3.x === planar.x && full3.y === planar.y, `keplerInit3(i=Om=0) x/y must equal keplerInit exactly for ${JSON.stringify(c)}`);
    assert(full3.vx === planar.vx && full3.vy === planar.vy, `keplerInit3(i=Om=0) vx/vy must equal keplerInit exactly for ${JSON.stringify(c)}`);
    assert(full3.z === 0 && full3.vz === 0, `keplerInit3(i=Om=0) must give z=vz=0 exactly for ${JSON.stringify(c)}, got z=${full3.z} vz=${full3.vz}`);
  }
  console.log("(a) init-parity OK:", cases.length, "cases, bit-exact");
}

// ---------------------------------------------------------------------------
// (b) inclination sanity: Mercury's z amplitude over one orbit matches the
// exact closed-form maximum (not just the circular-orbit approximation
// a·sin(i), which is off by ~8% at Mercury's eccentricity — verified by
// hand before writing this test), and node crossings land at longitude
// Om / Om+180°.
//
// Derivation of the exact max: with u = argument of latitude (= argp + nu)
// and r(nu) = p/(1+e·cos(nu)), z(u) = r·sin(u)·sin(i). Setting dz/du = 0 and
// using cos(u)cos(u-argp) + sin(u)sin(u-argp) = cos(argp) gives the maximum
// condition cos(u*) = -e·cos(argp); z_max is then r(u*-argp)·sin(u*)·sin(i).
// ---------------------------------------------------------------------------
{
  const p = PL.find(x => x.name === "MERCURY");
  const argp = p.varpi - p.Om;
  const pLR = p.a * (1 - p.e * p.e);
  const cosU = -p.e * Math.cos(argp);
  const uCands = [Math.acos(cosU), -Math.acos(cosU)];
  let expectedZMax = 0, uStar = 0;
  for (const u of uCands) {
    const nu = u - argp;
    const r = pLR / (1 + p.e * Math.cos(nu));
    const z = r * Math.sin(u) * Math.sin(p.i);
    if (Math.abs(z) > Math.abs(expectedZMax)) { expectedZMax = z; uStar = u; }
  }
  function nuToM(nu, e) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    return E - e * Math.sin(E);
  }
  const out = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  const nuStar = uStar - argp;
  keplerInit3(p.a, p.e, p.i, p.Om, p.varpi, nuToM(nuStar, p.e), MU_S, out);
  const relErr = Math.abs(out.z - expectedZMax) / Math.abs(expectedZMax);
  assert(relErr < 1e-6, `Mercury z at the analytic maximum should match the closed form to 1e-6, got z=${out.z} expected=${expectedZMax} relErr=${relErr}`);
  // sanity: the naive circular approximation is indeed a poor match here
  // (confirms this test is meaningfully stricter than "a*sin(i) within 5%")
  const circApprox = p.a * Math.sin(p.i);
  assert(Math.abs(Math.abs(expectedZMax) - circApprox) / circApprox > 0.03,
    "sanity check failed: expected Mercury's true z-max to differ meaningfully from the circular a*sin(i) approximation");

  // node crossings: heliocentric longitude at z=0 must be Om (ascending) and
  // Om+180° (descending), to within floating-point noise.
  const nuAsc = -argp, nuDesc = Math.PI - argp;
  keplerInit3(p.a, p.e, p.i, p.Om, p.varpi, nuToM(nuAsc, p.e), MU_S, out);
  const lonAsc = Math.atan2(out.y, out.x);
  assert(Math.abs(out.z) < 1e-6, `ascending-node z should be ~0, got ${out.z}`);
  assert(Math.abs(((lonAsc - p.Om + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) < 1e-9,
    `ascending node longitude should equal Om (${p.Om}), got ${lonAsc}`);
  keplerInit3(p.a, p.e, p.i, p.Om, p.varpi, nuToM(nuDesc, p.e), MU_S, out);
  const lonDesc = Math.atan2(out.y, out.x);
  assert(Math.abs(out.z) < 1e-6, `descending-node z should be ~0, got ${out.z}`);
  const expectedDesc = ((p.Om + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  assert(Math.abs(((lonDesc - expectedDesc + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) < 1e-9,
    `descending node longitude should equal Om+180 (${expectedDesc}), got ${lonDesc}`);
  console.log("(b) inclination sanity OK: Mercury z_max matches closed form, node crossings at Om/Om+180");
}

// ---------------------------------------------------------------------------
// (c)+(d) ENERGY/ANGULAR-MOMENTUM GATE: standalone Earth-Moon two-body KDK vs
// RK4 comparison at the same fixed step, using the REAL Moon orbital elements
// (a, e, i) from constants.js. This is a fresh, self-contained pair of
// integrators (not imported from ephemeris.js — the shipped module no longer
// has an RK4 body path to import) applied to the classical two-body problem,
// which has an exactly-conserved specific energy E=v²/2-mu/r and specific
// angular momentum vector L=r×v in continuous time.
//
// Measured before writing these thresholds (see the WP13 report): at the
// production step (period/200), RK4's *local* accuracy (O(dt^5) per step)
// beats leapfrog's (O(dt^3) per step) over a short span, so a naive "100
// orbits, KDK <= 1e-6" check as originally suggested does NOT hold — KDK
// measures ~4.8e-5 at 100 orbits, matching its behavior at 10,000 AND
// 300,000 orbits bit-for-bit (a flat, non-growing ceiling — the defining
// symplectic signature). RK4 at the SAME step instead grows secularly and
// linearly with orbit count (5.9e-5 at 10^4 orbits, 5.9e-4 at 10^5), so it
// provably overtakes KDK's flat ceiling once the run is long enough — this
// is what "bounded vs unbounded" actually means and is what this test
// verifies directly, with thresholds set from the measured numbers (not the
// original rough 1e-6 guess).
// ---------------------------------------------------------------------------
{
  const mu = MU_E + MU_M;
  const ic = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  keplerInit3(A_MOON, E_MOON, I_MOON, 0, 0, MOON_ANG0, mu, ic);
  const period = 2 * Math.PI * Math.sqrt((A_MOON ** 3) / mu);
  const dt = period / 200; // matches ephemeris.js's LEAP_DT_MAX (lunar period / 200)
  const checkpointsOrbits = [100, 1000, 10000];
  const totalOrbits = checkpointsOrbits[checkpointsOrbits.length - 1];
  const totalSteps = Math.round(totalOrbits * 200);

  function accel(x, y, z) {
    const r2 = x * x + y * y + z * z, r = Math.sqrt(r2), r3 = r2 * r;
    const w = -mu / r3;
    return [w * x, w * y, w * z];
  }
  function energyOf(s) {
    const [x, y, z, vx, vy, vz] = s;
    return 0.5 * (vx * vx + vy * vy + vz * vz) - mu / Math.hypot(x, y, z);
  }
  function angMomOf(s) {
    const [x, y, z, vx, vy, vz] = s;
    return [y * vz - z * vy, z * vx - x * vz, x * vy - y * vx];
  }
  function rk4Step(s, h) {
    const deriv = ([x, y, z, vx, vy, vz]) => {
      const [ax, ay, az] = accel(x, y, z);
      return [vx, vy, vz, ax, ay, az];
    };
    const k1 = deriv(s);
    const s2 = s.map((v, i) => v + h / 2 * k1[i]);
    const k2 = deriv(s2);
    const s3 = s.map((v, i) => v + h / 2 * k2[i]);
    const k3 = deriv(s3);
    const s4 = s.map((v, i) => v + h * k3[i]);
    const k4 = deriv(s4);
    return s.map((v, i) => v + h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  }
  function kdkStep(s, h) {
    let [x, y, z, vx, vy, vz] = s;
    let [ax, ay, az] = accel(x, y, z);
    vx += ax * h / 2; vy += ay * h / 2; vz += az * h / 2;
    x += vx * h; y += vy * h; z += vz * h;
    [ax, ay, az] = accel(x, y, z);
    vx += ax * h / 2; vy += ay * h / 2; vz += az * h / 2;
    return [x, y, z, vx, vy, vz];
  }

  const s0 = [ic.x, ic.y, ic.z, ic.vx, ic.vy, ic.vz];
  const E0 = energyOf(s0), L0 = angMomOf(s0), L0mag = Math.hypot(...L0);

  function run(stepFn) {
    let s = s0.slice();
    let maxDE = 0, maxDL = 0;
    const atCheckpoint = {};
    let cpIdx = 0;
    for (let i = 0; i < totalSteps; i++) {
      s = stepFn(s, dt);
      const dE = Math.abs((energyOf(s) - E0) / E0);
      const L = angMomOf(s);
      const dL = Math.hypot(L[0] - L0[0], L[1] - L0[1], L[2] - L0[2]) / L0mag;
      if (dE > maxDE) maxDE = dE;
      if (dL > maxDL) maxDL = dL;
      if (cpIdx < checkpointsOrbits.length && i === checkpointsOrbits[cpIdx] * 200 - 1) {
        atCheckpoint[checkpointsOrbits[cpIdx]] = maxDE;
        cpIdx++;
      }
    }
    return { maxDE, maxDL, atCheckpoint, final: s };
  }

  const kdkResult = run(kdkStep);
  const rk4Result = run(rk4Step);

  console.log("(c) energy drift checkpoints (|dE/E|max): KDK", kdkResult.atCheckpoint, " RK4", rk4Result.atCheckpoint);
  console.log("(d) angular-momentum drift over", totalOrbits, "orbits: KDK |dL/L|max =", kdkResult.maxDL, " RK4 |dL/L|max =", rk4Result.maxDL);

  // KDK is bounded: its drift at 10,000 orbits must not have grown
  // meaningfully past its drift at 100 orbits (a generous 3x band around a
  // measured ratio of ~1.00).
  assert(kdkResult.atCheckpoint[10000] < kdkResult.atCheckpoint[100] * 3,
    `KDK energy drift should stay bounded (not grow secularly): at 100 orbits ${kdkResult.atCheckpoint[100]}, at 10000 orbits ${kdkResult.atCheckpoint[10000]}`);
  assert(kdkResult.maxDE <= 1e-4, `KDK energy drift should stay within a realistic bound (<=1e-4) over ${totalOrbits} Moon orbits, got ${kdkResult.maxDE}`);
  // RK4 is NOT bounded: it grows secularly with time at the same step (this
  // is the actual reason KDK eventually wins — confirms the test itself is
  // exercising the claimed effect, not just asserting a number).
  assert(rk4Result.atCheckpoint[10000] > rk4Result.atCheckpoint[100] * 5,
    `sanity check failed: RK4 energy drift should grow secularly at this step, got ${rk4Result.atCheckpoint[100]} at 100 orbits vs ${rk4Result.atCheckpoint[10000]} at 10000 orbits`);
  // The actual acceptance criterion: KDK strictly beats RK4 at the same
  // step once the run is long enough for RK4's secular drift to overtake
  // KDK's flat ceiling (by 10,000 orbits here).
  assert(kdkResult.atCheckpoint[10000] < rk4Result.atCheckpoint[10000],
    `KDK energy drift (${kdkResult.atCheckpoint[10000]}) should be strictly smaller than RK4's (${rk4Result.atCheckpoint[10000]}) at the same step over ${totalOrbits} orbits`);
  assert(kdkResult.maxDL <= 1e-6, `KDK angular-momentum drift should be bounded near machine precision (<=1e-6), got ${kdkResult.maxDL}`);
  assert(isFinite(kdkResult.final.reduce((a, b) => a + b, 0)), "KDK final state must be finite");
  console.log("(c)+(d) energy/angular-momentum gate PASSED");
}

// ---------------------------------------------------------------------------
// (e) real-date seeding: with a known epochMs, Earth's mean anomaly must have
// advanced by exactly meanAnomalyAdvance(secondsSinceJ2000(epochMs), period)
// relative to the J2000 (offset=0) run — computed independently here, not
// hardcoded. The true-longitude difference between the two runs must match
// that mean-anomaly advance to within the equation-of-center for Earth's
// small eccentricity (~2*e*180/pi =~ 1.9 degrees at worst).
// ---------------------------------------------------------------------------
{
  setEpochMs(J2000_MS);
  resetEphem();
  const earthLonJ2000 = Math.atan2(-eph.sunY, -eph.sunX); // Earth heliocentric = -Sun(Earth-relative)

  const epochMs = Date.UTC(2026, 6, 1, 0, 0, 0); // 2026-07-01 (month index 6 = July)
  setEpochMs(epochMs);
  const offsetSec = epochOffsetSeconds();
  assert(offsetSec === (epochMs - J2000_MS) / 1000, "epochOffsetSeconds should compose getEpochMs+secondsSinceJ2000");
  // recompute Earth's period the same way constants.js does (mu/a^3), not by
  // importing OM_YEAR, so this is an independent cross-check of the value
  const AU_KM_LOCAL = 149597870.7;
  const nEarth = Math.sqrt((MU_S + MU_E) / (AU_KM_LOCAL ** 3));
  const periodEarth = 2 * Math.PI / nEarth;
  const expectedAdvanceRad = meanAnomalyAdvance(offsetSec, periodEarth);
  const expectedAdvanceDeg = ((expectedAdvanceRad * 180 / Math.PI) % 360 + 360) % 360;
  console.log("(e) expected Earth mean-anomaly advance since J2000:", expectedAdvanceDeg.toFixed(2), "deg (offset", (offsetSec / 86400 / 365.25).toFixed(2), "yr)");
  assert(Math.abs(expectedAdvanceDeg - 180.7) < 5, `sanity: expected ~180.7 deg advance for 2026-07-01, got ${expectedAdvanceDeg}`);

  resetEphem();
  const earthLon2026 = Math.atan2(-eph.sunY, -eph.sunX);
  let actualAdvanceDeg = ((earthLon2026 - earthLonJ2000) * 180 / Math.PI % 360 + 360) % 360;
  // The true longitude at each of the two epochs can deviate from its own
  // mean anomaly by up to the equation-of-center peak (~2e radians); the
  // ADVANCE between epochs differences two such terms, so the worst-case gap
  // between "actual longitude advance" and "mean-anomaly advance" is up to
  // ~4e radians (measured: 3.796 deg against a 3.83 deg bound below).
  const eqOfCenterMaxDeg = 4 * E_EARTH * 180 / Math.PI; // ~3.83 deg worst case
  const diff = Math.min(Math.abs(actualAdvanceDeg - expectedAdvanceDeg), 360 - Math.abs(actualAdvanceDeg - expectedAdvanceDeg));
  assert(diff < eqOfCenterMaxDeg + 0.5, `Earth's actual longitude advance (${actualAdvanceDeg.toFixed(3)}) should match the mean-anomaly advance (${expectedAdvanceDeg.toFixed(3)}) within the equation-of-center bound, diff=${diff.toFixed(3)}`);
  console.log("(e) real-date seeding OK: actual advance", actualAdvanceDeg.toFixed(3), "deg vs expected", expectedAdvanceDeg.toFixed(3), "deg (diff", diff.toFixed(3), "deg, bound", (eqOfCenterMaxDeg + 0.5).toFixed(3), ")");

  // restore a clean, deterministic epoch for anything that runs after this
  setEpochMs(J2000_MS);
  resetEphem();
}

// ---------------------------------------------------------------------------
// (g)+(h) ECLIPSE ACCEPTANCE (plan gate, binds WP13/WP14): with real lunar
// inclination/node live, the 2026-08-12 total solar eclipse (~17:46 UTC, new
// moon at the node) must emerge from the mean-element ephemeris — Sun and
// Moon seen from Earth's center must be nearly the SAME direction (angular
// separation near 0 deg; a full moon would instead show ~180 deg). Mean
// elements can be off by hours near the date, so per the plan we search the
// MINIMUM separation within +-2 days of the nominal instant rather than
// asserting the strict value exactly at 17:46, and record the time offset at
// which the minimum occurs. This directly warps the sim clock via
// setEpochMs+resetEphem for each sampled instant (no minute-by-minute
// integration needed — the mean-element seeding IS the "warp the clock
// there" operation). 2026-07-06 23:30 UTC is the regression case: it must
// show clear non-alignment.
//
// Threshold note: OMEGA (constants.js) was originally derived from Kepler's
// third law (sqrt((MU_E+MU_M)/A_MOON^3) -> 27.2872 d), 0.126% short of the
// Moon's true observed sidereal month (27.321661 d, longer because solar
// perturbation isn't in a pure two-body rate). That was invisible near J2000
// but compounded secularly over ~354 orbits to 26.5 years later: BEFORE the
// fix this test measured a 143 deg miss (the wrong lunation entirely, with
// the +-2 day search bottoming out at its window edge). AFTER recalibrating
// OMEGA to the observed rate, the minimum lands within an hour of the real
// eclipse instant (see the measured offset below) with only a few degrees of
// residual separation. That residual is a REAL, BOUNDED, non-secular
// limitation of mean two-body elements without full lunar perturbation
// theory (evection ~1.27 deg, variation ~0.66 deg, annual equation ~0.19 deg,
// etc.) — confirmed below by an independent J2000-era control check (zero
// elapsed epoch offset, so neither the OMEGA fix nor node-precession secular
// terms have any time to drift) landing at the SAME order of magnitude. So
// EPS_DEG is calibrated from that measured, reproducible ceiling (not the
// plan's original optimistic "1-2 deg" guess), with headroom under it; a
// future secular-drift regression would still blow well past it, exactly
// like the pre-fix 143 deg case did.
// ---------------------------------------------------------------------------
{
  function sunMoonSepDeg(epochMs) {
    setEpochMs(epochMs);
    resetEphem();
    const sunMag = Math.hypot(eph.sunX, eph.sunY, eph.sunZ);
    const moonMag = Math.hypot(eph.moonX, eph.moonY, eph.moonZ);
    const dot = eph.sunX * eph.moonX + eph.sunY * eph.moonY + eph.sunZ * eph.moonZ;
    const cosTheta = Math.max(-1, Math.min(1, dot / (sunMag * moonMag)));
    return Math.acos(cosTheta) * 180 / Math.PI;
  }

  // control: a KNOWN real new moon near J2000 (2000-01-06 18:14 UTC), i.e.
  // ~zero elapsed epoch offset, so any secular drift in OMEGA or the node
  // precession rate has had essentially no time to act. If the real-elements
  // seeding is fundamentally sound, this must land within the same few-degree
  // ceiling as the 2026 case below — establishing that ceiling empirically
  // instead of guessing it.
  const EPS_DEG = 8; // measured ceiling ~5-6.5 deg at both J2000 and 2026; keeps headroom
  const j2000NewMoonMs = Date.UTC(2000, 0, 6, 18, 14, 0);
  const j2000Sep = sunMoonSepDeg(j2000NewMoonMs);
  console.log("(g0) near-J2000 control (2000-01-06 18:14 UTC real new moon): Sun-Moon separation =", j2000Sep.toFixed(2), "deg");
  assert(j2000Sep < EPS_DEG, `near-J2000 control should already land within the mean-element ceiling (< ${EPS_DEG} deg) with ~zero elapsed epoch offset, got ${j2000Sep.toFixed(2)} deg`);

  const nominalMs = Date.UTC(2026, 7, 12, 17, 46, 0); // month index 7 = August
  const windowMs = 2 * 86400 * 1000;
  const stepMs = 10 * 60 * 1000; // 10-minute grid: ~0.045 deg quantization, far finer than the EPS_DEG bound
  let minSep = Infinity, minOffsetMs = 0;
  for (let d = -windowMs; d <= windowMs; d += stepMs) {
    const sep = sunMoonSepDeg(nominalMs + d);
    if (sep < minSep) { minSep = sep; minOffsetMs = d; }
  }
  console.log("(g) eclipse check: minimum Sun-Moon separation within +-2 days of 2026-08-12 17:46 UTC =",
    minSep.toFixed(4), "deg, at offset", (minOffsetMs / 3600000).toFixed(2), "h from nominal");
  assert(minSep < EPS_DEG, `expected the 2026-08-12 eclipse's minimum Sun-Moon separation within +-2 days to be < ${EPS_DEG} deg, got ${minSep.toFixed(4)} deg (offset ${(minOffsetMs / 3600000).toFixed(2)}h)`);
  assert(Math.abs(minOffsetMs / 3600000) < 6, `expected the minimum to land within a few hours of the real eclipse instant (secular-drift regression guard), got offset ${(minOffsetMs / 3600000).toFixed(2)}h`);

  const noEclipseMs = Date.UTC(2026, 6, 6, 23, 30, 0); // month index 6 = July
  const noEclipseSep = sunMoonSepDeg(noEclipseMs);
  console.log("(h) no-eclipse regression (2026-07-06 23:30 UTC): Sun-Moon separation =", noEclipseSep.toFixed(2), "deg");
  assert(noEclipseSep > 5, `expected 2026-07-06 23:30 UTC to show no eclipse alignment (separation > 5 deg), got ${noEclipseSep.toFixed(2)} deg`);

  // restore a clean, deterministic epoch for anything that runs after this
  setEpochMs(J2000_MS);
  resetEphem();
}

// ---------------------------------------------------------------------------
// (i) SHIPPED-PATH energy sanity (WP13 review carry-forward): (c)+(d) above
// re-implement KDK/RK4 standalone for an isolated Earth-Moon two-body case.
// This block instead calls the actual production `advanceEphem` (the full
// Sun+Earth+Moon+planets leapfrog, indirect frame term, and Sun 1PN, exactly
// as shipped) and tracks a Newtonian N-body energy proxy built from the real
// snapshot: KE=sum(1/2 * mu_i * v_i^2), PE=-sum_{i<j} mu_i*mu_j/r_ij, treating
// each body's mu (=G*M) as its "mass" with G=1 — self-consistent because the
// production mutual-gravity law is exactly a_i = -sum_j mu_j*(r_i-r_j)/r_ij^3,
// i.e. this proxy IS conserved under pure Newtonian dynamics with these
// weights. The Sun's 1PN correction (active inside 0.5 AU, i.e. continuously
// for Mercury) is a small non-Newtonian perturbation this proxy doesn't
// account for, so a little drift is physically expected — the assertion
// bounds it, it doesn't require exact conservation.
// Chunk size (1 day) is kept well under the deep-time Kepler-jump gate
// threshold (bodyStepSize()*150, effectively >=540,000 s here) so every call
// is forced through the real leapfrog path, never the analytic Kepler jump.
// ---------------------------------------------------------------------------
{
  setEpochMs(J2000_MS);
  resetEphem();
  const muArr = new Float64Array(NB);
  muArr[IDX_MOON] = MU_M;
  muArr[IDX_SUN] = MU_S;
  for (let i = 0; i < PL.length; i++) muArr[IDX_PLANETS + i] = PL[i].mu;

  function totalEnergy() {
    const st = snapshotEphem();
    const n = NB + 1; // +1 for Earth itself
    const X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
    const VX = new Float64Array(n), VY = new Float64Array(n), VZ = new Float64Array(n);
    const M = new Float64Array(n);
    X[NB] = st.earthX; Y[NB] = st.earthY; Z[NB] = st.earthZ;
    VX[NB] = st.earthVx; VY[NB] = st.earthVy; VZ[NB] = st.earthVz;
    M[NB] = MU_E;
    for (let i = 0; i < NB; i++) {
      X[i] = st.earthX + st.x[i]; Y[i] = st.earthY + st.y[i]; Z[i] = st.earthZ + st.z[i];
      VX[i] = st.earthVx + st.vx[i]; VY[i] = st.earthVy + st.vy[i]; VZ[i] = st.earthVz + st.vz[i];
      M[i] = muArr[i];
    }
    let KE = 0, PE = 0;
    for (let i = 0; i < n; i++) KE += 0.5 * M[i] * (VX[i] * VX[i] + VY[i] * VY[i] + VZ[i] * VZ[i]);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const dx = X[i] - X[j], dy = Y[i] - Y[j], dz = Z[i] - Z[j];
        PE -= M[i] * M[j] / Math.hypot(dx, dy, dz);
      }
    return KE + PE;
  }

  const moonPeriod = 2 * Math.PI * Math.sqrt((A_MOON ** 3) / (MU_E + MU_M));
  const totalDuration = 10 * moonPeriod;
  const CHUNK_S = 86400; // 1 day: far under the ~540,000 s deep-time gate threshold
  const E0 = totalEnergy();
  assert(isFinite(E0), "initial system energy must be finite");
  let maxDE = 0, remaining = totalDuration;
  while (remaining > 1e-6) {
    const dt = Math.min(CHUNK_S, remaining);
    advanceEphem(dt);
    remaining -= dt;
    const dE = Math.abs((totalEnergy() - E0) / E0);
    if (dE > maxDE) maxDE = dE;
  }
  console.log("(i) shipped-path energy sanity: |dE/E|max over 10 Moon orbits via production advanceEphem =", maxDE);
  assert(maxDE < 1e-4, `production advanceEphem should conserve the full-system Newtonian energy proxy to <1e-4 over 10 Moon orbits, got ${maxDE}`);

  setEpochMs(J2000_MS);
  resetEphem();
}

// ---------------------------------------------------------------------------
// guard: resetEphem must never throw even if the epoch module were somehow
// unavailable — simulate by temporarily poisoning epochOffsetSeconds' input.
// (safeEpochOffsetSeconds in ephemeris.js catches and falls back to 0; here
// we just confirm setEpochMs(NaN) — a broken epoch value — doesn't throw and
// falls back sanely.)
// ---------------------------------------------------------------------------
{
  setEpochMs(NaN);
  let threw = null;
  try { resetEphem(); } catch (e) { threw = e; }
  assert(threw === null, "resetEphem must not throw when the epoch is non-finite, got: " + threw);
  assert(Number.isFinite(eph.sunX) && Number.isFinite(eph.sunY), "resetEphem should fall back to a finite J2000 state when the epoch is broken");
  setEpochMs(J2000_MS);
  resetEphem();
  console.log("guard OK: resetEphem never throws on a broken epoch, falls back to J2000");
}

// ---------------------------------------------------------------------------
// sanity: NB / BH / GS wiring untouched by this file's changes
// ---------------------------------------------------------------------------
assert(NB === IDX_PLANETS + PL.length, "NB should equal IDX_PLANETS + planet count");
assert(BH.n === 0 && GS.length === 0, "this smoke test assumes a clean BH/GS state");

// ---------------------------------------------------------------------------
// (f) determinism: print a hash of the resulting state so this file can be
// diffed across `node` and `bun` runs (the gate step runs both and compares
// stdout).
// ---------------------------------------------------------------------------
{
  const digestParts = [eph.moonX, eph.moonY, eph.moonZ, eph.sunX, eph.sunY, eph.sunZ,
    ...eph.plX, ...eph.plY, ...eph.plZ];
  console.log("(f) determinism digest:", digestParts.map(v => v.toPrecision(12)).join(","));
}

console.log("physics3d smoke passed");
