// WP23-EXTENSION smoke: bound systems must not expand under dark energy, and
// the Sun must ride its own galactic orbit rather than sit at a fixed anchor
// forever (user physics report 2026-07-02: a T+34 Gyr screenshot showed the
// solar system drifting OUT of the galaxy).
//
// (a) Pure-Node checks against src/cosmology.js's boundSuppression and
//     src/universe/solarOrbit.js's solarGalacticStateAt — no browser needed,
//     both modules are plain math with no DOM dependency.
// (b) Headless deep-warp (pattern + starting point: smoke-river-deeptime.mjs's
//     "LOCAL-GROUP EXPANSION" scenario, 1.3 Mpc out at 72 km/s): drives the
//     ship through the real advance()/shipCosmologyJump code path for 34 Gyr
//     and asserts gravity now measurably brakes the expansion (bounded growth,
//     decreasing speed) instead of the pre-fix pure h^2*r runaway.
//
//     Debugging note (WP23-EXTENSION, kept for the next person touching this):
//     a ship parked motionless a few hundred pc from Earth is a POOR
//     regression proxy — over Gyr timescales it reliably intersects a
//     procedurally-generated star's real gravity (~1 star every few pc at
//     the Sun's local density) and gets a real, unrelated N-body kick, which
//     this test avoids by neutering the gravity-star pool (see below). Also:
//     eph.earthX/Y (Earth's own world position) was independently confirmed
//     to drift by 1e7+ AU over just 5 Gyr with BOTH G.darkEnergy and
//     G.darkMatter OFF — a separate, pre-existing ephemeris.js bug, unrelated
//     to Lambda or the DM halo and out of this package's file ownership
//     (cosmology.js/solarOrbit.js only), and likely the dominant contributor
//     to the user's original screenshot. FIXED (follow-up): resetEphem() set
//     the Sun's initial velocity from the reduced Earth-Sun two-body problem
//     alone, so the whole system's total momentum came out nonzero (~9 m/s,
//     missing the Sun's real reflex motion from Jupiter/Saturn/etc); since
//     momentum is exactly conserved thereafter, the barycenter coasted at
//     that residual velocity forever — a pure initial-condition defect, not
//     a Kepler-jump chaining artifact (reproduced identically with a single
//     advanceEphem(5 Gyr) call). Fixed by zeroing the system's total (x,y)
//     momentum at the end of resetEphem; see scripts/smoke-physics3d.mjs
//     part (j) for the dedicated regression.

import { createServer } from "vite";

function assert(ok, message, ctx) {
  if (!ok) throw new Error(message + (ctx ? " " + JSON.stringify(ctx) : ""));
}

// ---------------------------------------------------------------------------
// (a) Pure-Node checks
// ---------------------------------------------------------------------------
async function runPureNodeChecks() {
  const cosmo = await import("../src/cosmology.js");
  const consts = await import("../src/constants.js");
  const coords = await import("../src/universe/coords.js");
  const astro = await import("../src/universe/astroConstants.js");
  const solar = await import("../src/universe/solarOrbit.js");

  const { AU_KM, MU_S, SEC_YEAR, PC_KM: PC_KM_C } = consts;
  const { PC_KM, R0_PC, SUN_GAL } = coords;
  const { boundSuppression, LOCAL_GROUP_MASS_SOLAR } = cosmo;

  // --- boundSuppression: real g values computed independently from constants ---
  const gEarth = MU_S / (AU_KM * AU_KM);
  const sEarth = boundSuppression(AU_KM, gEarth);
  assert(sEarth > 0.99, "Earth-orbit scale must be ~fully suppressed (bound)", { sEarth, gEarth });

  const rGalKm = R0_PC * PC_KM;
  const vcirc = astro.vCirc(R0_PC / 1000);
  const gGal = (vcirc * vcirc) / rGalKm; // centripetal accel from the real 229 km/s rotation curve
  const sGal = boundSuppression(rGalKm, gGal);
  assert(sGal > 0.99, "8.2 kpc galactocentric (Sun's own radius) must be ~fully suppressed (bound)", { sGal, gGal });

  const r1Mpc = 1e6 * PC_KM;
  const gLG1 = MU_S * LOCAL_GROUP_MASS_SOLAR / (r1Mpc * r1Mpc);
  const s1Mpc = boundSuppression(r1Mpc, gLG1);
  assert(s1Mpc > 0.9, "1 Mpc Local-Group scale must be ~fully suppressed (bound)", { s1Mpc, gLG1 });

  const r10Mpc = 10e6 * PC_KM;
  const gLG10 = MU_S * LOCAL_GROUP_MASS_SOLAR / (r10Mpc * r10Mpc);
  const s10Mpc = boundSuppression(r10Mpc, gLG10);
  assert(s10Mpc < 0.05, "10 Mpc, well beyond the Local Group, must be ~fully active (unbound)", { s10Mpc, gLG10 });

  console.log("boundSuppression: Earth=" + sEarth.toFixed(4) + " 8.2kpc=" + sGal.toFixed(4) + " 1Mpc=" + s1Mpc.toFixed(4) + " 10Mpc=" + s10Mpc.toFixed(4));

  // --- solarGalacticStateAt ---
  const s0 = solar.solarGalacticStateAt(0);
  assert(s0.x === SUN_GAL[0] && s0.y === SUN_GAL[1] && s0.z === SUN_GAL[2],
    "solarGalacticStateAt(0) must exactly reproduce the SUN_GAL anchor", { s0, SUN_GAL });

  const periodMyr = solar.GALACTIC_ORBIT_PERIOD_S / (1e6 * 365.25 * 86400);
  assert(periodMyr > 200 && periodMyr < 260, "Sun's galactic orbital period should be ~200-260 Myr", { periodMyr });

  let minRpc = Infinity, maxRpc = -Infinity;
  const stepGyr = 0.01;
  for (let gyr = 0; gyr <= 2 + 1e-9; gyr += stepGyr) {
    const t = gyr * 1e9 * SEC_YEAR;
    const st = solar.solarGalacticStateAt(t);
    const R = Math.hypot(st.x, st.y);
    assert(Number.isFinite(R) && Number.isFinite(st.z), "solar orbit position must stay finite", { gyr, st });
    if (R < minRpc) minRpc = R;
    if (R > maxRpc) maxRpc = R;
  }
  assert(minRpc / 1000 > 7.5 && maxRpc / 1000 < 9, "Sun's galactocentric radius must stay bounded within [7.5, 9] kpc over 2 Gyr (epicyclic, not runaway)", { minKpc: minRpc / 1000, maxKpc: maxRpc / 1000 });

  console.log("solarGalacticStateAt: period=" + periodMyr.toFixed(1) + "Myr R-range=[" + (minRpc / 1000).toFixed(3) + "," + (maxRpc / 1000).toFixed(3) + "]kpc");
  console.log("pure-Node checks passed");
}

// ---------------------------------------------------------------------------
// (b) Headless deep-warp regression: the ship must not fly out of the galaxy
// ---------------------------------------------------------------------------
async function runHeadlessDeepWarpCheck() {
  let url = process.env.ARTEMIS_URL;
  let viteServer = null;
  if (!url) {
    viteServer = await createServer({
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    });
    await viteServer.listen();
    const address = viteServer.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite server did not expose a TCP port");
    url = `http://127.0.0.1:${address.port}/?bloom=0&hidehelp=1&tier1=0`;
  }

  const pwModule = await import("playwright");
  const pw = pwModule.default ?? pwModule;
  const browser = await pw.chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", err => errors.push(err.message));

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem("ap_introSeen", "1"); localStorage.setItem("ap_helpSeen", "1"); });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__G && window.__AP_READY);

    const result = await page.evaluate(async (targetGyr) => {
      const { G } = await import("/src/state.js");
      const { PC_KM, SEC_YEAR } = await import("/src/constants.js");
      const { eph, updEphem } = await import("/src/ephemeris.js");
      const { advance } = await import("/src/physics.js");
      const { equatorialKmToGal } = await import("/src/universe/coords.js");
      const activeStars = await import("/src/universe/activeStars.js");

      // Test isolation: neutralize the procedural/real stellar-gravity pool.
      // Over a 34 Gyr integration a fixed point in the galactic disk will
      // reliably intersect some star's real gravity (local density ~1 per
      // few pc) — a genuine, separate N-body effect this test isn't about.
      activeStars.GRAVITY_STARS.push = () => 0;
      activeStars.ACTIVE_STARS.push = () => 0;

      G.t = 0;
      G.dead = false;
      G.landed = null;
      G.paused = false;
      G.cabin = false;
      updEphem(0);

      // Same start point as the "LOCAL-GROUP EXPANSION" scenario (scenarios.js):
      // 1.3 Mpc out along the heliocentric-outward direction, moving at
      // 72 km/s — below the ~145 km/s escape speed the Local Group's combined
      // mass implies at that radius, so a correctly-bound treatment should
      // show gravity braking the outward drift, not a runaway.
      const sd = Math.hypot(eph.sunX, eph.sunY) || 1;
      const ux = -eph.sunX / sd, uy = -eph.sunY / sd;
      const rH = 1.3e6 * PC_KM;
      G.x = ux * (rH - sd); G.y = uy * (rH - sd); G.z = 0;
      G.vx = ux * 72 + eph.sunVx; G.vy = uy * 72 + eph.sunVy; G.vz = 0;
      G.heading = Math.atan2(G.vy, G.vx); G.pitch = 0;
      G.darkEnergy = true;
      G.darkMatter = true;
      G.gr = true;
      G.focus = "ship";
      G.warp = 1e9 * SEC_YEAR; // enables the shipCosmologyJump frame-bridge path

      const galAt = (x, y, z) => {
        const g = equatorialKmToGal(eph.earthX + x, eph.earthY + y, z);
        return Math.hypot(g[0], g[1], g[2]);
      };
      const rGalStart = galAt(G.x, G.y, G.z);
      const vStart = Math.hypot(G.vx, G.vy, G.vz);

      const targetSec = targetGyr * 1e9 * SEC_YEAR;
      const stepSec = 0.1e9 * SEC_YEAR;
      let guard = 0;
      while (G.t < targetSec && guard < 5000) {
        const remaining = targetSec - G.t;
        const advanced = advance(Math.min(stepSec, remaining), 0, 0, 0, 0);
        if (advanced <= 0) break;
        guard++;
      }

      const gyrReached = G.t / (1e9 * SEC_YEAR);
      const rGalEnd = galAt(G.x, G.y, G.z);
      const vEnd = Math.hypot(G.vx, G.vy, G.vz);

      return {
        gyrReached, guard,
        rGalStart, rGalEnd, vStart, vEnd,
        Gx: G.x, Gy: G.y, Gz: G.z,
        finite: Number.isFinite(G.x) && Number.isFinite(G.y) && Number.isFinite(G.z),
      };
    }, 34);

    console.log("deep-warp result: " + JSON.stringify(result));

    assert(result.finite, "ship position must stay finite through 34 Gyr of warp", result);
    assert(Math.abs(result.gyrReached - 34) / 34 < 0.05, "should reach ~34 Gyr of sim time", result);
    assert(result.rGalStart > 0 && result.rGalEnd > 0, "galactocentric distance must be positive", result);
    // The pre-fix behavior (raw h^2*r, no suppression) is a pure runaway:
    // speed grows without bound and distance explodes by 10+ orders of
    // magnitude over 34 Gyr (verified while debugging this fix). With the
    // Local-Group binding gate active, gravity must instead measurably brake
    // the expansion — speed decreasing, distance growing by at most a few x,
    // not diverging to nonsense scales.
    assert(result.vEnd < result.vStart,
      "gravity must measurably decelerate the outward drift (speed should decrease, not run away) — the signature that Local Group binding is suppressing Lambda",
      result);
    assert(result.rGalEnd < result.rGalStart * 5,
      "the ship's galactocentric distance must stay within a modest multiple of its starting value over 34 Gyr, not explode — it must NOT fly out of the galaxy/Local Group",
      result);

    if (errors.length) throw new Error("console errors: " + JSON.stringify(errors.slice(0, 20)));
    console.log("headless deep-warp bound-systems check passed");
  } finally {
    await browser.close();
    await viteServer?.close();
  }
}

await runPureNodeChecks();
await runHeadlessDeepWarpCheck();
console.log("smoke:bound-systems passed");
