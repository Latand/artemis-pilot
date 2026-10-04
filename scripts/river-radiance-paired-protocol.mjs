// Acceptance contract shared by the full-layer runner and pure negative tests.
import assert from 'node:assert/strict';
import { healthyRadianceFrame } from './river-radiance-qa.mjs';
import { runLimits,legacyRunLimits,validatePhases } from './river-radiance-run-budget.mjs';
import { proximaCompletePolicy,pinnedProximaShard,requireCompleteProximaPins } from './river-radiance-proxima-shards.mjs';
import { pinnedCompleteShard,completedShardPolicy } from './river-radiance-complete-shards.mjs';
import { validateFullPreparation } from './river-radiance-full-preparation.mjs';
import { radianceDeviceTargets,volumeRefinementReady,validateRefinementAdvance } from './river-radiance-volume-progress.mjs';

export const protocol = Object.freeze({
  baseline: '09863eedda25eef36d79e9cf88daa4ff3e377875',
  productionCandidate: '2c9b5bcf2f542728d76cf1350007297db2678f34',
  warmupFrames: 120, samplesPerBlock: 60, catalogSetupUpdates: 120,
  orders: Object.freeze(['ABBA', 'BAAB', 'ABBA', 'BAAB', 'ABBA']),
  p95RatioLimit: 1.05,
  fixtures: Object.freeze([
    { subject: 'proxima', rate: 1e6 * 31557600 },
    { subject: 'sun', rate: 0 },
    { subject: 'black-hole', rate: 3852 },
  ]),
  query: Object.freeze({ focus: 'sun', dist: '40000', hidehelp: '1', dpr: '1',
    tier1: '1', realsky: '1', field: '1', galaxyvol: '1', galaxies: '1',
    river: '1', compile: '1', earthnight: '1', clouds: '1', moonmap: '1' }),
});
export const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
export function summarize(values) {
  assert(values.length && values.every(value => Number.isFinite(value) && value >= 0), 'Finite nonnegative samples required');
  return { count: values.length, min: Math.min(...values), p50: quantile(values, .5), p95: quantile(values, .95),
    max: Math.max(...values), mean: values.reduce((a, b) => a + b, 0) / values.length };
}
export function validateSample(sample) {
  assert.equal(sample.gpuSynchronized, true, 'Acceptance samples require synchronous GPU completion');
  for (const key of ['cpuMs', 'finishMs', 'readbackMs', 'frameAndFinishMs', 'roundTripMs', 'protocolAndSchedulingMs'])
    assert(Number.isFinite(sample[key]) && sample[key] >= 0, `Invalid ${key}`);
  assert(sample.frameAndFinishMs > 0, 'A delivered frame must have positive duration');
  assert(Number.isInteger(sample.frameNo), 'Frame counter required');
  assert.deepEqual(sample.gpu, { contextLost: false, losses: 0, restores: 0, error: 0, defaultFramebuffer: true }, 'Every readback requires a healthy original context');
  assert(sample.river.enabled && sample.river.visible, 'Actual river must render in every measured frame');
}
export function trialSummary(trial) {
  assert.equal(trial.blocks.map(block => block.label).join(''), trial.order, 'No omitted or reordered blocks');
  assert(['ABBA', 'BAAB'].includes(trial.order));
  for (const block of trial.blocks) {
    assert.equal(block.samples.length, protocol.samplesPerBlock, 'Exactly sixty raw samples per block');
    block.samples.forEach(validateSample);
  }
  const samples = Object.fromEntries(['A', 'B'].map(label => [label, trial.blocks.filter(b => b.label === label).flatMap(b => b.samples)]));
  for (const label of ['A', 'B']) for (let i = 1; i < samples[label].length; i++)
    assert.equal(samples[label][i].frameNo, samples[label][i - 1].frameNo + 1, 'No discarded or hidden application frames');
  // The paired relative frame, not wall-clock order, identifies equal work.
  for (let i = 0; i < samples.A.length; i++) {
    assert.equal(samples.A[i].frameNo, samples.B[i].frameNo, 'Paired frame ordinals match');
    assert.deepEqual(samples.A[i].river, samples.B[i].river, 'Normal device counts and adaptive river cadence must match on every frame');
    assert.deepEqual(samples.A[i].quality, samples.B[i].quality, 'Device render quality must match on every frame');
  }
  const A = summarize(samples.A.map(s => s.frameAndFinishMs)), B = summarize(samples.B.map(s => s.frameAndFinishMs));
  assert(A.p95 > 0);
  return { A, B, ratio: B.p95 / A.p95, regressionPercent: (B.p95 / A.p95 - 1) * 100 };
}
export function scenarioSummary(scenario,{legacy=false}={}) {
  validatePhases(scenario.phases,legacy?legacyRunLimits:runLimits);
  const size=radianceDeviceTargets(scenario.pages.A.mobile).volume;
  validateFullPreparation(scenario.preparation,size,{legacy});
  assert.deepEqual(scenario.trials.map(t => t.order), protocol.orders, 'All five predeclared trials are mandatory');
  for (const label of ['A', 'B']) {
    assert.equal(scenario.warmup[label].length, protocol.warmupFrames, 'Keep all 120 warmup frames');
    scenario.warmup[label].forEach(validateSample);
    const all = [...scenario.warmup[label], ...scenario.trials.flatMap(t => t.blocks.filter(b => b.label === label).flatMap(b => b.samples))];
    const prepared=[...scenario.preparation.nativeWarmup[label],...scenario.preparation.refinement[label]].at(-1);
    assert.equal(all[0].frameNo,prepared.frameNo+1,'No hidden frame between preparation and synchronous warmup');
    let previous=scenario.preparation.refinement.after[label],last=previous.observedAtMs;
    for(const sample of all){assert(volumeRefinementReady(sample.volumeProgress,size),'Measured acceptance requires full history use');
      last=validateRefinementAdvance(previous,sample.volumeProgress,last,size);previous=sample.volumeProgress;}
    for (let i = 1; i < all.length; i++) assert.equal(all[i].frameNo, all[i - 1].frameNo + 1, 'Frame continuity also crosses trial and warmup boundaries');
  }
  const ratios = scenario.trials.map(trial => trialSummary(trial).ratio);
  const medianPairedRatio = quantile(ratios, .5);
  return { medianPairedRatio, ratioRange: { min: Math.min(...ratios), max: Math.max(...ratios) },
    passesFivePercentTarget: medianPairedRatio <= protocol.p95RatioLimit };
}
export function summarizeLongTasks(entries, ranges) {
  assert(entries.every(e => Number.isFinite(e.startTime) && Number.isFinite(e.duration) && e.duration >= 0));
  const measured = entries.filter(entry => ranges.some(range => entry.startTime >= range.start && entry.startTime <= range.end));
  return { thresholdMs: 50, measuredCount: measured.length,
    measuredTotalBlockingMs: measured.reduce((n, entry) => n + Math.max(0, entry.duration - 50), 0),
    measuredMaximumMs: Math.max(0, ...measured.map(entry => entry.duration)), measured, allEntries: entries };
}
export function longTaskBudget(A, B) {
  // Exact unchanged budgets from benchmark-explored-systems.mjs.
  const budget = { scope: 'All measured paired windows, equal frame counts, no discarded tasks',
    allowedTotalBlockingMs: A.measuredTotalBlockingMs * 1.05 + 50,
    allowedMaximumMs: Math.max(200, A.measuredMaximumMs * 1.05),
    allowedCount: Math.ceil(A.measuredCount * 1.05) + 1 };
  return { ...budget, passed: B.measuredTotalBlockingMs <= budget.allowedTotalBlockingMs &&
    B.measuredMaximumMs <= budget.allowedMaximumMs && B.measuredCount <= budget.allowedCount };
}
export function comparableState(state) {
  // Everything in the curated workload snapshot is compared. The shader's
  // intended owner ink gain is the ONLY differing physical/display input.
  return { ...state, river: { ...state.river,
    sources: state.river.sources.map(({ inkGain, ...source }) => source) } };
}
export function assertMatchedState(A, B) {
  assert.deepEqual(comparableState(A), comparableState(B), 'Field texture, owners, sources, camera, maps, layers, counts and quality must match');
}
export function assertHealthyState(s, mobile, subject) {
  assert.equal(s.quality.mobile, mobile); assert.equal(s.dpr, 1);
  assert.deepEqual(s.context, { lost: false, losses: 0, restores: 0, error: 0 });
  assert(s.paused && s.observerMode && s.gr, 'Frozen physical clock and live gravity river required');
  assert.deepEqual(s.maps, { night: 1, clouds: 1, moon: true, realSky: true, galaxyBackdrop: false });
  assert.equal(s.river.count, mobile ? 9216 : 15376, 'Full production particle texture for the device');
  assert(s.river.drawCount > 0 && s.river.drawCount <= s.river.count, 'Production draw policy must be live');
  assert(healthyRadianceFrame({ ...s.river, contextLost: s.context.lost, glError: s.context.error }));
  assert.match(s.river.textureHash, /^[a-f0-9]{64}$/);
  const name = subject === 'proxima' ? 'PROXIMA' : subject === 'sun' ? 'Sun' : 'placed-hole:0';
  assert(s.river.sources.some(source => source.name === name && source.owners > 0 && source.drawnOwners > 0), `${name} must own drawn samples`);
  assert(s.layers.catalog.loaded && s.layers.catalog.count > 0 && !s.layers.catalog.error);
  assert(s.layers.tier1.initialized && s.layers.tier1.tilesLoaded > 0 && s.layers.tier1.tilesLoaded < s.layers.tier1.totalTiles && s.layers.tier1.starsLoaded > 0 && !s.layers.tier1.pending && !s.layers.tier1.tileErrors && !s.layers.tier1.residualDirtyGroups);
  assert.equal(s.layers.catalogRows.updates, protocol.catalogSetupUpdates);
  assert.equal(s.layers.catalogRows.remaining, 0);
  assert.equal(s.layers.catalogRows.tiles.length, s.layers.tier1.tilesLoaded);
  assert.equal(s.layers.tier1.tilesLoaded, protocol.catalogSetupUpdates * 8, 'Normal eight-tile setup prefix is complete');
  assert.equal(s.layers.catalogRows.rows, s.layers.tier1.starsLoaded);
  assert.match(s.layers.catalogRows.hash, /^[a-f0-9]{64}$/);
  assert((!s.layers.tides.started || s.layers.tides.ready) && !s.layers.tides.error);
  assert(s.layers.field.enabled && s.layers.field.idle && s.layers.field.stars > 0);
  assert(s.layers.volume.enabled && s.layers.volume.mapsReady && s.layers.volume.coverageReady && !s.layers.volume.mapError);
  const targets=radianceDeviceTargets(mobile);
  assert.deepEqual(s.size,targets.canvas,'Full canvas remains independent of the volume target policy');
  assert.deepEqual(s.layers.volume.res,targets.volume,'Preserve the production full volume target for this device');
  assert(s.layers.volume.draft===false&&s.layers.volume.historyReady&&s.layers.volume.historyUsed,'Prepared full-resolution history required');
  assert(s.layers.galaxy.enabled && s.layers.galaxy.ready && !s.layers.galaxy.building && !s.layers.galaxy.error && s.layers.galaxy.galaxies > 0);
  assert.equal(s.post.bloom, false, 'Default production bloom policy is preserved; neither device requests optional bloom');
}

export function aggregateReports(reports, device, expectedCandidateRevision, {reuseComplete=false,legacy=false,reuseSunOnly=false}={}) {
  if(reuseSunOnly){
    requireCompleteProximaPins();assert(reuseComplete&&!legacy);
    if(device==='desktop')assert.equal(expectedCandidateRevision,proximaCompletePolicy.head,'Reused desktop keeps its actual measured head');
    else assert.notEqual(expectedCandidateRevision,proximaCompletePolicy.head,'Mobile Sun must come from its reviewed correction');
  }
  if(legacy)assert(!reuseComplete&&['4f79de1c7d78dcea0aa7481f6a8e9d979d34fd68','b9e7c15f1507a1ecdc2beed6079676a24374b1eb'].includes(expectedCandidateRevision),'Historical policy is limited to the actual preserved heads');
  assert.match(expectedCandidateRevision, /^[a-f0-9]{40}$/, 'Reviewed candidate HEAD is required for aggregation');
  if(reuseComplete){
    assert.equal(reports.length,3,'Exactly three complete raw views per device');
    assert(!completedShardPolicy.shards.some(p=>p.head===expectedCandidateRevision),'Replacement data must come from a new reviewed head');
  }
  assert(['desktop', 'mobile'].includes(device));
  const scenarios = [];
  const physicalSources=s=>({A:s.A,B:Object.fromEntries(['productionReference','productionTrees','hashes','computeHash'].map(k=>[k,s.B[k]]))});
  const provenance=[];
  let freshReport=null;
  for (const report of reports) {
    const pin=(reuseSunOnly?pinnedProximaShard(report,device):null)||(reuseComplete?pinnedCompleteShard(report,device):null);
    const old=pin?.timingPolicy==='legacy-55'||legacy;
    if(reuseComplete)assert.equal(report.shardComplete,true,'An incomplete report cannot contribute even partial trials');
    assert.deepEqual(report.runLimits,old?legacyRunLimits:runLimits,'Pinned explicit phase budgets are mandatory');
    assert.equal(report.preparationPolicy,old?undefined:'asset-native-v2');
    assert.equal(report.device, device, 'Device shards cannot be mixed');
    assert.deepEqual(report.protocol, protocol, 'No protocol changes between shards');
    if(reuseComplete){
      assert.deepEqual(physicalSources(report.sources),physicalSources(reports[0].sources),'Exact common production and baseline provenance across reused and new shards');
      if(!pin){if(freshReport)assert.deepEqual(report.harness,freshReport.harness);freshReport=report;}
      provenance.push({fixture:report.scenarios[0].fixture,actualHead:report.sources.B.revision,harness:report.harness,reused:!!pin,pin});
    }else{
      assert.deepEqual(report.sources, reports[0].sources, 'Exact same source identities across shards');
      assert.deepEqual(report.harness, reports[0].harness, 'Same reviewed harness in every shard');
    }
    assert.equal(report.errors.length, 0, 'Errors in a shard cannot be suppressed by aggregation');
    assert.equal(report.sources.A.revision, protocol.baseline);
    assert.equal(report.sources.B.revision,pin?pin.head:expectedCandidateRevision,'Every shard must use its exact reviewed head');
    assert.equal(report.sources.B.productionReference, protocol.productionCandidate);
    assert.equal(report.scenarios.length, report.selectedFixtures.length);
    for (const scenario of report.scenarios) {
      assert(protocol.fixtures.some(f => f.subject === scenario.fixture.subject && f.rate === scenario.fixture.rate));
      assert.equal(scenario.pages.A.gpu, scenario.pages.B.gpu);
      for (const label of ['A', 'B']) {
        const page = scenario.pages[label];
        assert(page.longTaskSupported && page.observerProbe.passed && page.observerProbe.observed.length > 0, 'Observer evidence required');
        assertHealthyState(scenario.before[label], device === 'mobile', scenario.fixture.subject);
      }
      assertMatchedState(scenario.before.A, scenario.before.B);
      for (const trial of scenario.trials) {
        for (const label of ['A', 'B']) {
          const blocks = trial.blocks.filter(block => block.label === label);
          for (const block of blocks) {
            assertHealthyState(block.after, device === 'mobile', scenario.fixture.subject);
            assert.equal(block.after.t, scenario.before[label].t);
            assert.deepEqual(block.after.camera, scenario.before[label].camera);
            assert.deepEqual(block.after.ship, scenario.before[label].ship);
          }
        }
        for (let i = 0; i < 2; i++) assertMatchedState(trial.blocks.filter(b => b.label === 'A')[i].after, trial.blocks.filter(b => b.label === 'B')[i].after);
      }
      const longTasks = {};
      for(const label of ['A','B']){
        assertHealthyState(scenario.prepared[label],device==='mobile',scenario.fixture.subject);
        const preparedLast=[...scenario.preparation.nativeWarmup[label],...scenario.preparation.refinement[label]].at(-1);
        assert.equal(scenario.prepared[label].workload.frameNo,preparedLast.frameNo);
        assert.equal(scenario.before[label].workload.frameNo,scenario.warmup[label].at(-1).frameNo);
      }
      assertMatchedState(scenario.prepared.A,scenario.prepared.B);
      for (const label of ['A', 'B']) {
        const ranges = scenario.trials.flatMap(t => t.blocks.filter(b => b.label === label).map(b => ({ start: b.startTime, end: b.endTime })));
        assert(ranges.every(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start));
        longTasks[label] = summarizeLongTasks(scenario.longTasks[label].allEntries, ranges);
      }
      scenarios.push({ name: scenario.name, fixture: scenario.fixture, ...scenarioSummary(scenario,{legacy:old}), longTasks });
    }
  }
  assert.deepEqual(scenarios.map(s => s.fixture.subject).sort(), protocol.fixtures.map(f => f.subject).sort(), 'All three views, once each, are mandatory');
  const totals = {};
  for (const label of ['A', 'B']) {
    const sets = scenarios.map(s => s.longTasks[label]);
    totals[label] = { measuredCount: sets.reduce((n, s) => n + s.measuredCount, 0),
      measuredTotalBlockingMs: sets.reduce((n, s) => n + s.measuredTotalBlockingMs, 0),
      measuredMaximumMs: Math.max(...sets.map(s => s.measuredMaximumMs)) };
  }
  const budget = longTaskBudget(totals.A, totals.B);
  if(reuseSunOnly&&device==='desktop')assert.equal(freshReport,null,'Desktop reuses only its three authenticated complete raw views');
  else if(reuseComplete)assert(freshReport,'This continuation requires its new incomplete-view replacement, never only cached gates');
  if(reuseSunOnly&&device==='mobile'){
    assert.equal(freshReport.scenarios[0].fixture.subject,'sun');
    assert.equal(provenance.filter(p=>!p.reused).length,1,'Only mobile Sun is newly measured');
  }
  const representative=freshReport||(reuseSunOnly?reports.find(r=>r.sources.B.revision===proximaCompletePolicy.head):reports[0]);
  assert(representative);
  return { device, expectedCandidateRevision, protocol, sources: representative.sources, harness: representative.harness, scenarios,
    ...(reuseComplete?{shardProvenance:provenance}:{}),
    mandatoryFrames: { measured: 3600, warmup: 720 }, longTasks: totals, longTaskBudget: budget,
    passed: scenarios.every(s => s.passesFivePercentTarget) && budget.passed };
}
