// Native-grid rays for the most structured parts of a moving volume view.
// Only the quality decision is made in screen space. Every atlas texel is a
// new integration at the CURRENT observer, never a reprojected volume depth.
import * as THREE from 'three';

export const MOTION_GRID = [12, 6];
export const MOTION_BORDER = 2;
export const MOTION_MAX_RAYS = 330000;
const TILE_COUNT = MOTION_GRID[0] * MOTION_GRID[1];

export function motionLayout(width, height, draftWidth, draftHeight, maxTextureSize = 16384) {
    if (![width, height, draftWidth, draftHeight, maxTextureSize].every(v => Number.isFinite(v) && v > 0)) return null;
    if (draftWidth >= width && draftHeight >= height) return null;
    const tw = Math.ceil(width / MOTION_GRID[0]), th = Math.ceil(height / MOTION_GRID[1]);
    const cw = tw + 2 * MOTION_BORDER, ch = th + 2 * MOTION_BORDER;
    // Additional ray count, INCLUDING tile gutters, never exceeds the coarse
    // pass or the fixed absolute ceiling. Not a full-resolution second frame.
    const rayBudget = Math.min(draftWidth * draftHeight, MOTION_MAX_RAYS);
    const count = Math.min(TILE_COUNT, Math.floor(rayBudget / (cw * ch)));
    if (!count || cw > maxTextureSize || ch > maxTextureSize) return null;
    const cols = Math.min(count, Math.max(1, Math.floor(Math.sqrt(count * ch / cw))), Math.floor(maxTextureSize / cw));
    const rows = Math.ceil(count / cols);
    if (rows * ch > maxTextureSize) return null;
    return { width, height, tw, th, cw, ch, count, cols, rows,
        atlasWidth: cols * cw, atlasHeight: rows * ch, rayBudget, rayPixels: count * cw * ch };
}

// The existing meter's two-byte log luminance retains spatial order here.
// Scores measure spatial variation, not just brightness: a uniform bright
// cloud must not displace a resolved dark lane from the bounded ray budget.
export function selectMotionTiles(bytes, width, height, limit) {
    if (!(limit > 0) || bytes.length !== width * height * 4) return [];
    const lum = new Float64Array(width * height), scores = [];
    for (let i = 0; i < lum.length; i++) {
        const y = Math.pow(2, (bytes[i * 4] + bytes[i * 4 + 1] / 255) * 40 / 255 - 24);
        lum[i] = Math.log1p(y);
    }
    for (let ty = 0; ty < MOTION_GRID[1]; ty++) for (let tx = 0; tx < MOTION_GRID[0]; tx++) {
        const x0 = Math.floor(tx * width / MOTION_GRID[0]), x1 = Math.ceil((tx + 1) * width / MOTION_GRID[0]);
        const y0 = Math.floor(ty * height / MOTION_GRID[1]), y1 = Math.ceil((ty + 1) * height / MOTION_GRID[1]);
        let energy = 0, count = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const a = lum[y * width + x];
            const dx = lum[y * width + Math.min(width - 1, x + 1)] - lum[y * width + Math.max(0, x - 1)];
            const dy = lum[Math.min(height - 1, y + 1) * width + x] - lum[Math.max(0, y - 1) * width + x];
            // Absolute display-space variation, compressed to retain faint detail.
            energy += (dx * dx + dy * dy) / (0.1 + a); count++;
        }
        scores.push({ id: ty * MOTION_GRID[0] + tx, tx, ty, score: Math.sqrt(energy / Math.max(1, count)) });
    }
    scores.sort((a, b) => b.score - a.score || a.id - b.id);
    const selected = scores.filter(s => s.score > 1e-4).slice(0, limit);
    // Feather the priority cutoff too, so small rank exchanges carry little
    // contrast. All weights depend on this frame, not accumulated radiance.
    const cutoff = scores[Math.min(limit, scores.length - 1)]?.score || 0;
    for (const item of selected) {
        const t = Math.max(0, Math.min(1, (item.score - 0.85 * cutoff) / Math.max(0.6 * cutoff, 1e-4)));
        item.weight = t * t * (3 - 2 * t);
    }
    return selected;
}

export function motionDetailUniforms() {
    return { uMotionAtlas: { value: null }, uMotionMap: { value: null },
        uMotionActive: { value: 0 }, uMotionFullSize: { value: new THREE.Vector2(1, 1) },
        uMotionTileSize: { value: new THREE.Vector2(1, 1) }, uMotionAtlasSize: { value: new THREE.Vector2(1, 1) } };
}

export const MOTION_COMPOSITE_GLSL = /* glsl */`
uniform sampler2D uMotionAtlas, uMotionMap;
uniform float uMotionActive;
uniform vec2 uMotionFullSize, uMotionTileSize, uMotionAtlasSize;
const vec2 MOTION_GRID = vec2(12.0, 6.0);
const float MOTION_BORDER = 2.0;
vec4 motionEntry(vec2 tile) {
    // Neighbors beyond the screen are not missing detail; suppress a needless
    // quality feather at the visible viewport boundary.
    return texture2D(uMotionMap, (clamp(tile, vec2(0.0), MOTION_GRID - 1.0) + 0.5) / MOTION_GRID);
}
vec3 motionDetail(vec2 uv, vec3 coarse) {
    if (uMotionActive < 0.5) return coarse;
    vec2 pixel = uv * uMotionFullSize;
    vec2 tile = min(floor(pixel / uMotionTileSize), MOTION_GRID - 1.0);
    vec4 entry = motionEntry(tile);
    if (entry.a < 0.5) return coarse;
    vec2 local = pixel - tile * uMotionTileSize;
    vec2 slot = floor(entry.rg * 255.0 + 0.5);
    vec2 atlasUv = (slot * (uMotionTileSize + 2.0 * MOTION_BORDER) + local + MOTION_BORDER) / uMotionAtlasSize;
    float weight = entry.b;
    // Neighbor-aware feather: adjacent detailed tiles join at full quality;
    // no checkerboard seams and no interpolation into a different atlas tile.
    float left = motionEntry(tile + vec2(-1.0, 0.0)).b;
    float right = motionEntry(tile + vec2(1.0, 0.0)).b;
    float down = motionEntry(tile + vec2(0.0, -1.0)).b;
    float up = motionEntry(tile + vec2(0.0, 1.0)).b;
    weight = min(weight, mix(min(entry.b, left), entry.b, smoothstep(0.0, 5.0, local.x)));
    weight = min(weight, mix(min(entry.b, right), entry.b, smoothstep(0.0, 5.0, uMotionTileSize.x - local.x)));
    weight = min(weight, mix(min(entry.b, down), entry.b, smoothstep(0.0, 5.0, local.y)));
    weight = min(weight, mix(min(entry.b, up), entry.b, smoothstep(0.0, 5.0, uMotionTileSize.y - local.y)));
    return mix(coarse, texture2D(uMotionAtlas, atlasUv).rgb, weight);
}
`;

const MOTION_VERTEX = /* glsl */`
attribute vec2 aViewOrigin, aAtlasOrigin;
uniform vec2 uMotionFullSize, uMotionTileSize, uMotionAtlasSize;
varying vec2 vNdc;
void main() {
    vec2 cell = uv * (uMotionTileSize + 4.0);
    vNdc = 2.0 * (aViewOrigin + cell - 2.0) / uMotionFullSize - 1.0;
    gl_Position = vec4(2.0 * (aAtlasOrigin + cell) / uMotionAtlasSize - 1.0, 0.0, 1.0);
}`;

export class GalaxyMotionDetail {
    constructor(uniforms) {
        this.uniforms = uniforms; this.target = null; this.material = null; this.layout = null;
        this.draws = 0; this.tiles = 0; this.rayPixels = 0; this.selected = [];
        this.mapBytes = new Uint8Array(TILE_COUNT * 4);
        this.map = new THREE.DataTexture(this.mapBytes, ...MOTION_GRID, THREE.RGBAFormat);
        this.map.minFilter = this.map.magFilter = THREE.NearestFilter;
        this.map.generateMipmaps = false; this.map.needsUpdate = true;
        this.map.name = 'galaxyMotionTileLookup';
        this.viewOrigins = new Float32Array(TILE_COUNT * 2); this.atlasOrigins = new Float32Array(TILE_COUNT * 2);
        const plane = new THREE.PlaneGeometry(2, 2);
        this.geometry = new THREE.InstancedBufferGeometry();
        this.geometry.index = plane.index; this.geometry.attributes = { ...plane.attributes };
        this.geometry.setAttribute('aViewOrigin', new THREE.InstancedBufferAttribute(this.viewOrigins, 2).setUsage(THREE.DynamicDrawUsage));
        this.geometry.setAttribute('aAtlasOrigin', new THREE.InstancedBufferAttribute(this.atlasOrigins, 2).setUsage(THREE.DynamicDrawUsage));
        this.geometry.instanceCount = 0;
        this.scene = new THREE.Scene();
        uniforms.uMotionMap.value = this.map;
    }
    reset() { this.uniforms.uMotionActive.value = 0; this.tiles = 0; this.rayPixels = 0; }
    render(renderer, rayMaterial, camera, full, draft, meterBytes, meterW, meterH) {
        this.reset();
        const layout = motionLayout(full.width, full.height, draft.width, draft.height, renderer.capabilities.maxTextureSize);
        if (!layout) return;
        const tiles = selectMotionTiles(meterBytes, meterW, meterH, layout.count);
        if (!tiles.length) return;
        if (!this.material) {
            this.material = new THREE.ShaderMaterial({ uniforms: { ...rayMaterial.uniforms, ...this.uniforms },
                vertexShader: MOTION_VERTEX, fragmentShader: rayMaterial.fragmentShader,
                depthTest: false, depthWrite: false, toneMapped: false });
            const mesh = new THREE.Mesh(this.geometry, this.material); mesh.frustumCulled = false; this.scene.add(mesh);
        }
        if (!this.target) {
            this.target = new THREE.WebGLRenderTarget(layout.atlasWidth, layout.atlasHeight, {
                type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
                minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
            this.target.texture.name = 'galaxyMotionNativeTiles';
        } else this.target.setSize(layout.atlasWidth, layout.atlasHeight);
        this.layout = layout; this.mapBytes.fill(0);
        for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i], sx = i % layout.cols, sy = Math.floor(i / layout.cols);
            this.viewOrigins.set([t.tx * layout.tw, t.ty * layout.th], i * 2);
            this.atlasOrigins.set([sx * layout.cw, sy * layout.ch], i * 2);
            this.mapBytes.set([sx, sy, Math.round(t.weight * 255), 255], t.id * 4);
        }
        this.map.needsUpdate = true;
        this.geometry.attributes.aViewOrigin.needsUpdate = this.geometry.attributes.aAtlasOrigin.needsUpdate = true;
        this.geometry.instanceCount = tiles.length;
        const u = this.uniforms, ru = rayMaterial.uniforms;
        u.uMotionFullSize.value.set(full.width, full.height); u.uMotionTileSize.value.set(layout.tw, layout.th);
        u.uMotionAtlasSize.value.set(layout.atlasWidth, layout.atlasHeight); u.uMotionAtlas.value = this.target.texture;
        const history = ru.uHistoryValid.value, pixAngle = ru.uPixAngle.value, stepK = ru.uStepK.value;
        try {
            ru.uHistoryValid.value = 0;
            ru.uPixAngle.value = 2 * ru.uTanHalf.value.y / full.height;
            // Isolate spatial sampling from quadrature: same integration step
            // as the moving draft. No hidden exposure/model/frequency boost.
            ru.uStepK.value = 0.055;
            renderer.setRenderTarget(this.target); renderer.autoClear = true;
            renderer.render(this.scene, camera);
            this.draws++; this.tiles = tiles.length; this.rayPixels = tiles.length * layout.cw * layout.ch;
            this.selected = tiles.map(t => t.id);
            u.uMotionActive.value = 1;
        } finally { ru.uHistoryValid.value = history; ru.uPixAngle.value = pixAngle; ru.uStepK.value = stepK; }
    }
    stats() {
        return { active: !!this.uniforms.uMotionActive.value, tiles: this.tiles, rayPixels: this.rayPixels,
            rayBudget: this.layout?.rayBudget || 0, draws: this.draws, selected: this.selected,
            atlas: this.target ? [this.target.width, this.target.height] : null,
            targetBytes: this.target ? this.target.width * this.target.height * 8 : 0 };
    }
}
