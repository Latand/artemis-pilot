// Fresh full-app active optical cost. Reuse the immutable reviewed runner;
// remove only its source-inventory entry for the absent ring-proxy module.
// All frames, five trials, timing windows and numerical gates stay unchanged.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync,realpathSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {diskInputs,hash,verifyDiskSource,adaptDiskBenchmark} from './disk-plane-source-contract.mjs';
const root=resolve(process.argv[2]||'.'),out=resolve(process.argv[3]||'evidence/disk-plane-cost');
const baseline=resolve(process.env.BASE_ROOT||'');assert(process.env.BASE_ROOT);
const validate=process.argv.includes('--validate');assert(validate||process.argv.includes('--run'),'Explicit --validate or separately authorized --run required');
assert.equal(process.env.OPTICS_BENCH,'1');assert(['desktop','mobile'].includes(process.env.DEVICE));assert(['0','1'].includes(process.env.BLOOM));
const expected=process.env.EXPECTED_CANDIDATE_REVISION;assert(expected,'External exact candidate revision required');
assert.equal(resolve(dirname(fileURLToPath(import.meta.url)),'..'),root,'Execute the committed candidate wrapper');
const temporary=mkdtempSync(join(tmpdir(),'disk-plane-cost-'));mkdirSync(out,{recursive:true});
const provenance={baseline:diskInputs.baseline,candidate:expected,mode:validate?'validate':'run',passed:false,errors:[],scope:'Issue50 only; ring-depth/finite-source lens fixes and issue49 remain excluded'};
try{
    provenance.sources={A:verifyDiskSource(baseline,'A',diskInputs.baseline),B:verifyDiskSource(root,'B',expected)};
    assert.equal(realpathSync(join(root,'node_modules')),realpathSync(join(baseline,'node_modules')),'Shared dependency tree');
    const native=execFileSync('git',['show',diskInputs.benchmarkReference+':'+diskInputs.benchmarkPath],{cwd:root,encoding:'utf8'});
    const effective=adaptDiskBenchmark(native);
    const helper=readFileSync(join(root,'scripts/explored-system-hooks.mjs'),'utf8');assert.equal(hash(helper),diskInputs.nativeHookHash);
    provenance.harness={reference:diskInputs.benchmarkReference,originalSha256:hash(native),effectiveSha256:hash(effective),hookSha256:hash(helper),
        delta:'Remove one source-inventory filename; no runtime/fixture/timing/gate changes'};
    writeFileSync(join(temporary,'package.json'),'{"type":"module"}');mkdirSync(join(temporary,'scripts'));
    writeFileSync(join(temporary,'scripts/benchmark-explored-systems.mjs'),effective);writeFileSync(join(temporary,'scripts/explored-system-hooks.mjs'),helper);
    symlinkSync(join(root,'node_modules'),join(temporary,'node_modules'),'dir');
    writeFileSync(join(out,'effective-benchmark.mjs'),effective);writeFileSync(join(out,'provenance.json'),JSON.stringify(provenance,null,2));
    const result=spawnSync(process.execPath,[join(temporary,'scripts/benchmark-explored-systems.mjs'),root,join(out,'paired'),...(validate?['--validate']:[])],
        {cwd:root,stdio:'inherit',env:{...process.env,BASE_ROOT:baseline,PAIRED_CPU_PROFILE:'0'}});
    assert.equal(result.status,0,'Native benchmark failed; raw reports and all original gates are preserved');provenance.passed=true;
}catch(error){provenance.errors.push(error.stack||String(error));process.exitCode=1;}
finally{
    try{provenance.postSources={A:verifyDiskSource(baseline,'A',diskInputs.baseline),B:verifyDiskSource(root,'B',expected)};
        assert.deepEqual(provenance.postSources,provenance.sources);
    }catch(error){provenance.passed=false;provenance.errors.push(error.stack||String(error));process.exitCode=1;}
    writeFileSync(join(out,'provenance.json'),JSON.stringify(provenance,null,2)+'\n');rmSync(temporary,{recursive:true,force:true});
}
