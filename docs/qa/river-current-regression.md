# Current river validation and archived exact-source evidence

## Why the old jobs need an explicit scope

`river-radiance.yml` requires the original PR base
`6179f23661591bb4dee89a0bf8e686233e1ba280`, immutable accepted harness tree,
and frozen entire candidate production/build fingerprint. Its six 160-minute
performance cells cannot attest an arbitrary later source tree.
`foreign-river-validation.yml` likewise requires that frozen production
fingerprint, ancestry and 14 exact reviewed source/harness blobs. Those are
historical source-identity contracts, not universal functional tests.

The archived radiance jobs now run only for their declared original PR-base
context; their unchanged fingerprint and protocol checks still determine the
allowed candidate. No PR number is inferred. The aggregate keeps its original
`always() && !cancelled()` behavior inside that same context. The foreign job
likewise retains the original-base PR context and its explicitly named
`diagnostic/foreign-river-precision` push route, with all original source checks.
Every historical command, timeout, matrix, artifact and performance threshold
is unchanged. A missing historical object or mismatched frozen source still
fails that historical run. No success fallback is supplied.

The two functional harnesses are restored to their original bytes. The exact
fingerprints, source manifests, accepted evidence and failed reports are not
repinned, relabeled or replaced. Preservation tests remove only the declared
workflow routing conditions before comparing whole-file hashes.

## Mandatory current-source coverage

The separate `river-current-validation.yml` runs for current source, assets,
entry points, dependency/build/environment configuration, scripts and either
archived workflow. Its current jobs do not inherit any historical skip guard.

The model job executes the existing radiance acceptance negative controls,
radiance bounds and sparse identity, field/advection/cadence invariants,
GPU-accounting/pixel-policy negatives, source/gain/recovery lifecycle negatives,
foreign observer/body precision and ownership controls, real Three startup
allocation checks, and quickload/scenario-session checks. Both current harness
adapters validate their actual production hooks before browser work. Build is
mandatory.

Six bounded functional cells cover desktop/mobile and these three suites:

- Foreign: the existing real-provider star, planet, keyboard movement, signed
  time, return, quicksave/quickload and native GPU loss/restoration sequence.
  All owned/excluded-source, full-buffer, GPU uniform/body draw, nonblank pixel,
  physical-clock, signed-advection and recovery assertions remain.
- Radiance transient: all six current Proxima/Sun/black-hole paused/high-rate
  views, with 20 frames per view, full buffers, actual owner/gain accounting,
  source/body alignment, sparse identity and nonblank source-region pixels.
- Radiance lifecycle: both current Proxima and moving-black-hole 64-frame
  sequences, including same-count source replacement, ordering/eligibility,
  positive/negative/paused advection, native mobile cadence and real GPU
  loss/restoration. The candidate gain checks now apply unconditionally to the
  sole current root. The mobile lifecycle cell uses explicit `quality=low` to
  exercise production cadence two, with `np=96` preserving all 9,216 legacy
  particle texels and the existing `dpr=1`. All other functional cells use High.
  This cell covers Low-mode cadence at full particle capacity; it does not claim
  full visual detail. Signed held-texture skips and moving-hole urgent dispatch
  keep their original assertions.

Each cell has a 15-minute process cap and 20-minute job cap. These are bounded
functional workloads, not shortened versions of the historical benchmark.
Current reports, captured pixels and actual before/after source hashes are
retained on failure. Current input hashes include ignored served/config inputs
such as `.env.local`. The wrapper fails when source changes during execution,
when its child exits unsuccessfully, or when an adaptation seam changes.

## Narrow adapter and explicit exclusions

`run-current-river-regression.mjs` verifies the exact original harness digest,
applies declared uniquely matched substitutions in memory, and writes a
separate effective harness to a temporary directory. Original files are never
rewritten during a run. Import resolution is anchored back to the original
script directory. The effective code and its hash are included in artifacts.
Tests reverse every substitution to recover the original harness byte-for-byte
and reject modified source, missing routes and omitted current matrix coverage.

Foreign execution changes only explicit current-only report fields and the
URL's `quality=high`. Radiance uses High except for mobile lifecycle, whose
explicit Low/`np=96` profile exercises native compute cadence without reducing
particle capacity. Its report records Low, the capacity override and the
selected profile, and its capacity assertion no longer claims full visual
quality. The profile is selected by explicit device/suite arguments to the pure
adapter; only the CLI reads environment variables. Pure regressions exercise
the actual production allocation and compute-cadence expressions, retain the
High-mode cadence-one negative control and check every profile's reversibility.
A pre-controller main keeps its existing native mobile cadence path. Radiance
also selects one current root, labels it honestly, enables every candidate gain
check, and uses that root for sparse identity. It removes exactly the old two-root field/texture equality and
compute-shader equality comparisons. Those are not meaningful historical
acceptance statements when running only the new source. Every remaining
per-frame, source, pixel, gain, cadence, advection and recovery check is retained
unchanged. Adaptation fails if the preserved comparison block changes.

Both raw reports and wrapper provenance explicitly state
`historicalAttestation: false`, `pairedSourceAcceptance: false`, and
`performanceAcceptance: false`. This suite supplies no new full-layer paired
radiance timing acceptance. Original p95 ≤ 1.05, blocking ≤ baseline × 1.05 +
50 ms, maximum ≤ max(200 ms, baseline maximum × 1.05), count, frame/trial counts
and preparation limits remain in their immutable historical protocol. No
current performance budget in another workflow changes.

A one-pass audit of the other 21 source-triggered workflows and 117 direct
script targets found no additional obsolete candidate-tree/PR-base gates.
Fixed historical comparison baselines in galaxy travel are still current-head
comparisons; river coverage's ancestry fence is satisfied by current main;
exploration crossover is already scoped to PR #32 and not source-triggered.
These unrelated jobs are unchanged. Browser checks require hosted execution;
local model/source validation is not GPU or physical-device acceptance.
