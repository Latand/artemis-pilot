// Deep-time clock and prediction smoke.
//
// float64 seconds space 16 s apart at 1e17 s (~3 Gyr), 4096 s at 2^64 s and
// 131072 s at 1e21 s. Before the compensated clock, a frame advance below half
// an ulp left G.t (and EPHT.t) frozen while the bodies moved, EPHT.t drifted
// off G.t because it was summed separately, and the close-approach refiners
// looped forever once ulp(t) exceeded their fixed 3600 s tolerance -- the idle
// prediction scheduler hung the whole app at ~2^64 s.
//
// A. clock primitives: many sub-ulp advances average to the requested dt.
// B. the live flight path (physics.advance) at 1e17, 2^64 and 1e21 s: G.t
//    advances by the requested time on average and EPHT.t === G.t after
//    every step (one clock); a ghost stamped with G.t is tested against the
//    same instant.
// C. predictions at the same epochs (child process with a hard timeout, so
//    a regression fails instead of hanging): nextConjunction, 200-year
//    closeApproaches, predictedLead and the events.js idle scheduler all
//    finish, inside their iteration caps, with sane future rows.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EPOCHS = [
    { label: "1e17 s", T: 1e17, dt: 1 },       // 60x warp at 60 fps
    { label: "2^64 s", T: 2 ** 64, dt: 60 },   // 1 h/s at 60 fps
    { label: "1e21 s", T: 1e21, dt: 3600 },    // 1 d/s at 24 fps
];

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
    if (cond) { pass++; console.log("  PASS  " + label + (detail ? "   " + detail : "")); }
    else { fail++; console.log("  FAIL  " + label + (detail ? "   " + detail : "")); }
};

function ulpOf(x) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, Math.abs(x));
    const e = (dv.getUint32(0) >>> 20) & 0x7ff;
    return Math.pow(2, e - 1075);
}

if (process.argv.includes("--predictions")) {
    await predictionsChild();
    process.exit(0);
}

installDomStub();
const state = await import("../src/state.js");
const ephem = await import("../src/ephemeris.js");
const physics = await import("../src/physics.js");
const constants = await import("../src/constants.js");
const { G, EPHT, GS, BH, advanceSimTime, setSimTime, simTimeLo, addGhost, gsPull } = state;
const { eph } = ephem;
const { AU_KM, MU_S, MU_M } = constants;

console.log("\nA. compensated clock primitives");
for (const { label, T, dt } of EPOCHS) {
    const u = ulpOf(T);
    setSimTime(T);
    let naive = T;
    const n = 20000;
    for (let i = 0; i < n; i++) { advanceSimTime(dt); naive += dt; }
    const advanced = (G.t - T) + simTimeLo();
    ok(Math.abs(advanced - n * dt) <= 1e-6 * n * dt, label + ": " + n + " x " + dt + " s advances hi+lo by the exact total",
        "got " + advanced + " want " + n * dt + " (ulp " + u + ")");
    ok(Math.abs((G.t - T) / n - dt) <= u / n, label + ": G.t alone advances by dt on average (within one ulp over the run)",
        "mean " + ((G.t - T) / n).toFixed(4) + " s");
    ok(dt < u / 2 ? naive === T : true, label + ": (control) naive float accumulation stalls at this magnitude",
        "naive advanced " + (naive - T));
}

console.log("\nB. live flight path: advance() at deep time, one clock");
function parkShipHelio(au) {
    const sx = eph.sunX, sy = eph.sunY, sz = eph.sunZ;
    const d = Math.hypot(sx, sy), ux = -sx / d, uy = -sy / d;
    const r = au * AU_KM, v = Math.sqrt(MU_S / r);
    G.x = sx + ux * r; G.y = sy + uy * r; G.z = sz;
    G.vx = eph.sunVx - uy * v; G.vy = eph.sunVy + ux * v; G.vz = eph.sunVz;
}
for (const { label, T, dt } of EPOCHS) {
    state.resetWorld(); ephem.resetEphem(); state.resetShip();
    GS.length = 0; BH.n = 0; G.darkEnergy = false; G.darkMatter = false;
    parkShipHelio(20);
    setSimTime(T);
    const n = 1500;
    let requested = 0, delivered = 0, clockMismatch = 0, nan = false;
    for (let i = 0; i < n; i++) {
        delivered += physics.advance(dt, 0, 0, 0, 0);
        requested += dt;
        if (EPHT.t !== G.t) clockMismatch++;
        if (!Number.isFinite(G.x + G.y + G.z + eph.earthX + eph.sunX)) nan = true;
    }
    const u = ulpOf(T);
    const moved = (G.t - T) + simTimeLo();
    ok(!G.dead && !nan, label + ": ship survives and every state stays finite", G.deadReason);
    ok(Math.abs(delivered - requested) <= 1e-6 * requested, label + ": physics reports full delivery", delivered + " / " + requested);
    ok(Math.abs(moved - requested) <= 1e-6 * requested + 1e-9, label + ": the clock advanced by the delivered time (hi+lo)",
        moved + " vs " + requested);
    ok(Math.abs((G.t - T) - requested) <= u, label + ": G.t advanced by the requested time to within one ulp",
        "G.t moved " + (G.t - T) + " s for " + requested + " s requested (ulp " + u + ")");
    ok(clockMismatch === 0, label + ": EPHT.t === G.t after every step", clockMismatch + " mismatches");
    const rSun = Math.hypot(G.x - eph.sunX, G.y - eph.sunY, G.z - eph.sunZ) / AU_KM;
    ok(rSun > 19 && rSun < 21, label + ": the parked ship is still on its 20 AU orbit", rSun.toFixed(3) + " AU");
    // one clock for light fronts: a ghost stamped now has a zero-radius front now
    GS.length = 0;
    addGhost(0, 0, 0, 0, 0, 0, MU_M, 1737, G.t);
    const pull = [0, 0, 0];
    gsPull(1e6, 0, 0, EPHT.t, pull);
    ok(GS[0].t === EPHT.t && pull[0] < 0, label + ": a ghost stamped with G.t still pulls at EPHT.t (front radius 0)",
        "front " + ((EPHT.t - GS[0].t) * 299792.458) + " km");
    GS.length = 0;
}

console.log("\nC. predictions at deep time (child process, 90 s timeout)");
{
    const self = fileURLToPath(import.meta.url);
    const child = spawnSync(process.execPath, [self, "--predictions"], { encoding: "utf8", timeout: 90000 });
    const lines = (child.stdout || "").split("\n").filter(line => line.startsWith("{"));
    ok(child.status === 0 && !child.signal, "prediction child finished in time", child.signal ? "killed by " + child.signal + " (hang)" : "rc=" + child.status + (child.stderr ? " " + child.stderr.slice(0, 400) : ""));
    for (const line of lines) {
        const r = JSON.parse(line);
        ok(r.nowOk, r.label + ": nextConjunction returns a future conjunction within 3 yr", r.nowDetail);
        ok(r.rowsOk, r.label + ": 200-yr close approaches are future, finite, sorted and unique", r.rowsDetail);
        ok(r.leadOk, r.label + ": predictedLead returns a positive lead and a real hold warp", r.leadDetail);
        ok(r.schedulerOk, r.label + ": the idle prediction scheduler publishes a result within its callback cap", r.schedulerDetail);
        ok(r.capsOk, r.label + ": refinement loops ended on tolerance, under their iteration caps", r.capsDetail);
    }
    ok(lines.length === EPOCHS.length, "all epochs reported", lines.length + " / " + EPOCHS.length);
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
console.log("deep clock smoke passed");
process.exit(0);

async function predictionsChild() {
    installDomStub();
    const ET = await import("../src/universe/eventTimeline.js");
    const events = await import("../src/events.js");
    const SEC_YEAR = 31557600;
    for (const { label, T } of EPOCHS) {
        ET.REFINE_STATS.maxIterations = 0;
        ET.REFINE_STATS.maxLeadSteps = 0;
        ET.REFINE_STATS.capped = 0;
        const now = ET.nextConjunction({ fromSec: T });
        const nowDt = now ? (now.tSimSec - T) / SEC_YEAR : NaN;
        const rows = ET.closeApproaches({ fromSec: T, spanSec: 200 * SEC_YEAR });
        const sorted = rows.every((row, i) => i === 0 || rows[i - 1].tSimSec <= row.tSimSec);
        const future = rows.every(row => Number.isFinite(row.tSimSec) && row.tSimSec >= T && row.tSimSec <= T + 200 * SEC_YEAR + 4 * ulpOf(T));
        const unique = new Set(rows.map(row => row.id)).size === rows.length;
        const lead = rows.length ? ET.predictedLead(rows[0]) : null;
        // the real scheduler, driven with a manual idle queue
        const queue = [];
        let published = null, callbacks = 0;
        const scheduler = events.createPredictionScheduler({
            readState: () => ({ fromSec: T, perturbed: false, epochMs: 1000 }),
            scheduleIdle: cb => queue.push(cb),
            createScan: ET.createCloseApproachScan,
            findNow: ET.nextConjunction,
            publish: result => { published = result; },
            nowMs: () => 0,
        });
        scheduler.update({});
        const deadline = { didTimeout: true, timeRemaining: () => 0 };
        while (queue.length && callbacks < 200000) { callbacks++; queue.shift()(deadline); }
        const schedulerRows = published?.rows || [];
        console.log(JSON.stringify({
            label,
            nowOk: !!now && nowDt > 0 && nowDt < 3,
            nowDetail: now ? now.label + " (+" + nowDt.toFixed(3) + " yr)" : "none",
            rowsOk: rows.length > 1000 && sorted && future && unique,
            rowsDetail: rows.length + " rows, sorted=" + sorted + " future=" + future + " unique=" + unique,
            leadOk: !!lead && lead.leadSec > 0 && Number.isFinite(lead.leadSec) && lead.holdWarp > 0,
            leadDetail: JSON.stringify(lead),
            schedulerOk: queue.length === 0 && schedulerRows.length > 1 && schedulerRows.every(row => row.tSimSec >= T),
            schedulerDetail: callbacks + " idle callbacks, " + schedulerRows.length + " rows published",
            capsOk: ET.REFINE_STATS.capped === 0 && ET.REFINE_STATS.maxIterations <= ET.REFINE_MAX_ITERATIONS &&
                ET.REFINE_STATS.maxLeadSteps <= ET.LEAD_SCAN_MAX_STEPS,
            capsDetail: "max refine iterations " + ET.REFINE_STATS.maxIterations + " / cap " + ET.REFINE_MAX_ITERATIONS +
                ", max lead steps " + ET.REFINE_STATS.maxLeadSteps + " / cap " + ET.LEAD_SCAN_MAX_STEPS + ", capped " + ET.REFINE_STATS.capped,
        }));
        scheduler.dispose();
    }
}

function installDomStub() {
    globalThis.window = globalThis;
    globalThis.addEventListener ??= () => { };
    globalThis.removeEventListener ??= () => { };
    globalThis.matchMedia ??= () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    globalThis.ResizeObserver ??= class { observe() { } unobserve() { } disconnect() { } };
    globalThis.location = { search: "" };
    globalThis.requestAnimationFrame ??= () => 0;
    globalThis.cancelAnimationFrame ??= () => { };
    const element = () => ({
        style: {}, dataset: {},
        classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
        appendChild() { }, removeChild() { }, append() { }, remove() { },
        addEventListener() { }, removeEventListener() { },
        setAttribute() { }, getAttribute() { return null; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 1, height: 1 }; },
    });
    const canvas2d = () => new Proxy({ canvas: { width: 1, height: 1 } }, {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (prop === "createImageData") return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
            if (prop === "createRadialGradient" || prop === "createLinearGradient") return () => ({ addColorStop() { } });
            if (prop === "measureText") return text => ({ width: String(text).length * 8 });
            return () => { };
        },
        set() { return true; },
    });
    const webgl = () => {
        const constants = {
            VERSION: 0x1f02, SHADING_LANGUAGE_VERSION: 0x8b8c, VENDOR: 0x1f00, RENDERER: 0x1f01,
            ALIASED_LINE_WIDTH_RANGE: 0x846e, ALIASED_POINT_SIZE_RANGE: 0x846d,
        };
        const getParameter = p => p === constants.VERSION ? "WebGL 2.0" :
            p === constants.SHADING_LANGUAGE_VERSION ? "WebGL GLSL ES 3.00" :
                p === constants.VENDOR || p === constants.RENDERER ? "stub" :
                    p === constants.ALIASED_LINE_WIDTH_RANGE || p === constants.ALIASED_POINT_SIZE_RANGE ? new Float32Array([1, 1]) : 16;
        return new Proxy({
            canvas: { width: 1, height: 1 },
            getExtension() { return null; },
            getParameter,
            getShaderPrecisionFormat() { return { precision: 23, rangeMin: 127, rangeMax: 127 }; },
        }, {
            get(target, prop) {
                if (prop in target) return target[prop];
                if (prop in constants) return constants[prop];
                if (prop === "drawingBufferWidth" || prop === "drawingBufferHeight") return 1;
                if (typeof prop === "string" && /^[A-Z0-9_]+$/.test(prop)) return 0;
                return () => { };
            },
        });
    };
    const canvas = () => ({ ...element(), width: 1, height: 1, getContext(type) { return type === "2d" ? canvas2d() : webgl(); } });
    globalThis.document = {
        body: element(), documentElement: element(),
        createElement(tag) { return tag === "canvas" ? canvas() : element(); },
        createElementNS(_ns, tag) { return tag === "canvas" ? canvas() : element(); },
        getElementById() { return element(); },
        querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() { }, removeEventListener() { },
    };
}
