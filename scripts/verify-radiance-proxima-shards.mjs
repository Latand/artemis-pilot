import assert from 'node:assert/strict';
import { readFileSync,mkdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { proximaCompletePolicy,pinnedProximaShard,requireCompleteProximaPins } from './river-radiance-proxima-shards.mjs';
import { verifySource } from './verify-radiance-prerequisites.mjs';
import { durableReport } from './river-radiance-run-budget.mjs';
export const unchangedMeasuredPaths=['src','public','index.html','package.json','package-lock.json',
  'scripts/benchmark-river-radiance.mjs','scripts/river-radiance-paired-browser.mjs','scripts/river-radiance-full-preparation.mjs',
  'scripts/river-radiance-run-budget.mjs','scripts/river-radiance-volume-progress.mjs','scripts/river-radiance-preparation-qa.mjs',
  'scripts/river-radiance-qa.mjs','scripts/fixtures/river-radiance-proxima.json'];
export function verifyProximaSource(){
  requireCompleteProximaPins();const source=verifySource();
  execFileSync('git',['merge-base','--is-ancestor',proximaCompletePolicy.head,'HEAD']);
  assert.equal(execFileSync('git',['diff','--name-only',proximaCompletePolicy.head,'HEAD','--',...unchangedMeasuredPaths],{encoding:'utf8'}).trim(),'','Source, delivered workload and measurement instrumentation must remain exact');
  return {...source,measuredParent:proximaCompletePolicy.head,unchangedMeasuredPaths};
}
export function verifyProximaMetadata({run,jobs,artifacts}){
  requireCompleteProximaPins();
  assert.equal(run.id,proximaCompletePolicy.run);assert.equal(run.head_sha,proximaCompletePolicy.head);assert.equal(run.run_attempt,1);
  assert.equal(run.repository.full_name,proximaCompletePolicy.repository);assert.equal(run.status,'completed');
  assert.equal(jobs.total_count,jobs.jobs.length);assert.equal(artifacts.total_count,artifacts.artifacts.length);
  for(const pin of proximaCompletePolicy.shards){
    const job=jobs.jobs.find(j=>j.id===pin.job);assert(job);assert.equal(job.name,pin.jobName);assert.equal(job.run_id,pin.run);
    assert.equal(job.status,'completed');assert.equal(job.conclusion,'success');
    const artifact=artifacts.artifacts.find(a=>a.id===pin.artifact);assert(artifact);
    assert.equal(artifact.name,pin.artifactName);assert.equal(artifact.digest,pin.artifactDigest);assert.equal(artifact.expired,false);
    assert.equal(artifact.workflow_run.id,pin.run);assert.equal(artifact.workflow_run.head_sha,pin.head);
  }
  return true;
}
export function verifyProximaReport(bytes,pin){
  assert.equal(createHash('sha256').update(bytes).digest('hex'),pin.sha256,'Exact completed Proxima raw bytes required');
  const report=JSON.parse(bytes);assert.equal(pinnedProximaShard(report,pin.device).artifact,pin.artifact);return report;
}
async function main(){
  const[mode,pathArg]=process.argv.slice(2),root=resolve(pathArg||'evidence/proxima');mkdirSync(root,{recursive:true});
  const result={passed:false,performanceAcceptance:false,scope:'Two complete Proxima views only; no partial trials',errors:[]};
  try{
    result.source=verifyProximaSource();
    if(mode==='fetch'){
      assert(process.env.GITHUB_TOKEN);
      const get=async suffix=>{const response=await fetch(`https://api.github.com/repos/${proximaCompletePolicy.repository}/actions/${suffix}`,{
        headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
        assert(response.ok,`GitHub read failed: ${response.status}`);return response.json();};
      const run=proximaCompletePolicy.run;
      result.metadata={run:await get(`runs/${run}`),jobs:await get(`runs/${run}/jobs?per_page=100`),artifacts:await get(`runs/${run}/artifacts?per_page=100`)};
      verifyProximaMetadata(result.metadata);durableReport(join(root,'metadata.json'),result.metadata);
    }else{
      assert.equal(mode,'verify');result.metadata=JSON.parse(readFileSync(join(root,'metadata.json')));verifyProximaMetadata(result.metadata);
      result.shards=proximaCompletePolicy.shards.map(pin=>{verifyProximaReport(readFileSync(join(root,pin.artifactName,'report.json')),pin);return pin;});result.passed=true;
    }
  }catch(error){result.errors.push({message:error.stack||String(error)});process.exitCode=1;}
  finally{durableReport(join(root,'provenance.json'),result);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
