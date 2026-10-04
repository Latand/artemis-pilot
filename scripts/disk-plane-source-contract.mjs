import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,existsSync} from 'node:fs';
import {join} from 'node:path';
export const diskInputs=JSON.parse(readFileSync(new URL('./fixtures/disk-plane-inputs.json',import.meta.url)));
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
export function adaptDiskBenchmark(native){
    assert.equal(hash(native),diskInputs.benchmarkHash,'Exact immutable full-cost runner required');
    const token="'src/render/ringSamplingDepth.js',";assert.equal(native.split(token).length,2);
    return native.replace(token,'');
}
export function verifyDiskSource(root,label,expectedHead){
    assert(['A','B'].includes(label));assert.match(expectedHead,/^[a-f0-9]{40}$/);
    assert.equal(realpathSync(git(root,'rev-parse','--show-toplevel').trim()),realpathSync(root));
    assert.equal(git(root,'rev-parse','HEAD').trim(),expectedHead);
    if(label==='A')assert.equal(expectedHead,diskInputs.baseline);
    git(root,'merge-base','--is-ancestor',diskInputs.baseline,expectedHead);
    const paths=[...diskInputs.productionPaths,'scripts'];
    git(root,'diff','--exit-code','--cached','HEAD','--',...paths);git(root,'diff','--exit-code','--',...paths);
    assert.equal(git(root,'ls-files','--others','--',...paths),'','No ignored/untracked served/config/harness inputs');
    const fingerprint=hash(execFileSync('git',['ls-files','--stage','-z','--',...diskInputs.productionPaths],{cwd:root}));
    assert.equal(fingerprint,diskInputs.fingerprints[label],'Only the declared disk block may differ from main');
    const entries=new Map(git(root,'ls-tree','-rz','HEAD').split('\0').filter(Boolean).map(record=>{
        const tab=record.indexOf('\t');return [record.slice(tab+1),record.slice(0,tab).split(' ')];
    }));
    let protectedBlobs=0;
    for(const path of git(root,'ls-files','-z','--',...paths).split('\0').filter(Boolean)){
        assert(entries.has(path));const[mode,type,sha]=entries.get(path);assert(type==='blob'&&['100644','100755'].includes(mode));
        assert.equal(git(root,'hash-object','--',path).trim(),sha,'Protected input bytes differ: '+path);protectedBlobs++;
    }
    assert(!existsSync(join(root,'src/render/ringSamplingDepth.js')),'No ring-depth proxy in either disk-only source');
    const changed=git(root,'diff','--name-only',diskInputs.baseline,'HEAD','--','src').trim().split('\n').filter(Boolean);
    assert.deepEqual(changed,label==='A'?[]:['src/holeOptics.js']);
    const hole=readFileSync(join(root,'src/holeOptics.js'));
    if(label==='A')assert.deepEqual(hole,execFileSync('git',['show',diskInputs.baseline+':src/holeOptics.js'],{cwd:root}));
    else assert.equal(hash(hole),diskInputs.candidateHoleSha256,'Exact frozen normalized disk shader required');
    return {revision:expectedHead,tree:git(root,'rev-parse','HEAD^{tree}').trim(),fingerprint,protectedBlobs,
        holeSha256:hash(hole),lensSha256:hash(readFileSync(join(root,'src/lensing.js'))),
        planetAppearanceSha256:hash(readFileSync(join(root,'src/render/planetAppearance.js'))),ringSamplingDepthAbsent:true};
}
