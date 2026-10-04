import assert from 'node:assert/strict';
import {validateNativeLensProof} from './optics-native-filter-proof.mjs';
import {inputs,validatePairReport,inspectInputs} from './optics-invariant-preflight.mjs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const proof={contextLost:false,glError:0,linked:true,ringPresent:1,lensCount:1,
    shaders:[{compiled:true,source:'lensGeometry[4]; iteration < 3'},{compiled:true,source:'vertex'}],
    texture:{bound:true,minFilter:9987,magFilter:9729,wrapS:10497,wrapT:33071,anisotropy:4}};
validateNativeLensProof(proof);
let negatives=0;
for(const change of [p=>p.contextLost=true,p=>p.glError=1282,p=>p.linked=false,p=>p.ringPresent=0,p=>p.lensCount=0,
    p=>p.shaders[0].compiled=false,p=>p.shaders[0].source='',p=>p.texture.bound=false,p=>p.texture.minFilter=9728,
    p=>p.texture.magFilter=9728,p=>p.texture.anisotropy=1]){
    const broken=structuredClone(proof);change(broken);assert.throws(()=>validateNativeLensProof(broken));negatives++;
}
const head='b'.repeat(40),pair={baselineRevision:inputs.baseline,candidateRevision:head,device:'mobile',opticsBloom:false,
    mode:'nearby-Saturn-lens',warmupFrames:120,samplesPerBlock:60,orders:['ABBA','BAAB','ABBA','BAAB','ABBA'],errors:[],passed:true,longTaskBudget:{passed:true},
    scenarios:[{passesFivePercentTarget:true,warmup:{A:Array(124).fill({}),B:Array(124).fill({})},
        trials:['ABBA','BAAB','ABBA','BAAB','ABBA'].map(order=>({order,blocks:[...order].map(label=>({label,samples:Array(60).fill({})}))}))}]};
validatePairReport(pair,head);
for(const change of [r=>r.baselineRevision='531da641fe5d61b4cdc7130285418c218299d263',r=>r.candidateRevision='a'.repeat(40),
    r=>r.device='desktop',r=>r.opticsBloom=true,r=>r.warmupFrames=119,r=>r.samplesPerBlock=59,r=>r.orders.pop(),r=>r.scenarios[0].trials.pop(),r=>r.errors.push('error'),
    r=>r.scenarios[0].trials[0].blocks[0].samples.pop(),r=>r.scenarios[0].warmup.A.splice(0,6),r=>r.passed=false,
    r=>r.scenarios[0].warmup.A.splice(0,4),r=>r.scenarios[0].warmup.B.splice(0,4),
    r=>r.longTaskBudget.passed=false,r=>r.scenarios[0].passesFivePercentTarget=false]){
    const broken=structuredClone(pair);change(broken);assert.throws(()=>validatePairReport(broken,head));negatives++;
}
const temporary=mkdtempSync(join(tmpdir(),'optics-input-guards-'));
const git=(...args)=>execFileSync('git',args,{cwd:temporary,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try{
    git('init','-q');mkdirSync(join(temporary,'src'));writeFileSync(join(temporary,'src/example.js'),'export const x=1;\n');
    writeFileSync(join(temporary,'.gitignore'),'.env.local\n.env.ignored\n');
    for(const path of ['vite.config.js','.env.local','tsconfig.json'])writeFileSync(join(temporary,path),'original fixture input\n');
    git('add','.');git('add','-f','.env.local');
    git('-c','user.name=QA','-c','user.email=qa@example.invalid','commit','-qm','Guard fixture');
    const revision=git('rev-parse','HEAD');
    const fingerprint=createHash('sha256').update(execFileSync('git',['ls-files','--stage','-z','--',...inputs.productionPaths],{cwd:temporary})).digest('hex');
    inspectInputs(temporary,revision,fingerprint);
    for(const path of ['.env.ignored','src/untracked.js']){
        writeFileSync(join(temporary,path),'extra');assert.throws(()=>inspectInputs(temporary,revision,fingerprint));negatives++;rmSync(join(temporary,path));
    }
    git('update-index','--assume-unchanged','src/example.js');writeFileSync(join(temporary,'src/example.js'),'changed');
    assert.throws(()=>inspectInputs(temporary,revision,fingerprint));negatives++;git('update-index','--no-assume-unchanged','src/example.js');git('checkout','--','src/example.js');
    git('update-index','--skip-worktree','src/example.js');writeFileSync(join(temporary,'src/example.js'),'changed');
    assert.throws(()=>inspectInputs(temporary,revision,fingerprint));negatives++;git('update-index','--no-skip-worktree','src/example.js');git('checkout','--','src/example.js');
    for(const path of ['vite.config.js','.env.local','tsconfig.json'])for(const flag of ['assume-unchanged','skip-worktree']){
        git('update-index','--'+flag,path);writeFileSync(join(temporary,path),'hidden tracked config edit\n');
        git('diff','--exit-code','--',path); // Establish the original blind spot.
        assert.throws(()=>inspectInputs(temporary,revision,fingerprint),/Protected input bytes differ/,
            `Direct byte guard must reject ${path} under ${flag}`);negatives++;
        git('update-index','--no-'+flag,path);git('checkout','--',path);
    }
    writeFileSync(join(temporary,'src/example.js'),'staged');git('add','src/example.js');assert.throws(()=>inspectInputs(temporary,revision,fingerprint));negatives++;
}finally{rmSync(temporary,{recursive:true,force:true});}
console.log(JSON.stringify({preflightNegativeControls:negatives,scope:'Binding/filter/schema guards; native runner retains all numerical performance gates'}));
