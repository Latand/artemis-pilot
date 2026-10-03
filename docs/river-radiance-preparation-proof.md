# Bounded preparation proof

Run `37135250926` at `165c5574` passed all transient/lifecycle checks and pixel
review. All six full performance shards stopped before measurement: the
five-minute settlement window included the mandatory 120 fully synchronized
catalog-setup draws. Desktop delivered only 3/6/15 paired frames for
Proxima/Sun/hole, and mobile 44/47/58. There were no catalog errors or pending
tiles in the final states; the fixed prefix and resolved-field builds remained
unfinished. The original partial reports and failed aggregates are retained.

This separate workflow runs **one desktop Proxima preparation proof**, with a
60-minute ceiling. It does not launch the six-shard suite or return a performance
pass. Its preparation and diagnostic timing records cannot satisfy the full
acceptance aggregator.

The proof preserves the exact baseline `09863eed`, candidate production source
`2c9b5bc`, all normally enabled layers, DPR1, particle counts, camera, clock and
the original 120-update catalog prefix. Every untimed setup frame is a real
production frame delivered from native `requestAnimationFrame`; the fixture
omits only its own extra `gl.finish` and 1-pixel readback. Synchronization already
inside production remains. Each submitted frame and readiness state is retained,
and prefix counters must advance exactly once per frame on both revisions.

After those fixed 120 updates, the unchanged five-minute deadline begins for
pending assets, workers and resolved-field readiness. Additional equal native
frames continue production updates until both sides are ready. A GPU fence then
drains actual rendering; its error/context/framebuffer and unchanged frame count
are checked and its full duration is reported. Nothing pending is silently
charged to a timed frame.

The proof then retains 120 additional native-rAF warmup frames per revision,
followed by another checked GPU fence. Full state, loaded tile IDs/row hashes,
counts, camera and raw river texture must match. Eight synchronized timer-task
cost probes per revision follow, using the existing full-frame readback path.
Their distribution and simple workload-cost projection are diagnostic, not a
five-trial acceptance result or evidence about other views/devices.

The full acceptance runner remains unchanged: 120 synchronized warmup frames,
five fixed ABBA/BAAB trials, 60 samples per block, three views per device and the
existing 5%/long-task limits. Its sample validator now explicitly rejects
unsynchronized preparation records. Any later decision to use this setup path
in that runner requires review and a fresh complete gate. A proof timeout or
continued expensive settled frames must be reported before another matrix.

## Progressive volume readiness

The first preparation proof, run `37136825781` at `cbed691f`, completed its
120-update prefix in 710.4 seconds. Both sides loaded the same 960 tiles and
308,779 rows, and the resolved field became idle. Eight subsequent synchronized
samples had p50 2.661 seconds for the baseline and 2.613 for the candidate.
These are diagnostic samples, not performance acceptance: the volume still
reported `draft=true` and `historyReady=false`.

Source and recorded prefix counters explain that flag. `draft` means the final
blend has not completed; it does not mean each ray pass is a draft pass. Actual
frames 4–121 all used full-target refinement integration. Native wall-clock
adaptation lowered the refine budget to 0.02, permitting only two rows per frame
in the 1200×800 full target. Reconstructing the observed prefix gives 369/800
rows at frame 121. A later total of 625 rows is only an inference because the
first proof did not record warmup row counters. The frozen fixture time is
17076376013673600 seconds (+541117702.6667 years); visual advection is injected
only into the river and does not advance that physical clock.

The next isolated proof records the actual row, mix, full/draft target sizes,
history state, physical inputs, adaptive budget, and every existing dirty reason
after every delivered frame. Test-only counters distinguish maps, map blending,
target changes, fine-detail band, camera/model key, magnitude limit, enable state,
and context resets. Removing those counters restores the exact original source
bytes; they cannot modify rendering decisions.

After the unchanged 120-prefix and 120-warmup frames, matched native frames
continue until both sides have rendered all 800 rows, completed the blend, saved
history, and delivered the first clean frame that actually uses that history.
The save frame alone is not ready: history preparation precedes the save in the
production render. Input changes, new dirty/draft resets, backward
rows, or a delivered clean refinement frame without row progress fail. A stalled
blend/history fails after five seconds without progress. The additional sequence
is also bounded to 460 frames (400 at the two-row minimum plus 60 blend frames)
and the job retains its hard 60-minute ceiling. Catalog requests remain held at
the exact completed prefix. A verified GPU fence follows full refinement before
the same eight diagnostic cost probes; each probe must retain full readiness.
The refinement checkpoint is copied independently, and every cost sample is
persisted before its readiness/progress assertions so failures retain their
actual diagnostic state.
This followup cannot launch the full matrix or certify its performance gate.

Local validation (no browser):

```sh
node scripts/smoke-river-radiance-preparation.mjs
node scripts/smoke-river-radiance-volume-progress.mjs
node scripts/smoke-river-radiance-paired.mjs
BASE_ROOT=/path/to/exact-baseline node scripts/probe-river-radiance-preparation.mjs . /tmp/radiance-preparation --validate
```
