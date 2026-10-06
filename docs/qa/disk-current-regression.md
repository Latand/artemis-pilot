# Current-source disk regression and historical release evidence

The `Disk continuity final validation` workflow now has two distinct scopes.
Every existing protected path still triggers it, including `src/**`, `public/**`,
configuration and `scripts/**`. Startup-quality changes and later force/physics
changes therefore receive the current-source checks.

## Historical PR #59 attestation

The `pixels` and `paired-cost` jobs run only for PR #59 against its original base
`6179f23661591bb4dee89a0bf8e686233e1ba280`. Their original reviewed-tree, parent,
source fingerprint, harness blob, dependency and first-attempt checks still have
to pass. Every command, matrix cell, timeout, assertion and artifact upload in
these jobs is unchanged. Historical failed reports remain failed evidence.
There is no new manual-dispatch route with undefined pull-request refs.

These jobs are skipped for a later PR because its new source cannot be the
frozen disk-only release. That skip does not certify a new tree. The source
contract, paired pixel probe, fixtures, acceptance policy, finalizer, benchmark
adapter and cost-contract test remain byte-identical. Their preservation is
checked by `smoke-disk-workflow-scope.mjs`, including a digest of both old job
bodies with only the new routing guards removed.

## Mandatory current-source checks

The `current-model` job checks extracted shader arithmetic and float32 support,
frustum eligibility and rejection, production callback lifecycle, installed
Three program precision/cache selection, static program specialization, native
observer negative controls, crossing/occlusion/pixel-policy negatives, real
pointer-fixture callbacks, bounded finalizer failure handling, context-recovery
predicates, and hole appearance, precision and emission. It also builds the app.
It does not invoke snapshot-specific source binding or `--verify-main-scope`.

After that job passes, `current-pixels` runs all four desktop/mobile ×
direct/bloom cells using `probe-disk-continuity-current.mjs`. The probe uses the
current app at explicit `quality=high` and the existing test-only frozen-frame
hooks. It checks all 21 signed disk pitches using the unchanged acceptance
function from `disk-plane-qa.mjs`: dense-crossing 0.75–1.25 endpoint bounds,
0.20 endpoint-relative adjacent-step bound and the original no-dropout bound.
Measurements are disk-on minus disk-off GPU framebuffer pixels. Real trusted
pointer placement prevents hover overlays contaminating the frames.

Each cell also checks two complete alternate/original resize cycles and two
real `WEBGL_lose_context` cycles. Repeated resize and recovery must reproduce
identical frozen disk images; loss must stop successful app-frame counting;
restoration must resume healthy renders while preserving paused physical time.
Missing real GPU recovery support fails rather than supplying synthetic success.
Before/after hashes bind evidence to the actual tested source. Atomic reporting
and independent bounded cleanup reuse the original tested finalizer. Any failed
assertion fails CI. PNGs, measurements and failure reports are retained.

The separate existing `bh-river.yml` still tests desktop/mobile full-quality TDE
disk emission against same-frame blend and disk-disabled ablations.

## Deliberate limits

This current suite does not reproduce PR #59's paired pre-fix main/candidate
foreground and ring masks, eight native inclined-pixel parity pairs, full native
program-observer matrix or active-cost benchmark. Its reports explicitly carry
`historicalAttestation: false` and `performanceAcceptance: false`. CPU mocks and
threshold-preservation tests are not runtime GPU or performance measurements.
The original maximum cost allowance remains `max(220 ms, baseline maximum ×
1.10)`; no p95, blocking, count, crossing or opacity threshold is relaxed.
The immutable historical cost-contract test requires its original `48a9da40…`
benchmark object, which is absent from some current checkouts. It is preserved
in the historical jobs, not silently bypassed inside a current measurement.

Neither suite resolves issue #49 or the held PR #52 ring/lens work. Chromium
viewport emulation is not physical mobile-device or Safari validation.
