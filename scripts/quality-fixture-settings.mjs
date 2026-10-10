// Compare render settings, not the changing measurements used to choose them.
// Trial is controller telemetry, not a render budget (including in manual mode).
// Keep every other field, including future budget knobs; raw snapshots remain
// in the browser report so timing/history diagnostics are not discarded.
export function qualitySettings(snapshot) {
    const { frameMs, samples, changes, reason, trial, ...settings } = snapshot;
    return settings;
}
