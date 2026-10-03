// QA-only census of existing production textures. No uploads, material edits,
// camera changes, warmup changes or GPU synchronization are introduced here.
export function installTextureUploadTracker(renderer, scene, camera) {
    const LIMIT = 4096, handles = new WeakMap(), callbacks = new Map();
    let nextHandle = 0, active = false, frame = 0, stage = '', before = new Map(), last = new Map();
    const events = [], frames = [], checkpoints = [], drawn = new Set();
    let truncated = false;
    const handleId = handle => {
        if (!handle) return 0;
        if (!handles.has(handle)) handles.set(handle, ++nextHandle);
        return handles.get(handle);
    };
    const append = (rows, item) => { if (rows.length < LIMIT) rows.push(item); else truncated = true; };
    const visible = object => { for (let o = object; o; o = o.parent) if (!o.visible) return false; return true; };
    function census() {
        const owners = new Map(), q = window.exploredQA;
        for (const [i, slot] of (q?.body.systemBodyRenderState() || []).entries()) {
            for (const kind of ['mesh', 'ring', 'label', 'glow']) if (slot[kind]) owners.set(slot[kind], { planet: i, kind, planetName: slot.planet?.name || null });
            for (const [j, moon] of slot.moons.entries()) owners.set(moon, { planet: i, moon: j, kind: 'moon' });
            for (const [j, glow] of slot.moonGlows.entries()) owners.set(glow, { planet: i, moon: j, kind: 'moon-glow' });
        }
        const rows = new Map();
        scene.traverse(object => {
            if (active && object.material && !callbacks.has(object)) {
                const previous = object.onAfterRender;
                callbacks.set(object, previous);
                object.onAfterRender = function (...args) { drawn.add(this.uuid); return previous?.apply(this, args); };
            }
            for (const material of (Array.isArray(object.material) ? object.material : [object.material]).filter(Boolean)) {
                const bindings = [...Object.entries(material), ...Object.entries(material.uniforms || {}).map(([key, u]) => ['uniform:' + key, u.value])];
                for (const [binding, texture] of bindings) if (texture?.isTexture) {
                    const properties = renderer.properties.get(texture);
                    let row = rows.get(texture.uuid);
                    if (!row) {
                        row = { textureId: texture.uuid, sourceId: texture.source?.uuid || null,
                            gpuHandle: handleId(properties.__webglTexture), uploadedVersion: properties.__version ?? null,
                            version: texture.version, width: texture.image?.width ?? null, height: texture.image?.height ?? null,
                            textureType: texture.type, imageType: texture.image?.constructor?.name || null, bindings: [] };
                        rows.set(texture.uuid, row);
                    }
                    row.bindings.push({ objectId: object.uuid, objectName: object.name || object.type,
                        materialId: material.uuid, binding, owner: owners.get(object) || null,
                        appearanceIdentity: object.userData?.appearanceIdentity || null,
                        detailWidth: material.userData?.surfaceDetailWidth || null,
                        visible: visible(object), drawn: drawn.has(object.uuid) });
                }
            }
        });
        return rows;
    }
    const metadata = () => ({ frame, stage, focus: window.exploredQA?.state.G.focus,
        host: window.__exploredCurrentSystem?.starId || null,
        camera: camera.position.toArray(), target: window.exploredQA?.s.cam.tgt.toArray(),
        distance: window.exploredQA?.s.cam.dist, gpu: { ...renderer.info.memory } });
    function compare(prior, after, boundary, timing = null) {
        for (const [id, row] of after) {
            const previous = prior.get(id);
            if (row.gpuHandle && (row.gpuHandle !== previous?.gpuHandle || row.uploadedVersion !== previous?.uploadedVersion))
                append(events, { ...metadata(), boundary, timing, kind: !previous?.gpuHandle ? 'first-allocation' : row.gpuHandle !== previous.gpuHandle ? 'new-handle' : 'version-upload', before: previous || null, after: row });
        }
    }
    const tracker = {
        start() { active = true; stage = 'same-host-entry'; frame = 0; last = census(); },
        mark(value) { stage = value; },
        checkpoint(value) { append(checkpoints, { ...metadata(), name: value, textures: [...census().values()] }); },
        beforeFrame() { if (!active) return; frame++; drawn.clear(); before = census(); compare(last, before, 'between-frames'); },
        afterFrame(timing) {
            if (!active) return;
            const after = census(), meta = metadata();
            append(frames, { ...meta, timing });
            compare(before, after, 'production-frame', timing); last = after;
        },
        stop() {
            active = false;
            for (const [object, previous] of callbacks) object.onAfterRender = previous;
            callbacks.clear();
            return { limit: LIMIT, truncated, events, frames, checkpoints,
                timingScope: 'Diagnostic instrumentation only. Census runs outside reported frame timing; draw callbacks add tracking overhead. These samples never replace the original acceptance measurements.' };
        },
    };
    window.__textureUploadTracker = tracker;
    return tracker;
}
