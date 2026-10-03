// Recompute mandatory acceptance from every raw view report, never cached pass flags.
// node scripts/aggregate-river-radiance-paired.mjs desktop OUTPUT.json INPUT/report.json [...]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { aggregateReports } from './river-radiance-paired-protocol.mjs';
import { durableReport } from './river-radiance-run-budget.mjs';
const [device, output, ...inputs] = process.argv.slice(2);
assert(output && inputs.length, 'Pass device, output JSON and every input report');
await mkdir(dirname(output),{recursive:true});
let result={inputs,device,passed:false,errors:[]};
try{
  const reports=await Promise.all(inputs.map(async path=>JSON.parse(await readFile(path,'utf8'))));
  const expectedCandidateRevision=process.env.EXPECTED_CANDIDATE_REVISION||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  result={...result,...aggregateReports(reports,device,expectedCandidateRevision)};
  assert(result.passed,'Complete paired p95 / long-task acceptance failed');
}catch(error){result.passed=false;result.errors.push({message:error.stack||String(error)});process.exitCode=1;}
finally{durableReport(output,result);}
console.log(JSON.stringify({device,passed:result.passed,mandatoryFrames:result.mandatoryFrames,longTaskBudget:result.longTaskBudget,errors:result.errors},null,2));
