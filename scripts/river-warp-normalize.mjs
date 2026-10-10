// Strict normalizer for river shader guards: removes exactly the warp-sandbox
// insertions (each must match once), so natural flight can still be compared
// byte for byte against historical river baselines. Any other edit survives
// normalization and fails those guards.
import assert from 'node:assert/strict';
const once = (text, from, to, name) => {
    const n = text.split(from).length - 1;
    assert.equal(n, 1, `warp normalizer: expected one ${name}, found ${n}`);
    return text.replace(from, to);
};
export function withoutWarpSandbox(source) {
    let s = source;
    const start = s.indexOf('// Hypothetical warp sandbox (warpBubble.js)');
    const end = s.indexOf('float sourceCore', start);
    assert(start > 0 && end > start, 'warp normalizer: bubble GLSL block');
    s = s.slice(0, start) + s.slice(end);
    assert.equal(s.split(' + bubbleShift(p)').length - 1, 2, 'warp normalizer: two flowField bubble terms');
    s = s.replaceAll(' + bubbleShift(p)', '');
    s = once(s, `    // Warp: passing sources sweep the ship-sized volume within a frame, so
    // most strata carry the bubble's ambient stream; halos keep a fifth.
    if (hash13(vec3(vUv * 601.1, 3.3)) < 0.68 * (1.0 - 0.8 * uBubbleShape.z)) {`,
        '    if (hash13(vec3(vUv * 601.1, 3.3)) < 0.68) {', 'halo stratum share');
    s = once(s, `    if (!halo && length(p) > uRadius * 1.04) {
        // In the ship chart the warp stream leaves through the rear of the
        // volume. Re-enter it upstream on the same streamline, as in a wind
        // tunnel, so the front keeps its inflow.
        float ax = dot(p, uBubbleAxis.xyz);
        if (uBubbleAxis.w > 0.0 && uBubbleShape.y > 0.5 && ax < 0.0 && length(p0) <= uRadius * 1.04) {
            vec3 lat = p - uBubbleAxis.xyz * ax;
            float l2 = dot(lat, lat), r2 = uRadius * uRadius * 0.97;
            p = l2 < r2 ? lat + uBubbleAxis.xyz * sqrt(r2 - l2) : lat * (uRadius * 0.98 / sqrt(l2));
        } else kill = true;
    }`, '    if (!halo && length(p) > uRadius * 1.04) kill = true;', 'wind-tunnel re-entry');
    s = once(s, `
    // Ship chart: samples that drift into the calm interior stall there for
    // a residence time ~1/(1 - f). Recycle them sooner, so the sample budget
    // keeps resolving the walls and the stream; these are field samples.
    if (!halo && uBubbleAxis.w > 0.0 && uBubbleShape.y > 0.5 &&
        length(p - uBubble.xyz) < uBubble.w * 0.6 && hash13(vec3(vUv * 557.3, uTick + 4.1)) < 0.05) kill = true;`, '', 'interior recycling');
    return s;
}
