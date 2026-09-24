// Real-star point layers that exist at EVERY camera distance:
//   - the HYG v4.1 catalog (119k stars, tier 0) -- previously split between a
//     camera-attached naked-eye dome (mag <= 6.5, its own brightness formula,
//     vanishing at 0.2 ly) and a cosmic-scale cloud that only appeared past
//     0.002 ly with a different size curve;
//   - the curated destinations (STARS: named nearby stars, the HYG physical
//     subset, special objects) -- previously drawn three times at once (fixed
//     3 px markers, a vertically jittered cloud, and the dome).
// Both now use the shared resolved-star material (starPointMaterial.js), so a
// star has one appearance at one brightness wherever the camera is; as its
// disk resolves the point fades and the photosphere mesh (stars.js) takes
// over. Curated stars' catalog twins are hidden from the HYG cloud, so no star
// is drawn twice.
//
// Floating origin: positions are kept in float64 world km on the CPU; the GPU
// holds float32 residuals relative to renderOrigin's origin, and each mesh
// sits at that origin in scene units. refreshCatalogResiduals() re-bases them
// after renderOrigin.maybeRebase().
import * as THREE from "three";
import { K, PC_KM, STARS } from "../constants.js";
import { loadHygCatalogData } from "../universe/catalogData.js";
import { registerHygCatalog } from "../universe/hygActiveCatalog.js";
import { getOrigin, worldToResidualArr } from "../universe/renderOrigin.js";
import { makeStarPointMaterial } from "./starPointMaterial.js";
import { linearStarColor } from "./stellarAppearance.js";
import { CURATED_PHOTOMETRY } from "./curatedPhotometry.js";
import { bvToTeff, teffToRGB, absMagFromApparent, absMagVFromL } from "./viewBrightness.js";
import { PERF, markPerf } from "../perf.js";

const SUPPRESS_PC = 0.18;       // curated destination <-> catalog twin match radius
const state = {
    // Both layers sit in the scene itself (not the far-tier group): a star the
    // camera approaches must stay drawn inside the near tier (< 0.02 ly); the
    // shared material's depth fence draws each point in exactly one pass.
    parent: null,
    held: new Set(),   // HYG rows currently drawn by an active-star visual (stars.js)
    tier0: null,   // { mesh, geometry, worldKm, count, slotOfRow }
    named: null,   // { mesh, geometry, worldKm, count, starsLen }
    loading: false,
    loaded: false,
    error: "",
};

const _rgb = [1, 1, 1];
const _col = new THREE.Color();

// V-band absolute magnitude for a curated destination, from the best record
// it carries: catalog absolute magnitude, catalog apparent magnitude at its
// distance, or bolometric luminosity through BC_V(Teff).
export function curatedAbsMagV(star) {
    if (Number.isFinite(star.absMag)) return star.absMag;
    const phot = CURATED_PHOTOMETRY[star.name];
    const dPc = Math.hypot(star.x, star.y, star.z || 0) / PC_KM;
    if (phot && Number.isFinite(phot.mag)) return absMagFromApparent(phot.mag, dPc);
    if (star.lumSolar > 0) return absMagVFromL(star.lumSolar, curatedTeff(star));
    return NaN;
}
export function curatedTeff(star) {
    return star.tempK || CURATED_PHOTOMETRY[star.name]?.tempK || (Number.isFinite(star.bv) ? bvToTeff(star.bv) : 5800);
}

function makeLayer(count, withHidden) {
    const geometry = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", pos);
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute("absMag", new THREE.BufferAttribute(new Float32Array(count), 1));
    geometry.setAttribute("teffK", new THREE.BufferAttribute(new Float32Array(count), 1));
    geometry.setAttribute("radiusKm", new THREE.BufferAttribute(new Float32Array(count), 1));
    if (withHidden) {
        const h = new THREE.BufferAttribute(new Float32Array(count), 1);
        h.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute("hidden", h);
    }
    const mesh = new THREE.Points(geometry, makeStarPointMaterial({ hidden: withHidden, radius: true }));
    mesh.frustumCulled = false;
    mesh.renderOrder = -3;
    return { mesh, geometry, worldKm: new Float64Array(count * 3), count };
}

function setColor(arr, i, teff) {
    teffToRGB(teff, _rgb);
    linearStarColor(_rgb, _col);
    arr[i * 3] = _col.r; arr[i * 3 + 1] = _col.g; arr[i * 3 + 2] = _col.b;
}

function placeAtOrigin(layer) {
    const o = getOrigin();
    layer.mesh.position.set(o.x * K, o.z * K, -o.y * K);
    const pos = layer.geometry.attributes.position;
    for (let i = 0; i < layer.count; i++) {
        worldToResidualArr(layer.worldKm[i * 3], layer.worldKm[i * 3 + 1], layer.worldKm[i * 3 + 2], pos.array, i * 3, K);
    }
    pos.needsUpdate = true;
}

// Curated destinations (non-black-hole entries of STARS).
function buildNamed() {
    const rows = STARS.filter(s => !s.bh);
    if (state.named) {
        state.parent.remove(state.named.mesh);
        state.named.geometry.dispose();
        state.named.mesh.material.dispose();
    }
    const layer = makeLayer(rows.length, false);
    const g = layer.geometry.attributes;
    for (let i = 0; i < rows.length; i++) {
        const s = rows[i];
        layer.worldKm[i * 3] = s.x; layer.worldKm[i * 3 + 1] = s.y; layer.worldKm[i * 3 + 2] = s.z || 0;
        const teff = curatedTeff(s);
        const m = curatedAbsMagV(s);
        g.absMag.array[i] = Number.isFinite(m) ? m : 99;
        g.teffK.array[i] = teff;
        g.radiusKm.array[i] = s.R || 0;
        setColor(g.color.array, i, teff);
    }
    layer.mesh.name = "curated destinations";
    layer.starsLen = STARS.length;
    placeAtOrigin(layer);
    state.named = layer;
    state.parent.add(layer.mesh);
}

async function loadTier0() {
    if (state.loading || state.loaded) return;
    state.loading = true;
    const t0 = PERF.enabled ? performance.now() : 0;
    try {
        const { meta, vals } = await loadHygCatalogData();
        registerHygCatalog(meta, vals, { deferIndex: true });
        const fields = meta.fields || [];
        const fi = (n, d) => { const i = fields.indexOf(n); return i >= 0 ? i : d; };
        const stride = meta.stride || fields.length || 10;
        const iX = fi("xPc", 0), iY = fi("yPc", 1), iZ = fi("zPc", 2), iBv = fi("bv", 3), iMag = fi("mag", 4);
        const iAbs = fi("absMag", -1), iLum = fi("lumSolar", -1), iTemp = fi("tempK", -1), iRad = fi("radiusSolar", -1);
        const count = Math.floor(vals.length / stride);
        // Curated twins (world pc, same frame as the rotated catalog values).
        const sup = [];
        for (const s of STARS) if (!s.bh) sup.push(s.x / PC_KM, s.y / PC_KM, (s.z || 0) / PC_KM);
        const layer = makeLayer(count, true);
        layer.slotOfRow = new Int32Array(count);
        layer.baseHidden = new Uint8Array(count);
        const g = layer.geometry.attributes;
        const r2 = SUPPRESS_PC * SUPPRESS_PC;
        let slice = performance.now();
        for (let i = 0, j = 0; i < count; i++, j += stride) {
            const x = vals[j + iX], y = vals[j + iY], z = vals[j + iZ];
            layer.slotOfRow[i] = i;
            layer.worldKm[i * 3] = x * PC_KM; layer.worldKm[i * 3 + 1] = y * PC_KM; layer.worldKm[i * 3 + 2] = z * PC_KM;
            const dPc = Math.hypot(x, y, z);
            const temp = iTemp >= 0 ? vals[j + iTemp] : NaN;
            const teff = temp > 0 ? temp : bvToTeff(vals[j + iBv]);
            // V-band absolute magnitude (the catalog's own absmag; else from
            // apparent magnitude and distance; bolometric only as a last
            // resort, through BC_V). Tier 1 uses the same V-band convention.
            const absField = iAbs >= 0 ? vals[j + iAbs] : NaN;
            const lum = iLum >= 0 ? vals[j + iLum] : NaN;
            const mag = vals[j + iMag];
            g.absMag.array[i] = Number.isFinite(absField) ? absField
                : Number.isFinite(mag) && dPc > 0 ? absMagFromApparent(mag, dPc)
                    : lum > 0 ? absMagVFromL(lum, teff) : 99;
            g.teffK.array[i] = teff;
            g.radiusKm.array[i] = iRad >= 0 && vals[j + iRad] > 0 ? vals[j + iRad] * 696340 : 0;
            setColor(g.color.array, i, teff);
            // The Sun's own row (distance 0) is drawn by bodies.js.
            let hide = !(dPc > 1e-6);
            for (let k = 0; !hide && k < sup.length; k += 3) {
                const dx = x - sup[k], dy = y - sup[k + 1], dz = z - sup[k + 2];
                if (dx * dx + dy * dy + dz * dz <= r2) hide = true;
            }
            layer.baseHidden[i] = hide ? 1 : 0;
            g.hidden.array[i] = hide || state.held.has(i) ? 1 : 0;
            if ((i & 8191) === 0 && performance.now() - slice > 8) {
                await new Promise(r => (typeof requestIdleCallback === "function" ? requestIdleCallback(r, { timeout: 60 }) : setTimeout(r, 0)));
                slice = performance.now();
            }
        }
        layer.mesh.name = "HYG v4.1 catalog";
        placeAtOrigin(layer);
        state.tier0 = layer;
        state.parent.add(layer.mesh);
        state.loaded = true;
        if (PERF.enabled) markPerf("catalogStars.load", performance.now() - t0, { count });
    } catch (err) {
        state.error = err?.message || String(err);
        console.warn("catalog stars unavailable:", state.error);
    } finally {
        state.loading = false;
    }
}

export function initCatalogStars(parent) {
    if (state.parent) return;
    state.parent = parent;
    buildNamed();
    const start = () => loadTier0();
    if (typeof requestIdleCallback === "function") requestIdleCallback(start, { timeout: 600 });
    else setTimeout(start, 0);
}

// Per-frame: keep the curated cloud in step with runtime promotions (rare).
export function updateCatalogStars() {
    if (!state.parent) return;
    if (state.named && state.named.starsLen !== STARS.length) {
        buildNamed();
        hidePromotedTwins();
    }
}

// Hide HYG rows that were promoted into STARS at runtime (catalog search).
function hidePromotedTwins() {
    const t0 = state.tier0;
    if (!t0) return;
    const h = t0.geometry.attributes.hidden;
    let touched = false;
    for (const s of STARS) {
        if (Number.isInteger(s.hygIndex) && s.hygIndex >= 0 && s.hygIndex < t0.count && !t0.baseHidden[s.hygIndex]) {
            t0.baseHidden[s.hygIndex] = 1;
            h.array[s.hygIndex] = 1;
            touched = true;
        }
    }
    if (touched) h.needsUpdate = true;
}

// One star, one representation: while an active-star visual (stars.js) draws
// a catalog star at its live position, the static catalog point steps aside.
export function holdCatalogRow(row, held) {
    if (!Number.isInteger(row) || row < 0) return;
    if (held) state.held.add(row); else state.held.delete(row);
    const t0 = state.tier0;
    if (!t0 || row >= t0.count) return;
    const h = t0.geometry.attributes.hidden;
    const v = t0.baseHidden[row] || held ? 1 : 0;
    if (h.array[row] === v) return;
    h.array[row] = v;
    h.addUpdateRange(row, 1);
    h.needsUpdate = true;
}

export function refreshCatalogResiduals() {
    if (state.tier0) placeAtOrigin(state.tier0);
    if (state.named) placeAtOrigin(state.named);
}

export function setCatalogStarsFade(fade) {
    for (const layer of [state.tier0, state.named]) {
        if (!layer) continue;
        layer.mesh.material.uniforms.uFade.value = fade;
        layer.mesh.visible = fade > 0.003;
    }
}

export function catalogStarsStatus() {
    return { loaded: state.loaded, count: state.tier0?.count || 0, named: state.named?.count || 0, error: state.error };
}
