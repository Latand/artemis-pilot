import assert from 'node:assert/strict';
import { readFileSync,mkdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { completedShardPolicy,pinnedCompleteShard } from './river-radiance-complete-shards.mjs';
import { verifySource } from './verify-radiance-prerequisites.mjs';
import { durableReport } from './river-radiance-run-budget.mjs';
export function verifyCompleteMetadata(metadata){
  for(const pin of completedShardPolicy.shards){
    const item=metadata[pin.run];assert(item);
    assert.equal(item.run.id,pin.run);assert.equal(item.run.head_sha,pin.head);assert.equal(item.run.run_attempt,1);
    assert.equal(item.run.repository.full_name,completedShardPolicy.repository);
    assert.equal(item.jobs.total_count,item.jobs.jobs.length);assert.equal(item.artifacts.total_count,item.artifacts.artifacts.length);
    const job=item.jobs.jobs.find(j=>j.id===pin.job);assert(job);assert.equal(job.name,pin.jobName);assert.equal(job.run_id,pin.run);
    assert.equal(job.status,'completed');assert.equal(job.conclusion,'success');
    const artifact=item.artifacts.artifacts.find(a=>a.id===pin.artifact);assert(artifact);
    assert.equal(artifact.name,pin.artifactName);assert.equal(artifact.digest,pin.artifactDigest);assert.equal(artifact.expired,false);
    assert.equal(artifact.workflow_run.id,pin.run);assert.equal(artifact.workflow_run.head_sha,pin.head);
  }
  return true;
}
export function verifyCompleteReport(bytes,pin){
  assert.equal(createHash('sha256').update(bytes).digest('hex'),pin.sha256,'Original complete raw report bytes are mandatory');
  const report=JSON.parse(bytes);assert.equal(pinnedCompleteShard(report,pin.device).artifact,pin.artifact);return report;
}
async function main(){
  const[mode,pathArg]=process.argv.slice(2),root=resolve(pathArg||'evidence/reused');mkdirSync(root,{recursive:true});
  const result={passed:false,performanceAcceptance:false,scope:'Only the three complete measured shards, never partial trials',errors:[]};
  try{
    result.source=verifySource();
    if(mode==='fetch'){
      assert(process.env.GITHUB_TOKEN);result.metadata={};
      const get=async suffix=>{const response=await fetch(`https://api.github.com/repos/${completedShardPolicy.repository}/actions/${suffix}`,{
        headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
        assert(response.ok,`GitHub read failed: ${response.status}`);return response.json();};
      for(const run of new Set(completedShardPolicy.shards.map(p=>p.run)))result.metadata[run]={run:await get(`runs/${run}`),jobs:await get(`runs/${run}/jobs?per_page=100`),artifacts:await get(`runs/${run}/artifacts?per_page=100`)};
      verifyCompleteMetadata(result.metadata);durableReport(join(root,'metadata.json'),result.metadata);
    }else{
      assert.equal(mode,'verify');result.metadata=JSON.parse(readFileSync(join(root,'metadata.json')));verifyCompleteMetadata(result.metadata);
      result.shards=completedShardPolicy.shards.map(pin=>{
        verifyCompleteReport(readFileSync(join(root,pin.artifactName,'report.json')),pin);return pin;
      });result.passed=true;
    }
  }catch(error){result.errors.push({message:error.stack||String(error)});process.exitCode=1;}
  finally{durableReport(join(root,'provenance.json'),result);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
