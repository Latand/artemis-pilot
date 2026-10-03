// Test capability routing and comparison gates without launching a browser.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harness = resolve(root, 'scripts/verify-explored-systems.mjs');
const scratch = await mkdtemp(resolve(tmpdir(), 'explored-baseline-routing-'));
const env = { ...process.env, BASE_ROOT: '', BASELINE: '', DEVICE: 'desktop' };
let cases = 0;
const run = (args, overrides = {}) => spawnSync(process.execPath, [harness, ...args], { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8' });
try {
    // Real source hook validation, with only the capability marker omitted from
    // a temporary pre-fix fixture; neither application source tree is edited.
    for (const name of ['main.js', 'render/bodySurfaceMaterial.js', 'render/catalogStars.js']) {
        const destination = resolve(scratch, 'pre-fix/src', name);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(resolve(root, 'src', name)));
    }
    for (const [name, target, baseline, expected] of [
        ['fixed baseline', root, true, false], ['pre-fix baseline', resolve(scratch, 'pre-fix'), true, true],
        ['fixed candidate', root, false, false], ['candidate never exempted', resolve(scratch, 'pre-fix'), false, false],
    ]) {
        const result = run([target, '--validate'], { BASE_ROOT: baseline ? target : '' });
        assert.equal(result.status, 0, `${name}: ${result.stderr}`);
        const report = JSON.parse(result.stdout.trim());
        assert.equal(report.baseline, baseline, `${name}: comparison-side metadata`);
        assert.equal(report.expectHostDrop, expected, `${name}: expected behavior`);
        cases++;
    }
    const fixture = { name: 'matched-fixture' };
    const make = () => ({ device: 'desktop', revision: 'qa-fixture', baseline: false, expectHostDrop: false,
        preloadFlags: {}, routes: [{ fixture }], benchmark: [{ fixture, runs: [{ frameAndFinishMs: [10, 10, 10] }] }],
        longTasks: { benchmark: [] }, reproduction: { hostDropped: false }, passed: true });
    async function compare(name, base, candidate, pass, message) {
        const paths = ['base.json', 'candidate.json', 'comparison.json'].map(f => resolve(scratch, f));
        await writeFile(paths[0], JSON.stringify(base)); await writeFile(paths[1], JSON.stringify(candidate));
        const result = run(['--compare', ...paths]);
        assert.equal(result.status === 0, pass, `${name}: ${result.stderr}`);
        if (message) assert(result.stderr.includes(message), `${name}: wrong failure: ${result.stderr}`);
        const comparison = JSON.parse(await readFile(paths[2], 'utf8'));
        assert.equal(comparison.baselineReproduced, base.reproduction.hostDropped, name);
        cases++;
    }
    const fixed = { ...make(), baseline: true };
    const broken = { ...fixed, expectHostDrop: true, reproduction: { hostDropped: true } };
    const legacy = { ...broken }; delete legacy.expectHostDrop;
    await compare('fixed baseline passes positive verification', fixed, make(), true);
    await compare('pre-fix baseline reproduces bug', broken, make(), true);
    await compare('archived baseline retains historical meaning', legacy, make(), true);
    await compare('missing pre-fix reproduction fails', { ...broken, reproduction: { hostDropped: false } }, make(), false, 'Pre-fix baseline must reproduce');
    await compare('fixed baseline host loss fails', { ...fixed, reproduction: { hostDropped: true } }, make(), false, 'Fixed baseline must retain');
    await compare('fixed baseline functional failure fails', { ...fixed, passed: false }, make(), false, 'Fixed baseline must pass');
    await compare('candidate failure remains blocking', fixed, { ...make(), passed: false }, false, 'Candidate functional verification must pass');
    const slow = make(); slow.benchmark[0].runs[0].frameAndFinishMs = [11, 11, 11];
    await compare('five percent guard remains blocking', fixed, slow, false, 'p95 exceeded the 5%');
    const stalled = make(); stalled.longTasks.benchmark = [{ duration: 201 }];
    await compare('long task guard remains blocking', fixed, stalled, false, 'long tasks exceeded');
    console.log(`Explored-system baseline routing: ${cases} cases passed`);
} finally { await rm(scratch, { recursive: true, force: true }); }
