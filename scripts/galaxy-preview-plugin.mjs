// Build-time only. The startup texture is an actual mip of the same full
// model the worker generates. It cannot drift to a different seed or norm.
import { generateGalaxyMaps, packGalaxyMapsHalf, MAP_SEED, MAP_SIZE } from '../src/universe/galaxyMaps.js';
export function buildGalaxyPreview() {
    const packed = packGalaxyMapsHalf(generateGalaxyMaps());
    const levels = packed.levels.filter(level => level.width <= 32);
    const bytes = Buffer.concat(levels.map(level => Buffer.from(level.data.buffer)));
    return { size: 32, sourceSize: MAP_SIZE, seed: MAP_SEED, extentPc: packed.extentPc, norm: packed.norm,
        rgba16: bytes.toString('base64') };
}
export function galaxyPreviewPlugin() {
    const id = 'virtual:galaxy-preview', resolved = '\0' + id;
    let source;
    return {
        name: 'galaxy-model-preview',
        resolveId(value) { if (value === id) return resolved; },
        load(value) {
            if (value !== resolved) return;
            if (!source) source = 'export default ' + JSON.stringify(buildGalaxyPreview()) + ';';
            return source;
        },
        handleHotUpdate(ctx) {
            if (/\/(galaxyMaps|astroConstants|prng)\.js$/.test(ctx.file)) {
                source = undefined;
                const module = ctx.server.moduleGraph.getModuleById(resolved);
                if (module) ctx.server.moduleGraph.invalidateModule(module);
                // Node's build-time generator imports are cached. Restart to
                // rebuild both preview and worker from the edited parameters.
                ctx.server.restart();
                return [];
            }
        },
    };
}
