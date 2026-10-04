# Disk and transparent-ring partial release

The isolated partial candidate `4d3ded4a4731f738fd27098156469f477d643c56`
restored the complete production `src` subtree of reviewed commit
`531da641fe5d61b4cdc7130285418c218299d263`. Published head `6fd18de` merged
main `e69158f8bfa6f2d24d786cb60c247fe66afa1420`. The current local preparation
also merges actual main `ab51029827cf9324eb737673e46c49ab74aa1718`, preserving
its core, catalog, source-radiance, surface-exposure and galaxy-travel changes. The three optical modules and ring-material factory remain
byte-identical to the reviewed 531 subset; a scoped smoke enforces that contract
without prohibiting unrelated integration work.
It retains finite-source lens geometry and final-residual validation, accepted
opaque depth/colour pairing, transparent-ring source depth with real alpha holes,
and normalized disk-plane raster support. It does not change physical tidal
stretching or simulation state.

## Explicitly unfinished

Issue #49 remains open. Thin detached silhouette-edge pixels caused by mismatched
colour/depth antialiasing are **not repaired by this partial release**. The later
edge-repair candidates improved those pixels but exceeded the unchanged 5%
full-source performance budget. Their commits, scripts and failed reports remain
available. The production reversion does not relabel them as accepted.

The applicable partial probe reports `silhouetteEdgeRepair:false` and
`issue49RemainsOpen:true`. Its separate deferred-edge texture fixture must still
reproduce a nonzero detached-edge count. That is a known limitation record, not
an edge-correction success. The original experimental edge scripts remain in
the repository and can be exercised on their matching prototype revisions.

The observed #50 reproduction is an exact plane-crossing dropout. Completing
that scoped fix requires all four desktop/mobile × direct/bloom captures,
source/body co-location, signed dense-crossing bounds and zero changed opaque
foreground pixels using the corrected same-target identity control. The photo
alone does not establish persistent underside-only disappearance or physical
spaghettification.

## Gates retained

- Current same-task framebuffer read/PNG capture and physical-hole scene-cache
  synchronization are retained. The foreground reference uses the same active
  compositor/render target; original no-lens screenshots remain diagnostic.
- Disk energy stays within the existing 0.75–1.25 outer-boundary interval, with
  adjacent dense-crossing deltas no larger than 0.20. Opaque interior changes
  must remain exactly zero. These thresholds are unchanged.
- The complete actual-main `ab510298` source baseline is compared with this candidate in all
  four modes using all five ABBA/BAAB trials, 120 warmup frames, 60 samples per
  block, the 5% paired-p95 limit and the original long-task total/count/max gates.
  The 531 comparison remains historical edge-cost evidence only.
- Existing general GPU recovery and other repository regression workflows are
  retained. No new rendering pass, target, quality reduction or cadence change
  is introduced.

## Failed evidence retained

- [Run 37120441056](https://github.com/Latand/artemis-pilot/actions/runs/37120441056):
  eight-neighbour edge candidate failed all four full-cost modes.
- [Run 37124704388](https://github.com/Latand/artemis-pilot/actions/runs/37124704388):
  two-probe candidate passed pixels but failed full-cost ratios 1.24328, 1.31098,
  1.21442 and 1.36797 (desktop/direct, desktop/bloom, mobile/direct, mobile/bloom).
- [Run 37131622101](https://github.com/Latand/artemis-pilot/actions/runs/37131622101):
  endpoint/conic preflight passed mobile pixels but failed median full-cost
  ratio 1.11052 and its long-task budget. Every trial is retained.
- The broad mobile catalog/overview CPU failure at `ea036df` was not reproduced
  by the separately instrumented frozen-root diagnostic
  [37132352070](https://github.com/Latand/artemis-pilot/actions/runs/37132352070).
  The cause remains uncertain; the later run does not erase the earlier failure.

No PR update or merge is justified by local smokes alone. Independent review
and final exact-head hosted validation must precede acceptance of this subset.

## Isolated subset preflight and final integration

[Run 37136186500](https://github.com/Latand/artemis-pilot/actions/runs/37136186500)
validated exact `4d3ded4` in all four pixel modes, including all 31 applicable
cases and zero changed opaque foreground pixels. Eight key images per mode
were individually inspected; detached thin gold edge outlines remain visible.
Full paired p95 ratios were 0.990324 desktop/direct, 1.003307 desktop/bloom and
0.993184 mobile/direct, with all long-task guards passing.

Original mobile/bloom had p95 ratio 1.013693 but failed its maximum long-task
guard: 326 ms versus 304.5 ms allowed. Its complete report (artifact 11278319809)
remains retained. The single GPU-readback-dominated sample took 326.3 ms, of
which CPU was 7.1 ms and readback 319.2 ms; the underlying cause is unproven.

One unchanged full mobile/bloom repeat was
[predeclared](https://github.com/Latand/artemis-pilot/pull/52#issuecomment-5971175913)
before it ran. It passed p95 ratio 0.988252 and all original long-task guards
(artifact 11279326520). Its runner changed from AMD EPYC 7763 to Intel Xeon
6973P, so absolute timings across allocations are not a code-speedup claim.
Source/config/workload snapshots were identical and all five trials per attempt
remain available. No further repeat was authorized.

The isolated preflight does not substitute for final broad checks on the
published Jupiter-integrated PR head. Main's source is preserved exactly, but
that combined head must receive its own checks before merge. Issue #49 stays
open; only the disk-plane defect and major ring-source-depth improvement are
in this partial release's completion scope.

## Current-main local integration preparation (2026-10-04)

Remote PR #52 remains `6fd18de5262145f30a8a5d70ec62e71c300fba77`. This local
integration preserves that commit and main `3a51477` through reviewed local
`6cedc34`. Merge `15ce237732cf43ce14ccb1b7bca76946f7082578` has that reviewed
commit and actual main `ab51029827cf9324eb737673e46c49ab74aa1718` as parents.
PR #56's merged galaxy travel is now included exactly. No hosted run or
publication is part of this preparation; unmerged cloud changes remain excluded.

The earlier 3a merge had one adjacent-import conflict in `planetAppearance.js`;
both imports are retained. The ab510298 merge is conflict-free. Relative to
current main, production changes remain exactly
`holeOptics.js`, `lensing.js`, the new `ringSamplingDepth.js`, and the ring import
and return wrapper in `planetAppearance.js`. The three optical modules and ring
factory equal reviewed 531. All other production source matches current main.
Earth/cloud surface-exposure helpers do not wrap the ring material; its existing
compile callback and render-time depth capture are retained.

Local validation passes optics, ring/partial-scope, appearance/precision, surface
exposure/fast-path/worker, orbital integration, core integration, river radiance
and source alignment, scenario-session and baseline-routing smokes, npm test,
build and diff checks. Current-main and historical 531 benchmark hooks validate,
and frozen optical capture transforms remain syntactically valid. These results
are not new GPU pixel, recovery or performance acceptance.

### Baseline and evidence plan requiring independent review

The historical optical workflow pinned 531, which already includes these
disk/ring fixes. That comparison measures later integration and edge optimizer
overhead; it cannot isolate the full patch cost against current main. The local
primary workflow now pins actual main ab510298 and fails before checkout if the PR
base differs. This change requires independent review before any publication or
hosted run. It compares both complete native source roots and matched work.
Keep all five ABBA/BAAB trials, all warmup/measured frames, the 5% paired-p95 gate
and every total/count/maximum long-task limit. Retain 531 as historical evidence,
not as a replacement for current-main attribution. Every threshold remains
unchanged. The historical 531 push-only diagnostic workflow is retained as such;
it is not the primary active-fix acceptance gate.

Current main lacks the newly added `ringSamplingDepth.js`. Source provenance now
records that one legitimate baseline absence as a null hash plus an explicit
absence list and immutable Git commit/tree proof from the declared baseline
worktree root. A deleted tracked file, non-Git directory, missing candidate or
other missing source file fails. The `--validate`
path checks hashes as well as native source hooks before browser startup. Its
negative smoke covers current-main absence, historical 531 presence, a deleted
tracked baseline ring, a non-Git baseline, missing candidate ring code and
missing required baseline files. The rendering,
workload-matching, timing, five-trial and threshold code is byte-identical to
the integrated pre-change harness.

The final target requires all four desktop/mobile direct/bloom optical pixel
legs, explicit TDE-off source-depth ablations and same-target zero-change opaque
foreground controls. Verify the retained surface-exposure inactive/active paths
and GPU recovery with the integrated ring capture. Broad checks must use the
actual PR base and preserve current core/catalog/radiance/travel work. If main
changes again, rebase the plan onto that actual main and review shared
`planetAppearance.js` interactions before running it.

The fresh radiance workflow also binds actual ab510298 and the complete new
optical candidate fingerprint. Both roots now own the same hidden 420-point
foreign-star layer, so its bounded inventory is required on both sides and raw
CPU object/geometry/material counts are compared without the earlier subtraction.
Every GPU count, texture hash, field, source, gain, camera and cadence gate stays
exact. The immutable 7d45 harness, all six fresh views, 7,200 measured frames,
1,440 warmup frames, five trials, phase caps and device-wide long-task budgets
remain mandatory. Previous travel/radiance reports do not accept this new source.
See `travel-radiance-fresh.md` for the adapter binding and evidence requirements.

### Earlier final-head failures remain failures

Published `6fd18de` passed all functional/pixel checks and the full 1200-frame
mobile soak, but three maximum-long-task guards failed:

- Optical desktop/direct: 375 ms versus 366.45 ms allowed; two tasks exceeded it.
- Optical mobile/direct: 303 ms versus 287.7 ms allowed; two tasks exceeded it.
- Broad desktop: 208 ms versus 206.85 ms allowed; one task exceeded it.

All median p95, total-blocking and task-count gates passed. The largest samples
were readback-dominated, and before/after A/B workloads matched. This supports a
runner/GPU-scheduling hypothesis but does not establish it or rule out a runtime
regression. The full [final report](https://github.com/Latand/artemis-pilot/pull/52#issuecomment-5972040205)
preserves all failures and source/runner limits. No repeat or waiver is implied
by this new integration, and issue #49 remains open.

One previously reproduced lifecycle limitation remains outside this preparation:
after an active lens is disabled, `updateLensingLazy` returns before clearing
the ring capture camera. This is inherited from the frozen partial implementation,
not a new merge interaction or an established cause of the earlier timing spikes.
No lifecycle code is changed here. Review its scope explicitly and retain
enable/disable/recovery checks before claiming final integration acceptance.
