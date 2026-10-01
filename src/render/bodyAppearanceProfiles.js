// Rendering recipes, never ephemeris or physical-shape data. All relief and
// unsurveyed terrain are deterministic illustrations, not recovered topography.
const observedMap = 'Solar System Scope 2k artistic mosaic, CC BY 4.0; modified display rendering';
const inferred = 'Deterministic terrain illustration informed by observed surface classes; feature locations are not cartographic';
const unknown = 'Illustrative appearance only; no resolved global surface map is known';
const profile = (kind, color, options = {}) => ({
    kind, color, relief: .002, craters: 100, contrast: .15, roughness: .96,
    provenance: inferred, mapSaturation: 1, ...options,
});

export const BODY_APPEARANCES = Object.freeze({
    EARTH: profile('ocean', 0x386a96, { craters: 0, relief: .0008, provenance: observedMap }),
    MOON: profile('lunar', 0xb9b7b1, { craters: 230, relief: .004, contrast: .22, provenance: observedMap }),
    MERCURY: profile('cratered', 0xa39a8c, { craters: 260, relief: .004, provenance: observedMap }),
    VENUS: profile('haze', 0xe4d5ab, { craters: 0, relief: 0, contrast: .055, provenance: observedMap }),
    MARS: profile('desert', 0xc27e58, { craters: 90, relief: .003, contrast: .25, polar: true, provenance: observedMap }),
    JUPITER: profile('bands', 0xcbb28e, { craters: 0, relief: 0, contrast: .22, bandCount: 22, storm: true, provenance: observedMap }),
    SATURN: profile('bands', 0xdaca9f, { craters: 0, relief: 0, contrast: .10, bandCount: 30, provenance: observedMap }),
    URANUS: profile('bands', 0xa5cace, { craters: 0, relief: 0, contrast: .035, bandCount: 14, mapSaturation: .7, provenance: observedMap }),
    NEPTUNE: profile('bands', 0x86b7c3, { craters: 0, relief: 0, contrast: .085, bandCount: 18, mapSaturation: .3, photoTint: 0xbde6e5, provenance: observedMap }),
    PHOBOS: profile('grooved', 0x837b70, { craters: 90, relief: .016, grooves: .4, basin: .24, contrast: .14 }),
    DEIMOS: profile('cratered', 0x9d9383, { craters: 35, relief: .005, contrast: .08 }),
    IO: profile('volcanic', 0xe0cf79, { craters: 0, relief: .0012, contrast: .23 }),
    EUROPA: profile('fractured', 0xd9d1b6, { craters: 7, relief: .0007, fractureColor: 0x92684c, contrast: .10 }),
    GANYMEDE: profile('grooved', 0xa89e8b, { craters: 95, relief: .002, grooves: .85, terrainMix: true, contrast: .30 }),
    CALLISTO: profile('cratered', 0x786f60, { craters: 360, relief: .003, brightEjecta: true, contrast: .26 }),
    MIMAS: profile('cratered', 0xbfc0b8, { craters: 190, relief: .010, basin: .34, contrast: .13 }),
    ENCELADUS: profile('fractured', 0xe7e9e4, { craters: 25, relief: .002, southStripes: true, fractureColor: 0xb4c4c6, contrast: .045 }),
    TETHYS: profile('fractured', 0xd1d2c9, { craters: 145, relief: .007, basin: .32, canyon: true, fractureColor: 0x9da49f, contrast: .12 }),
    DIONE: profile('fractured', 0xbdbcb2, { craters: 160, relief: .004, fractureColor: 0xe2e4db, contrast: .16 }),
    RHEA: profile('cratered', 0xc7c6bb, { craters: 260, relief: .004, contrast: .14 }),
    TITAN: profile('haze', 0xd3aa61, { craters: 0, relief: 0, contrast: .065, polar: true }),
    IAPETUS: profile('dichotomy', 0xd2cec0, { craters: 150, relief: .008, ridge: true, contrast: .15 }),
    MIRANDA: profile('coronae', 0xbcc0b9, { craters: 90, relief: .009, contrast: .19 }),
    ARIEL: profile('fractured', 0xc1c3ba, { craters: 95, relief: .005, canyon: true, fractureColor: 0x858f8c, contrast: .14 }),
    UMBRIEL: profile('cratered', 0x827f76, { craters: 200, relief: .004, brightEjecta: true, contrast: .15 }),
    TITANIA: profile('fractured', 0xb7b4a9, { craters: 170, relief: .004, canyon: true, fractureColor: 0x878b84, contrast: .16 }),
    OBERON: profile('cratered', 0xaaa497, { craters: 220, relief: .005, brightEjecta: true, contrast: .19 }),
    TRITON: profile('frost', 0xd2c8bd, { craters: 12, relief: .0015, polar: true, contrast: .14 }),
    PROTEUS: profile('cratered', 0x85837c, { craters: 150, relief: .009, basin: .22, contrast: .19 }),
    NEREID: profile('cratered', 0x98998f, { craters: 100, relief: .004, contrast: .12, provenance: unknown }),
    CERES: profile('cratered', 0x8d8a81, { craters: 200, relief: .005, contrast: .16, saltSpots: true }),
});

export function bodyAppearanceSeed(identity) {
    // FNV-1a: stable body identity, independent of slot order and visit order.
    let h = 2166136261;
    for (const ch of String(identity)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

export function getBodyAppearance(body, identity = '') {
    const name = String(typeof body === 'string' ? body : body?.name || '').toUpperCase();
    const known = BODY_APPEARANCES[name];
    const seed = bodyAppearanceSeed(identity || name || 'unnamed-body');
    if (known) return { ...known, name, seed, id: identity || name };
    const type = body?.type || (body?.gas ? 'gas' : body?.R ? 'moon' : 'rocky');
    const kind = ({ gas: 'bands', 'hot-jupiter': 'bands', 'sub-neptune': 'haze', ice: 'frost', ocean: 'ocean', desert: 'desert', moon: 'cratered' })[type] || 'cratered';
    const gas = kind === 'bands' || kind === 'haze';
    return {
        ...profile(kind, body?.color ?? 0xaaa397, {
            craters: gas || kind === 'ocean' ? 0 : 120,
            relief: gas ? 0 : .003, contrast: kind === 'haze' ? .06 : .20,
            bandCount: 12 + seed % 18, storm: gas && seed % 3 === 0,
            polar: kind === 'frost' || kind === 'ocean', provenance: unknown,
        }), name: name || 'ILLUSTRATIVE BODY', seed, id: identity || name,
    };
}
