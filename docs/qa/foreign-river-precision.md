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

## First GPU result and the captured photosphere correction

Run `37186624841` on actual `e90481cdb4e313493e5e3f54f4a42ea5dffe3665`
failed on the first host frame on both devices. Its two artifacts remain the
original failed evidence: desktop `11297610313`, SHA256
`fb8fcec6c43753147de4032956084109b3d7e88fd90a9b3ac42dbd732e63d11c`, and
mobile `11297058999`, SHA256
`e57f2eab023f31034ef3be5b0cfae1cb6e27b92eec7214052bb0debba42054a4`.
The repaired river observer and draw residuals reached the actual GPU, with
finite full buffers and 10,452 desktop / 5,250 mobile drawn samples owned by
the correct host. No screenshot was reached, so this is not visual acceptance.

The independent quaternion/matrix calculations differ by about 2e-14 around
zero. The numerical comparison now adds the local float64 arithmetic bound to
float32 upload spacing; it does not enlarge the error budget using absolute
galaxy coordinates. A mutation exceeding that derived bound still fails.

The same frame showed an undrawn photosphere. Replaying its exact camera and
303.367209730177-unit sphere in THREE.Frustum makes the near-tier far plane
report -3,346,140,824 units, despite a true view distance of 1,213.468838920708.
Both CPU tier tests reject it before the material callback can repair its
transform. Galaxy-qualified photospheres now bypass that inaccurate global
test under the existing 48-object active-visual cap and LOD/visibility gates.
Ordinary Milky Way photospheres keep CPU culling. Hidden parents still stop
traversal, and behind-camera geometry still clips on the GPU.

The fixture now requires a real body draw in the current frame, records the
actual per-draw GPU model-view rather than a potentially stale object matrix,
and requires nonblank host-region pixels. The first host and planet frames are
also captured. The sequence, source ownership, finite-buffer, saved-system,
signed-advection and native-recovery checks retain their earlier requirements.

## Undiscovered point-layer startup allocation

The pre-fix `8663be59` full radiance run `37184131655` failed the desktop Sun
and black-hole workload comparison after preparation, before any accepted
warmup/measurement samples. GPU geometry counts were candidate 195 / base 194
for the Sun and 193 / 192 for the black hole. The failed raw artifacts
`11296959011` and `11297094438` remain intact. No GPU-count allowance was added.

Desktop startup renders the scene before the first discovery frame. The foreign
point layer previously started visible with an infinite draw range and 420
unfilled attribute entries. The actual Three traversal and geometry allocators
register that exact object: one geometry, five attributes, 15,120 bytes. The
layer now starts hidden with zero draw range; existing discovery alone activates
it. The real initializer/allocator regression retains the old failing control,
proves zero allocation initially and on the first Milky Way query, then one
allocation on real M31 activation with unchanged buffers and IDs on revisit.
The fresh performance comparison still requires exact GPU-resource equality.

## Corrected host draw, away-facing planet ownership

The next isolated run `37188916575` at `583370e9` passed all eight initial
host frames on desktop and mobile, including actual triangle submissions,
CPU/GPU observer and photosphere transforms, nonblank host-region pixels,
finite full buffers and nonzero host ownership. Both jobs then stopped at
`planet-0`. Raw artifacts remain: desktop `11298357802`, SHA256
`0a1dad58661051eae8bf1226cbfdb510658c6e1c4de2428e03149c735dc45d72`, and
mobile `11298023924`, SHA256
`773c1a0a0e488e1adfaa24c008c23d7906d2df3d327339ce0b4c9a6bfd69883d`.

That planet frame passed observer/body transforms and finite-buffer checks.
The registered host remained a current field source but owned zero samples.
Replaying the production halo eligibility rule gives source view position
`[-3954.9925349749233, -3766.406474330936, 6767.961616674823]`, reach
`5357.184809961386`, and depth plus reach `-1410.7768067134366`.
Its halo is behind the observer, so zero eligibility, CDF and ownership are
correct. The earlier fixture incorrectly demanded positive ownership there.

The fixture preserves that exact away-facing transition and requires zero
ownership after its actual dispatch. It then selects one fixed planet pose
with the host in front, retains four native cadence frames, and requires
positive host ownership in every following fixed-view frame. This is explicit
inspection framing, not continuous navigation. Every foreground frame records
the actual camera quaternion, recomputes the production eligibility and full
source CDF, and checks current source/force/epoch parity. Signed-epoch frames
follow actual eligibility and the retained dispatch snapshot without moving
the camera to manufacture ownership. Missing eligible owners, fabricated
away-view owners, changed quaternion/CDF, stale field and clock all fail pure
negative controls. Production and the fifteen-minute fixture cap are unchanged.

Independent review additionally demonstrated that position parity alone could
accept a zeroed force coefficient in the excluded view. The fixture now records
the real active provider's mass parameter and radius, the field's coefficient
and sink, and actual compiled GPU `uBody.w`/`uSink` values. Both field and CPU
uniform values must equal the provider-derived values; GPU values must match
within float32 upload rounding. Twenty-eight zero/altered force, core and
provider negative controls cover both eligible and excluded views. Turning
off visible halo ownership cannot turn off the host's gravitational source.
