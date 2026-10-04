# Foreign-host observer and river precision

The enabled river was not covered by the earlier Andromeda route: that capture
uses `river=0`, while the radiance fixtures cover Milky Way sources. Inspection
of actual head `8663be59` reproduced a separate precision error. For host
`gx:m31:2654435769:1250:0:0:18`, planet 0 has radius 4054.82662200786 km. At
3R, a 30 Hz free-camera move is 0.2635637304305109 scene units. The split camera
retained that motion, but the old river observer uniform remained `[6,6,-8]`
and its model-view translation remained `[2,1.5,-12]`. The required observer
x residual changed from 6.734463451560835 to 6.998027181991013. Its final
observer residual error was 1.8491574784326332 scene units, about 1,849 km.

The repair subtracts the river origin before combining the split observer's
local offset. It uses that result for volume sizing and the shader's camera
uniform. Line, dot, warp-guide and collapsing-shell materials use the existing
body translation hook, so their model-view frame agrees with the observer.
The hook retains previous callbacks and is installed once at material creation.
Native context restoration reuses those materials. Missing or stale split
metadata uses the ordinary camera-position path. Physical world positions,
source ranking, force coefficients, flow/compute GLSL and the retained
texture-center/center-shift rules are unchanged.

`smoke-foreign-river.mjs` executes the real camera function and the previous
river publication as a negative control. It covers positive, negative and
revisited epochs at twelve viewing angles, sub-unit movement, material callback
ownership, ordinary/stale fallback and immutable physical/shader inputs. The
old code fails all 96 before/after samples across 48 cases. Separate negative
controls reject missing/stale sources, zero owned samples, clock drift, reduced
buffers, invalid GPU data and uniform/model-view/body misalignment.

`verify-foreign-river.mjs` keeps the real provider, selected source, physical
clock and native river budgets. It reads every live particle texel, actual
compiled-program camera/model-view uniforms and the rendered body's matrix.
It covers a star, its planet, keyboard free movement, signed clock delivery,
return, keyboard quicksave/quickload and native loss/restoration. Draw/read/PNG
capture occurs in one browser task. Error budgets derive from local float64
operations and float32 spacing; intergalactic coordinates do not enlarge them.

This is a bounded integration fixture, with distant catalog/galaxy background
layers omitted. It is not a performance benchmark or continuous-flight proof.
The ship stays in the Milky Way; its independent warp-visibility distance path
is outside this repair's claim. Generated planets retain the existing host
field, without a new planet well or mutual stellar gravity. Full travel,
resource and radiance performance gates need the corrected production source;
earlier reports remain evidence for their original pre-fix head.

Local source checks (no browser in validation):

```sh
node scripts/smoke-foreign-river.mjs
node scripts/verify-foreign-river.mjs . /tmp/foreign-river-validate --validate
```

After independent review, the hosted fixture is invoked with `DEVICE=desktop`
and `DEVICE=mobile`. No browser run has been claimed by this document.

The isolated `Foreign river precision validation` workflow runs only on pushes
to `diagnostic/foreign-river-precision`, with two jobs and no PR-wide benchmark
trigger. Each job has a 20-minute total cap and a 15-minute fixture process cap.
It verifies the complete production fingerprint, exact reviewed fixture/source
blobs and actual HEAD before and after execution, retains raw JSON/PNG evidence
and source identities even on failure, and does not retry. Passing this bounded
validation is a prerequisite for considering another full corrected-source
cohort, not a substitute for that cohort or its original performance gates.
