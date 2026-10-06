# Scale-aware gravity inspector

Open **Gravity** in Explore. The compact control stays reachable with the object details closed on phones.

## Local objects

For the ship, Earth, Moon, Sun, planets and placed compact objects, the panel shows up to three strongest contributors, a vector **Others + corrections** remainder, and their net. These are acceleration magnitudes in m/s², not percentages or force proportions. Opposing directions can cancel. The arrow gives the projected net direction; its normalized length is not a distance or a physical magnitude.

The read-only ledger is collected from the force routines used by the local integrators. It includes the active source set, finite gas/core aggregates, softened transient fields, enabled cosmology, and applicable J2, relativity and frame corrections. Earth has a world-XY constraint; other integrated bodies use the Earth-relative frame. Drag, thrust and surface constraints are not part of gravity. Destroyed targets and prescribed catalog/analytic targets never get a fabricated applied acceleration.

Gas + core systems expose their actual local perturbing kicks, including self-pull exclusion. Their prescribed Galactic guiding orbit and harmonic restoring response are explicitly excluded: this is not their total motion acceleration. Each cloud and its formed core appear once, using the current bound mass and finite extent.

## Placed black holes

With a placed hole selected and gravity flow enabled, dashed gold arrows show the pulls from all other placed holes. The green arrow shows its current net acceleration, including other sources and the Earth-frame correction. These direction-only arrows remain visible with the Gravity panel collapsed; open it for acceleration magnitudes and model limits. A source along the line of sight is marked rather than given a fabricated screen direction.

The arrows reuse the exact live solver ledger and exclude self-pull. They follow moving holes and the surviving identity after a merger. Camera position does not reweight gravity: the optical lapse factor is separate from ambient field strength. A selected placed hole keeps its local force explanation across zoom scales.

Time Pulses remains a complete qualitative field, including the selected hole's own surrounding well. Its strokes are not object trajectories or exact relativistic spacetime. Its display softening, moving reference frame and large-scale estimates differ from the target-specific solver; merger/accretion mass fronts are resolved by the explanatory arrows, not the ambient field.

## Scale changes are presentation only

Except for a selected placed compact object, above a 20,000-light-year viewing distance, the panel switches to the **Milky Way context estimate**. It switches back below 14,000 light-years, so small zoom changes do not flicker. This changes the explanatory context, not the pinned selection or physical source set.

At galaxy scale the target is the Milky Way center, excluding self-pull. Neighboring galaxies replace individual member stars, without adding both. The view reuses a bounded, coarsened source sample from the existing large-scale visualization, with at least the Local Group horizon. Andromeda uses the existing merger-model halo mass when dark matter is on; other catalog masses are estimates from stellar light. Positions are apparent/light-cone positions, not a synchronized dynamical census. Shares are fractions of sampled source magnitudes, not shares of the net. The estimate is never applied to world physics, and no galaxy-wide forecast is offered.

## Short coast path

The existing path renderer can show a bounded numerical coast preview for the ship and integrated Solar-System bodies. It uses the local force laws and timestep limits, restores the live ephemeris, and freezes source inventory while extrapolating massive partners. It is budget-limited, so duration and points are shown; it does not promise a full orbit or a coupled close encounter. Earth is drawn in world XY; other paths retain today's Earth origin to display Earth-relative motion. It predicts forward coasting without thrust, regardless of the time-direction control.

The inspector does not offer a coupled path for placed holes or gas/core systems, or for catalog/galaxy models. Existing prediction tools remain available outside the inspector. Changing focus or mode, using the ordinary P/touch prediction control, restarting, or loading a save clears the transient inspector path and its body lock. Ordinary prediction controls then use the normal ship path.

## Verification

- `npm run smoke:gravity-inspector`: shared solver ledgers, no self-pull, read-only state, corrections, gas mass accounting, bounded integration, rank/scale hysteresis, aggregate identity and mass
- `npm run verify:gravity-holes`: real three-hole arrows, collapsed-panel visibility, camera invariance, movement, merger, scale retention, desktop/mobile screenshots
- `npm run verify:gravity-inspector`: real desktop/mobile browser controls, exact ledger sum, bounded prediction and restoration, repeated open/close, scale transitions, preserved selection, honest gas scope and screenshots
- The dedicated pull-request workflow captures raw application frames. CI runs use software-rendered Chromium and mobile emulation, not a phone hardware benchmark.
