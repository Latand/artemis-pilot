// Check the actual benchmark snippets, without replacing any timed app work.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./benchmark-explored-systems.mjs', import.meta.url), 'utf8');
const functional = readFileSync(new URL('./verify-explored-systems.mjs', import.meta.url), 'utf8');
const qualityLiteral = source.match(/quality:(\{dpr:[^\n]*?\}),warp:G\.warp/)[1];
function quality({ dpr = 1, aa = true, particles = 15376, bloom = false, lensing = false, volume = false } = {}) {
    const result = vm.runInNewContext('(' + qualityLiteral + ')', {
        renderer: { getPixelRatio: () => dpr, getContext: () => ({ getContextAttributes: () => ({ antialias: aa }) }) },
        river: { count: particles }, bloomPass: { enabled: bloom }, lensingPass: { enabled: lensing },
        galaxyVolumeStats: () => ({ enabled: volume }),
    });
    return JSON.parse(JSON.stringify(result));
}
const same = (a, b) => assert.deepEqual(a, b);
same(quality(), quality());
for (const mutation of [{ dpr: .5 }, { aa: false }, { particles: 1024 }, { bloom: true }, { lensing: true }, { volume: true }])
    assert.throws(() => same(quality(), quality(mutation)), 'A different actual render workload must be rejected');
for (const text of [source, functional]) {
    assert(text.includes("quality: 'high'"));
    const initialization = text.match(/if \(frameNo === 0\) frame\(\);/g);
    assert.equal(initialization.length, 1);
    for (const initialFrameNo of [0, 1]) {
        const context = { frameNo: initialFrameNo, draws: 0 };
        vm.createContext(context);
        vm.runInContext('function frame(){frameNo++;draws++;}' + initialization[0], context);
        assert.equal(context.frameNo, 1, 'Both startup models receive exactly one initialization frame');
        assert.equal(context.draws, initialFrameNo ? 0 : 1, 'No extra warmup is added to an already initialized source');
    }
}
assert(source.includes("const orders = ['ABBA', 'BAAB', 'ABBA', 'BAAB', 'ABBA'];"));
assert(source.includes('const samplesPerBlock = 60, warmupFrames = 120;'));
assert(source.includes('scenario.medianPairedRatio <= 1.05'));
assert(source.includes('assert.deepEqual(scenario.before.A.workload, scenario.before.B.workload'));
console.log('Explored fixture: High actual DPR/AA/capacity/passes, six incompatible-quality negatives, equal single initialization, unchanged samples/order/5% budget pass.');
