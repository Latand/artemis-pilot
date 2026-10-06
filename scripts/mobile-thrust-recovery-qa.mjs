// Read-only recovery assertions. A cadence-delayed mode badge is separate from
// the command/actuator state: never wait away unintended post-restore thrust.
export function releasedMobileFlightIsSafe(held, restored) {
    const input = restored.input, drive = restored.drive;
    return restored.success > held.success && restored.t > held.t && restored.dv === held.dv
        && restored.contextLost === false && restored.contextLifecycleLost === false
        && restored.paused === false && restored.dead === false
        && Array.isArray(input?.keys) && input.keys.length === 0
        && input.thrustMain === 0 && input.thrustLat === 0 && input.boost === false
        && restored.throttle === 'COAST'
        && (drive === null || (drive?.magnitude === 0 && drive.engaged === false
            && drive.ax === 0 && drive.ay === 0 && drive.az === 0));
}

// Serialized by Playwright. Count an actual production HUD update after loss,
// not RAF callbacks or an assumed number of frames per wall-clock second.
export function restoredMobileHudAdvanced(held) {
    return window.__frameSuccess > held.success && window.__mobileHudFrame > held.hudFrame;
}
