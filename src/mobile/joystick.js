import { G, keys } from '../state.js';
import { markInteraction, onInputCancel } from './renderSession.js';

export function bindNavigationStick(element) {
    let id = null, x = 0, y = 0, raf = 0, last = 0;
    const owned = new Set();
    const set = (code, enabled) => {
        if (enabled) { keys.add(code); owned.add(code); }
        else if (owned.delete(code)) keys.delete(code);
    };
    const clearKeys = () => { for (const key of owned) keys.delete(key); owned.clear(); };
    const stop = () => {
        const pointer = id; id = null; x = y = last = 0;
        cancelAnimationFrame(raf); raf = 0; clearKeys();
        element.style.setProperty('--stick-x', '0px'); element.style.setProperty('--stick-y', '0px');
        if (pointer !== null) try { element.releasePointerCapture(pointer); } catch { /* already released */ }
        markInteraction(false);
    };
    const tick = t => {
        if (id === null) return;
        const dt = last ? Math.min(.04, (t - last) / 1000) : 0; last = t;
        if (G.uiMode === 'pilot') {
            set('KeyA', x < -.18); set('KeyD', x > .18);
            set('KeyW', false); set('KeyS', false);
            if (Math.abs(y) > .18) { G.hold = null; G.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, (G.pitch || 0) - y * dt)); }
        } else if (G.uiMode === 'observe') {
            set('KeyA', x < -.18); set('KeyD', x > .18);
            set('KeyW', y < -.18); set('KeyS', y > .18);
        } else { stop(); return; }
        raf = requestAnimationFrame(tick);
    };
    const move = e => {
        if (id !== e.pointerId) return;
        const rect = element.getBoundingClientRect(), radius = Math.max(1, rect.width * .35);
        x = (e.clientX - rect.x - rect.width / 2) / radius;
        y = (e.clientY - rect.y - rect.height / 2) / radius;
        const length = Math.max(1, Math.hypot(x, y)); x /= length; y /= length;
        element.style.setProperty('--stick-x', `${x * 25}px`); element.style.setProperty('--stick-y', `${y * 25}px`);
        e.preventDefault(); markInteraction(true);
    };
    element.addEventListener('pointerdown', e => {
        if (id !== null) return;
        id = e.pointerId; element.setPointerCapture(id); move(e); raf = requestAnimationFrame(tick);
    });
    element.addEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(type, e => { if (e.pointerId === id) stop(); });
    // Keyboard alternatives: this button and the existing movement controls
    // are usable without a touchscreen. No synthetic keydown event injection.
    element.addEventListener('keydown', e => {
        const code = { ArrowLeft: 'KeyA', ArrowRight: 'KeyD', ArrowUp: 'KeyW', ArrowDown: 'KeyS' }[e.key];
        if (code && G.uiMode === 'observe') { e.preventDefault(); set(code, true); }
    });
    element.addEventListener('keyup', clearKeys); element.addEventListener('blur', stop);
    onInputCancel(stop);
    return stop;
}
