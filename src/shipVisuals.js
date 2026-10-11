import { WARP, BUBBLE_SIGMA } from './warpBubble.js';
import { G } from './state.js';
import { createShipMotion, stepShipMotion } from './shipMotion.js';
import './shipVisuals.css';
import { DRIVE } from './curvatureDrive.js';
import { createDriveField } from './shipDriveField.js';
import * as THREE from 'three';
const axis = new THREE.Vector3(), up = new THREE.Vector3(0,1,0);
let field = null;
// Alcubierre's R is a free parameter. The hull is drawn enlarged so it stays
// readable, and R follows that drawing: the calm interior always holds the
// hull and the walls span the field around it at every zoom.
export const BUBBLE_VIEW_RADIUS = .45;

export const shipVisuals = {
    enabled: true, motion: createShipMotion(),
    x: 0, y: 0, z: 0, dx: 0, dy: 1, dz: 0, radius: .07,
    strength: 0, visible: false,
    // Warp sandbox state read by the shared river (river.js); scene units.
    // chart: 1 draws the field in the chart moving with the ship (bubble fills
    // the view), 0 in the rest chart (bubble small against a system view).
    bubble: { active: false, presence: 0, radius: 0, chart: 1, speed: 0, sigma: BUBBLE_SIGMA, ax: 0, ay: 1, az: 0 },
};
export function initShipVisuals() {
    const buttons = document.querySelectorAll('[data-warp-visual]');
    const notes = document.querySelectorAll('[data-warp-note]');
    const sync = () => {
        for (const button of buttons) {
            button.setAttribute('aria-pressed', String(shipVisuals.enabled));
            button.textContent = `Field guide · ${shipVisuals.enabled ? 'ON' : 'OFF'}`;
        }
        for (const note of notes) note.hidden = !shipVisuals.enabled && !WARP.enabled;
    };
    for (const button of buttons) button.addEventListener('click', () => {
        shipVisuals.enabled = !shipVisuals.enabled;
        if (!shipVisuals.enabled) shipVisuals.strength = 0;
        sync();
    });
    sync();
}
const smooth01 = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function updateBubble(b, viewDist, dtReal, paused, radiusCap) {
    b.active = WARP.enabled;
    b.speed = WARP.enabled ? WARP.speed : 0;
    // Bubble axis in scene axes: (x, y, z) -> (x, z, -y).
    b.ax = WARP.dx; b.ay = WARP.dz; b.az = -WARP.dy;
    // R follows the view only while the camera rides with the hull; a view
    // focused elsewhere leaves it at its last size.
    // It is bounded with the drawn hull, so a system view keeps a small bubble.
    const viewR = Number.isFinite(viewDist) && viewDist > 0 ? viewDist * BUBBLE_VIEW_RADIUS : 0;
    const cappedR = viewR > 0 ? Math.min(viewR, radiusCap > 0 ? radiusCap : Infinity) : 0;
    const wanted = G.focus === 'ship' && cappedR > 0 ? cappedR : b.radius;
    // Ship chart while the bubble fills the view, rest chart once it is small
    // against it (from the zoom alone, so easing R never flips the chart).
    if (G.focus === 'ship' && viewR > 0) b.chart = smooth01(.15, .85, cappedR / viewR);
    // Zooming is a view action: R follows it in real time, even when paused.
    const view = Math.max(0, Math.min(dtReal || 0, .1)), dt = paused ? 0 : view;
    // Eased in log space, so even a large zoom ratio settles within a second.
    if (!(b.radius > 0) || b.presence === 0) b.radius = wanted;
    else b.radius *= Math.exp(Math.log(wanted / b.radius) * -Math.expm1(-view / .25));
    // Presence only eases presentation (volume, contrast, contour). The field
    // term itself is v_s(f - 1) and follows the model speed every frame.
    const target = b.speed > 0 ? Math.min(1, Math.log1p(b.speed) / Math.log1p(20)) : 0;
    b.presence = target >= b.presence ? b.presence + (target - b.presence) * -Math.expm1(-dt / .25)
        : b.presence + (target - b.presence) * -Math.expm1(-dt / .6);
    if (b.presence < 1e-3 && target === 0) b.presence = 0;
}
export function updateShipVisuals(craft, position, direction, scale, speedKmS, dtReal, paused, visible, viewDist = NaN, radiusCap = Infinity) {
    const s = shipVisuals;
    updateBubble(s.bubble, viewDist, dtReal, paused, radiusCap);
    // Ring motion and all distortion use the delivered drive field, never
    // passive orbital speed. speedKmS remains in the API for old view callers.
    const bubbleLevel = WARP.enabled && WARP.speed > 0 ? Math.min(1,.2+WARP.logSpeed/18) : 0;
    const level = bubbleLevel || DRIVE.level;
    stepShipMotion(s.motion, level * 120, dtReal, paused);
    for (const rotor of craft.userData.rotors) rotor.rotation.y = s.motion.angle;
    s.x = position.x; s.y = position.y; s.z = position.z;
    axis.set(DRIVE.ax, DRIVE.az, -DRIVE.ay);
    if (axis.lengthSq() > 1e-20) axis.normalize(); else axis.copy(direction);
    s.dx = axis.x; s.dy = axis.y; s.dz = axis.z;
    s.radius = Math.min(10, Math.max(.036, scale * 3));
    s.visible = visible;
    // The warp is drawn only through the shared river.
    s.strength = s.enabled && visible && !WARP.enabled ? DRIVE.level : 0;
    if (!field) { field = createDriveField(); craft.parent.add(field); }
    field.visible = s.strength > .001;
    field.quaternion.setFromUnitVectors(up, axis);
    field.scale.setScalar(s.radius);
    field.material.uniforms.level.value = s.strength;
    field.material.uniforms.phase.value = s.motion.angle;
    s.fieldVisible = field.visible;
}
