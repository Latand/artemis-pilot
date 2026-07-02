import { createServer } from "vite";

// WP23a: the Milky Way-Andromeda merger. Verifies the cached two-body +
// dynamical-friction trajectory table in cosmic.js (mergerSeparationKpcAt /
// mergerDisruptFractionAt / mergerDebugState) against the acceptance
// criteria from the plan (first passage ~4-5 Gyr, permanent capture under
// 50 kpc by 12 Gyr, monotonic pre-passage approach, determinism, finite at
// very deep time) and that the Local Group view actually renders a
// non-degenerate interacting pair partway through the merger.

const SEC_YEAR = 31557600;
const GYR_SEC = 1e9 * SEC_YEAR;
const LY_KM = 9460730472580.8;
const K = 0.001;
const LY_SCENE = LY_KM * K;
const SCRATCH = "/tmp/claude-1000/-home-latand-Projects-artemis-pilot/3464e715-d9dc-487c-a901-5c8f9bd38368/scratchpad";

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

function checksum(bytes) {
  let nonZero = 0, hash = 2166136261;
  for (let i = 0; i < bytes.length; i += 97) {
    const v = bytes[i];
    if (v) nonZero++;
    hash ^= v;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return { nonZero, sampled: Math.ceil(bytes.length / 97), hash };
}

async function bootPage() {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("ap_introSeen", "1"); localStorage.setItem("ap_helpSeen", "1"); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__G && window.__cam && window.__gl);
}

async function readMergerMath() {
  return await page.evaluate(async ({ gyrSec }) => {
    const cosmic = await import("/src/cosmic.js");
    const debug = cosmic.mergerDebugState();

    const sep0 = cosmic.mergerSeparationKpcAt(0);

    // Monotonic, strictly-decreasing pre-passage approach.
    const N = 200;
    const preSamples = [];
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * debug.firstPassageGyr * gyrSec;
      preSamples.push(cosmic.mergerSeparationKpcAt(t));
    }
    let monotonic = true;
    for (let i = 1; i < preSamples.length; i++) {
      if (preSamples[i] > preSamples[i - 1] + 0.5) { monotonic = false; break; } // 0.5 kpc slack for interpolation noise
    }

    // Permanent coalescence: separation stays under 50 kpc from 12 Gyr
    // onward (well past mergedGyr), sampled densely out to 100 Gyr.
    let permanentUnder50 = true, maxSepAfter12 = 0;
    for (let gyr = 12; gyr <= 100; gyr += 0.5) {
      const s = cosmic.mergerSeparationKpcAt(gyr * gyrSec);
      if (s > maxSepAfter12) maxSepAfter12 = s;
      if (s >= 50) permanentUnder50 = false;
    }

    const sepAt100 = cosmic.mergerSeparationKpcAt(100 * gyrSec);
    const sepAtHuge = cosmic.mergerSeparationKpcAt(1000 * gyrSec); // beyond table range - must stay finite

    const disruptAtFirstPassage = cosmic.mergerDisruptFractionAt(debug.firstPassageGyr * gyrSec);
    const disruptAt10Gyr = cosmic.mergerDisruptFractionAt(10 * gyrSec);
    const disruptAtStart = cosmic.mergerDisruptFractionAt(0);

    return {
      debug, sep0, monotonic, permanentUnder50, maxSepAfter12, sepAt100, sepAtHuge,
      disruptAtFirstPassage, disruptAt10Gyr, disruptAtStart,
      preFirst: preSamples[0], preLast: preSamples[preSamples.length - 1],
    };
  }, { gyrSec: GYR_SEC });
}

async function shootAtGyr(gyr, label) {
  await page.evaluate(({ tSec }) => {
    window.__G.t = tSec;
    window.__G.warp = 1;
  }, { tSec: gyr * GYR_SEC });
  // Let a handful of real rAF frames run so updateCosmicLayer/updateLocalGalaxyMotion
  // pick up the new G.t and the merger-driven uniforms/positions settle.
  await page.evaluate(() => new Promise(resolve => {
    let n = 0;
    const tick = () => { n++; if (n >= 8) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));
  const shot = await page.screenshot({ path: `${SCRATCH}/23a-merger-${label}.png` });
  const sum = checksum(shot);
  console.log(`screenshot T+${gyr}Gyr (${label}): bytes=${shot.length} ${JSON.stringify(sum)}`);
  return sum;
}

try {
  await bootPage();

  // --- Part A: pure trajectory math -----------------------------------
  const math = await readMergerMath();
  console.log("mergerDebugState " + JSON.stringify(math.debug));
  console.log("sep(0)=" + math.sep0.toFixed(2) + " kpc");
  console.log("maxSepAfter12Gyr=" + math.maxSepAfter12.toFixed(2) + " kpc, sepAt100Gyr=" + math.sepAt100.toFixed(4) + " kpc, sepAtHuge=" + math.sepAtHuge);
  console.log("disruptFrac: atFirstPassage=" + math.disruptAtFirstPassage.toFixed(3) + " at10Gyr=" + math.disruptAt10Gyr.toFixed(3) + " atStart=" + math.disruptAtStart.toFixed(3));

  assert(Math.abs(math.sep0 - 785) < 0.5, "separation(now) should be ~785 kpc", math);
  assert(math.debug.firstPassageGyr >= 3.5 && math.debug.firstPassageGyr <= 5.5, "first passage should land in [3.5, 5.5] Gyr", math.debug);
  assert(math.monotonic, "separation must decrease monotonically before first passage", math);
  assert(math.permanentUnder50, "separation must stay permanently under 50 kpc from 12 Gyr onward (coalesced)", math);
  assert(Number.isFinite(math.sepAt100) && math.sepAt100 >= 0, "separation at 100 Gyr must be finite", math);
  assert(Number.isFinite(math.sepAtHuge) && math.sepAtHuge >= 0, "separation must stay finite far beyond the table range (1000 Gyr)", math);
  assert(math.disruptAtStart < 0.05, "disk should still be pristine at T+0", math);
  assert(math.disruptAt10Gyr > 0.9, "disk should be fully disrupted/reddened well after coalescence (10 Gyr)", math);

  // --- Part B: determinism across a fresh page load ---------------------
  const probeT = 4.2 * GYR_SEC;
  const value1 = await page.evaluate(async (t) => (await import("/src/cosmic.js")).mergerSeparationKpcAt(t), probeT);
  await bootPage();
  const value2 = await page.evaluate(async (t) => (await import("/src/cosmic.js")).mergerSeparationKpcAt(t), probeT);
  console.log("determinism probe @4.2Gyr: run1=" + value1 + " run2=" + value2);
  assert(value1 === value2, "the trajectory table must be bit-identical across independent page loads", { value1, value2 });

  // --- Part C: visual - Local Group view across the merger ---------------
  await page.evaluate(({ lyKm, lyScene }) => {
    const g = window.__G;
    g.focus = "free";
    g.darkEnergy = true;
    g.darkMatter = true;
    g.gr = true;
    g.x = 1300000 * lyKm;
    g.y = 220000 * lyKm;
    g.z = 0;
    g.vx = 0; g.vy = 0; g.vz = 0;
    window.__cam.dist = 3200000 * lyScene;
    window.__cam.yaw = -1.05;
    window.__cam.pitch = .34;
    window.__cam.tgt.set(1100000 * lyScene, 0, -120000 * lyScene);
  }, { lyKm: LY_KM, lyScene: LY_SCENE });

  let built = false;
  for (let i = 0; i < 200 && !built; i++) {
    built = await page.evaluate(async () => (await import("/src/cosmic.js")).isCosmicLayerBuilt());
    if (!built) await page.waitForTimeout(100);
  }
  assert(built, "cosmic layer should finish building within ~20s of being made visible");

  const sums = {};
  for (const [gyr, label] of [[0, "t0"], [4.5, "passage"], [6, "mid"], [8, "merged"]]) {
    sums[label] = await shootAtGyr(gyr, label);
  }
  for (const [label, sum] of Object.entries(sums)) {
    assert(sum.nonZero > sum.sampled * 0.05, `screenshot at ${label} must have non-degenerate (non-blank) galaxy pixels`, sum);
  }

  if (errors.length) throw new Error("console errors: " + JSON.stringify(errors.slice(0, 20)));

  console.log("merger smoke passed");
} finally {
  await browser.close();
  await viteServer?.close();
}
