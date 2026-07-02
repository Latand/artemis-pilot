// WP12: save-format v10 round-trip. Runs against a real page (localStorage,
// toast/banner DOM) rather than a bare-Node import, since src/saves.js pulls
// in src/achievements.js and src/hud.js, both of which touch document at
// module load — the same reason scripts/smoke-stellar-live.mjs drives a
// headless browser instead of importing modules directly.
import { createServer } from "vite";
import { existsSync } from "node:fs";

const SLOT = "artemis.quicksave.v1"; // mirrors the private SLOT constant in src/saves.js
const DEFAULT_SEED = 0x9e3779b9 >>> 0;
const TEST_SEED = 305419896 >>> 0; // arbitrary, != DEFAULT_SEED and != the poison value below
const TEST_SEED2 = 123456789; // distinct seed used by the forward-compat check

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

let pwModule;
try {
  pwModule = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
} catch (err) {
  console.error("Playwright is required. Install it locally or set PLAYWRIGHT_MODULE to its module entrypoint.");
  throw err;
}
const pw = pwModule.default ?? pwModule;
const executableCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  process.env.CHROME_EXECUTABLE_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);
const executablePath = executableCandidates.find(p => existsSync(p));
const browser = await pw.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
page.on("pageerror", err => errors.push(err.message));

function assert(ok, message, ctx) {
  if (!ok) throw new Error(message + (ctx !== undefined ? " " + JSON.stringify(ctx) : ""));
}

try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("ap_introSeen", "1"); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__G && window.__cam);

  const saved = await runSaveV10(page);
  assert(saved.ok, "saveState should succeed", saved);
  assert(saved.blob.v === 10, "quicksave should be schema v10", saved.blob.v);
  assert(saved.blob.galaxySeed === TEST_SEED, "quicksave should persist the live procedural galaxy seed", saved);
  assert(saved.blob.procStars.includes(saved.pickedId), "quicksave should persist the pinned procedural star id", saved);
  assert(saved.blob.focusProcedural?.id === saved.pickedId, "quicksave should persist the procedural focus id", saved);
  assert(saved.blob.log?.entries?.some(e => e.kind === "notable" && e.id === "smoke-discovery"),
    "quicksave should persist the discovery log", saved.blob.log);
  assert(saved.blob.epochMs === null || Number.isFinite(saved.blob.epochMs),
    "quicksave epochMs should be null (epoch.js not landed) or a finite ms timestamp (epoch.js landed)", saved.blob.epochMs);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__G && window.__cam);
  const loaded = await runLoadAfterSaveV10(page);
  assert(loaded.ok, "loadState should succeed restoring a v10 save", loaded);
  assert(loaded.seed === TEST_SEED, "loadState should restore the saved galaxy seed before touching procedural stars", loaded);
  assert(loaded.focus === saved.focus, "loadState should restore the procedural focus", { loaded, saved });
  assert(loaded.pinned.includes(saved.pickedId), "loadState should re-pin the saved procedural star", loaded);
  assert(JSON.stringify(loaded.log) === JSON.stringify(saved.blob.log),
    "loadState should restore the discovery log", { loaded: loaded.log, saved: saved.blob.log });

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__G && window.__cam);
  const v8 = await runV8Fallback(page);
  assert(v8.threw === null, "restoring a synthetic v8 blob should not throw", v8);
  assert(v8.ok, "restoring a synthetic v8 blob should report success", v8);
  assert(v8.seedAfter === DEFAULT_SEED, "a v8 (pre-seed) save should fall back to the default galaxy seed", v8);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__G && window.__cam);
  const v9fwd = await runV9ForwardCompat(page);
  assert(v9fwd.threw === null, "restoring a v9 blob with unknown/future fields should not throw", v9fwd);
  assert(v9fwd.ok, "restoring a v9 blob with unknown/future fields should report success", v9fwd);
  assert(v9fwd.seedAfter === TEST_SEED2, "forward-compat restore should still apply the recognized fields", v9fwd);
  assert(v9fwd.log.entries.length === 0, "restoring a v9 blob should default the discovery log to empty", v9fwd.log);

  if (errors.length) throw new Error("console errors: " + errors.join(" | "));

  console.log("saves smoke passed");
  console.log(JSON.stringify({ saved, loaded, v8, v9fwd }));
} finally {
  await browser.close();
  await viteServer?.close();
}

// Sets a known seed, pins a procedural star deterministic to that seed, and
// quicksaves. Returns the raw persisted blob so the caller can assert on the
// on-disk v10 shape directly.
async function runSaveV10(page) {
  return await page.evaluate(async (testSeed) => {
    const { G } = await import("/src/state.js");
    const { setSeed, getSeed, localStarsInCell } = await import("/src/universe/galaxy.js");
    const { pinProceduralStarById, proceduralFocusValue } = await import("/src/universe/activeStars.js");
    const { clearLog, noteNotable } = await import("/src/discoveryLog.js");
    const { saveState } = await import("/src/saves.js");

    setSeed(testSeed);
    clearLog();
    noteNotable("smoke-discovery", "Smoke Discovery");
    const cellStars = localStarsInCell(0, 0, 0); // uses the current (testSeed) global seed
    if (!cellStars.length) throw new Error("test cell 0,0,0 produced no procedural stars for seed " + testSeed);
    const pick = cellStars[0];
    pinProceduralStarById(pick.id);
    G.focus = proceduralFocusValue(pick.id);
    G.t = 12345.5;

    const ok = await saveState();
    const blob = JSON.parse(localStorage.getItem("artemis.quicksave.v1"));
    return { ok, seedUsed: getSeed(), pickedId: pick.id, focus: G.focus, blob };
  }, TEST_SEED);
}

// Fresh page (module state reset by reload), poisons the live seed, then
// loads the save from runSaveV10 to prove setSeed(saved) actually restores it
// (rather than the seed merely matching by coincidence).
async function runLoadAfterSaveV10(page) {
  return await page.evaluate(async () => {
    const { G } = await import("/src/state.js");
    const { setSeed, getSeed } = await import("/src/universe/galaxy.js");
    const { serializePinnedProceduralStars } = await import("/src/universe/activeStars.js");
    const { serializeLog } = await import("/src/discoveryLog.js");
    const { loadState } = await import("/src/saves.js");
    setSeed(0xdeadbeef);
    const ok = await loadState();
    return { ok, seed: getSeed(), focus: G.focus, pinned: serializePinnedProceduralStars(), log: serializeLog() };
  });
}

// Builds a save blob shaped exactly like a genuine pre-v9 save (no
// galaxySeed/epochMs/z/vz keys at all) and confirms it restores cleanly.
async function runV8Fallback(page) {
  return await page.evaluate(async () => {
    const { G } = await import("/src/state.js");
    const { snapshotEphem } = await import("/src/ephemeris.js");
    const { setSeed, getSeed } = await import("/src/universe/galaxy.js");
    const { loadState } = await import("/src/saves.js");

    const ephSt = snapshotEphem();
    const v8 = {
      v: 8,
      g: { ...G },
      focusCatalog: null, focusHygCatalog: null, focusProcedural: null,
      procStars: [], hygStars: [],
      world: { earth: false, moon: false, sun: false, pl: [] },
      eph: {
        x: Array.from(ephSt.x), y: Array.from(ephSt.y),
        vx: Array.from(ephSt.vx), vy: Array.from(ephSt.vy),
        earthX: ephSt.earthX, earthY: ephSt.earthY,
        earthVx: ephSt.earthVx, earthVy: ephSt.earthVy,
      },
      bh: [], bhEv: [], gs: [], bhSizeIdx: 0,
    };
    localStorage.setItem("artemis.quicksave.v1", JSON.stringify(v8));
    setSeed(0xdeadbeef); // poison so the default fallback below can't be a coincidence
    let ok = false, threw = null;
    try { ok = await loadState(); } catch (e) { threw = e.message; }
    return { ok, threw, seedAfter: getSeed() };
  });
}

// Saves a real blob, stamps it back to v9, then adds fields no shipped v9 writes
// (an arbitrary future top-level/nested key, plus WP13's z/vz ephemeris
// fields) to prove a NEWER save restores on THIS code without throwing.
async function runV9ForwardCompat(page) {
  return await page.evaluate(async (testSeed2) => {
    const { G } = await import("/src/state.js");
    const { setSeed, getSeed } = await import("/src/universe/galaxy.js");
    const { serializeLog } = await import("/src/discoveryLog.js");
    const { saveState, loadState } = await import("/src/saves.js");

    setSeed(testSeed2);
    G.t = 999;
    await saveState();
    const blob = JSON.parse(localStorage.getItem("artemis.quicksave.v1"));

    blob.v = 9;
    delete blob.log;
    blob.wpFutureFeature = { anything: true };
    blob.g.someFutureGField = 42;
    blob.eph.someFutureArray = [1, 2, 3];
    const n = blob.eph.x.length;
    blob.eph.z = Array.from({ length: n }, (_, i) => i * 0.5);
    blob.eph.vz = Array.from({ length: n }, (_, i) => i * 0.01);
    blob.eph.earthZ = 7.5;
    blob.eph.earthVz = 0.002;
    localStorage.setItem("artemis.quicksave.v1", JSON.stringify(blob));

    setSeed(0xdeadbeef);
    let ok = false, threw = null;
    try { ok = await loadState(); } catch (e) { threw = e.message; }
    return { ok, threw, seedAfter: getSeed(), gFuture: G.someFutureGField, log: serializeLog() };
  }, TEST_SEED2);
}
