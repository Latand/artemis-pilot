import { createServer } from "vite";
import { existsSync } from "node:fs";

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
  url = `http://127.0.0.1:${address.port}/?bloom=0&hidehelp=1`;
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

try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("ap_introSeen", "1"); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__G && window.__cam);

  const dragResult = await runShipDragSmoke(page);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__G && window.__cam);

  const activeBrowseResult = await runActiveNeighborhoodSmoke(page);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__G && window.__cam);

  const stellarJumpGuard = await runStellarJumpGuardSmoke(page);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__G && window.__cam);

  const result = await page.evaluate(async () => {
    const { G } = await import("/src/state.js");
    const { STARS } = await import("/src/constants.js");
    const { eph, updEphem } = await import("/src/ephemeris.js");
    const { refreshActiveStars } = await import("/src/universe/activeStars.js");
    const { orbitInfo, shipDeepJump } = await import("/src/physics.js");
    const { AP, apStep } = await import("/src/autopilot.js");
    const proxima = STARS.find(st => st.name === "PROXIMA");
    G.t = 0;
    G.focus = "star:0";
    G.landed = null;
    G.dead = false;
    G.paused = false;
    G.heading = 0;
    G.pitch = 0;
    G.throttle = 1;
    updEphem(G.t);
    const orbitR = proxima.R * 45;
    const vc = Math.sqrt(proxima.mu / orbitR);
    G.x = proxima.x - eph.earthX + orbitR;
    G.y = proxima.y - eph.earthY;
    G.z = proxima.z;
    G.vx = -eph.earthVx;
    G.vy = -eph.earthVy + vc;
    G.vz = 0;
    refreshActiveStars(proxima.x + orbitR, proxima.y, proxima.z, G.focus);
    const oi = orbitInfo();
    AP.mode = "circ";
    AP.phase = "burn";
    AP.target = "star:0";
    const ap = apStep(1 / 60, 1, oi, { toast() { } });
    const jumpDt = 86400;
    const jumped = shipDeepJump(jumpDt);
    const postJump = orbitInfo();
    return {
      body: oi.body,
      domStar: oi.domStar,
      starName: oi.star?.name,
      starNear: oi.starNear?.name,
      starId: oi.starId,
      r: oi.r,
      relV: oi.relV,
      orbitR,
      vc,
      apMode: AP.mode,
      apReturned: ap !== null,
      jumped,
      jumpDt,
      postJumpBody: postJump.body,
      postJumpDomStar: postJump.domStar,
      postJumpR: postJump.r,
    };
  });

  function assert(ok, message) {
    if (!ok) throw new Error(message + " " + JSON.stringify(result));
  }

  assert(result.domStar && result.body === "PROXIMA" && result.starName === "PROXIMA", "orbitInfo should choose Proxima");
  assert(result.starNear === "PROXIMA" && result.starId === "PROXIMA", "orbitInfo should expose Proxima diagnostics");
  assert(Math.abs(result.r - result.orbitR) / result.orbitR < 1e-9, "orbitInfo should use Proxima-relative radius");
  assert(Math.abs(result.relV - result.vc) / result.vc < 1e-9, "orbitInfo should use Proxima-relative speed");
  assert(result.apMode === "off" && !result.apReturned, "apStep should accept an already circular stellar orbit");
  assert(result.jumped === result.jumpDt, "shipDeepJump should advance a dominant stellar orbit");
  assert(result.postJumpDomStar && result.postJumpBody === "PROXIMA", "shipDeepJump should stay bound to Proxima");
  assert(Math.abs(result.postJumpR - result.orbitR) / result.orbitR < 1e-6, "shipDeepJump should preserve circular stellar radius");
  assert(dragResult.cameraMoved && dragResult.shipStill && dragResult.releaseSpeed > 0 && dragResult.releaseSpeed <= 32.000001,
    "ship drag should require a deliberate hold and release under the speed cap");
  assert(activeBrowseResult.rows > 0 && activeBrowseResult.procFocus && activeBrowseResult.resolved && activeBrowseResult.travelStarted,
    "active-neighborhood browser should focus a procedural star and start travel");
  assert(stellarJumpGuard.crossingRejected && stellarJumpGuard.advanceBlocked && stellarJumpGuard.localAdvanceBlocked && stellarJumpGuard.curvedRejected && stellarJumpGuard.safeOrbitJumped,
    "stellar and local-body guards should block long unsafe jumps while keeping safe stellar orbits fast");
  if (errors.length) throw new Error("console errors: " + errors.join(" | "));

  console.log("stellar live smoke passed");
  console.log(JSON.stringify({ ...result, drag: dragResult, activeBrowse: activeBrowseResult, stellarJumpGuard }));
} finally {
  await browser.close();
  await viteServer?.close();
}

async function runStellarJumpGuardSmoke(page) {
  return await page.evaluate(async () => {
    const { G } = await import("/src/state.js");
    const { DARK_ENERGY, STARS } = await import("/src/constants.js");
    const { eph, updEphem } = await import("/src/ephemeris.js");
    const { refreshActiveStars } = await import("/src/universe/activeStars.js");
    const { advance, shipDeepJump } = await import("/src/physics.js");
    const spicaIndex = STARS.findIndex(st => st.name === "SPICA");
    const spica = STARS[spicaIndex];
    G.t = 0;
    G.focus = "star:" + spicaIndex;
    G.landed = null;
    G.dead = false;
    G.paused = false;
    G.darkEnergy = true;
    G.darkMatter = true;
    updEphem(G.t);
    const startR = spica.R * 200;
    G.x = spica.x - eph.earthX + startR;
    G.y = spica.y - eph.earthY;
    G.z = spica.z || 0;
    G.vx = -startR / 31557600 - eph.earthVx;
    G.vy = -eph.earthVy;
    G.vz = 0;
    refreshActiveStars(spica.x + startR, spica.y, spica.z || 0, G.focus);
    const crossing = shipDeepJump(31557600);
    G.t = 0;
    G.dead = false;
    G.x = spica.x - eph.earthX + startR;
    G.y = spica.y - eph.earthY;
    G.z = spica.z || 0;
    G.vx = -startR / 31557600 - eph.earthVx;
    G.vy = -eph.earthVy;
    G.vz = 0;
    refreshActiveStars(spica.x + startR, spica.y, spica.z || 0, G.focus);
    const advanceCrossing = advance(31557600, 0, 0, 0, 0);
    const advanceDead = G.dead;
    G.t = 0;
    G.dead = false;
    updEphem(G.t);
    const ra = spica.R * 2.2;
    const rp = spica.R * .8;
    const a = (ra + rp) * .5;
    const period = Math.PI * 2 * Math.sqrt(a * a * a / spica.mu);
    const vApo = Math.sqrt(spica.mu * (2 / ra - 1 / a));
    G.x = spica.x - eph.earthX + ra;
    G.y = spica.y - eph.earthY;
    G.z = spica.z || 0;
    G.vx = -eph.earthVx;
    G.vy = -eph.earthVy + vApo;
    G.vz = 0;
    refreshActiveStars(spica.x + ra, spica.y, spica.z || 0, G.focus);
    const curved = shipDeepJump(period);
    G.t = 0;
    G.dead = false;
    updEphem(G.t);
    G.x = spica.x - eph.earthX + startR;
    G.y = spica.y - eph.earthY;
    G.z = spica.z || 0;
    const vc = Math.sqrt(spica.mu / startR);
    G.vx = -eph.earthVx;
    G.vy = -eph.earthVy + vc;
    G.vz = 0;
    refreshActiveStars(spica.x + startR, spica.y, spica.z || 0, G.focus);
    const safe = shipDeepJump(86400);
    G.t = 0;
    G.dead = false;
    G.landed = null;
    G.focus = "free";
    G.darkEnergy = true;
    G.darkMatter = false;
    updEphem(G.t);
    const far = DARK_ENERGY.VISIBLE_FULL_KM * 2;
    G.x = far;
    G.y = 0;
    G.z = 0;
    G.vx = -2 * far / 31557600;
    G.vy = 0;
    G.vz = 0;
    refreshActiveStars(eph.earthX + G.x, eph.earthY + G.y, G.z, G.focus);
    const localAdvance = advance(31557600, 0, 0, 0, 0);
    const localAdvanceDead = G.dead;
    return {
      crossing,
      advanceCrossing,
      advanceDead,
      localAdvance,
      localAdvanceDead,
      curved,
      safe,
      crossingRejected: crossing === 0,
      advanceBlocked: advanceDead || advanceCrossing < 31557600,
      localAdvanceBlocked: localAdvanceDead || localAdvance < 31557600,
      curvedRejected: curved === 0,
      safeOrbitJumped: safe === 86400,
    };
  });
}

async function runActiveNeighborhoodSmoke(page) {
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyU");
  await page.keyboard.up("Shift");
  await page.waitForSelector(".hygActiveResult");
  const rows = await page.locator(".hygActiveResult").count();
  const proc = page.locator('.hygActiveResult[data-source="procedural"]').first();
  const procFocus = await proc.getAttribute("data-focus");
  await proc.click();
  await page.waitForTimeout(80);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyT");
  await page.keyboard.up("Shift");
  await page.waitForTimeout(80);
  const status = await page.evaluate(async () => {
    const { G } = await import("/src/state.js");
    const { activeStarForFocus } = await import("/src/universe/activeStars.js");
    const { AP } = await import("/src/autopilot.js");
    return {
      focus: G.focus,
      resolved: !!activeStarForFocus(G.focus),
      travelStarted: AP.mode !== "off",
    };
  });
  return {
    rows,
    procFocus: procFocus?.startsWith("proc:") && status.focus === procFocus,
    resolved: status.resolved,
    travelStarted: status.travelStarted,
  };
}

async function runShipDragSmoke(page) {
  await page.evaluate(() => { window.__G.paused = true; });
  const rect = await page.locator("#gl canvas").boundingBox();
  if (!rect) throw new Error("main canvas missing");
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const before = await page.evaluate(() => ({ x: window.__G.x, y: window.__G.y, z: window.__G.z, yaw: window.__cam.yaw }));
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(cx + 36, cy, { steps: 4 });
  await page.mouse.up({ button: "left" });
  await page.waitForTimeout(80);
  const afterCamera = await page.evaluate(() => ({ x: window.__G.x, y: window.__G.y, z: window.__G.z, yaw: window.__cam.yaw }));
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "left" });
  await page.waitForTimeout(260);
  await page.mouse.move(cx + 24, cy + 12, { steps: 8 });
  await page.mouse.up({ button: "left" });
  await page.waitForTimeout(80);
  const afterDrag = await page.evaluate(() => ({ vx: window.__G.vx, vy: window.__G.vy, vz: window.__G.vz }));
  return {
    cameraMoved: Math.abs(afterCamera.yaw - before.yaw) > .01,
    shipStill: Math.hypot(afterCamera.x - before.x, afterCamera.y - before.y, afterCamera.z - before.z) < 1e-6,
    releaseSpeed: Math.hypot(afterDrag.vx, afterDrag.vy, afterDrag.vz),
  };
}
