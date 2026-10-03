import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { aggregateReports,protocol } from './river-radiance-paired-protocol.mjs';
import { report as rawFixture } from './river-radiance-test-fixtures.mjs';
import { prerequisite,verifyMetadata,verifyArtifact,verifySource,compatibleDeviceGates } from './verify-radiance-prerequisites.mjs';
const metadata={run:{id:prerequisite.runId,head_sha:prerequisite.head,run_attempt:1,repository:{full_name:prerequisite.repository},status:'in_progress',conclusion:null},
 jobs:{total_count:3,jobs:prerequisite.artifacts.map(e=>({id:e.jobId,name:e.jobName,run_id:prerequisite.runId,status:'completed',conclusion:'success'}))},
 artifacts:{total_count:3,artifacts:prerequisite.artifacts.map(e=>({id:e.id,name:e.name,digest:e.digest,expired:false,workflow_run:{id:prerequisite.runId,head_sha:prerequisite.head}}))}};
verifyMetadata(metadata);
for(const mutate of[m=>m.run.head_sha='a'.repeat(40),m=>m.run.run_attempt=2,m=>m.run.repository.full_name='other/repo',m=>m.jobs.jobs[0].conclusion='failure',
 m=>m.jobs.jobs[0].id++,m=>m.jobs.total_count++,m=>m.artifacts.artifacts[0].digest='wrong',m=>m.artifacts.artifacts[0].expired=true,m=>m.artifacts.artifacts[0].workflow_run.head_sha='b'.repeat(40)]){
 const bad=structuredClone(metadata);mutate(bad);assert.throws(()=>verifyMetadata(bad));
}
verifySource();
const dir=mkdtempSync(join(tmpdir(),'radiance-prerequisite-'));
try{
 const report={errors:[],checks:[{pass:true}],cases:[{name:'candidate-sun',revision:prerequisite.head}]};
 const text=JSON.stringify(report);writeFileSync(join(dir,'report.json'),text);
 const expected={id:1,name:'tiny',checks:1,files:{'report.json':createHash('sha256').update(text).digest('hex')}};
 verifyArtifact(dir,expected);writeFileSync(join(dir,'report.json'),text+' ');assert.throws(()=>verifyArtifact(dir,expected));
 writeFileSync(join(dir,'report.json'),text);writeFileSync(join(dir,'extra.png'),'extra');assert.throws(()=>verifyArtifact(dir,expected));
}finally{rmSync(dir,{recursive:true,force:true});}
for(const [index,folder]of ['transient-mobile','lifecycle-mobile','lifecycle-desktop'].entries()){
 const path=join('evidence/run-37145710093',folder);if(existsSync(path))verifyArtifact(path,prerequisite.artifacts[index]);
}
const mobileHead='b'.repeat(40);
function shards(device,head){
 const raw=structuredClone(rawFixture());raw.device=device;raw.sources.B.revision=head;
 Object.assign(raw.sources.B,{productionTrees:'same production',hashes:{source:'same source'},computeHash:'same compute'});
 if(device==='mobile'){
  function convert(value){
   if(!value||typeof value!=='object')return;
   if('mobile'in value)value.mobile=true;
   if(value.fullSize){value.fullSize=[215,466];value.refineRow=466;}
   if(value.size)value.size=[430,932];if(value.res)value.res=[215,466];
   if(value.maxAdditionalFrames)value.maxAdditionalFrames=293;
   for(const key of['count','drawCount','drawnCount'])if(value[key]===15376)value[key]=9216;
   for(const key of['ambient','drawnAmbient'])if(value[key]===15276)value[key]=9116;
   for(const child of Object.values(value))convert(child);
  }convert(raw);
 }
 return raw.scenarios.map(s=>({...raw,selectedFixtures:[s.fixture],scenarios:[s]}));
}
const desktopRaw=shards('desktop',prerequisite.head),mobileRaw=shards('mobile',mobileHead);
const desktop={errors:[],...aggregateReports(desktopRaw,'desktop',prerequisite.head)},mobile={errors:[],...aggregateReports(mobileRaw,'mobile',mobileHead)};
const check=(d=desktop,m=mobile,dr=desktopRaw,mr=mobileRaw)=>compatibleDeviceGates(d,m,mobileHead,dr,mr);
check();assert.throws(()=>compatibleDeviceGates(desktop,mobile,mobileHead));
for(const mutate of[
 x=>x.passed=false,x=>x.longTaskBudget.passed=false,x=>x.scenarios.pop(),x=>x.scenarios[0].medianPairedRatio=1.06,
 x=>x.expectedCandidateRevision='c'.repeat(40),x=>x.sources.B.revision='c'.repeat(40),x=>x.protocol.p95RatioLimit=1.1,
 x=>x.sources.B.hashes.source='different',x=>x.mandatoryFrames.measured=3599,x=>x.errors.push({message:'retained failure'}),
 x=>x.longTasks.B.measuredTotalBlockingMs=1e12,
 ]){const bad=structuredClone(mobile);mutate(bad);assert.throws(()=>check(desktop,bad));}
for(const [key,value]of [['warmupFrames',1],['samplesPerBlock',1],['orders',['ABBA']]]){
 const d=structuredClone(desktop),m=structuredClone(mobile),dr=structuredClone(desktopRaw),mr=structuredClone(mobileRaw);
 d.protocol[key]=value;m.protocol[key]=value;for(const raw of [...dr,...mr])raw.protocol[key]=value;
 assert.throws(()=>check(d,m,dr,mr),'Jointly shortened protocols must fail canonical validation');
}
for(const mutate of[
 x=>x[0].sources.B.revision='c'.repeat(40),x=>x[0].errors.push({message:'raw retained failure'}),
 x=>x[0].scenarios[0].longTasks.B.allEntries.push({startTime:2100,duration:1e12}),
 x=>x[0].scenarios[0].trials[0].blocks[0].samples.pop(),x=>x.pop(),
 ]){const raw=structuredClone(mobileRaw);mutate(raw);assert.throws(()=>check(desktop,mobile,desktopRaw,raw));}
const workflow=readFileSync('.github/workflows/river-radiance-mobile-setup.yml','utf8');
assert(workflow.includes('branches: [diagnostic/river-radiance-mobile-setup]'));
assert(!workflow.includes('DEVICE: desktop')&&!workflow.includes('device: [desktop'));
assert(workflow.includes('fixture: [proxima, sun, black-hole]')&&workflow.includes('node scripts/aggregate-river-radiance-paired.mjs mobile'));
assert(workflow.includes('needs: verified-prerequisites')&&workflow.includes('if: always()'));
console.log('Pinned successful prerequisites, every artifact byte, unchanged source and cross-head device-gate compatibility are enforced; no browser or network run');
