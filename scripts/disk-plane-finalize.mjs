import {writeFile,unlink} from 'node:fs/promises';
import {renameSync} from 'node:fs';
let writeSequence=0;

export async function initializeDiskReport(path,report){
    // A run cannot inherit a completed:true report from an earlier attempt.
    // Fail before starting resources if this evidence destination is occupied.
    await writeFile(path,JSON.stringify({...report,completed:false},null,2)+'\n',{flag:'wx'});
}

// Serialize before awaiting, then publish one complete snapshot atomically.
// An aborted timed-out write cannot later replace a failure report with success.
export async function atomicDiskReport(path,report,{signal}={}){
    const temporary=path+`.${process.pid}.${++writeSequence}.tmp`;
    const snapshot=JSON.stringify(report,null,2)+'\n';
    try{
        await writeFile(temporary,snapshot,{signal});
        signal?.throwIfAborted();
        // No async gap between the cancellation check and atomic publication.
        renameSync(temporary,path);
    }catch(error){
        try{await unlink(temporary);}catch{/* A missing/failed temporary file is not authoritative evidence. */}
        throw error;
    }
}

export async function finalizeDiskProbe({report,originalError,hadOriginalError=originalError!==undefined,verifySources,flush,closeBrowser,closeServer,timeoutMs=10000}){
    const requestedComplete=report.completed===true&&!hadOriginalError;
    report.completed=false;
    const failures=[];
    const describe=error=>error?.stack||String(error);
    if(hadOriginalError)report.failure=describe(originalError);
    async function attempt(name,operation){
        const controller=new AbortController();let timer;
        try{
            await Promise.race([
                Promise.resolve().then(()=>operation(controller.signal)),
                new Promise((_,reject)=>{timer=setTimeout(()=>{
                    const error=new Error(`${name} exceeded ${timeoutMs}ms`);controller.abort(error);reject(error);
                },timeoutMs);}),
            ]);
            return {name,passed:true};
        }catch(error){
            failures.push({name,error:describe(error)});return {name,passed:false};
        }finally{clearTimeout(timer);}
    }
    const verification=await attempt('source-verification',verifySources);
    // All three start independently. A failed or hung report/browser operation
    // cannot prevent attempting to close the other resource.
    const cleanup=await Promise.all([
        attempt('failure-checkpoint',signal=>flush({signal})),
        attempt('browser-close',closeBrowser),
        attempt('server-close',closeServer),
    ]);
    report.finalization={attempts:[verification,...cleanup],errors:failures};
    report.completed=requestedComplete&&failures.length===0;
    const finalWrite=await attempt('final-report',signal=>flush({signal}));
    if(!finalWrite.passed){
        report.completed=false;
        // Preserve the original failure even if the final evidence store also
        // fails. The earlier atomic checkpoint is already completed:false.
        await attempt('failure-report',signal=>flush({signal}));
    }
    if(hadOriginalError)throw originalError;
    if(failures.length)throw new AggregateError(failures.map(f=>new Error(f.error)),'Disk-plane finalization failed');
}
