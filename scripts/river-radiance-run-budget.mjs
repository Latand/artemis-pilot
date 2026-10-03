import assert from 'node:assert/strict';
import { openSync,writeFileSync,fsyncSync,closeSync,renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const runLimits=Object.freeze({preparationMs:60*60000,warmupMs:15*60000,measurementMs:55*60000,
  assetSettlementMs:5*60000,checkpointMs:5000,jobMinutes:135});

// Sync atomic replacement also works from SIGTERM/exit handlers. A timeout
// cannot leave a truncated JSON file or an unflushed completed sample.
export function durableReport(path,report){
  const temporary=path+'.tmp',file=openSync(temporary,'w');
  try{writeFileSync(file,JSON.stringify(report,null,2)+'\n');fsyncSync(file);}finally{closeSync(file);}
  renameSync(temporary,path);
  const directory=openSync(dirname(path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}

export function installReportSignals(report,getBudget,save){
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{
    report.errors.push({message:`Interrupted by ${signal}; incomplete evidence retained`});report.passed=false;report.shardComplete=false;
    getBudget()?.checkpoint();save();process.exit(signal==='SIGTERM'?143:130);
  });
  process.once('exit',()=>save());
}

export function phaseBudget(phases,save,{now=()=>performance.now(),schedule=setTimeout,cancel=clearTimeout}={}){
  let active=null;
  const expired=(entry,deadline)=>!Number.isFinite(now())||now()>=deadline;
  const fail=(deadline)=>{
    active.elapsedMs=now()-active.startedAtMs;active.timedOut=true;
    active.timeoutDeadlineMs=deadline;save();
    return new Error(`${active.name} deadline expired during ${active.pendingOperation||'phase boundary'}`);
  };
  return {
    start(name){assert(!active,'Finish the previous phase');const limit=runLimits[name+'Ms'];assert(limit);
      active={name,limitMs:limit,startedAtMs:now(),completed:false,timedOut:false};phases.push(active);save();},
    async run(operation,description,additionalDeadline=Infinity){
      assert(active);const deadline=Math.min(active.startedAtMs+active.limitMs,additionalDeadline);
      active.pendingOperation=description;save();if(expired(active,deadline))throw fail(deadline);
      let timer;
      try{
        const value=await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{
          timer=schedule(()=>reject(fail(deadline)),Math.max(0,deadline-now()));
        })]);
        if(expired(active,deadline))throw fail(deadline);
        delete active.pendingOperation;active.elapsedMs=now()-active.startedAtMs;save();return value;
      }finally{cancel(timer);}
    },
    finish(){assert(active);if(expired(active,active.startedAtMs+active.limitMs))throw fail(active.startedAtMs+active.limitMs);
      active.elapsedMs=now()-active.startedAtMs;active.completed=true;delete active.pendingOperation;save();active=null;},
    checkpoint(){if(active)active.elapsedMs=now()-active.startedAtMs;save();},
  };
}

export function validatePhases(phases){
  assert.deepEqual(phases.map(p=>p.name),['preparation','warmup','measurement']);
  for(const phase of phases){
    assert.equal(phase.limitMs,runLimits[phase.name+'Ms']);
    assert(phase.completed&&!phase.timedOut&&!phase.pendingOperation);
    assert(Number.isFinite(phase.startedAtMs)&&Number.isFinite(phase.elapsedMs)&&phase.elapsedMs>=0&&phase.elapsedMs<phase.limitMs);
  }
  for(let i=1;i<phases.length;i++)assert(phases[i].startedAtMs>=phases[i-1].startedAtMs+phases[i-1].elapsedMs);
}
