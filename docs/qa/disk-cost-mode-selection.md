# Bounded disk mode-selection diagnostic

This local proposal investigates the remaining v5 cost blocker. It does not
change production, rerun acceptance, or provide a new timing result. The four
v5 pixel/lifecycle modes passed; desktop/direct failed maximum-task 507>501.9ms,
and mobile/direct failed median p95 ratio 1.054339>1.05 plus blocking 42694>42233.75ms.
Both bloom cost modes passed. All historical failures remain valid.

## Exact scope and stopping condition

Use actual main 6179f23661591bb4dee89a0bf8e686233e1ba280 and candidate
a21d5d137659d81193a196414e31c8c0012718ff/tree f42680b76e3750ccc9465f9b44165c82e28197de,
with the immutable 48a9da40 native benchmark and its reviewed ring-file inventory
adaptation. Select only mobile/direct and its original nearby-Saturn fixture.
The production source, camera, query, normal map readiness, initial application
frame, Long Tasks observer self-check and serial timer-task delivery stay the same.
The source adapter is a separate, exact-revision checkout from both served roots.

Retain exactly 120 original warmup frames, the original surface-queue readiness
wait, and exactly four existing settled frames per revision. Stop before the
first ABBA/BAAB block. No replacement or additional app frame, screenshot, pixel
read, profiling pass, or acceptance window is added. Original one-pixel
synchronous frame readbacks remain. One untimed GL error/context check follows
each root's four settled frames. All raw bookkeeping is saved, but its durations
must not be interpreted as performance evidence.

Only the candidate gets the native observer. It is installed before the first
warmup draw so its CPU compilation/precision history is complete. During warmup
it records native submission identities and compile intervals without reading
bound programs or uniforms. A scoped wrapper observes the result of the
production callback's existing HIGH_FLOAT query, forwarding its arguments,
return value and errors unchanged. It issues no extra warmup GL query. During the four settled frames,
the same reviewed observer reads actual bound programs and uploaded uniforms,
validates effective fragment precision, compares native/CPU float32 inputs,
re-evaluates the conservative geometry proof, and checks the selected flag.
The original program-cache key is preserved. All callbacks and native methods
are restored before any result is accepted. Native query counts exclude
production operations and the explicit post-settlement GL-status check.

Each of the four actual frame counters needs one to four positive native disk
draws. Missing, extra, mislabeled, stale, lost-context or disabled-disk evidence
fails the diagnostic; no frames are added to fill a gap. Compile resets must
link to actual submissions. Zero-count and unobserved warmup calls never count
as uploaded-uniform evidence. Raw shader text and native proof inputs are retained.
The observer inherits its fixed 8192-record/64-program limits and records each
unobserved warmup call under an additional 8192 cap.

Possible terminal findings are all-fast, all-fallback, mixed selection, or an
observation failure. If flag zero is seen, report the actual compilation,
storage, camera and conservative-geometry rejection reasons. A tagged copy of
the exact pinned scalar helper explains the rejecting guard offline and asserts
that its Boolean is identical to the production helper; it cannot affect a draw.
If flag one is confirmed, assess the feasibility of a separately compiled
unclipped shader locally. Do not implement that specialization without a new
review: initial compilation, effective precision, cached-program transitions,
clipping and recovery must remain fail-closed. No result promises a ≤5% cost.

This diagnostic can establish its own actual selection only. It cannot
retroactively prove uniforms from v5's uninstrumented timed draws. The inherited
cost fixture has no explicit pointer/hover-neutrality assertion. Native
precision capability does not certify IEEE arithmetic rounding.

## Provenance, runtime and containment

The first diagnostic attempt, run37252663287 at0ad2048f, failed before browser
startup: Three0.164.1 does not export the package.json subpath. Its artifact and
source checks are retained; no native mode was observed. The corrected metadata
reader resolves Three's exported CJS entry and verifies package name, version
and exact entry ancestry. Both --validate and --run now execute the same package
and renderer-source binding used by the workflow. The smoke reproduces the real
installed-package export error, tests invalid metadata/ancestry, and executes
the exact wrapper and workflow binding snippets. Its unexecuted binary placeholder
tests metadata code only; actual binary existence, image and version still need
the separately authorized hosted observation. No retry is implied by this fix.

The wrapper requires explicit source roots and an exact diagnostic HEAD. It
checks immutable source/tree pins, all existing protected source/config inputs,
shared dependencies and source snapshots before and after. The original native
benchmark and accepted observer have immutable SHA256 pins. The generated
selection script is saved and hashed separately; the original benchmark is never
edited. Actual Chromium/SwiftShader execution requires Node 22.23.3,
Playwright/core 1.63.0, Chromium 153.0.8010.12/revision 1243, Three 0.164.1 and Vite 5.4.21,
plus exact critical Three renderer/program-source hashes. CHROMIUM_PATH is
removed from the child environment while the original undefined executable
option preserves Playwright's default headless-shell selection. The exact
Playwright registry implementation is hashed. Its managed headless-shell path
is matched against the owned spawn command and actual /proc process image,
and the launched browser version must match. Equal full-Chromium/headless-shell
version strings alone do not satisfy this binding. Local --validate
starts no browser and is not runtime/GPU acceptance.

The supervised Node tree has a 12-minute deadline and 20-second termination
grace. A scoped Node preload journals owned spawn PID, parent, session and
start-time identities plus executable paths (no arguments or environment),
including Playwright's detached browser session. Spawn
arguments and returned handles are preserved. The supervisor signals only
registered owned sessions after rechecking live witness and leader identities;
it does not kill by process name or signal unrelated sessions. The final hard
stop remains active after the immediate Node child exits. Unexpected detached
children surviving a normal parent exit also trigger cleanup and disqualify
completion. Direct root ownership is established independently of journal I/O.
Malformed rows are reported while valid registrations are retained; an
over-limit tail is rejected while the bounded valid prefix still supports
cleanup. Any journal error fails completion, even if cleanup succeeds.
Spawn admission takes a shared bounded lock, checks row/count capacity and a
complete line boundary, reserves a worst-case 64 KiB registration, then holds
the lock through spawn and registration. The readable journal limit is the
same 1 MiB constant in recorder and supervisor. An over-limit or partial tail
rejects before the original spawn; concurrent writers cannot both take the
last slot. A stale lock fails admission after one second without launching.
If external corruption or I/O failure occurs after creation, the just-created
owned child is killed before the error propagates. No later duplicate
spawn-event append can push accepted registration beyond the prefix.
A final one-second wait bounds exit notification. Timeout is
journaled before signals, the ownership journal is retained, and there is no retry.
Normal cleanup uses the independently bounded observer-stop/browser-close and
finalizer paths, attempts every server/cache close, preserves the original
error, and uses the existing abort-aware atomic writer with a unique temporary file
per snapshot. A timed-out success write cannot overwrite a later failure.
Retained page/shader errors reject completion both before success and through
cleanup, including errors delivered while closing the browser. A future hosted
job needs its own reviewed trigger, exact revision pins, outer timeout and
failure artifact upload; none is added or launched here.

## Local checks

The CPU smoke uses the installed Three indexed and non-indexed native-call
mocks. Eight cases cover stable shortcut, geometry fallback, precision fallback
and first-settled compilation. Twenty-three negatives cover missing frames,
wrong mode/precision/compile linkage, invented warmup GPU evidence, unexpected
warmup queries, wrong fixture/time/context and cleanup. Fourteen process fixtures
cover success, failure, missing executable timeout/hard termination, immediate-child exit, a detached grandchild with an
unrelated live control, detached children surviving normal parent exit, and
malformed/capped journal tails with both root-only and detached-child trees,
capacity/partial-tail rejection before a new detached launch, and two writers
contending for one reserved slot. Exact-preload stub tests also prove the
underlying spawn is never called after failed admission. Ten
exact generated-finalizer cases retain independent cleanup and original errors.
Exact review regressions also cover a late aborted success write, retained
page/shader errors, late browser-close errors, and executable/version binding, including same-version binary-family drift.
The immutable delivery/readback helper and 120+4 prefix are checked byte-for-byte
or by exact pinned transform markers. No local browser, shader rendering or
acceptance benchmark is executed.
