// Preloaded only into this diagnostic's owned Node tree. Preserve spawn
// arguments/handles; journal identities and paths, never arguments or env.
const fs=require('node:fs'), cp=require('node:child_process'), mod=require('node:module');
const MAX_JOURNAL_BYTES=1024*1024, MAX_RECORD_BYTES=64*1024, MAX_RECORDS=4096;
function identity(pid){
    if(!Number.isInteger(pid)||pid<=1)return null;
    try{const raw=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),tail=raw.slice(raw.lastIndexOf(') ')+2).split(' ');
        return{pid,ppid:Number(tail[1]),group:Number(tail[2]),session:Number(tail[3]),start:tail[19],state:tail[0]};
    }catch(error){if(['ENOENT','ESRCH'].includes(error.code))return null;throw error;}
}
function same(a,b){return!!a&&!!b&&a.pid===b.pid&&a.start===b.start;}
function sessions(){
    const result=[];
    for(const name of fs.readdirSync('/proc'))if(/^\d+$/.test(name)){
        try{const p=identity(Number(name));if(p)result.push(p);}catch(error){if(error.code!=='EACCES')throw error;}
    }
    return result;
}
function install(){
    const file=process.env.ARTEMIS_DISK_PROCESS_JOURNAL;if(!file)return;
    if(globalThis[Symbol.for('artemis.disk.owned.spawn')])return;
    globalThis[Symbol.for('artemis.disk.owned.spawn')]=true;
    let stopping=false,count=0;
    const wait=new Int32Array(new SharedArrayBuffer(4)),lock=file+'.lock';
    function locked(operation){
        const deadline=process.hrtime.bigint()+1000000000n;
        while(true){try{fs.mkdirSync(lock);break;}catch(error){
            if(error.code!=='EEXIST')throw error;
            if(process.hrtime.bigint()>=deadline)throw Error('Owned journal admission lock timeout');
            Atomics.wait(wait,0,0,5);
        }}
        try{return operation();}finally{fs.rmdirSync(lock);}
    }
    function capacity(needed){
        const size=fs.statSync(file).size;
        if(size+needed>MAX_JOURNAL_BYTES)throw Error('Owned journal admission capacity exceeded');
        if(size){const fd=fs.openSync(file,'r'),last=Buffer.alloc(1);
            try{if(fs.readSync(fd,last,0,1,size-1)!==1||last[0]!==10)throw Error('Owned journal admission requires a complete row boundary');}
            finally{fs.closeSync(fd);}
        }
    }
    function appendLocked(record){
        const line=JSON.stringify(record)+'\n',bytes=Buffer.byteLength(line);
        if(bytes>MAX_RECORD_BYTES||count>=MAX_RECORDS)throw Error('Owned journal record cap exceeded');
        capacity(bytes);fs.appendFileSync(file,line);count++;
    }
    locked(()=>appendLocked({type:'self',self:identity(process.pid),parent:identity(process.ppid)}));
    process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
    const original=cp.spawn;
    cp.spawn=function(...args){
        if(stopping)throw Error('Owned diagnostic is stopping; new spawn rejected');
        return locked(()=>{
            // Reserve a worst-case complete row BEFORE creating a process.
            // The shared lock spans admission, spawn and registration, so
            // concurrent valid writers cannot push an accepted row past the
            // same bounded prefix consumed by the supervisor.
            if(count>=MAX_RECORDS)throw Error('Owned journal admission count exceeded');
            capacity(MAX_RECORD_BYTES);
            const parent=identity(process.pid),child=original.apply(this,args);
            const options=(Array.isArray(args[1])?args[2]:args[1])||{};
            const spawned=identity(child.pid);if(!spawned)return child;
            let commandPath=null,processImage=null;
            try{commandPath=fs.realpathSync(args[0]);}catch{}
            try{processImage=fs.readlinkSync(`/proc/${child.pid}/exe`);}catch{}
            try{appendLocked({type:'spawn',parent,child:spawned,detached:options.detached===true,commandPath,processImage});}
            catch(error){
                // Concurrent non-protocol corruption or I/O failure after
                // spawn must kill this just-created child before propagating.
                const current=identity(child.pid);
                if(same(current,spawned))try{process.kill(options.detached&&current.group===current.pid?-current.pid:current.pid,'SIGKILL');}catch{}
                throw error;
            }
            // Linux libuv returns after child exec/setsid. No later duplicate
            // spawn-event append is needed or allowed to consume capacity.
            return child;
        });
    };
    mod.syncBuiltinESMExports();
}
module.exports={identity,same,sessions,MAX_JOURNAL_BYTES,MAX_RECORD_BYTES};
if(process.env.ARTEMIS_DISK_PROCESS_JOURNAL)install();
