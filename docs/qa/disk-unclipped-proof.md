# Conservative disk raster-support fast path

This local candidate addresses issue #50 only. It adds a uniform shortcut to the
normalized raster-support implementation at `c933da57`. It does not repair the
ring/lens issue #49 or replace any failed performance result. Main 6179's lens,
planet/ring rendering, physical inputs and depth tests remain unchanged.

The previous v3 cohort 37232097341 passed all four pixel/lifecycle and p95 gates,
but failed desktop/direct maximum task 548 > 515.55 ms, desktop/bloom maximum
448 > 431.55 ms, and mobile/bloom total blocking 42099 > 41945 ms. Those failures remain
valid. A shader shortcut has no established timing or pixel acceptance yet.

## What is skipped

`uDiskUnclipped` is recomputed by the actual disk draw callback, using that draw's
uploaded float32 origin, disk normal, camera rotation, inverse projection, view
depth and active near/far tier. It starts at 0, resets on rejected cameras and
avoids the proof entirely when the disk is disabled. The flag is not cached
between cameras, tiers or recreated materials. A renderer-specific capability
qualification is recorded from the actual `onBeforeCompile` parameters when
the disk material compiles: effective highp, at least 23
fraction bits, exponent ranges at least 126/127. Unknown or lower precision
keeps the normalized path. Compilation resets the flag before uniform upload,
including recompilation after context restoration. Renderer qualifications are
separate. A missing/unsupported compile permanently rejects this shortcut for
that material/renderer, so a later highp compile cannot authorize a previously
cached mediump program that skips the compile hook. A new material starts
unverified. This conservative fallback also persists across restoration when
that existing material has an uncertain history. No precision query or GL
readback enters a draw callback. `getShaderPrecisionFormat` qualifies storage
precision/range; it does not certify IEEE operation rounding.

When it is 1, every ray in the viewport has full unclipped support. The shader
uses the original `-ro.z/rd.z` hit and coverage 1. When it is 0, the normalized
interval, its centered arithmetic, clipping and fractional coverage remain.
The new branch depends only on a uniform. The radial mask, noise, lighting,
shadow, native derivatives downstream of the hit, blending and depth fence
are unchanged. No texture read or render pass is added.

## Eligibility proof

The proof deliberately accepts only a narrow camera family. Its inverse
projection at NDC z=0 must give `(a*x,b*y,-1,w)` for x,y in[-1,1], with
0<a,b<=2 and 2^-32<=w<=2^32. The actual physical viewport is read from
`renderer.getCurrentViewport`; integer dimensions 4..32768 are required. The
proved NDC rectangle extends two pixels beyond each edge: x in
±(1+4/width), y in±(1+4/height). This includes native derivative helper lanes,
so unchanged visible hits also retain their downstream derivative neighborhood.
The expanded a/b extents must still be<=2. Asymmetric, orthographic and custom forms reject.
The caller also rejects parented/non-perspective cameras. The uploaded rotation
must have `||R^T R-I||F <1e-5`; the uploaded normal and view-depth vectors must
have squared lengths within 1e-5 of 1. Scaled or uncertain cameras therefore keep
the normalized path. All values are finite, with absolute magnitude<=2^70;
rsUnits is in [2^-32,2^32].

For q=(a*x,b*y,-1) over that expanded rectangle, the numerator `n dot Rq` is affine in x,y. Its extrema are
bounded by its center plus/minus the absolute x/y coefficient contributions.
Let g=||R^T R-I||F. The denominator |Rq| lies between sqrt(1-g) and
sqrt(1+g)*sqrt(1+expandedA²+expandedB²). Applying those denominator bounds to each signed
numerator endpoint bounds the exact normalized ray dot product over the whole
frustum, including corners and its interior. The same calculation bounds the
view-depth dot product. This is stronger than checking only disk-center rays.

The bounds include an explicit IEEE float32 arithmetic error budget. With
u=2^-24 and gamma(k)=ku/(1-ku):

- projected multiplication/division contributes gamma(2) relative vector error;
- each normalization bounds the three products/two sums by gamma(5), then
  rounded square root and division;
- perturbing a vector by e before normalization contributes at most
  2e/(length-e) to its unit direction;
- the matrix product contributes gamma(5)*||R||F times its input norm;
- the final normal/view dot contributes its own gamma(5) error;
- the origin dot uses gamma(5) times the sum of absolute products.

Small outward double-arithmetic cushions cover CPU calculations of these
bounds. The nonzero projected z component keeps the pre-normalization norm
between normal float32 scales 2^-33 and 2^34. The separate depth-product guard keeps the shader's 1e-12
floor inactive. The magnitude, slope and support limits keep the largest
interval intermediate below 2^120, below float32 overflow. This model does not
assert identical native GPU execution; shader compilation and final GPU tests
remain separate requirements.

Let Hlo/Hhi bound the absolute uploaded origin-normal dot; let slo/shi bound the
positive toward-plane ray slope, and dlo/dhi the positive view-depth dot. Let
h=float32(.02), the largest possible raster support. Eligibility requires:

- Hlo>2h, slo>.001 and rsUnits*dlo>2e-12;
- `(Hlo-h)/shi * rsUnits*dlo > 2*near`;
- `(Hhi+h)/slo * rsUnits*dhi < far/2`.

These conditions put every support interval wholly in front of the camera and
strictly inside the active depth tier. The factor-two interior dominates
rounding in hit, half-width, depth-product and clipping divisions. It is an
eligibility margin, not a modified clipping plane or physical thickness.
In the fallback expressions this gives entry=-1 and exit=1, hence coverage=1
and hit=planeHit+halfWidth*0=planeHit. Positive hits are bit-identical in the
float32 scalar model. Near/far truncation, camera-plane crossing and tangent
frusta cannot take the shortcut. Unsupported views simply retain the current
normalized implementation.

## Evidence and limits

`smoke-disk-plane-support.mjs` still evaluates the actual fallback expressions,
including the far Cygnus annulus whose absolute endpoint subtraction vanished
in float32. That is a scalar stability case, not a claim that the subpixel
annulus is visibly resolved. The new `smoke-disk-frustum-fast-path.mjs` checks 125 scalar cases and 16,538
reconstructed float32 rays, including the derivative halo. It has 13 positive
and 35 negative fixtures, 400 seeded adversarial views and 6 deterministic guard
mutations. Twenty required physical-input records come from the preserved v3
cohort; their report and PNG hashes are retained. Camera matrices for those
records are explicitly reconstructed from pinned fixture settings. `smoke-disk-fast-path-lifecycle.mjs` executes the production
material and camera callback with real Three cameras, including tier changes,
parenting, scale, projection changes, disabled/re-enabled disk and new material.
It covers 36 callback/material transitions, including unsupported shader
precision and renderer-specific capability state. It is a CPU lifecycle test,
not native GPU context recovery. `smoke-disk-program-precision.mjs` additionally
uses the installed Three r164 `WebGLPrograms.getParameters/getProgramCacheKey`
to reproduce inherited mediump despite renderer default highp, and cached
mediump reselection after a later highp compilation. Only new cache keys invoke
the production compile callback. This is actual parameter/cache-key behavior,
not GPU program execution.

Offline Mesa compilation must use the final committed source and captured
native Three shader prefixes for all four layer programs. It proves compilation
and linking only. Existing source/fixture pins still intentionally bind the old
v3 candidate; they must be updated and reviewed separately before a future
hosted cohort. No old timings, pixels or recovery results qualify this source.

The plausible saving is removal of two support derivatives, two vector lengths
and the normalized interval arithmetic in ordinary inclined views. The full
normalized path remains compiled and available. Actual compiler execution and
net cost, including the once-per-disk-draw CPU proof, are unmeasured. Lower
recurring GPU cost could reduce aggregate blocking; it cannot promise that
isolated maximum-task failures disappear.
