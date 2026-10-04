import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { inputs, requireProduction, verifyCleanInputs } from './travel-radiance-adapter.mjs';

const manifest = JSON.parse(readFileSync(new URL('./fixtures/foreign-river-validation.json', import.meta.url)));
const root = resolve('.'), output = resolve(process.argv[2] || 'evidence/foreign-river/sources');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const expected = process.env.EXPECTED_CANDIDATE_REVISION;
assert(expected, 'Exact hosted candidate HEAD is required');
const production = requireProduction(root, expected, inputs.productionFingerprints.B);
verifyCleanInputs(root, ['scripts', '.github/workflows/foreign-river-validation.yml']);
git('merge-base', '--is-ancestor', manifest.requiredAncestor, expected);
const blobs = Object.fromEntries(Object.keys(manifest.blobs).map(path => [path, git('rev-parse', expected + ':' + path)]));
assert.deepEqual(blobs, manifest.blobs, 'The actual reviewed fixture and production blobs are mandatory');
// A changed or omitted input cannot pass merely because production matched.
for (const path of Object.keys(blobs)) {
  const changed = { ...blobs, [path]: '0'.repeat(40) };
  assert.throws(() => assert.deepEqual(changed, manifest.blobs));
  delete changed[path]; assert.throws(() => assert.deepEqual(changed, manifest.blobs));
}
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'identity.json'), JSON.stringify({ passed: true, production, manifest, blobs }, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, head: expected, tree: production.tree, fixtureBlobs: Object.keys(blobs).length }));
