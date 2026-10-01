// Rendering-only photosphere priors. These are deterministic illustrations of
// stellar atmospheres, NOT resolved observations or measured starspot maps.
// No value here participates in gravity, radii, evolution or point photometry.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const blend = (a, b, t) => a + (b - a) * t;

export function stellarSurfaceSeed(identity = 'SUN') {
    let hash = 2166136261;
    for (const char of String(identity)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return hash >>> 0;
}

export function stellarSurfaceIdentity(star = {}) {
    return star.id || (star.hygIndex !== undefined ? `hyg:${star.hygIndex}` : star.name) || 'SUN';
}

// Only fills the three curated destinations lacking any existing temperature.
// These values remain rendering metadata; none is written into STARS or used
// to invent a missing visual magnitude. The Luhman entry is an unresolved pair.
export const STELLAR_SURFACE_TEMPERATURE_FALLBACKS = Object.freeze({
    'TEEGARDEN': Object.freeze({ tempK: 3034, interpretation: 'Approximate late-M dwarf effective temperature',
        source: 'https://arxiv.org/html/2402.00923v1#S4.SS1' }),
    'LUHMAN 16': Object.freeze({ tempK: 1300, interpretation: 'Representative of unresolved A/B components, 1310±30 K and 1280±75 K',
        source: 'https://arxiv.org/abs/1406.1518' }),
    'WISE 0855-0714': Object.freeze({ tempK: 250, interpretation: 'Approximate value within the reported 225–260 K range; infrared-dominated',
        source: 'https://www.nasa.gov/news-release/nasas-spitzer-and-wise-telescopes-find-close-cold-neighbor-of-sun/' }),
});

export function stellarSurfaceTemperature(star = {}, photometry = null) {
    if (star.tempK > 0 && Number.isFinite(star.tempK)) return star.tempK;
    if (photometry?.tempK > 0) return photometry.tempK;
    return STELLAR_SURFACE_TEMPERATURE_FALLBACKS[star.name]?.tempK || null;
}

export function stellarSurfaceProfile(star = {}) {
    const identity = stellarSurfaceIdentity(star);
    const seed = stellarSurfaceSeed(identity);
    const tempK = Number.isFinite(star.tempK) && star.tempK > 0 ? star.tempK : 5772;
    const radiusSolar = Math.max(0.000001, star.radiusSolar || (star.R > 0 ? star.R / 696340 : 1));
    const kind = String(star.kind || star.spect || star.cls || '').toUpperCase();
    const compact = star.pulsar || kind === 'NS' || radiusSolar < 0.0001;
    const whiteDwarf = !compact && (kind === 'WD' || /^D[ABCOQXZ]/.test(kind) || radiusSolar < 0.05);
    const cool = clamp((5600 - tempK) / 2400, 0, 1);
    const radiative = clamp((tempK - 6800) / 2200, 0, 1);
    const giant = clamp(Math.log10(Math.max(1, radiusSolar)) / 2.6, 0, 1);
    const convectiveGiant = giant * (1 - radiative);
    // Fine dwarf granules only resolve on close approach. Lower-gravity cool
    // giants have broader cells; hot radiative atmospheres remain restrained.
    let granuleScale = blend(blend(580, 320, cool), 5.5, convectiveGiant);
    let granuleContrast = blend(blend(0.24, 0.20, cool), 0.44, convectiveGiant) * (1 - 0.94 * radiative);
    let mesoContrast = blend(0.035 + cool * 0.025, 0.15, convectiveGiant) * (1 - 0.75 * radiative);
    let spotRadius = blend(0.013, 0.048, cool) * (1 - 0.45 * giant);
    let spotStrength = blend(0.57, 0.75, cool) * (1 - radiative) * (1 - 0.75 * giant);
    if (tempK < 1800) {
        // Substellar atmospheric mottling is not a solar umbra/penumbra map.
        granuleScale = 90;
        granuleContrast = 0.10;
        mesoContrast = 0.06;
        spotRadius = 0;
        spotStrength = 0;
    }
    if (whiteDwarf || compact) {
        granuleScale = 1500;
        granuleContrast = compact ? 0 : 0.015;
        mesoContrast = 0;
        spotRadius = 0;
        spotStrength = 0;
    }
    // Below 1500 K optical emission collapses exponentially. This prevents a
    // cold brown dwarf becoming a bright red lamp at the LUT's 1000 K floor.
    const opticalGain = tempK < 1500 ? Math.exp(-26160 * (1 / tempK - 1 / 1500)) : 1;
    let randomState = seed;
    const random = () => {
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
        return randomState / 4294967296;
    };
    const offset = [random() * 97, random() * 97, random() * 97];
    const spots = Array.from({ length: 3 }, () => {
        const longitude = random() * 2 * Math.PI;
        const latitude = (random() - 0.5) * 1.3;
        return [Math.cos(latitude) * Math.cos(longitude), Math.sin(latitude), Math.cos(latitude) * Math.sin(longitude)];
    });
    return {
        identity, seed, tempK, radiusSolar, offset, spots,
        family: compact ? 'compact' : whiteDwarf ? 'white-dwarf' : tempK < 1800 ? 'cool-substellar'
            : radiative > 0.8 ? 'hot-radiative' : convectiveGiant > 0.7 ? 'cool-supergiant'
                : giant > 0.25 ? 'giant' : cool > 0.5 ? 'cool-dwarf' : 'solar-like',
        granuleScale, granuleContrast, mesoScale: blend(26, 2.5, convectiveGiant), mesoContrast,
        spotRadius, spotStrength, opticalGain,
        limbDarkening: whiteDwarf || compact ? 0.42 : blend(0.62 + 0.1 * cool, 0.43, radiative),
        provenance: 'Illustrative, deterministic atmosphere detail; not an observed surface map',
    };
}

// CPU twin of the shader footprint taper, used by regression tests. An octave
// is gone before it can alias; it never turns into a distance-dependent shimmer.
export function stellarDetailWeight(footprint) {
    const t = clamp((footprint - 0.45) / 1.15, 0, 1);
    return 1 - t * t * (3 - 2 * t);
}
