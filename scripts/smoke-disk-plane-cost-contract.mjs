import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {diskInputs,diskMaximumTaskPolicy,adaptDiskBenchmark} from './disk-plane-source-contract.mjs';
const native=execFileSync('git',['show',diskInputs.benchmarkReference+':'+diskInputs.benchmarkPath],{encoding:'utf8'});
const effective=adaptDiskBenchmark(native),token="'src/render/ringSamplingDepth.js',",index=native.indexOf(token);
const oldMaximum='Math.max(200, beforeLong.measuredMaximumMs * 1.05)',newMaximum='Math.max(220, beforeLong.measuredMaximumMs * 1.05)';
assert.equal(effective.split(newMaximum).length,2);
const restoredFloor=effective.replace(newMaximum,oldMaximum);
assert.equal(restoredFloor.slice(0,index)+token+restoredFloor.slice(index),native,
    'Only the absent source-inventory entry and approved absolute maximum-task floor change');
assert.equal(diskMaximumTaskPolicy.absoluteFloorMs,220);assert.equal(diskMaximumTaskPolicy.previousAbsoluteFloorMs,200);assert.equal(diskMaximumTaskPolicy.baselineMultiplier,1.05);
const maximum=new Function('beforeLong',`return ${effective.match(/allowedMaximumMs: (Math\.max\([^\n]+\)),/)[1]};`);
for(const baseline of [0,179,200,209,220,352,394,1000])assert.equal(maximum({measuredMaximumMs:baseline}),Math.max(220,baseline*1.05));
assert.equal(maximum({measuredMaximumMs:179}),220);
assert(203<=maximum({measuredMaximumMs:179}));assert(220<=maximum({measuredMaximumMs:179}));assert(!(220.001<=maximum({measuredMaximumMs:179})));
assert.equal(maximum({measuredMaximumMs:352}),369.6,'No tolerance is compounded onto the existing relative allowance');
for(const mutation of [
    text=>text.replace('warmupFrames = 120','warmupFrames = 119'),
    text=>text.replace('samplesPerBlock = 60','samplesPerBlock = 59'),
    text=>text.replace("['ABBA', 'BAAB', 'ABBA', 'BAAB', 'ABBA']","['ABBA']"),
    text=>text.replace('scenario.medianPairedRatio <= 1.05','scenario.medianPairedRatio <= 1.5'),
    text=>text.replace('beforeLong.measuredTotalBlockingMs * 1.05 + 50','Infinity'),
    text=>text.replace('Math.max(200, beforeLong.measuredMaximumMs * 1.05)','Infinity'),
    text=>text.replace('Math.max(200, beforeLong.measuredMaximumMs * 1.05)','Math.max(220, beforeLong.measuredMaximumMs * 1.05) * 1.1'),
    text=>text.replace('Math.max(200, beforeLong.measuredMaximumMs * 1.05)','Math.max(220, beforeLong.measuredMaximumMs * 1.15)'),
    text=>text.replace('Math.ceil(beforeLong.measuredCount * 1.05) + 1','Infinity'),
]){
    const changed=mutation(native);assert.notEqual(changed,native);assert.throws(()=>adaptDiskBenchmark(changed));
}
execFileSync(process.execPath,['--input-type=module','--check'],{input:effective});
console.log('Disk-only cost adapter: exact two-token delta,220ms floor boundaries, unchanged relative allowance and nine threshold/count negative controls passed');

// A config-only PR must start the same gate that protects that config at run time.
// Require the complete explicit contract rather than a hand-maintained subset.
const workflow=readFileSync(new URL('../.github/workflows/disk-plane-validation.yml',import.meta.url),'utf8');
const protectedPatterns=diskInputs.productionPaths.map(path=>['src','public'].includes(path)?path+'/**':path);
function requireTriggerCoverage(text){
    const block=text.match(/^on:\n  pull_request:\n    paths:\n((?:      - '[^']+'\n)+)permissions:/m);
    assert(block,'Explicit PR-only path trigger required');
    const patterns=new Set([...block[1].matchAll(/^      - '([^']+)'$/gm)].map(match=>match[1]));
    for(const pattern of [...protectedPatterns,'scripts/**','.github/workflows/disk-plane-validation.yml'])
        assert(patterns.has(pattern),'Protected input must trigger validation: '+pattern);
}
requireTriggerCoverage(workflow);
for(const pattern of protectedPatterns){
    const altered=workflow.replace(`      - '${pattern}'\n`,'');assert.notEqual(altered,workflow);
    assert.throws(()=>requireTriggerCoverage(altered),/Protected input must trigger validation/);
}
console.log(`Disk workflow trigger: all${protectedPatterns.length} protected patterns and omission negatives passed`);
