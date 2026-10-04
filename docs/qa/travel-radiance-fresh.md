# Fresh radiance performance for optics on travel-enabled main

The historical radiance acceptance requires identical production. The optical
integration is a different production tree, so neither the historical radiance
measurements nor the accepted travel measurements can stand in for this run.
The historical manifests and verifier remain unchanged. The workflow uses the
immutable runner and protocol at `7d45c681f684da27bd84532e1de1d0ddd3f9564f` as
code, with no historical raw-report substitution.

The adapter compares actual main `ab51029827cf9324eb737673e46c49ab74aa1718`
against the exact reported candidate HEAD. The candidate's complete served and
build input fingerprint is frozen from local merge `15ce2377`, preserving all
actual-main travel fixes and the reviewed partial disk/ring correction. The
baseline fingerprint is `5509822d3cdc9bee3f72b8ae08990f004f0e637911f44ecd3a3eb4825ef1fff8`;
the candidate fingerprint is `baf24e53f5fa2a89bd1a3352af30cff34385e31169c7d803eef4c1ff54facbc6`.
This binding requires independent review before publication or hosted execution.
The workflow rejects a PR-base change before preparing either root. The immutable
fingerprint remains valid across QA-only commits. Source checks cover `src`,
`public`, entry HTML, dependency manifests/locks, the Vite preview dependency,
automatic environment and build configs, and untracked/ignored inputs. They
check HEAD, index and worktree before and after execution. The candidate's
adapter and all scripts must be clean committed bytes. Any production change
requires another source review and a new declared fingerprint.

Only three historical harness modules are adapted in a temporary directory:
source pins and fresh-only mode in the protocol; source provenance and variant
identity in the runner; read-only inventory telemetry in the browser snapshot.
Every original and effective helper hash, adapter hash, both measured source
trees and the effective source files are retained. Original files are never
rewritten. Historical reuse and legacy-budget modes fail explicitly.

Both current-main roots have one `persistent Andromeda stars` Points object even
in the three Milky Way fixtures. Its raw inventory remains in every snapshot.
Both variants must prove that this object is hidden, has zero draw range, owns
its geometry and material uniquely, has exactly the five production attributes
at capacity 420, and retains stable UUIDs. The earlier CPU-count subtraction is
removed: raw object, geometry and material counts now match exactly. Per-page
UUIDs remain excluded from cross-page equality and checked for within-page
stability. No GPU memory/program count, active layer, field texture, source,
camera, quality, cadence or particle count is relaxed. Radiance gains also match
exactly. Missing/extra baseline objects and any CPU/GPU-count mismatch fail.

Each desktop/mobile Proxima, Sun and black-hole view keeps 120 synchronous
warmup frames per side and five trials in ABBA/BAAB/ABBA/BAAB/ABBA order, with
60 samples per block. All 7,200 measured and 1,440 warmup frames are mandatory.
Preparation retains the full enabled layers, native quality, the declared 120
AT-HYG updates and complete volume-history readiness. The original 60-minute
preparation, 15-minute warmup and 80-minute measurement caps remain in effect.
No retry, frame deletion, outlier removal or partial-view reuse is permitted.

Each view's median paired p95 ratio must be at most 1.05. Device-wide long tasks
retain the original budgets: blocking time at most baseline × 1.05 + 50 ms,
maximum at most max(200 ms, baseline maximum × 1.05), and count at most
ceil(baseline count × 1.05) + 1. A fresh aggregate requires all three reports,
successful post-run provenance checks and the exact same candidate/harness.
Transient and lifecycle browser suites then compare that candidate with actual
main. Hosted SwiftShader results do not establish physical-device FPS or the
separate absolute 50 ms travel-transition target.

The preceding `8663be59` run `37184131655` is retained as before-fix evidence.
Its three mobile views completed all 3,600 measured and 720 warmup frames:
median paired p95 ratios were Proxima 0.99861, Sun 0.97480 and black hole
0.98899, with the original combined long-task budget passing. All three
desktop views failed exact GPU geometry equality (+1 candidate geometry)
before accepted measurement; desktop aggregation failed and the downstream
functional suites were skipped. Those observations do not qualify the changed
production. The final candidate requires a complete fresh six-view cohort.
