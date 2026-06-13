import * as THREE from "three";
import { STAR_CATALOG_META } from "./constants.js";
import { dotTexture } from "./textures.js";

const SKY_R = 5.92e6;
const MAG_LIMIT = 6.5;
const LABEL_R = SKY_R * 0.985;
const LINE_R = SKY_R * 0.992;

const MAG_BANDS = [
    { max: 0.5, size: 5.8, opacity: 1.0 },
    { max: 1.5, size: 4.6, opacity: 1.0 },
    { max: 2.5, size: 3.5, opacity: .98 },
    { max: 3.5, size: 2.55, opacity: .94 },
    { max: 5.0, size: 1.75, opacity: .86 },
    { max: MAG_LIMIT, size: 1.12, opacity: .74 },
];

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

let root = null;
let loadPromise = null;
const status = { loaded: false, stars: 0, constellations: 0, labels: 0, error: "" };

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

function colorFromBV(bv) {
    const t = THREE.MathUtils.clamp((bv + .4) / 2.4, 0, 1);
    const c = new THREE.Color();
    if (t < .32) c.setRGB(.58 + t * 1.05, .72 + t * .75, 1.0);
    else if (t < .58) c.setRGB(.90 + (t - .32) * .38, .94 + (t - .32) * .18, 1.0 - (t - .32) * .38);
    else c.setRGB(1.0, .98 - (t - .58) * .72, .82 - (t - .58) * .78);
    return c;
}

function magGain(mag) {
    return THREE.MathUtils.clamp(Math.pow(10, -0.4 * (mag - 1.0)), .10, 5.8);
}

function makeLabelTexture(text, color = "#d9e7ff") {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "700 34px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,.9)";
    ctx.shadowBlur = 18;
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

function addSkyLabel(parent, text, dir, scaleX, scaleY, color) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeLabelTexture(text, color),
        transparent: true,
        opacity: .94,
        depthTest: false,
        depthWrite: false,
    }));
    sprite.position.copy(dir).multiplyScalar(LABEL_R);
    sprite.scale.set(scaleX, scaleY, 1);
    sprite.renderOrder = 3;
    parent.add(sprite);
    return sprite;
}

function buildNameMap(meta) {
    const map = new Map();
    for (const row of meta.labels || []) {
        const key = normName(row[1]);
        if (key && !map.has(key)) map.set(key, row);
    }
    return map;
}

function rowDir(row, vals, meta, indexes, out) {
    const j = row[0] * meta.stride;
    return dirFromRecord(vals, j, indexes.xPc, indexes.yPc, indexes.zPc, out);
}

function addConstellations(parent, meta, vals, indexes) {
    const byName = buildNameMap(meta);
    const linePos = [];
    const tmpA = new THREE.Vector3();
    const tmpB = new THREE.Vector3();
    const tmpC = new THREE.Vector3();
    let lineCount = 0;
    let labelCount = 0;

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
            addSkyLabel(parent, ast.name, tmpC, 340000, 82000, "#9fbfff");
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
        const lines = new THREE.LineSegments(g, m);
        lines.frustumCulled = false;
        lines.renderOrder = -1;
        parent.add(lines);
    }

    for (const starName of BRIGHT_LABELS) {
        const row = byName.get(normName(starName));
        if (!row) continue;
        rowDir(row, vals, meta, indexes, tmpA);
        addSkyLabel(parent, starName, tmpA, 170000, 42000, "#f8d08a");
        labelCount++;
    }

    status.constellations = lineCount;
    status.labels = labelCount;
}

function addRealStars(parent, meta, vals, indexes) {
    const bands = MAG_BANDS.map(() => ({ pos: [], col: [] }));
    const dir = new THREE.Vector3();
    let visible = 0;
    for (let i = 0; i < meta.count; i++) {
        const j = i * meta.stride;
        const mag = vals[j + indexes.mag];
        if (!Number.isFinite(mag) || mag > MAG_LIMIT) continue;
        dirFromRecord(vals, j, indexes.xPc, indexes.yPc, indexes.zPc, dir);
        const bandIndex = MAG_BANDS.findIndex(band => mag <= band.max);
        if (bandIndex < 0) continue;
        const band = bands[bandIndex];
        band.pos.push(dir.x * SKY_R, dir.y * SKY_R, dir.z * SKY_R);
        const bv = vals[j + indexes.bv];
        const c = colorFromBV(Number.isFinite(bv) ? bv : .65);
        const gain = magGain(mag);
        band.col.push(
            Math.min(2.6, c.r * (.40 + gain * .55)),
            Math.min(2.6, c.g * (.40 + gain * .55)),
            Math.min(2.6, c.b * (.40 + gain * .55)),
        );
        visible++;
    }

    const sprite = dotTexture("rgba(255,255,255,1)", "rgba(190,210,255,0.48)");
    for (let i = 0; i < bands.length; i++) {
        const band = bands[i];
        if (!band.pos.length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(band.pos), 3));
        g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(band.col), 3));
        const pts = new THREE.Points(g, new THREE.PointsMaterial({
            vertexColors: true,
            size: MAG_BANDS[i].size,
            sizeAttenuation: false,
            transparent: true,
            opacity: MAG_BANDS[i].opacity,
            depthTest: false,
            depthWrite: false,
            map: sprite,
            blending: THREE.AdditiveBlending,
        }));
        pts.frustumCulled = false;
        pts.renderOrder = -2;
        parent.add(pts);
    }
    status.stars = visible;
}

async function loadRealSky() {
    const res = await fetch(STAR_CATALOG_META.hygUrl);
    if (!res.ok) throw new Error("HYG metadata fetch failed");
    const meta = await res.json();
    const binUrl = new URL(meta.binary, new URL(STAR_CATALOG_META.hygUrl, location.href));
    const binRes = await fetch(binUrl);
    if (!binRes.ok) throw new Error("HYG binary fetch failed");
    const vals = new Float32Array(await binRes.arrayBuffer());
    const indexes = {
        xPc: fieldIndex(meta, "xPc"),
        yPc: fieldIndex(meta, "yPc"),
        zPc: fieldIndex(meta, "zPc"),
        bv: fieldIndex(meta, "bv"),
        mag: fieldIndex(meta, "mag"),
    };
    addRealStars(root, meta, vals, indexes);
    addConstellations(root, meta, vals, indexes);
    status.loaded = true;
    status.error = "";
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
        if (typeof window !== "undefined") window.__REAL_SKY = { ...status };
    });
    if (typeof window !== "undefined") window.__REAL_SKY = { ...status, promise: loadPromise };
    return root;
}

export function realSkyStatus() {
    return { ...status };
}
