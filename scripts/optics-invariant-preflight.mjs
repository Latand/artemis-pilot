import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const inputs=JSON.parse(readFileSync(new URL('./fixtures/optics-invariant-inputs.json',import.meta.url)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
export function inspectInputs(root,head,expected){
    assert.match(head,/^[a-f0-9]{40}$/);
    assert.equal(realpathSync(git(root,'rev-parse','--show-toplevel').trim()),realpathSync(root));
    assert.equal(git(root,'rev-parse','HEAD').trim(),head);
    const paths=[...inputs.productionPaths,'scripts'];
    git(root,'diff','--exit-code','--cached','HEAD','--',...paths);git(root,'diff','--exit-code','--',...paths);
    // --others without --exclude-standard includes ignored served/config files.
    assert.equal(git(root,'ls-files','--others','--',...paths),'','No ignored/untracked source, config or harness inputs');
    const fingerprint=sha(execFileSync('git',['ls-files','--stage','-z','--',...inputs.productionPaths],{cwd:root}));
    assert.equal(fingerprint,expected);
    // Compare bytes directly too, so assume-unchanged/skip-worktree flags cannot
    // make a changed tracked input look clean to git diff.
    // ls-files expands the protected pathspecs; ls-tree does not expand globs
    // such as vite.config.*. Resolve concrete tracked names, then look each
    // one up in the immutable full HEAD tree before checking its actual bytes.
    const tracked=git(root,'ls-files','-z','--',...paths).split('\0').filter(Boolean);
    const headBlobs=new Map(git(root,'ls-tree','-rz','HEAD').split('\0').filter(Boolean).map(record=>{
        const tab=record.indexOf('\t');return [record.slice(tab+1),record.slice(0,tab).split(' ')];
    }));
    const hashes={};
    for(const path of tracked){
        assert(headBlobs.has(path),'Protected tracked input must exist in HEAD: '+path);
        const [mode,type,blob]=headBlobs.get(path);
        assert(['100644','100755'].includes(mode)&&type==='blob','Regular protected Git blobs only');
        const actual=git(root,'hash-object','--',path).trim();assert.equal(actual,blob,'Protected input bytes differ: '+path);hashes[path]=actual;
    }
    return {revision:head,tree:git(root,'rev-parse','HEAD^{tree}').trim(),fingerprint,protectedBlobCount:Object.keys(hashes).length,
        protectedBlobsSha256:sha(JSON.stringify(hashes))};
}
export function validatePairReport(report,head){
    assert.equal(report.baselineRevision,inputs.baseline);assert.equal(report.candidateRevision,head);
    assert.equal(report.device,'mobile');assert.equal(report.opticsBloom,false);assert.equal(report.mode,'nearby-Saturn-lens');
    assert.equal(report.warmupFrames,120);assert.equal(report.samplesPerBlock,60);
    assert.deepEqual(report.orders,['ABBA','BAAB','ABBA','BAAB','ABBA']);
    assert.deepEqual(report.errors,[]);assert.equal(report.scenarios.length,1);
    const scenario=report.scenarios[0];assert.equal(scenario.trials.length,5);
    const counts={A:0,B:0};
    for(const [index,trial] of scenario.trials.entries()){
        assert.equal(trial.order,report.orders[index]);assert.equal(trial.blocks.length,4);
        for(const [blockIndex,block] of trial.blocks.entries()){
            assert.equal(block.label,trial.order[blockIndex]);assert.equal(block.samples.length,60);counts[block.label]+=block.samples.length;
        }
    }
    assert.deepEqual(counts,{A:600,B:600});
    for(const label of ['A','B'])assert.equal(scenario.warmup[label].length,124,'Exactly120 warmup plus4 native settled frames retained');
    assert.equal(scenario.passesFivePercentTarget,true);assert.equal(report.longTaskBudget.passed,true);assert.equal(report.passed,true);
    // Performance verdicts remain those of the unchanged native runner.
}
function main(){
    const root=resolve(process.env.CANDIDATE_ROOT||'.'),baseline=resolve(process.env.BASE_ROOT||'');
    const head=process.env.EXPECTED_CANDIDATE_REVISION;
    assert(process.env.BASE_ROOT&&head,'Exact source roots and candidate revision are mandatory');
    const A=inspectInputs(baseline,inputs.baseline,inputs.productionFingerprints.A);
    assert.equal(A.tree,inputs.baselineTree);
    const B=inspectInputs(root,head,inputs.productionFingerprints.B);
    assert.equal(realpathSync(join(baseline,'node_modules')),realpathSync(join(root,'node_modules')),'One dependency tree for both revisions');
    const parent=git(root,'rev-parse','HEAD^1').trim();
    assert.equal(git(root,'rev-parse',parent+'^{tree}').trim(),inputs.reviewedSourceTree,'Direct child of the reviewed invariant source');
    git(root,'diff','--exit-code',parent,'HEAD','--',...inputs.productionPaths);
    const harness={};for(const [path,hash] of Object.entries(inputs.harnessHashes)){
        harness[path]=sha(readFileSync(join(root,path)));assert.equal(harness[path],hash,'Pinned native harness changed: '+path);
    }
    const packages=Object.fromEntries(Object.keys(inputs.packages).map(name=>[name,JSON.parse(readFileSync(join(root,'node_modules',name,'package.json'))).version]));
    assert.deepEqual(packages,inputs.packages);
    const browsers=JSON.parse(readFileSync(join(root,'node_modules/playwright-core/browsers.json')));
    for(const name of ['chromium','chromium-headless-shell']){
        const browser=browsers.browsers.find(b=>b.name===name);assert.equal(browser.revision,'1243');assert.equal(browser.browserVersion,'153.0.8010.12');
    }
    const record={phase:process.env.PREFLIGHT_PHASE||'pre',sources:{A,B},reviewedSourceParent:parent,harness,
        packages,node:process.version,browserManifestSha256:sha(JSON.stringify(browsers)),runtime:'Chromium153.0.8010.12 / revision1243',
        scope:'Four pixel modes then one mobile/direct actual-main pair. No six-view run or release acceptance.'};
    if(process.env.PREFLIGHT_PAIR_REPORT)validatePairReport(JSON.parse(readFileSync(process.env.PREFLIGHT_PAIR_REPORT)),head);
    const out=resolve(process.env.ARTEMIS_EVIDENCE||'evidence/optics-invariant');mkdirSync(out,{recursive:true});
    writeFileSync(join(out,record.phase+'-provenance.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main();
