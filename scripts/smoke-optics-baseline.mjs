// Validate real source provenance before any browser or timing work begins.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const currentMain = 'ab51029827cf9324eb737673e46c49ab74aa1718';
const historical = '531da641fe5d61b4cdc7130285418c218299d263';
const ring = 'src/render/ringSamplingDepth.js';
const paths = ['src/main.js', 'src/render/catalogStars.js', 'src/render/bodySurfaceMaterial.js',
    'src/universe/minorBodies.js', 'src/universe/renderOrigin.js', 'src/moons.js',
    'src/lensing.js', 'src/holeOptics.js', 'src/render/planetAppearance.js', ring];
const scratch = await mkdtemp(resolve(tmpdir(), 'optics-baseline-'));
async function copyRevision(name, revision) {
    const destination = resolve(scratch, name);
    for (const path of paths) {
        if (revision === currentMain && path === ring) {
            const missing = spawnSync('git', ['cat-file', '-e', `${revision}:${path}`], { cwd: root });
            assert.notEqual(missing.status, 0, 'the reviewed main really predates ring sampling');
            continue;
        }
        const bytes = revision ? execFileSync('git', ['show', `${revision}:${path}`], { cwd: root }) : await readFile(resolve(root, path));
        await mkdir(dirname(resolve(destination, path)), { recursive: true });
        await writeFile(resolve(destination, path), bytes);
    }
    if (revision) {
        // Share read-only objects, but keep each fixture's refs and worktree
        // private. The proof must inspect the real immutable source commit.
        execFileSync('git', ['init', '--quiet', destination]);
        const objects = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd: root, encoding: 'utf8' }).trim();
        await writeFile(resolve(destination, '.git/objects/info/alternates'), objects + '\n');
        execFileSync('git', ['update-ref', 'HEAD', revision], { cwd: destination });
    }
    return destination;
}
function validate(baseline, candidate) {
    return spawnSync(process.execPath, [resolve(root, 'scripts/benchmark-explored-systems.mjs'), candidate, '--validate'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, BASE_ROOT: baseline, OPTICS_BENCH: '1', DEVICE: 'mobile', BLOOM: '1' },
    });
}
try {
    const baseline = await copyRevision('main', currentMain);
    const old = await copyRevision('historical', historical);
    const candidate = await copyRevision('candidate');
    for (const [base, absent] of [[baseline, true], [old, false]]) {
        const result = validate(base, candidate);
        assert.equal(result.status, 0, result.stderr);
        const report = JSON.parse(result.stdout.trim());
        assert.deepEqual(report.sourceFileAbsences, { A: absent ? [ring] : [], B: [] });
        assert.deepEqual(report.sourceFileAbsenceProofs, { A: absent ? { [ring]: {
            commit: currentMain,
            tree: execFileSync('git', ['rev-parse', `${currentMain}^{tree}`], { cwd: root, encoding: 'utf8' }).trim(),
        } } : {}, B: {} });
        assert.equal(report.sourceHashes.A[ring] === null, absent);
        assert.match(report.sourceHashes.B[ring], /^[a-f0-9]{64}$/);
        assert.deepEqual(report.orders, ['ABBA', 'BAAB', 'ABBA', 'BAAB', 'ABBA']);
        assert.equal(report.warmupFrames, 120); assert.equal(report.samplesPerBlock, 60);
    }
    const oldRing = await readFile(resolve(old, ring)); await unlink(resolve(old, ring));
    try {
        const result = validate(old, candidate);
        assert.notEqual(result.status, 0, 'a deleted tracked baseline ring must fail');
        assert(result.stderr.includes(`Baseline ${historical} tracks ${ring}`));
    } finally { await writeFile(resolve(old, ring), oldRing); }
    const gitDirectory = resolve(baseline, '.git'), hiddenGit = resolve(scratch, 'hidden-main-git');
    await rename(gitDirectory, hiddenGit);
    try {
        const result = validate(baseline, candidate);
        assert.notEqual(result.status, 0, 'an arbitrary non-Git source absence must fail');
        assert(result.stderr.includes('not a git repository'));
    } finally { await rename(hiddenGit, gitDirectory); }
    for (const [side, path] of [[candidate, ring], [baseline, 'src/moons.js'], [baseline, 'src/lensing.js']]) {
        const bytes = await readFile(resolve(side, path)); await unlink(resolve(side, path));
        try {
            const result = validate(baseline, candidate);
            assert.notEqual(result.status, 0, 'missing required source must fail before browser startup');
            assert(result.stderr.includes('ENOENT') && result.stderr.includes(path));
        } finally { await writeFile(resolve(side, path), bytes); }
    }
    const workflow = await readFile(resolve(root, '.github/workflows/optics-crossing.yml'), 'utf8');
    assert(workflow.includes(`OPTICS_BASE_SHA: '${currentMain}'`));
    assert(workflow.includes('test "$PR_BASE_SHA" = "$OPTICS_BASE_SHA"'));
    assert(!workflow.includes(historical), 'primary active pair must not silently use the already-fixed historical subset');
    console.log('Optical provenance: immutable current-main absence, historical source, tracked-deletion/non-Git/required-file failures, native hooks and pinned baseline pass');
} finally { await rm(scratch, { recursive: true, force: true }); }
