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

await runLifecycleGate();

console.log("tde smoke passed  tFbDays=" + (tFb / 86400).toFixed(3) + "  slope=" + slope.toFixed(5));

// Lifecycle gate (re-pinned for the encounter pipeline): a Sun on a beta = 3
// parabola about a 1e6 Msun hole is disrupted at its analytic pericentre with
// no phantom gravity source, feeds the hole only its bound half along
// M_acc(t), and the physical outcome is identical at a watchable and a deep
// warp and independent of the wall clock.
async function runLifecycleGate() {
    installDomStub();
    const state = await import("../src/state.js");
    const ephem = await import("../src/ephemeris.js");
    const physics = await import("../src/physics.js");
    const blackholes = await import("../src/blackholes.js");
    const enc = await import("../src/bhEncounters.js");
    const { accretedFraction } = await import("../src/tde.js");
    const { BH, EPHT, G, GS, WORLD, resetWorld, resetShip } = state;
    const { eph, updEphem, resetEphem } = ephem;
    const { BH_META, addBlackHole, clearBlackHoles, initBHHooks, activeTde } = blackholes;

    let lifecycleEvents = [];
    initBHHooks({
        toast() { },
        predict() { },
        event() { },
        cataclysm(target) {
            lifecycleEvents.push(["captured", target]);
            state.destroyBody(target);
        },
        disrupt(target) {
            lifecycleEvents.push(["disrupt", target]);
            state.destroyBody(target);
            return target === "sun" ? "Sun" : "Body";
        },
        absorbed(target) {
            lifecycleEvents.push(["absorbed", target]);
        },
    });

    function placeSunEncounter() {
        clearBlackHoles();
        resetWorld();
        resetEphem();
        resetShip();
        GS.length = 0;
        G.t = 0; EPHT.t = 0;
        G.dead = true;
        G.darkEnergy = false; G.darkMatter = false;
        updEphem();
        const rs = 2 * muBh / (C_LIGHT * C_LIGHT);
        const mu = muBh + muStar;
        const rp = rt / 3, d0 = 4 * rt, p = 2 * rp;
        const nu = -Math.acos(p / d0 - 1);
        const k = Math.sqrt(mu / p);
        const relX = d0 * Math.cos(nu), relY = d0 * Math.sin(nu);
        const relVx = -k * Math.sin(nu), relVy = k * (1 + Math.cos(nu));
        const idx = addBlackHole(eph.sunX - relX, eph.sunY - relY, rs, eph.sunVx - relVx, eph.sunVy - relVy, true);
        assert(idx === 0 && BH.n === 1 && BH_META.length === 1, "lifecycle harness should create one hole with its visual");
    }
    function runEncounter(warp, fps, wall) {
        lifecycleEvents = [];
        mockNowMs = wall.bornMs;
        placeSunEncounter();
        const frame = warp / fps;
        let sawApproach = false, gsMax = 0, floorAtSun = null;
        const tEnd = 30000;
        while (G.t < tEnd - 1e-9) {
            physics.advanceWorld(Math.min(frame, tEnd - G.t));
            mockNowMs += wall.msPerFrame;
            gsMax = Math.max(gsMax, GS.length);
            if (!WORLD.sunDestroyed && WORLD.tdeInProgress) sawApproach = true;
            if (WORLD.sunDestroyed && floorAtSun === null) floorAtSun = WORLD.irreversibleFloorT;
        }
        // a 1e6 Msun hole this deep in the Solar System also strips inner
        // planets on the way; the gate follows the Sun's own records
        const d = enc.TDES.find(x => x.target === "sun");
        assert(d, "the Sun should have a flare record");
        const accretedAtPeriPlusHalfDay = d.accreted;
        // fallback at a deep warp to 2 t_fb
        const tLate = d.t0 + 2 * d.tFb;
        while (G.t < tLate - 1e-6) physics.advanceWorld(Math.min(86400, tLate - G.t));
        const ev = BH.ev[0].find(e => e.tFb > 0 && e.t === d.t0);
        const flare = activeTde();
        return {
            regime: d.regime, t0: d.t0, tFb: d.tFb, beta: d.beta,
            sawApproach, gsMax, tdeInProgressAfter: WORLD.tdeInProgress,
            sunDestroyed: WORLD.sunDestroyed, floorAtSun, frame,
            accretedEarly: accretedAtPeriPlusHalfDay, accretedLate: d.accreted,
            profileEvent: ev ? { t: ev.t, dmu: ev.dmu, tFb: ev.tFb } : null,
            flare: flare ? { target: flare.targetName, regime: flare.regime, L: flare.LnowW, LEdd: flare.LEddW } : null,
            sunHooks: lifecycleEvents.filter(e => e[1] === "sun").map(e => [...e]),
            sunFlares: enc.TDES.filter(x => x.target === "sun").length,
        };
    }

    const watch = runEncounter(600, 60, { bornMs: 100, msPerFrame: 16 });
    const deep = runEncounter(86400, 60, { bornMs: 100, msPerFrame: 16 });
    const watchSlowWall = runEncounter(600, 60, { bornMs: 10000, msPerFrame: 2500 });
    for (const [label, r] of [["warp 600", watch], ["warp 86400", deep]]) {
        assert(r.regime === "full", label + ": Sun + 1e6 Msun at beta 3 should be a full disruption, got " + r.regime);
        assert(r.gsMax === 0, label + ": the disruption must not stage phantom gravity sources, saw " + r.gsMax);
        assert(r.sunDestroyed, label + ": the Sun should be removed at pericentre");
        assert(r.floorAtSun >= r.t0 && r.floorAtSun <= r.t0 + r.frame, label + ": the irreversible floor should publish at the pericentre time");
        assert(!r.tdeInProgressAfter, label + ": no disruption should remain in progress afterwards");
        assert(r.accretedEarly === 0, label + ": nothing may be accreted before t_fb, got " + r.accretedEarly);
        assert(relErr(r.accretedLate, .5 * muStar * accretedFraction(2 * r.tFb, r.tFb)) <= 1e-9,
            label + ": the hole should gain exactly M_acc(t) of the bound half, got " + (r.accretedLate / muStar) + " Msun");
        assert(r.profileEvent && relErr(r.profileEvent.dmu, .5 * muStar) <= 1e-12 && r.profileEvent.tFb === r.tFb,
            label + ": the causal mass event should carry the bound half with the fallback profile");
        assert(r.flare && r.flare.L > 0 && r.flare.L <= r.flare.LEdd,
            label + ": a flare should be live and Eddington-capped");
        assert(JSON.stringify(r.sunHooks) === JSON.stringify([["disrupt", "sun"]]),
            label + ": exactly one disruption hook call for the Sun, got " + JSON.stringify(r.sunHooks));
        assert(r.sunFlares === 1, label + ": exactly one Sun flare record");
    }
    assert(watch.sawApproach, "the approach should raise tdeInProgress before pericentre at a watchable warp");
    assert(Math.abs(watch.t0 - deep.t0) < 1, "pericentre time should not depend on warp: " + watch.t0 + " vs " + deep.t0);
    assert(relErr(watch.beta, deep.beta) < 1e-3, "beta should not depend on warp: " + watch.beta + " vs " + deep.beta);
    assert(relErr(watch.accretedLate, deep.accretedLate) < 1e-6, "accreted mass should not depend on warp");
    assert(JSON.stringify(watch) === JSON.stringify(watchSlowWall),
        "the physical lifecycle should be independent of the performance.now schedule");
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
