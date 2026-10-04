// Pure protocol, data-retention, attribution-sign and exact-source hook checks.
// No browser launch, network, production modification or acceptance changes.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { protocol, trialSummary, effects, validateComplete, summarize } from './exploration-crossover-protocol.mjs';
import { transform, initializeDocument, initializeQA, readState, readPrograms, selectFixture, installCommandRecorder } from './exploration-crossover-browser.mjs';
let cases = 0;
function check(name, fn) { fn(); cases++; console.log('ok', name); }
const samples = (readbackMs = 5) => Array.from({ length: 60 }, (_, i) => ({ frameNo: i + 1, frameAndFinishMs: 10, cpuMs: 5,
    finishMs: 0, readbackMs, telemetryMs: .1, roundTripMs: 11, protocolAndSchedulingMs: 1,
    gpu: { contextLost: false, error: 0, width: 430, height: 932 }, counters: { calls: 27 }, programIds: [1] }));
const make = () => ({ combinations: protocol.combinations.map(assignment => ({ assignment, scenarios: protocol.fixtures.map(fixture => ({
    fixture, warmup: { L: Array.from({ length: 124 }, () => samples()[0]), R: Array.from({ length: 124 }, () => samples()[0]) },
    trials: protocol.orders.map(order => ({ order, blocks: [...order].map(slot => ({ slot, samples: samples() })) })),
})) })) });
check('predeclared full count', () => assert.deepEqual(validateComplete(make()), { measured: 14400, warmup: 2976 }));
for (const [name, mutate] of [
    ['missing combination', r => r.combinations.pop()],
    ['wrong combination order', r => r.combinations.reverse()],
    ['missing Earth history', r => r.combinations[0].scenarios.shift()],
    ['wrong warmup count', r => r.combinations[0].scenarios[0].warmup.L.pop()],
    ['missing trial', r => r.combinations[0].scenarios[0].trials.pop()],
    ['missing sample', r => r.combinations[0].scenarios[0].trials[0].blocks[0].samples.pop()],
    ['lost context', r => { r.combinations[0].scenarios[0].trials[0].blocks[0].samples[0].gpu.contextLost = true; }],
    ['GL error', r => { r.combinations[0].scenarios[0].trials[0].blocks[0].samples[0].gpu.error = 1282; }],
    ['blank framebuffer', r => { r.combinations[0].scenarios[0].trials[0].blocks[0].samples[0].gpu.width = 0; }],
    ['no program identity', r => { r.combinations[0].scenarios[0].trials[0].blocks[0].samples[0].programIds = []; }],
]) check(`reject ${name}`, () => { const r = make(); mutate(r); assert.throws(() => validateComplete(r)); });
check('all samples included in nearest-rank p95', () => { const data = Array(95).fill(10).concat(Array(5).fill(30)); assert.equal(summarize(data).mean, 11); assert.equal(summarize(data).p95, 10); });
check('source and slot sign reversal', () => {
    const r = make(), source = .66, slotEffect = .2;
    for (const combo of r.combinations) for (const scenario of combo.scenarios) for (const trial of scenario.trials) {
        const gap = slotEffect + (combo.assignment === 'AB' ? source : combo.assignment === 'BA' ? -source : 0);
        for (const block of trial.blocks) block.samples = samples(5 + (block.slot === 'R' ? gap : 0));
        trial.summary = trialSummary(trial.blocks);
    }
    for (const row of effects(r.combinations)) for (const c of row.trialContrasts) {
        assert(Math.abs(c.sourceBMinusAReadbackMs - source) < 1e-12);
        assert(Math.abs(c.rightMinusLeftSlotReadbackMs - slotEffect) < 1e-12);
        assert(Math.abs(c.sameCodeAAReadbackMs - slotEffect) < 1e-12);
    }
    assert.equal(protocol.acceptance.status, 'failed'); assert.equal(protocol.acceptance.unchangedLimit, 1.05);
});
for (const [label, revision] of Object.entries(protocol.revisions)) for (const path of ['src/main.js', 'src/render/catalogStars.js', 'src/render/bodySurfaceMaterial.js']) {
    const source = execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' });
    const result = transform(source, '/' + path);
    check(`${label} exact revision ${path} parses`, () => execFileSync(process.execPath, ['--input-type=module', '--check'], { input: result }));
    if (path === 'src/main.js') check(`${label} no hidden replacement render path`, () => {
        assert(result.includes('const start=performance.now();frame();'));
        assert(!result.includes('pairedFineFrame'));
        assert(result.indexOf('frameAndFinishMs=performance.now()-start') < result.indexOf('gl.isContextLost()'));
        assert(result.includes('renderer.info.autoReset=false;renderer.info.reset();'));
        assert(result.includes('window.__crossoverPrograms=new Map()'));
    });
}
check('hook drift fails closed', () => assert.throws(() => transform('function changed() {}', '/src/main.js')));
for (const fn of [initializeDocument, initializeQA, readState, readPrograms, selectFixture, installCommandRecorder]) {
    check(`serialized browser function ${fn.name} parses`, () => execFileSync(process.execPath, ['--input-type=module', '--check'], { input: `(${fn.toString()})` }));
}
check('recorder copies arguments, wraps extension calls and leaves calls disabled between captures', () => {
    const sandbox = { result: null };
    vm.runInNewContext(`
        class FakeBuffer {}
        class HTMLImageElement {} class ImageBitmap {}
        class FakeGL {
            constructor() { this.drawingBufferWidth=1;this.drawingBufferHeight=1;this.RGBA=6408;this.UNSIGNED_BYTE=5121;this.ext={drawArraysInstancedANGLE(){}}; }
            createBuffer(){return new FakeBuffer();} bindBuffer(){} bufferData(){} drawArrays(){}
            getExtension(){return this.ext;} readPixels(x,y,w,h,format,type,data){data.set([1,2,3,255]);}
            getError(){return 0;} isContextLost(){return false;}
        }
        class HTMLCanvasElement { constructor(){this.gl=new FakeGL();} getContext(){return this.gl;} }
        const window=globalThis;
        const btoa=s=>s; // Encoded contents are not used by this test.
        (${installCommandRecorder.toString()})();
        const canvas=new HTMLCanvasElement(), gl=canvas.getContext('webgl2');
        const buffer=gl.createBuffer();gl.bindBuffer(1,buffer);const ext=gl.getExtension('ANGLE_instanced_arrays');
        const tape=__crossoverTapes[0];tape.begin();const bytes=new Uint8Array([1,2]);
        gl.bufferData(1,bytes,2);bytes[0]=9;ext.drawArraysInstancedANGLE(0,1,2,3);gl.drawArrays(0,1,2);
        const commands=tape.end();gl.drawArrays(9,9,9);const pixels=tape.pixels();
        result={commands,pixels,methods:tape.methods,sameContext:canvas.getContext('webgl2')===gl,tapes:__crossoverTapes.length};
    `, sandbox);
    assert.equal(sandbox.result.commands.length, 3);
    assert.equal(sandbox.result.commands[0].args[1].bytes[0], 1);
    assert.equal(sandbox.result.commands[1].name, 'extension:ANGLE_instanced_arrays.drawArraysInstancedANGLE');
    assert.equal(sandbox.result.sameContext, true); assert.equal(sandbox.result.tapes, 1);
    assert.equal(sandbox.result.pixels.contextLost, false); assert.equal(sandbox.result.pixels.error, 0);
});
const original = await readFile(new URL('./benchmark-explored-systems.mjs', import.meta.url), 'utf8');
// PR34 adds the fifth surface-exposure argument to the production call.
// Normalize only its reviewed hook adapter; the pinned baseline digest still
// protects every timing sample, assertion, criterion and other byte.
const adapterImport = "import { systemRenderStatement } from './explored-system-hooks.mjs';\n";
const adapterCall = "['systemRender', systemRenderStatement(body)]";
const originalCall = "['systemRender', 'updateSystemRender(focusedSystem, G.t, camera, G.focus);']";
function assertUnchangedAcceptanceHarness(source) {
    const imports = source.split(adapterImport).length - 1;
    const calls = source.split(adapterCall).length - 1;
    if (imports || calls) {
        assert.equal(imports, 1, 'Exactly one explicit hook import');
        assert.equal(calls, 1, 'Exactly one explicit hook use');
        source = source.replace(adapterImport, '').replace(adapterCall, originalCall);
    }
    assert.equal(createHash('sha256').update(source).digest('hex'), 'f694be002c24deaf7c805976461dc917e4b4dc80f49a658dd6d1c3beb70b657f');
}
check('acceptance harness unchanged outside reviewed exact render-hook adapter', () => assertUnchangedAcceptanceHarness(original));
check('pinned original harness remains accepted', () => assertUnchangedAcceptanceHarness(original.replace(adapterImport, '').replace(adapterCall, originalCall)));
for (const [name, altered] of [
    ['unknown change', original + '\n// undeclared edit\n'],
    ['duplicate hook import', original + adapterImport],
    ['duplicate hook call', original + adapterCall],
    ['missing hook import', original.replace(adapterImport, '')],
    ['unknown hook call', original.replace(adapterCall, "['systemRender', systemRenderStatement(body, true)]")],
    ['performance threshold change', original.replace('scenario.medianPairedRatio <= 1.05', 'scenario.medianPairedRatio <= 1.06')],
]) check(`harness guard rejects ${name}`, () => {
    assert.notEqual(altered, original, 'Fixture must mutate the current production harness');
    assert.throws(() => assertUnchangedAcceptanceHarness(altered));
});
const runner = await readFile(new URL('./diagnose-exploration-crossover.mjs', import.meta.url), 'utf8');
check('command instrumentation strictly after all timing', () => {
    assert(runner.indexOf('report.timingComplete = true') < runner.indexOf('context.addInitScript(installCommandRecorder)'));
    assert(runner.includes('await mkdir(out)')); // prevents overwriting an earlier run
    assert(runner.includes('await journal('));
    assert(!runner.includes('Profiler.start'));
});
check('fixed diagnostic/operation deadlines and signal-safe artifact finalization', () => {
    assert.equal(protocol.deadlineMs, 45 * 60 * 1000); assert.equal(protocol.operationTimeoutMs, 120000);
    assert.equal(protocol.cleanupTimeoutMs, 15000);
    assert(runner.includes("process.once('SIGTERM', onTerm)")); assert(runner.includes('Promise.race([run(), stop])'));
    assert(runner.includes("await rename(resolve(out, 'report.json.tmp'), resolve(out, 'report.json'))"));
    assert(runner.includes('await save(true)'));
    assert(runner.includes('- result.sample.telemetryMs - result.sample.postFrameCaptureMs'));
});
const boundedSource = runner.slice(runner.indexOf('function bounded('), runner.indexOf('const evaluate ='));
const sandbox = { setTimeout, clearTimeout, protocol, pendingTimeouts: new Set(), aborted: false };
vm.runInNewContext(boundedSource + ';globalThis.testBounded=bounded;', sandbox);
assert.equal(await sandbox.testBounded(Promise.resolve(7), 'resolved test', 50), 7);
await assert.rejects(sandbox.testBounded(new Promise(() => {}), 'stalled test', 5), /exceeded fixed 5ms bound/);
assert.equal(sandbox.pendingTimeouts.size, 0); cases++; console.log('ok stalled operation rejects without retry');
const collectSource = runner.slice(runner.indexOf('async function collect('), runner.indexOf('async function programSnapshot('));
const calls = [], captureSandbox = { assert, performance, phase: 'test', currentAssignment: 'AA', slots: { L: { page: {} } },
    deliver: async () => ({ sample: { frameNo: 1, gpu: { contextLost: false, error: 1282 } }, commands: ['retained'], pixels: {} }),
    journal: async () => calls.push('journal'), saveCapture: async () => calls.push('capture') };
vm.runInNewContext(collectSource + ';globalThis.testCollect=collect;', captureSandbox);
await assert.rejects(captureSandbox.testCollect('L', 1, { fixture: 'test' }, true));
assert.deepEqual(calls, ['journal', 'capture']); cases++; console.log('ok bad GPU capture saved before invalidation');
check('exact archived frame ordinals are predeclared and checked', () => {
    assert.equal(protocol.startupFrameNo, 1);
    assert.deepEqual(protocol.fixtureBeforeFrames, [125, 849, 1573]);
    assert.deepEqual(protocol.fixtureAfterFrames, [725, 1449, 2173]);
    assert(runner.includes('protocol.startupFrameNo')); assert(runner.includes('protocol.fixtureBeforeFrames[fixtureIndex]'));
    assert(runner.includes('protocol.fixtureAfterFrames[fixtureIndex]'));
});
const workflow = await readFile(new URL('../.github/workflows/exploration-crossover.yml', import.meta.url), 'utf8');
check('PR32-only diagnostic workflow, no acceptance or deployment', () => {
    assert(/^  pull_request:$/m.test(workflow)); assert(!/^  (push|pull_request_target|workflow_dispatch):/m.test(workflow));
    assert(workflow.includes('if: github.event.pull_request.number == 32'));
    assert(workflow.includes('ref: ${{ github.event.pull_request.head.sha }}'));
    for (const path of ['scripts/*exploration-crossover*', '.github/workflows/exploration-crossover.yml', 'docs/exploration-crossover/**']) assert(workflow.includes(path));
    assert(workflow.includes('contents: read')); assert(!/\bwrite\b/.test(workflow));
    assert(workflow.includes('timeout-minutes: 50')); assert(workflow.includes('cancel-in-progress: false')); assert(workflow.includes('if: always()'));
    for (const revision of Object.values(protocol.revisions)) assert(workflow.includes(revision));
});
console.log(`Exploration crossover smoke: ${cases} cases passed`);
