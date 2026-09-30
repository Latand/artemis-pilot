import { river, setRiverStyle } from './river.js';
import { G } from './state.js';

export const RIVER_STYLES = [
    { id: 'lines', name: 'Fine lines' },
    { id: 'arcs', name: 'Luminous arcs' },
    { id: 'particles', name: 'Particle current' },
    { id: 'pulses', name: 'Time pulses' },
    { id: 'currents', name: 'Gravity currents' },
];

export function initRiverStyles() {
    const controls = [...document.querySelectorAll('[data-river-style]')];
    let saved = null;
    try { saved = localStorage.getItem('ap_riverStyle'); } catch {}
    const requested = new URLSearchParams(location.search).get('flowstyle') || saved || 'arcs';
    const initial = RIVER_STYLES.findIndex(s => s.id === requested);
    setRiverStyle(initial < 0 ? 1 : initial);
    for (const select of controls) {
        for (const style of RIVER_STYLES) {
            const option = document.createElement('option');
            option.value = style.id; option.textContent = style.name;
            select.append(option);
        }
        select.value = RIVER_STYLES[river.style].id;
        select.addEventListener('change', () => {
            const index = RIVER_STYLES.findIndex(s => s.id === select.value);
            if (!setRiverStyle(index)) return;
            G.gr = true;
            for (const other of controls) other.value = select.value;
            try { localStorage.setItem('ap_riverStyle', select.value); } catch {}
        });
        // Camera shortcuts must not consume a select's arrow keys.
        for (const event of ['keydown', 'keyup', 'pointerdown', 'wheel']) {
            select.addEventListener(event, e => e.stopPropagation());
        }
    }
}
