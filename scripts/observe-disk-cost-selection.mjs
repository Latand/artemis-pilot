// Diagnostic-only adapter. --validate starts no browser; --run requires a
// separately reviewed hosted job. It never executes acceptance windows.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,symlinkSync,realpathSync,renameSync,rmSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {verifyDiskSource} from './disk-plane-source-contract.mjs';
import {SELECTION_PINS as P,adaptSelectionBenchmark,digest,explainDiskEligibility,inspectSelectionRuntime,verifyHeadlessLaunch} from './disk-cost-selection-contract.mjs';
import {runSelectionProcess} from './disk-selection-process.mjs';
const adapter=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const candidate=resolve(process.env.SOURCE_ROOT||''),baseline=resolve(process.env.BASE_ROOT||''),out=resolve(process.env.ARTEMIS_EVIDENCE||'evidence/disk-cost-selection');
const run=process.argv.includes('--run'),validate=process.argv.includes('--validate');
assert(run!==validate&&process.argv.slice(2).length===1,'Exactly --validate or --run required');
assert(process.env.SOURCE_ROOT&&process.env.BASE_ROOT&&process.env.EXPECTED_DIAGNOSTIC_REVISION,'Explicit roots and diagnostic revision required');
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
mkdirSync(out,{recursive:true});const temp=mkdtempSync(join(tmpdir(),'disk-selection-'));
const report={diagnosticOnly:true,browserStarted:false,completed:false,pins:P,adapterRevision:process.env.EXPECTED_DIAGNOSTIC_REVISION,errors:[],acceptanceFrames:0};
const save=()=>{writeFileSync(join(out,'provenance.json.tmp'),JSON.stringify(report,null,2)+'\n');renameSync(join(out,'provenance.json.tmp'),join(out,'provenance.json'));};
const snapshot=()=>{
 assert.equal(git(candidate,'rev-parse','HEAD'),P.candidate);assert.equal(git(candidate,'rev-parse','HEAD^{tree}'),P.candidateTree);
 assert.equal(git(baseline,'rev-parse','HEAD'),P.baseline);
 const sources={A:verifyDiskSource(baseline,'A',P.baseline),B:verifyDiskSource(candidate,'B',P.candidate),adapter:verifyDiskSource(adapter,'B',process.env.EXPECTED_DIAGNOSTIC_REVISION)};
 for(const root of [baseline,adapter])assert.equal(realpathSync(join(root,'node_modules')),realpathSync(join(candidate,'node_modules')),'Shared exact runtime');
 return sources;
};
try{
 report.sources=snapshot();
 const native=execFileSync('git',['show',P.benchmarkReference+':'+P.benchmarkPath],{cwd:adapter,encoding:'utf8'});
 const effective=adaptSelectionBenchmark(native,adapter),runner=join(temp,'scripts/benchmark-explored-systems.mjs');
 mkdirSync(dirname(runner));writeFileSync(join(temp,'package.json'),' {"type":"module"} ');writeFileSync(runner,effective);
 const hook=readFileSync(join(candidate,'scripts/explored-system-hooks.mjs'));writeFileSync(join(temp,'scripts/explored-system-hooks.mjs'),hook);
 assert.equal(digest(hook),'2d24f1ddf1916741d20595b305a5a5e4b5bf141440bed351ed9dbc143f9aca86');
 symlinkSync(join(candidate,'node_modules'),join(temp,'node_modules'),'dir');
 writeFileSync(join(out,'effective-selection.mjs'),effective);
 report.harness={originalSha256:digest(native),effectiveSelectionSha256:digest(effective),hookSha256:digest(hook),scope:'Only original setup,120 warmup and four settled frames per root. No timed trials or cost gates executed.'};
 const env={...process.env,BASE_ROOT:baseline,DEVICE:P.device,BLOOM:P.bloom,OPTICS_BENCH:'1',PAIRED_CPU_PROFILE:'0'};
 report.executableOverrideRemoved=!!env.CHROMIUM_PATH;delete env.CHROMIUM_PATH;
 execFileSync(process.execPath,['--check',runner]);
 const req=createRequire(join(adapter,'package.json'));
 const binding=inspectSelectionRuntime(req);
 report.managedHeadless=binding.managedHeadless;
 report.runtime={node:process.version,...binding.runtime};
 if(validate){
  report.validationOutput=execFileSync(process.execPath,[runner,candidate,join(out,'selection'),'--validate'],{cwd:adapter,env,encoding:'utf8'});
 }else{
  assert(!existsSync(join(out,'selection/selection-report.json')),'A new diagnostic cannot reuse a prior observation report');
  assert.equal(process.env.GITHUB_ACTIONS,'true','No local browser route');assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');
  assert.equal(process.version,'v22.23.3');
  report.managedHeadless.realPath=realpathSync(report.managedHeadless.executablePath);
  report.browserRequested=true;report.browserStarted=null;save();
  report.child=await runSelectionProcess(process.execPath,[runner,candidate,join(out,'selection')],{cwd:adapter,env,
      deadlineMs:P.maxProcessMs,cleanupMs:P.cleanupMs,journalPath:join(out,'owned-processes.jsonl'),onTimeout:()=>{report.timedOut=true;report.completed=false;save();}});
  assert(!report.child.timedOut&&report.child.childExited&&report.child.code===0&&!report.child.unexpectedDescendants&&!report.child.signalErrors.length,'Bounded native-selection process failed');
  report.actualHeadless=verifyHeadlessLaunch(report.child.ownership,report.managedHeadless.realPath);
  const observation=JSON.parse(readFileSync(join(out,'selection/selection-report.json'),'utf8'));
  assert(observation.completed&&observation.errors.length===0&&observation.browser==='153.0.8010.12'&&observation.diagnosticOnly&&observation.acceptanceFrames===0&&observation.selectionResult?.timingAcceptance===false);
  report.selection=observation.selectionResult;
  const holeSource=readFileSync(join(candidate,'src/holeOptics.js'),'utf8');
  report.eligibilityExplanations=observation.selectionNative.settled.draws.map(d=>{
   const u=d.uniforms,input={origin:u.uOrigin,normal:u.uNormal,viewDepth:u.uViewDepth,rotation:u.uCameraRotation,
       inverseProjection:u.uInverseProjection,near:u.uNear,far:u.uFar,rsUnits:u.uRsUnits,viewportWidth:d.viewport[2],viewportHeight:d.viewport[3]};
   const explanation=explainDiskEligibility(holeSource,input);assert.equal(explanation.eligible,d.geometryEligible);
   return{draw:d.id,frame:d.lifecycle.frameNo,...explanation};
  });
 }
 report.completed=true;
}catch(error){report.errors.push(error.stack||String(error));report.completed=false;process.exitCode=1;}
finally{
 if(run&&existsSync(join(out,'selection/selection-report.json'))){
  try{const observation=JSON.parse(readFileSync(join(out,'selection/selection-report.json'),'utf8'));if(observation.browser)report.browserStarted=true;}
  catch(error){report.errors.push('Observation readback: '+String(error));report.completed=false;process.exitCode=1;}
 }
 try{report.postSources=snapshot();assert.deepEqual(report.postSources,report.sources);}catch(error){report.errors.push(error.stack||String(error));report.completed=false;process.exitCode=1;}
 try{rmSync(temp,{recursive:true,force:true});}catch(error){report.errors.push(String(error));report.completed=false;process.exitCode=1;}
 save();
}
