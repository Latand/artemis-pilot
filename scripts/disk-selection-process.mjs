// One spawn and one deadline. Registered detached sessions are owned even if
// their immediate Node parent exits. No command-name or global process kill.
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,openSync,readSync,fstatSync,closeSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import owned from './disk-selection-owned.cjs';
const preload=fileURLToPath(new URL('./disk-selection-owned.cjs',import.meta.url));
export function runSelectionProcess(command,args,{cwd,env,deadlineMs,cleanupMs,onTimeout=()=>{},stdio='inherit',journalPath}){
    return new Promise((resolve,reject)=>{
        const temporary=journalPath?null:mkdtempSync(join(tmpdir(),'disk-owned-'));
        const journal=journalPath||join(temporary,'processes.jsonl');
        writeFileSync(journal,'',{flag:'wx'});
        const supervisor=owned.identity(process.pid),known=new Map(),ownedSessions=new Map(),executables=new Map(),signals=[],errors=[];
        let child,rootIdentity,deadline,killTimer,lastTimer,poll,exited=false,exitInfo,settled=false,stopping=false,timedOut=false,unexpectedDescendants=false;
        const add=p=>{if(p&&Number.isInteger(p.pid)&&p.pid>1&&/^\d+$/.test(p.start)){
            known.set(p.pid,p);
            if(p.session===p.pid&&p.group===p.pid&&p.session!==supervisor.session)ownedSessions.set(p.session,p);
        }};
        const error=e=>{const message=String(e);if(!errors.includes(message))errors.push(message);};
        const collect=()=>{
            // Direct ownership comes from spawn/proc, never from journal I/O.
            // Preserve it even when the journal is malformed or over its cap.
            if(rootIdentity)add(rootIdentity);
            try{
                const fd=openSync(journal,'r');let bytes;
                try{const size=fstatSync(fd).size,limit=Math.min(size,owned.MAX_JOURNAL_BYTES);if(size>limit)error('Owned journal byte cap');
                    const buffer=Buffer.alloc(limit);let read=0;
                    while(read<limit){const n=readSync(fd,buffer,read,limit-read,read);if(n===0)break;read+=n;}
                    bytes=buffer.subarray(0,read).toString('utf8');
                }finally{closeSync(fd);}
                const lines=bytes.split('\n');lines.pop();const records=[];
                const identityRecord=p=>p&&typeof p==='object'&&['pid','ppid','group','session'].every(k=>Number.isInteger(p[k])&&p[k]>=0&&p[k]<=2147483647)
                    &&p.pid>1&&typeof p.start==='string'&&/^\d{1,32}$/.test(p.start);
                for(const line of lines)if(line){try{
                    const r=JSON.parse(line),p=r?.type==='self'?r.self:r?.type==='spawn'?r.child:null;
                    if(!identityRecord(p)||!identityRecord(r?.parent)){error('Malformed owned journal record');continue;}
                    records.push(r);
                }catch{error('Malformed owned journal row');}}
                for(let pass=0;pass<=records.length;pass++){
                    let progress=false;
                    for(const r of records){
                        const p=r.type==='self'?r.self:r.type==='spawn'?r.child:null;if(!p){error('Unknown owned journal record');continue;}
                        if(p.pid===child.pid&&owned.same(r.parent,supervisor)&&p.ppid===supervisor.pid){if(rootIdentity&&!owned.same(rootIdentity,p)){error('Root PID identity changed');continue;}rootIdentity||=p;}
                        const parent=known.get(r.parent?.pid);
                        if((p.pid===child.pid&&owned.same(p,rootIdentity))||(parent&&owned.same(parent,r.parent)&&p.ppid===parent.pid&&BigInt(p.start)>=BigInt(parent.start))){
                            const old=known.get(p.pid);if(old&&!owned.same(old,p)){error('Owned PID reused in journal');continue;}
                            if(!old){add(p);progress=true;}
                            else if(p.session===p.pid&&p.group===p.pid)add(p);
                            if(r.type==='spawn'&&typeof r.commandPath==='string'&&typeof r.processImage==='string')
                                executables.set(`${p.pid}:${p.start}`,{pid:p.pid,start:p.start,commandPath:r.commandPath,processImage:r.processImage});
                        }
                    }
                    if(!progress)break;
                }
            }catch(e){error(e);}
            const active=[];
            try{for(const p of owned.sessions()){
                const session=ownedSessions.get(p.session);if(!session||p.state==='Z')continue;
                const currentLeader=owned.identity(session.pid);
                if(currentLeader&&!owned.same(currentLeader,session)){error('Owned session leader PID reused');continue;}
                if(BigInt(p.start)<BigInt(session.start)||p.session===supervisor.session){error('Unverified session member');continue;}
                active.push(p);
            }}catch(e){error(e);}
            return active;
        };
        const signalOwned=kind=>{
            const members=collect(),groups=new Map();for(const member of members)groups.set(member.group,member);
            for(const [group,witness]of groups){
                if(group<=1||group===supervisor.group){error('Unsafe process group refused');continue;}
                const live=owned.identity(witness.pid),session=ownedSessions.get(witness.session);
                if(!owned.same(live,witness)||live.group!==group||live.session!==session?.pid)continue;
                const leader=owned.identity(session.pid);if(leader&&!owned.same(leader,session)){error('Reused session refused');continue;}
                try{process.kill(-group,kind);signals.push({group,session:session.pid,witnessPid:witness.pid,witnessStart:witness.start,signal:kind});}
                catch(e){if(e.code!=='ESRCH')error(e);}
            }
        };
        const finish=()=>{
            if(settled)return;settled=true;
            clearTimeout(deadline);clearTimeout(killTimer);clearTimeout(lastTimer);clearInterval(poll);
            process.removeListener('SIGTERM',abort);process.removeListener('SIGINT',abort);
            const remaining=collect();if(remaining.length)error('Owned live processes remain after cleanup');
            const result={...exitInfo,pid:child.pid,timedOut,childExited:exited,unexpectedDescendants,signalErrors:errors,
                ownership:{registered:known.size,sessions:[...ownedSessions.values()],executables:[...executables.values()],signals,remaining,journal}};
            if(temporary)rmSync(temporary,{recursive:true,force:true});resolve(result);
        };
        const stop=(timeout)=>{
            if(stopping||settled)return;stopping=true;timedOut=timeout;
            if(timeout)try{onTimeout();}catch(e){error('Timeout journal: '+String(e));}
            signalOwned('SIGTERM');poll=setInterval(()=>signalOwned('SIGTERM'),50);
            killTimer=setTimeout(()=>{
                clearInterval(poll);signalOwned('SIGKILL');
                // Give exit/reaping notifications one bounded second. Keep the
                // final kill even after the immediate child has exited.
                lastTimer=setTimeout(finish,1000);
            },cleanupMs);
        };
        const abort=()=>stop(true);
        const childEnv={...env,NODE_OPTIONS:`--require ${JSON.stringify(preload)}`,ARTEMIS_DISK_PROCESS_JOURNAL:journal};
        try{child=spawn(command,args,{cwd,env:childEnv,stdio,detached:true});rootIdentity=owned.identity(child.pid);}catch(e){if(temporary)rmSync(temporary,{recursive:true,force:true});reject(e);return;}
        process.once('SIGTERM',abort);process.once('SIGINT',abort);deadline=setTimeout(abort,deadlineMs);
        child.once('error',e=>{exitInfo={code:null,signal:null,error:String(e)};exited=true;if(!stopping)finish();});
        child.once('exit',(code,signalName)=>{
            exitInfo={code,signal:signalName};exited=true;
            if(!stopping){const remaining=collect();if(remaining.length){unexpectedDescendants=true;stop(false);}else finish();}
        });
    });
}
