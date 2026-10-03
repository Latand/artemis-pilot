import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const completedShardPolicy=JSON.parse(readFileSync(new URL('./fixtures/radiance-complete-shards.json',import.meta.url)));
export function pinnedCompleteShard(report,device){
  assert.equal(report.scenarios.length,1,'One complete view per reused shard');
  const subject=report.scenarios[0].fixture.subject;
  const pin=completedShardPolicy.shards.find(p=>p.device===device&&p.subject===subject);
  if(!pin)return null;
  assert.equal(report.sources.B.revision,pin.head);
  assert.equal(createHash('sha256').update(JSON.stringify(report)).digest('hex'),pin.canonicalSha256,'Only the exact completed raw report may be reused');
  assert.equal(report.shardComplete,true);assert.deepEqual(report.errors,[]);
  return pin;
}
