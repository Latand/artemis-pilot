# Disk and transparent-ring partial release

The isolated partial candidate `4d3ded4a4731f738fd27098156469f477d643c56`
restored the complete production `src` subtree of reviewed commit
`531da641fe5d61b4cdc7130285418c218299d263`. The final PR candidate also merges
main `e69158f8bfa6f2d24d786cb60c247fe66afa1420`, preserving its Jupiter playback
source unchanged. The three optical modules and ring-material factory remain
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
- The complete exact531 source baseline is compared with this candidate in all
  four modes using all five ABBA/BAAB trials, 120 warmup frames, 60 samples per
  block, the 5% paired-p95 limit and the original long-task total/count/max gates.
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
