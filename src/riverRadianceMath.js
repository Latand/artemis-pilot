// Display-only importance-sampling compensation. View-aware allocation puts
// more tracers around a visible source; those extra samples must not multiply
// its ink. Retain a small glyph-equivalent budget for sources that had too few
// old samples to show their field at all. These are not physical luminosities.
export const SPARSE_SOURCE_SAMPLES = 128;
export const OWNED_SAMPLE_FRACTION = .68;

export function sourceSampleInkGain(allocatedSamples, referenceSamples) {
    if (!Number.isFinite(allocatedSamples) || allocatedSamples <= 0 || !Number.isFinite(referenceSamples)) return 1;
    const reference = Math.max(0, referenceSamples);
    return Math.min(1, Math.max(SPARSE_SOURCE_SAMPLES, reference) / allocatedSamples);
}
