// Display policy only: camera-normalized coordinates keep the flow finite
// from hundreds of AU to the galaxy web. It never changes world dynamics.
export function largeScaleFlowBlend(distance) {
    const t = Math.max(0, Math.min(1, Math.log(Math.max(1, distance) / 8e6) / Math.log(5)));
    return t * t * (3 - 2 * t);
}

export function flowPulseRate(simRate, crossingSeconds) {
    if (!(simRate > 0)) return 0;
    // Perceptual floor preserves the illustration at 1x; response saturates
    // before temporal aliasing. Speed is qualitative, not a clock reading.
    const advance = simRate / Math.max(1, crossingSeconds);
    return .12 + .9 * advance / (.15 + advance);
}

export function flowMassFromMagnitude(mv) {
    // Approximate stellar M/L = 2, explicitly a visualization estimate for
    // catalog galaxies without measured dynamical masses.
    return 2 * 10 ** (-.4 * (mv - 4.83));
}

export function coarsenGalaxyWells(wells, scale, origin) {
    const cell = scale * .12;
    const groups = new Map();
    for (const w of wells) {
        const key = [w.x-origin.x,w.y-origin.y,w.z-origin.z].map(v=>Math.floor(v/cell)).join(',');
        const g = groups.get(key) || {x:0,y:0,z:0,mass:0,core:0,members:0,groupKey:key,label:w.label,dominantMass:0};
        const mass = g.mass + w.mass;
        const weight = w.mass / mass;
        g.x += (w.x-g.x)*weight; g.y += (w.y-g.y)*weight; g.z += (w.z-g.z)*weight;
        g.mass = mass; g.core = Math.max(g.core,w.core); g.members++;
        if (w.mass > g.dominantMass) { g.label = w.label; g.dominantMass = w.mass; }
        groups.set(key,g);
    }
    return [...groups.values()].map(g=>({...g,core:Math.max(g.core,g.members>1 ? cell*.35 : 0),
        score:g.mass/Math.max((scale*.12)**2,(g.x-origin.x)**2+(g.y-origin.y)**2+(g.z-origin.z)**2)}));
}
