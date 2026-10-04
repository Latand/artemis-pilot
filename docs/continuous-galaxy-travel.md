# Continuous Andromeda travel: first vertical slice of #46

This change is **partial #46**. It must not close #46, #20, #18 or the mutual-gravity work in #45.

## Controls and ownership

In Explore, **Approach Andromeda** re-aims the camera without changing its position and uses the existing smooth zoom controller to move toward a disk location 10 kpc from M31's center. It is accelerated camera navigation, not a spacecraft propulsion or travel-time simulation. **Stop approach**, wheel zoom and WASD interrupt it. The ordinary camera/ship, focus and simulation clock remain separate. **Return toward the Milky Way** uses the same controller. There is no hidden scene change, distant-camera teleport or tour-only population.

Both a free camera and the physical ship discover the same M31 provider at their own positions. Camera discovery does not replace the ship's active gravitational neighbourhood. A visible point's `gx:m31:<universe seed>:<birth cell>:<star index>` identity resolves through the existing procedural-focus, photosphere, generated-system, planet and moon paths. Existing MW and real-catalog IDs are unchanged.

## Coordinates, time and persistence

The registry uses the existing measured M31 direction/distance, disk orientation and reduced MW–M31 trajectory. Galaxy-local coordinates are float64. GPU star buffers receive observer-relative residuals. Host and planet orbital offsets stay separate through surface model-view subtraction so an intergalactic coordinate cannot erase a planet-sized offset.

M31's first local population follows a prescribed 250 Myr rigid disk rotation at the common coordinate clock. It is a bounded deterministic illustration, **not differential disk dynamics or mutual stellar gravity**. Stars do not reseed when a camera changes scale or crosses a time bucket. The distant diffuse galaxy renderer retains its established past-light-cone convention; local physical stars use coordinate-time locations, matching the existing local-star convention. No claim of a fully solved stellar light cone is made.

Generated planet parameters and surface identities are the existing deterministic per-host generator. Sparse, timestamped velocity-impulse residuals have a versioned journal/checkpoint hook and quicksave restoration. This hook is a piecewise-linear perturbation of the prescribed trajectory; it does not implement gravitational backreaction. There is no new intervention UI in this slice. The journal is limited to 4,096 events across at most 64 edited stars and rejects overflow rather than silently losing history.

## Exposure and scope

The default bounded-travel exposure limits the external-galaxy exposure target to eight times the reference exposure and disables the faint-field asinh stretch. It leaves the full catalog and physical flux calculation in place, so empty intergalactic sky is not automatically raised into a bright cosmic-web visualization. **Exposure: deep-sky overview** explicitly selects the existing high-gain photographic overview. These are display choices, not claims that a naked eye and a telescope have the same exposure. Cosmic scale shortcuts still exist as intentional overview controls.

The existing diffuse M31 model remains the large-scale envelope. This slice does not replace it with a new self-consistent resolved/unresolved luminosity partition or reconstruct every other catalog galaxy's stars. Other galaxy providers, material differential dynamics and light-cone detail are future work.

## Budgets and verification

An ordinary query touches at most 125 birth cells, 80 candidate stars per cell, and returns at most 420 stars. Up to 64 edited-star exceptions are materialized once per journal revision and remain discoverable even after ejection outside the disk. These exception records are bounded independently. The LRU caches hold at most 256 cells and 2,048 star records; GPU capacity is fixed at 420. Promotion removes the identical star from the separate camera point layer before the active point/photosphere path draws it. Physical gravity retains the existing 64-source cap; it is not a mutual interaction island.

`npm run smoke:galaxy-travel` checks registry orientation/distance, stable IDs and system parameters under time reversal and cache eviction, exact-clock publication, independent ship discovery, bounded memory, seed separation and journal/save-shaped replay. `npm run verify:galaxy-travel` runs the real UI controls and captures departure, intergalactic transit, M31 entry, manual free flight, point selection, photosphere, planet, return and quickload. The latter reports production-frame CPU times and records a video. Hardware performance and the target of no transition stall over 50 ms require measured final-revision evidence; compilation stalls are not disguised by raising that threshold.

## Next acceptance milestone

A separate bounded mutual-interaction island should select at most 64 masses by physical influence, including offscreen neighbours; apply deterministic symmetric pair forces once per step; and persist checkpoints/residuals across island entry/exit. Tests must bound energy/momentum drift and prove no double counting with the prescribed host potential. This change does not simulate all stars in advance.

## First hosted route result and pending acceptance

Exact head `219e9a62` passed the real-control route and retained the same M31 star and planet across return/quickload at coordinate time 6 s. The images showed the requested dark intergalactic sky. Visual review also found legacy Solar/MW guide labels leaking into M31 views; those labels now use observer-to-source reach rather than camera-target zoom. The inherited Moon-beacon return triangle required the #55 foundation repair.

The software-rendered capture did **not** meet the absolute 50 ms transition target: median submitted-frame wall time was 1.91 s, p95 3.75 s, and the largest post-startup frame was 16.71 s during stellar approach. These values include browser/driver blocking, not just JavaScript compute. Do not call this smooth-device-performance evidence.

`benchmark-galaxy-travel.mjs` is a paired diagnostic, not an acceptance substitute. The current main integration pins baseline `3a51477c9b17aaf275bb58b84b16c5b1f14ae2c6` after the catalog/radiance merge. The earlier `b6b89726` evidence used `09863eed` and retains that original attribution. The diagnostic uses the same software browser/viewport and fixed galaxy-quality setting on both exact source trees, replays six observer views from the successful route in predeclared ABBA/BAAB order and asserts identical broad camera matrices for every timed sample. A separate native-W controller trace reports positional/pixel divergence, because the precision fix intentionally changes free movement at M31 planet scale. Baseline lacks foreign targets and surfaces, so this is matched camera workload, not identical object content. Both cold and warm samples, stage timings, completion readback, and hardware timer support are retained. GPU queries are collected in later browser tasks; unsupported, disjoint and unresolved queries remain explicit. Absolute target failure is reported independently of the relative ratio. The functional route also records per-frame discovery/render stages to locate its expensive transitions.


## Integrated foundation and final diagnostic limits

The later exact `4c92bdcb` route passed its functional assertions. All 12 screenshots were inspected individually: the leaked Solar/MW labels were gone, and the same generated host/planet survived manual movement, return and quickload. The old Moon-beacon triangle still appeared on Milky Way return. The local integration now includes #55's cleanup and asserts that beacon is hidden on return; the integrated pixels remain to be recaptured.

The paired `4c92bdcb` / `1a8e3af` diagnostic matched all broad camera poses and resolved all 768 GPU queries. Warm submission p95 was 17.6 ms on both; warm GPU p95 was 7,394.6 / 7,441.6 ms (candidate/base ratio 1.006354), and warm completion p95 was 7,404.3 / 7,451.5 ms (1.006375). Every completed frame exceeded 50 ms. This is evidence about shared SwiftShader cost, not realistic-device frame rate. The baseline lacks the new foreign objects and both exact source trees predate this integration.

With per-frame readback draining, the real route's largest post-startup submission was 244.3 ms on quickload: 136.4 ms in the render call, 82.3 ms in the focus stage, and 8.0 ms in the foreign field. Foreign-field maximum across that route was 22.9 ms. Drained timing changes queue pacing; it must not be presented as a speedup over the earlier unprofiled 16.71 s sample.

A local real-catalog CPU profile traced most repeated focus-refresh cost to canonical alias normalization. A WeakMap now caches only the derived curated identity keys, guarded by name/HIP/HD/HR values; identity precedence, epoch fallback and mutable aliases stay unchanged. In 50 local restore replays, refresh median/p95 changed from 18.7/34.0 ms before the cache to 6.7/10.9 ms after it. These CPU-only results do not certify the render-call spike or the hosted performance target. The next capture records separate retained-star-follow and active-refresh stages.

The integrated Jupiter excursion now captures and restores the foreign exploration host, exact split camera residual and intervention journal. Journal event sequences survive restore independently of render-cache revisions. Seed cleanup participates in the shared structural source revision, and the pooled-point regression covers both retained HYG ownership and exact foreign-time/same-clock journal publication. The existing motion exposure argument remains on the system-render call after current-camera placement.

## Main integration and evidence boundary

The main integration preserves actual travel head `b6b89726381261e58336a1c9ea611d87b5e48742` and actual main `3a51477c9b17aaf275bb58b84b16c5b1f14ae2c6` as parents. Main's tree is `9612897732b3edc2baa16eeb211fc7da6c7753c9`. The merge is conflict-free. All 21 incoming files match main exactly; the only incoming production changes are `src/river.js` and the new `src/riverRadianceMath.js`. The travel, identity, journal, split-camera and surface source remains unchanged. The travel workflow's baseline pin and this document are the only additional integration edits.

The earlier 18 successful travel-head workflows establish results for `b6b89726`, not this new combined tree. In particular, river pixels now include main's reviewed source-density display compensation. Its field, source publication and advection paths retain their accepted code, but final-head catalog/river coherence and travel return captures must still run. The explored-system workload must compare against actual current main, including the existing one-roundtrip label warmup and all 20 subsequent strict no-growth checks.

Main's authenticated radiance timing can transfer only to identical production inputs. Travel changes those inputs, so the unchanged acceptance verifier correctly rejects transfer; its historical six-view results are not final travel performance evidence. A new measurement using the original strict protocol is required before claiming radiance performance for this tree. The absolute 50 ms travel target and the earlier per-fixture submission regressions remain unresolved until new measurements say otherwise. No physical-device frame-rate claim follows from hosted SwiftShader results.
