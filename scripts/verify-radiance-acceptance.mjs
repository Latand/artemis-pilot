// Reuse only authenticated, complete raw measurements of identical production.
// The immutable accepted runner stays at its original Git ref, including every
// historical policy and negative test. This script launches no browser or retry.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

export const acceptance = JSON.parse(readFileSync(new URL('./fixtures/radiance-acceptance.json', import.meta.url)));
const expectedMetadata = JSON.parse(readFileSync(new URL('./fixtures/radiance-acceptance-metadata.json', import.meta.url)));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function verifyAcceptanceMetadata({ run, jobs, artifacts }) {
  assert.equal(run.id, acceptance.run);
  assert.equal(run.head_sha, acceptance.reference);
  assert.equal(run.repository.full_name, acceptance.repository);
  assert.equal(run.run_attempt, 1);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(jobs.total_count, jobs.jobs.length, 'Complete job page required');
  assert.equal(artifacts.total_count, artifacts.artifacts.length, 'Complete artifact page required');
  for (const expected of expectedMetadata.jobs.jobs) {
    const matches = jobs.jobs.filter(job => job.id === expected.id);
    assert.equal(matches.length, 1);
    for (const [key, value] of Object.entries(expected)) assert.equal(matches[0][key], value, `Job ${key}`);
  }
  for (const expected of expectedMetadata.artifacts.artifacts) {
    const matches = artifacts.artifacts.filter(artifact => artifact.id === expected.id);
    assert.equal(matches.length, 1);
    for (const key of ['name', 'digest', 'expired']) assert.equal(matches[0][key], expected[key], `Artifact ${key}`);
    for (const key of ['id', 'head_sha']) assert.equal(matches[0].workflow_run[key], expected.workflow_run[key]);
  }
  return true;
}

export function verifyRawAcceptanceReport(bytes, pin) {
  assert.equal(hash(bytes), pin.sha256, 'Exact completed raw report bytes required');
  return JSON.parse(bytes);
}

export function verifyCleanAcceptanceInputs(cwd, paths) {
  // HEAD versus worktree alone misses an altered index masked by restored files.
  assert.equal(spawnSync('git', ['diff', '--quiet', '--cached', 'HEAD', '--', ...paths], { cwd }).status, 0, 'Acceptance index differs from HEAD');
  assert.equal(spawnSync('git', ['diff', '--quiet', '--', ...paths], { cwd }).status, 0, 'Acceptance worktree differs from index');
  // Include ignored files: Vite consumes .env.local even when Git ignores it.
  assert.equal(git(cwd, 'ls-files', '--others', '--', ...paths), '', 'Untracked acceptance input');
}

export function verifyPinnedAcceptanceInputs(cwd, reference, paths) {
  // Bind the reported commit, independently of whatever files are on disk.
  assert.equal(spawnSync('git', ['diff', '--quiet', reference, 'HEAD', '--', ...paths], { cwd }).status, 0, 'Committed acceptance inputs differ from reference');
  verifyCleanAcceptanceInputs(cwd, paths);
}

export function verifyAcceptanceSource(root, referenceRoot) {
  assert.equal(git(referenceRoot, 'rev-parse', 'HEAD'), acceptance.reference);
  assert.equal(git(referenceRoot, 'rev-parse', 'HEAD^{tree}'), acceptance.referenceTree);
  const protectedPaths = [...acceptance.productionPaths, ...acceptance.maintainedPaths];
  verifyPinnedAcceptanceInputs(referenceRoot, acceptance.reference, [...acceptance.productionPaths, 'scripts']);
  verifyPinnedAcceptanceInputs(root, acceptance.reference, protectedPaths);
  // New integration tooling is not present at the historical ref, but its
  // execution still must use the committed version whose HEAD is reported.
  verifyCleanAcceptanceInputs(root, [...acceptance.productionPaths, 'scripts']);
  assert.equal(git(root, 'rev-parse', 'HEAD:src'), acceptance.sourceTree);
  git(root, 'merge-base', '--is-ancestor', acceptance.functionalBaseline, 'HEAD');
  git(root, 'merge-base', '--is-ancestor', acceptance.releaseBase, 'HEAD');
  git(root, 'diff', '--exit-code', acceptance.baseline, acceptance.functionalBaseline, '--', ...acceptance.productionPaths);
  return { actualHead: git(root, 'rev-parse', 'HEAD'), actualTree: git(root, 'rev-parse', 'HEAD^{tree}'),
    acceptedReference: acceptance.reference, sourceTree: acceptance.sourceTree, functionalBaseline: acceptance.functionalBaseline, releaseBase: acceptance.releaseBase,
    productionPaths: acceptance.productionPaths, maintainedPaths: acceptance.maintainedPaths };
}

export async function replayAcceptance(referenceRoot, evidenceRoot) {
  const fromAccepted = path => import(pathToFileURL(join(referenceRoot, 'scripts', path)));
  const { aggregateReports } = await fromAccepted('river-radiance-paired-protocol.mjs');
  const { completedShardPolicy } = await fromAccepted('river-radiance-complete-shards.mjs');
  const { proximaCompletePolicy } = await fromAccepted('river-radiance-proxima-shards.mjs');
  const { verifyCompleteMetadata, verifyCompleteReport } = await fromAccepted('verify-radiance-complete-shards.mjs');
  const { verifyProximaMetadata, verifyProximaReport } = await fromAccepted('verify-radiance-proxima-shards.mjs');
  const read = path => JSON.parse(readFileSync(path));
  const devices = {};
  for (const [device, pins] of Object.entries(acceptance.devices)) {
    const dir = join(evidenceRoot, device);
    verifyCompleteMetadata(read(join(dir, 'reused/metadata.json')));
    verifyProximaMetadata(read(join(dir, 'proxima/metadata.json')));
    for (const pin of completedShardPolicy.shards) verifyCompleteReport(readFileSync(join(dir, 'reused', pin.artifactName, 'report.json')), pin);
    for (const pin of proximaCompletePolicy.shards) verifyProximaReport(readFileSync(join(dir, 'proxima', pin.artifactName, 'report.json')), pin);
    const reports = pins.reports.map(pin => verifyRawAcceptanceReport(readFileSync(join(dir, pin.path)), pin));
    const computed = aggregateReports(reports, device, pins.measuredHead, { reuseComplete: true, reuseSunOnly: true });
    const hosted = read(join(dir, 'aggregate.json'));
    for (const key of ['passed', 'mandatoryFrames', 'longTasks', 'longTaskBudget', 'scenarios', 'shardProvenance', 'sources', 'harness', 'expectedCandidateRevision'])
      assert.deepEqual(computed[key], hosted[key], `Recomputed ${device} ${key}`);
    assert.equal(hosted.correctionHead, acceptance.reference);
    assert(computed.passed);
    assert.deepEqual(computed.mandatoryFrames, { measured: 3600, warmup: 720 });
    devices[device] = { measuredHead: pins.measuredHead, mandatoryFrames: computed.mandatoryFrames,
      ratios: computed.scenarios.map(s => ({ subject: s.fixture.subject, ratio: s.medianPairedRatio })),
      longTasks: computed.longTasks, longTaskBudget: computed.longTaskBudget, shardProvenance: computed.shardProvenance };
  }
  return { devices, totalMeasured: 7200, totalWarmup: 1440 };
}

async function main() {
  const [mode, referenceArg, evidenceArg] = process.argv.slice(2);
  assert(['source', 'fetch', 'replay'].includes(mode));
  assert(referenceArg && evidenceArg);
  const root = process.cwd(), referenceRoot = resolve(referenceArg), evidenceRoot = resolve(evidenceArg);
  mkdirSync(evidenceRoot, { recursive: true });
  const save = (name, value) => { const path = join(evidenceRoot, name); writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n'); renameSync(path + '.tmp', path); };
  const result = { passed: false, mode, measuredReference: acceptance.reference, errors: [] };
  try {
    result.source = verifyAcceptanceSource(root, referenceRoot);
    if (mode === 'fetch') {
      assert(process.env.GITHUB_TOKEN, 'Read-only Actions authentication required');
      const get = async suffix => {
        const response = await fetch(`https://api.github.com/repos/${acceptance.repository}/actions/${suffix}`, {
          headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) });
        assert(response.ok, `GitHub read failed: ${response.status}`); return response.json();
      };
      const metadata = { run: await get(`runs/${acceptance.run}`), jobs: await get(`runs/${acceptance.run}/jobs?per_page=100`), artifacts: await get(`runs/${acceptance.run}/artifacts?per_page=100`) };
      verifyAcceptanceMetadata(metadata); save('metadata.json', metadata);
    } else if (mode === 'replay') {
      verifyAcceptanceMetadata(JSON.parse(readFileSync(join(evidenceRoot, 'metadata.json'))));
      Object.assign(result, await replayAcceptance(referenceRoot, evidenceRoot));
    }
    result.passed = true;
  } catch (error) { result.errors.push({ message: error.stack || String(error) }); process.exitCode = 1; }
  finally { save(mode + '-provenance.json', result); }
  console.log(JSON.stringify({ passed: result.passed, mode, totalMeasured: result.totalMeasured, totalWarmup: result.totalWarmup, errors: result.errors }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
