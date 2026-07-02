// WP22 acceptance set: side-by-side river appearance near Earth, near the
// Sun, at 50 AU, and at interstellar distance — activity should concentrate
// at masses, far field should be calm (the user's two regression screenshots
// showed the opposite: long straight far-field streaks, weak near-mass).
import puppeteer from "puppeteer-core";
const EXE = process.env.CHROME || "/usr/bin/google-chrome-stable";
const URL = process.env.ARTEMIS_URL || "http://localhost:5173/";
const OUT_DIR = process.env.OUT_DIR || ".";
const AU_KM = 149597870.7, K = 0.001, LY_KM = 9460730472580.8, LY_SCENE = LY_KM * K;
const wait = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({
    executablePath: EXE, headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--window-size=1280,800"],
    protocolTimeout: 180000,
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.evaluateOnNewDocument(() => localStorage.setItem("ap_helpSeen", "1"));
const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await wait(2500);
await page.evaluate(() => document.getElementById("introEnter")?.click());
await wait(4000);
const hideHud = () => {
    const cv = document.querySelector("canvas");
    document.querySelectorAll("body *").forEach(el => { if (el !== cv && !el.contains(cv)) el.style.setProperty("visibility", "hidden", "important"); });
};
const shoot = name => page.screenshot({ path: `${OUT_DIR}/${name}` });

// 1. near Earth: default ship start, close-in.
await page.evaluate(() => { window.__G.focus = "ship"; if (window.__cam) { window.__cam.dist = 12; window.__cam.distTarget = null; } });
await wait(1000);
await page.evaluate(hideHud);
await shoot("river-scale-near-earth.png");

// 2. near the Sun: focus on it directly (engine follows sunPos every frame).
// SUN_RADIUS*K ~= 696 scene units, so this is a few solar radii out.
await page.evaluate(() => { window.__G.focus = "sun"; if (window.__cam) { window.__cam.dist = 2800; window.__cam.distTarget = null; } });
await wait(1200);
await page.evaluate(hideHud);
await shoot("river-scale-near-sun.png");

// 3. 50 AU: free-flight camera far from the Sun/Earth, well past Neptune (~30 AU).
await page.evaluate((auScene) => {
    window.__G.focus = "free";
    if (window.__cam) { window.__cam.dist = auScene * 50 * 1.3; window.__cam.distTarget = null; window.__cam.tgt.set(0, 0, 0); }
}, AU_KM * K);
await wait(1200);
await page.evaluate(hideHud);
await shoot("river-scale-50au.png");

// 4. interstellar: right at the start of river.js's own zoom-fade window
// (smooth01(0.05, 0.9, cam.dist/LY_SCENE)) so the river is still faintly live
// for comparison — well beyond it the river is intentionally invisible
// (pre-existing zoom-fade behavior, unrelated to this redesign).
await page.evaluate((lyScene) => {
    window.__G.focus = "free";
    if (window.__cam) { window.__cam.dist = lyScene * 0.06; window.__cam.distTarget = null; window.__cam.tgt.set(0, 0, 0); }
}, LY_SCENE);
await wait(1200);
await page.evaluate(hideHud);
await shoot("river-scale-interstellar.png");

const diag = await page.evaluate(() => ({
    riverEnabled: window.__river?.enabled,
    drawCount: window.__river?.drawCount,
    radius: window.__river?.radius,
}));
console.log("DIAG " + JSON.stringify(diag));
console.log("ERRORS " + errors.length + " " + JSON.stringify(errors.slice(0, 20)));
await browser.close();
