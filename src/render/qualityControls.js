import { QUALITY_MODES, QUALITY_NAMES } from './adaptiveQuality.js';
import './qualityControls.css';
export function installQualityControls(state, setMode) {
    const root = document.createElement('details');
    root.id = 'renderQualityControls';
    const summary = document.createElement('summary'); summary.textContent = 'Graphics';
    const label = document.createElement('label'); label.textContent = 'Visual quality ';
    const select = document.createElement('select'); select.id = 'renderQualityMode';
    select.setAttribute('aria-label', 'Visual quality');
    for (const [i, value] of QUALITY_MODES.entries()) {
        const option = document.createElement('option'); option.value = value;
        option.textContent = i ? QUALITY_NAMES[i - 1] : 'Auto'; select.append(option);
    }
    label.append(select);
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const note = document.createElement('p');
    note.textContent = 'Minimal keeps bodies, stars and gravity flow, with a simplified galaxy and no lensing or bloom. Physics and saves are unchanged. Reload High for its full particle allocation and antialiasing. Software rendering may remain slow.';
    root.append(summary, label, status, note); document.body.append(root);
    select.addEventListener('change', () => setMode(select.value));
    // Graphics shortcuts must never leak into ship controls.
    root.addEventListener('keydown', event => {
        if (event.key === 'Escape') { root.open = false; summary.focus(); }
        event.stopPropagation();
    });
    const update = () => {
        select.value = state.mode;
        summary.textContent = `Graphics · ${QUALITY_NAMES[state.effectiveLevel ?? state.level]}`;
        const reason = state.effectiveLevel > state.level ? 'current scene workload' : state.reason;
        status.textContent = `${state.mode === 'auto' ? 'Auto: ' : ''}${reason}${state.software ? ' · software rendering detected' : ''}.`;
    };
    update(); return update;
}
