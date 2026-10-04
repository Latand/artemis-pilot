// Recompute both complete device gates. Desktop keeps its previous measured
// head; only the mobile Sun shard may come from this reviewed correction.
import assert from 'node:assert/strict';
import { readFileSync,mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { aggregateReports } from './river-radiance-paired-protocol.mjs';
import { proximaCompletePolicy,requireCompleteProximaPins } from './river-radiance-proxima-shards.mjs';
import { durableReport } from './river-radiance-run-budget.mjs';
const[device,output,...inputs]=process.argv.slice(2);
assert(output&&inputs.length===3);mkdirSync(dirname(resolve(output)),{recursive:true});
let result={device,inputs,passed:false,errors:[]};
try{
  requireCompleteProximaPins();
  const correctionHead=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const measuredHead=device==='desktop'?proximaCompletePolicy.head:correctionHead;
  const reports=inputs.map(p=>JSON.parse(readFileSync(p)));
  result={...result,correctionHead,...aggregateReports(reports,device,measuredHead,{reuseComplete:true,reuseSunOnly:true})};
  assert(result.passed,'The complete recomputed device gate failed');
}catch(error){result.passed=false;result.errors.push({message:error.stack||String(error)});process.exitCode=1;}
finally{durableReport(output,result);}
console.log(JSON.stringify({device,passed:result.passed,mandatoryFrames:result.mandatoryFrames,longTaskBudget:result.longTaskBudget,errors:result.errors}));
