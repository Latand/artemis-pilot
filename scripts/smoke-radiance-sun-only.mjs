import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {aggregateReports} from './river-radiance-paired-protocol.mjs';
import {completedShardPolicy} from './river-radiance-complete-shards.mjs';
import {verifyCompleteReport} from './verify-radiance-complete-shards.mjs';
import {proximaCompletePolicy,requireCompleteProximaPins} from './river-radiance-proxima-shards.mjs';
import {verifyProximaMetadata,verifyProximaReport} from './verify-radiance-proxima-shards.mjs';
import {report as syntheticReport} from './river-radiance-test-fixtures.mjs';
const root=process.argv[2];assert(root);
const old=new Map(completedShardPolicy.shards.map(pin=>[pin.device+':'+pin.subject,verifyCompleteReport(readFileSync(join(root,pin.artifactName,'report.json')),pin)]));
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

// The synthetic acceptance examples exercise the validator, never stand in for
// pending hosted Proxima evidence or populate the committed provenance pins.
const saved=structuredClone(proximaCompletePolicy),hash=value=>createHash('sha256').update(value).digest('hex');
try{
 proximaCompletePolicy.complete=false;assert.throws(()=>requireCompleteProximaPins(),/must finish/);
 const retained=Object.fromEntries(['desktop','mobile'].map(device=>{const r=fresh(device,'proxima');r.sources.B.revision=proximaCompletePolicy.head;return[device,r];}));
 proximaCompletePolicy.complete=true;
 proximaCompletePolicy.shards=['desktop','mobile'].map((device,i)=>{const raw=JSON.stringify(retained[device]);return{
  run:proximaCompletePolicy.run,head:proximaCompletePolicy.head,device,subject:'proxima',timingPolicy:'asset-native-v2',measuredFrames:1200,
  artifact:i+1,artifactName:`radiance-replacement-${device}-proxima`,artifactDigest:'sha256:'+hash(raw),sha256:hash(raw),canonicalSha256:hash(raw),
  job:device==='desktop'?111302146276:111302146297,jobName:`Complete ${device} proxima`};});
 requireCompleteProximaPins();
 const metadata={run:{id:proximaCompletePolicy.run,head_sha:proximaCompletePolicy.head,run_attempt:1,status:'completed',repository:{full_name:'Latand/artemis-pilot'}},
  jobs:{total_count:2,jobs:proximaCompletePolicy.shards.map(p=>({id:p.job,name:p.jobName,run_id:p.run,status:'completed',conclusion:'success'}))},
  artifacts:{total_count:2,artifacts:proximaCompletePolicy.shards.map(p=>({id:p.artifact,name:p.artifactName,digest:p.artifactDigest,expired:false,workflow_run:{id:p.run,head_sha:p.head}}))}};
 verifyProximaMetadata(metadata);
 for(const pin of proximaCompletePolicy.shards){verifyProximaReport(Buffer.from(JSON.stringify(retained[pin.device])),pin);assert.throws(()=>verifyProximaReport(Buffer.from(JSON.stringify(retained[pin.device])+' '),pin));}
 for(const mutate of[m=>m.run.head_sha=head,m=>m.run.status='in_progress',m=>m.run.run_attempt=2,m=>m.jobs.jobs[0].conclusion='failure',m=>m.artifacts.artifacts[0].digest='bad']){const bad=structuredClone(metadata);mutate(bad);assert.throws(()=>verifyProximaMetadata(bad));}
 const cases=[['desktop',[retained.desktop,old.get('desktop:sun'),old.get('desktop:black-hole')],proximaCompletePolicy.head],['mobile',[retained.mobile,fresh('mobile','sun'),old.get('mobile:black-hole')],head]];
 for(const[device,reports,expected]of cases){
  const options={reuseComplete:true,reuseSunOnly:true};
  const out=aggregateReports(reports,device,expected,options);assert(out.passed);assert.equal(out.mandatoryFrames.measured,3600);
  assert.equal(out.shardProvenance.filter(p=>!p.reused).length,device==='desktop'?0:1);assert.equal(out.sources.B.revision,expected);
  for(const mutate of[rs=>rs[0].errors.push('retained failure'),rs=>rs[0].shardComplete=false,rs=>rs[0].sources.B.revision=head,rs=>rs[0].harness.changed=true,rs=>rs[0].scenarios[0].trials.pop(),rs=>rs[0].runLimits.measurementMs++,rs=>rs.pop()]){const bad=structuredClone(reports);mutate(bad);assert.throws(()=>aggregateReports(bad,device,expected,options));}
  assert.throws(()=>aggregateReports(reports,device,'c'.repeat(40),options));
 }
 for(const mutate of[rs=>rs[1].protocol.samplesPerBlock=1,rs=>rs[1].protocol.orders.pop(),rs=>rs[1].scenarios[0].warmup.A.pop(),rs=>rs[1].sources.B.revision=proximaCompletePolicy.head,rs=>rs[1].errors.push('retained browser error'),rs=>rs[1].shardComplete=false,rs=>rs[1].sources.B.productionReference='c'.repeat(40),rs=>rs[1].scenarios[0].trials[0].blocks[0].samples.pop()]){const bad=structuredClone(cases[1][1]);mutate(bad);assert.throws(()=>aggregateReports(bad,'mobile',head,{reuseComplete:true,reuseSunOnly:true}));}
 const mobile=structuredClone(cases[1][1]);mobile[1].scenarios[0].longTasks.B.allEntries.push({startTime:2100,duration:1e12});
 assert.equal(aggregateReports(mobile,'mobile',head,{reuseComplete:true,reuseSunOnly:true}).passed,false,'Recompute one device-wide budget from raw long tasks');
 assert.throws(()=>aggregateReports(cases[0][1],'desktop',proximaCompletePolicy.head,{reuseComplete:true,reuseSunOnly:true,legacy:true}));
}finally{for(const key of Object.keys(proximaCompletePolicy))delete proximaCompletePolicy[key];Object.assign(proximaCompletePolicy,saved);}
const workflow=readFileSync('.github/workflows/river-radiance-sun-only.yml','utf8');
assert(workflow.includes('branches: [diagnostic/river-radiance-sun-only]'));
assert.equal((workflow.match(/fixture: sun/g)||[]).length,1);assert(!/fixture: (proxima|black-hole)/.test(workflow));
assert(workflow.includes('timeout-minutes: 160')&&workflow.includes('timeout-minutes: 156'));
assert(workflow.includes('device: [desktop, mobile]'));assert(workflow.includes('run-id: 37156898245'));
console.log('Sun-only mode authenticates retained Proxima data, preserves actual desktop head, measures only mobile Sun and recomputes both full raw device gates');

// When real reviewed pins are present, additionally replay their exact bytes
// and metadata; this is distinct from the synthetic acceptance examples above.
if(process.argv[3]){
 const evidence=process.argv[3],actual=Object.fromEntries(proximaCompletePolicy.shards.map(pin=>[pin.device,verifyProximaReport(readFileSync(join(evidence,pin.device+'-proxima','report.json')),pin)]));
 verifyProximaMetadata(JSON.parse(readFileSync(join(evidence,'terminal-metadata.json'))));
 const result=aggregateReports([actual.desktop,old.get('desktop:sun'),old.get('desktop:black-hole')],'desktop',proximaCompletePolicy.head,{reuseComplete:true,reuseSunOnly:true});
 const original=JSON.parse(readFileSync(join(evidence,'complete-desktop','aggregate.json')));
 for(const key of['passed','scenarios','mandatoryFrames','longTasks','longTaskBudget'])assert.deepEqual(result[key],original[key]);
 const mobile=aggregateReports([actual.mobile,fresh('mobile','sun'),old.get('mobile:black-hole')],'mobile',head,{reuseComplete:true,reuseSunOnly:true});
 assert(mobile.passed);assert.equal(mobile.shardProvenance.filter(p=>!p.reused).length,1);
 console.log('Actual two Proxima artifacts authenticated; raw desktop replay exactly matches the prior complete aggregate; actual mobile Proxima combines with an explicitly synthetic Sun unit fixture');
}
