// Read-only instrumentation for the isolated preparation proof. No rendering,
// scheduling, resolution, field input, or readiness flag is changed here.
import assert from 'node:assert/strict';
function once(source,token,replacement){
  assert.equal(source.split(token).length,2,`Volume progress hook changed: ${token}`);
  return source.replace(token,replacement);
}
export function volumeProgressTransform(source,id){
  if(!id.replaceAll('\\','/').split('?')[0].endsWith('/src/render/galaxyVolume.js'))return null;
  for(const[reason,token]of[
    ['maps','state.mapT = performance.now(); state.mapRevision++; state.history = null; state.dirty = true;'],
    ['mapBlend','u.uMapBlend.value = t * t * (3 - 2 * t); state.dirty = true;'],
    ['targets','state.targetSize = next; state.dirty = true; state.lastDrawn = null;'],
    ['fineBand','if (u.uFineBand.value[0] !== band[0]) {'],
    ['viewOrModelKey','if (changed) {\n        for (let i = 0; i < vals.length; i++) key[i] = vals[i];'],
    ['magnitudeLimit','if (Math.abs(u.value - m) > 1e-3) {'],
    ['enabled','if (enabled !== state.enabled) {'],
    ['contextReset','export function resetGalaxyVolumeHistory() {'],
  ]){
    const insertAfter=token.endsWith('{');
    source=once(source,token,insertAfter?token+` pairedVolumeDirty('${reason}');`:`pairedVolumeDirty('${reason}'); `+token);
  }
  // The changed-key reason belongs inside its existing conditional.
  source=once(source,"pairedVolumeDirty('viewOrModelKey'); if (changed) {","if (changed) { pairedVolumeDirty('viewOrModelKey');");
  source=once(source,'rayRender(renderer, state.rtDraft);','pairedVolumeCounters.draftPasses++; rayRender(renderer, state.rtDraft);');
  source=once(source,'state.refineRow += n;','state.refineRow += n; pairedVolumeCounters.refinePasses++;');
  source=once(source,'state.historySaved = true;','state.historySaved = true; pairedVolumeCounters.historySaves++;');
  return source+`
const pairedVolumeCounters={draftPasses:0,refinePasses:0,historySaves:0,dirtyReasons:{}};
function pairedVolumeDirty(reason){pairedVolumeCounters.dirtyReasons[reason]=(pairedVolumeCounters.dirtyReasons[reason]||0)+1;}
export function pairedVolumeProgress(){return {
 observedAtMs:performance.now(),refineRow:state.refineRow,fullSize:state.rtFull?[state.rtFull.width,state.rtFull.height]:null,
 draftSize:state.rtDraft?[state.rtDraft.width,state.rtDraft.height]:null,mix:state.mix,
 historyReady:!!state.history,historySaved:state.historySaved,historyUsed:state.historyUsed,dirty:state.dirty,
 renders:state.renders,inside:state.inside,enabled:state.enabled,opacity:state.opacity,
 invalidations:state.invalidations,mapRevision:state.mapRevision,budget:{...budget},
 model:{time:state.time,frameSimSec:state.frameSimSec,magLimit:state.rayMat?.uniforms.uMagLimit.value,lastKey:[...state.lastKey]},
 counters:{...pairedVolumeCounters,dirtyReasons:{...pairedVolumeCounters.dirtyReasons}}
};}
`;
}
export function validateVolumeProgress(state,expectedSize=[1200,800]){
  assert.deepEqual(state.fullSize,expectedSize,'Keep the declared full device target');
  assert(state.enabled&&state.opacity>.001);
  assert(Number.isInteger(state.refineRow)&&state.refineRow>=0);
  assert(Number.isFinite(state.mix)&&state.mix>=0&&state.mix<=1);
  assert(Number.isFinite(state.observedAtMs));
  assert(state.model&&Number.isFinite(state.model.time)&&state.model.frameSimSec===0&&Array.isArray(state.model.lastKey));
  assert(state.counters.dirtyReasons&&Object.values(state.counters.dirtyReasons).every(n=>Number.isInteger(n)&&n>=0));
  for(const key of['draftPasses','refinePasses','historySaves'])assert(Number.isInteger(state.counters[key])&&state.counters[key]>=0);
}
export function volumeRefinementReady(state,expectedSize=[1200,800]){
  validateVolumeProgress(state,expectedSize);
  return state.refineRow>=state.fullSize[1]&&state.mix===1&&state.historyReady&&state.historySaved&&state.historyUsed
    &&!state.dirty&&state.counters.historySaves>0;
}
export function validateRefinementAdvance(previous,next,lastProgressAtMs,expectedSize=[1200,800]){
  validateVolumeProgress(previous,expectedSize);validateVolumeProgress(next,expectedSize);
  assert.deepEqual(next.model,previous.model,'Frozen volume inputs must remain fixed');
  assert.deepEqual(next.counters.dirtyReasons,previous.counters.dirtyReasons,'Unexpected volume dirty/reset reason after settlement');
  assert.equal(next.invalidations,previous.invalidations);assert.equal(next.mapRevision,previous.mapRevision);
  assert.equal(next.counters.draftPasses,previous.counters.draftPasses,'No new draft pass after settlement');
  assert(!next.dirty&&next.refineRow>=previous.refineRow&&next.mix>=previous.mix,'Refinement cannot reset or move backward');
  if(previous.refineRow<previous.fullSize[1]){
    assert(next.refineRow>previous.refineRow&&next.counters.refinePasses===previous.counters.refinePasses+1,'Every delivered refinement frame must advance actual rows');
  }
  const advanced=next.refineRow>previous.refineRow||next.mix>previous.mix||(!previous.historyReady&&next.historyReady)
    ||(!previous.historyUsed&&next.historyUsed);
  assert(next.observedAtMs>=previous.observedAtMs&&Number.isFinite(lastProgressAtMs)&&lastProgressAtMs<=previous.observedAtMs);
  if(volumeRefinementReady(previous,expectedSize)&&volumeRefinementReady(next,expectedSize))return next.observedAtMs;
  assert(advanced||next.observedAtMs-lastProgressAtMs<5000,'Volume blend/history stalled for five seconds');
  return advanced?next.observedAtMs:lastProgressAtMs;
}
