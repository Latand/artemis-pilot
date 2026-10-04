import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {atomicDiskReport,initializeDiskReport,finalizeDiskProbe} from './disk-plane-finalize.mjs';

const directory=await mkdtemp(join(tmpdir(),'disk-finalizer-'));
let tested=0;
async function run(name,{originalError,hadOriginalError=originalError!==undefined,failSource=false,failBrowser=false,failServer=false,
    failWrites=[],hangBrowser=false,hangServer=false,slowWrite=0}={}){
    const path=join(directory,name+'.json'),events=[],snapshots=[];
    const report={completed:false,name};await initializeDiskReport(path,report);report.completed=true;
    let writes=0,caught;
    try{
        await finalizeDiskProbe({report,originalError,hadOriginalError,timeoutMs:hangBrowser||hangServer||slowWrite?30:1000,
            verifySources:()=>{events.push('verify');if(failSource)throw Error('source failure');},
            closeBrowser:()=>{events.push('browser');if(failBrowser)throw Error('browser failure');if(hangBrowser)return new Promise(()=>{});},
            closeServer:()=>{events.push('server');if(failServer)throw Error('server failure');if(hangServer)return new Promise(()=>{});},
            flush:async options=>{
                const number=++writes,snapshot=structuredClone(report);snapshots.push(snapshot);events.push('write'+number);
                if(failWrites.includes(number))throw Error('write failure '+number);
                if(slowWrite===number)await new Promise(resolve=>setTimeout(resolve,90));
                await atomicDiskReport(path,snapshot,options);
            }});
    }catch(error){caught=error;}
    if(slowWrite)await new Promise(resolve=>setTimeout(resolve,120));
    assert(events.includes('browser')&&events.includes('server'),'Both close operations are attempted independently');
    assert.equal(snapshots[0].completed,false,'Checkpoint is never a premature success marker');
    const failed=hadOriginalError||failSource||failBrowser||failServer||hangBrowser||hangServer||failWrites.length||slowWrite;
    const disk=JSON.parse(await readFile(path,'utf8'));
    assert.equal(report.completed,!failed);assert.equal(disk.completed,!failed,'Atomic disk marker follows final cleanup outcome');
    if(hadOriginalError){assert.equal(caught,originalError,'Original thrown value is preserved');assert.equal(report.failure,originalError?.stack||String(originalError));}
    else if(failed)assert(caught instanceof AggregateError);
    else assert.equal(caught,undefined);
    if(failBrowser||hangBrowser)assert(report.finalization.errors.some(e=>e.name==='browser-close'));
    if(failServer||hangServer)assert(report.finalization.errors.some(e=>e.name==='server-close'));
    if(failSource)assert(report.finalization.errors.some(e=>e.name==='source-verification'));
    if(failWrites.includes(1))assert(report.finalization.errors.some(e=>e.name==='failure-checkpoint'));
    if(failWrites.includes(2)||slowWrite===2)assert(report.finalization.errors.some(e=>e.name==='final-report'));
    tested++;
}
try{
    await run('success');
    await run('checkpoint-fails',{failWrites:[1]});
    await run('browser-fails',{failBrowser:true});
    await run('server-fails',{failServer:true});
    await run('both-close-fail',{failBrowser:true,failServer:true});
    await run('source-fails',{failSource:true});
    await run('original-preserved',{originalError:new Error('original capture failure'),failSource:true,failBrowser:true,failServer:true,failWrites:[1]});
    await run('primitive-preserved',{originalError:0,hadOriginalError:true});
    await run('undefined-preserved',{originalError:undefined,hadOriginalError:true});
    await run('final-write-fails',{failWrites:[2]});
    await run('all-writes-fail',{failWrites:[1,2,3]});
    await run('browser-times-out',{hangBrowser:true});
    await run('server-times-out',{hangServer:true});
    await run('checkpoint-times-out',{slowWrite:1});
    await run('final-write-times-out',{slowWrite:2});
    const path=join(directory,'exclusive.json');await initializeDiskReport(path,{completed:true});
    assert.equal(JSON.parse(await readFile(path,'utf8')).completed,false);
    const before=await readFile(path,'utf8');await assert.rejects(initializeDiskReport(path,{completed:true}),/EEXIST/);
    assert.equal(await readFile(path,'utf8'),before,'Refuse reuse instead of overwriting previous evidence');tested++;
    const controller=new AbortController();controller.abort(Error('cancelled write'));
    await assert.rejects(atomicDiskReport(path,{completed:true},{signal:controller.signal}));
    assert.equal(await readFile(path,'utf8'),before,'An aborted late success cannot overwrite the failure checkpoint');tested++;
    const source=readFileSync(new URL('./probe-disk-plane.mjs',import.meta.url),'utf8');
    assert(source.includes('await finalizeDiskProbe({report,originalError,hadOriginalError,'),'The actual probe uses the tested finalizer');
    assert(source.includes('flush,closeBrowser:()=>browser?.close(),closeServer:()=>server?.close()'));
    assert(source.indexOf('await initializeDiskReport(')<source.indexOf('browser = await chromium.launch('),'Fresh false marker precedes all browser resources');
    console.log(JSON.stringify({test:'Exact disk probe finalizer',cases:tested,originalErrorPreserved:true,independentBoundedCloseAttempts:true,atomicCompletionMarker:true,browserStarted:false}));
}finally{await rm(directory,{recursive:true,force:true});}
