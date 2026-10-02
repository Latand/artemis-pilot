# External galaxies: continuous close-view detail

## Report and diagnosis

The supplied image shows Andromeda as a large smooth spiral inside a sharply
bounded, rotated square. The old shader capped each billboard axis at 0.5
radians while fading against the **uncapped** component scale. Its geometry
therefore ended while its emitted light was still bright. Center-only
front-plane rejection and affine billboard coordinates added near/off-axis
failure modes. This was independent of gravity or the galaxy's physical size.

## Rendering change

Every external population entry uses the same deterministic structure path:
measured Local Volume/2MRS galaxies and the labeled statistical completion.
Small sources retain the inexpensive PSF/profile path. One shared 64 KiB
scalar noise texture keeps the detail shader compact; it is not a galaxy
image and is not replaced at zoom. Larger sources retain
intrinsic-coordinate spiral branches, patchy dust, unresolved star-forming
associations and color variation, filtered by each pixel's footprint. Irregular
systems use asymmetric complexes; spheroids stay smooth rather than gaining
spiral arms. Existing catalog morphology, orientation, size, color and
luminosity are the inputs. These are modeled details, not source images or
new observational data.

Uncapped conservative screen rectangles replace close rotated billboards.
A galaxy whose support crosses the observer plane covers the viewport, then
its forward-ray light decides which pixels are visible. Its center may leave
the screen or pass behind the observer without erasing visible material.
The existing far-tier group owns each source once; center distance cannot
erase its emitting material around an observer, and depth testing still lets
foreground objects cover it. A support overlap does not draw it twice. Nearby non-Local-Group chunks switch to quads before the hardware point
limit, using the same 8-scale-length support and a conservative apparent
light-cone distance.

When angular scale length grows from .025 to .065 radians, the profile blends
to an analytic finite-thickness model: six positive oblate Gaussian components
approximate the existing exponential surface-density law. Each forward
half-ray is integrated with an error function. There is no marching loop,
ray/plane singularity or random frame noise. The analytic first moment locates
modeled structure ahead of observers inside the source. The fit's smooth
integrated luminosity is within 0.003% of the reference; center peak is 2.6%
lower and the radial profile from 0.1–4.5 scale lengths is within 1.3%. The
outer display taper is extended to 6–8 scale lengths so an arbitrary rectangle
does not truncate bright light. This restores some formerly discarded light.

## Boundaries

- This is an illustrative emissivity/dust model, not resolved star catalogs,
  radiative-transfer reconstruction or external-galaxy N-body dynamics
- Catalog luminosity, cosmic evolution, light-cone positions/redshift,
  Andromeda's merger trajectory, tidal light budgets, gravity and the gravity
  inspector are unchanged
- Smooth component normalization is tested independently. The procedural dust,
  associations, taper, display stretch and tone mapping do not claim exact
  integrated observed-flux conservation
- Dust attenuates this galaxy's emitted appearance; it is not foreground
  extinction of unrelated catalog galaxies
- Nearby quads cost more per covered fragment; point sources bypass detail.
  Software-rendered browser measurements are not phone hardware benchmarks

## Verification

`node scripts/smoke-external-galaxy-geometry.mjs` independently integrates the
3-D mixture numerically, checks inside/edge/far/scale behavior and tests over
150,000 projected sphere samples against the conservative bounds.

The dedicated workflow captures exact base/head source revisions using one
unchanged full-app harness on desktop and mobile. Raw frames and target-only
diagnostics retain the live production material, attributes and uniforms.
The target diagnostic makes clipping and center-behind errors visible without
other galaxies masking them. See its generated reports for omissions, poses,
exposure, assertions, timings and source revisions. Screenshots must be
reviewed before this draft is called visually complete.

### Browser-driven performance revision

The first full-browser run spent minutes in whole-frame readback. The initial
6–7 ms `gl.finish` measurements did not include that pending work and must not
be presented as frame performance. Phase instrumentation separated app
readback from the fast single-source diagnostic. The conservative support
fallback had allowed tiny, entirely off-screen galaxies near the eye plane to
cover the whole viewport. Four side-frustum-plane sphere tests now reject
these sources before fullscreen fallback. The compact shared noise field and
empty-fragment fast paths also reduce work without changing zoom identity.

The watchdog is unchanged. Successful complete browser captures, actual
readback timing and exact-head CI remain required acceptance evidence.

### Independent-review edge cases

Ray reconstruction now uses the draw-time projection matrix through a vertex
varying, including asymmetric/per-eye projections. The background population's
far-tier group owns its light even at its exact center; physical center depth
cannot reject an entire surrounding galaxy. Raster support includes the whole
near model whenever that blend is nonzero, independent of the far-profile
minor-axis detail gate. Tests include exact/near centers and an asymmetric
per-draw projection diagnostic; this is not a physical-headset certification.

The exposure meter uses visible extended support even when a galaxy's center
is behind the camera or coincident with it. Nearby non-Local-Group sources
also bypass the coarse population sampling stride, at their current apparent
positions. A squared-distance bound limits extra work. The regression suite
checks bounded near-view gain against the same target's normal-view exposure;
visibility alone is not acceptance if a source becomes washed out.
