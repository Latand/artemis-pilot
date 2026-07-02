function assert(ok, msg) {
    if (!ok) {
        console.error("FAIL: " + msg);
        process.exit(1);
    }
}

function relErr(a, b) {
    return Math.abs(a - b) / Math.max(1, Math.abs(b));
}

function installDomStub() {
    globalThis.window = globalThis;
    globalThis.addEventListener ??= () => { };
    globalThis.removeEventListener ??= () => { };
    globalThis.matchMedia ??= () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    globalThis.ResizeObserver ??= class { observe() { } unobserve() { } disconnect() { } };
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
        MAX_CUBE_MAP_TEXTURE_SIZE: 0x8513,
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

installDomStub();

const constants = await import("../src/constants.js");
const ephem = await import("../src/ephemeris.js");
const state = await import("../src/state.js");
const physics = await import("../src/physics.js");
const epoch = await import("../src/epoch.js");

const { WARPS, WARP_MAX, warpStepDown, warpStepUp } = constants;
const { resetEphem, advanceEphem, eph } = ephem;
const { G, BH, GS, WORLD, EPHT, resetShip, resetWorld, destroyBody } = state;
const { advance } = physics;
const { civilDateAt, J2000_MS } = epoch;

function resetHarness() {
    resetWorld();
    resetEphem();
    resetShip();
    GS.length = 0;
    BH.n = 0;
    G.dead = false;
    G.landed = null;
    G.paused = false;
}

function bodyVector() {
    const out = [
        eph.moonX, eph.moonY, eph.moonZ, eph.moonVx, eph.moonVy, eph.moonVz,
        eph.sunX, eph.sunY, eph.sunZ, eph.sunVx, eph.sunVy, eph.sunVz,
    ];
    for (let i = 0; i < constants.PL.length; i++) {
        out.push(eph.plX[i], eph.plY[i], eph.plZ[i], eph.plVx[i], eph.plVy[i], eph.plVz[i]);
    }
    return out;
}

function assertBodyClose(before, after, tol, label) {
    assert(before.length === after.length, label + " vector length changed");
    for (let i = 0; i < before.length; i++) {
        const err = relErr(after[i], before[i]);
        assert(err <= tol, label + " component " + i + " relErr " + err + " > " + tol);
    }
}

{
    const ladder = [...WARPS.slice().reverse().map(w => -w), ...WARPS];
    for (let i = 1; i < ladder.length - 1; i++) {
        const w = ladder[i];
        assert(warpStepUp(warpStepDown(w)) === w, "warp ladder inverse failed at " + w);
    }
    assert(warpStepDown(0.01) === -0.01, "warp down should cross 0.01 to -0.01");
    assert(warpStepUp(-0.01) === 0.01, "warp up should cross -0.01 to 0.01");
    assert(warpStepDown(-WARP_MAX) === -WARP_MAX, "warp down should clamp at WARP_MIN");
    console.log("(a) reverse warp ladder OK");
}

{
    resetHarness();
    const before = bodyVector();
    advanceEphem(7200);
    advanceEphem(-7200);
    assertBodyClose(before, bodyVector(), 1e-6, "stepped round-trip");
    console.log("(b) stepped ephemeris round-trip OK");
}

{
    resetHarness();
    const before = bodyVector();
    const dt = 200 * 86400;
    advanceEphem(dt);
    advanceEphem(-dt);
    assertBodyClose(before, bodyVector(), 1e-7, "Kepler round-trip");
    console.log("(c) Kepler-jump round-trip OK");
}

{
    const d0 = civilDateAt(J2000_MS, 0);
    const dm = civilDateAt(J2000_MS, -86400);
    const key = d => d.y * 10000 + d.m * 100 + d.d;
    assert(dm.mode === "date" && d0.mode === "date" && key(dm) < key(d0), "civil date should count down for negative elapsed seconds");
    console.log("(d) civil date countdown OK");
}

{
    resetHarness();
    G.t = 1000;
    EPHT.t = 1000;
    destroyBody(0);
    G.t = 2000;
    EPHT.t = 2000;
    const advanced = advance(-5000, 0, 0, 0, 0);
    assert(Math.abs(G.t - 1000) <= 1e-6, "reverse should freeze at irreversible floor, got G.t=" + G.t);
    assert(Math.abs(advanced + 1000) <= 1e-6, "advance should report the clamped negative step, got " + advanced);
    assert(WORLD.plDestroyed[0] === 1, "destroyed planet should stay destroyed after blocked reverse");
    assert(WORLD.reverseBlocked, "reverseBlocked flag should be set at the floor");
    console.log("(e) irreversible floor guard OK");
}

{
    resetHarness();
    GS.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, mu: 1, R: 1, t0: 0, t: Infinity });
    const advanced = advance(-10, 0, 0, 0, 0);
    assert(advanced === 0, "reverse should block while GS has a live source");
    assert(WORLD.reverseBlocked, "reverseBlocked should be set while live debris blocks reverse");
    GS.length = 0;
    console.log("(f) live debris reverse block OK");
}

{
    resetHarness();
    const before = bodyVector();
    advanceEphem(86400);
    const forward = bodyVector();
    resetHarness();
    advanceEphem(86400);
    assertBodyClose(forward, bodyVector(), 0, "forward parity");
    assertBodyClose(before, before, 0, "forward parity baseline");
    console.log("(g) forward positive-dt parity OK");
}

console.log("reverse smoke passed");
