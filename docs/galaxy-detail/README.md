# Milky Way dust detail: PR #11

This pass follows merged PR #10 (`d2ade2937d56f098911e80860462af9b4f404595`). The runtime change is in `src/universe/galaxyModel.js`; render-target sizes, exposure, the stellar populations and the galaxy's spatial seeds are unchanged.

## Diagnosis and implementation

The dust cascade already contains modeled structure below the 46.875 pc structure-map texel. Its old filter used one width for both the projected pixel footprint and the integration segment. A long segment therefore suppressed detail in *both* directions, including transverse structure the screen could resolve. In the translating-camera draft, this removed much of the dust contrast before the output texture was even sampled.

`gdDustSegment` now divides that segment into three equal intervals and samples density at their midpoints. Each sample retains the pixel-footprint filter and uses the shorter longitudinal filter. The result is the arithmetic mean of densities, not a mean of log-density or transmission. A smooth weight transitions to the old single sample when the pixel footprint dominates or the segment is already small. This is bounded quadrature: three evaluations at full weight, at most four during the blend. It is not a sharpening pass, a negative mip bias, new random speckles or a new panorama.

The coordinates remain in the common rotating galactocentric pattern frame. Translated views still integrate fresh rays and reject angular history. The old light-fraction tables, resolved star identities, emission coefficients, extinction coefficients and large-scale maps are unchanged. The new integration can change *attenuated* brightness because it retains more of the existing dust variation; this is not an exposure adjustment.

## Verification

The tested runtime and harness commit is `3e4eb703bdb790f205fad51f79a608ef0f8fc36c`. Later files in this directory document those results and do not alter the renderer.

- [Model/build and full-application regressions](https://github.com/Latand/artemis-pilot/actions/runs/36168978765): model/build plus before/after isolated renderer and application jobs.
- [Dust-detail comparison](https://github.com/Latand/artemis-pilot/actions/runs/36168978754): before, after, three finer-midpoint reference shards, and automated image comparison.

The new probe records 14 images per variant: four settled sky views, a motion-start frame, eight consecutive translating-camera frames and an exact return. It uses the production volume and renderer at 480×300, DPR 1, epoch zero and fixed diffuse exposure 0.15. The moving production draft is 240×150; settled production and reference images are 480×300. Comparison frames have identical camera transforms, projection and exposure. No image is exposure-normalized or sharpened.

The expensive reference is split into static, early-motion and late-motion jobs. Each starts from the same frozen observer; their shared anchor image must match pixel-for-pixel, and their union must cover all 14 requested frames. Incomplete reports are rejected. An earlier unsplit run reached the CI time limit; sharding changes the workload distribution, not reference precision.

The reference uses the **old midpoint estimator**, with the new segment quadrature disabled, a 0.006 fractional ray step and a 1600-step ceiling. It is more expensive numerical sampling of the same field, not measured astronomical ground truth or a proof of convergence at every resolution.

Nine analytic fixtures execute the actual production `gdDustSegment` GLSL with known density fields: constant and linear density, quadratic midpoint weights, reversal of the segment, disabled quadrature, pixel minification, periodic mean and both LOD-blend boundaries. These complement the full rendered comparisons; the shader is not rewritten in JavaScript for the test.

Separate full-application captures include Earth, Earth orbit, Moon approach/recession, Solar System/outer-system views, FOV-only zoom, return to Earth and the river overlay. All nine paired captures were checked for identical camera, time, focus, overlay state, DPR and dimensions. Foreground bodies continue to occlude the sky. The previous startup, resize/DPR, renderer-state, composer/bloom and worker-failure assertions also pass.

## Measured results

All three image-acceptance checks pass in CI and in the independently rerun local analyser. Metrics use encoded display values on the 0-255 scale, not physical radiance.

| View | Luma RMSE before | Luma RMSE after | High-pass correlation before -> after |
| --- | ---: | ---: | ---: |
| gc-wide | 6.8623 | 3.8954 | 0.5192 -> 0.8754 |
| gc-zoom | 7.9012 | 5.0192 | 0.3870 -> 0.6435 |
| cygnus | 1.8859 | 0.8242 | 0.6421 -> 0.8811 |
| external | 0.1396 | 0.1396 | 0.9991 -> 0.9991 |

Across all eight translating frames, mean luma RMSE falls from **11.3703 to 7.2937 (35.85%)**. Temporal residual RMS (frame-to-frame error changes after subtracting the reference's actual view change) falls from **0.8271 to 0.8233**. This is not a universal quality score: it is a diagnostic for this fixed series. The whole-galaxy production images are pixel-identical before and after. Exact return-to-pose remains reproducible. All three reference shards' shared anchor PNGs are pixel-identical.

Native PNGs show finer dark-cloud edges and smaller coherent dust structures, including during translation. The full-application FOV zoom shows the same improvement with the existing stars and foreground geometry in place. The new moving draft remains visibly softer than the settled and finer-reference views; it does not establish the full fidelity target by itself.

### Timing and resources

The measured renderer was **Chromium 153 / ANGLE Vulkan SwiftShader (Subzero), Linux**, 480x300, DPR 1, with adaptive budgets held at 1 for reproducibility. Eight moving frames per production variant were measured:

| Draw + blocking pixel readback + statistics | Before | After |
| --- | ---: | ---: |
| P50 | 3464.1 ms | 3409.5 ms |
| P95 / maximum (n=8) | 3504.5 ms | 3477.4 ms |
| Frames over 50 ms | 8 / 8 | 8 / 8 |

These are software-rendered wall times from separate Actions virtual machines, **not hardware GPU times, interactive FPS or evidence of a speedup**. PNG encoding is excluded; readback and the pixel-statistics loop are included. `gl.finish` alone returned much earlier than blocking readback in this browser, so its roughly millisecond-scale numbers are explicitly not presented as completed rendering cost. The timer extension is exposed but GPU timer queries were not collected. Recorded refinement latency is polling/scheduling latency and includes 60 ms polling delays; GPU-complete refinement latency remains unmeasured.

Volume render-target residency remains **2,976,000 bytes** for the inside views and **3,840,000 bytes** for the external view in both variants. This excludes shared structure maps and driver allocations. The change adds no textures or render targets and leaves the existing residency caps intact. It adds bounded dust arithmetic (three density samples at full blend, four in transition), whose cost still needs profiling on physical desktop/mobile GPUs.

## Reproduce

From a checkout of the tested PR head:

```sh
npm install
npx playwright install --with-deps chromium
git worktree add --detach /tmp/artemis-detail-base d2ade2937d56f098911e80860462af9b4f404595
ln -s "$PWD/node_modules" /tmp/artemis-detail-base/node_modules
VARIANT=before node scripts/measure-galaxy-detail.mjs /tmp/artemis-detail-base evidence/before/detail
VARIANT=after node scripts/measure-galaxy-detail.mjs . evidence/after/detail
for shard in static early late; do
  VARIANT=reference REFERENCE_SHARD="$shard" node scripts/measure-galaxy-detail.mjs . "evidence/galaxy-detail-reference-$shard/detail"
done
for variant in before after galaxy-detail-reference-static galaxy-detail-reference-early galaxy-detail-reference-late; do
  mkdir -p "evidence/$variant/sources"
  git rev-parse HEAD > "evidence/$variant/sources/head-sha.txt"
  printf '%s\n' d2ade2937d56f098911e80860462af9b4f404595 > "evidence/$variant/sources/base-sha.txt"
  cp package-lock.json "evidence/$variant/sources/"
done
```

The Actions artifacts also include `sources/head-sha.txt`, `sources/base-sha.txt` and the dependency lock. Download/extract the five capture artifacts (`galaxy-detail-before`, `galaxy-detail-after`, and `galaxy-detail-reference-{static,early,late}`), then run:

```sh
python -m pip install numpy scipy Pillow
python docs/galaxy-detail/analyze.py BEFORE AFTER REFERENCE OUTPUT --check
```

`BEFORE` and `AFTER` are extracted artifact roots. `REFERENCE` is the parent directory containing all three extracted `galaxy-detail-reference-*` directories. The workflow runs this comparison automatically and uploads `galaxy-detail-comparison` with JSON, PNGs and GIF. The analyser rejects partial captures and mismatched shard anchors, checks poses and dependency locks, writes all-frame metrics, native comparisons and an eight-frame motion GIF. With `--check`, mean moving-frame luma RMSE must improve, no static view may exceed its baseline RMSE by more than 5% plus 0.02 display units, and temporal residual RMS may not increase by more than 10% plus 0.002 units. These criteria are image-specific, not universal perceptual scores. GIF playback is 220 ms/frame for inspection, not a recording of interactive frame rate. These are optional analysis dependencies, not runtime dependencies. Actions artifact retention is 14 days.

## Scope and remaining limits

This improves rendering of the existing modeled fine field; it does not add a measured 3D dust reconstruction. The complete perceptual “8K” target, observational colour/brightness calibration, hardware GPU performance, mobile Safari and the separate headset XR path remain unverified. A translating draft still has lower output resolution than a settled view. Wider integration segments still remove unresolved detail; three midpoint samples are not exact volume integration.

The observational references remain [Gaia EDR3 all-sky brightness/colour](https://www.esa.int/ESA_Multimedia/Images/2020/12/Interactive_map_of_the_sky_from_Gaia_s_Early_Data_Release_3) and [ESO/S. Brunier's Milky Way panorama](https://www.eso.org/public/images/eso0932a/). They are Solar-neighbourhood views, not maps to paste into arbitrary galactic viewpoints. ESA identifies equirectangular and Hammer versions and credits ESA/Gaia/DPAC, CC BY-SA 3.0 IGO, acknowledgement A. Moitinho. ESO's public image is 6000×3000; the advertised 800-million-pixel original is not provided there for copyright reasons. No reference image assets are redistributed by this PR. This pass changes sampling, not a calibration against those images.
