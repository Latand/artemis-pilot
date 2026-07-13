import { existsSync } from "node:fs";
import { createServer } from "vite";

const failures = [];
const pageErrors = [];
let browser = null;
let viteServer = null;

function check(condition, message, context) {
  if (condition) return;
  failures.push(message + (context === undefined ? "" : ` ${JSON.stringify(context)}`));
}

function watchErrors(page, label) {
  page.on("console", message => {
    if (message.type() === "error") pageErrors.push(`${label} console: ${message.text()}`);
  });
  page.on("pageerror", error => pageErrors.push(`${label} pageerror: ${error.message}`));
}

async function dockGeometry(page) {
  return page.evaluate(() => {
    const dock = document.getElementById("timeDock");
    const hud = document.getElementById("hudBot");
    const scale = document.getElementById("cosmicScale");
    scale.style.setProperty("transition", "none", "important");
    scale.style.setProperty("opacity", "1", "important");
    const rect = element => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const d = rect(dock);
    const h = rect(hud);
    const s = rect(scale);
    const overlapWidth = Math.max(0, Math.min(d.right, h.right) - Math.max(d.left, h.left));
    const overlapHeight = Math.max(0, Math.min(d.bottom, h.bottom) - Math.max(d.top, h.top));
    const scaleOverlapWidth = Math.max(0, Math.min(d.right, s.right) - Math.max(d.left, s.left));
    const scaleOverlapHeight = Math.max(0, Math.min(d.bottom, s.bottom) - Math.max(d.top, s.top));
    return {
      dock: d,
      hud: h,
      scale: s,
      dockDisplay: getComputedStyle(dock).display,
      hudDisplay: getComputedStyle(hud).display,
      scaleDisplay: getComputedStyle(scale).display,
      scaleOpacity: getComputedStyle(scale).opacity,
      overlap: overlapWidth * overlapHeight,
      scaleOverlap: scaleOverlapWidth * scaleOverlapHeight,
    };
  });
}

async function openReadyPage(context, label, url) {
  const page = await context.newPage();
  watchErrors(page, label);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__G && document.body.classList.contains("mode-observe"));
  return page;
}

try {
  viteServer = await createServer({
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await viteServer.listen();
  const address = viteServer.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite server did not expose a TCP port");
  const url = `http://127.0.0.1:${address.port}/?bloom=0&hidehelp=1&tier1=0`;

  const playwrightModule = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const playwright = playwrightModule.default ?? playwrightModule;
  const executableCandidates = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    process.env.CHROME_EXECUTABLE_PATH,
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean);
  const executablePath = executableCandidates.find(candidate => existsSync(candidate));
  browser = await playwright.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });

  const storageState = {
    cookies: [],
    origins: [{
      origin: `http://127.0.0.1:${address.port}`,
      localStorage: [
        { name: "ap_introSeen", value: "1" },
        { name: "ap_helpSeen", value: "1" },
        { name: "ap_uiMode", value: "observe" },
      ],
    }],
  };

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    storageState,
  });
  const mobile = await openReadyPage(mobileContext, "mobile", url);
  const mobileState = await mobile.evaluate(() => {
    const visible = id => {
      const element = document.getElementById(id);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    return {
      dockDisplay: getComputedStyle(document.getElementById("timeDock")).display,
      leftVisible: visible("mLeft"),
      throttleVisible: visible("mThrottle"),
    };
  });
  check(mobileState.dockDisplay === "none", "mobile hides the desktop Time Dock", mobileState);
  check(mobileState.leftVisible, "mobile attitude controls remain accessible", mobileState);
  check(mobileState.throttleVisible, "mobile throttle remains accessible", mobileState);
  await mobileContext.close();

  const intermediateContext = await browser.newContext({
    viewport: { width: 768, height: 1024 },
    deviceScaleFactor: 1,
    storageState,
  });
  const intermediate = await openReadyPage(intermediateContext, "intermediate", url);
  const intermediateHits = await intermediate.evaluate(() => {
    const hitCenter = id => {
      const target = document.getElementById(id);
      const rect = target.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { id, hit: hit?.id || hit?.className || hit?.tagName, ownsHit: hit === target || target.contains(hit) };
    };
    return [hitCenter("navBtn"), hitCenter("simsBtn")];
  });
  check(intermediateHits.every(result => result.ownsHit),
    "768x1024 fine-pointer layout preserves navigator and simulation center hit targets", intermediateHits);
  await intermediateContext.close();

  const coarseTabletContext = await browser.newContext({
    viewport: { width: 820, height: 900 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    storageState,
  });
  const coarseTablet = await openReadyPage(coarseTabletContext, "coarse-tablet", url);
  const coarseDockDisplay = await coarseTablet.locator("#timeDock").evaluate(element => getComputedStyle(element).display);
  check(coarseDockDisplay === "none", "coarse layouts above 760px hide the desktop Time Dock", { coarseDockDisplay });
  await coarseTabletContext.close();

  const desktopContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    storageState,
  });
  const page = await openReadyPage(desktopContext, "desktop", url);

  const observe = await dockGeometry(page);
  check(observe.dockDisplay !== "none" && observe.dock.width > 0, "desktop OBSERVE shows the Time Dock", observe);
  check(observe.scaleDisplay !== "none" && observe.scaleOpacity === "1" && observe.scaleOverlap === 0,
    "OBSERVE keeps the visible cosmic scale clear of the Time Dock", observe);

  await page.evaluate(async () => (await import("/src/uiMode.js")).setUiMode("pilot", false));
  await page.waitForFunction(() => window.__G.uiMode === "pilot");
  const pilot = await dockGeometry(page);
  check(pilot.dockDisplay !== "none", "PILOT shows the Time Dock", pilot);
  check(pilot.hudDisplay !== "none" && pilot.overlap === 0, "PILOT keeps the Time Dock clear of the flight strip", pilot);
  check(pilot.scaleDisplay !== "none" && pilot.scaleOpacity === "1" && pilot.scaleOverlap === 0,
    "PILOT keeps the visible cosmic scale clear of the Time Dock", pilot);

  await page.evaluate(async () => (await import("/src/uiMode.js")).setUiMode("direct", false));
  await page.waitForFunction(() => window.__G.uiMode === "direct");
  const direct = await dockGeometry(page);
  check(direct.dockDisplay !== "none", "DIRECT shows the Time Dock", direct);
  check(direct.hudDisplay !== "none" && direct.overlap === 0, "DIRECT keeps the Time Dock clear of the flight strip", direct);
  check(direct.scaleDisplay !== "none" && direct.scaleOpacity === "1" && direct.scaleOverlap === 0,
    "DIRECT keeps the visible cosmic scale clear of the Time Dock", direct);

  await page.evaluate(async () => (await import("/src/uiMode.js")).setXrPresenting(true));
  await page.waitForFunction(() => document.body.classList.contains("mode-xr"));
  const xr = await dockGeometry(page);
  check(xr.dockDisplay !== "none", "simulated XR shows the Time Dock", xr);
  check(xr.hudDisplay !== "none" && xr.overlap === 0, "simulated XR keeps the Time Dock clear of the flight strip", xr);
  await page.evaluate(async () => (await import("/src/uiMode.js")).setXrPresenting(false));

  await page.evaluate(() => window.__cinematic.setCleanRender(true));
  await page.waitForFunction(() => document.body.classList.contains("mode-clean"));
  const cleanDisplay = await page.locator("#timeDock").evaluate(element => getComputedStyle(element).display);
  check(cleanDisplay === "none", "Director clean render hides the Time Dock", { cleanDisplay });
  await page.evaluate(() => window.__cinematic.setCleanRender(false));
  await page.waitForFunction(() => !document.body.classList.contains("mode-clean"));

  await page.evaluate(() => { window.__G.cabin = true; });
  await page.waitForFunction(() => document.body.classList.contains("mode-cabin"));
  const cabinDisplay = await page.locator("#timeDock").evaluate(element => getComputedStyle(element).display);
  check(cabinDisplay === "none", "cabin mode hides the Time Dock", { cabinDisplay });
  await page.evaluate(() => { window.__G.cabin = false; });
  await page.waitForFunction(() => !document.body.classList.contains("mode-cabin"));

  const railContract = await page.evaluate(async () => {
    const { WARPS, SEC_YEAR } = await import("/src/constants.js");
    const { setWarp } = await import("/src/timeCtl.js");
    const rail = document.getElementById("tdRail");
    const originalQuery = rail.querySelectorAll.bind(rail);
    let perFrameQueries = 0;
    rail.querySelectorAll = (...args) => {
      perFrameQueries++;
      return originalQuery(...args);
    };
    setWarp(500 * SEC_YEAR, "dock-smoke-log-space");
    for (let i = 0; i < 8; i++) await new Promise(resolve => requestAnimationFrame(resolve));
    rail.querySelectorAll = originalQuery;
    return {
      activeLabel: rail.querySelector('.tdTick[aria-current="true"]')?.getAttribute("aria-label"),
      columnTemplate: rail.style.gridTemplateColumns,
      tickCount: rail.children.length,
      warpCount: WARPS.length,
      perFrameQueries,
    };
  });
  check(railContract.activeLabel === "1 kyr/s", "nearest warp rung uses log-space distance", railContract);
  check(railContract.tickCount === railContract.warpCount &&
    railContract.columnTemplate.startsWith(`repeat(${railContract.warpCount},`),
    "warp rail derives its grid from the live ladder length", railContract);
  check(railContract.perFrameQueries === 0, "per-frame Time Dock updates reuse the cached tick array", railContract);

  const renderCadence = await page.evaluate(async () => {
    const { setWarp } = await import("/src/timeCtl.js");
    setWarp(3600, "dock-smoke-cadence");
    for (let i = 0; i < 8; i++) await new Promise(resolve => requestAnimationFrame(resolve));
    const dock = document.getElementById("timeDock");
    const date = document.getElementById("tdDate");
    let dateMutations = 0;
    let attributeMutations = 0;
    const dateObserver = new MutationObserver(records => { dateMutations += records.length; });
    const attributeObserver = new MutationObserver(records => { attributeMutations += records.length; });
    dateObserver.observe(date, { childList: true, characterData: true, subtree: true });
    attributeObserver.observe(dock, { attributes: true, subtree: true });
    for (let i = 0; i < 24; i++) await new Promise(resolve => requestAnimationFrame(resolve));
    dateObserver.disconnect();
    attributeObserver.disconnect();
    return { dateMutations, attributeMutations, frames: 24 };
  });
  check(renderCadence.dateMutations >= 2 && renderCadence.dateMutations <= 8,
    "Time Dock text renders on the HUD cadence", renderCadence);
  check(renderCadence.attributeMutations === 0,
    "stable Time Dock classes and attributes produce zero redundant mutations", renderCadence);

  const rungEdges = await page.evaluate(async () => {
    const { WARP_MAX } = await import("/src/constants.js");
    const { setWarp } = await import("/src/timeCtl.js");
    const activeLabel = async warp => {
      setWarp(warp, "dock-smoke-rung-edge");
      for (let i = 0; i < 8; i++) await new Promise(resolve => requestAnimationFrame(resolve));
      return document.querySelector('.tdTick[aria-current="true"]')?.getAttribute("aria-label");
    };
    const midpoint = Math.sqrt(600 * 3600);
    return {
      zero: await activeLabel(0),
      reverse: await activeLabel(-600),
      minimum: await activeLabel(-WARP_MAX),
      maximum: await activeLabel(WARP_MAX),
      belowMidpoint: await activeLabel(midpoint * 0.99),
      aboveMidpoint: await activeLabel(midpoint * 1.01),
    };
  });
  check(rungEdges.zero === "0.01×", "zero warp selects the smallest rung", rungEdges);
  check(rungEdges.reverse === "10 min/s", "reverse warp selects by signed magnitude", rungEdges);
  check(rungEdges.minimum === "1 Byr/s" && rungEdges.maximum === "1 Byr/s",
    "warp extrema select the outer rung", rungEdges);
  check(rungEdges.belowMidpoint === "10 min/s" && rungEdges.aboveMidpoint === "1 h/s",
    "log-space selection changes sides at the geometric midpoint", rungEdges);

  const oneHour = page.locator('.tdTick[aria-label="1 h/s"]');
  await oneHour.click();
  await page.waitForFunction(() => window.__G.warp === 3600);
  await page.waitForFunction(() => document.querySelector('.tdTick[aria-label="1 h/s"]')?.getAttribute("aria-current") === "true");
  check(await oneHour.getAttribute("aria-current") === "true", "selected warp exposes aria-current");

  await page.locator("#tdRev").click();
  await page.waitForFunction(() => window.__G.warp === -3600);
  await page.waitForFunction(() => document.getElementById("tdRev")?.getAttribute("aria-pressed") === "true");
  check(await page.locator("#tdRev").getAttribute("aria-pressed") === "true", "REV exposes its pressed state");

  const finiteFloorExpected = await page.evaluate(async () => {
    const { G, WORLD } = await import("/src/state.js");
    const { getEpochMs } = await import("/src/epoch.js");
    const { fmtCivilDate } = await import("/src/format.js");
    const { setWarp } = await import("/src/timeCtl.js");
    WORLD.irreversibleFloorT = G.t;
    const expected = "REVERSE BLOCKED — cannot rewind past " + fmtCivilDate(getEpochMs(), WORLD.irreversibleFloorT);
    setWarp(-3600, "dock-smoke");
    requestAnimationFrame(() => setWarp(3600, "dock-smoke-release"));
    return expected;
  });
  let statusVisible = true;
  try {
    await page.waitForFunction(() => {
      const status = document.getElementById("tdBlocked");
      return !status.hidden && status.textContent.includes("REVERSE BLOCKED");
    }, null, { timeout: 3000 });
  } catch {
    statusVisible = false;
  }
  check(statusVisible, "a one-frame reverse-block pulse reaches the live status");
  const finiteFloorText = await page.locator("#tdBlocked").textContent();
  check(finiteFloorText === finiteFloorExpected, "finite-floor blocking uses the exact civil-date copy",
    { actual: finiteFloorText, expected: finiteFloorExpected });
  const statusA11y = await page.locator("#tdBlocked").evaluate(element => ({
    role: element.getAttribute("role"),
    live: element.getAttribute("aria-live"),
  }));
  check(statusA11y.role === "status" && statusA11y.live === "polite", "reverse-block plate is a polite live status", statusA11y);
  const latchTiming = await page.evaluate(async () => {
    const { G, WORLD } = await import("/src/state.js");
    const { renderTimeDock, sampleTimeDock } = await import("/src/timeDock.js");
    const waitUntil = target => new Promise(resolve => setTimeout(resolve, Math.max(0, target - performance.now())));
    WORLD.irreversibleFloorT = G.t;
    WORLD.reverseBlocked = true;
    const latchStartedAt = performance.now();
    sampleTimeDock();
    WORLD.reverseBlocked = false;
    WORLD.irreversibleFloorT = -Infinity;
    renderTimeDock();

    await waitUntil(latchStartedAt + 1000);
    sampleTimeDock();
    renderTimeDock();
    const visibleAtOneSecond = !document.getElementById("tdBlocked").hidden;
    const visibleElapsedMs = performance.now() - latchStartedAt;

    await waitUntil(latchStartedAt + 1700);
    sampleTimeDock();
    renderTimeDock();
    const hiddenAtOnePointSevenSeconds = document.getElementById("tdBlocked").hidden;
    const hiddenElapsedMs = performance.now() - latchStartedAt;
    return { visibleAtOneSecond, hiddenAtOnePointSevenSeconds, visibleElapsedMs, hiddenElapsedMs };
  });
  check(latchTiming.visibleAtOneSecond && latchTiming.hiddenAtOnePointSevenSeconds,
    "the reverse-block plate brackets the 1.5s latch expiry", latchTiming);

  await page.locator("#tdPause").click();
  await page.waitForFunction(() => window.__G.paused === true);
  await page.waitForFunction(() => document.getElementById("tdPause")?.getAttribute("aria-pressed") === "true");
  check(await page.locator("#tdPause").getAttribute("aria-pressed") === "true", "pause exposes its pressed state");

  await page.evaluate(async () => {
    const { GS, WORLD } = await import("/src/state.js");
    GS.push({ smokeTimeDock: true });
    WORLD.reverseBlocked = true;
  });
  await page.waitForFunction(() => {
    const status = document.getElementById("tdBlocked");
    return !status.hidden && status.textContent.includes("matter in flight");
  });
  const matterText = await page.locator("#tdBlocked").textContent();
  check(matterText.includes("debris and gravity ghosts"), "matter-in-flight blocking uses the GS/TDE wording", { matterText });
  const blockedGeometry = await dockGeometry(page);
  check(blockedGeometry.scaleOverlap === 0, "cosmic-scale clearance expands with the blocked plate", blockedGeometry);
  await page.evaluate(async () => {
    const { GS, WORLD } = await import("/src/state.js");
    const { renderTimeDock, sampleTimeDock } = await import("/src/timeDock.js");
    const index = GS.findIndex(item => item?.smokeTimeDock);
    if (index >= 0) GS.splice(index, 1);
    WORLD.reverseBlocked = false;
    await new Promise(resolve => setTimeout(resolve, 1700));
    sampleTimeDock();
    renderTimeDock();
  });
  check(await page.locator("#tdBlocked").evaluate(element => element.hidden),
    "the cleared GS blocking latch expires before the independent TDE probe");

  await page.evaluate(async () => {
    const { GS, WORLD } = await import("/src/state.js");
    if (GS.length !== 0) throw new Error("TDE cause probe requires an empty GS array");
    WORLD.tdeInProgress = true;
    WORLD.reverseBlocked = true;
  });
  await page.waitForFunction(() => {
    const status = document.getElementById("tdBlocked");
    return !status.hidden && status.textContent.includes("matter in flight");
  });
  const tdeMatterText = await page.locator("#tdBlocked").textContent();
  check(tdeMatterText.includes("debris and gravity ghosts"),
    "TDE alone selects the matter-in-flight blocking copy", { tdeMatterText });
  await page.evaluate(async () => {
    const { WORLD } = await import("/src/state.js");
    WORLD.reverseBlocked = false;
    WORLD.tdeInProgress = false;
  });

  const cancelLabel = await page.locator("#tdCancel").getAttribute("aria-label");
  check(cancelLabel === "Cancel time jump", "the jump cancel button has an explicit accessible name", { cancelLabel });
  const jumpBeforeCancel = await page.evaluate(async () => {
    const { jumpActive, startTimeJump } = await import("/src/timeCtl.js");
    startTimeJump({ holdWarp: 60 });
    document.getElementById("tdJump").hidden = false;
    return jumpActive();
  });
  await page.locator("#tdCancel").click();
  const jumpAfterCancel = await page.evaluate(async () => (await import("/src/timeCtl.js")).jumpActive());
  check(jumpBeforeCancel && !jumpAfterCancel, "the real CANCEL handler clears active jump state",
    { jumpBeforeCancel, jumpAfterCancel });
  for (let i = 0; i < 8; i++) await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const jumpGeometry = await dockGeometry(page);
  check(jumpGeometry.scaleOverlap === 0, "cosmic-scale clearance expands with the jump plate", jumpGeometry);
  await page.evaluate(() => { document.getElementById("tdJump").hidden = true; });

  await desktopContext.close();

  const freshContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    storageState,
  });
  const fresh = await openReadyPage(freshContext, "fresh", url);
  const freshStart = await fresh.evaluate(() => ({
    warp: window.__G.warp,
    blockedHidden: document.getElementById("tdBlocked").hidden,
  }));
  check(freshStart.warp === 60 && freshStart.blockedHidden,
    "fresh load starts at warp 60 with the reverse-block plate hidden", freshStart);
  await fresh.locator("#tdRev").click();
  await fresh.waitForFunction(() => window.__G.warp === -60);
  const freshReverse = await fresh.evaluate(() => ({
    warp: window.__G.warp,
    blockedHidden: document.getElementById("tdBlocked").hidden,
  }));
  check(freshReverse.warp === -60 && freshReverse.blockedHidden,
    "fresh-load REV changes warp 60 to -60 and keeps the plate hidden", freshReverse);
  await freshContext.close();

  check(pageErrors.length === 0, "browser sessions have no page errors", pageErrors);

  if (failures.length) throw new Error(`smoke-time-dock FAILED:\n- ${failures.join("\n- ")}`);
  console.log("smoke-time-dock passed");
} finally {
  await browser?.close();
  await viteServer?.close();
}
