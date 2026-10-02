import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeLocalVolume } from '../src/universe/galaxyCatalogs.js';
import { externalGalaxyCases, transformExternalGalaxySource, EPOCH_GYR } from './external-galaxy-fixtures.mjs';
const cases = externalGalaxyCases(), ids = new Set(cases.map(t => t.name));
assert.equal(cases.length, 22); assert.equal(ids.size, cases.length);
assert.deepEqual(['m31', 'zoom', 'catalog'].map(s => externalGalaxyCases(s).length), [6, 7, 9]);
assert.throws(() => externalGalaxyCases('missing'));
const lv = decodeLocalVolume(readFileSync(new URL('../public/data/local-volume.json', import.meta.url), 'utf8'));
for (const name of new Set(cases.map(t => t.target))) assert(lv.some(g => g.displayName === name), `Missing real catalog galaxy ${name}`);
for (const [target, family] of [['NGC 253', 'spiral'], ['NGC 5128', 'elliptical'], ['NGC 6822', 'irregular']]) {
    const g = lv.find(g => g.displayName === target);
    assert(family === 'spiral' ? g.type > 0 && g.type < 8.5 : family === 'elliptical' ? g.type <= 0 : g.type >= 8.5, `${target} catalog type changed`);
}
assert.equal(cases.find(t => t.name === 'm31-user-epoch').epochGyr, EPOCH_GYR);
assert(cases.some(t => t.view === 'behind'));
assert(cases.some(t => t.view === 'offaxis'));
const zoom = externalGalaxyCases('zoom');
assert(zoom[0].height >= 80 && zoom.at(-1).height <= .04);
assert(zoom.every((t, i) => !i || t.height < zoom[i - 1].height));
for (const file of ['src/main.js', 'src/render/galaxyPopulationRender.js', 'src/render/catalogStars.js']) {
    const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert(transformExternalGalaxySource(src, '/repo/' + file));
}
assert.throws(() => transformExternalGalaxySource('changed source', '/repo/src/main.js'));
assert.equal(transformExternalGalaxySource('untouched', '/repo/src/unrelated.js'), null);
console.log('PASS external-galaxy QA: 22 unique real-catalog fixtures, morphology families, present/user epochs, center-behind/off-axis and on-disk zoom, fail-closed transforms');
