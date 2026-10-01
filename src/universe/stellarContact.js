// A gas sink's R is a numerical accretion/control scale, not a photosphere.
// Keep sampled live-flight and preview contacts on the same surface rule.
export function stellarSurfaceHit(star, distanceSquared) {
    return !star?.gasSink && star?.R > 0 && distanceSquared <= star.R * star.R;
}
