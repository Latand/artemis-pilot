// Execute actual policy/visibility/draw-count blocks; WebGL remains hosted QA.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/river.js',import.meta.url),'utf8');
const slice=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start);assert(start>=0&&end>start);return source.slice(start,end);};
const init=slice('    // Resolve the draw-only policy','    if (!river.enabled) return;');
const visibility=slice('    lines.visible = fEff > .01','    if (fEff <= .01)');
const block=slice('    // A guided-flight policy changes only','    const riverVolumeT0 =');
assert(!/fEff\s*=|computeEvery\s*=|uBody|uHalo|uDtSim/.test(init+visibility+block),'Presentation never changes physical field, source data or compute state');
for(const mobile of [false,true])for(const surfaceProx of [0,.5,1])for(const localFocus of [0,.4,1]){
 const geometry=()=>({range:null,setDrawRange(start,count){this.range=[start,count];}});
 const context=vm.createContext({presentation:null,surfaceProx,renderQuality:{mobile,dpr:1.25,loadShed:2},river:{drawCount:0,style:3,computeEvery:3,sourceCount:20},lineMat:{depthWrite:false},lines:{geometry:geometry()},dots:{material:{depthWrite:false},geometry:geometry()},uniformsShared:{uPixelRatio:{},uLocalFocus:{},uOpacity:{}},localFocus,planeBias:.6,loadShed:.2,renderShed:.2,fEff:.7,RIVER_DENSITY_GAIN:1.1,NPART:15376,IPP:4,PERF:{enabled:false}});
 const apply=policy=>{context.presentation=policy;vm.runInContext('{'+init+visibility+block+'}',context);return context.uniformsShared.uOpacity.value;};
 const original=.44*(mobile?1.08:1)*1.1*.7*(1+.6*.62+localFocus*.7)*(1-.2*.12);
 assert.equal(apply(null),original);assert.equal(context.lineMat.depthTest,surfaceProx>.5);
 const count=context.river.drawCount,lineRange=JSON.stringify(context.lines.geometry.range),dotRange=JSON.stringify(context.dots.geometry.range);
 assert.equal(apply(Object.freeze({opacityGain:.22,occludeBodies:true})),original*.22);
 assert.equal(context.river.visible,true);assert.equal(context.lineMat.depthTest,true);assert.equal(context.dots.material.depthTest,true);
 assert.equal(context.lineMat.depthWrite,false);assert.equal(context.dots.material.depthWrite,false);
 assert.equal(context.river.drawCount,count,'Same-phase particle counts unchanged');assert.equal(JSON.stringify(context.lines.geometry.range),lineRange);assert.equal(JSON.stringify(context.dots.geometry.range),dotRange);
 assert.equal(context.river.computeEvery,3);assert.equal(context.river.sourceCount,20);
 assert.equal(apply(null),original,'Exit restores original ink exactly');assert.equal(context.lineMat.depthTest,surfaceProx>.5);
 assert.equal(apply({opacityGain:NaN}),original);assert.equal(apply({opacityGain:Infinity}),original);
 assert.equal(apply({opacityGain:-1}),original*.05);assert.equal(apply({opacityGain:8}),original);
 apply({opacityGain:.22,occludeBodies:true});
 context.presentation=null;context.fEff=0;
 vm.runInContext('{'+init+visibility+'}',context); // actual hidden-flow early-return prefix
 assert.equal(context.river.visible,false);assert.equal(context.lines.visible,false);assert.equal(context.dots.visible,false);
 assert.equal(context.river.presentationGain,1,'Cosmic/hidden Exit refreshes policy telemetry');assert.equal(context.river.presentationDepthTest,false);assert.equal(context.lineMat.depthTest,false);
 context.river.presentationGain=.22;context.river.presentationDepthTest=true;vm.runInContext('{'+init+'}',context);
 assert.equal(context.river.presentationGain,1,'Disabled renderer Exit also restores policy metadata');assert.equal(context.river.visible,false);
}
const main=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
assert.equal(main.split('dtR, scenarioPlaybackActive() ? GUIDED_RIVER_PRESENTATION : null);').length-1,2,'Perf and ordinary paths match');
assert(main.includes('Object.freeze({ occludeBodies: true, opacityGain: .22 })'),'One retained policy, no per-frame allocation');
console.log('Guided flow: exact same-phase counts, original defaults/visible+hidden+disabled Exit, bounded ink, depth and compute/source invariants pass');
