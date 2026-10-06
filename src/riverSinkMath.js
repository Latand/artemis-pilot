// Display-only sink transitions. A compact object's sampled halo must extend
// beyond its exclusion fade; the camera's whole volume is not a sink radius.
// These bounds never enter the field, mass, sampling, or advection equations.
export const SINK_SUPPORT_FRACTION = 0.5;

export const blackHoleSinkOuter = (core, reach, coreMultiple) =>
    Math.min(core * coreMultiple, reach * SINK_SUPPORT_FRACTION);

export const BLACK_HOLE_SINK_GLSL = /* glsl */`
float blackHoleSinkOuter(float core, float reach, float coreMultiple) {
    return min(core * coreMultiple, reach * ${SINK_SUPPORT_FRACTION});
}
`;
