import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { acceptance, verifyAcceptanceMetadata, verifyRawAcceptanceReport, verifyPinnedAcceptanceInputs } from './verify-radiance-acceptance.mjs';
const metadata = JSON.parse(readFileSync(new URL('./fixtures/radiance-acceptance-metadata.json', import.meta.url)));
assert(verifyAcceptanceMetadata(metadata));
for (const mutate of [
  m => m.run.head_sha = '0'.repeat(40), m => m.run.run_attempt++,
  m => m.run.repository.full_name = 'other/repository', m => m.run.conclusion = 'failure',
  m => m.jobs.jobs[0].conclusion = 'failure', m => m.jobs.jobs[0].run_id++,
  m => m.jobs.jobs.pop(), m => m.jobs.jobs[0].id++,
  m => m.artifacts.artifacts[0].digest = 'sha256:' + '0'.repeat(64),
  m => m.artifacts.artifacts[0].expired = true,
  m => m.artifacts.artifacts[0].workflow_run.head_sha = '0'.repeat(40),
  m => m.artifacts.artifacts[0].workflow_run.id++, m => m.artifacts.artifacts.pop(),
  m => { m.artifacts.artifacts.push(m.artifacts.artifacts[0]); m.artifacts.total_count++; },
]) {
  const bad = structuredClone(metadata); mutate(bad); assert.throws(() => verifyAcceptanceMetadata(bad));
}
// Raw bytes bind every frame and long-task entry, including cached pass fields.
const raw = Buffer.from(JSON.stringify({ samples: [1, 2, 3], passed: true }));
const pin = { sha256: createHash('sha256').update(raw).digest('hex') };
assert.deepEqual(verifyRawAcceptanceReport(raw, pin), { samples: [1, 2, 3], passed: true });
for (const changed of ['{"samples":[1,2],"passed":true}', '{"samples":[1,2,3],"passed":false}', raw + '\n'])
  assert.throws(() => verifyRawAcceptanceReport(Buffer.from(changed), pin));
assert.deepEqual(Object.keys(acceptance.devices), ['desktop', 'mobile']);
for (const device of Object.values(acceptance.devices)) {
  assert.equal(device.reports.length, 3);
  assert.equal(new Set(device.reports.map(pin => pin.path)).size, 3);
  for (const pin of device.reports) assert.match(pin.sha256, /^[a-f0-9]{64}$/);
}
console.log('Radiance acceptance rejects wrong source-run metadata, missing/duplicate/expired artifacts and altered or shortened raw reports');

const fixture = mkdtempSync(join(tmpdir(), 'radiance-source-guard-'));
const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (path, bytes) => { mkdirSync(dirname(join(fixture, path)), { recursive: true }); writeFileSync(join(fixture, path), bytes); };
const commit = () => git('-c', 'user.name=Radiance fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic input state');
const inputs = ['src/main.js', 'public/data.json', 'index.html', 'package.json', 'package-lock.json', 'bun.lock',
  'vite.config.js', 'scripts/galaxy-preview-plugin.mjs', 'src/universe/galaxyMaps.js', 'src/universe/astroConstants.js', 'src/universe/prng.js'];
try {
  git('init', '-q');
  put('.gitignore', '*.local\n');
  for (const path of inputs) put(path, 'accepted\n');
  git('add', '.'); commit();
  const reference = git('rev-parse', 'HEAD');
  verifyPinnedAcceptanceInputs(fixture, reference, acceptance.productionPaths);
  for (const path of inputs) {
    put(path, 'changed\n');
    assert.throws(() => verifyPinnedAcceptanceInputs(fixture, reference, acceptance.productionPaths), /worktree differs/);
    git('add', path); put(path, 'accepted\n');
    assert.throws(() => verifyPinnedAcceptanceInputs(fixture, reference, acceptance.productionPaths), /index differs/);
    put(path, 'changed\n'); commit(); put(path, 'accepted\n');
    assert.throws(() => verifyPinnedAcceptanceInputs(fixture, reference, acceptance.productionPaths), /Committed acceptance inputs differ/,
      'An altered commit cannot borrow accepted worktree bytes');
    git('reset', '--hard', reference);
    verifyPinnedAcceptanceInputs(fixture, reference, acceptance.productionPaths);
  }
  for (const path of ['.env.local', '.env.production', 'vite.config.ts', 'postcss.config.js', '.postcssrc.json', 'tsconfig.json', 'jsconfig.json', 'npm-shrinkwrap.json', '.npmrc']) {
    put(path, 'new implicit input\n');
    assert.throws(() => verifyPinnedAcceptanceInputs(fixture, reference, acceptance.productionPaths), /Untracked acceptance input/);
    git('add', '-f', path); commit(); rmSync(join(fixture, path));
    assert.throws(() => verifyPinnedAcceptanceInputs(fixture, reference, acceptance.productionPaths), /Committed acceptance inputs differ/);
    git('reset', '--hard', reference);
  }
} finally { rmSync(fixture, { recursive: true, force: true }); }

const workflow = readFileSync(new URL('../.github/workflows/river-radiance.yml', import.meta.url), 'utf8');
for (const path of acceptance.productionPaths) {
  const trigger = ['src', 'public'].includes(path) ? path + '/**' : path.startsWith('package') ? 'package*.json' : path;
  assert(workflow.includes(`- '${trigger}'`), `Missing workflow trigger for ${path}`);
}
for (const path of ['scripts/context-recovery-qa.mjs', 'scripts/smoke-context-recovery-qa.mjs'])
  assert(workflow.includes(`- '${path}'`), `Missing maintained helper trigger: ${path}`);
console.log('Committed, index-only, unstaged, masked and ignored served/build inputs fail closed; matching workflow triggers pass');
