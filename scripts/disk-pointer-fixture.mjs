import assert from 'node:assert/strict';

// Existing toolbar button, outside #gl in desktop and compact layouts.
// Hover only: no clicks, synthetic events, or production-state setters.
export const NEUTRAL_POINTER_SELECTOR = '#exploreHelp';
export const POINTER_FIXTURE_POLICY = Object.freeze({ method: 'real Playwright mouse over existing #exploreHelp',
    movesPerRoot: 5, addedAppFrames: 0, addedDraws: 0, addedReadbacks: 0,
    productionStateSetters: false, forcedGlyphHiding: false,
    historicalFailureCause: 'Hover contamination is supported by retained geometry and projections; failed-frame event ordering was not recorded and remains unproven.' });

export function appendReadOnlyHoverInspection(source) {
    for (const marker of ['let hoverBodyTarget = BODY_NONE, lockedBodyTarget = BODY_NONE, labelHoverTarget = BODY_NONE, labelPtr = null;',
        'const hovLinePos = new Float32Array(6);', 'const hovCone = new THREE.Mesh(', 'function updateHover(w, h) {'])
        assert.equal(source.split(marker).length, 2, `Read-only hover inspection hook: ${marker}`);
    return source + `
window.__diskPlaneHoverSnapshot = () => ({
    paused: G.paused, t: G.t, bodyNone: BODY_NONE,
    hoverBodyTarget, labelHoverTarget, labelPtr: labelPtr ? [...labelPtr] : null,
    lastPtr: lastPtr ? [...lastPtr] : null,
    hoverTipDisplay: hoverTipEl.style.display,
    line: { visible: hovLine.visible, positionVersion: hovLineAttr.version,
        positions: Array.from(hovLinePos), position: hovLine.position.toArray(),
        quaternion: hovLine.quaternion.toArray(), scale: hovLine.scale.toArray(), world: hovLine.matrixWorld.toArray() },
    cone: { visible: hovCone.visible, position: hovCone.position.toArray(), quaternion: hovCone.quaternion.toArray(),
        scale: hovCone.scale.toArray(), world: hovCone.matrixWorld.toArray(),
        opacity: hovCone.material.opacity, depthTest: hovCone.material.depthTest, depthWrite: hovCone.material.depthWrite }
});
`;
}

// Audit actual input without modifying or suppressing its normal callbacks.
export function installPointerAudit() {
    let last = null, sequence = 0;
    window.addEventListener('pointermove', event => {
        last = { sequence: ++sequence, x: event.clientX, y: event.clientY, timeStamp: event.timeStamp,
            trusted: event.isTrusted, pointerType: event.pointerType, buttons: event.buttons,
            targetId: event.target?.id || null, targetTag: event.target?.tagName || null,
            controlId: event.target?.closest?.('#exploreHelp')?.id || null };
    }, { capture: true, passive: true });
    window.__diskPlanePointerSnapshot = () => {
        const control = document.querySelector('#exploreHelp');
        const bounds = control?.getBoundingClientRect(), style = control && getComputedStyle(control);
        const hit = last && document.elementFromPoint(last.x, last.y);
        return { event: last ? { ...last } : null, sequence,
            control: control ? { id: control.id, hovered: control.matches(':hover'),
                visible: !!(control.isConnected && bounds.width > 4 && bounds.height > 4 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0),
                bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
                pointInside: !!(last && last.x > bounds.left && last.x < bounds.right && last.y > bounds.top && last.y < bounds.bottom) } : null,
            hit: hit ? { id: hit.id || null, tag: hit.tagName, controlId: hit.closest?.('#exploreHelp')?.id || null,
                scene: !!hit.closest?.('#gl'), label: !!hit.closest?.('.lbl') } : null,
            production: window.__diskPlaneHoverSnapshot?.() || null };
    };
}

export function assertParkedPointer(snapshot, afterSequence = -1) {
    const event = snapshot?.event, control = snapshot?.control, hit = snapshot?.hit;
    const ok = event?.trusted === true && event.pointerType === 'mouse' && event.buttons === 0 &&
        Number.isFinite(event.x) && Number.isFinite(event.y) && event.sequence > afterSequence &&
        event.controlId === 'exploreHelp' && control?.id === 'exploreHelp' && control.visible && control.hovered &&
        control.pointInside && hit?.controlId === 'exploreHelp' && !hit.scene && !hit.label;
    assert(ok, `Pointer fixture blocked: real mouse is not verified over the neutral toolbar control: ${JSON.stringify(snapshot)}`);
}

export function assertFrozenPointer(snapshot) {
    assertParkedPointer(snapshot);
    const state = snapshot.production;
    const ok = state?.paused === true && state.t === 0 && state.bodyNone === -99 &&
        state.hoverBodyTarget === state.bodyNone && state.labelHoverTarget === state.bodyNone && state.labelPtr === null &&
        state.line?.visible === false && state.cone?.visible === false && state.hoverTipDisplay === 'none';
    assert(ok, `Pointer fixture blocked: frozen capture retains active production hover state: ${JSON.stringify(snapshot)}`);
}

export function assertPointerCaptures(snapshots) {
    assert(snapshots?.length > 0, 'Every frozen draw must retain pointer evidence');
    for (const snapshot of snapshots) {
        assert(!snapshot.afterReadError, `Pointer fixture blocked: after-draw inspection failed: ${JSON.stringify(snapshot)}`);
        assertFrozenPointer(snapshot.before); assertFrozenPointer(snapshot.after);
    }
}

const parkCounts = new WeakMap();
export async function parkNeutralPointer(page) {
    const control = page.locator(NEUTRAL_POINTER_SELECTOR);
    await control.waitFor({ state: 'visible', timeout: 10000 });
    const bounds = await control.boundingBox();
    assert(bounds && bounds.width > 4 && bounds.height > 4, 'Pointer fixture blocked: existing neutral control has no usable visible bounds');
    const previous = await page.evaluate(() => window.__diskPlanePointerSnapshot?.().sequence ?? -1);
    const count = (parkCounts.get(page) || 0) + 1;
    const target = { x: bounds.x + bounds.width / 2 + (count % 2 ? -1 : 1), y: bounds.y + bounds.height / 2 };
    // One real move per planned park. Alternate interior points to obtain fresh
    // input without retries, crossing the scene, or forcing hidden controls.
    await page.mouse.move(target.x, target.y);
    const observed = await page.evaluate(() => window.__diskPlanePointerSnapshot());
    try { assertParkedPointer(observed, previous); }
    catch (error) { error.pointerEvidence = { operation: count, commandedPosition: target, observed }; throw error; }
    parkCounts.set(page, count);
    return { operation: count, commandedPosition: target, observed };
}

// Tests run exact production callback bodies, not rewritten equivalents.
export function productionHoverCallbacks(source) {
    return ['bindBodyLabel', 'updateHover'].map(name => {
        const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}', start);
        assert(start >= 0 && end > start, `Production hover callback ${name} exists`);
        return source.slice(start, end + 2);
    }).join('\n');
}
