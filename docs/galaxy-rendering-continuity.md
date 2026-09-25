# Milky Way rendering continuity

## Baseline and reproduced failure

The comparison base is `549079a18c348efdac8e303c5156129d2f08bd4a`. The user's screenshots do not establish a deployed commit, so the captures in this change reproduce the repository baseline, not an assumed deployment.

The existing sky is a ray-integrated volume, not a static skybox. Its shared density maps, dust model, resolved stellar populations and inside/outside galaxy model remain in place.

A reproducible blackout was found in render-target resizing. After a completed frame, `setSize(800, 500)` resized the previously valid 640x400 view's attachments, but did not mark the draft dirty. The next composite sampled an empty draft. A same-aspect resize, with no camera movement, produced a completely black framebuffer. After invalidation was corrected, the first resized frame had nonzero coverage throughout the image. At the original fixed view, before/after screenshots were byte-identical; this is not a different galaxy substituted to hide the failure.

Other inspected contributors were quarter-resolution moving drafts, removal of fine octaves during motion, missing coverage while worker maps were unavailable, nominal-FOV ray construction, and incomplete restoration of renderer state around background subpasses. Foreground-disk exposure metering could also dim the shared sky deliberately; that is distinct from an empty render target.

## Implementation

`galaxyVolume.js` invalidates draft and refinement work on output, DPR and target-size changes. It derives the observer from the camera's world matrix, including a parent transform, and derives rays from the projection matrix, including camera zoom and asymmetric projections. Model changes, moving solar anchors and resolved-magnitude changes invalidate the relevant work.

Moving drafts keep the same fine-detail model as settled frames. Projected pixel and integration-step footprints decide which frequencies are resolved. Inside the galaxy, the nominal moving scale changes from 0.25 to 0.5, subject to the quality budget. Desktop and mobile full-target residency are capped at 4.2 and 1.2 million pixels respectively; this is not a mandatory monolithic 8K render target.

A completed view may supply angular radiance to a subsequent rotation. The cache stores observer position, galaxy state, ray transform, projection, exposure-independent gain and angular resolution. Its mipmapped radiance is reprojected by direction, with uncovered/behind-camera rays rejected. Translation and model changes reject this history; there is no fabricated single depth for an extended volume. Full refinements always integrate fresh rays, so resampled history is not recursively baked back into itself. The tradeoff is explicit: a continuously translating camera uses fresh, more expensive drafts, not a stale sharp image.

`galaxy-preview-plugin.mjs` computes a 32x32 preview from actual mip levels of the canonical 1024x1024 model at build time. It preserves that model's seed and normalization. The browser can therefore render a coarse shared-model galaxy immediately, without a separate panorama or a blocking map build. Full worker results replace coarse density progressively before integration. Worker creation, message errors and a 30-second timeout retain the coarse model instead of erasing the sky.

Background subpasses preserve the current render target, cube face/mip, viewport, scissor, `autoClear` and XR enabled flag, including failure cleanup. This is a state-preservation safeguard, not a claim of headset validation.

## Display interpretation

The default is explicitly an astronomical-camera sky: approaching a sunlit foreground body does not meter the stars and diffuse galaxy down as though the whole scene shared the foreground exposure. `?skyexposure=adaptive` retains the previous foreground-metered interpretation. The physical population and luminosity tables are not rewritten.

`?galexposure=0.15` fixes the diffuse-volume display exposure for diagnosis. It is not a physical instrument calibration or a global override of all post-processing. The comparison harness fixes the same shared sky exposure in both revisions, so changing exposure cannot hide missing structure.

No external photographs or new astronomical datasets are used as runtime textures. The existing statistical sub-map dust and star-forming structure remains a model, not a measured reconstruction of individual clouds. The blue spacetime-river visualization is a separate feature; it is not removed or relabeled as stars.

## Reproduction and evidence

Install the repository's dependencies, then run:

```sh
node scripts/smoke-galaxy-continuity.mjs
npm test
npm run smoke:galaxy-model
npm run smoke:galaxy-population
npm run smoke:brightness
npm run smoke:scaleladder
npm run smoke:determinism
npm run build
npx playwright install --with-deps chromium
node scripts/verify-galaxy-rendering.mjs . evidence/galaxy/after
node scripts/capture-galaxy-app-routes.mjs . evidence/galaxy/app-after
```

The GitHub workflow checks out both exact revisions and runs the same capture script against them. `BASELINE=1` records explicitly named historical failures; unexpected failures still fail the comparison. The artifact `galaxy-rendering-evidence` contains source revision identifiers, the implementation diff, dependency versions, PNGs and JSON reports. The script records delayed startup, same-aspect resize, a 16-frame rotation sequence, return to pose, a render-origin rebase, translation/model-history rejection, direct and tiered rendering, opaque foreground occlusion, composer/bloom, galactic travel and DPR changes. A separately injected worker failure checks coarse coverage.

The volume capture is deliberately isolated from the catalog and UI to make pixel comparisons meaningful. A foreground sphere tests actual depth-tier occlusion; it is not presented as an Earth/Moon travel test. Full-application route captures are separate evidence: near Earth, orbiting Earth, approaching/receding from the Moon, Solar System and outer-system views, FOV zoom at a stationary observer, return to Earth, and the river overlay enabled. These preserve the real foreground and stellar layers; their images require visual review rather than inferring sky continuity from whole-frame mean brightness.

Timing values are synchronous JavaScript rendering plus `gl.finish()` wall time, excluding PNG encoding and pixel analysis. The report identifies the actual renderer and browser. SwiftShader measurements are not hardware GPU timings or a frame-rate guarantee. `targetBytes` measures this volume's render targets, not total application memory or total driver allocation.

## Limits of this pass

The historical disappearance is reproduced and corrected. Moving-view structure is preserved using the existing shared model rather than an unrelated sharper wallpaper. This does not certify an 8K perceptual-quality target, a reconstruction calibrated to Gaia/ESO imagery, or acceptable performance on every device. Hardware profiling, mobile Safari and headset rendering remain separate acceptance work. The existing raw XR dispatch bypasses the desktop background hook and is not repaired by the state-restoration guard alone. Extremely fast translating views still trade resolution against integration cost. Quantitative photometric calibration across every output size and every post-processing combination is not claimed.
