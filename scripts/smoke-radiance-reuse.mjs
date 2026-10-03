import assert from 'node:assert/strict';
import { readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { aggregateReports } from './river-radiance-paired-protocol.mjs';
import { completedShardPolicy } from './river-radiance-complete-shards.mjs';
import { verifyCompleteMetadata,verifyCompleteReport } from './verify-radiance-complete-shards.mjs';
import { report as syntheticReport } from './river-radiance-test-fixtures.mjs';
const root=process.argv[2];assert(root,'Supply the authenticated complete raw report directory');
const old=new Map(completedShardPolicy.shards.map(pin=>{const path=join(root,pin.artifactName,'report.json');assert(existsSync(path));return [pin.device+':'+pin.subject,verifyCompleteReport(readFileSync(path),pin)];}));
const metadata={};for(const pin of completedShardPolicy.shards){metadata[pin.run]??={run:{id:pin.run,head_sha:pin.head,run_attempt:1,repository:{full_name:completedShardPolicy.repository}},jobs:{total_count:0,jobs:[]},artifacts:{total_count:0,artifacts:[]}};
 const m=metadata[pin.run];m.jobs.jobs.push({id:pin.job,name:pin.jobName,run_id:pin.run,status:'completed',conclusion:'success'});m.jobs.total_count++;
 m.artifacts.artifacts.push({id:pin.artifact,name:pin.artifactName,digest:pin.artifactDigest,expired:false,workflow_run:{id:pin.run,head_sha:pin.head}});m.artifacts.total_count++;}
verifyCompleteMetadata(metadata);
for(const mutate of[m=>m[37145710093].run.head_sha='bad',m=>m[37145710093].jobs.jobs[0].conclusion='failure',m=>m[37148090790].artifacts.artifacts[0].digest='bad',m=>m[37148090790].artifacts.artifacts[0].expired=true]){const bad=structuredClone(metadata);mutate(bad);assert.throws(()=>verifyCompleteMetadata(bad));}
const head='e'.repeat(40);
function fresh(device,subject){
 const r=structuredClone(syntheticReport());r.device=device;r.shardComplete=true;
 r.sources=structuredClone(old.values().next().value.sources);r.sources.B.revision=head;r.sources.B.tree='f'.repeat(40);
 const scenario=r.scenarios.find(s=>s.fixture.subject===subject);r.scenarios=[scenario];r.selectedFixtures=[scenario.fixture];
 if(device==='mobile'){
  const convert=o=>{if(!o||typeof o!=='object')return;if('mobile'in o)o.mobile=true;if(o.fullSize){o.fullSize=[215,466];o.refineRow=466;}if(o.size)o.size=[430,932];if(o.res)o.res=[215,466];if(o.maxAdditionalFrames)o.maxAdditionalFrames=293;
   for(const k of['count','drawCount','drawnCount'])if(o[k]===15376)o[k]=9216;for(const k of['ambient','drawnAmbient'])if(o[k]===15276)o[k]=9116;for(const value of Object.values(o))convert(value);};convert(r);
 }return r;
}
const desktop=[fresh('desktop','proxima'),old.get('desktop:sun'),old.get('desktop:black-hole')],mobile=[fresh('mobile','proxima'),fresh('mobile','sun'),old.get('mobile:black-hole')];
for(const [device,reports]of [['desktop',desktop],['mobile',mobile]]){
 const result=aggregateReports(reports,device,head,{reuseComplete:true});assert(result.passed);assert.equal(result.mandatoryFrames.measured,3600);assert.equal(result.shardProvenance.filter(p=>p.reused).length,device==='desktop'?2:1);
 for(const mutate of[
  rs=>rs[0].errors.push('retained error'),rs=>rs[0].shardComplete=false,rs=>rs[0].sources.B.revision='c'.repeat(40),rs=>rs[0].protocol.samplesPerBlock=1,
  rs=>rs[0].scenarios[0].trials[0].blocks[0].samples.pop(),rs=>rs.at(-1).scenarios[0].trials[0].blocks[0].samples.pop(),
  rs=>rs.at(-1).harness.changed=true,rs=>rs.at(-1).sources.B.hashes.changed='bad',rs=>rs.pop(),
 ]){const bad=structuredClone(reports);mutate(bad);assert.throws(()=>aggregateReports(bad,device,head,{reuseComplete:true}));}
 const expensive=structuredClone(reports);expensive[0].scenarios[0].longTasks.B.allEntries.push({startTime:2100,duration:1e12});
 assert.equal(aggregateReports(expensive,device,head,{reuseComplete:true}).passed,false,'Raw combined long-task totals override all cached flags');
 assert.throws(()=>aggregateReports(reports,device,completedShardPolicy.shards[0].head,{reuseComplete:true}));
}
const workflow=readFileSync('.github/workflows/river-radiance-incomplete.yml','utf8');assert(workflow.includes('branches: [diagnostic/river-radiance-incomplete-only]'));
assert(workflow.includes('timeout-minutes: 160')&&workflow.includes('timeout-minutes: 156'));
assert.equal((workflow.match(/fixture: proxima/g)||[]).length,2);assert.equal((workflow.match(/fixture: sun/g)||[]).length,1);assert(!workflow.includes('fixture: black-hole'));
console.log('Authenticated immutable complete shards combine with fresh complete raw views; altered, partial, mismatched and expensive evidence cannot pass');
