import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { adaptOverviewBenchmark, materializeOverview, overviewPair } from './diagnose-overview-causal.mjs';
import { installOverviewObservers, installOverviewNativeAudit } from './overview-causal-attribution.mjs';
import { systemRenderStatement } from './explored-system-hooks.mjs';
const original = readFileSync(new URL('./benchmark-explored-systems.mjs', import.meta.url), 'utf8');
const adapted = adaptOverviewBenchmark(original);
let restored = adapted.source.slice(adapted.prefix.length);
for (const { before, after, index } of [...adapted.changes].reverse()) {
    assert.equal(restored.slice(index, index + after.length), after); restored = restored.slice(0, index)+before+restored.slice(index+after.length);
}
assert.equal(restored, original, 'Only declared, reversible diagnostic adaptations');
const section = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));
assert.equal(section(adapted.source, '        for (const [trialIndex, order]', '        scenario.medianPairedRatio'),
    section(original, '        for (const [trialIndex, order]', '        scenario.medianPairedRatio'), 'Original every-frame, every-block and every-trial measurement is byte-identical');
assert.equal(section(adapted.source, '    const beforeLong = ', '    await overviewAttribution('),
    section(original, '    const beforeLong = ', '    // CPU profiling can alter JIT state.'), 'Original long-task thresholds unchanged');
for (const token of ["const samplesPerBlock = 60, warmupFrames = 120;", "const orders = ['ABBA', 'BAAB', 'ABBA', 'BAAB', 'ABBA'];",
    'scenario.medianPairedRatio <= 1.05', 'diagnosticOnly: true, acceptance: false', "{ name: 'system-overview'"]) assert(adapted.source.includes(token));
assert(!adapted.source.includes("{ name: 'earth-near'")); assert(!adapted.source.includes("{ name: 'catalog-star'"));
assert(adapted.source.indexOf('await overviewAttribution(') > adapted.source.indexOf('report.longTaskBudget.passed ='));
for (const bad of [original+'\n', original.replace('samplesPerBlock = 60', 'samplesPerBlock = 1')]) assert.throws(() => adaptOverviewBenchmark(bad));
execFileSync(process.execPath, ['--input-type=module', '--check'], { input: materializeOverview(adapted.source) });
const transformDefinitions = section(original, 'function once(source,', 'for (const tree of [baselineRoot, root])');
const transform = new Function('assert', 'systemRenderStatement', transformDefinitions+';return transform;')(assert, systemRenderStatement);
for (const revision of Object.values(overviewPair)) for (const path of ['src/main.js', 'src/render/catalogStars.js', 'src/render/bodySurfaceMaterial.js']) {
    const source = execFileSync('git', ['show', revision+':'+path], { encoding: 'utf8' });
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: transform(source, '/'+path) });
}
class Style { constructor() { this.values = {}; } getPropertyValue(key) { return this.values[key] || ''; } setProperty(key, value) { this.values[key] = value; return 'forwarded'; } }
class Element { constructor(id) { this.id = id; } getBoundingClientRect() { return { width: 12, height: 20 }; } }
class Observer { constructor(callback) { this.callback = callback; } }
let time = 0, delivered = 0;
const context = { Date: class extends Date {}, localStorage: { setItem() {} }, ResizeObserver: Observer,
    CSSStyleDeclaration: Style, Element, document: { documentElement: { style: new Style() } }, performance: { now: () => ++time } };
context.window = context; vm.runInNewContext(`(${installOverviewObservers.toString()})();`, context);
const observer = new context.ResizeObserver(() => { delivered++; }), target = new Element('explorePanel');
observer.callback([{ target }], observer); assert.equal(delivered, 1); assert.equal(context.__overviewAttribution.callbacks, 0);
context.__overviewAttribution.enabled = true; observer.callback([{ target }], observer);
assert.equal(context.__overviewAttribution.callbacks, 1); assert.equal(context.__overviewAttribution.targetEntries.explorePanel, 1);
assert.equal(context.document.documentElement.style.setProperty('--test', '12px'), 'forwarded');
assert.equal(context.__overviewAttribution.rootWrites.length, 1); target.getBoundingClientRect(); assert.equal(context.__overviewAttribution.rectReads.explorePanel, 1);
const gl = Object.fromEntries(['clear','clearDepth','clearColor','clearStencil','blitFramebuffer','bindFramebuffer','bindRenderbuffer','renderbufferStorage','renderbufferStorageMultisample','viewport','scissor','useProgram','framebufferTexture2D','framebufferRenderbuffer','deleteFramebuffer','deleteRenderbuffer','deleteTexture'].map(name => [name, () => 42]));
for (const name of ['createFramebuffer','createRenderbuffer','createTexture','createProgram']) gl[name] = () => ({});
const renderer = { getContext: () => gl, getRenderTarget: () => null, clear: () => gl.clear(16640), clearDepth: () => gl.clearDepth(1),
    setRenderTarget: () => 42, render: () => { gl.useProgram(null); return 77; }, autoClear: true, outputColorSpace: 'srgb' };
context.pairedQA = { scene: { renderer, composer: null } };
vm.runInNewContext(`(${installOverviewNativeAudit.toString()})();`, context);
assert.equal(renderer.render(), 77); assert.equal(Object.keys(context.__overviewNativeAudit.counts).length, 0);
context.__overviewNativeAudit.enabled = true; assert.equal(renderer.clear(), 42); assert.equal(renderer.render(), 77);
assert.equal(context.__overviewNativeAudit.counts['gl.clear'], 1); assert.equal(context.__overviewNativeAudit.counts['renderer.render'], 1);
assert.equal(context.__overviewNativeAudit.counts['gl.useProgram'], 1); assert.equal(context.__overviewNativeAudit.dropped, 0);
const workflow = readFileSync(new URL('../.github/workflows/overview-causal-diagnostic.yml', import.meta.url), 'utf8');
assert(workflow.includes("branches: ['diagnostic/overview-causal-8c6569-16587']"));
assert(!/pull_request:|workflow_dispatch:|matrix:|continue-on-error/.test(workflow));
assert(workflow.includes('timeout-minutes: 15')); assert(workflow.includes('10m node scripts/diagnose-overview-causal.mjs'));
for (const sha of Object.values(overviewPair)) assert(workflow.includes(sha));
console.log('Overview causal diagnostic: immutable measurement/thresholds and reversible scope; isolated observer/native-call audit forwarding; exact pair and bounded push-only workflow verified. No browser run or acceptance claim.');

assert(readFileSync(new URL('./overview-causal-attribution.mjs',import.meta.url),'utf8').includes('visualParityClaim: false'));
