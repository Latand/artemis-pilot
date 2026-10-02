// The identical HEAD-owned fixtures and transforms run against both revisions.
export const EPOCH_GYR = 2.9687;
export function externalGalaxyCases(suite = 'all') {
    const m31 = [
        { name: 'm31-normal', view: 'catalog', height: 22 },
        { name: 'm31-close', view: 'face', height: 3.2, roll: .61 },
        { name: 'm31-edge-on', view: 'edge', height: 8, roll: .37 },
        { name: 'm31-off-axis', view: 'offaxis', height: 2.2, aim: 3.1, roll: .61 },
        { name: 'm31-center-behind', view: 'behind', height: .12, radius: 1.8 },
        { name: 'm31-user-epoch', view: 'catalog', distanceKpc: 455 / 3.261563777, epochGyr: EPOCH_GYR },
    ].map(t => ({ ...t, suite: 'm31', target: 'Andromeda' }));
    const zoom = [80, 24, 8, 3, 1, .25, .04].map(height => ({ name: `m31-zoom-${String(height).replace('.', 'p')}h`,
        suite: 'zoom', target: 'Andromeda', view: 'diskpatch', height, radius: 1.8, roll: .31 }));
    const catalog = [
        { target: 'NGC 253', family: 'spiral' },
        { target: 'NGC 5128', family: 'elliptical' },
        { target: 'NGC 6822', family: 'irregular' },
    ].flatMap(t => [6000, 24, 3].map(height => ({ ...t, suite: 'catalog', view: 'face', height,
        name: `${t.family}-${height === 6000 ? 'point' : height === 24 ? 'normal' : 'close'}`, roll: .41 })));
    if (!['all', 'm31', 'zoom', 'catalog'].includes(suite)) throw new Error(`Unknown SUITE ${suite}`);
    return [...m31, ...zoom, ...catalog].filter(t => suite === 'all' || t.suite === suite);
}
const replaceOnce = (text, a, b, label) => {
    if (text.split(a).length !== 2) throw new Error(`External-galaxy QA hook changed: ${label}`);
    return text.replace(a, b);
};
export function transformExternalGalaxySource(source, id) {
    id = id.replaceAll('\\', '/').split('?')[0];
    if (id.endsWith('/src/main.js')) {
        source = replaceOnce(source, 'initCosmicLayer(farTierGroup);', '// QA: omit unrelated legacy cosmic fallback.', 'legacy cosmic layer');
        source = replaceOnce(source, 'const firstFrameT0 = perfStart();', 'G.t = 0; G.paused = true; resetEphem(); clock.getDelta = () => 1 / 60;\nconst firstFrameT0 = perfStart();', 'initial epoch');
        source = replaceOnce(source, 'renderer.setAnimationLoop(frame);', '// QA: frames are advanced explicitly.', 'animation loop');
        return source + `\nwindow.__externalGalaxyApp = {
            frame() { lastMobileFrame = -Infinity; frameNo = 11; frame(); },
            setEpoch(t) { G.t = t; G.paused = true; resetEphem(); },
            gc: galacticCenterScene,
        };\n`;
    }
    if (id.endsWith('/src/render/galaxyPopulationRender.js')) {
        for (const marker of ['const state =', 'const EXPOSURE =']) if (!source.includes(marker)) throw new Error(`Missing ${marker} QA state`);
        return source + `\nexport function externalGalaxyQaState() { return state; }
        export function externalGalaxyQaResetMeter() { EXPOSURE.fresh = true; EXPOSURE.frame = 0; EXPOSURE.t = 0; }\n`;
    }
    if (id.endsWith('/src/render/catalogStars.js')) return replaceOnce(source, 'const start = () => loadTier0();', 'const start = () => {}; // QA: omit unrelated HYG background catalog.', 'background stars');
    return null;
}
