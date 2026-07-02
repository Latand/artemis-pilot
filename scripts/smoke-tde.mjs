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

    initBHHooks({
        toast() { },
        predict() { },
        cataclysm() { },
        disrupt(target) { return target === "sun" ? "Sun" : "Body"; },
        absorbed(target) { state.destroyBody(target); },
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

    const fastMu0 = resetHarness(1e6 * 31557600);
    bhAdvance(1, 1);
    assert(GS.length === 0, "fast-warp TDE should leave GS.length===0, got " + GS.length);
    assert(BH.mu[0] > fastMu0, "fast-warp TDE should increase BH.mu");

    const watchMu0 = resetHarness(600);
    bhAdvance(1, 1);
    assert(GS.length === 1, "watchable TDE should stage one phantom, got " + GS.length);
    G.warp = 1e6 * 31557600;
    bhAdvance(1, 2);
    assert(GS.length === 0, "watchable TDE should clear GS after fast resolution, got " + GS.length);
    assert(BH.mu[0] > watchMu0, "watchable TDE completion should increase BH.mu");
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
    globalThis.performance ??= { now: () => 0 };
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
