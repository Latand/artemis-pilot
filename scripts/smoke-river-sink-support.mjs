import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { blackHoleSinkOuter } from '../src/riverSinkMath.js';
import { spawnReach } from '../src/riverMath.js';
import { C_LIGHT, MU_S, FLOW } from '../src/constants.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
for (const radius of [16, 100, 1000, 1e4, 1e5, 1e6, 1.2e8]) {
    for (const sink of [.000001, .01, 1, 100, 1e4, 1e6]) {
        const core = Math.max(sink, Math.min(Math.max(radius * .0008, .45), 64));
        for (const samplingRadius of [radius, radius * 10]) {
            const reach = spawnReach(core, 0, samplingRadius);
            for (const multiple of [8, 9]) {
                const outer = blackHoleSinkOuter(core, reach, multiple);
                assert(outer > core * .9, 'strictly ordered smoothstep even for resolved/oversized horizons');
                assert(outer <= reach * .5, 'outer half of sampled halo clears the sink transition');
                assert.equal(smooth(core * .9, outer, reach), 1);
            }
        }
    }
}
function meanFade(legacy) {
    const radius = 1e5, core = 64, reach = spawnReach(core, 0, radius);
    const outer = legacy ? Math.max(core * 9, radius * .13) : blackHoleSinkOuter(core, reach, 9);
    let sum = 0;
    for (let i = 0; i < 10000; i++) {
        const r = core * 1.2 + (reach - core * 1.2) * ((i + .5) / 10000) ** 1.6;
        sum += smooth(core * .9, outer, r) / 10000;
    }
    return sum;
}
assert(meanFade(false) > .5, 'representative owned samples remain visible outside the exclusion core');
assert(meanFade(true) < .02, 'old whole-volume fade is a failing negative control');

const source = readFileSync(new URL('../src/river.js', import.meta.url), 'utf8');
const base = execFileSync('git', ['show', '2cde3de63015ea721364471736d82a21726af4e4:src/river.js'], { encoding: 'utf8' });
const literal = (text, name) => text.match(new RegExp('const ' + name + ' = /\\* glsl \\*/`([\\s\\S]*?)`;'))?.[1];
for (const name of ['FLOW_GLSL', 'COMPUTE_FRAG']) assert.equal(literal(source, name), literal(base, name), `${name}: unchanged physical field, sampling, capture and advection`);
assert(source.includes('${BLACK_HOLE_SINK_GLSL}'));
assert(source.includes('blackHoleSinkOuter(bhCore, bhReach, 9.0)'));
assert(source.includes('blackHoleSinkOuter(bhCore, bhReach, 8.0)'));
assert(!source.includes('max(bhCore * 9.0, uRadius * 0.13)'));
assert(!source.includes('max(bhCore * 8.0, uRadius * 0.08)'));
const massRatio = 10 * C_LIGHT ** 2 / 2 / MU_S;
const coefficient = .001 * Math.sqrt(10 * C_LIGHT ** 2 / 1000);
assert(Math.abs(coefficient / FLOW.CS - Math.sqrt(massRatio)) < 1e-12);
console.log(JSON.stringify({ test: 'BH source-local sink support', legacyMeanFade: meanFade(true), currentMeanFade: meanFade(false), massRatio, flowRatio: coefficient / FLOW.CS }));
