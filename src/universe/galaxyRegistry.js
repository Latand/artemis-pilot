// Persistent galaxy coordinates. Runtime star physics uses coordinate time;
// the distant diffuse-light renderer retains its separate past-light-cone time.
import { PC_KM, galToWorldKmFromInto } from './coords.js';
import { solarGalacticStateAt } from './solarOrbit.js';
import { andromedaOffsetMpc } from './localGroupOrbit.js';
import { andromedaDiskFrame, milkyWayDiskFrame } from './mergerTides.js';

export const GALAXIES = Object.freeze([
    Object.freeze({ id: 'mw', name: 'Milky Way', radiusPc: 20000, scalePc: 2600, heightPc: 300, frame: milkyWayDiskFrame() }),
    Object.freeze({ id: 'm31', name: 'Andromeda', radiusPc: 30000, scalePc: 5300, heightPc: 600, frame: andromedaDiskFrame() }),
]);
export function galaxyById(id) { return GALAXIES.find(g => g.id === id) || null; }
export function galaxyCenterKm(id, t, out = [0, 0, 0]) {
    const galaxy = galaxyById(id);
    if (!galaxy) return null;
    const sun = solarGalacticStateAt(t);
    galToWorldKmFromInto(0, 0, 0, sun.x, sun.y, sun.z, out);
    if (id === 'm31') {
        const delta = andromedaOffsetMpc(t);
        for (let i = 0; i < 3; i++) out[i] += delta[i] * 1e6 * PC_KM;
    }
    return out;
}
export function galaxyLocalPc(id, world, t, out = [0, 0, 0]) {
    const g = galaxyById(id), c = galaxyCenterKm(id, t);
    if (!g || !c) return null;
    const d = world.map((v, i) => (v - c[i]) / PC_KM);
    for (const [i, axis] of [g.frame.e1, g.frame.e2, g.frame.n].entries()) out[i] = d.reduce((s, v, j) => s + v * axis[j], 0);
    return out;
}
export function galaxyWorldKm(id, localPc, t, out = [0, 0, 0]) {
    const g = galaxyById(id);
    if (!g || !galaxyCenterKm(id, t, out)) return null;
    for (let i = 0; i < 3; i++) out[i] += PC_KM * (g.frame.e1[i] * localPc[0] + g.frame.e2[i] * localPc[1] + g.frame.n[i] * localPc[2]);
    return out;
}
export function galaxyAt(world, t) {
    for (const g of GALAXIES) {
        const p = galaxyLocalPc(g.id, world, t);
        if (Math.hypot(p[0], p[1]) < g.radiusPc && Math.abs(p[2]) < g.heightPc * 6) return g;
    }
    return null;
}
