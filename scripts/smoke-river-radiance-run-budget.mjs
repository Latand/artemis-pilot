import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { runLimits,phaseBudget,validatePhases,durableReport } from './river-radiance-run-budget.mjs';
assert.deepEqual(runLimits,{preparationMs:3600000,warmupMs:900000,measurementMs:4800000,assetSettlementMs:300000,checkpointMs:5000,jobMinutes:160});
assert.equal((runLimits.preparationMs+runLimits.warmupMs+runLimits.measurementMs)/60000+5,runLimits.jobMinutes);
const directory=mkdtempSync(join(tmpdir(),'radiance-deadline-'));
try{
 const path=join(directory,'report.json'),report={phases:[],samples:[],errors:[]};let now=0;
 const save=()=>durableReport(path,report);
 const budget=phaseBudget(report.phases,save,{now:()=>now,schedule:()=>0,cancel:()=>{}});
 for(const name of['preparation','warmup','measurement']){
  budget.start(name);await budget.run(async()=>{report.samples.push({name,frameNo:report.samples.length+1});save();now+=10;},'sample');budget.finish();now++;
 }
 validatePhases(report.phases);assert.equal(JSON.parse(readFileSync(path)).samples.length,3);assert(!existsSync(path+'.tmp'));
 for(const name of['preparation','warmup','measurement']){
  const phases=[],records=[];let time=10;const b=phaseBudget(phases,()=>records.push(structuredClone(phases)),{now:()=>time,schedule:()=>0,cancel:()=>{}});
  b.start(name);await assert.rejects(b.run(async()=>{time+=runLimits[name+'Ms'];},'late completion'),/deadline expired/);
  assert(phases[0].timedOut&&!phases[0].completed);assert.equal(records.at(-1)[0].pendingOperation,'late completion');assert.throws(()=>validatePhases(phases));
 }
 const hung=[],held=[],b=phaseBudget(hung,()=>held.push(structuredClone(hung)),{now:()=>10,schedule:fn=>setTimeout(fn,5),cancel:clearTimeout});
 b.start('preparation');await assert.rejects(b.run(()=>new Promise(()=>{}),'hung browser readback'),/deadline expired/);
 assert.equal(held.at(-1)[0].pendingOperation,'hung browser readback');assert(held.at(-1)[0].timedOut);
 for(const when of[300000,300001]){
  let time=0;const phases=[],b=phaseBudget(phases,()=>{}, {now:()=>time,schedule:()=>0,cancel:()=>{}});b.start('preparation');
  await assert.rejects(b.run(async()=>{time=when;return true;},'late ready asset',300000),/deadline expired/);
 }
 const moduleURL=new URL('./river-radiance-run-budget.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`
 import {durableReport,phaseBudget,installReportSignals} from ${JSON.stringify(moduleURL)};
 const report={phases:[],samples:[{frameNo:37}],errors:[],passed:null,shardComplete:false};
 const save=()=>durableReport(${JSON.stringify(path)},report),budget=phaseBudget(report.phases,save);
 installReportSignals(report,()=>budget,save);budget.start('measurement');
 console.log('ready');await budget.run(()=>new Promise(()=>{}),'pending GPU sample38');
 `],{stdio:['ignore','pipe','pipe']});
 await once(child.stdout,'data');const exit=once(child,'exit');child.kill('SIGTERM');
 assert.deepEqual(await exit,[143,null]);const interrupted=JSON.parse(readFileSync(path));
 assert.equal(interrupted.passed,false);assert.equal(interrupted.shardComplete,false);
 assert.deepEqual(interrupted.samples,[{frameNo:37}]);assert.match(interrupted.errors[0].message,/SIGTERM/);
 assert.equal(interrupted.phases[0].pendingOperation,'pending GPU sample38');assert.equal(interrupted.phases[0].completed,false);
 const aggregatePath=join(directory,'aggregate.json');
 const aggregate=spawnSync(process.execPath,['scripts/aggregate-river-radiance-paired.mjs','desktop',aggregatePath,join(directory,'missing-report.json')],{encoding:'utf8'});
 assert.equal(aggregate.status,1);const failure=JSON.parse(readFileSync(aggregatePath));
 assert.equal(failure.passed,false);assert.match(failure.errors[0].message,/ENOENT/);
 const workflow=readFileSync('.github/workflows/river-radiance-incomplete.yml','utf8');
 const perf=workflow.split('  incomplete-performance:')[1].split('  recomputed-device-aggregate:')[0];
 assert(perf.includes('timeout-minutes: 160')&&perf.includes('timeout-minutes: 156'));
 assert(perf.includes('device: desktop')&&perf.includes('device: mobile')&&perf.includes('fixture: proxima')&&perf.includes('fixture: sun'));
 assert(perf.includes('if: always()')&&workflow.split('  recomputed-device-aggregate:')[1].includes('timeout-minutes: 10'));
 console.log('Phase deadlines reject late/hung operations; atomic reports preserve samples and pending operation through real SIGTERM');
}finally{rmSync(directory,{recursive:true,force:true});}
