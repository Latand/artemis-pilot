// One-allocation diagnostic only. Run as part of PR32 checks in Actions.
// BASE_ROOT=/exact/A CANDIDATE_ROOT=/exact/B node scripts/diagnose-exploration-crossover.mjs [OUTPUT]
// --validate checks both exact revisions and injected JavaScript without a browser.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { protocol, trialSummary, effects, validateComplete } from './exploration-crossover-protocol.mjs';
import { transform, initializeDocument, initializeQA, readState, selectFixture, readPrograms, installCommandRecorder } from './exploration-crossover-browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert(process.env.BASE_ROOT && process.env.CANDIDATE_ROOT, 'Both pinned application worktrees are required');
const trees = { A: resolve(process.env.BASE_ROOT), B: resolve(process.env.CANDIDATE_ROOT) };
const out = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'evidence/exploration-crossover');
const sha = data => createHash('sha256').update(data).digest('hex');
const git = (tree, ...args) => execFileSync('git', args, { cwd: tree, encoding: 'utf8' }).trim();
const sources = {};
for (const [label, tree] of Object.entries(trees)) {
    assert.equal(git(tree, 'rev-parse', 'HEAD'), protocol.revisions[label]);
    assert.equal(git(tree, 'status', '--porcelain', '--untracked-files=no'), '', 'Measured source worktree must be clean');
    const paths = git(tree, 'ls-files', 'src', 'public', 'index.html', 'package.json').split('\n');
    sources[label] = { revision: protocol.revisions[label], files: {}, transformedHooks: {} };
    for (const path of paths) sources[label].files[path] = sha(await readFile(resolve(tree, path)));
    sources[label].manifestSha256 = sha(JSON.stringify(sources[label].files));
    for (const path of ['src/main.js', 'src/render/catalogStars.js', 'src/render/bodySurfaceMaterial.js']) {
        const hooked = transform(await readFile(resolve(tree, path), 'utf8'), '/' + path);
        sources[label].transformedHooks[path] = sha(hooked);
        execFileSync(process.execPath, ['--input-type=module', '--check'], { input: hooked });
    }
}
const acceptedHarnessHash = sha(await readFile(resolve(root, 'scripts/benchmark-explored-systems.mjs')));
assert.equal(acceptedHarnessHash, 'f694be002c24deaf7c805976461dc917e4b4dc80f49a658dd6d1c3beb70b657f', 'Acceptance harness must remain byte-identical');
if (process.argv.includes('--validate')) {
    console.log(JSON.stringify({ hooks: 'valid', productionRevisions: protocol.revisions, acceptedHarnessHash, protocol })); process.exit(0);
}
// A fresh output directory is mandatory: reruns may not overwrite earlier data.
await mkdir(dirname(out), { recursive: true }); await mkdir(out);
await writeFile(resolve(out, 'protocol.json'), JSON.stringify(protocol, null, 2) + '\n', { flag: 'wx' });
await mkdir(resolve(out, 'sources'));
for (const file of ['diagnose-exploration-crossover.mjs', 'exploration-crossover-protocol.mjs', 'exploration-crossover-browser.mjs',
    'smoke-exploration-crossover.mjs', 'exploration-crossover.package-lock.json', 'benchmark-explored-systems.mjs']) {
    await writeFile(resolve(out, 'sources', file), await readFile(resolve(root, 'scripts', file)));
}
const report = { version: 1, diagnosticOnly: true, acceptance: protocol.acceptance, protocol, sources, acceptedHarnessHash,
    harnessRevision: git(root, 'rev-parse', 'HEAD'), harnessDirty: git(root, 'status', '--porcelain', '--untracked-files=no'),
    started: new Date().toISOString(), hardware: { platform: os.platform(), release: os.release(), arch: os.arch(),
        logicalCPUs: os.cpus().length, cpuModels: [...new Set(os.cpus().map(c => c.model))], totalMemoryBytes: os.totalmem(), node: process.version },
    limitations: [
        'Diagnostic only. The preserved d84ab18 acceptance failure remains failed, irrespective of every result here.',
        'Two persistent browser contexts and page targets; each assignment navigates those pages and creates new WebGL contexts. No claim that a GL context survives navigation.',
        'One fixed AA,BB,AB,BA sequence cannot separate period/thermal/cache drift from source or slot effects by itself.',
        'Different CPU model from AMD EPYC 9V45 limits applicability to the recorded failure.',
        'Readback wall time includes driver and OS scheduling, not a pure GPU execution measurement.',
        'Counter collection and live framebuffer/error queries occur after the timed interval on every frame; they can perturb subsequent scheduling uniformly. This modified diagnostic cannot replace acceptance.',
        'API command and pixel capture is a separate untimed full-history replay after all timing, not a recording of the timed frames or driver-internal commands.',
    ], combinations: [], parity: [], events: [], errors: [], timingComplete: false, diagnosticComplete: false };
let reportWrites = Promise.resolve();
const save = (final = false) => {
    if (aborted && !final) return reportWrites;
    const bytes = JSON.stringify(report, null, 2) + '\n';
    reportWrites = reportWrites.catch(() => {}).then(async () => {
        await writeFile(resolve(out, 'report.json.tmp'), bytes);
        await rename(resolve(out, 'report.json.tmp'), resolve(out, 'report.json'));
    });
    return reportWrites;
};
const journal = record => appendFile(resolve(out, 'frames.ndjson'), JSON.stringify(record) + '\n');
let browser, phase = 'initialization', currentAssignment = null;
let aborted = false;
const pendingTimeouts = new Set();
function bounded(promise, description, timeoutMs = protocol.operationTimeoutMs) {
    if (aborted) return Promise.reject(new Error('Diagnostic aborted'));
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { pendingTimeouts.delete(timer); reject(new Error(`${description} exceeded fixed ${timeoutMs}ms bound`)); }, timeoutMs);
        pendingTimeouts.add(timer);
    });
    return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer); pendingTimeouts.delete(timer); });
}
const evaluate = (page, fn, argument) => {
    if (aborted) return Promise.reject(new Error('Diagnostic aborted'));
    return bounded(page.evaluate(fn, argument), 'Browser evaluation');
};

const servers = {}, caches = [], slots = {};
async function activate(page) { await page.bringToFront(); await page.waitForFunction(() => !document.hidden); }
async function deliver(page, capture = false) {
    const start = performance.now();
    const result = await evaluate(page, capture => new Promise((resolve, reject) => setTimeout(() => {
        try {
            const tape = capture ? __crossoverTapes.find(t => t.gl === pairedQA.scene.renderer.getContext()) : null;
            if (capture && !tape) throw new Error('No recorder for live renderer context');
            tape?.begin(); const sample = __pairedFrame(), captureStart = performance.now();
            const commands = tape?.end();
            // Capture pixels in the SAME task as render, before the default
            // framebuffer may be invalidated (preserveDrawingBuffer=false).
            const result = capture ? { sample, commands, pixels: tape.pixels(), methods: tape.methods } : { sample };
            sample.postFrameCaptureMs = capture ? performance.now() - captureStart : 0;
            resolve(result);
        } catch (error) { reject(error); }
    }, 0)), capture);
    result.sample.roundTripMs = performance.now() - start;
    result.sample.protocolAndSchedulingMs = Math.max(0, result.sample.roundTripMs - result.sample.frameAndFinishMs - result.sample.telemetryMs - result.sample.postFrameCaptureMs);
    return result;
}
async function collect(slot, count, metadata, captureLast = false) {
    const samples = [];
    for (let i = 0; i < count; i++) {
        const { sample, ...capture } = await deliver(slots[slot].page, captureLast && i === count - 1);
        // Journal BEFORE assertions, so even the offending raw sample survives.
        await journal({ phase, assignment: currentAssignment, slot, ...metadata, sampleIndex: i + 1, sample });
        if (captureLast && i === count - 1) await saveCapture(slot, metadata.fixture, sample, capture);
        if (samples.length) assert.equal(sample.frameNo, samples.at(-1).frameNo + 1, 'No hidden/throttled no-op frames');
        samples.push(sample);
        assert.equal(sample.gpu.contextLost, false); assert.equal(sample.gpu.error, 0);
        assert.equal(sample.gpu.defaultFramebuffer, true, 'Readback must target the displayed framebuffer');
        assert(sample.gpu.width > 0 && sample.gpu.height > 0 && sample.counters.calls > 0);
    }
    return samples;
}
async function programSnapshot(page) {
    return (await evaluate(page, readPrograms)).map(p => ({ ...p, shaders: p.shaders.map(s => ({ ...s, sha256: sha(s.source) })),
        sourceSha256: sha(JSON.stringify(p.shaders)) }));
}
async function saveCapture(slot, fixture, sample, capture) {
    const stem = `parity-${currentAssignment}-${fixture}-${slot}`, pixels = Buffer.from(capture.pixels.base64, 'base64');
    let nonblackPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) nonblackPixels += pixels[i] + pixels[i + 1] + pixels[i + 2] > 0;
    const commandBytes = JSON.stringify(capture.commands);
    await writeFile(resolve(out, stem + '.rgba'), pixels);
    await writeFile(resolve(out, stem + '-commands.json'), commandBytes + '\n');
    const record = { assignment: currentAssignment, fixture, slot, source: currentAssignment[protocol.slots.indexOf(slot)],
        frameNo: sample.frameNo, counters: sample.counters, gpu: sample.gpu,
        pixels: { file: stem + '.rgba', format: 'RGBA8, WebGL bottom-left origin', width: capture.pixels.width, height: capture.pixels.height,
            bytes: pixels.length, sha256: sha(pixels), nonblackPixels, error: capture.pixels.error, contextLost: capture.pixels.contextLost },
        commands: { file: stem + '-commands.json', count: capture.commands.length, sha256: sha(commandBytes), wrappedMethods: capture.methods },
        programs: null };
    report.parity.push(record); await save();
    const programs = await programSnapshot(slots[slot].page);
    await writeFile(resolve(out, stem + '-programs.json'), JSON.stringify(programs, null, 2) + '\n');
    record.programs = { file: stem + '-programs.json', hashes: programs.map(p => p.sourceSha256).sort() };
    await save();
    assert.equal(capture.pixels.contextLost, false); assert.equal(capture.pixels.error, 0);
    assert.equal(pixels.length, capture.pixels.width * capture.pixels.height * 4);
    assert(nonblackPixels > 0, 'Parity capture must not silently be an invalidated black framebuffer');
}
async function navigateAssignment(assignment, replay = false) {
    currentAssignment = assignment;
    // Both old documents are destroyed before either new application is loaded.
    for (const slot of protocol.slots) await slots[slot].page.goto('about:blank');
    const result = {};
    for (const [i, slot] of protocol.slots.entries()) {
        const source = assignment[i], page = slots[slot].page;
        await page.goto(`http://127.0.0.1:${servers[source].httpServer.address().port}/?${new URLSearchParams(protocol.query)}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__AP_READY && window.__pairedFrame);
        const identity = await evaluate(page, initializeQA);
        assert.equal(identity.mobile, true); assert(identity.longTaskSupported);
        await activate(page);
        const probe = await evaluate(page, () => new Promise(resolve => setTimeout(() => {
            const start = performance.now(); while (performance.now() - start < 80) { /* archived observer history */ }
            resolve({ start, end: performance.now() });
        }, 0)));
        await page.waitForFunction(probe => {
            for (const entry of __pairedObserver.takeRecords()) __pairedLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
            return __pairedLongTasks.some(e => Math.min(e.startTime + e.duration, probe.end) - Math.max(e.startTime, probe.start) >= 70);
        }, probe);
        const observed = await evaluate(page, probe => {
            const entries = __pairedLongTasks.filter(e => Math.min(e.startTime + e.duration, probe.end) - Math.max(e.startTime, probe.start) >= 70);
            __pairedObserver.takeRecords(); __pairedLongTasks.length = 0; return entries;
        }, probe);
        const initial = await evaluate(page, readState);
        assert.equal(initial.workload.frameNo, protocol.startupFrameNo, 'Exact archived startup frame history');
        assert.deepEqual(initial.maps, { night: 1, clouds: 1, moon: true });
        result[slot] = { source, slot, pageTargetId: slots[slot].targetId, navigationOrdinal: protocol.combinations.indexOf(assignment) + (replay ? 5 : 1),
            identity, observerProbe: { ...probe, observed }, initial };
    }
    assert.equal(result.L.identity.gpu, result.R.identity.gpu);
    return result;
}
function assertMatched(left, right) {
    for (const field of ['focus', 't', 'paused', 'seed', 'epoch', 'workload', 'camera', 'ship', 'maps']) assert.deepEqual(left[field], right[field], `Matched ${field}`);
}
async function runCombination(assignment, replay = false) {
    const combo = { assignment, phase, pages: await navigateAssignment(assignment, replay), scenarios: [] };
    if (!replay) report.combinations.push(combo);
    else { report.replays ||= []; report.replays.push(combo); }
    await save();
    for (const fixture of protocol.fixtures) {
        const scenario = { fixture, warmup: {}, trials: [], programs: {} }; combo.scenarios.push(scenario);
        for (const slot of protocol.slots) {
            const page = slots[slot].page; await activate(page); await evaluate(page, selectFixture, fixture);
            scenario.warmup[slot] = await collect(slot, protocol.warmupFrames, { fixture: fixture.name, kind: 'warmup' });
            await page.waitForFunction(() => { const q = pairedQA.surfaces.pairedSurfaceQueue(); return !q.pending && !q.inFlight; });
            scenario.warmup[slot].push(...await collect(slot, protocol.settledFrames, { fixture: fixture.name, kind: 'settled' }));
            scenario.programs[slot] = { before: await programSnapshot(page) };
        }
        scenario.before = { L: await evaluate(slots.L.page, readState), R: await evaluate(slots.R.page, readState) };
        assertMatched(scenario.before.L, scenario.before.R);
        const fixtureIndex = protocol.fixtures.indexOf(fixture);
        for (const slot of protocol.slots) assert.equal(scenario.before[slot].workload.frameNo, protocol.fixtureBeforeFrames[fixtureIndex], 'Exact archived pre-fixture frame history');
        if (replay) {
            const timed = report.combinations.find(c => c.assignment === assignment).scenarios.find(s => s.fixture.name === fixture.name);
            for (const slot of protocol.slots) assertMatched(scenario.before[slot], timed.before[slot]);
        }
        for (const [trialIndex, order] of protocol.orders.entries()) {
            const trial = { index: trialIndex + 1, order, blocks: [] }; scenario.trials.push(trial);
            for (const [blockIndex, slot] of [...order].entries()) {
                const page = slots[slot].page; await activate(page);
                const startTime = await evaluate(page, () => performance.now());
                const samples = await collect(slot, protocol.samplesPerBlock,
                    { fixture: fixture.name, kind: replay ? 'replay' : 'timed', trial: trial.index, block: blockIndex + 1 },
                    replay && trialIndex === 4 && blockIndex === order.lastIndexOf(slot));
                const endTime = await evaluate(page, () => performance.now());
                trial.blocks.push({ index: blockIndex + 1, slot, source: assignment[protocol.slots.indexOf(slot)], startTime, endTime,
                    loadAverage: os.loadavg(), samples }); await save();
            }
            trial.summary = trialSummary(trial.blocks);
            console.log(phase, assignment, fixture.name, trial.index, JSON.stringify(trial.summary));
        }
        scenario.after = {};
        for (const slot of protocol.slots) {
            scenario.after[slot] = await evaluate(slots[slot].page, readState);
            assert.equal(scenario.after[slot].workload.frameNo, protocol.fixtureAfterFrames[fixtureIndex], 'Exact archived post-fixture frame history');
            for (const field of ['camera', 'ship', 't', 'paused']) assert.deepEqual(scenario.after[slot][field], scenario.before[slot][field]);
            scenario.programs[slot].after = await programSnapshot(slots[slot].page);
            const known = new Set([...scenario.programs[slot].before, ...scenario.programs[slot].after].map(p => p.id));
            for (const sample of [...scenario.warmup[slot], ...scenario.trials.flatMap(t => t.blocks.filter(b => b.slot === slot).flatMap(b => b.samples))])
                assert(sample.programIds.every(id => known.has(id)), 'Every per-frame program must have captured sources');
        }
        await save();
    }
    combo.longTasks = {};
    for (const slot of protocol.slots) combo.longTasks[slot] = await evaluate(slots[slot].page, () => [
        ...__pairedLongTasks, ...__pairedObserver.takeRecords().map(e => ({ startTime: e.startTime, duration: e.duration }))]);
    await save();
}
async function compareParity() {
    const comparisons = [];
    for (const assignment of protocol.combinations) for (const fixture of protocol.fixtures) {
        const records = protocol.slots.map(slot => report.parity.find(r => r.assignment === assignment && r.fixture === fixture.name && r.slot === slot));
        assert(records.every(Boolean), 'All 24 declared captures required');
        const [l, r] = records, left = await readFile(resolve(out, l.pixels.file)), right = await readFile(resolve(out, r.pixels.file));
        assert.equal(left.length, right.length);
        let changedBytes = 0, changedPixels = 0, maxDelta = 0, sumDelta = 0;
        for (let i = 0; i < left.length; i += 4) {
            let changed = false;
            for (let c = 0; c < 4; c++) { const d = Math.abs(left[i + c] - right[i + c]); changedBytes += d !== 0; changed ||= d !== 0; maxDelta = Math.max(maxDelta, d); sumDelta += d; }
            changedPixels += changed;
        }
        comparisons.push({ assignment, fixture: fixture.name, exactPixels: changedBytes === 0, changedBytes, changedPixels,
            maxChannelDelta: maxDelta, meanAbsoluteChannelDelta: sumDelta / left.length,
            exactAPICallTape: l.commands.sha256 === r.commands.sha256,
            exactProgramSourceHashes: JSON.stringify(l.programs.hashes) === JSON.stringify(r.programs.hashes),
            note: 'Equality describes these replay captures only. Different API IDs/order can require manual inspection; equal current-frame API calls alone do not prove equal pre-existing GPU resource contents.' });
    }
    return comparisons;
}
async function run() {
    await save();
    browser = await chromium.launch({ args: protocol.browserArgs });
    report.browser = await browser.version(); assert.equal(report.browser, protocol.browserVersion, 'Do not silently change the browser from the failed allocation');
    for (const [label, tree] of Object.entries(trees)) {
        const cacheDir = await mkdtemp(resolve(os.tmpdir(), `exploration-crossover-${label}-`)); caches.push(cacheDir);
        const server = await createServer({ root: tree, cacheDir, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
            plugins: [{ name: 'exploration-crossover-test-only', enforce: 'pre', transform }] });
        await bounded(server.listen(), 'Vite listen'); servers[label] = server;
    }
    // Exactly two contexts/pages, reused through all timing and replay assignments.
    for (const slot of protocol.slots) {
        const context = await browser.newContext({ viewport: protocol.viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
        await context.addInitScript(initializeDocument);
        const page = await context.newPage(); page.setDefaultTimeout(120000);
        const session = await context.newCDPSession(page), { targetInfo } = await session.send('Target.getTargetInfo'); await session.detach();
        slots[slot] = { context, page, targetId: targetInfo.targetId };
        page.on('pageerror', error => report.errors.push({ phase, assignment: currentAssignment, slot, message: error.stack || error.message }));
        page.on('console', message => { if (message.type() === 'error' && /THREE|Shader|GL_INVALID|WebGL/i.test(message.text()))
            report.errors.push({ phase, assignment: currentAssignment, slot, message: message.text() }); });
        page.on('worker', worker => { report.events.push({ phase, assignment: currentAssignment, slot, event: 'worker', url: worker.url() }); });
        await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, body: '' }));
    }
    phase = 'timing';
    for (const assignment of protocol.combinations) await runCombination(assignment);
    report.counts = validateComplete(report); report.timingComplete = true; report.contrasts = effects(report.combinations); await save();
    // Command wrapping cannot perturb any later timing: every timing block is done.
    phase = 'untimed-parity-replay';
    for (const slot of protocol.slots) await slots[slot].context.addInitScript(installCommandRecorder);
    for (const assignment of protocol.combinations) await runCombination(assignment, true);
    assert.equal(report.parity.length, 24); report.parityComparisons = await compareParity();
    report.diagnosticComplete = !report.errors.length;
    assert(report.diagnosticComplete, 'Runtime errors invalidate the diagnostic; evidence retained');
}
let deadlineTimer, rejectStop;
const stop = new Promise((_, reject) => { rejectStop = reject; });
const signal = name => rejectStop(new Error(`Diagnostic interrupted by ${name}; invalid partial result, no replacement`));
const onTerm = () => signal('SIGTERM'), onInt = () => signal('SIGINT');
process.once('SIGTERM', onTerm); process.once('SIGINT', onInt);
deadlineTimer = setTimeout(() => signal('fixed 45-minute deadline'), protocol.deadlineMs);
try {
    await Promise.race([run(), stop]);
} catch (error) {
    report.errors.push({ phase, assignment: currentAssignment, message: error.stack || String(error) });
    report.diagnosticComplete = false; process.exitCode = 1; console.error(error);
} finally {
    aborted = true; clearTimeout(deadlineTimer);
    for (const timer of pendingTimeouts) clearTimeout(timer);
    // The deadline leaves 15 minutes in the job and 5 in the step for cleanup
    // and upload. Save before cleanup, and cap cleanup even if Chromium hangs.
    report.finished = new Date().toISOString(); await save(true);
    const cleanup = async () => {
        await browser?.close();
        for (const server of Object.values(servers)) await server.close();
        for (const cache of caches) await rm(cache, { recursive: true, force: true });
    };
    let cleanupTimer;
    const cleanupFinished = await Promise.race([cleanup().then(() => true).catch(error => {
        report.errors.push({ phase: 'cleanup', message: String(error) }); return false;
    }), new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(false), protocol.cleanupTimeoutMs); })]);
    clearTimeout(cleanupTimer);
    if (!cleanupFinished) { report.errors.push({ phase: 'cleanup', message: 'Cleanup did not complete within fixed bound' }); report.diagnosticComplete = false; process.exitCode = 1; }
    await save(true);
    process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt);
    if (!cleanupFinished) process.exit(process.exitCode || 1);
}
console.log(JSON.stringify({ diagnosticComplete: report.diagnosticComplete, timingComplete: report.timingComplete,
    acceptance: report.acceptance, report: resolve(out, 'report.json') }, null, 2));
