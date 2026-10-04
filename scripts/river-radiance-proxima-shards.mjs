import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const proximaCompletePolicy=JSON.parse(readFileSync(new URL('./fixtures/radiance-proxima-complete-shards.json',import.meta.url)));
export function requireCompleteProximaPins(){
  assert.equal(proximaCompletePolicy.complete,true,'Both Proxima jobs must finish and their exact raw evidence must be reviewed');
  assert.equal(proximaCompletePolicy.run,37156898245);
  assert.equal(proximaCompletePolicy.head,'8feb71c9b0ed6d6286b98ff9123a84a2845566c9');
  assert.deepEqual(proximaCompletePolicy.shards.map(p=>p.device).sort(),['desktop','mobile']);
  for(const pin of proximaCompletePolicy.shards){
    assert.equal(pin.run,proximaCompletePolicy.run);assert.equal(pin.head,proximaCompletePolicy.head);
    assert.equal(pin.subject,'proxima');assert.equal(pin.timingPolicy,'asset-native-v2');assert.equal(pin.measuredFrames,1200);
    for(const key of ['sha256','canonicalSha256'])assert.match(pin[key],/^[a-f0-9]{64}$/);
    assert.match(pin.artifactDigest,/^sha256:[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(pin.artifact)&&pin.artifact>0);
    assert.equal(pin.job,pin.device==='desktop'?111302146276:111302146297);
    assert.equal(pin.artifactName,`radiance-replacement-${pin.device}-proxima`);
    assert.equal(pin.jobName,`Complete ${pin.device} proxima`);
  }
}
export function pinnedProximaShard(report,device){
  requireCompleteProximaPins();assert.equal(report.scenarios.length,1);
  if(report.scenarios[0].fixture.subject!=='proxima')return null;
  const pin=proximaCompletePolicy.shards.find(p=>p.device===device);assert(pin);
  assert.equal(report.sources.B.revision,pin.head);assert.equal(report.device,device);
  assert.equal(createHash('sha256').update(JSON.stringify(report)).digest('hex'),pin.canonicalSha256,'The original completed Proxima raw report is required');
  assert.equal(report.shardComplete,true);assert.deepEqual(report.errors,[]);
  return pin;
}
