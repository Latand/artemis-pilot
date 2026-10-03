# Disk and transparent-ring partial release

This candidate restores the complete production `src` subtree of reviewed commit
`531da641fe5d61b4cdc7130285418c218299d263` in this isolated candidate. A scoped
smoke pins the three optical modules and ring-material factory, so unrelated integration work is
not accidentally prohibited by a whole-repository golden snapshot.
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
