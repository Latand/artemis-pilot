export const SHIP_GRAB_HOLD_MS = 220;
export const SHIP_GRAB_CANCEL_PX = 6;
export const SHIP_GRAB_FOLLOW_GAIN = .2;
export const SHIP_GRAB_MAX_SPEED = 32;
export const SHIP_GRAB_THROW_SCALE = .18;
export const SHIP_GRAB_PICK_MIN_PX = 14;
export const SHIP_GRAB_PICK_MAX_PX = 28;

export function shipGrabPendingIntent(movedPx, heldMs) {
    const moved = Number.isFinite(movedPx) ? Math.max(0, movedPx) : Infinity;
    const held = Number.isFinite(heldMs) ? Math.max(0, heldMs) : 0;
    if (moved > SHIP_GRAB_CANCEL_PX) return "camera";
    return held >= SHIP_GRAB_HOLD_MS ? "activate" : "pending";
}
