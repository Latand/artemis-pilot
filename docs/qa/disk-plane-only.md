# Issue #50: disk-plane continuity only

This candidate starts from actual main 6179f23661591bb4dee89a0bf8e686233e1ba280. Its only production change is the disk-support block in `src/holeOptics.js`. Main's lens solver, planet appearance, native ring rendering, physical state and other optical layers remain unchanged. There is no ring-depth proxy module. Issue #49 and the held PR #52 ring/lens stack remain unresolved.

## Sampling change

An analytical plane intersection gives zero ray distance when the camera lies in the disk plane, so all disk emission vanished for that crossing frame. The fix uses normalized, near/far-clipped raster-footprint support around the original plane hit. Coverage divides by the support width, preventing two full emitting faces or a crossing flash. This is sampling regularization, not physical disk thickness or a new accretion model.

The earlier absolute-endpoint formulation loses thin intervals in float32 at large camera distances. A reachable Cygnus annulus example has a plane hit at 2,000,000 rs, radius 48 rs and a positive filtered mask, while the two absolute endpoints round to the same value. The new formulation clips offsets normalized around the original hit. An unclipped interval becomes exactly [-1,1], so its coverage is 1 and its midpoint remains the exact original plane hit. It does not add an epsilon exemption. Near/far clipping still has ordinary input/float32 rounding limits; no universal precision claim is made.

The scalar regression uses the actual extracted GLSL expressions and an independent signed-coordinate integral oracle. It covers close signed crossings, reflections, tangent guards, support clamps, ordinary outside-support hits, clipped/tier partitions and the far emitting-annulus example. The former endpoint collapse is retained as a negative fixture. GPU derivatives, sampling and visual acceptance remain separate.

## Prepared pixel and lifecycle controls

The dedicated paired probe uses exact main and candidate roots in each of four desktop/mobile, direct/bloom configurations. It retains the 31 original cases and all dense crossing upper/lower/adjacency/no-drop bounds. Main must reproduce its zero-plane dropout; only the candidate can pass positive continuity acceptance.

Foreground opacity uses the same compositor/target with an identity lens, preserving the exact zero-change interior gate. Additive bloom is disabled only for the two opacity-control draws. Physical and drawn hole positions must match. Asset settlement uses production map requests and the real surface queue rather than a timer.

Disk-off/TDE-off ring contribution masks must match main byte-for-byte wherever visible. Empty masks do not count as a passed ring comparison. Native material and actual GL sampler/program observations are state evidence only; they do not establish a new alpha-gap or ring-depth repair guarantee. No existing ring-fix assertion is represented as passing.

Two complete camera/resize cycles compare their settled frozen images. Two actual `WEBGL_lose_context` cycles per source must stop successful-frame counting while lost, preserve paused physical time, restore a healthy native context and render identical post-recovery pixels. Failure to obtain the real extension is a blocked test, never a synthetic success.

The source-derived pixel budget is 509 explicit render/readback calls per root, 1018 per paired configuration and 4072 across four configurations, plus the declared setup/healthy/lost frame deliveries. Composer internals expand these into more GPU passes. These counts are a bounded diagnostic plan, not a timing or performance result. No browser execution has occurred for this candidate.

## Fresh cost plan

`benchmark-disk-plane.mjs` adapts the immutable reviewed 48 benchmark solely by removing the absent ring-proxy filename from its source-hash inventory. Both roots genuinely lack that module; no substitute is supplied. The measured frame, native hooks, fixture, 120-frame warmup plus 4 settled frames, five ABBA/BAAB trials, 60 samples per block, synchronized readback and all numerical gates remain unchanged. Seven negative controls reject altered warmup, block count/order, p95 and long-task limits.

For each of the four modes, measure exact 6179 main against the frozen disk-only candidate with the same dependency tree and Chromium 153.0.8010.12/Playwright 1.63.0. Retain all 600 measured frames per side and the full 124-frame initial warmup/settlement ledger, including the native runner's separately labelled post-window attribution deliveries. Require median paired p95 ratio ≤1.05 and unchanged task count, total blocking and maximum-task budgets. No historical 531,48 or invariant timing substitutes for these new pairs. No selective retry or discarded trial is permitted.

Before an eventual hosted run, its workflow must be independently reviewed, pin the exact new candidate and baseline, make the immutable 48 harness object available through a normal fetch, preserve the full pixel artifacts and failure logs, and enforce an execution/upload budget. This local preparation contains no launch workflow or publication authorization. Source/build/harness inputs must match their committed blobs before and after every run, including ignored/untracked configuration and tracked files hidden by Git flags.

The prior disk-support treatment cost 7.6–9.7ms in a different Chromium 148 diagnostic. The full ring/lens stacks and invariant-cache experiment failed their actual-main performance gates. The centered interval fixes a correctness defect and is not assumed faster; the disk-only subset can still fail 5%. Those original failures remain preserved, and no broader solver optimization or release acceptance is claimed.
