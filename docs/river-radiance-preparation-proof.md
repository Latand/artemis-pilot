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

Local validation (no browser):

```sh
node scripts/smoke-river-radiance-preparation.mjs
node scripts/smoke-river-radiance-paired.mjs
BASE_ROOT=/path/to/exact-baseline node scripts/probe-river-radiance-preparation.mjs . /tmp/radiance-preparation --validate
```
