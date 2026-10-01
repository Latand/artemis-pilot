// Static Schwarzschild observer convention; rendering controls, not dynamics.
// The event horizon (1 rs), photon sphere (1.5 rs), and distant critical
// impact parameter (sqrt(27)/2 rs) are different quantities.
export const SHADOW_RS = Math.sqrt(27) / 2;
export const MIN_HOLE_OBSERVER_RS = 1.06;
export function shadowAngularRadius(distanceRs) {
    const d = Math.max(1 + 1e-9, distanceRs);
    const a = Math.asin(Math.min(1, SHADOW_RS / d * Math.sqrt(1 - 1 / d)));
    return d >= 1.5 ? a : Math.PI - a;
}
export function namedHoleAppearance(star) {
    const name = String(star.name || '').toUpperCase();
    if (name === 'SGR A*') return { diskOn:true, TmaxK:6500, gain:.24, routOverRin:9, jetOn:false, label:'Illustrative radio-emission structure; Sgr A* is optically obscured and weakly accreting' };
    if (name === 'CYGNUS X-1') return { diskOn:true, TmaxK:1e7, gain:1.1, routOverRin:24, jetOn:false, label:'Illustrative exposed accretion disk; most thermal emission is in X-rays' };
    return { diskOn:false, TmaxK:0, gain:0, routOverRin:8, jetOn:false, label:'Dormant black hole: no invented luminous disk or jet' };
}
