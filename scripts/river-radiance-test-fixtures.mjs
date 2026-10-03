// Deterministic raw reports for pure acceptance/provenance negative tests.
import { protocol } from './river-radiance-paired-protocol.mjs';
import { runLimits } from './river-radiance-run-budget.mjs';
const digest = 'a'.repeat(64);
function state(subject = 'sun') {
  return { quality: { mobile: false, loadShed: 0 }, dpr: 1, size:[1200,800], context: { lost: false, losses: 0, restores: 0, error: 0 },
    paused: true, observerMode: true, gr: true, t: 0, camera: { target: [1, 2, 3] }, ship: [0, 0, 0, 0, 0, 0], workload: { frameNo: 120 },
    maps: { night: 1, clouds: 1, moon: true, realSky: true, galaxyBackdrop: false },
    river: { count: 15376, drawCount: 15376, drawnCount: 15376, drawnStart: 0, ambient: 15276, drawnAmbient: 15276,
      drawVisible: true, finite: true, invalidOwners: 0, readError: 0, textureHash: digest, uniforms: { vRef: 1, planeBias: 0 },
      sources: [{ name: subject === 'proxima' ? 'PROXIMA' : subject === 'sun' ? 'Sun' : 'placed-hole:0', owners: 100, drawnOwners: 100,
        inkGain: 1, cdfShare: .5, color: [1, 1, 1], coefficient: 3 }] },
    layers: { catalog: { loaded: true, count: 119000, error: '' },
      tier1: { initialized: true, tilesLoaded: 960, totalTiles: 12288, starsLoaded: 100000, pending: 0, tileErrors: 0, residualDirtyGroups: 0 },
      catalogRows: { updates: 120, remaining: 0, tiles: Array.from({ length: 960 }, (_, i) => i), rows: 100000, hash: digest },
      tides: { started: false, ready: false, error: null }, field: { enabled: true, idle: true, stars: 350000 },
      volume: { enabled: true, mapsReady: true, coverageReady: true, mapError: null, res:[1200,800], draft:false,historyReady:true,historyUsed:true },
      galaxy: { enabled: true, ready: true, building: false, error: null, galaxies: 40000 } }, post: { bloom: false, composer: false } };
}
function sample(frameNo, ratio = 1) {
  return { frameNo, volumeProgress:volume(frameNo), gpuSynchronized:true, cpuMs: 4 * ratio, finishMs: 0, readbackMs: 6 * ratio, frameAndFinishMs: 10 * ratio,
    roundTripMs: 11 * ratio, protocolAndSchedulingMs: ratio,
    gpu: { contextLost: false, losses: 0, restores: 0, error: 0, defaultFramebuffer: true },
    river: { enabled: true, visible: true, count: 15376, drawCount: 15376, computeEvery: 1, frame: frameNo },
    quality: { mobile: false, dpr: 1 } };
}
function volume(frameNo){return {fullSize:[1200,800],enabled:true,opacity:1,refineRow:800,mix:1,historyReady:true,historySaved:true,historyUsed:true,dirty:false,
 observedAtMs:frameNo*100,invalidations:2,mapRevision:1,model:{time:0,frameSimSec:0,magLimit:9,lastKey:[1]},
 counters:{draftPasses:2,refinePasses:300,historySaves:1,dirtyReasons:{targets:2}}};}
function preparation(){
 const native=n=>{const s=sample(n);Object.assign(s,{gpuSynchronized:false,finishMs:0,readbackMs:0});return s;};
 const prefix=Array.from({length:120},(_,i)=>({...native(i+2),readiness:{catalogPrefix:{updates:i+1,remaining:119-i}}}));
 const nativeWarmup=Array.from({length:120},(_,i)=>native(i+122));
 const pair=value=>({A:structuredClone(value),B:structuredClone(value)});
 return {complete:true,prefix:pair(prefix),nativeWarmup:pair(nativeWarmup),assets:{...pair([]),elapsedMs:10,readiness:[{A:{ready:true,catalogPrefix:{updates:120,remaining:0}},B:{ready:true,catalogPrefix:{updates:120,remaining:0}}}]},
 refinement:{...pair([]),before:pair(volume(241)),after:pair(volume(241)),maxAdditionalFrames:460},
 fences:['settled','native-warm','refined'].flatMap(stage=>['A','B'].map(label=>({label,stage,before:stage==='settled'?121:241,after:stage==='settled'?121:241,durationMs:1,pixel:[0,0,0,0],contextLost:false,error:0,defaultFramebuffer:true})))};
}
function scenario(fixture = protocol.fixtures[1], ratios = [1, 1, 1, 1, 1]) {
  const counters = { A: 361, B: 361 };
  return { name: fixture.subject, fixture, preparation:preparation(),phases:['preparation','warmup','measurement'].map((name,i)=>({name,limitMs:runLimits[name+'Ms'],startedAtMs:i*20,elapsedMs:10,completed:true,timedOut:false})), pages: Object.fromEntries(['A', 'B'].map(label => [label,
    { mobile:false,gpu: 'SwiftShader', longTaskSupported: true, observerProbe: { passed: true, observed: [{ duration: 80 }] } }])),
    prepared: { A:{...state(fixture.subject),workload:{frameNo:241}}, B:{...state(fixture.subject),workload:{frameNo:241}} },
    before: { A:{...state(fixture.subject),workload:{frameNo:361}}, B:{...state(fixture.subject),workload:{frameNo:361}} },
    warmup: { A: Array.from({ length: 120 }, (_, i) => sample(i + 242)), B: Array.from({ length: 120 }, (_, i) => sample(i + 242)) },
    trials: protocol.orders.map((order, i) => ({ order, blocks: [...order].map((label, j) => {
      const startTime = (i * 4 + j + 1) * 1000;
      const samples = Array.from({ length: 60 }, () => sample(++counters[label], label === 'B' ? ratios[i] : 1));
      const after = state(fixture.subject); after.workload.frameNo = counters[label];
      return { label, samples, after, startTime, endTime: startTime + 900 };
    }) })), longTasks: { A: { allEntries: [] }, B: { allEntries: [] } } };
}
function report() {
  return { device: 'desktop', runLimits, protocol: structuredClone(protocol), selectedFixtures: structuredClone(protocol.fixtures),
    sources: { A: { revision: protocol.baseline }, B: { revision: protocol.productionCandidate, productionReference: protocol.productionCandidate } }, harness: { digest },
    errors: [], scenarios: protocol.fixtures.map(f => scenario(f)) };
}

export { state,sample,volume,preparation,scenario,report };
