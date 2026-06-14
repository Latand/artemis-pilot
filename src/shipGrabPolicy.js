export const SHIP_GRAB_HOLD_MS = 120;
export const SHIP_GRAB_CANCEL_PX = 10;
export const SHIP_GRAB_FOLLOW_GAIN = .34;
export const SHIP_GRAB_MAX_SPEED = 80;
export const SHIP_GRAB_THROW_SCALE = .35;

export function shipGrabPendingIntent(movedPx, heldMs) {
    const moved = Number.isFinite(movedPx) ? Math.max(0, movedPx) : Infinity;
    const held = Number.isFinite(heldMs) ? Math.max(0, heldMs) : 0;
    if (moved > SHIP_GRAB_CANCEL_PX) return "camera";
    return held >= SHIP_GRAB_HOLD_MS ? "activate" : "pending";
}
