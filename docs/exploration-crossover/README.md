# Mobile exploration crossover diagnostic (PR32)

## Status and scope

This is a predeclared diagnostic, not a new acceptance benchmark. The recorded
`d84ab18` mobile system-overview acceptance result remains **failed**:
median paired p95 ratio `1.0546875000009592 > 1.05`. No acceptance samples,
thresholds, fixture order, workflow or production files are changed here.

At preparation time, the diagnostic had not been executed in a real browser. Local Chromium
launch is already known to fail at sandbox/socket startup in this environment;
no attempt was made to route around that restriction. This PR prepares one
complete GitHub Actions diagnostic allocation per invocation, with partial artifacts retained on failure.
Publication and execution remain subject to the user's approval.

## What the existing evidence does and does not show

The preserved failure has approximately `+0.7135 ms` mean full-frame time:
`+0.0468 ms` CPU submission and `+0.6595 ms` synchronous readback wait. The
third trial has a larger excursion, but three of five paired p95 ratios fail;
removing that excursion would not justify calling the original run a pass.

At the overview camera the archived post-acceptance counters show identical
submitted resources/draws, but are one attribution snapshot rather than
per-frame command/pixel evidence. The failing allocation is AMD EPYC 9V45;
the earlier passing allocation was AMD EPYC 7763. Readback wall time includes
driver/OS scheduling and is not a direct GPU execution measurement.

Source inspection found no demonstrated simpler production fix. `river=0`
skips the warp layer; the paused ring step returns immediately. Added ship work
consists of two rotor angle assignments and scalar visual-state updates. Extra
CPU scene geometry exists, but no measured production hotspot explains a
persistent ~0.66 ms readback difference. Removing that work would be speculative.

## Frozen protocol

- Trigger: PR32 pull-request checks when diagnostic files change; the harness
  checks out the exact PR head. No separate diagnostic branch publication.
  GitHub evaluates these path filters against the cumulative PR diff: later PR32
  pushes may trigger another complete allocation even if that individual push
  changes other files. Every allocation is retained independently; no later
  result replaces an earlier run or changes the acceptance gate.
- Application A: `5c304f4f9c3572bbc9c62f480a074fc5da58c729`
- Application B: `d84ab18c5638bb24e89fac2c00cb734a1b9988dd`
- One Actions allocation, one Chromium `153.0.8010.12`, two persistent browser
  contexts and page targets, created L then R
- Fixed source assignments, in order: `AA`, `BB`, `AB`, `BA`
- Both pages navigate to blank before each assignment. Navigations recreate GL
  contexts; this is page/browser-context-slot crossover, not preservation of
  one WebGL context across code swaps. Target IDs and navigation ordinals remain
  in the report.
- Fixed fixtures: Earth-near, catalog-star, system-overview. Archived frame
  ordinals are enforced: startup 1; before/after Earth 125/725, catalog 849/1449,
  overview 1573/2173.
- Per fixture/slot: 120 warmup frames, surface queue drained, four settled frames
- Fixed trials: `LRRL`, `RLLR`, `LRRL`, `RLLR`, `LRRL`; 60 frames/block
- Total: 14,400 timed frames plus 2,976 warmup/settled frames. Every combination
  repeats all preceding Earth/catalog work; overview is never selectively rerun.
- Same viewport, query, paused epoch, timer-task frame delivery, finish plus
  synchronous 1-pixel RGBA readback, and 80 ms observer-probe history as the
  preserved paired benchmark. The failed run's npm lockfile is vendored to pin
  Playwright 1.63.0 and its Chromium; runtime rejects a browser-version change.
- No performance-based early stop, alternate ordering, replacement samples,
  profiler, retry, success threshold or automatic acceptance decision
- A fixed 45-minute diagnostic deadline, 120-second stalled-operation limit,
  infrastructure failure or invariant failure stops the run as invalid.
  SIGTERM/SIGINT are finalized as invalid partial results; cleanup is capped at
  15 seconds. The 50-minute collection step and 60-minute job leave upload time. The partial
  report and append-only raw journal remain available; no replacement is launched.

The original acceptance script has a required SHA256 of
`f694be002c24deaf7c805976461dc917e4b4dc80f49a658dd6d1c3beb70b657f`.
Runtime validates exact clean production revisions, all tracked source/asset
hashes, transformed-hook hashes, dependencies, browser, hardware and page IDs.

## Instrumentation and parity boundaries

The production frame body is unchanged. Test-only hooks freeze time, suppress
unrelated background HYG loading, and deliver frames serially, as the original
harness does. Each diagnostic frame resets renderer.info once and disables its
per-render automatic reset, yielding totals across all render passes. Calls,
triangles, lines, points, GPU geometries/textures and program IDs are saved for
every warmup and measured frame. Program source text is cached by ID on first
observation, even if later disposed; SHA256 mappings are saved with each fixture.

After the timing endpoint, each frame records live context/error status,
framebuffer size and default-framebuffer binding. These queries and telemetry
can influence subsequent scheduling; the diagnostic is explicitly a modified
measurement, not an acceptance replacement. Full CPU, finish, readback,
frame, post-frame telemetry, round-trip and protocol/scheduling residual timings
are retained in raw form. The residual subtracts measured telemetry and, in
replay, post-frame capture time; it still includes transport/serialization overhead
and is not a pure OS-scheduling measurement.

Only after **all four timing combinations** finish, the runner installs WebGL
API wrappers and replays all four combinations from fresh documents. It repeats
exactly the same initialization, warmups, fixture order and 600 frames per slot
per fixture. Only each slot's 600th frame is captured; there are no extra
application frames. Replay state is checked against the corresponding timed
state before each fixture.

For 24 declared captures, it retains:

- Full RGBA8 framebuffer bytes, dimensions and SHA256, read in the same browser
  task as the captured frame so preserveDrawingBuffer=false cannot erase it
- WebGL/WebGL2 and extension API call tape, with typed arguments copied at call
  time and stable per-type resource IDs; all wrapped method names are recorded
- Program/shader source and SHA256 mappings
- Exact pixel equality/difference metrics, API tape equality, shader hash equality

These are replay observations. They do not prove exact timed-frame parity,
identical driver-internal commands or identical pre-existing GPU resources.
Different resource IDs/order can make API tapes differ without a visual change;
manual inspection must distinguish that from actual arguments/work differences.

## Reading the result

All five trials are shown independently, including same-code controls. For each
trial/fixture let D be the right-slot minus left-slot mean readback time. The
report gives `D_AA`, `D_BB`, `D_AB`, `D_BA` plus:

- source contrast B−A = `(D_AB − D_BA) / 2`
- slot contrast R−L = `(D_AB + D_BA) / 2`

These are descriptive contrasts, not significance tests or causal estimates.
One fixed-order allocation cannot exclude period/thermal/cache effects. Compare
all five trials with both same-code controls, per-frame counters, program sources,
pixels/API tapes, full timings and CPU model. A different CPU model limits
claims about the recorded 9V45 failure. If the difference follows source, inspect
or fix that path before normal final acceptance. If it follows slots or remains
unresolved, report that limitation for an explicit acceptance decision. The
existing failed result never becomes passed in this tool.

## Retention and checks

`protocol.json` is written before launch. An existing output directory is
rejected. `frames.ndjson` appends each raw frame before validating it, preserving
the offending frame if an assertion fails. `report.json` is atomically refreshed with serialized writes after every
block; it includes raw warmups, every trial, replay samples, long-task entries,
errors and source identities. Captures and archived harness sources live beside
it. Actions uploads the entire evidence directory for 30 days, including failures.
The workflow has its own concurrency key and cannot cancel PR32's acceptance or
soak. It cannot deploy or merge.

Local checks:

- `node scripts/smoke-exploration-crossover.mjs`: 36 checks, including real source
  hook syntax at both exact commits, corrupted protocol rejection, contrast sign,
  recorder argument copying/extension calls and isolation from acceptance
- `node scripts/smoke-explored-baseline-routing.mjs`: 13 checks
- `npm test` and `npm run build`: passed
- Real browser timing, screenshots and pixel/API captures: **not run locally**

The smoke tests and hook validation do not establish browser correctness or
performance. A clean-context independent review completed with no remaining
findings after correcting telemetry attribution and invalid-capture retention.
Real-browser runtime remains unverified until the declared diagnostic runs.
