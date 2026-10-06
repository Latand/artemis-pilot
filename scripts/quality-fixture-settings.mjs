// Compare render settings, not the changing measurements used to choose them.
// Keep every other field, including future budget knobs; raw snapshots remain
// in the browser report so timing/history diagnostics are not discarded.
export function qualitySettings(snapshot) {
    const { frameMs, samples, changes, reason, ...settings } = snapshot;
    return settings;
}
