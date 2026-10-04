# Paired owner-radiance performance extension

Current local continuation: run only desktop Proxima, mobile Sun and mobile
Proxima; reuse the three authenticated complete shards. Preparation/warmup/
measurement caps are now 60/15/80 minutes. The earlier run records and timing
policies below remain historical evidence, not passing substitutes.

This separate test harness compares exact baseline
`09863eedda25eef36d79e9cf88daa4ff3e377875` against the production source in
`2c9b5bcf2f542728d76cf1350007297db2678f34`. Later harness-only candidate commits
are allowed and recorded, but any tracked or untracked production-source drift
fails before browser launch. The original `benchmark-explored-systems.mjs` is
unchanged. Its disabled river/background layers cannot measure this change.

## Scope and workload

Run desktop (1200×800) and mobile (430×932), both DPR 1, with the actual production
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

Canvas resolution and the volume's internal full target are separate. Unchanged
production `ensureTargets` uses scale 1 on desktop and scale 0.5 on mobile, below
its memory/texture caps. The expected full volume targets are therefore 1200×800
and 215×466 respectively, while the mobile canvas remains 430×932 at DPR 1. QA
checks both independently; it must not force a larger mobile volume or accept
a reduced canvas. Tests execute the exact baseline/candidate target policy.

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

Preparation preserves the reviewed native-rAF path: 120 catalog-prefix frames per
revision, then a separate five-minute deadline for remaining assets/workers,
finite native resolved-field settlement under the total preparation cap,
120 further native preparation frames, and bounded continued refinement until
full rows, blend and saved-history use are complete on both pages. These native
frames omit only the test-added GPU finish/readback; production synchronization
remains. They are recorded separately and never counted as acceptance warmup.
Each stage has a verified GPU drain, and the refinement stage retains actual row,
history, dirty/reset-reason and model-input evidence. Refinement allows at most
ceil(full target height / 2) +60 additional frames, without changing its budget.
Desktop is bounded to 460 additional frames; mobile to 293. Final full-resolution
state and raw river textures must match before the original synchronous warmup.

The entire preparation phase has a 60-minute cap, including browser/page startup,
fixed prefix, assets, native refinement, GPU drains and final snapshots. Asset
network/asset readiness must arrive strictly before its separate five-minute
deadline after the prefix; late readiness is a failure. The per-frame native
resolved-field queue is observed separately under the 60-minute total cap,
without replacing its real idle predicate. A new dirty/reset reason, a clean frame
without row progress, or stalled blend/history fails. The full HYG layer,
procedural field, galaxy population/volume, epoch-dependent tides, maps, gravity
river and normal postprocessing/lensing remain present. Production visibility
still determines which layers have visible content.

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
node scripts/smoke-river-radiance-run-budget.mjs
node scripts/smoke-river-radiance-full-preparation.mjs
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

## Cost and bounded execution

The completed preparation proof at 998184eb, run 37140303408, establishes the
actual desktop Proxima readiness contract. Both revisions retained 119,625 HYG
rows, 76 named stars, 960 AT-HYG tiles/308,779 rows, 250,001 resolved stars,
15,376 drawn particles and the full 1200×800 volume. They completed rows at
frame 337, saved history at 338 and first used it at 339. All 692 delivered frames
and both before/after raw river texture hashes were independently replayed.
Recorded preparation phases and drains took 45.6 minutes. Eight fully settled
synchronized diagnostic samples per revision had baseline/candidate p50
2.388/2.253 seconds and p95 2.471/2.396 seconds. This proves readiness and provides
a planning input; eight samples do not satisfy performance acceptance.

Each view keeps 120 synchronous warmup frames per revision, then 600 measured
frames per revision: 1,200 measured deliveries total, not 1,200 per revision.
At the observed Proxima p50/p95 costs, both revisions together need 9.3–9.7 minutes
for warmup and 46.4–48.7 minutes for measurement. With the observed 45.6-minute
preparation and five minutes for startup, snapshots and uploads, the planning
estimate is 106–109 minutes per similarly expensive shard. The other views and
mobile device have not been measured in this full workload; that arithmetic is
a budget proxy, not a predicted runtime or accepted result for those views.

The original 4f79de1c/b9e7c15f runs used 60 minutes preparation, 15 minutes
synchronous warmup and 55 minutes measured trials plus final state/observer
checks. These historical caps remain pinned when their completed shards are
revalidated; the current continuation uses the policy below. Each phase is
bounded even while a browser call is pending; finishing at or after its deadline
fails. The browser step has a 131-minute ceiling and its job 135 minutes, reserving
up to four minutes around the step for dependencies and artifact upload. The
5-minute planning margin includes those tasks plus bounded cleanup. Cleanup is
limited to ten seconds. No automatic retries are configured.

Six independent device/view shards can run in parallel when admitted. Their
hard ceiling is 810 standard-runner minutes (13.5 runner-hours); using the Proxima
proxy gives 10.6–10.9 runner-hours, roughly 106–109 minutes if all six are admitted
together. Queuing and different view costs remain unknown. Both mandatory
aggregate jobs are separately bounded to ten minutes. The unchanged transient
and lifecycle prerequisite jobs retain their own 45/60-minute caps and are
additional to the performance-stage budget. No matrix is launched by this local
patch or by the preparation-only branch.

Including all prerequisite and aggregate caps, the complete workflow ceiling is
995 runner-minutes (16 hours 35 minutes). With immediate admission and parallel
matrix legs, the maximum dependency path is 60 +135 +10 =205 minutes; queue time
is additional. The 135-minute figure describes the performance stage only.

Reports use an atomic replace after fsync. Every delivered sample is saved
before validation, progress is checkpointed every five seconds during pending
browser work, and SIGTERM/SIGINT retain completed samples plus the active pending
operation before exiting with failure. Aggregation also writes a failure report
when a shard is missing or invalid. Artifact upload remains `if: always()` with
14-day retention. Platform-wide termination or upload failure cannot guarantee
remote artifact delivery; the local report remains consistent and no incomplete
record can pass an aggregate. All original failures remain preserved.

Per device, acceptance still contains 3,600 measured deliveries (1,800/revision)
and 720 synchronized warmup deliveries (360/revision), in addition to recorded
preparation. The observed desktop Proxima path adds 676 native preparation
deliveries per shard, giving 2,116 total including acceptance warmup/measurement.
No resolution, row, particle, view, trial or sample reduction is used to meet a
deadline. Any such reduction would change the production workload and invalidate
this full-layer acceptance comparison.

## Runner billing

Read-only GitHub verification on 2026-10-03 returned public visibility for
Latand/artemis-pilot. All jobs in these workflows use literal `ubuntu-latest`,
a standard GitHub-hosted runner. Official GitHub documentation states that
standard public-repository runner usage is free and unlimited; these caps do not
consume billed/private-repository runner minutes or create a paid-runner
commitment. Larger runners are chargeable even for public repositories, and
changing runner class or repository visibility requires reassessment.

Artifacts retain 14 days. Account storage/billing settings were not inspected or
changed, so this finding concerns runner compute and does not assert that every
possible storage-related charge is impossible. Concurrency remains subject to
account/platform limits.

Sources: [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[Actions limits](https://docs.github.com/en/actions/reference/limits).

Hosted headless Chromium/SwiftShader evidence does not establish physical desktop
or mobile FPS, native GPU cost, startup latency, or interaction latency. Bounded
catalog streaming is disclosed above. Local checks are pure/transform checks;
no local browser was launched. Complete performance acceptance remains pending
all reviewed hosted shards and both mandatory aggregates.

## Preserved mobile setup failure

At head 4f79de1c, run 37145710093, all three mobile shards stopped on the first
baseline preparation frame. QA incorrectly expected a 430×932 volume target;
production correctly returned 215×466. Neither warmup nor measured trials began.
The Proxima failure is preserved as an exact frame fixture from artifact
11282255109; Sun 11282555028 and black-hole 11282635062 retain the same failure.
The corrected expectation keeps all source bytes, canvas dimensions, DPR,
particle counts, sampling policies and acceptance thresholds unchanged. Tests
retain the old rejection and independently reject wrong canvas, target and DPR
values on both devices. This is a setup correction, not a measured-performance
retry or passing result.

Each failed report also records the ten-second cleanup cap. The retained
Proxima log places its primary assertion at 18:53:59.813 and process failure at
18:54:09.951 UTC. Native frame work was still unsynchronized; the report does not
identify which close operation was waiting or prove its cause. Queued GPU work
is plausible, not established. Cleanup remains bounded to ten seconds, and its
secondary failure remains visible; no timeout increase or extra probe is made.

## Isolated mobile continuation

The original push workflow has no device selector. Publishing a fix to its
`diagnostic/river-radiance-pair` branch would rerun desktop, so the correction
uses a separate `diagnostic/river-radiance-mobile-setup` branch and workflow.
It schedules only three mobile performance shards and the mandatory mobile
aggregate, after a ten-minute provenance check. Original desktop jobs and their
aggregate remain exclusively in run 37145710093 at 4f79de1c; they are never
cancelled, replaced, or inferred to pass from mobile results.

The provenance check reads the original run, exact successful functional job
IDs and artifact IDs/digests with a read-only Actions token. It downloads the
three accepted functional artifacts and verifies every report and all 72 reviewed
PNG hashes against the committed manifest. All checks must still pass. It also
requires 4f79de1c ancestry and exact production/package/functional-harness bytes.
A missing, expired, altered or failed prerequisite stops the mobile shards;
there is no fallback that reruns those jobs. Only the small verification manifest
is re-uploaded; the original images remain in their original artifacts.

The three mobile shards retain the 135-minute job cap and all original trial,
sample and performance gates. Their aggregate requires the new exact candidate
head. The mobile-only workflow is bounded to 425 runner-minutes (7h05), with a
155-minute dependency path when immediately admitted. Its read-only Actions
permission enables cross-run artifact reads; billing and repository settings
are unchanged.

Overall performance acceptance still requires the successful original desktop
aggregate and the new mobile aggregate. `compatibleDeviceGates` checks those
exact expected heads, common baseline, protocol, production tree/source/compute
hashes and full per-device frame counts. It requires all three raw shard reports
for each device, recomputes the canonical protocol and p95/long-task aggregates
from every retained sample and long-task entry, and requires the cached aggregate
to equal that result. Changed actual source revisions, retained errors, jointly
shortened protocols and cached passing budgets cannot bypass the gate.
Harness hashes differ for the reviewed
mobile target assertion correction; production and the workload are unchanged.
No measured failure is retried by this setup-only continuation.

## Bounded completion of the three incomplete views

Both original workflows are terminal. Desktop Sun, desktop black-hole and mobile
black-hole completed all five trials and 1,200 measured frames each. Desktop
Proxima stopped at the 55-minute measurement cap with 1,029 frames; mobile Sun
stopped there with 1,165. Corrected mobile Proxima reached no measured trial:
its 120-update catalog prefix finished, but the asset deadline also covered a
finite native field retune. None of those partial trials counts toward acceptance.

The retained mobile sequence has one finite 89-bin retune (38 bar +51 disk bins
for epoch 18). The initial 250,001-star selection caused the mobile 60,000-star
budget controller to retune once, to magnitude 7.25. At frame 179/build 179, all
89 staged bins swapped to 38,715 stars; frame 180 added no build but had not yet
completed the required three no-work updates. The real fixture ends there with
idle:false. Missing queue fields are never invented in that fixture.

Asset readiness now retains every prior map/catalog/network/worker requirement
except resolvedField.idle. Native field settlement then continues every paired
production rAF frame under the existing total 60-minute preparation cap. It reads
existing debug state, validates the actual required-bin set, at most one issued
request per update, completed/staged/inflight accounting, frozen observer and
inputs, and real three-update idle. Distinct generation limits are bounded by
the production 6..11 grid at 0.25 magnitude; repeated limits or bin rebuilds fail.
A genuine pending worker can continue under the total deadline. There is no
extra short native timer, forced-ready flag, skipped draw or reduced workload.
Detailed queue snapshots are collected during native settlement, outside the
unchanged synchronous measurement windows. Existing full-state snapshots still
require the field to be idle before and after every measured block.

Across 96 retained complete blocks, the slowest 60-frame block was 196.528 seconds
(desktop Proxima, trial 5, A). Twenty such blocks cost 3,930.560 seconds; the largest
observed complete-phase overhead adds 8.894 seconds. A 20% margin gives 4,727.344
seconds (78.789 minutes), rounded to an 80-minute measurement cap. Preparation
remains 60 minutes and synchronous warmup 15. Browser steps are capped at 156
minutes and jobs at 160, keeping all 1,200 samples, all five original trials and
unchanged 5% p95 and long-task limits. This is a bounded completion attempt based
on retained workload timing; it does not reinterpret incomplete runs as passes.

Only a push to `diagnostic/river-radiance-incomplete-only` triggers the new
workflow. Its exact matrix is desktop/proxima, mobile/sun, mobile/proxima.
It authenticates the successful original job and artifact IDs/digests for:

- Desktop Sun: run 37145710093, artifact 11283689849, head 4f79de1c
- Desktop black-hole: run 37145710093, artifact 11284272823, head 4f79de1c
- Mobile black-hole: run 37148090790, artifact 11284910593, head b9e7c15f

Raw byte and canonical JSON hashes are pinned in the complete-shard manifest.
Their real source/harness headers and original 55-minute timing policy are kept.
New reports must come from the new exact reviewed head, carry the explicit
asset/native readiness contract, and complete their own full trials. The mixed
aggregator revalidates every raw report, compares exact common production and
baseline provenance, and recomputes all three view p95 values plus one combined
long-task budget per device. Altered reused reports, partial trials, changed
source revisions, shorter protocols and cached passing summaries cannot pass.
The result lists each shard's actual provenance rather than rewriting old heads.

The provenance job is capped at 10 minutes, three fresh jobs at 160 each, and two
aggregates at 10 each: 510 standard-runner minutes maximum, with a 180-minute
immediate-admission dependency path. Complete measured gate failures are never
retried. Every prior failed report stays preserved. Publication and launch of
this correction require independent review; this local implementation has not
started another browser run.


### Retained native-bin camera references

The first corrected mobile Sun setup in run `37156898245` at `8feb71c9`
failed before warmup or measurement. Artifact `11286328261` preserves both
frame-121 queue snapshots and the original failure. Both revisions already
had identical idle fields: 89 completed bins, 24 meshes, 30,477 stars, and
32 idle updates. The first normal-entry bar bin `b:18` kept its earlier camera
reference; its difference from the fixture reference was 0.000008095117 pc.
Its actual production rebuild score was only `3.389002416e-8`, below the
unchanged `score > 1` rebuild condition. The original guard incorrectly
required all historical bin references to be exactly equal within a family.
The secondary ten-second browser cleanup failure is retained separately.

The QA correction snapshots those initial bin records without changing them.
It uses the same bar/epoch transforms and `distance / max(0.06 * radius, 0.05)`
camera score as production to validate retained references. Every subsequent
appearance of a retained record must match its initial value exactly; newly
issued requests and newly completed bins must use the exact current camera
reference. The actual observer, camera, physical clock, era/neighbourhood
inputs and pending request parameters remain stable. This paused fixture
still rejects temporal or other input transitions; it does not grant a
blanket tolerance to new work or trigger unnecessary production rebuilds.

The regression fixture contains the actual failed A/B checkpoints, including
their report hash. Tests accept their already-idle zero-extra-frame state and
reject beyond-policy historical references, changed retained references,
new-bin/request camera drift, current-camera drift and changed time. Any
synthetic continuation used by unit tests is labelled as synthetic. The
ongoing Proxima jobs from the same run remain separate evidence. This change
alone provides no new browser or performance acceptance and changes no cap,
production source, workload, sample count or performance gate.


### One remaining mobile Sun view

Run `37156898245` finished with both Proxima views successful and the mobile
Sun setup failure above preserved. Desktop Proxima contributed all 1,200
measured frames, with median paired p95 ratio 1.000624; mobile Proxima also
contributed all 1,200, with ratio 0.992911. Their complete reports are pinned
by run/head/job/artifact identity, archive digest, raw bytes and canonical JSON
hash. The desktop aggregate was independently recomputed from all three raw
views: 3,600 measured frames, 720 warmup frames, all per-view p95 gates and one
device-wide long-task budget pass. Mobile correctly remains incomplete.

The isolated `diagnostic/river-radiance-sun-only` trigger starts exactly one
new browser job, mobile Sun, using the reviewed historical-reference guard.
GitHub job reruns retain the original commit SHA, so rerunning the old Sun
job cannot execute that correction. No Proxima or completed Sun/BH view is
measured again. The current benchmark, browser transform, full preparation
loop, frame timing, workload, volume readiness and caps stay unchanged.

The prerequisite job authenticates all five complete raw views, retains the
existing functional evidence, and checks that measured source and harness
paths match `8feb71c9`. Both final device aggregates are mandatory. Desktop
replays its three pinned raw views while reporting its actual measured head
`8feb71c9`; mobile combines the new Sun view with the exact completed Proxima
and BH reports. Cached pass flags and partial old Sun trials cannot contribute.
The raw device-wide long-task budget is recomputed once for each device.

The phase limits remain preparation 60 minutes, warmup 15 minutes, measurement
80 minutes; the browser step is capped at 156 minutes and its job at 160.
With a 10-minute verification job and two 10-minute aggregate jobs, the ceiling
is 190 runner-minutes and a 180-minute dependency path if admitted immediately.
All run on the existing standard `ubuntu-latest` public-repository runners.
There are no retries or new billing/settings changes. All old failures remain
available. This setup-only continuation still requires review and actual
hosted execution; it does not yet establish overall performance acceptance.
