// Tier-1 (AT-HYG, ~2.37M star) renderer: one THREE.Points mesh per group of
// GROUP_TILE_SPAN HEALPix tiles (12288 / 256 = 48 groups => at most 48 draw
// calls at full load, comfortably under the <100 whole-scene draw-call budget
// shared with every other layer). Each group's buffers
// are preallocated at the group's *manifest* total star count the first time
// the group is touched, then filled incrementally as tiles stream in.
//
// Slot assignment inside a group buffer is in LOAD order, not tile-id order:
// the first tile to arrive gets slots [0, n0), the second gets [n0, n0+n1),
// etc. That makes `geometry.drawRange = [0, filledCount]` always correct with
// no gaps and no need to hide not-yet-loaded slots behind a sentinel — the
// pure bookkeeping for this (`createGroupLayout`/`addTileToLayout`) is
// exported and Node-testable (see scripts/smoke-tier1-runtime.mjs).
//
// Positions: each star's world-frame kilometres (parsec * PC_KM, heliocentric
// equatorial) are kept in a CPU-only Float64Array per group (`worldKm`) —
// authoritative, never uploaded to the GPU. The GPU `position` attribute only
// ever holds the small camera-relative float32 residual computed from it via
// renderOrigin.worldToResidualArr; call `refreshAllResiduals` after a rebase
// to recompute every loaded star's residual against the new origin.
//
// Proper motion (`pm`, mas/yr x10 per axis) is decoded and stored per star but
// not applied to position anywhere in this module — Tier-1 stars are static
// until a later work package decides an update cadence for real per-star
// kinematics; this only reserves the storage and documents the gap.

import * as THREE from "three";
import { PC_KM, K } from "../constants.js";
import { worldToResidualArr } from "../universe/renderOrigin.js";

export const GROUP_TILE_SPAN = 256;

// --- pure bookkeeping (Node-testable, no THREE/DOM) -------------------------

export function groupIndexForTile(tileId, span = GROUP_TILE_SPAN) {
    return Math.floor(tileId / span);
}

// Per-group total star capacity straight from the manifest's [byteOffset,count]
// tile table — known before a single byte of star data has been fetched.
export function computeGroupCapacities(manifestTiles, span = GROUP_TILE_SPAN) {
    const numGroups = Math.ceil(manifestTiles.length / span);
    const capacities = new Array(numGroups).fill(0);
    for (let t = 0; t < manifestTiles.length; t++) {
        capacities[groupIndexForTile(t, span)] += manifestTiles[t][1];
    }
    return capacities;
}

export function createGroupLayout(capacity) {
    return { capacity, filledCount: 0, tileOffsets: new Map() };
}

// Idempotent: re-adding a tile already present returns its existing slot with
// isNew:false instead of double-counting filledCount (a tile message could in
// principle be delivered twice — e.g. a caller retry racing a slow reply).
export function addTileToLayout(layout, tileId, count) {
    const existing = layout.tileOffsets.get(tileId);
    if (existing) return { offset: existing.offset, count: existing.count, isNew: false };
    if (layout.filledCount + count > layout.capacity) {
        throw new Error(`athygStars: group layout overflow (tile ${tileId}, filled ${layout.filledCount}, incoming ${count}, capacity ${layout.capacity})`);
    }
    const offset = layout.filledCount;
    layout.tileOffsets.set(tileId, { offset, count });
    layout.filledCount += count;
    return { offset, count, isNew: true };
}

// --- color ramp (same B-V/CI piecewise ramp as src/realSky.js's colorFromBV,
// re-expressed against a reusable output array instead of THREE.Color so the
// per-star ingest loop below allocates nothing) --------------------------

function bvColor(ci, out) {
    const t = Math.max(0, Math.min(1, ((Number.isFinite(ci) ? ci : .65) + .4) / 2.4));
    let r, g, b;
    if (t < .32) { r = .58 + t * 1.05; g = .72 + t * .75; b = 1.0; }
    else if (t < .58) { r = .90 + (t - .32) * .38; g = .94 + (t - .32) * .18; b = 1.0 - (t - .32) * .38; }
    else { r = 1.0; g = .98 - (t - .58) * .72; b = .82 - (t - .58) * .78; }
    out[0] = Math.min(1, r); out[1] = Math.min(1, g); out[2] = Math.min(1, b);
}

// --- magnitude -> size/alpha shader (numerics report §2 formulas) ----------

export const TIER1_BASE_PX = 6.0;
export const TIER1_MAG_REF = 4.0;
export const TIER1_MIN_PX = 0.6;
export const TIER1_MAX_PX = 10.0;
export const TIER1_MAG_LIMIT = 8.0;

const VERT = `
attribute vec3 color;
attribute float mag;
varying vec3 vColor;
varying float vAlpha;
uniform float uBasePx;
uniform float uMagRef;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uMagLimit;
void main() {
    vColor = color;
    float size = uBasePx * pow(10.0, -0.2 * (mag - uMagRef));
    gl_PointSize = clamp(size, uMinPx, uMaxPx);
    vAlpha = clamp(pow(10.0, -0.4 * (mag - uMagLimit)), 0.0, 1.0);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAG = `
varying vec3 vColor;
varying float vAlpha;
void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = dot(uv, uv);
    if (d > 0.25) discard;
    float edge = smoothstep(0.25, 0.1, d);
    gl_FragColor = vec4(vColor, vAlpha * edge);
}
`;

function makeTier1Material() {
    return new THREE.ShaderMaterial({
        uniforms: {
            uBasePx: { value: TIER1_BASE_PX },
            uMagRef: { value: TIER1_MAG_REF },
            uMinPx: { value: TIER1_MIN_PX },
            uMaxPx: { value: TIER1_MAX_PX },
            uMagLimit: { value: TIER1_MAG_LIMIT },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
    });
}

// --- THREE-backed groups -----------------------------------------------------

/**
 * Build the (up to) 48 group meshes and add them to `parent`. Groups whose
 * manifest capacity is 0 get no mesh (nothing to draw, ever) but keep a slot
 * in the returned array so `groupIndexForTile` stays a valid index into it.
 */
export function createTileGroups(parent, manifest, span = GROUP_TILE_SPAN) {
    const capacities = computeGroupCapacities(manifest.tiles, span);
    return capacities.map(capacity => {
        if (capacity === 0) return { capacity: 0, layout: createGroupLayout(0), mesh: null, geometry: null, worldKm: null, pm: null };
        const layout = createGroupLayout(capacity);
        const geometry = new THREE.BufferGeometry();
        const posAttr = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
        const colAttr = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
        const magAttr = new THREE.BufferAttribute(new Float32Array(capacity), 1);
        posAttr.setUsage(THREE.DynamicDrawUsage);
        colAttr.setUsage(THREE.DynamicDrawUsage);
        magAttr.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute("position", posAttr);
        geometry.setAttribute("color", colAttr);
        geometry.setAttribute("mag", magAttr);
        geometry.setDrawRange(0, 0);
        const mesh = new THREE.Points(geometry, makeTier1Material());
        mesh.frustumCulled = false;
        mesh.renderOrder = -3;
        mesh.name = "athygTier1Group";
        parent.add(mesh);
        return { capacity, layout, mesh, geometry, worldKm: new Float64Array(capacity * 3), pm: new Int16Array(capacity * 2) };
    });
}

const _tmpColor = [1, 1, 1];

/**
 * Decode one tile's worth of star data into its group's buffers. `tileData`
 * is the worker's `{count, positions (parsec, Float32Array), magCi (Int16Array
 * mag*100/ci*1000 pairs), pm (Int16Array pmRa*10/pmDec*10 pairs)}`. Returns
 * null if the tile's group has zero capacity (should never happen for a tile
 * the manifest reports a nonzero count for) or `{offset, count}` otherwise.
 * Safe to call twice for the same tileId (second call is a no-op).
 */
export function ingestTile(groups, tileId, tileData, span = GROUP_TILE_SPAN) {
    if (!tileData || tileData.count === 0) return null;
    const gi = groupIndexForTile(tileId, span);
    const group = groups[gi];
    if (!group || group.capacity === 0) return null;
    const { offset, count, isNew } = addTileToLayout(group.layout, tileId, tileData.count);
    if (!isNew) return { offset, count };

    const { positions, magCi, pm } = tileData;
    const posArr = group.geometry.attributes.position.array;
    const colArr = group.geometry.attributes.color.array;
    const magArr = group.geometry.attributes.mag.array;
    for (let i = 0; i < count; i++) {
        const si = offset + i;
        const pcX = positions[i * 3], pcY = positions[i * 3 + 1], pcZ = positions[i * 3 + 2];
        const wx = pcX * PC_KM, wy = pcY * PC_KM, wz = pcZ * PC_KM;
        group.worldKm[si * 3] = wx; group.worldKm[si * 3 + 1] = wy; group.worldKm[si * 3 + 2] = wz;
        worldToResidualArr(wx, wy, wz, posArr, si * 3, K);
        const mag = magCi[i * 2] / 100;
        const ci = magCi[i * 2 + 1] / 1000;
        bvColor(ci, _tmpColor);
        colArr[si * 3] = _tmpColor[0]; colArr[si * 3 + 1] = _tmpColor[1]; colArr[si * 3 + 2] = _tmpColor[2];
        magArr[si] = mag;
        group.pm[si * 2] = pm[i * 2]; group.pm[si * 2 + 1] = pm[i * 2 + 1];
    }

    const posAttr = group.geometry.attributes.position;
    const colAttr = group.geometry.attributes.color;
    const magAttr = group.geometry.attributes.mag;
    posAttr.addUpdateRange(offset * 3, count * 3); posAttr.needsUpdate = true;
    colAttr.addUpdateRange(offset * 3, count * 3); colAttr.needsUpdate = true;
    magAttr.addUpdateRange(offset, count); magAttr.needsUpdate = true;
    group.geometry.setDrawRange(0, group.layout.filledCount);
    return { offset, count };
}

/**
 * Call contract: after `renderOrigin.maybeRebase(...)` returns true, call this
 * once (before the next render) to recompute every already-loaded star's GPU
 * residual against the new origin. Newly-ingested tiles after this point pick
 * up the current origin automatically via `ingestTile`, so this only needs to
 * run for stars already resident in the buffers at rebase time.
 *
 * Kept as a synchronous, do-everything-now helper (used by e.g. Node smoke
 * tests that don't run a render loop to pump against). Interactive/VR code
 * should use markResidualsDirty + pumpGroupResiduals instead — see the
 * comment above pumpGroupResiduals for why a single synchronous pass across
 * the full ~2.37M-star catalog is not safe to call from a frame callback.
 */
export function refreshAllResiduals(groups) {
    for (const group of groups) {
        const n = group.layout?.filledCount || 0;
        if (!group.mesh || n === 0) continue;
        const posArr = group.geometry.attributes.position.array;
        for (let si = 0; si < n; si++) {
            worldToResidualArr(group.worldKm[si * 3], group.worldKm[si * 3 + 1], group.worldKm[si * 3 + 2], posArr, si * 3, K);
        }
        const posAttr = group.geometry.attributes.position;
        posAttr.addUpdateRange(0, n * 3);
        posAttr.needsUpdate = true;
    }
}

// --- chunked (incremental) residual refresh ---------------------------------
//
// refreshAllResiduals above re-transforms every loaded star synchronously —
// at full 2.37M-star load that's ~7.5-15ms of straight-line float math, which
// alone blows an 8.3ms (120fps VR) frame budget. markResidualsDirty +
// pumpGroupResiduals split that same work across as many updateTier1() calls
// as it takes, `maxStarsPerCall` stars at a time (see athygTier1.js's
// pumpResidualRefresh, the public entry point that owns the resume cursor).
//
// Correctness note (read before changing the budget): a star not yet
// re-transformed this refresh still renders with its PRE-rebase residual,
// i.e. computed against the OLD origin, for however many pump calls it takes
// to reach it. That is a real, deliberate trade-off — nothing is hidden or
// skipped, so the visible effect is a small positional error, not a gap.
// Worst case that error is `rebaseThresholdKm * K` scene units (the origin
// never drifts further than the rebase threshold before maybeRebase fires
// again) — at the default 1e4 km threshold and K=0.001 that's 10 scene
// units. Tier-1 stars sit at real stellar distances (>=1 pc from the
// camera, i.e. >=3.09e10 scene units), so a 10-unit offset is a relative
// angular error on the order of 1e-10 — many orders of magnitude under one
// pixel — for as many as ceil(totalLoadedStars / maxStarsPerCall) frames
// (2.37M / 300,000 = 8 frames worst case at full load). That is the
// intentional trade this scheme makes: imperceptible positional drift for a
// handful of frames, instead of a multi-millisecond synchronous stall.

/**
 * Marks every non-empty group's currently-loaded stars dirty and rewinds its
 * resume cursor to 0. Call once, synchronously, right after
 * renderOrigin.maybeRebase(...) returns true — the recompute itself happens
 * later, incrementally, via pumpGroupResiduals.
 */
export function markResidualsDirty(groups) {
    for (const group of groups) {
        if (!group.mesh || (group.layout?.filledCount || 0) === 0) continue;
        group.residualDirty = true;
        group.residualCursor = 0;
    }
}

/**
 * Recomputes up to `budget` star residuals total, resuming from
 * `cursor.groupIndex` (and each group's own `residualCursor`), across
 * whichever groups markResidualsDirty flagged. Mutates `cursor.groupIndex`
 * to remember where to resume on the next call. Returns
 * `{ done, dirtyGroups }`: `done` is true only once no group is dirty
 * anymore; `dirtyGroups` is how many groups still have stars left to
 * recompute (surfaced by athygTier1.tier1Stats for observability).
 */
export function pumpGroupResiduals(groups, cursor, budget) {
    let gi = cursor.groupIndex || 0;
    while (gi < groups.length && budget > 0) {
        const group = groups[gi];
        if (!group.mesh || !group.residualDirty) { gi++; continue; }
        const n = group.layout.filledCount;
        const posArr = group.geometry.attributes.position.array;
        const start = group.residualCursor || 0;
        let si = start;
        while (si < n && budget > 0) {
            worldToResidualArr(group.worldKm[si * 3], group.worldKm[si * 3 + 1], group.worldKm[si * 3 + 2], posArr, si * 3, K);
            si++; budget--;
        }
        if (si > start) {
            const posAttr = group.geometry.attributes.position;
            posAttr.addUpdateRange(start * 3, (si - start) * 3);
            posAttr.needsUpdate = true;
        }
        group.residualCursor = si;
        if (si >= n) { group.residualDirty = false; gi++; }
        // else: budget exhausted mid-group — stay put, resume here next call.
    }
    cursor.groupIndex = gi < groups.length ? gi : 0;
    let dirtyGroups = 0;
    for (const group of groups) if (group.residualDirty) dirtyGroups++;
    return { done: dirtyGroups === 0, dirtyGroups };
}

export function disposeGroups(groups, parent) {
    for (const group of groups) {
        if (!group.mesh) continue;
        if (parent) parent.remove(group.mesh);
        group.geometry.dispose();
        group.mesh.material.dispose();
    }
}

export function groupStats(groups) {
    let drawCalls = 0, starsLoaded = 0, tilesLoaded = 0;
    for (const group of groups) {
        if (!group.mesh) continue;
        if (group.layout.filledCount > 0) drawCalls++;
        starsLoaded += group.layout.filledCount;
        tilesLoaded += group.layout.tileOffsets.size;
    }
    return { drawCalls, starsLoaded, tilesLoaded, groupCount: groups.length };
}
