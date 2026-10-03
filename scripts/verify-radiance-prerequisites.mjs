// Reuse only the exact already accepted functional artifacts. This does not
// accept desktop performance, which remains owned by the original run.
import assert from 'node:assert/strict';
import { readFileSync,readdirSync,mkdirSync } from 'node:fs';
import { resolve,join,relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { durableReport } from './river-radiance-run-budget.mjs';
import { aggregateReports,protocol } from './river-radiance-paired-protocol.mjs';
export const prerequisite=JSON.parse(readFileSync(new URL('./fixtures/radiance-prerequisites-4f79de1c.json',import.meta.url)));
export const unchangedFunctionalPaths=['src','public','index.html','package.json','package-lock.json',
  'scripts/verify-river-radiance.mjs','scripts/river-radiance-qa.mjs','scripts/river-radiance-lifecycle.mjs',
  'scripts/context-recovery-qa.mjs','scripts/fixtures/river-radiance-proxima.json'];
export function verifyMetadata({run,jobs,artifacts}){
  assert.equal(run.id,prerequisite.runId);assert.equal(run.head_sha,prerequisite.head);assert.equal(run.run_attempt,1);
  assert.equal(run.repository.full_name,prerequisite.repository);
  assert.equal(jobs.total_count,jobs.jobs.length);assert.equal(artifacts.total_count,artifacts.artifacts.length);
  for(const expected of prerequisite.artifacts){
    const job=jobs.jobs.find(j=>j.id===expected.jobId);
    assert(job);assert.equal(job.name,expected.jobName);assert.equal(job.run_id,prerequisite.runId);
    assert.equal(job.status,'completed');assert.equal(job.conclusion,'success');
    const artifact=artifacts.artifacts.find(a=>a.id===expected.id);
    assert(artifact);assert.equal(artifact.name,expected.name);assert.equal(artifact.expired,false);
    assert.equal(artifact.digest,expected.digest);assert.equal(artifact.workflow_run.id,prerequisite.runId);
    assert.equal(artifact.workflow_run.head_sha,prerequisite.head);
  }
  // The parent run may be in progress or failed because of mobile setup. Its
  // three explicitly pinned successful functional jobs are what is reused.
  return true;
}
function files(root){return readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(root,e.name)):[join(root,e.name)]);}
export function verifyArtifact(root,expected){
  const actual=Object.fromEntries(files(root).map(path=>[relative(root,path).replaceAll('\\','/'),createHash('sha256').update(readFileSync(path)).digest('hex')]));
  assert.deepEqual(actual,expected.files,'Every report and individually reviewed PNG must retain its exact bytes');
  const report=JSON.parse(readFileSync(join(root,'report.json')));
  assert.deepEqual(report.errors,[]);assert.equal(report.checks.length,expected.checks);assert(report.checks.every(c=>c.pass===true));
  for(const row of report.cases){
    assert.equal(row.revision,row.name.startsWith('baseline-')?prerequisite.baseline:prerequisite.head);
  }
  return {artifactId:expected.id,name:expected.name,checks:report.checks.length,files:actual};
}
export function verifySource(){
  execFileSync('git',['merge-base','--is-ancestor',prerequisite.head,'HEAD']);
  execFileSync('git',['diff','--exit-code',prerequisite.head,'--',...unchangedFunctionalPaths]);
  assert.equal(execFileSync('git',['ls-files','--others','--exclude-standard','--',...unchangedFunctionalPaths],{encoding:'utf8'}).trim(),'');
  return {head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),functionalParent:prerequisite.head,
    unchangedFunctionalPaths,production:execFileSync('git',['ls-tree','HEAD','--','src','public','index.html','package.json'],{encoding:'utf8'}).trim()};
}
export function compatibleDeviceGates(desktop,mobile,expectedMobileHead,desktopShards,mobileShards){
  assert.match(expectedMobileHead,/^[a-f0-9]{40}$/);
  for(const [gate,shards,device,head] of [[desktop,desktopShards,'desktop',prerequisite.head],[mobile,mobileShards,'mobile',expectedMobileHead]]){
    assert(Array.isArray(shards)&&shards.length===3,'All three raw shard reports are required per device');
    assert.deepEqual(gate.errors,[],'Retained aggregate errors cannot be hidden by cached pass flags');
    assert.deepEqual(gate.protocol,protocol,'Canonical views, trials, warmup and samples are mandatory');
    const actual=aggregateReports(shards,device,head,{legacy:['4f79de1c7d78dcea0aa7481f6a8e9d979d34fd68','b9e7c15f1507a1ecdc2beed6079676a24374b1eb'].includes(head)});
    assert.equal(actual.passed,true,'Recomputed raw p95 and device-wide long-task gates must pass');
    for(const [key,value] of Object.entries(actual))assert.deepEqual(gate[key],value,`Cached aggregate ${key} must match raw recomputation`);
    assert.equal(gate.sources.B.revision,head);
  }
  assert(desktop.passed===true&&mobile.passed===true);assert.equal(desktop.device,'desktop');assert.equal(mobile.device,'mobile');
  assert.equal(desktop.expectedCandidateRevision,prerequisite.head);
  assert.match(expectedMobileHead,/^[a-f0-9]{40}$/);assert.equal(mobile.expectedCandidateRevision,expectedMobileHead);
  assert.equal(desktop.sources.A.revision,prerequisite.baseline);
  assert.equal(desktop.sources.B.productionReference,'2c9b5bcf2f542728d76cf1350007297db2678f34');
  assert.deepEqual(desktop.protocol,mobile.protocol);
  assert.deepEqual(desktop.sources.A,mobile.sources.A);
  for(const key of ['productionReference','productionTrees','hashes','computeHash'])assert.deepEqual(desktop.sources.B[key],mobile.sources.B[key]);
  assert.equal(desktop.mandatoryFrames.measured,3600);assert.equal(mobile.mandatoryFrames.measured,3600);
  assert.equal(desktop.mandatoryFrames.warmup,720);assert.equal(mobile.mandatoryFrames.warmup,720);
  for(const gate of [desktop,mobile]){
    assert(gate.longTaskBudget.passed);
    assert.deepEqual(gate.scenarios.map(s=>s.fixture.subject).sort(),['black-hole','proxima','sun']);
    assert(gate.scenarios.every(s=>s.passesFivePercentTarget&&s.medianPairedRatio<=1.05));
  }
  return true;
}
async function main(){
  const [mode,pathArg]=process.argv.slice(2),root=resolve(pathArg||'evidence/prerequisites');mkdirSync(root,{recursive:true});
  const output=join(root,'provenance.json'),result={passed:false,readinessOnly:false,performanceAcceptance:false,
    priorRun:prerequisite.runId,priorHead:prerequisite.head,desktopGate:'Must pass independently in the original run',errors:[]};
  try{
    result.source=verifySource();
    if(mode==='fetch'){
      assert(process.env.GITHUB_TOKEN,'Read-only Actions token required');
      const get=async suffix=>{
        const response=await fetch(`https://api.github.com/repos/${prerequisite.repository}/actions/${suffix}`,{
          headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
        assert(response.ok,`GitHub read failed: ${response.status}`);return response.json();
      };
      result.metadata={run:await get(`runs/${prerequisite.runId}`),jobs:await get(`runs/${prerequisite.runId}/jobs?per_page=100`),
        artifacts:await get(`runs/${prerequisite.runId}/artifacts?per_page=100`)};
      verifyMetadata(result.metadata);durableReport(join(root,'metadata.json'),result.metadata);
    }else{
      assert.equal(mode,'verify');result.metadata=JSON.parse(readFileSync(join(root,'metadata.json')));verifyMetadata(result.metadata);
      result.artifacts=prerequisite.artifacts.map(expected=>verifyArtifact(join(root,'artifacts',expected.name),expected));result.passed=true;
    }
  }catch(error){result.errors.push({message:error.stack||String(error)});process.exitCode=1;}
  finally{durableReport(output,result);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
