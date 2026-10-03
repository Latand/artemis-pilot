# Paired owner-radiance performance extension

This separate test harness compares exact baseline
`09863eedda25eef36d79e9cf88daa4ff3e377875` against the production source in
`2c9b5bcf2f542728d76cf1350007297db2678f34`. Later harness-only candidate commits
are allowed and recorded, but any tracked or untracked production-source drift
fails before browser launch. The original `benchmark-explored-systems.mjs` is
unchanged. Its disabled river/background layers cannot measure this change.

## Scope and workload

Run desktop (1200×800) and mobile (430×932), both DPR1, with the actual production
particle texture (15,376 desktop; 9,216 mobile), normal device draw/cadence policy,
and all normally enabled render layers present. No `np` override, forced compute cadence, disabled
catalog renderer, or shader gain-off substitute is used. Optional bloom and the galaxy
backdrop keep their production defaults; neither is forced on. In this exact
source, bloom is requested only by an explicit URL option, so it stays off for
both devices. Normal black-hole lensing remains available. The three fixed views are:

- Proxima: frozen supplied epoch/camera/source fixture; visual rate 1 Myr/s
- Sun: frozen epoch/camera; zero visual advection
- Placed black hole: frozen epoch/camera; visual rate 3,852 s/s

These are frozen physical clocks with declared visual river advection, not live
orbital evolution. The six paused/high-rate pixel/hash/lifecycle views remain a
separate diagnostic.

AT-HYG is a whole-sky priority stream: its camera cone changes priority, then a
global sweep fills the rest. This runner lets the normal production selection run
for exactly 120 setup updates, eight new tiles per update, before holding further
requests with a test-only hook. It does not eagerly load the 2.37M-row catalog.
The selected bounded prefix (normally 960 of 12,288 tiles) remains fully rendered.
The hook preserves motion uniforms, residual uploads, every loaded row, and normal
draws. Every selected request must settle before warmup; each snapshot records
sorted tile IDs, row count, and SHA256 of tile identity plus decoded position,
magnitude, and color-index bytes. A missing CPU row, pending request, unequal IDs,
or unequal row hash fails. Equal update counts alone are never considered proof
of equal catalog content.

All remaining assets/workers must settle using equal, serial A/B production frame
deliveries. There is a five-minute settlement deadline: failure is reported, not
worked around by reducing rows, particles, or quality. Settlement samples/readiness
are retained separately from the fixed warmup. The full HYG layer, procedural
field, galaxy population/volume, normal epoch-dependent tides, maps, gravity river,
and production postprocessing/lensing remain present. Production visibility and the selected epoch
still decide whether a particular layer has visible content.

## Unchanged acceptance

Each view has 120 warmup frames **per revision**, then exactly five trials in order
`ABBA, BAAB, ABBA, BAAB, ABBA`, with 60 samples per block. Both source pages share one
Chromium instance and run serially. Each real frame is delivered on a normal
browser `setTimeout` task; synchronous 1-pixel GPU readback follows `gl.finish` and
is included in frame duration. This is the established explored-systems protocol.
No acceptance profiler, outlier removal, trial replacement, or sample deletion is
allowed. All raw samples remain in the reports.

Each view's median of all five paired p95 ratios must be at most 1.05. Over **all
three views for each device**, retain the established long-task guards:

- Candidate total blocking time ≤ baseline ×1.05 +50 ms
- Candidate maximum task duration ≤ max(200 ms, baseline maximum ×1.05)
- Candidate task count ≤ ceil(baseline count ×1.05) +1

The live normal-timer 80ms observer probe must produce an overlapping observed
long task before timing. Lost/restored contexts, GL errors, non-default readback
buffers, missing normally enabled layers/maps, mismatched full workload, and incomplete frame counts
fail. Per-frame quality and river cadence/counts must match; full block snapshots
also compare source inputs, owner accounting, raw GPU compute texture hashes,
loaded rows, camera, scene counts, maps, and fixed clock/ship. Only the intended
per-source display ink gain is excluded from paired input equality.

Per-view sharding is supported. A successful shard reports `passed: null` and
`shardComplete: true`; it does not claim complete performance acceptance. The
aggregate tool requires all three views, exact reviewed candidate HEAD, baseline,
device, harness, five trials, and all samples. It recomputes p95 and all long-task
windows from raw data, applying the +50ms/+1count allowance **once per device**.
Per-view long-task budgets remain diagnostics.

## Commands

Prepare an exact baseline worktree and make the reviewed runner's installed
`node_modules` available there using the existing workflow's dependency setup.
No browser is launched by either command below:

```sh
node scripts/smoke-river-radiance-paired.mjs
BASE_ROOT=/path/to/exact-baseline DEVICE=desktop node scripts/benchmark-river-radiance.mjs . /tmp/radiance-validation --validate
BASE_ROOT=/path/to/exact-baseline DEVICE=mobile node scripts/benchmark-river-radiance.mjs . /tmp/radiance-validation --validate
```

After independent combined harness/workflow review, an authorized hosted job can
run one of three view shards per device:

```sh
BASE_ROOT=/path/to/exact-baseline DEVICE=desktop FIXTURE=proxima node scripts/benchmark-river-radiance.mjs . evidence/desktop/proxima
BASE_ROOT=/path/to/exact-baseline DEVICE=desktop FIXTURE=sun node scripts/benchmark-river-radiance.mjs . evidence/desktop/sun
BASE_ROOT=/path/to/exact-baseline DEVICE=desktop FIXTURE=black-hole node scripts/benchmark-river-radiance.mjs . evidence/desktop/black-hole
node scripts/aggregate-river-radiance-paired.mjs desktop evidence/desktop/aggregate.json evidence/desktop/proxima/report.json evidence/desktop/sun/report.json evidence/desktop/black-hole/report.json
```

Repeat with `DEVICE=mobile` and the mobile paths. The aggregator defaults to the
current checkout's HEAD as the expected reviewed candidate; set
`EXPECTED_CANDIDATE_REVISION` explicitly when aggregating elsewhere. Do not mark
the performance gate complete until both device aggregates pass. Omitting
`FIXTURE` runs all three views serially and computes that device's full gate.

## Cost and limits

Per device the mandatory acceptance record contains 3,600 measured frame deliveries
(1,800/revision) and 720 warmup deliveries (360/revision). The bounded streaming
setup adds at least 720 deliveries across the device's three views, followed by
any additional equal settlement frames. Thus the minimum is 5,040 frame deliveries
per device, or 1,680 per view shard, plus startup, snapshots, and settlement waits.

No prior measurement of this full-layer workload supports a runtime prediction.
Recent nearby-hole optical runs of a different workload reported roughly
0.15–0.32 seconds/frame on mobile and 0.56–0.80 seconds/frame on desktop. Applied
only as arithmetic to 1,680 deliveries, those ranges give about 4.2–9.0 minutes
and 15.7–22.4 minutes respectively, before startup, snapshots and additional
settlement. They are comparisons, not forecasts or evidence for this shader.
A 60-minute per-view hosted timeout provides headroom without reducing the
mandatory sample count. Six independent device/view jobs keep an individual job
bounded to one complete view; settlement has an internal five-minute deadline. The workflow
must provide enough time for every mandatory sample and always retain incomplete
failure artifacts. A timeout cannot be relabeled as passing or shortened by a
partial trial.

Hosted headless Chromium/SwiftShader evidence does not establish physical desktop
or mobile FPS, native GPU cost, startup latency, or interaction latency. Bounded
catalog streaming is disclosed above. All local checks for this extension are
pure/transform checks: no local browser was launched and no performance result is
claimed before the reviewed hosted run.
