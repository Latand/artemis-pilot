import assert from 'node:assert/strict';
import { qualitySettings } from './quality-fixture-settings.mjs';

// The baseline predates named modes and exposes only the four shared settings.
// Verify every new High budget before comparing the legacy settings; do not
// compare mode labels with missing legacy metadata, or mistake telemetry for
// render work. Actual buffer/river/galaxy workloads are separately recorded in
// every timed frame. Unknown future fields are retained, never silently dropped.
export function mobileThrustQualitySettings(snapshot) {
    const settings = qualitySettings(snapshot);
    assert.equal(settings.mobile, true, 'The comparison is the mobile render path');
    const modern = 'mode' in settings;
    assert.equal(settings.dpr, 1, 'Explicit DPR 1 matches the baseline mobile framebuffer');
    // At warp 60 the legacy heuristic reports 1; manual High reports 0.
    // Both select the same river draw/compute branches (<2). Explicit DPR
    // removes their only framebuffer difference. Never accept level 2.
    assert.equal(settings.loadShed, modern ? 0 : 1, 'Expected per-version mobile load-shed branch');
    delete settings.loadShed;
    if (modern) {
        const high = { mode: 'high', level: 0, effectiveLevel: 0, dprCap: 1.15, maxPixels: 4.2e6,
            riverDraw: 1, riverEvery: 1, galaxyScale: 1, lensSamples: 0, minimal: false };
        for (const [key, value] of Object.entries(high)) {
            assert.equal(settings[key], value, `Explicit High mobile budget: ${key}`);
            delete settings[key];
        }
        delete settings.software;
        delete settings.rendererName;
    }
    return settings;
}
