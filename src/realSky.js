import * as THREE from "three";
import { STAR_CATALOG_META } from "./constants.js";
import { G } from "./state.js";
import { dotTexture } from "./textures.js";
import { PERF, markPerf } from "./perf.js";
import { SKY_CURVE, bvToTeff, teffToRGB, sizePxForMag, skyDomeFade } from "./render/viewBrightness.js";

const SKY_R = 5.92e6;
const MAG_LIMIT = 6.5;
const LABEL_R = SKY_R * 0.985;
const LINE_R = SKY_R * 0.992;

// Per-band size/opacity now come straight from the shared SKY_CURVE
// (WP16 a3: constellation readability) instead of hand-tuned numbers, so a
// bright star's dominance over a faint one is the same photometric ranking
// every other star layer uses. Bands still exist to keep the draw-call
// budget at 6 (one THREE.Points per band) — only their per-band size/opacity
// values are now curve-derived, at each band's brightest (most legible) edge.
const MAG_BAND_EDGES = [0.5, 1.5, 2.5, 3.5, 5.0, MAG_LIMIT];
const MAG_BAND_OPACITY = [1.0, 1.0, .96, .88, .76, .6];
const MAG_BANDS = MAG_BAND_EDGES.map((max, i) => ({
    max,
    size: sizePxForMag(i === 0 ? -1.2 : MAG_BAND_EDGES[i - 1], SKY_CURVE),
    opacity: MAG_BAND_OPACITY[i],
}));

const ASTERISMS = [
    {
        name: "ORION",
        stars: ["BETELGEUSE", "BELLATRIX", "MINTAKA", "ALNILAM", "ALNITAK", "SAIPH", "RIGEL"],
        edges: [
            ["BETELGEUSE", "BELLATRIX"], ["BELLATRIX", "MINTAKA"], ["MINTAKA", "ALNILAM"],
            ["ALNILAM", "ALNITAK"], ["ALNITAK", "SAIPH"], ["SAIPH", "RIGEL"],
            ["RIGEL", "MINTAKA"], ["BETELGEUSE", "ALNITAK"],
        ],
    },
    {
        name: "URSA MAJOR",
        stars: ["DUBHE", "MERAK", "PHECDA", "MEGREZ", "ALIOTH", "MIZAR", "ALKAID"],
        edges: [
            ["DUBHE", "MERAK"], ["MERAK", "PHECDA"], ["PHECDA", "MEGREZ"],
            ["MEGREZ", "DUBHE"], ["MEGREZ", "ALIOTH"], ["ALIOTH", "MIZAR"], ["MIZAR", "ALKAID"],
        ],
    },
    {
        name: "CASSIOPEIA",
        stars: ["CAPH", "SCHEDAR", "RUCHBAH"],
        edges: [["CAPH", "SCHEDAR"], ["SCHEDAR", "RUCHBAH"]],
    },
    {
        name: "TAURUS",
        stars: ["ELNATH", "ALDEBARAN", "AIN"],
        edges: [["ELNATH", "ALDEBARAN"], ["ALDEBARAN", "AIN"]],
    },
    {
        name: "GEMINI",
        stars: ["CASTOR", "POLLUX", "WASAT", "ALHENA"],
        edges: [["CASTOR", "WASAT"], ["POLLUX", "WASAT"], ["WASAT", "ALHENA"]],
    },
    {
        name: "LEO",
        stars: ["REGULUS", "ALGIEBA", "ZOSMA", "CHERTAN", "DENEBOLA"],
        edges: [["REGULUS", "ALGIEBA"], ["ALGIEBA", "ZOSMA"], ["ZOSMA", "DENEBOLA"], ["DENEBOLA", "CHERTAN"], ["CHERTAN", "REGULUS"]],
    },
    {
        name: "VIRGO",
        stars: ["SPICA", "PORRIMA", "VINDEMIATRIX"],
        edges: [["SPICA", "PORRIMA"], ["PORRIMA", "VINDEMIATRIX"]],
    },
    {
        name: "BOOTES",
        stars: ["ARCTURUS", "IZAR"],
        edges: [["ARCTURUS", "IZAR"]],
    },
    {
        name: "ANDROMEDA",
        stars: ["ALPHERATZ", "MIRACH", "ALMACH"],
        edges: [["ALPHERATZ", "MIRACH"], ["MIRACH", "ALMACH"]],
    },
    {
        name: "PERSEUS",
        stars: ["MIRFAK", "ALGOL", "MENKIB"],
        edges: [["MIRFAK", "ALGOL"], ["ALGOL", "MENKIB"]],
    },
    {
        name: "AURIGA",
        stars: ["CAPELLA", "MENKALINAN", "MAHASIM", "HASSALEH", "ELNATH"],
        edges: [["CAPELLA", "MENKALINAN"], ["MENKALINAN", "MAHASIM"], ["MAHASIM", "HASSALEH"], ["HASSALEH", "ELNATH"], ["ELNATH", "CAPELLA"]],
    },
    {
        name: "CANIS MAJOR",
        stars: ["SIRIUS", "MIRZAM", "WEZEN", "ADHARA", "ALUDRA"],
        edges: [["MIRZAM", "SIRIUS"], ["SIRIUS", "WEZEN"], ["WEZEN", "ADHARA"], ["ADHARA", "ALUDRA"]],
    },
    {
        name: "SUMMER TRIANGLE",
        stars: ["VEGA", "DENEB", "ALTAIR"],
        edges: [["VEGA", "DENEB"], ["DENEB", "ALTAIR"], ["ALTAIR", "VEGA"]],
    },
    {
        name: "CYGNUS",
        stars: ["DENEB", "SADR", "ALBIREO"],
        edges: [["DENEB", "SADR"], ["SADR", "ALBIREO"]],
    },
    {
        name: "AQUILA",
        stars: ["TARAZED", "ALTAIR", "ALSHAIN"],
        edges: [["TARAZED", "ALTAIR"], ["ALTAIR", "ALSHAIN"]],
    },
    {
        name: "PEGASUS",
        stars: ["ALPHERATZ", "ALGENIB", "MARKAB", "SCHEAT"],
        edges: [["ALPHERATZ", "ALGENIB"], ["ALGENIB", "MARKAB"], ["MARKAB", "SCHEAT"], ["SCHEAT", "ALPHERATZ"]],
    },
    {
        name: "PISCIS AUSTRINUS",
        stars: ["FOMALHAUT"],
        edges: [],
    },
    {
        name: "ARIES",
        stars: ["HAMAL", "SHERATAN", "MESARTHIM"],
        edges: [["HAMAL", "SHERATAN"], ["SHERATAN", "MESARTHIM"]],
    },
    {
        name: "DRACO",
        stars: ["THUBAN", "ELTANIN", "RASTABAN"],
        edges: [["THUBAN", "ELTANIN"], ["ELTANIN", "RASTABAN"]],
    },
    {
        name: "WINTER TRIANGLE",
        stars: ["SIRIUS", "PROCYON", "BETELGEUSE"],
        edges: [["SIRIUS", "PROCYON"], ["PROCYON", "BETELGEUSE"], ["BETELGEUSE", "SIRIUS"]],
    },
    {
        name: "SCORPIUS",
        stars: ["ANTARES", "SHAULA", "SARGAS"],
        edges: [["ANTARES", "SHAULA"], ["SHAULA", "SARGAS"]],
    },
    {
        name: "CRUX",
        stars: ["ACRUX", "GACRUX", "MIMOSA"],
        edges: [["ACRUX", "GACRUX"], ["MIMOSA", "GACRUX"], ["MIMOSA", "ACRUX"]],
    },
    {
        name: "CENTAURUS",
        stars: ["RIGIL KENTAURUS", "HADAR", "MENKENT"],
        edges: [["RIGIL KENTAURUS", "HADAR"], ["HADAR", "MENKENT"]],
    },
];

const BRIGHT_LABELS = [
    "SIRIUS", "CANOPUS", "ARCTURUS", "VEGA", "CAPELLA", "RIGEL", "PROCYON", "BETELGEUSE",
    "ALTAIR", "ALDEBARAN", "SPICA", "ANTARES", "POLLUX", "REGULUS", "DENEB", "POLARIS",
    "FOMALHAUT", "ACHERNAR", "RIGIL KENTAURUS", "HADAR",
];
const SKY_NAME_KEYS = (() => {
    const keys = new Set(BRIGHT_LABELS.map(normName));
    for (const ast of ASTERISMS) for (const name of ast.stars) keys.add(normName(name));
    return keys;
})();
const SKY_LABEL_ROWS = [
    [7573, "Achernar"], [60528, "Acrux"], [33491, "Adhara"], [20836, "Ain"], [95646, "Albireo"],
    [21367, "Aldebaran"], [1064, "Algenib"], [50439, "Algieba"], [14539, "Algol"], [31600, "Alhena"],
    [62755, "Alioth"], [67086, "Alkaid"], [9617, "Almach"], [26245, "Alnilam"], [26661, "Alnitak"],
    [675, "Alpheratz"], [97723, "Alshain"], [97336, "Altair"], [35805, "Aludra"], [80517, "Antares"],
    [69449, "Arcturus"], [25272, "Bellatrix"], [27918, "Betelgeuse"], [30364, "Canopus"], [24548, "Capella"],
    [743, "Caph"], [36743, "Castor"], [54716, "Chertan"], [101765, "Deneb"], [57457, "Denebola"],
    [53904, "Dubhe"], [25363, "Elnath"], [87559, "Eltanin"], [113006, "Fomalhaut"], [60891, "Gacrux"],
    [68481, "Hadar"], [9860, "Hamal"], [22960, "Hassaleh"], [71877, "Izar"], [28308, "Mahasim"],
    [113601, "Markab"], [59590, "Megrez"], [28287, "Menkalinan"], [68712, "Menkent"], [18566, "Menkib"],
    [53753, "Merak"], [8812, "Mesarthim"], [62237, "Mimosa"], [25864, "Mintaka"], [5435, "Mirach"],
    [15823, "Mirfak"], [30250, "Mirzam"], [65171, "Mizar"], [57826, "Phecda"], [11733, "Polaris"],
    [37717, "Pollux"], [61746, "Porrima"], [37172, "Procyon"], [85408, "Rastaban"], [49527, "Regulus"],
    [24377, "Rigel"], [71454, "Rigil Kentaurus"], [6671, "Ruchbah"], [100126, "Sadr"], [27297, "Saiph"],
    [85963, "Sargas"], [113519, "Scheat"], [3171, "Schedar"], [85663, "Shaula"], [8883, "Sheratan"],
    [32262, "Sirius"], [65267, "Spica"], [96968, "Tarazed"], [68535, "Thuban"], [90977, "Vega"],
    [63403, "Vindemiatrix"], [35452, "Wasat"], [34353, "Wezen"], [54710, "Zosma"],
];
const HYG_FIELDS = ["xPc", "yPc", "zPc", "bv", "mag", "absMag", "lumSolar", "tempK", "massSolar", "radiusSolar"];
const HYG_BIN_URL = STAR_CATALOG_META.hygUrl.replace(/\.json(?:[?#].*)?$/, ".bin");

let root = null;
let constellationRoot = null;
let loadPromise = null;
const status = { loaded: false, stars: 0, constellations: 0, labels: 0, constellationsVisible: true, error: "" };

function publishStatus() {
    if (typeof window !== "undefined") window.__REAL_SKY = { ...status, promise: loadPromise };
}

function normName(v) {
    return String(v || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, " ");
}

function fieldIndex(meta, field) {
    const i = meta.fields.indexOf(field);
    if (i < 0) throw new Error("HYG field missing: " + field);
    return i;
}

function dirFromRecord(vals, j, ix, iy, iz, out = new THREE.Vector3()) {
    out.set(vals[j + ix], vals[j + iz], -vals[j + iy]);
    if (out.lengthSq() < 1e-18) out.set(1, 0, 0);
    return out.normalize();
}

// True Teff-based hue via the shared blackbody LUT (WP16 b): color is
// intrinsic to the star, not brightened/dimmed by its apparent magnitude —
// that job now belongs entirely to the per-band size/opacity curve above.
const _teffRGB = [1, 1, 1];
function colorFromTemp(tempK, bv, c = new THREE.Color()) {
    teffToRGB(tempK > 0 ? tempK : bvToTeff(bv), _teffRGB);
    c.setRGB(_teffRGB[0], _teffRGB[1], _teffRGB[2]);
    return c;
}

function makeLabelTexture(text, color = "#d9e7ff") {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "700 18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,.9)";
    ctx.shadowBlur = 18;
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
}

function addSkyLabel(parent, text, dir, scaleX, scaleY, color) {
    const mat = new THREE.SpriteMaterial({
        map: makeLabelTexture(text, color),
        transparent: true,
        opacity: .94,
        depthTest: false,
        depthWrite: false,
    });
    mat.userData.baseOpacity = .94;
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(dir).multiplyScalar(LABEL_R);
    sprite.scale.set(scaleX, scaleY, 1);
    sprite.renderOrder = 3;
    parent.add(sprite);
    return sprite;
}

function idleSlice() {
    return new Promise(resolve => {
        if (typeof requestIdleCallback === "function") requestIdleCallback(resolve, { timeout: 80 });
        else setTimeout(resolve, 0);
    });
}
async function yieldIfNeeded(slice, budget = 6) {
    if (performance.now() - slice.t <= budget) return;
    await idleSlice();
    slice.t = performance.now();
}
function magBandIndex(mag) {
    for (let i = 0; i < MAG_BANDS.length; i++) if (mag <= MAG_BANDS[i].max) return i;
    return -1;
}

function buildNameMap(meta, wanted = null) {
    const map = new Map();
    for (const row of meta.labels || []) {
        const key = normName(row[1]);
        if (key && (!wanted || wanted.has(key)) && !map.has(key)) map.set(key, row);
    }
    return map;
}

function rowDir(row, vals, meta, indexes, out) {
    const j = row[0] * meta.stride;
    return dirFromRecord(vals, j, indexes.xPc, indexes.yPc, indexes.zPc, out);
}

async function addConstellations(parent, meta, vals, indexes) {
    const t0 = performance.now();
    constellationRoot = new THREE.Group();
    constellationRoot.name = "Constellation guides";
    constellationRoot.frustumCulled = false;
    parent.add(constellationRoot);
    setConstellationsVisible(G.constellations);
    const byName = buildNameMap(meta, SKY_NAME_KEYS);
    const linePos = [];
    const tmpA = new THREE.Vector3();
    const tmpB = new THREE.Vector3();
    const tmpC = new THREE.Vector3();
    let lineCount = 0;
    let labelCount = 0;
    const slice = { t: performance.now() };

    for (const ast of ASTERISMS) {
        tmpC.set(0, 0, 0);
        let anchorCount = 0;
        for (const starName of ast.stars) {
            const row = byName.get(normName(starName));
            if (!row) continue;
            tmpC.add(rowDir(row, vals, meta, indexes, tmpA));
            anchorCount++;
        }
        if (anchorCount > 0) {
            tmpC.normalize();
            addSkyLabel(constellationRoot, ast.name, tmpC, 340000, 82000, "#9fbfff");
            labelCount++;
        }
        for (const [a, b] of ast.edges) {
            const ra = byName.get(normName(a));
            const rb = byName.get(normName(b));
            if (!ra || !rb) continue;
            rowDir(ra, vals, meta, indexes, tmpA);
            rowDir(rb, vals, meta, indexes, tmpB);
            linePos.push(tmpA.x * LINE_R, tmpA.y * LINE_R, tmpA.z * LINE_R);
            linePos.push(tmpB.x * LINE_R, tmpB.y * LINE_R, tmpB.z * LINE_R);
            lineCount++;
        }
        await yieldIfNeeded(slice);
    }

    if (linePos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(linePos), 3));
        const m = new THREE.LineBasicMaterial({
            color: 0x80a8ff,
            transparent: true,
            opacity: .42,
            depthTest: false,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        m.userData.baseOpacity = .42;
        const lines = new THREE.LineSegments(g, m);
        lines.frustumCulled = false;
        lines.renderOrder = -1;
        constellationRoot.add(lines);
    }

    for (const starName of BRIGHT_LABELS) {
        const row = byName.get(normName(starName));
        if (!row) continue;
        rowDir(row, vals, meta, indexes, tmpA);
        addSkyLabel(parent, starName, tmpA, 170000, 42000, "#f8d08a");
        labelCount++;
        await yieldIfNeeded(slice);
    }

    status.constellations = lineCount;
    status.labels = labelCount;
    publishStatus();
    if (PERF.enabled) markPerf("realSky.constellations", performance.now() - t0, { lineCount, labelCount });
}

async function addRealStars(parent, meta, vals, indexes) {
    const t0 = performance.now();
    const bands = MAG_BANDS.map(() => ({ pos: [], col: [] }));
    const dir = new THREE.Vector3();
    const color = new THREE.Color();
    let visible = 0;
    const slice = { t: performance.now() };
    for (let i = 0; i < meta.count; i++) {
        const j = i * meta.stride;
        const mag = vals[j + indexes.mag];
        if (!Number.isFinite(mag) || mag > MAG_LIMIT) continue;
        dirFromRecord(vals, j, indexes.xPc, indexes.yPc, indexes.zPc, dir);
        const bandIndex = magBandIndex(mag);
        if (bandIndex < 0) continue;
        const band = bands[bandIndex];
        band.pos.push(dir.x * SKY_R, dir.y * SKY_R, dir.z * SKY_R);
        const bv = vals[j + indexes.bv];
        const tempK = indexes.tempK != null ? vals[j + indexes.tempK] : NaN;
        const c = colorFromTemp(tempK, Number.isFinite(bv) ? bv : .65, color);
        band.col.push(c.r, c.g, c.b);
        visible++;
        if ((i & 2047) === 0) await yieldIfNeeded(slice);
    }

    const sprite = dotTexture("rgba(255,255,255,1)", "rgba(190,210,255,0.48)");
    for (let i = 0; i < bands.length; i++) {
        const band = bands[i];
        if (!band.pos.length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(band.pos), 3));
        g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(band.col), 3));
        const mat = new THREE.PointsMaterial({
            vertexColors: true,
            size: MAG_BANDS[i].size,
            sizeAttenuation: false,
            transparent: true,
            opacity: MAG_BANDS[i].opacity,
            depthTest: false,
            depthWrite: false,
            map: sprite,
            blending: THREE.AdditiveBlending,
        });
        mat.userData.baseOpacity = MAG_BANDS[i].opacity;
        const pts = new THREE.Points(g, mat);
        pts.frustumCulled = false;
        pts.renderOrder = -2;
        parent.add(pts);
        await yieldIfNeeded(slice);
    }
    status.stars = visible;
    publishStatus();
    if (PERF.enabled) markPerf("realSky.stars", performance.now() - t0, { visible });
}

async function loadRealSky() {
    const t0 = performance.now();
    const binUrl = new URL(HYG_BIN_URL, location.href);
    const binRes = await fetch(binUrl);
    if (!binRes.ok) throw new Error("HYG binary fetch failed");
    const vals = new Float32Array(await binRes.arrayBuffer());
    const meta = {
        binary: HYG_BIN_URL,
        fields: HYG_FIELDS,
        stride: HYG_FIELDS.length,
        count: Math.floor(vals.length / HYG_FIELDS.length),
        labels: SKY_LABEL_ROWS,
    };
    const indexes = {
        xPc: fieldIndex(meta, "xPc"),
        yPc: fieldIndex(meta, "yPc"),
        zPc: fieldIndex(meta, "zPc"),
        bv: fieldIndex(meta, "bv"),
        mag: fieldIndex(meta, "mag"),
        tempK: meta.fields.indexOf("tempK") >= 0 ? meta.fields.indexOf("tempK") : null,
    };
    await idleSlice();
    await addRealStars(root, meta, vals, indexes);
    await idleSlice();
    await addConstellations(root, meta, vals, indexes);
    status.loaded = true;
    status.error = "";
    if (PERF.enabled) markPerf("realSky.load", performance.now() - t0, { stars: status.stars, constellations: status.constellations, labels: status.labels });
}

export function initRealSky(parent) {
    if (root || location.search.includes("realsky=0")) return root;
    root = new THREE.Group();
    root.name = "HYG real naked-eye sky";
    root.frustumCulled = false;
    parent.add(root);
    loadPromise = loadRealSky().catch(err => {
        status.error = err?.message || String(err);
        console.warn("real sky:", status.error);
    }).finally(() => {
        publishStatus();
    });
    publishStatus();
    return root;
}

export function realSkyReady() {
    return loadPromise;
}

export function setConstellationsVisible(visible) {
    status.constellationsVisible = !!visible;
    if (constellationRoot) constellationRoot.visible = status.constellationsVisible;
    publishStatus();
}

export function realSkyStatus() {
    return { ...status };
}

// WP16 a1: the fixed-distance-shell naked-eye dome only makes sense within
// the solar neighborhood — once the camera is 50-500 pc from Sol it fades to
// fully invisible (an "Earth sky" is meaningless from that far away). Every
// material this touches carries a userData.baseOpacity set at creation time
// so repeated calls re-derive from the same baseline instead of compounding.
let lastDomeFade = 1;
export function updateRealSkyFade(camDistFromSolPc) {
    if (!root) return;
    const fade = skyDomeFade(camDistFromSolPc);
    if (Math.abs(fade - lastDomeFade) < .004) return;
    lastDomeFade = fade;
    root.visible = fade > .003;
    if (!root.visible) return;
    root.traverse(obj => {
        if (!obj.material) return;
        const base = obj.material.userData.baseOpacity ?? obj.material.opacity;
        obj.material.opacity = base * fade;
    });
}
