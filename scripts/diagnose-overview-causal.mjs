// One authorized diagnostic pair; never acceptance or a retry of the PR matrix.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const overviewPair = Object.freeze({ A: '8c6569e03efe7f74707c254c6851be975974c708', B: '16587fff9e4b5bfcb1c3e7313c884d0d39597be9' });
export const benchmarkSha256 = '78ce8ab98f08e9e644046fb8f4561590464436b62253a56568603d04584070e1';
const sha = value => createHash('sha256').update(value).digest('hex');
export function adaptOverviewBenchmark(original) {
    assert.equal(sha(original), benchmarkSha256, 'Exact reviewed paired benchmark required');
    let source = original; const changes = [];
    const once = (before, after, reason) => { assert.equal(source.split(before).length, 2, reason); const index = source.indexOf(before); source = source.replace(before, after); changes.push({ before, after, reason, index }); };
    once("const device = process.env.DEVICE || 'desktop', mobile = device === 'mobile';", "const device = process.env.DEVICE || 'desktop', mobile = device === 'mobile';\nassert.equal(device, 'desktop', 'Authorized desktop overview diagnostic only');", 'desktop only');
    once("    { name: 'earth-near', focus: 'earth', distance: 25, yaw: -.4, pitch: .45 },\n    { name: 'catalog-star', focus: 'star:2', distance: null, yaw: -.4, pitch: .45 },\n", '', 'overview only');
    once('const report = { version: 4, device, sourceHashes,', 'const report = { diagnosticOnly: true, acceptance: false, historicalFailureSuperseded: false, contextCreationOrder: ["A", "B"], allocationOrderCounterbalanced: false, version: 4, device, sourceHashes,', 'explicit non-authority');
    once("fixedDiagnosticExperiment: 'After ALL acceptance fixtures and long-task collection: twenty attribution frames per fixture plus twenty fine-substage Earth frames and one 120-frame Earth CDP CPU profile per revision. No profiler runs between acceptance trials or fixtures'", "fixedDiagnosticExperiment: 'One overview-only five-trial pair, then fresh-context twenty-frame overview observer/layout/style attribution. No Earth/catalog measurements, profiler or observer instrumentation between comparison samples'", 'accurate attribution scope');
    once("authority: 'Paired trials are the performance acceptance measurement because the sequential independent-browser timings confound revision with machine-time drift. Sequential raw reports and their comparison remain available as diagnostics; they are not deleted or relabeled as passing'", "authority: 'Non-authoritative causal comparison of two historical runtime revisions. Original PR acceptance failure remains unchanged. The inherited 1.05 and long-task calculations are reported, not release acceptance'", 'accurate diagnostic authority');
    const initStart = source.indexOf('        report.pages[label] = await page.evaluate(async () => {');
    const initEnd = source.indexOf("        assert.equal(report.pages[label].mobile", initStart);
    assert(initStart > 0 && initEnd > initStart);
    const init = source.slice(initStart, initEnd);
    const initializer = init.replace('        report.pages[label] = await page.evaluate', 'const initializePage = page => page.evaluate').trim();
    once(init, '        report.pages[label] = await initializePage(page);\n', 'shared original page initialization');
    once('try {\n    browser = await chromium.launch', initializer+'\ntry {\n    browser = await chromium.launch', 'reused initializer declaration');
    once('        report.pages[label].initial = initial; await save();', "        report.pages[label].initial = initial;\n        report.pages[label].nativeInitial = await captureOverviewState(page, out, label+'-initial'); await save();", 'initial resource history');
    once('        scenario.activeWorkersBefore = ', "        scenario.nativeBefore = { A: await captureOverviewState(pages.A, out, 'A-before'), B: await captureOverviewState(pages.B, out, 'B-before') };\n        scenario.activeWorkersBefore = ", 'pre-comparison native state');
    once('        scenario.after = { A: await state(pages.A), B: await state(pages.B) };', "        scenario.after = { A: await state(pages.A), B: await state(pages.B) };\n        scenario.nativeAfter = { A: await captureOverviewState(pages.A, out, 'A-after'), B: await captureOverviewState(pages.B, out, 'B-after') };", 'post-comparison native state');
    const diagnosticStart = source.indexOf('    // CPU profiling can alter JIT state.');
    const diagnosticEnd = source.indexOf('    report.passed = report.scenarios.length', diagnosticStart);
    assert(diagnosticStart > 0 && diagnosticEnd > diagnosticStart);
    once(source.slice(diagnosticStart, diagnosticEnd), "    await overviewAttribution({ browser, pages, servers, initializePage, query, viewport, fixture: fixtures[0], frames, state, activate, out, report, save });\n", 'separate post-comparison overview attribution');
    const prefix = `import { captureOverviewState, overviewAttribution } from ${JSON.stringify(new URL('./overview-causal-attribution.mjs', import.meta.url).href)};\n`;
    return { source: prefix + source, changes, prefix };
}
export function materializeOverview(source) {
    return source.replace(/^import (.+?) from (['"])([^'"]+)\2;/gm,
        (_, clause, quote, specifier) => `import ${clause} from ${JSON.stringify(import.meta.resolve(specifier))};`);
}
function bind(root, expected) {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(git('rev-parse', 'HEAD'), expected);
    const paths = ['src', 'public', 'index.html', 'package.json', 'package-lock.json', 'bun.lock', 'vite.config.*',
        'scripts/galaxy-preview-plugin.mjs', '.env*', 'postcss.config.*', '.postcssrc*', 'tsconfig*.json', 'jsconfig*.json', 'npm-shrinkwrap.json', '.npmrc'];
    git('diff', '--exit-code', '--cached', 'HEAD', '--', ...paths); git('diff', '--exit-code', '--', ...paths);
    assert.equal(git('ls-files', '--others', '--', ...paths), '', 'No untracked or ignored served/config inputs');
    return { revision: expected, tree: git('rev-parse', 'HEAD^{tree}'),
        sourceTree: git('rev-parse', 'HEAD:src'), files: Object.fromEntries(['src/main.js', 'src/scene.js', 'src/compactExplorer.js',
            'src/render/qualityControls.css', 'src/render/adaptiveQuality.js', 'package.json'].map(path => [path, sha(readFileSync(join(root, path)))])) };
}
async function main() {
    const [a, b, destination = 'evidence/overview-causal', ...options] = process.argv.slice(2);
    assert(a && b); assert(options.every(option => option === '--validate'));
    const roots = { A: resolve(a), B: resolve(b) }, out = resolve(destination);
    const before = Object.fromEntries(Object.entries(roots).map(([label, root]) => [label, bind(root, overviewPair[label])]));
    const original = readFileSync(new URL('./benchmark-explored-systems.mjs', import.meta.url), 'utf8');
    assert.equal(sha(readFileSync(new URL('./explored-system-hooks.mjs', import.meta.url))), '2d24f1ddf1916741d20595b305a5a5e4b5bf141440bed351ed9dbc143f9aca86', 'Reviewed shared transformation hook');
    const { source, changes } = adaptOverviewBenchmark(original), effective = materializeOverview(source);
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: effective });
    mkdirSync(out, { recursive: true });
    const provenance = { diagnosticOnly: true, acceptance: false, completed: false, before,
        contextCreationOrder: ['A', 'B'], allocationOrderCounterbalanced: false,
        interpretation: 'ABBA/BAAB balances execution order only. Persistent SwiftShader context/allocation-order effects remain confounded; attribute no UI cause without corroborating observer/layout/native-pass evidence.',
        originalBenchmarkSha256: sha(original), effectiveBenchmarkSha256: sha(effective),
        diagnosticHarness: Object.fromEntries(['diagnose-overview-causal.mjs', 'overview-causal-attribution.mjs'].map(name => [name, sha(readFileSync(new URL(name, import.meta.url)))])),
        adaptations: changes.map(change => change.reason), omissions: ['No original fd41 baseline rerun',
            'No prior Earth/catalog trial history; fresh overview resources are recorded', 'No physical-device inference',
            'No GPU timer query inserted; readback/finish are not GPU execution time'], errors: [] };
    const path = join(out, 'provenance.json'); writeFileSync(path, JSON.stringify(provenance, null, 2)+'\n', { flag: 'wx' });
    writeFileSync(join(out, 'effective-benchmark.mjs'), effective);
    const temporary = mkdtempSync(join(tmpdir(), 'overview-causal-'));
    try {
        const entry = join(temporary, 'benchmark.mjs'); writeFileSync(entry, effective);
        const result = spawnSync(process.execPath, [entry, roots.B, out, ...options], { cwd: roots.B, stdio: 'inherit',
            env: { ...process.env, BASE_ROOT: roots.A, DEVICE: 'desktop', PAIRED_CPU_PROFILE: '0' } });
        provenance.childExit = result.status; provenance.completed = result.status === 0;
        if (result.status !== 0) { process.exitCode = 1; provenance.errors.push('Comparison did not pass all inherited gates; all raw samples retained'); }
    } finally {
        try { provenance.after = Object.fromEntries(Object.entries(roots).map(([label, root]) => [label, bind(root, overviewPair[label])])); assert.deepEqual(provenance.after, before); }
        catch (error) { provenance.completed = false; provenance.errors.push(String(error)); process.exitCode = 1; }
        writeFileSync(path, JSON.stringify(provenance, null, 2)+'\n'); rmSync(temporary, { recursive: true, force: true });
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
