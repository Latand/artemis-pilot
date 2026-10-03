// Diagnostic equivalence excludes only the proposed display gain.
export function comparableRadianceFrame(frame) {
  const { textureBase64, pixel, png, ...state } = frame;
  return {
    ...state,
    sources: state.sources.map(({ inkGain, ...source }) => source),
  };
}

export function differingFields(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

export function healthyRadianceFrame(frame) {
  return !frame.contextLost && frame.glError === 0 && frame.readError === 0 &&
    frame.finite && frame.invalidOwners === 0 &&
    frame.ambient + frame.sources.reduce((n, source) => n + source.owners, 0) === frame.count &&
    frame.drawnAmbient + frame.sources.reduce((n, source) => n + source.drawnOwners, 0) === frame.drawnCount &&
    frame.drawnCount === frame.drawCount && frame.drawVisible;
}

// This is only a meaningful-capture guard. Coverage and saturation changes
// remain measured evidence to inspect, rather than an invented visual pass.
export function healthyRadianceCapture(frame) {
  const p = frame.pixel;
  return !!p && Number.isInteger(frame.width) && frame.width > 0 &&
    Number.isInteger(frame.height) && frame.height > 0 &&
    p.projected.length === 3 && p.projected.every(Number.isFinite) &&
    p.projected.every(value => value >= -1 && value <= 1) &&
    p.center.length === 2 && p.center.every(Number.isFinite) &&
    p.center[0] >= 0 && p.center[0] < frame.width &&
    p.center[1] >= 0 && p.center[1] < frame.height &&
    p.canvasLit > 0 && p.canvasLit <= frame.width * frame.height &&
    p.canvasMax > p.canvasMin &&
    p.rings.length > 0 && p.rings.every(ring => ring.total > 0 &&
      Number.isFinite(ring.luminance) && ring.lit >= 0 && ring.lit <= ring.total &&
      ring.saturated >= 0 && ring.saturated <= ring.total) &&
    p.rings.some(ring => ring.lit > 0);
}
