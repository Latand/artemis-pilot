# Continuous Andromeda travel: first vertical slice of #46

This change is **partial #46**. It must not close #46, #20, #18 or the mutual-gravity work in #45.

## Controls and ownership

In Explore, **Approach Andromeda** re-aims the camera without changing its position and uses the existing smooth zoom controller to move toward a disk location 10 kpc from M31's center. It is accelerated camera navigation, not a spacecraft propulsion or travel-time simulation. **Stop approach**, wheel zoom and WASD interrupt it. The ordinary camera/ship, focus and simulation clock remain separate. **Return toward the Milky Way** uses the same controller. There is no hidden scene change, distant-camera teleport or tour-only population.

Both a free camera and the physical ship discover the same M31 provider at their own positions. Camera discovery does not replace the ship's active gravitational neighbourhood. A visible point's `gx:m31:<universe seed>:<birth cell>:<star index>` identity resolves through the existing procedural-focus, photosphere, generated-system, planet and moon paths. Existing MW and real-catalog IDs are unchanged.

## Coordinates, time and persistence

The registry uses the existing measured M31 direction/distance, disk orientation and reduced MW–M31 trajectory. Galaxy-local coordinates are float64. GPU star buffers receive observer-relative residuals. Host and planet orbital offsets stay separate through surface model-view subtraction so an intergalactic coordinate cannot erase a planet-sized offset.

M31's first local population follows a prescribed 250 Myr rigid disk rotation at the common coordinate clock. It is a bounded deterministic illustration, **not differential disk dynamics or mutual stellar gravity**. Stars do not reseed when a camera changes scale or crosses a time bucket. The distant diffuse galaxy renderer retains its established past-light-cone convention; local physical stars use coordinate-time locations, matching the existing local-star convention. No claim of a fully solved stellar light cone is made.

Generated planet parameters and surface identities are the existing deterministic per-host generator. Sparse, timestamped velocity-impulse residuals have a versioned journal/checkpoint hook and quicksave restoration. This hook is a piecewise-linear perturbation of the prescribed trajectory; it does not implement gravitational backreaction. There is no new intervention UI in this slice. The journal is limited to 4,096 events and rejects overflow rather than silently losing history.

## Exposure and scope

The default bounded-travel exposure limits the external-galaxy exposure target to eight times the reference exposure and disables the faint-field asinh stretch. It leaves the full catalog and physical flux calculation in place, so empty intergalactic sky is not automatically raised into a bright cosmic-web visualization. **Exposure: deep-sky overview** explicitly selects the existing high-gain photographic overview. These are display choices, not claims that a naked eye and a telescope have the same exposure. Cosmic scale shortcuts still exist as intentional overview controls.

The existing diffuse M31 model remains the large-scale envelope. This slice does not replace it with a new self-consistent resolved/unresolved luminosity partition or reconstruct every other catalog galaxy's stars. Other galaxy providers, material differential dynamics and light-cone detail are future work.

## Budgets and verification

A query touches at most 125 birth cells, 80 candidate stars per cell, and returns at most 420 stars. The LRU caches hold at most 256 cells and 2,048 star records; GPU capacity is fixed at 420. Promotion removes the identical star from the separate camera point layer before the active point/photosphere path draws it. Physical gravity retains the existing 64-source cap; it is not a mutual interaction island.

`npm run smoke:galaxy-travel` checks registry orientation/distance, stable IDs and system parameters under time reversal and cache eviction, exact-clock publication, independent ship discovery, bounded memory, seed separation and journal/save-shaped replay. `npm run verify:galaxy-travel` runs the real UI controls and captures departure, intergalactic transit, M31 entry, manual free flight, point selection, photosphere, planet, return and quickload. The latter reports production-frame CPU times and records a video. Hardware performance and the target of no transition stall over 50 ms require measured final-revision evidence; compilation stalls are not disguised by raising that threshold.

## Next acceptance milestone

A separate bounded mutual-interaction island should select at most 64 masses by physical influence, including offscreen neighbours; apply deterministic symmetric pair forces once per step; and persist checkpoints/residuals across island entry/exit. Tests must bound energy/momentum drift and prove no double counting with the prescribed host potential. This change does not simulate all stars in advance.
