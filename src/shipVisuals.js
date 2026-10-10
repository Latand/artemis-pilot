import { WARP } from './warpBubble.js';
import { createWarpMetricField } from './warpMetricField.js';
import { createShipMotion, stepShipMotion } from './shipMotion.js';
import './shipVisuals.css';
import { DRIVE } from './curvatureDrive.js';
import { createDriveField } from './shipDriveField.js';
import * as THREE from 'three';
const axis = new THREE.Vector3(), up = new THREE.Vector3(0,1,0);
let field = null, metricField = null;

export const shipVisuals = {
    enabled: true, motion: createShipMotion(),
    x: 0, y: 0, z: 0, dx: 0, dy: 1, dz: 0, radius: .07,
    strength: 0, visible: false,
};
export function initShipVisuals() {
    const buttons = document.querySelectorAll('[data-warp-visual]');
    const notes = document.querySelectorAll('[data-warp-note]');
    const sync = () => {
        for (const button of buttons) {
            button.setAttribute('aria-pressed', String(shipVisuals.enabled));
            button.textContent = `Field guide · ${shipVisuals.enabled ? 'ON' : 'OFF'}`;
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
    // Ring motion and all distortion use the delivered drive field, never
    // passive orbital speed. speedKmS remains in the API for old view callers.
    const bubbleLevel = WARP.enabled && WARP.speed > 0 ? Math.min(1,.2+WARP.logSpeed/18) : 0;
    const level = bubbleLevel || DRIVE.level;
    stepShipMotion(s.motion, level * 120, dtReal, paused);
    for (const rotor of craft.userData.rotors) rotor.rotation.y = s.motion.angle;
    s.x = position.x; s.y = position.y; s.z = position.z;
    if (bubbleLevel) axis.set(WARP.dx,WARP.dz,-WARP.dy);
    else axis.set(DRIVE.ax, DRIVE.az, -DRIVE.ay);
    if (axis.lengthSq() > 1e-20) axis.normalize(); else axis.copy(direction);
    s.dx = axis.x; s.dy = axis.y; s.dz = axis.z;
    s.radius = bubbleLevel ? Math.max(.036,scale*3) : Math.min(10, Math.max(.036, scale * 3));
    s.visible = visible;
    s.strength = s.enabled && visible ? level : 0;
    if (!field) { field = createDriveField(); craft.parent.add(field); }
    field.visible = s.strength > .001 && !bubbleLevel;
    if (!metricField) { metricField=createWarpMetricField(); craft.parent.add(metricField); }
    metricField.visible=s.strength>.001 && bubbleLevel>0;
    metricField.quaternion.setFromUnitVectors(up,axis);
    metricField.scale.setScalar(s.radius);
    metricField.material.uniforms.level.value=s.strength;
    field.quaternion.setFromUnitVectors(up, axis);
    field.scale.setScalar(s.radius);
    field.material.uniforms.level.value = s.strength;
    field.material.uniforms.phase.value = s.motion.angle;
    s.fieldVisible = field.visible || metricField.visible;
    s.metric = metricField.visible;
}
