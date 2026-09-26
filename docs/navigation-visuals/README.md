# Flight history, external galaxies and compact screens

Continuation of merged PR #11. Comparison base: `5a7a88b25ebb0319e7c6d2d8da4dddcdf7268e15`.

The three reported problems are addressed in their actual rendering/UI paths, not by editing screenshots. This pass does not replace the Milky Way model or change the prescribed galaxy encounter, galaxy catalog identities or stellar-evolution tables. Detailed photographic reconstruction of arbitrary galaxies is **not** delivered: the new external-galaxy substructure is modeled, and the late merger remains visibly soft.

## Flight history

The original history connected widely separated samples after deep-time steps, producing the reported heliocentric spirograph. It also retained thousands of old samples without a per-segment age fade. Updating the last stored point instead of preserving an anchor could lose accumulated slow motion.

`RecentPath` keeps committed samples in a float64 ring and uploads independent, origin-relative line segments with fading endpoint opacity. Capacities are 768 recent samples and 256 journey samples, replacing 8,000 and 6,000. The two GPU attribute allocations total 57,344 bytes, versus 336,000 bytes for the previous position/color arrays; these figures exclude objects and other geometry.

History expires at the earlier of 24 active display-clock seconds or 1.15 locally estimated orbital periods, also bounded by ring capacity. Pausing freezes the display clock. A simulation jump larger than 1/48 of the local period, rewind, epoch replacement or position discontinuity resets the segment; it is not connected by a fictitious chord. The display path also checks epochs while paused, when no new motion sample arrives. High time warp clears sampled history rather than drawing an aliased orbit. Analytic body-orbit guides and the existing future-coast prediction are separate and remain intact.

Explore hides flight history by default. Pilot retains a recent fading path. `?trails=1` explicitly allows the path in Explore; `?trails=0` disables it. These parameters do not disable the physics or move the ship.

## External galaxies

`galaxyPopulationRender.js` previously supplied smooth disk/bulge or spheroid profiles with a simple edge-on dust lane. The population outside the Local Group could additionally be limited by the maximum GL point size when approached.

`galaxyMorphology.js` adds deterministic galaxy-local spiral ridges, adjacent dust modulation, broad star-forming complexes and type-dependent colors. Irregular and spheroidal types are not all forced into spiral shapes. A stable catalog-id seed and galaxy basis define the pattern, rather than screen coordinates or camera speed. Analytic footprint filtering removes unresolved harmonics. The Fourier modulation has unit angular mean before extinction, redistributing the annular light rather than introducing another stellar population. Color factors have unit luminance. Existing luminosity and resolved/unresolved bookkeeping are retained.

Chunks switch to instanced quads when their projected extent would exceed the point-size representation, with hysteresis on the return transition. Fine structure fades by projected resolution and inclination. This is a compact projected model, not a full volumetric reconstruction allowing resolved-star travel inside every catalog galaxy. The arm textures remain fairly smooth at high magnification.

## Merger rendering and white overlap

The existing simulation still supplies the same 6,144 particles and encounter trajectory. A fixed, same-host neighbor graph is built in the worker, then used to align and stretch light kernels with the deformation of nearby simulated particles. The stretch is bounded to 1–2.5. Worker transfer includes the existing simulation fields plus this graph.

Two nonlinear-compositing problems were isolated. Stretching/tone-mapping each small debris contribution before adding it made the result depend on how the light was partitioned among particles. Adding individually display-encoded overlapping galaxy cores also clipped them to white.

`LinearTidalPass` sums debris radiance before its display stretch. For a direct-rendered merger, `renderLinearFrame` combines the scene's linear contributions in a half-float target before one final ACES/sRGB transform. An already active composer target is not wrapped in another display transform. Renderer state is restored on both normal completion and exceptions, and foreground occlusion remains tested.

The extra memory is explicit: the debris color target is capped at 1,048,576 pixels (8 MiB). The direct-frame color target follows the viewport at 8 bytes per pixel, plus its depth attachment; it is **not** covered by the debris cap. At the tested 800×500 viewport, each color target accounts for 3,200,000 bytes. This is a memory/per-pass cost, not a free sharpening effect.

The late 13.6-Gyr close view still has smooth bright cores and a broad envelope. No gas hydrodynamics, resolved tidal stars or observationally calibrated dust reconstruction is claimed. The encounter times are states of the project's scenario, not a new prediction of the real Milky Way–Andromeda future. The separate headset XR path still uses its existing renderer and is not certified by these tests.

## Compact UI

`compactExplorer` reuses the live object facts, time controller, search, events and movement actions instead of creating duplicate controllers. Details, movement buttons and time settings open on demand. The compact closed state leaves the scene visible, while pause/play and time stepping remain directly available.

The layout uses safe-area insets, measured toolbar/time-dock sizes and visual-viewport height. Portrait and short coarse-pointer landscape are handled separately. Toggles expose `aria-expanded`; Escape closes them and restores the trigger's focus. Changing modes or opening search/events collapses the temporary controls and stops held movement.

Browser scenarios cover 390×844, 320×568, 500×850 and 844×390 at DPR 1. Portrait checks require at least 30% uninterrupted vertical scene between the closed panels. Interaction checks include facts access, time selection, pause, movement that changes the camera but not the ship, two unobstructed canvas contacts and a delivered two-finger pinch. These are Chromium touch-emulation tests, not physical iPhone/Safari certification.

## Tests and evidence

The PR links the exact tested head and completed Actions runs. `navigation-{render,mobile,merger}-{before,after}` artifacts contain native PNGs, JSON reports, head/base SHAs and a dependency snapshot. Retention is 14 days; the source-only recovery bundle is retained for three days. Capture scripts stay in the repository.

The numerical suite covers bounded/fading history, jumps, rewind, epochs, slow-motion sampling, float64 origin subtraction, stable galaxy seeds, projected LOD hysteresis, annular light normalization and tidal-neighbor deformation. The navigation browser suite checks actual production shaders and adapters, including the paused epoch reset. Historical defects are recorded only for the baseline; the new version must pass its assertions.

The linear-radiance fixtures explicitly compare one source against equivalent split sources, rather than checking only that a screenshot is nonblack. The direct-frame fixture previously measured encoded overlap at RGB 255 versus the correct RGB 227; the new linear sum agrees with the single source at RGB 227. This is a test fixture, not an astronomical brightness measurement.

The independent Milky Way comparison still checks all 14 required views, matching camera/projection/epoch, dependency locks and complete reference shards. The original PR11 improvement-only gate incorrectly rejected an unchanged renderer. It now accepts either strict moving-error improvement or **every before/after RGB pixel being identical across all 14 views**. Equal aggregate error alone does not qualify. Existing static/temporal bounds remain, seven acceptance-policy unit tests exercise rejection paths, and `--require-improvement` retains the original strict experiment.

### Reproduce

```sh
npm install
npx playwright install --with-deps chromium
npm test
node scripts/smoke-navigation-visuals.mjs
npm run smoke:merger-tides
npm run smoke:merger
npm run smoke:galaxy-population
npm run smoke:galaxy-model
npm run smoke:brightness
npm run smoke:determinism
npm run build
node scripts/review-navigation.mjs . evidence/render
node scripts/verify-linear-frame.mjs . evidence/linear-frame
SUITE=mobile node scripts/review-compact-and-merger.mjs . evidence/mobile
SUITE=merger node scripts/review-compact-and-merger.mjs . evidence/merger
```

The Actions workflow runs the same capture harness against separate head/base roots. The merger harness fixes exposure at 0.35 and records camera, time, projection, dimensions and DPR. The sidebar comparison uses identical recorded view states with the river overlay off.

To check the downloaded artifacts and assemble native before/after panels:

```sh
python -m pip install numpy Pillow
# Unzip each navigation-*-before/after artifact into its same-named folder.
python docs/navigation-visuals/review.py evidence/artifacts evidence/review
```

The review script rejects mixed source revisions, different dependency locks, missing views and mismatched recorded states. It also produces a six-frame trajectory-expiration GIF. Its time labels indicate simulated age with no new samples; playback timing is illustrative, not measured FPS. No resizing, exposure fitting or sharpening is used in the PNG comparisons.

All browser evidence is from Chromium/ANGLE Vulkan SwiftShader on Linux. No interactive frame-rate or physical-GPU speedup claim is made. Native hardware profiling, mobile Safari, volumetric external-galaxy interiors and a substantially finer late-merger appearance remain further work.
