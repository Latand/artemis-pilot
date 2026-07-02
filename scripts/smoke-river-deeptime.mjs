import { createServer } from "vite";

// Reproduces + guards against the deep-time spacetime-river breakdown (WP22):
// after the ship integrates for tens of Gyr under dark-energy expansion
// (shipCosmologyJump, physics.js), the ship/camera's absolute scene-space
// position grows to ~1e16-1e18 scene units — far past float32's ~7-digit
// precision. Before the WP22 fix, river.js uploaded that absolute position
// straight into GPU uniforms/textures (all float32), collapsing the river's
// local structure (~1e4 scene units) to a single quantized point. The fix
// (river.js) re-expresses every position relative to a float64 CPU-side
// center before it ever reaches the GPU. This smoke drives the ship through
// the same dark-energy expansion the "LOCAL-GROUP EXPANSION" scenario uses
// (scenarios.js), reaching ~34 Gyr and ~100 Gyr, and asserts the river's GPU
// position texture stays finite, spatially varied (not collapsed to one
// point), and still animates frame to frame.

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

function assert(ok, message, ctx) {
  if (!ok) throw new Error(message + (ctx ? " " + JSON.stringify(ctx) : ""));
}

// Drives the ship to `targetGyr` of sim time via repeated direct
// shipCosmologyJump-path advance() calls (small enough steps to stay
// numerically sane, but entirely synchronous — no real-time waiting), then
// lets a couple of real rendered frames run at that epoch and reads back the
// river's live GPU position texture twice in a row.
async function runToEpoch(page, targetGyr) {
  return await page.evaluate(async (targetGyr) => {
    const { G } = await import("/src/state.js");
    const { PC_KM, SEC_YEAR } = await import("/src/constants.js");
    const { eph, updEphem } = await import("/src/ephemeris.js");
    const { advance } = await import("/src/physics.js");
    const river = await import("/src/river.js");

    G.t = 0;
    G.dead = false;
    G.landed = null;
    G.paused = false;
    G.cabin = false;
    updEphem(0);

    // Same start point as the "LOCAL-GROUP EXPANSION" scenario (scenarios.js):
    // 1.3 Mpc out along the heliocentric-outward direction, moving at 72 km/s.
    const sd = Math.hypot(eph.sunX, eph.sunY) || 1;
    const ux = -eph.sunX / sd, uy = -eph.sunY / sd;
    const rH = 1.3e6 * PC_KM;
    G.x = ux * (rH - sd); G.y = uy * (rH - sd); G.z = 0;
    G.vx = ux * 72 + eph.sunVx; G.vy = uy * 72 + eph.sunVy; G.vz = 0;
    G.heading = Math.atan2(G.vy, G.vx);
    G.pitch = 0;
    G.darkEnergy = true;
    G.darkMatter = true;
    G.gr = true;
    G.focus = "ship";
    G.warp = 1e9 * SEC_YEAR; // enables the shipCosmologyJump frame-bridge path

    const targetSec = targetGyr * 1e9 * SEC_YEAR;
    const stepSec = 0.1e9 * SEC_YEAR; // 0.1 Gyr per step
    let guard = 0;
    while (G.t < targetSec && guard < 5000) {
      const remaining = targetSec - G.t;
      const advanced = advance(Math.min(stepSec, remaining), 0, 0, 0, 0);
      if (advanced <= 0) break; // jump refused (e.g. too close to a body) — stop rather than spin
      guard++;
    }

    // Freeze warp so the app's own rAF-driven frame loop doesn't keep
    // integrating huge additional jumps while we sample frames below.
    G.warp = 1;

    const gyrReached = G.t / (1e9 * SEC_YEAR);
    const cam = window.__cam;
    const camera = window.__gl.camera;

    const waitFrame = () => new Promise(r => requestAnimationFrame(r));
    // Wait for the app's own rAF-driven frame loop (main.js) to actually pick
    // up this epoch's ship state and run a real updateRiver() pass — not just
    // a fixed number of ticks, since main.js's own async boot/render-setup
    // work (unrelated to this fix) can vary the number of frames needed
    // before the loop is fully live. river.radius starts at a sentinel 22
    // and only becomes the real (possibly tiny, possibly huge) local radius
    // once updateRiver has run with live camera/ship state.
    let framesWaited = 0;
    while (river.river.radius === 22 && framesWaited < 300) {
      await waitFrame();
      framesWaited++;
    }
    await waitFrame();
    const snap1 = river.riverDebugReadPositions(8);
    await waitFrame();
    await waitFrame();
    const snap2 = river.riverDebugReadPositions(8);

    return {
      gyrReached,
      guard,
      framesWaited,
      Gx: G.x, Gy: G.y, Gz: G.z,
      camTgt: cam ? [cam.tgt.x, cam.tgt.y, cam.tgt.z] : null,
      camPos: camera ? [camera.position.x, camera.position.y, camera.position.z] : null,
      riverEnabled: river.river.enabled,
      riverRadius: river.river.radius,
      snap1, snap2,
    };
  }, targetGyr);
}

try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("ap_introSeen", "1"); localStorage.setItem("ap_helpSeen", "1"); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__G && window.__cam && window.__gl);

  const results = {};
  for (const gyr of [34.41, 100]) {
    const r = await runToEpoch(page, gyr);
    results[gyr] = r;
    console.log("epoch " + gyr + "Gyr -> " + JSON.stringify({ gyrReached: r.gyrReached, guard: r.guard, framesWaited: r.framesWaited, camTgt: r.camTgt, riverEnabled: r.riverEnabled, riverRadius: r.riverRadius, snap1: r.snap1, snap2: r.snap2 }));

    assert(r.framesWaited < 300, "the app's frame loop should pick up the new epoch's state within 300 frames", r);
    assert(r.riverEnabled, "river should stay enabled at deep time", r);
    assert(Math.abs(r.gyrReached - gyr) / gyr < 0.05, "should reach the target epoch (within 5%)", r);
    assert(r.snap1 && r.snap2, "river texture read-back should succeed", r);
    assert(r.snap1.finite && r.snap2.finite, "river particle positions must stay finite (no NaN/Inf collapse)", r);
    assert(r.snap1.nonZero > 0 && r.snap2.nonZero > 0, "river particles must not all collapse to the origin", r);
    assert(r.snap1.distinct > r.snap1.sampled * 0.5, "river particles must retain spatial variety, not quantize to one point", r);
    assert(r.snap2.distinct > r.snap2.sampled * 0.5, "river particles must retain spatial variety on a later frame too", r);
    assert(r.snap1.hash !== r.snap2.hash, "river must still be animating frame to frame (hash should differ)", r);

    // review C1: render placement — the lines mesh must sit AT smoothCenter in
    // world space (particles are center-relative; a mesh left at origin draws
    // the whole river displaced by -smoothCenter and invisible off-focus).
    if (r.snap1.visible) {
      const mp = r.snap1.meshPos, c = r.snap1.center;
      assert(mp, "river mesh handle should be readable", r);
      const scale = Math.max(1, Math.abs(c.x), Math.abs(c.y), Math.abs(c.z));
      const off = Math.max(Math.abs(mp.x - c.x), Math.abs(mp.y - c.y), Math.abs(mp.z - c.z));
      assert(off / scale < 1e-6, "river mesh must carry smoothCenter back into world space", { mp, c, off });
    }

    const camMag = Math.max(...r.camTgt.map(Math.abs));
    assert(camMag > 1e10, "sanity: camera target should genuinely be at a deep-time cosmological scene distance", { camMag, camTgt: r.camTgt });
  }

  const shot = await page.screenshot({ path: "/tmp/claude-1000/-home-latand-Projects-artemis-pilot/3464e715-d9dc-487c-a901-5c8f9bd38368/scratchpad/22-river-deeptime.png" });
  console.log("screenshot bytes " + shot.length);

  if (errors.length) throw new Error("console errors: " + JSON.stringify(errors.slice(0, 20)));

  console.log("river deep-time smoke passed");
} finally {
  await browser.close();
  await viteServer?.close();
}
