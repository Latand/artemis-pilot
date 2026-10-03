# One moving state for catalog stars

Partial implementation of [#45](https://github.com/Latand/artemis-pilot/issues/45).
This is a foundation for [#46](https://github.com/Latand/artemis-pilot/issues/46),
not a completion of mutual stellar interactions or intergalactic traversal.

## Cause

Curated destinations (`STARS`) retained their epoch coordinates while the Sun,
procedural field and active HYG rows moved. The named point buffer refreshed
only after a promotion changed its length. The full HYG and AT-HYG background
point layers were also static. A label, its photosphere, its gravity source and
the background could therefore describe different epochs.

## State and rendering

`catalogMotion.js` now owns the shared epoch-to-time catalog model. Every star
retains an immutable epoch position. The seed is HIP, HD, HR, catalog row ID,
or a deterministic name/stream ID fallback, independent of universe seed and
camera position. The existing thin-disk synthetic velocity distribution and
closed-form epicycle model are reused, including the measured rotation-curve
parameters already used by procedural stars. This is explicitly a synthetic
orbit, not a measured proper-motion prediction for a named real star.

`syncGalacticFrame` publishes positions into the same destination objects used
by source selection, labels, photospheres, picking and explored systems. Stable
star and child IDs do not change. Declared unresolved companions co-move with
their primary; their internal binary orbits remain unresolved. Sgr A* retains
its existing nucleus-relative trajectory. Catalog positions use the existing
~19.6-year active-layer evaluation bucket. Every frame at million-year/s warp
lands in a new bucket. Reverse and direct seek evaluate the same epoch function;
there is no accumulated integration history.

The full HYG and both AT-HYG point layers evaluate the same algebra in a shared
GPU kernel, with four extra floats per point (16 bytes), rather than scanning
millions of stars on the CPU per frame. This adds approximately 40 MB for the
2.37-million-star AT-HYG base plus HYG background, in addition to any estimated
AT-HYG supplement. A small named buffer follows the canonical CPU objects. Both named and active
point buffers use observer-relative residuals, independent of the optional
global-rebase setting, to preserve local photosphere alignment after kpc travel.
Active HYG rows and the explored HYG host use the existing bounded active-point
pool with CPU positions; the matching background row is hidden. A photosphere
handoff therefore never revives a frozen epoch twin. Curated/HYG duplicate
resolution uses immutable epoch coordinates and explicit aliases, so divergent
fallback velocities cannot switch a selected system's identity. A bounded
active-position publisher runs even when cosmic-frame cadence defers more
expensive neighbourhood discovery. Float32 far-field GPU
positions are approximations; the browser test measures their deviation from
the canonical float64 model through ±541 Myr and +1 Gyr. Angular frequency is
packed from the canonical CPU model, and range-reduced polynomial trigonometry
avoids vendor-dependent phase error accumulating at kiloparsec radii.

Intrinsic magnitudes use epoch distances, never the changing distance to the
Sun. Promoted-star saves retain epoch coordinates, so loading a future save
does not turn its future position into a new birth position. Legacy promoted
records without epoch coordinates retain their prior epoch interpretation.

## What gravity means here

The Galaxy provides a prescribed smooth mean field: circular guiding motion
plus radial/vertical epicycles. Catalog stars do not kick one another or
back-react on this field. Adding a player black hole does not perturb their
prescribed Galactic orbits. This change must not be described as N-body gravity.

The local active layer retains a 640-object total budget and normally fills a
64-source gravity shortlist by influence, with priority for focus, compact
objects and contact-proximate sources (priority sources can exceed the shortlist
target, bounded by the active-object budget). Its Newtonian stellar force is
applied to local ship/body/hole field evaluations outside the existing 0.02 ly
Solar-System exclusion gate. The stars themselves are prescribed sources. A
ship already bound to a catalog/procedural host is transported with its host
between catalog buckets; local orbital velocities retain the existing
host-following convention. Internal system orbits remain the existing
analytic model. Separate Solar-System/placed-hole/gas dynamics already include
some genuine mutual local interactions; this PR does not expand that scope.

A collisionless smooth-field approximation is reasonable for most galaxy-disk
motion, but not close stellar encounters, dense nuclei, binaries, or user-induced
perturbations. See the primary derivations in Jo Bovy's
[collisionless dynamics](https://galaxiesbook.org/chapters/I-04.-Equilibria-of-Collisionless-Stellar-Systems_1-Collisionless-vs.-collisional-dynamics.html)
and [epicycle approximation](https://galaxiesbook.org/chapters/II-03.-Orbits-in-Disks_3-Close-to-circular-orbits%3A-the-epicycle-approximation.html).

For #46, preserve immutable identity and epoch baselines, but layer persistent
interventions/checkpointed local dynamics on top. Render LOD must query that
same state. Other galaxies need their own spatial population/state providers;
a visual galaxy instance alone is not yet a navigable stellar system.

## Verification

- `node scripts/smoke-catalog-motion.mjs`: ±Myr/Gyr determinism, named/source/
  point/planet coherence, fixed luminosity, stable IDs, companion transport,
  promoted/active HYG parity and future-save epoch preservation. A 1,000-epoch
  CPU benchmark enforces <2 ms per bounded curated-table update.
- `node scripts/verify-catalog-motion.mjs`: production application captures at
  0, +1 Myr, +10 Myr, +541 Myr (selected system), -1 Myr and return to epoch;
  full HYG background, named labels and system rendering. A transform-feedback
  probe executes the production GPU orbit kernel against float64 reference
  states. Background procedural/galaxy-population and AT-HYG network streaming
  are omitted from this focused full-app capture; AT-HYG decode/group plumbing
  has separate runtime smokes and shares the tested shader.
- Existing explored-system, galaxy-dynamics, tier-1 runtime/queryable/estimated,
  determinism, exoplanet, core tests and build remain relevant.

Local Chromium execution is blocked by the executor's socket restriction;
full-app pixels and shader verification run in the authorized GitHub Actions
workflow. A successful local build is not visual verification.

## Measured far-field precision and memory

The four-float orbit attribute adds about 39.9 MB of CPU attribute arrays for
full HYG plus the 2.37M AT-HYG base, and typically a similar amount of GPU
residency. The estimated AT-HYG supplement is additional. The number is not a
total application-memory estimate.

Independent offline Mesa ES transform-feedback on named and stratified HYG
rows found all sampled valid-distance rows below 0.05 pc through ±1 Gyr
(maximum 0.03881 pc). That is a representative validation envelope, not a
universal guarantee for every catalog record or epoch. The same valid-distance
sample reached about 0.639 pc at 10 Gyr and 3.246 pc at 100 Gyr. The UI permits
longer seeks; far-field catalog positions remain a float32 approximation there.
Local named/promoted/explored state remains canonical float64, rendered with
observer-relative residuals.

The raw binary contains HYG's 100 kpc placeholder distances. Production
catalogData.repairPlaceholderDistances replaces those with photometric priors
(minimum 500 pc), also recalculating luminosity/mass/radius. Raw-bin precision
samples must distinguish them from actual runtime input. These inferred values
must not be described as measured 100 kpc distances. The worker, direct registration and normal loader share the same idempotent
normalization. Repaired rows keep explicit estimated-distance provenance in
active/promoted records, saves and displayed details.
