// Recompute mandatory acceptance from every raw view report, never cached pass flags.
// node scripts/aggregate-river-radiance-paired.mjs desktop OUTPUT.json INPUT/report.json [...]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { aggregateReports } from './river-radiance-paired-protocol.mjs';
const [device, output, ...inputs] = process.argv.slice(2);
assert(output && inputs.length, 'Pass device, output JSON and every input report');
const reports = await Promise.all(inputs.map(async path => JSON.parse(await readFile(path, 'utf8'))));
const expectedCandidateRevision = process.env.EXPECTED_CANDIDATE_REVISION || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const result = { inputs, ...aggregateReports(reports, device, expectedCandidateRevision) };
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ device, passed: result.passed, mandatoryFrames: result.mandatoryFrames, longTaskBudget: result.longTaskBudget }, null, 2));
assert(result.passed, 'Complete paired p95 / long-task acceptance failed');
