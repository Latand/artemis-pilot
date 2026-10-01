// Pure deterministic, seam-free texture synthesis. Kept independent of DOM and
// Three.js so the actual maps can be exercised by Node smoke tests.
import { bodyAppearanceSeed } from './bodyAppearanceProfiles.js';
const TAU = 2 * Math.PI;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const rgb = hex => [hex >> 16 & 255, hex >> 8 & 255, hex & 255];
function random(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function noise3(seed) {
    function hash(x, y, z) { let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ seed; n = Math.imul(n ^ n >>> 13, 1274126177); return ((n ^ n >>> 16) >>> 0) / 4294967296; }
    return (x, y, z) => {
        const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
        let a = x - ix, b = y - iy, c = z - iz;
        a *= a * (3 - 2 * a); b *= b * (3 - 2 * b); c *= c * (3 - 2 * c);
        const x00 = hash(ix, iy, iz) * (1 - a) + hash(ix + 1, iy, iz) * a;
        const x10 = hash(ix, iy + 1, iz) * (1 - a) + hash(ix + 1, iy + 1, iz) * a;
        const x01 = hash(ix, iy, iz + 1) * (1 - a) + hash(ix + 1, iy, iz + 1) * a;
        const x11 = hash(ix, iy + 1, iz + 1) * (1 - a) + hash(ix + 1, iy + 1, iz + 1) * a;
        return ((x00 * (1 - b) + x10 * b) * (1 - c) + (x01 * (1 - b) + x11 * b) * c);
    };
}

export function generateBodySurfaceMaps(profile, width = 512) {
    if (!Number.isInteger(width) || width < 32 || width > 2048 || width % 2) throw new RangeError('Surface width must be an even integer from 32 to 2048');
    const height = width / 2, size = width * height;
    const color = new Uint8Array(size * 4), elevation = new Float32Array(size), normal = new Uint8Array(size * 4);
    const base = rgb(profile.color), fracture = rgb(profile.fractureColor ?? 0x8f8977);
    const seed = profile.seed ?? bodyAppearanceSeed(profile.name || profile.kind);
    const n = noise3(seed), rng = random(seed ^ 0x75d21a);
    const phase = rng() * TAU;
    const sinLon = new Float32Array(width), cosLon = new Float32Array(width);
    for (let x = 0; x < width; x++) { sinLon[x] = Math.sin(x / width * TAU); cosLon[x] = Math.cos(x / width * TAU); }
    for (let y = 0; y < height; y++) {
        // End rows are exact poles. All longitude samples collapse there.
        const lat = Math.PI * (.5 - y / (height - 1)), sy = Math.sin(lat), cy = Math.cos(lat);
        for (let x = 0; x < width; x++) {
            const sx = cy * cosLon[x], sz = cy * sinLon[x];
            const broad = n(sx * 3.3 + 9, sy * 3.3 + 9, sz * 3.3 + 9);
            const medium = n(sx * 15 + 31, sy * 15 + 31, sz * 15 + 31);
            const fine = n(sx * 63 + 61, sy * 63 + 61, sz * 63 + 61);
            let tone = 1 + (broad - .5) * profile.contrast * 2.7 + (medium - .5) * .09 + (fine - .5) * .035;
            let h = .5 + (medium - .5) * .11 + (fine - .5) * .035;
            let r = base[0], g = base[1], b = base[2];
            const kind = profile.kind;
            if (kind === 'bands' || kind === 'haze') {
                const wave = Math.sin(lat * (profile.bandCount || 9) + (broad - .5) * 3 + .8 * Math.sin(sz * 8 + phase));
                tone = 1 + wave * profile.contrast + (medium - .5) * profile.contrast * .35;
                if (profile.storm) {
                    const q = Math.pow((sx + .38) / .20, 2) + Math.pow((sy + .29) / .10, 2);
                    const storm = (1 - smooth(.4, 1, q)) * smooth(.15, .5, sz);
                    r += storm * 22; g -= storm * 27; b -= storm * 37;
                }
                if (profile.polar) tone *= 1 - .14 * smooth(.65, .96, Math.abs(sy));
            } else if (kind === 'volcanic') {
                const sulfur = smooth(.42, .67, broad);
                r += sulfur * 13; g -= sulfur * 37; b -= sulfur * 42;
                // Interleaved pale deposits break up the broad sulfur field;
                // low-amplitude fine grains remain independent of volcanic pits.
                const pale = smooth(.51, .72, medium + broad * .14) * .55;
                r = r * (1 - pale) + 239 * pale;
                g = g * (1 - pale) + 228 * pale;
                b = b * (1 - pale) + 179 * pale;
                tone += (fine - .5) * .08;
                h *= .3;
            } else if (kind === 'dichotomy') {
                const dark = smooth(-.15, .12, sx + .22 * (medium - .5));
                const c = .19 + .81 * dark;
                r *= c; g *= c; b *= c * .93;
                h += .35 * Math.exp(-Math.pow(sy / .020, 2));
            } else if (kind === 'lunar') {
                const mare = 1 - smooth(.33, .48, broad + .12 * sx);
                tone *= 1 - .45 * mare;
            } else if (kind === 'grooved' || kind === 'coronae') {
                const domain = smooth(.35, .56, broad);
                const line = Math.pow(.5 + .5 * Math.sin((sx * 14 + sy * 11 + sz * 8) * (kind === 'coronae' ? 3 : 7) + medium * 3), 10);
                const grooves = line * (profile.grooves || .8) * domain;
                tone *= 1 - .16 * grooves; h -= grooves * .11;
                if (profile.terrainMix || kind === 'coronae') tone *= .72 + domain * .4;
            } else if (kind === 'fractured') {
                // Warped great-circle families form fractures without UV seams.
                const a = Math.abs(Math.sin(sx * 16 + sy * 11 + sz * 13 + (broad - .5) * 8 + phase));
                const c = Math.abs(Math.sin(sx * 9 - sy * 17 + sz * 14 + (medium - .5) * 1.5));
                // Width includes the texture footprint, so a thin line does
                // not become disconnected dots at the 512-pixel mobile tier.
                const aa = 30 / width;
                let crack = Math.max(1 - smooth(.045, .105 + aa, a), (1 - smooth(.025, .075 + aa, c)) * .65);
                const ridge = Math.exp(-Math.pow((a - .19) / (.045 + aa), 2));
                const chaos = smooth(.55, .69, broad);
                const splinter = Math.abs(Math.sin(sx * 53 + sy * 47 - sz * 61 + medium * 3));
                crack = Math.max(crack, (1 - smooth(.03, .09 + aa, splinter)) * chaos * .30);
                h += ridge * .035;
                tone -= chaos * (medium - .35) * .10;
                if (profile.southStripes) {
                    crack *= .08;
                    crack = Math.max(crack, (1 - smooth(.02, .12, Math.abs(Math.sin(sx * 28 + sz * 12)))) * smooth(.64, .88, -sy));
                }
                r = r * (1 - crack * .7) + fracture[0] * crack * .7;
                g = g * (1 - crack * .7) + fracture[1] * crack * .7;
                b = b * (1 - crack * .7) + fracture[2] * crack * .7;
                h -= crack * (profile.canyon ? .25 : .09);
            } else if (kind === 'frost') {
                const cells = smooth(.42, .52, medium) - smooth(.55, .66, medium);
                tone -= cells * .1; h += cells * .035;
                const cap = smooth(.2, .65, -sy + (broad - .5) * .35);
                r += cap * 20; g += cap * 18; b += cap * 15;
            } else if (kind === 'ocean') {
                const land = smooth(.48, .53, broad);
                r = 31 * (1 - land) + (94 + medium * 30) * land;
                g = 67 * (1 - land) + (108 + medium * 22) * land;
                b = 104 * (1 - land) + (72 + medium * 20) * land;
                h = .5 + land * (medium - .3) * .12;
                const cloud = smooth(.65, .80, medium + broad * .15) * .7;
                r = r * (1 - cloud) + 226 * cloud; g = g * (1 - cloud) + 229 * cloud; b = b * (1 - cloud) + 226 * cloud;
            }
            if (profile.polar && kind !== 'haze' && kind !== 'frost') {
                const ice = smooth(.91, .985, Math.abs(sy) + (broad - .5) * .03);
                r = r * (1 - ice) + 220 * ice; g = g * (1 - ice) + 221 * ice; b = b * (1 - ice) + 211 * ice;
            }
            const i = y * width + x, k = i * 4;
            color[k] = clamp(r * tone, 0, 255); color[k + 1] = clamp(g * tone, 0, 255); color[k + 2] = clamp(b * tone, 0, 255); color[k + 3] = 255;
            elevation[i] = h;
        }
    }
    // Crater diameter and relief share a physical angular metric. Each stamp
    // wraps at the dateline and narrows with cos(latitude), avoiding stretched
    // equatorial craters. The polar caps retain the seamless 3D field.
    function stamp(cx, cy, radius, major = false, volcano = false) {
        const stretch = 1 / Math.max(.14, Math.cos((cy / (height - 1) - .5) * Math.PI));
        const ry = radius, rx = radius * stretch;
        const ventPhase = volcano ? rng() * TAU : 0;
        const ventStretch = volcano ? .65 + rng() * .7 : 1;
        const extent = volcano ? 2.4 : 1.5;
        for (let y = Math.max(1, Math.floor(cy - ry * extent)); y <= Math.min(height - 2, Math.ceil(cy + ry * extent)); y++) {
            for (let dx = -Math.ceil(rx * extent); dx <= Math.ceil(rx * extent); dx++) {
                const x = ((Math.floor(cx + dx) % width) + width) % width;
                const vx = dx / rx, vy = (y - cy) / ry;
                const angle = Math.atan2(vy, vx);
                const irregular = volcano ? 1 + .16 * Math.sin(angle * 3 + ventPhase) + .09 * Math.sin(angle * 7 - ventPhase) : 1;
                const q = Math.hypot(vx / ventStretch, vy) / irregular;
                if (q > 1.45) continue;
                const i = y * width + x, k = i * 4;
                if (volcano) {
                    const caldera = 1 - smooth(.24, .55, q);
                    const sulfur = Math.exp(-Math.pow((q - .88) / .27, 2)) * (.65 + .35 * Math.sin(angle * 2 + ventPhase));
                    color[k] = clamp(color[k] * (1 - .78 * caldera) + sulfur * 13, 0, 255);
                    color[k + 1] *= 1 - .80 * caldera - .26 * sulfur;
                    color[k + 2] *= 1 - .65 * caldera - .15 * sulfur;
                    elevation[i] -= caldera * .12;
                } else {
                    const bowl = (1 - smooth(.15, .91, q)), rim = Math.exp(-Math.pow((q - .92) / .095, 2));
                    const ray = Math.exp(-Math.pow((q - 1.12) / .3, 2));
                    elevation[i] += (rim * .16 - bowl * .28) * (major ? 1.6 : .6 + radius / height * 4);
                    const shade = 1 - .075 * bowl + ray * (profile.brightEjecta ? .65 : .11);
                    color[k] = clamp(color[k] * shade, 0, 255); color[k + 1] = clamp(color[k + 1] * shade, 0, 255); color[k + 2] = clamp(color[k + 2] * shade, 0, 255);
                }
            }
        }
    }
    const volcano = profile.kind === 'volcanic';
    for (let j = 0; j < (volcano ? 145 : profile.craters || 0); j++) {
        const x = rng() * width, cy = (Math.acos(rng() * 1.8 - .9) / Math.PI) * (height - 1);
        const rad = height * (.003 + Math.pow(rng(), 3) * (volcano ? .023 : .034));
        stamp(x, cy, rad, false, volcano);
    }
    if (profile.basin) stamp(width * .54, height * .47, height * profile.basin / Math.PI, true);
    if (profile.saltSpots) {
        // Reflective carbonate-like albedo spots, not emissive lights and not
        // height peaks. Their seeded positions are expressly illustrative.
        for (let j = 0; j < 5; j++) {
            const cx = rng() * width, cy = height * (.22 + rng() * .56), r = height * .006;
            for (let y = Math.floor(cy - r * 2); y <= Math.ceil(cy + r * 2); y++) {
                for (let xx = Math.floor(cx - r * 2); xx <= Math.ceil(cx + r * 2); xx++) {
                    const x = (xx + width) % width, k = (y * width + x) * 4;
                    const q = Math.hypot((xx - cx) * Math.cos((cy / height - .5) * Math.PI), y - cy) / r;
                    const salt = Math.exp(-q * q * 1.5) * .8;
                    for (let c = 0; c < 3; c++) color[k + c] = color[k + c] * (1 - salt) + 220 * salt;
                }
            }
        }
    }
    // A separate normal map from the synthetic height field. Never use
    // albedo as elevation: dark maria, sulfur and frost are not depressions.
    const relief = profile.relief || 0;
    for (let y = 0; y < height; y++) {
        const cosLat = Math.max(.04, Math.cos(Math.PI * (.5 - y / (height - 1))));
        for (let x = 0; x < width; x++) {
            const xm = (x + width - 1) % width, xp = (x + 1) % width;
            const ym = Math.max(0, y - 1), yp = Math.min(height - 1, y + 1);
            let nx = -(elevation[y * width + xp] - elevation[y * width + xm]) * relief * width / (2 * TAU * cosLat);
            let ny = (elevation[yp * width + x] - elevation[ym * width + x]) * relief * height / (2 * Math.PI);
            if (y === 0 || y === height - 1) { nx = 0; ny = 0; }
            const len = Math.hypot(nx, ny, 1), k = (y * width + x) * 4;
            normal[k] = Math.round((nx / len * .5 + .5) * 255); normal[k + 1] = Math.round((ny / len * .5 + .5) * 255);
            normal[k + 2] = Math.round((1 / len * .5 + .5) * 255); normal[k + 3] = 255;
        }
    }
    return { width, height, color, normal, elevation, seed, provenance: profile.provenance };
}
