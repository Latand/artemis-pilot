import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {diskInputs,verifyDiskSource} from './disk-plane-source-contract.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const valid=verifyDiskSource(root,'B',head);
assert.equal(valid.sourceTree,diskInputs.reviewedSourceTree);
for(const [key,wrong] of [['reviewedSourceTree','0'.repeat(40)],['reviewedSourceHoleBlob','0'.repeat(40)],['candidateHoleSha256','0'.repeat(64)]]){
    const saved=diskInputs[key];diskInputs[key]=wrong;
    try{assert.throws(()=>verifyDiskSource(root,'B',head),undefined,`wrong ${key} rejects`);}finally{diskInputs[key]=saved;}
}
assert.deepEqual(verifyDiskSource(root,'B',head),valid,'negative proof controls leave exact source binding unchanged');
console.log('Disk source binding: actual reviewed source ancestor/tree/blob and exact bytes pass; three false-pin controls reject. No source mutation or browser execution.');
