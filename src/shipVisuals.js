import { createShipMotion, stepShipMotion } from './shipMotion.js';
import './shipVisuals.css';

export const shipVisuals = {
    enabled: false, motion: createShipMotion(),
    x: 0, y: 0, z: 0, dx: 0, dy: 1, dz: 0, radius: .07,
    strength: 0, visible: false,
};
export function initShipVisuals() {
    const buttons = document.querySelectorAll('[data-warp-visual]');
    const notes = document.querySelectorAll('[data-warp-note]');
    const sync = () => {
        for (const button of buttons) {
            button.setAttribute('aria-pressed', String(shipVisuals.enabled));
            button.textContent = `Warp visual · ${shipVisuals.enabled ? 'ON' : 'OFF'}`;
        }
        for (const note of notes) note.hidden = !shipVisuals.enabled;
    };
    for (const button of buttons) button.addEventListener('click', () => {
        shipVisuals.enabled = !shipVisuals.enabled;
        if (!shipVisuals.enabled) shipVisuals.strength = 0;
        sync();
    });
    sync();
}
export function updateShipVisuals(craft, position, direction, scale, speedKmS, dtReal, paused, visible) {
    const s = shipVisuals;
    stepShipMotion(s.motion, speedKmS, dtReal, paused);
    for (const rotor of craft.userData.rotors) rotor.rotation.y = s.motion.angle;
    s.x = position.x; s.y = position.y; s.z = position.z;
    s.dx = direction.x; s.dy = direction.y; s.dz = direction.z;
    s.radius = Math.min(10, Math.max(.036, scale * 3));
    s.visible = visible;
    s.strength = s.enabled && visible ? s.motion.level : 0;
}
