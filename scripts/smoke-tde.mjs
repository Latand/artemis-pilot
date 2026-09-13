import {
    L_EDD_PER_MSUN,
    boundFraction,
    circularizationKm,
    fallbackTimeSec,
    iscoKm,
    tdeLuminosityW,
    tidalRadiusKm,
} from "../src/tde.js";
import { C_LIGHT, MU_S, R_SUN } from "../src/constants.js";

let mockNowMs = 0;

function assert(ok, msg) {
    if (!ok) {
        console.error("FAIL: " + msg);
        process.exit(1);
    }
}

function relErr(a, b) {
    return Math.abs(a - b) / Math.max(1e-300, Math.abs(b));
}

function fitSlope(xs, ys) {
    const lx = xs.map(Math.log);
    const ly = ys.map(Math.log);
    const mx = lx.reduce((a, b) => a + b, 0) / lx.length;
    const my = ly.reduce((a, b) => a + b, 0) / ly.length;
    let num = 0, den = 0;
    for (let i = 0; i < lx.length; i++) {
        num += (lx[i] - mx) * (ly[i] - my);
        den += (lx[i] - mx) * (lx[i] - mx);
    }
    return num / den;
}

const muStar = MU_S;
const muBh = MU_S * 1e6;
const rt = tidalRadiusKm(R_SUN, muBh, muStar);
assert(relErr(rt, R_SUN * Math.cbrt(muBh / muStar)) <= 1e-9, "tidalRadiusKm should match R*cbrt(muBH/muBody)");
assert(tidalRadiusKm(R_SUN, muBh * 2, muStar) > rt, "tidalRadiusKm should increase with BH mass");

const tFb = fallbackTimeSec(R_SUN, muBh, muStar);
const tFb4 = fallbackTimeSec(R_SUN, muBh * 4, muStar);
assert(Math.abs(tFb4 / tFb - 2) <= 1e-6, "fallbackTimeSec should scale as sqrt(M_BH), got factor " + (tFb4 / tFb));
const days41 = 41 * 86400;
assert(relErr(tFb, days41) <= .2, "fallbackTimeSec day-form should be about 41 days, got " + (tFb / 86400) + " days");

assert(boundFraction() === 0.5, "boundFraction should return exactly 0.5");

const tailTfb = 86400;
const tailMBhMsun = 1e9;
const tailMStarKg = 1e20;
const tailFactors = [2, 4, 8, 16, 32];
const tailTimes = tailFactors.map(f => tailTfb * f);
const tailLum = tailTimes.map(t => tdeLuminosityW(t, tailTfb, tailMStarKg, tailMBhMsun));
const tailLEdd = L_EDD_PER_MSUN * tailMBhMsun;
assert(tailLum.every(l => l > 0 && l < tailLEdd), "light-curve samples should be positive and uncapped before fitting");
const slope = fitSlope(tailTimes, tailLum);
assert(Math.abs(slope - (-5 / 3)) <= .03, "light-curve decay slope should be -5/3 +/- 0.03, got " + slope);

assert(iscoKm(12345) === 3 * 12345, "iscoKm should equal 3*rs exactly");
assert(relErr(circularizationKm(R_SUN, muBh, muStar), 2 * rt) <= 1e-9, "circularizationKm should equal 2*tidalRadiusKm");

await runWarpSafetyGate();

console.log("tde smoke passed  tFbDays=" + (tFb / 86400).toFixed(3) + "  slope=" + slope.toFixed(5));

async function runWarpSafetyGate() {
    installDomStub();
    const state = await import("../src/state.js");
    const ephem = await import("../src/ephemeris.js");
    const blackholes = await import("../src/blackholes.js");
    const { BH, EPHT, G, GS, WORLD, resetWorld } = state;
    const { eph, updEphem } = ephem;
    const { BH_META, addBlackHole, bhAdvance, clearBlackHoles, initBHHooks } = blackholes;

    let lifecycleEvents = [];
    initBHHooks({
        toast() { },
        predict() { },
        cataclysm() { },
        disrupt(target) {
            lifecycleEvents.push(["disrupt", target, EPHT.t]);
            state.destroyBody(target);
            return target === "sun" ? "Sun" : "Body";
        },
        absorbed(target) {
            lifecycleEvents.push(["absorbed", target, EPHT.t]);
            if (!state.isBodyDestroyed(target)) state.destroyBody(target);
        },
    });

    function resetHarness(warp) {
        clearBlackHoles();
        resetWorld();
        GS.length = 0;
        BH_META.length = 0;
        G.t = 0;
        G.warp = warp;
        EPHT.t = 0;
        updEphem(0);
        WORLD.sunDestroyed = false;
        const rs = 2 * MU_S * 1e6 / (C_LIGHT * C_LIGHT);
        const idx = addBlackHole(eph.sunX, eph.sunY, rs, eph.sunVx, eph.sunVy, true);
        assert(idx === 0 && BH.n === 1, "black-hole harness should create one hole");
        return BH.mu[0];
    }
    function syncSimTime(t) {
        G.t = t;
        EPHT.t = t;
    }

    const fastMu0 = resetHarness(1e6 * 31557600);
    syncSimTime(1);
    bhAdvance(1, 1);
    assert(GS.length === 0, "fast-warp TDE should leave GS.length===0, got " + GS.length);
    assert(BH.mu[0] > fastMu0, "fast-warp TDE should increase BH.mu");
    assert(WORLD.sunDestroyed, "fast-warp TDE should destroy the Sun through the absorbed hook");

    const watchMu0 = resetHarness(600);
    syncSimTime(1);
    bhAdvance(1, 1);
    assert(GS.length === 1, "watchable TDE should stage one phantom, got " + GS.length);
    G.warp = 1e6 * 31557600;
    syncSimTime(2);
    bhAdvance(1, 2);
    assert(GS.length === 0, "watchable TDE should clear GS after fast resolution, got " + GS.length);
    assert(BH.mu[0] > watchMu0, "watchable TDE completion should increase BH.mu");

    const shortWall = runWatchableLifecycle({ bornMs: 100, completedMs: 1100 });
    const longWall = runWatchableLifecycle({ bornMs: 10000, completedMs: 31000 });
    assert(shortWall.dtSequence.length === longWall.dtSequence.length &&
        shortWall.dtSequence.every((dt, i) => dt === longWall.dtSequence[i]),
    "watchable TDE runs should use the same simulated dt sequence");
    assert(shortWall.wallElapsedMs < 5000,
        "short-wall TDE should keep real elapsed time below five seconds, got " + shortWall.wallElapsedMs);
    assert(longWall.wallElapsedMs - shortWall.wallElapsedMs >= 10000,
        "mocked performance.now schedules should be materially different");
    assert(shortWall.visualAtEnd < .96,
        "short-wall TDE presentation progress should stay below .96, got " + shortWall.visualAtEnd);
    assert(shortWall.physical.completionSimT === shortWall.expectedCompletionSimT,
        "watchable TDE should complete after its simulated duration with wall elapsed below five seconds");
    assert(JSON.stringify(shortWall.physical) === JSON.stringify(longWall.physical),
        "watchable TDE physical lifecycle should be independent of performance.now schedule");
    assert(shortWall.physical.bhMu > shortWall.initialBhMu,
        "simulated completion should increase BH mass");
    assert(relErr(shortWall.physical.bhMu, shortWall.initialBhMu + MU_S) <= 1e-12,
        "simulated completion should add the disrupted body's mass to the BH");
    assert(relErr(shortWall.physical.eventMassGain, MU_S) <= 1e-12,
        "BH mass-gain event should equal the disrupted body's mass");
    assert(shortWall.physical.massEvents.length === 1 &&
        shortWall.physical.massEvents[0].t === shortWall.expectedCompletionSimT,
    "BH mass-gain event should publish at simulated completion time");
    assert(shortWall.physical.sunDestroyed,
        "simulated completion should destroy the disrupted body");
    assert(shortWall.physical.irreversibleFloorT === shortWall.expectedCompletionSimT,
        "irreversible floor should publish at simulated completion time");
    assert(shortWall.physical.disruptCount === 0 && !shortWall.physical.tdeInProgress,
        "simulated completion should remove the disruption lifecycle");
    assert(shortWall.physical.tdeMeta.active && shortWall.physical.tdeMeta.targetName === "Sun",
        "simulated completion should activate Sun TDE metadata");
    assert(shortWall.physical.gravitySources.length === 1 &&
        shortWall.physical.gravitySources[0].phase === "ghost" &&
        shortWall.physical.gravitySources[0].t === shortWall.expectedCompletionSimT &&
        shortWall.physical.gravitySources[0].t0 === shortWall.expectedCompletionSimT,
    "simulated completion should hand the disruption phantom off to a causal ghost");
    assert(JSON.stringify(shortWall.physical.lifecycleEvents) === JSON.stringify([
        ["disrupt", "sun", 1],
        ["absorbed", "sun", shortWall.expectedCompletionSimT],
    ]), "watchable TDE should emit disruption then absorption at deterministic simulated times");

    function runWatchableLifecycle(wallSchedule) {
        lifecycleEvents = [];
        mockNowMs = wallSchedule.bornMs;
        const initialBhMu = resetHarness(600);
        syncSimTime(1);
        bhAdvance(1, 1);
        const disruption = window.__BH_DISRUPT[0];
        assert(disruption, "watchable lifecycle should stage one disruption");
        assert(WORLD.sunDestroyed,
            "watchable disruption should destroy the Sun during the staged phase");
        assert(WORLD.irreversibleFloorT === 1,
            "watchable disruption should publish its irreversible floor at simulation time 1");
        assert(GS.length === 1,
            "watchable lifecycle should stage one disruption phantom, got " + GS.length);
        assert(!lifecycleEvents.some(e => e[0] === "absorbed"),
            "watchable staged phase should have no absorption event");
        const completionDt = disruption.duration + 1;
        const expectedCompletionSimT = 1 + completionDt;
        mockNowMs = wallSchedule.completedMs;
        syncSimTime(expectedCompletionSimT);
        bhAdvance(completionDt, expectedCompletionSimT);
        const massEvents = BH.ev[0].slice(1).map(e => ({
            x: e.x, y: e.y, z: e.z, t: e.t, dmu: e.dmu,
        }));
        return {
            dtSequence: [1, completionDt],
            expectedCompletionSimT,
            initialBhMu,
            wallElapsedMs: wallSchedule.completedMs - wallSchedule.bornMs,
            visualAtEnd: disruption.visual,
            physical: {
                completionSimT: lifecycleEvents.find(e => e[0] === "absorbed")?.[2] ?? null,
                bhMu: BH.mu[0],
                eventMassGain: massEvents.reduce((sum, e) => sum + e.dmu, 0),
                massEvents,
                sunDestroyed: WORLD.sunDestroyed,
                irreversibleFloorT: WORLD.irreversibleFloorT,
                disruptCount: window.__BH_DISRUPT.length,
                tdeInProgress: WORLD.tdeInProgress,
                tdeMeta: {
                    active: BH_META[0].tde.active,
                    targetName: BH_META[0].tde.targetName,
                    t0Sim: BH_META[0].tde.t0Sim,
                    tFbSec: BH_META[0].tde.tFbSec,
                    LpeakW: BH_META[0].tde.LpeakW,
                    LnowW: BH_META[0].tde.LnowW,
                    LEddW: BH_META[0].tde.LEddW,
                    mStarKg: BH_META[0].tde.mStarKg,
                    mBhMsun: BH_META[0].tde.mBhMsun,
                    rCirc: BH_META[0].tde.rCirc,
                },
                gravitySources: GS.map(s => ({
                    phase: Number.isFinite(s.t) ? "ghost" : "phantom",
                    x: s.x, y: s.y, z: s.z,
                    vx: s.vx, vy: s.vy, vz: s.vz,
                    mu: s.mu, R: s.R, t0: s.t0, t: s.t,
                })),
                lifecycleEvents: lifecycleEvents.map(e => [...e]),
            },
        };
    }
}

function installDomStub() {
    globalThis.window = globalThis;
    globalThis.addEventListener ??= () => { };
    globalThis.removeEventListener ??= () => { };
    globalThis.matchMedia ??= () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    globalThis.ResizeObserver ??= class {
        observe() { }
        unobserve() { }
        disconnect() { }
    };
    globalThis.location = { search: "" };
    Object.defineProperty(globalThis, "performance", {
        configurable: true,
        value: { now: () => mockNowMs },
    });
    globalThis.requestAnimationFrame ??= () => 0;
    globalThis.cancelAnimationFrame ??= () => { };
    const element = () => ({
        style: {},
        classList: { add() { }, remove() { }, toggle() { } },
        appendChild() { },
        removeChild() { },
        addEventListener() { },
        removeEventListener() { },
        setAttribute() { },
        getAttribute() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 1, height: 1 }; },
    });
    const canvas = () => ({
        ...element(),
        width: 1,
        height: 1,
        getContext(type) {
            if (type === "2d") return canvas2d();
            return webgl();
        },
    });
    globalThis.document = {
        body: element(),
        createElement(tag) { return tag === "canvas" ? canvas() : element(); },
        createElementNS(_ns, tag) { return tag === "canvas" ? canvas() : element(); },
        getElementById() { return element(); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() { },
        removeEventListener() { },
    };
}

function canvas2d() {
    return {
        canvas: { width: 1, height: 1 },
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        lineCap: "butt",
        lineJoin: "miter",
        globalCompositeOperation: "source-over",
        createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
        putImageData() { },
        createRadialGradient() { return { addColorStop() { } }; },
        createLinearGradient() { return { addColorStop() { } }; },
        fillRect() { },
        clearRect() { },
        beginPath() { },
        arc() { },
        stroke() { },
        fill() { },
        moveTo() { },
        lineTo() { },
        closePath() { },
        save() { },
        restore() { },
        translate() { },
        rotate() { },
        scale() { },
        drawImage() { },
        measureText(text) { return { width: String(text).length * 8 }; },
        fillText() { },
        strokeText() { },
    };
}

function webgl() {
    const fn = () => { };
    const constants = {
        VERSION: 0x1f02,
        SHADING_LANGUAGE_VERSION: 0x8b8c,
        VENDOR: 0x1f00,
        RENDERER: 0x1f01,
        MAX_TEXTURE_IMAGE_UNITS: 0x8872,
        MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
        MAX_TEXTURE_SIZE: 0x0d33,
        MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
        MAX_VERTEX_ATTRIBS: 0x8869,
        MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
        MAX_VARYING_VECTORS: 0x8dfc,
        MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
        MAX_SAMPLES: 0x8d57,
        ALIASED_LINE_WIDTH_RANGE: 0x846e,
        ALIASED_POINT_SIZE_RANGE: 0x846d,
    };
    function getParameter(p) {
        if (p === constants.VERSION) return "WebGL 2.0";
        if (p === constants.SHADING_LANGUAGE_VERSION) return "WebGL GLSL ES 3.00";
        if (p === constants.VENDOR || p === constants.RENDERER) return "stub";
        if (p === constants.ALIASED_LINE_WIDTH_RANGE || p === constants.ALIASED_POINT_SIZE_RANGE) return new Float32Array([1, 1]);
        return 16;
    }
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
            return fn;
        },
    });
}
