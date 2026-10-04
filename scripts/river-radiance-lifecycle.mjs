// A bounded, predetermined visual-advection sequence. Physical time is paused.
export const RADIANCE_LIFECYCLE_FRAMES = 64;
export const RADIANCE_RESET_FRAME = 48;
export const RADIANCE_CAPTURE_FRAMES = [15, 23, 63];
export function radianceLifecycleStep(index, subject) {
  const high = subject === 'proxima' ? 1e6 * 31557600 : 3852;
  return { index, observerPc: index < 8 ? 8 : 8.1,
    hostName: subject === 'proxima' && index >= 16 && index < 32 ? 'BARNARD' : 'PROXIMA',
    offscreen: index >= 24 && index < 32,
    rate: index >= 32 && index < 40 ? high : index >= 40 && index < 48 ? -high : 0,
    reset: index === RADIANCE_RESET_FRAME, capture: RADIANCE_CAPTURE_FRAMES.includes(index) };
}

export function sameCountActiveReplacement(before, after) {
  const a = before.active.ids, b = after.active.ids;
  return a.length === b.length && a.length > 2 && a[0] === b[0] && a.at(-1) === b.at(-1)
    && JSON.stringify(a) !== JSON.stringify(b) && after.active.revision > before.active.revision
    && after.sources.filter(s => s.activeSource).every(s => s.currentActive);
}

export function healthyRadianceGain(frame, previous) {
  const state = frame.gainState;
  if (!state || !frame.sources.every(source => Number.isFinite(source.inkGain) && source.inkGain > 0 && source.inkGain <= 1)) return false;
  if (frame.skippedCompute && previous?.gainState && JSON.stringify(state) !== JSON.stringify(previous.gainState)) return false;
  const total = frame.sources.reduce((sum, source) => sum + Math.sqrt(Math.max(0, source.coefficient)), 0);
  for (const source of frame.sources) {
    const share = state.ownerShares[source.index], reference = state.referenceShares[source.index];
    if (!Number.isFinite(share + reference) || share < 0 || reference < 0) return false;
    if (frame.dispatch) {
      if (Math.abs(share - source.cdfShare) > 1e-12) return false;
      const expected = total > 0 ? Math.sqrt(Math.max(0, source.coefficient)) / total : 0;
      if (Math.abs(reference - expected) > 1e-12) return false;
    }
    const allocated = frame.drawCount * .68 * share, referenceCount = frame.drawCount * .68 * reference;
    const expected = allocated > 0 ? Math.min(1, Math.max(128, referenceCount) / allocated) : 1;
    if (Math.abs(source.inkGain - expected) > 1e-12) return false;
    if (allocated <= 128 && source.inkGain !== 1) return false;
  }
  return true;
}

export function healthyRadianceRecovery(recovery, next) {
  return recovery.before.paused && recovery.held.paused && recovery.restored.paused
    && recovery.before.time === recovery.held.time && recovery.before.time === recovery.restored.time
    && recovery.held.contextLost && recovery.held.lifecycleLost
    && recovery.held.losses > recovery.before.losses
    && !recovery.restored.contextLost && !recovery.restored.lifecycleLost
    && recovery.held.completed === recovery.before.completed
    && recovery.restored.restores > recovery.before.restores
    && recovery.restored.resetCalls > recovery.before.resetCalls
    && recovery.restored.defaultTarget
    && next.completed > recovery.held.completed && next.time === recovery.before.time
    && !next.contextLost && next.dispatch?.respawn === 1 && !next.skippedCompute;
}

export function signedRadianceAdvection(frame, plan) {
  return !frame.dispatch || frame.dispatch.dt === 0 || Math.sign(frame.dispatch.dt) === Math.sign(plan.rate);
}

// Coverage follows the existing production scheduling branches. A moving,
// close-focus hole can require urgent volume refresh even on an off-cadence
// frame; Proxima supplies the signed, held-texture mobile skip coverage.
export function healthyRadianceMobileCadence(frames, subject) {
  if (frames.length !== RADIANCE_LIFECYCLE_FRAMES) return false;
  const offCadence = frame => Number.isInteger(frame.computeEvery) && frame.computeEvery > 1
    && Number.isInteger(frame.frame) && frame.frame % frame.computeEvery !== 0;
  if (subject === 'proxima') {
    const signedSkip = sign => frames.some((frame, index) => {
      const previous = frames[index - 1];
      return Math.sign(radianceLifecycleStep(index, subject).rate) === sign
        && Math.sign(frame.dtVis) === sign && offCadence(frame)
        && frame.skippedCompute && !frame.dispatch && previous
        && typeof frame.textureHash === 'string' && frame.textureHash === previous.textureHash
        && JSON.stringify(frame.gainState) === JSON.stringify(previous.gainState);
    });
    return signedSkip(1) && signedSkip(-1)
      && frames.every((frame, index) => !frame.skippedCompute || (!frame.dispatch && index > 0
        && frame.textureHash === frames[index - 1].textureHash
        && JSON.stringify(frame.gainState) === JSON.stringify(frames[index - 1].gainState)));
  }
  if (subject === 'black-hole') {
    const urgent = frames.filter(offCadence);
    return urgent.length > 0 && frames.every(frame => !frame.skippedCompute && !!frame.dispatch)
      && urgent.every(frame => frame.dispatch.respawn > .08)
      && [1, -1].every(sign => urgent.some(frame => Math.sign(frame.dispatch.dt) === sign));
  }
  return false;
}
