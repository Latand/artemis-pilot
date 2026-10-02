// This fixture catalog is shared by current and baseline captures. Distances
// are centre-to-camera radii (r_s for holes), never guessed scene units.
export function celestialCases({ suite = 'all', baseline = false } = {}) {
    const bodies = [
        { name: 'earth-day', body: 'EARTH', radii: 4.3 },
        { name: 'earth-low', body: 'EARTH', radii: 1.32 },
        { name: 'moon', body: 'MOON', radii: 4.3 },
        ...['MERCURY', 'VENUS', 'MARS', 'JUPITER', 'SATURN', 'URANUS', 'NEPTUNE'].map(body =>
            ({ name: body.toLowerCase(), body, radii: body === 'SATURN' ? 7 : 4.3 })),
        ...['IO', 'EUROPA', 'TITAN', 'IAPETUS'].map(body => ({ name: body.toLowerCase(), body, radii: 4.3 })),
        { name: 'iapetus-boundary', body: 'IAPETUS', radii: 4.3, yaw: -2.6707963268, pitch: .12 },
        { name: 'iapetus-close-boundary', body: 'IAPETUS', radii: 1.85, yaw: -2.6707963268, pitch: .06 },
        { name: 'io-close', body: 'IO', radii: 1.85 },
        { name: 'europa-close', body: 'EUROPA', radii: 1.85 },
        { name: 'unknown-system-planet', body: 'unknown-planet', radii: 4.3 },
        { name: 'unknown-system-moon', body: 'unknown-moon', radii: 4.3 },
    ].map(s => ({ ...s, suite: 'bodies' }));
    const stars = [
        ['cool', 'PROXIMA'], ['solar', 'SUN'], ['hot', 'SIRIUS A'], ['giant', 'BETELGEUSE'],
    ].flatMap(([type, body]) => [4.3, body === 'SUN' ? 1.3 : 1.85].map(radii =>
        ({ name: `${type}-${radii < 2 ? 'close' : 'disc'}`, body, radii, suite: 'stars' })));
    const angles = [{ angle: 'front', pitch: 1.42 }, { angle: 'tilted', pitch: .48 }, { angle: 'edge', pitch: .015 }];
    const distances = baseline ? [45, 8, 2.7] : [45, 8, 2.7, 1.06];
    const holes = distances.flatMap(radii => angles.map(a =>
        ({ name: `sgr-a-${radii}rs-${a.angle}`, body: 'SGR A*', radii, ...a, suite: 'holes' })));
    holes.push(...distances.map(radii =>
        ({ name: `quasar-${radii}rs-tilted`, body: 'placed-quasar', radii, pitch: .48, suite: 'holes' })),
        ...[angles[0], angles[2]].map(a =>
            ({ name: `quasar-45rs-${a.angle}`, body: 'placed-quasar', radii: 45, ...a, suite: 'holes' })),
        { name: 'gaia-bh1-8rs-dormant', body: 'GAIA BH1', radii: 8, pitch: .48, suite: 'holes' });
    if (!baseline) holes.push({ name: 'gaia-bh1-1.06rs-dormant', body: 'GAIA BH1', radii: 1.06, pitch: .48, suite: 'holes' },
        ...['SGR A*', 'placed-quasar'].map(body => ({ name: `${body.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-1.06rs-rim-diagnostic`,
            body, radii: 1.06, pitch: .48, lookAway: 2.52, diagnosticSky: true, suite: 'holes' })));
    if (!baseline) holes.push({ name: 'sgr-a-1.06rs-rim-production-sky', body: 'SGR A*', radii: 1.06, pitch: .48, lookAway: 2.52, fov: 70, suite: 'holes' });
    if (!['all', 'bodies', 'stars', 'holes'].includes(suite)) throw new Error(`Unknown SUITE: ${suite}`);
    const baselineMechanisms = new Set(['sgr-a-45rs-tilted', 'sgr-a-8rs-tilted', 'sgr-a-2.7rs-tilted', 'sgr-a-2.7rs-edge', 'quasar-8rs-tilted', 'quasar-45rs-edge']);
    return [...bodies, ...stars, ...holes].filter(s => (suite === 'all' || s.suite === suite) &&
        (!baseline || s.suite !== 'holes' || baselineMechanisms.has(s.name)));
}

function replaceOnce(source, from, to, label) {
    if (source.split(from).length !== 2) throw new Error(`Celestial QA hook changed: ${label}`);
    return source.replace(from, to);
}

// Test-server transforms only: production renderer, materials, lights, focus,
// camera clamps, lensing and tone mapping are deliberately untouched.
export function transformCelestialSource(source, id) {
    id = id.replaceAll('\\', '/').split('?')[0];
    if (id.endsWith('/src/main.js')) {
        source = replaceOnce(source, 'initCosmicLayer(farTierGroup);', '// QA: unrelated cosmic background is not initialized.', 'cosmic startup');
        source = replaceOnce(source, 'initMergerTides(farTierGroup, galaxySharedUniforms());', '// QA: no unrelated merger worker.', 'merger startup');
        const exploredHook = 'const focusedSystem = getExploredSystem(G.focus, nearestActiveStar(eph.earthX + G.x, eph.earthY + G.y, G.z).star, G.t);';
        const legacyHook = 'const focusedSystem = systemHost ? getFocusedSystem(systemHost, G.t) : null;';
        const systemHook = source.includes(exploredHook) ? exploredHook : legacyHook;
        source = replaceOnce(source, systemHook, systemHook.replace('= ', '= window.__celestialSystem || (').replace(';', ');'), 'generated-system fixture');
        source = replaceOnce(source, 'const firstFrameT0 = perfStart();',
            'G.t = 0; G.paused = true; resetEphem(); clock.getDelta = () => 1 / 60;\nconst firstFrameT0 = perfStart();', 'first frame');
        source = replaceOnce(source, 'renderer.setAnimationLoop(frame);', '// QA: frames are delivered explicitly, not by wall-clock timing.', 'animation loop');
        return source + `\nwindow.__celestialFrame = () => { lastMobileFrame = -Infinity; frameNo = 11; frame(); };
window.__celestialEnsureLensing = ensureLensingModule;
window.__celestialLensingStatus = () => ({ loaded: !!updateLensingImpl, enabled: !!lensingPass.enabled });\n`;
    }
    if (id.endsWith('/src/render/systemBodies.js')) return source + '\nexport const celestialQaSlots = groups;\n';
    if (id.endsWith('/src/render/catalogStars.js')) {
        return replaceOnce(source, 'const start = () => loadTier0();', 'const start = () => {}; // QA: named points remain, 119k background catalog omitted.', 'catalog background');
    }
    return null;
}
