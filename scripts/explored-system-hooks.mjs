import assert from 'node:assert/strict';

// Baseline and candidate keep their own complete production call. Only these
// reviewed signatures are supported; unknown or duplicate calls fail closed.
export function systemRenderStatement(source) {
    const signatures = [
        'updateSystemRender(focusedSystem, G.t, camera, G.focus);',
        'updateSystemRender(focusedSystem, G.t, camera, G.focus, G.paused ? 0 : presentationExposureSeconds(advanced, rawDtR));',
    ];
    const calls = source.match(/\bupdateSystemRender\s*\(/g) || [];
    const matches = signatures.filter(statement => source.includes(statement));
    assert.equal(calls.length, 1, 'Explored-system QA requires one production system-render call');
    assert.equal(matches.length, 1, 'Explored-system QA system-render signature changed');
    return matches[0];
}
