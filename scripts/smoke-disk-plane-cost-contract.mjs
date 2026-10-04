import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {diskInputs,adaptDiskBenchmark} from './disk-plane-source-contract.mjs';
const native=execFileSync('git',['show',diskInputs.benchmarkReference+':'+diskInputs.benchmarkPath],{encoding:'utf8'});
const effective=adaptDiskBenchmark(native),token="'src/render/ringSamplingDepth.js',",index=native.indexOf(token);
assert.equal(effective.slice(0,index)+token+effective.slice(index),native,'Only the absent module source-inventory entry changes');
for(const mutation of [
    text=>text.replace('warmupFrames = 120','warmupFrames = 119'),
    text=>text.replace('samplesPerBlock = 60','samplesPerBlock = 59'),
    text=>text.replace("['ABBA', 'BAAB', 'ABBA', 'BAAB', 'ABBA']","['ABBA']"),
    text=>text.replace('scenario.medianPairedRatio <= 1.05','scenario.medianPairedRatio <= 1.5'),
    text=>text.replace('beforeLong.measuredTotalBlockingMs * 1.05 + 50','Infinity'),
    text=>text.replace('Math.max(200, beforeLong.measuredMaximumMs * 1.05)','Infinity'),
    text=>text.replace('Math.ceil(beforeLong.measuredCount * 1.05) + 1','Infinity'),
]){
    const changed=mutation(native);assert.notEqual(changed,native);assert.throws(()=>adaptDiskBenchmark(changed));
}
execFileSync(process.execPath,['--input-type=module','--check'],{input:effective});
console.log('Disk-only cost adapter: immutable native hooks, all five trials and seven threshold/count negative controls passed');
