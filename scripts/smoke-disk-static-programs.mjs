import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {THREE,source,makeDisk,makeMutatedDisk,makeCamera,pose,harness} from './qa/disk-static-harness.mjs';
let checks=0;const check=(r,mode,label)=>{assert.equal(r.mode,mode,label);assert.equal(r.flag,mode,label+' CPU mode');checks++;};
const h=harness(),d=makeDisk(),c=makeCamera();
check(h.draw(d,c),0,'initial draw compiles safe fallback');check(h.draw(d,c),1,'qualified next draw compiles fast program');
const stable={queries:h.state.queries,builds:h.state.builds,version:d.material.version};
for(let i=0;i<120;i++)check(h.draw(d,c),1,'steady eligible draw');
assert.deepEqual({queries:h.state.queries,builds:h.state.builds,version:d.material.version},stable,'steady draws add no capability query, build or version update');
assert.equal(h.cache().size,2,'two programs for one output/precision context');
for(const pitch of [0,.00065,.1,-.00065]){pose(c,pitch);check(h.draw(d,c),0,'signed crossing normalized');}
for(let i=0;i<64;i++){pose(c,i%2?.48:0);check(h.draw(d,c),i%2?1:0,'alternating boundary reuses cached variants');}
assert.equal(h.state.builds,2,'arbitrary mode transitions never compile again');
pose(c,-.48);check(h.draw(d,c),1,'reflected view');pose(c);
c.near=500;c.updateProjectionMatrix();check(h.draw(d,c),0,'near clipping');c.near=.02;c.far=650;c.updateProjectionMatrix();check(h.draw(d,c),0,'far clipping');c.far=1e7;c.updateProjectionMatrix();check(h.draw(d,c),1,'tier recovery');
c.setViewOffset(1000,1000,10,0,900,1000);check(h.draw(d,c),0,'asymmetric projection');c.clearViewOffset();check(h.draw(d,c),1,'symmetric recovery');
const parent=new THREE.Group();parent.add(c);parent.updateMatrixWorld(true);check(h.draw(d,c),0,'parented camera');parent.remove(c);c.updateMatrixWorld(true);check(h.draw(d,c),1,'unparented recovery');
c.scale.setScalar(2);c.updateMatrixWorld(true);check(h.draw(d,c),0,'scaled camera');c.scale.setScalar(1);c.updateMatrixWorld(true);check(h.draw(d,c),1,'scale recovery');
h.state.viewport.set(0,0,3,3);check(h.draw(d,c),0,'uncertain viewport');h.state.viewport.set(0,0,430,932);check(h.draw(d,c),1,'mobile viewport');
d.material.uniforms.uDiskOn.value=0;check(h.draw(d,c),0,'disabled disk');assert.equal(h.state.draws.at(-1).count,0);d.material.uniforms.uDiskOn.value=1;check(h.draw(d,c),1,'reenabled disk');
// Actual getProgram, parameter and cache-key code handles precompile, multiple
// holes, precision inheritance, cached variants and context-cache replacement.
const shared=makeDisk();check(h.draw(shared,c),0,'new hole fallback');check(h.draw(shared,c),1,'new hole fast');assert.equal(h.state.builds,2,'holes share both programs');
const pre=harness(),pd=makeDisk();assert.equal(pre.compile(pd).parameters.defines.DISK_UNCLIPPED,0);check(pre.draw(pd,c),1,'renderer.compile qualifies but never precompiles unsafe fast mode');assert.equal(pre.cache().size,2);assert.equal(pre.compile(pd).parameters.defines.DISK_UNCLIPPED,0);check(pre.draw(pd,c),1,'unarmed later precompile returns to safe fallback key');assert.equal(pre.cache().size,2);
const restoreBefore=h.state.builds;h.recover();check(h.draw(d,c),1,'context-cache recovery requalifies before specialized key');assert.equal(h.state.builds,restoreBefore+1);
const low=harness(),ld=makeDisk();low.seedPrecision('mediump');check(low.draw(ld,c),0,'actual inherited mediump');low.seedPrecision('highp');low.state.force=true;check(low.draw(ld,c),0,'sticky precision rejection');low.seedPrecision('mediump');check(low.draw(ld,c),0,'cached mediump stays normalized');
const transition=harness(),td=makeDisk();check(transition.draw(td,c),0,'transition initial');check(transition.draw(td,c),1,'transition fast');transition.seedPrecision('mediump');transition.state.force=true;check(transition.draw(td,c),0,'new mediump fast-key shader has HIGH_PRECISION fallback guard');transition.seedPrecision('highp');check(transition.draw(td,c),0,'safe cached highp cannot defeat sticky rejection');
for(const missing of [false,true]){const bad=harness(),bd=makeDisk();check(bad.draw(bd,c),0,'capability initial');check(bad.draw(bd,c),1,'capability fast');bad.recover();if(missing)bad.state.formatThrows=true;else bad.state.format={precision:16,rangeMin:62,rangeMax:62};check(bad.draw(bd,c),0,'recovery capability rejection before program key');
 check(bad.draw(bd,c),0,'key-hook version change permits one cached follow-up lookup');
 const settled={queries:bad.state.queries,builds:bad.state.builds,lookups:bad.state.lookups,version:bd.material.version};
 for(let i=0;i<10;i++)check(bad.draw(bd,c),0,'rejected precision remains stable');
 assert.deepEqual({queries:bad.state.queries,builds:bad.state.builds,lookups:bad.state.lookups,version:bd.material.version},settled,'key downgrade cannot create ongoing cache churn');
}
const stale=harness(),sd=makeDisk(),foreign=harness();check(stale.draw(sd,c),0,'stale setup');check(stale.draw(sd,c),1,'stale fast');sd.onBeforeRender(stale.renderer,stale.scene,c);foreign.compile(sd);sd.onAfterRender();check(foreign.draw(sd,c),0,'stale foreign precompile cannot seed an unsafe local program');assert.equal(foreign.cache().size,2);check(stale.draw(sd,c),1,'original renderer keeps valid independent program');
const targets=harness(),bd=makeDisk();check(targets.draw(bd,c),0,'target initial');check(targets.draw(bd,c),1,'target direct');
for(let i=0;i<20;i++){targets.state.target=i%2?null:{texture:{colorSpace:THREE.LinearSRGBColorSpace},isXRRenderTarget:false};pose(c,i%3?0:.48);check(targets.draw(bd,c),i%3?0:1,'output-target and boundary variants');}
assert.equal(targets.cache().size,4,'exactly two modes per output-color variant');
// Review reproduction: unarmed B.compile must invalidate A's cached fast
// program even when A's next camera already wants the shared zero define.
function crossRendererPrecompile(disk,changeCamera){
 const a=harness(),b=harness(),camera=makeCamera();a.draw(disk,camera);a.draw(disk,camera);
 const before=disk.material.version;b.compile(disk);const after=disk.material.version;
 changeCamera(camera);return{draw:a.draw(disk,camera),before,after,a,b,camera,disk};
}
for(const change of [camera=>pose(camera,0),camera=>pose(camera,.00065),camera=>{camera.near=500;camera.updateProjectionMatrix();},camera=>{camera.far=650;camera.updateProjectionMatrix();}]){
 const x=crossRendererPrecompile(makeDisk(),change);assert.equal(x.after,x.before+1,'cross-renderer compile changes version');check(x.draw,0,'unarmed cross-renderer compile cannot bypass fallback');
 pose(x.camera);x.camera.near=.02;x.camera.far=1e7;x.camera.updateProjectionMatrix();check(x.a.draw(x.disk,x.camera),1,'safe eligible view reuses fast program after cross-renderer compile');
}
const direct=harness(),dd=makeDisk(),dc=makeCamera();direct.draw(dd,dc);direct.draw(dd,dc);const directVersion=dd.material.version;
assert.equal(dd.material.customProgramCacheKey(),'hole-disk-static:0');assert.equal(dd.material.version,directVersion+1);
pose(dc,0);check(direct.draw(dd,dc),0,'unarmed direct key query invalidates cached fast program');
const marker='        setDiskMode(mode);\n        if (!mode)';assert.equal(source.split(marker).length,2);
const mutated=source.replace(marker,'        disk.material.defines.DISK_UNCLIPPED=mode;\n        if (!mode)');
const broken=crossRendererPrecompile(makeMutatedDisk(mutated),camera=>pose(camera,0));
assert.equal(broken.after,broken.before);assert.equal(broken.draw.flag,0);assert.equal(broken.draw.mode,1,'negative reproduces stale fast shader at exact-plane fallback');
// Template equivalence: specialization replaces only the old uniform branch
// delimiter. All arithmetic, derivatives, clipping and emission expressions
// are exact. The old float32 proof suites remain applicable to both bodies.
const baseline=execFileSync('git',['show','a21d5d137659d81193a196414e31c8c0012718ff:src/holeOptics.js'],{encoding:'utf8'});
const fragment=s=>s.slice(s.indexOf('const analyticFragment ='),s.indexOf('// Conservative all-frustum proof'));
const uncomment=s=>s.replace(/\/\/[^\n]*/g,'').replace(/\s+/g,'');
let old=fragment(baseline),candidate=fragment(source);
old=old.replace('if (uDiskUnclipped < .5) {','STATIC_BEGIN').replace('            }\n            if (exitHit > entry','STATIC_END\n            if (exitHit > entry');
candidate=candidate.replace('#if !defined(DISK_UNCLIPPED) || DISK_UNCLIPPED == 0 || !defined(HIGH_PRECISION)','STATIC_BEGIN').replace('            #endif\n            if (exitHit > entry','STATIC_END\n            if (exitHit > entry');
assert.equal(uncomment(candidate),uncomment(old),'same source arithmetic in both static branches');
const oldHelper=baseline.slice(baseline.indexOf('export function diskSupportUnclipped'),baseline.indexOf('\nexport function makeHoleOptics'));
assert(source.includes(oldHelper.trim()),'entire conservative float32 proof remains byte-identical');
const result={checks,stable,normalContextPrograms:2,transitionBuilds:2,actualThree:THREE.REVISION,callbackOrderAndCache:'installed renderObject/getProgram/getParameters/getProgramCacheKey; GL allocation stubbed',arithmeticIdentical:true,precisionGuard:true,browser:false,performance:false};
if(process.env.ARTEMIS_EVIDENCE)writeFileSync(process.env.ARTEMIS_EVIDENCE,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
