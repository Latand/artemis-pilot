# Compact-source river sink support

Issue: [#66](https://github.com/Latand/artemis-pilot/issues/66).

The user reported strong Sun-centered strokes and weak flow around three
placed holes, each with a 10 km Schwarzschild radius (3.386 solar masses).
The screenshot does not identify the loaded revision or the 3D camera pose.

## Defect and scope

On base `2cde3de`, compact-source sampling can end around 0.02 of the river
volume radius, but the hole's visibility fade finishes at 0.13 of that radius.
At a representative volume/sampling radius of 100,000 scene units, the source
core is 64, sampling ends at 2,000, and the fade finishes at 13,000. Integrating
the production radial spawn distribution gives mean sink-fade transmission
0.015108. This is a display factor, not a physical luminosity measurement.

The corrected sink/crowd transitions finish by half the source's sampling
reach, and no farther than the existing 9/8 display-core radii. Their inner
edge remains below the outer edge even when the physical horizon is large
relative to the viewport. The same representative mean becomes 0.736853.
The broad halo color envelope is retained; there is no new brightness gain.

Only the vertex-stage visibility transition changes. `FLOW_GLSL` and
`COMPUTE_FRAG` are byte-identical to the base: physical field, source mass,
sampling support, ownership, capture and advection remain unchanged. The
previous optical-lapse coefficient correction in PR #62 remains intact.

At a matched physical distance outside the sources, this isolated hole has
3.386 times the Sun's Newtonian acceleration and 1.840 times its river-model
speed. Neither streak brightness nor length is a calibrated force meter.

## Checks

`node scripts/smoke-river-sink-support.mjs` covers sink/support scale ladders,
ordered fade bounds, the old formula as a failing negative control, exact
field/compute preservation, and the coefficient/mass ratio.

`node scripts/verify-river-sink-support.mjs [output-directory]` uses the real
production app and shaders at High quality, with full desktop/mobile particle
allocations. It freezes physical time and captures a pixel-identical Sun-only
control plus three matched-distance views: Sun plus one hole, Sun plus three
holes, and a wider three-hole view.
Mobile uses a larger camera distance so all sources fit the narrower viewport.
One further capture resolves the 10 km horizon at an 80 km observer distance,
through the production lens/optics path, and checks that its interior stays
black. A broad majority-clipping guard rejects a saturated white patch in
place of missing strokes; before/after PNG inspection remains required.
For each view, the pinned old and candidate vertex shaders render the exact
same GPU particle texture, source state, uniforms and camera. The test reads
the completed WebGL framebuffer and saves full PNGs and region measurements.
It fails if the old missing-stroke condition is not improved, if an actual
hole has no owned samples, or if any field/texture state changes between draws.

The workflow also retains the existing visual, coverage, owner-radiance,
lifecycle, source-alignment, resource-policy and gravity-hole headless guards.
Those structural guards are not a substitute for the existing long coverage
and radiance renderer suites; this focused check does not relax their gates.

Local pure/structural checks pass. Local Chromium cannot launch because this
executor denies its required Unix socket, including an escalated invocation.
Actual rendered acceptance remains pending the focused hosted workflow and
inspection of its before/after PNGs. No hardware frame-time claim is made.
