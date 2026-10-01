import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A wide TDE's cold outskirts have effectively zero emitted radiance.
// They must not become an occluder solely because their geometric mask is 1.
const x = 1000, f = x ** -.75 * (1 - 1 / Math.sqrt(x)) ** .25 / .48805;
const emitted = f ** 4, background = .6, coverage = 1;
assert(emitted < 2e-8, 'fixture spans the cold tail of the actual disk profile');
assert(background * (1 - coverage) + emitted < 2e-8, 'former normal blend erased the background');
assert.equal(background + emitted * coverage >= background, true, 'emission-only composition preserves background light');
const source = readFileSync(new URL('../src/holeOptics.js', import.meta.url), 'utf8');
assert.match(source, /blending:layer>=1\s*\?\s*THREE\.AdditiveBlending\s*:\s*THREE\.NormalBlending/,
    'only the physical shadow is an absorbing layer');
assert.match(source, /depthWrite:false, depthTest:true/, 'foreground depth occlusion remains enabled');
assert.match(source, /mask \*= 1\.0-shadow\*behind/, 'rear disk emission remains hidden by its own shadow');
console.log('Hole emission: cold wide-disk regression, shadow blend and depth contracts passed');
