# Optical component cost diagnostic (local implementation)

This is a diagnostic harness prepared for independent implementation review. It has not been published or executed in a browser. It does not modify production, existing acceptance scripts, their thresholds, or workflows. No performance or pixel result is claimed by the browser-free validation. It does not close issue49 or approve PR52.

The reviewed plan is identified by SHA-256 `b933f4750decc85573fe44461b497dbef1c6126e04915d5f4a685669106a75fe`. Actual main is `ab51029827cf9324eb737673e46c49ab74aa1718`. Candidate is `48a9da40a05b28cfd0d125b6107a771999fb784d`, tree `117adc60b590e235eeb345eb1079a5f7a2ed6232`.

## Local validation

These commands parse and validate test-server source transforms and run mock/negative contracts. They do not load Playwright or start a server/browser. Source roots must be separate worktrees at the exact commits above; the harness worktree may contain its own QA commit.

```sh
node scripts/smoke-optics-components.mjs
BASE_ROOT=/exact/main/worktree \
CANDIDATE_ROOT=/exact/48a9da4/worktree \
ARTEMIS_EVIDENCE=/new/validation/directory \
node scripts/diagnose-optics-components.mjs --validate
```

Implementation files:

- `scripts/diagnose-optics-components.mjs`: source preflight, durable supervisor/journal, serial native frame delivery, two timing orders, post-timing inspection and untimed pixel contexts.
- `scripts/optics-component-contract.mjs`: immutable experiment definition, exact source transforms, actual lens-draw boundary wrapper, ledger/identity/pixel guards and non-acceptance attribution.
- `scripts/optics-component-browser.mjs`: native full-app fixture, state capture and post-timing program inspection.
- `scripts/smoke-optics-components.mjs`: browser-free positive/negative contracts and full pre-existing production/acceptance-file identity check.

## Execution requires separate authorization

A later approved execution uses the same command with `--run`, a new output directory, and the repository's locked Vite/Playwright dependencies available to the harness. The harness currently has no published workflow. Do not start it as part of implementation validation, and do not replace a denied browser/sandbox route with another route.

The supervisor starts one worker process group and enforces a hard 1,200,000 ms cap over preflight, startup, warmup, both orders, inspection and pixels. Every completed delivery is appended to `events.jsonl` before the worker receives its acknowledgement. `report.json` contains complete in-memory ledgers at checkpoints and on cap/failure; the journal remains the authoritative incremental evidence. An interrupted/in-flight frame is labelled by a delivery-start event and is not fabricated as a completed sample. On failure or cap the worker/browser group is stopped and partial evidence is retained. Existing journals are never overwritten; there is no automatic retry, threshold adjustment, replacement block or pooled rerun.

## Fixed experiment

| Variant | Source | Lens iterations | Ring query | Disk support |
| --- | --- | --- | --- | --- |
| A | actual main | native | natively absent | native |
| B | 48a9da4 | 3 | native | normalized |
| C | 48a9da4 | 3 | forced off only at actual lens draw | normalized |
| D | 48a9da4 | 1 | same draw-boundary off control | normalized |
| E | 48a9da4 | 1 | native | normalized |
| F | 48a9da4 | 3 | native | exact-main support block |

One browser retains six separately prepared mobile/direct pages at 430×932 and DPR 1. The existing full-app fixture keeps distance 600, yaw π/2, pitch 0.48, frozen October 1 epoch, real world/lens/native frame hooks and the original layer query. Each page preserves native startup, 120 synchronous native deliveries, complete surface-queue settlement, and four final settled frames. The fixed 720 warmup plus 24 settled frames are a lower bound, not the total preparation count. Startup and any settlement deliveries remain separately accounted. Startup executes inside navigation and therefore has no separately observable Node roundtrip: the ledger records `null`, an explicit reason, the navigation envelope, and real CPU/finish/readback/frame-number values.

Then run ABCDEF and FEDCBA, ten native frames per variant per order: 120 measured frames total. Only one page/frame executes at a time. Do not reload, rewarm, replace contexts, compile extra programs, inspect uniforms or capture pixels between the two orders. Native error/context guards and JavaScript state/resource checks remain outside each measured block, in their original positions. Every native delivery must increment its real frame number. The browser and supervisor ledgers must agree.

Ring capture and CPU proxy setup remain active in C/D. The wrapper executes after `renderSceneTiered` and immediately around `lensQuad.render`, or immediately around native `super.render` for the source hook's composer equivalent. It restores the captured value in `finally`, including failures. All variants use that wrapper shape. Measured execution performs no additional GL inspection calls. Once both orders finish, an untimed native draw temporarily observes the actual GL draw call after Three uploads its uniforms. Candidate capture must be 1; the active GL program must receive 0 in C/D or 1 in B/E/F; restoration must return 1. A must retain the Git-proven missing-ring state. Failure invalidates interpretation of the associated timing.

D/E change only the iteration bound, retaining finite source distance, final sampled-depth residual, original foreground guard, edge fallback, accepted colour/depth pair and all other shader code. They are intentionally ablated diagnostics, not correctness fixes. F substitutes the exact-main support prefix through the disk mask and preserves all other disk emission/noise/blend/depth code.

## Evidence and interpretation

Reject untracked, ignored, or merely staged inputs under src/public/scripts and root served/package/config/env paths, including .env.local. Ordinary root node_modules and evidence outside protected paths remain permitted. Record all tracked source/build inputs and their immutable Git blob proofs, source-transform hashes, harness commit/tree/hash, exact served Vite response hashes (including optimized dependencies/static assets), post-plugin module hashes, native effective shader text/hashes and link/compile/error status. Record browser/hardware, quality, all lens uniforms, native state, resource/program IDs, real affine ring transform, material/texture identity and post-timing GL sampling settings. Compare cross-page CPU scene object/geometry/material counts, GPU geometry/texture/program counts, and background workload/readiness/quality. Program IDs stay within-page checks; elapsed background timings and historical counters do not enter cross-page parity. State, quality, workload, camera, lens, texture or source mismatches abort interpretation; no source is patched to match.

Report mean and p95 estimates separately for each order: B−C (annulus fragment queries at 3 iterations), C−D (iterations without ring queries), B−E (iterations with ring queries), B−F (disk support), and their interaction. A/B is an anchor only. Keep CPU, finish, readback, frame-completion and roundtrip measurements separate. Compare all component estimates with the largest same-variant order drift, for both mean and p95. Opposite signs, disagreeing mean/p95 direction, conflicting component rankings, or a delta no larger than observed drift produce an inconclusive result. Do not sum component deltas into a promised optimization. These ten-frame blocks have no acceptance verdict or five-percent pass claim.

## Untimed pixels and remaining limits

Only after timing and its draw-boundary proof, open separate untimed contexts using the original pixel fixture's 390×700 viewport and frozen October 3 epoch. The original 48a9da4 probe's entire draw function is extracted with pinned provenance. The only adaptations permit A's native ring-module absence and return bytes for independent comparisons. Existing source/depth/TDE, same-target foreground and dense-crossing assertions remain. B must pass all 31 original cases plus the known-unresolved edge fixture. B/F receive the complete dense signed-crossing comparison; F must expose its known crossing defect.

Every variant receives the same eight key images:

1. `saturn-near-lens-0.48-production.png`
2. `saturn-near-lens-0.48-no-ring-depth-no-tides.png`
3. `saturn-near-lens-0.48-no-tides.png`
4. `disk-crossing-0-production.png`
5. `saturn-near-lens--0.48-production.png`
6. `saturn-foreground-lens-0-production.png`
7. `disk-crossing--0.0006-production.png`
8. `disk-crossing-0.0006-production.png`

The existing `no-ring-depth-no-tides` pixel label intentionally suppresses capture. That untimed ablation never substitutes for C/D's normal capture-1 → actual-GL-0 → restore-1 proof. Ring-only byte contrasts are B/C and E/D, each using matching production and no-tides views at pitch 0.48. C/E is never used as an independent ring contrast. Ablated failures are retained and cannot relax B's original gates.

Native texture min/mag filters, mipmap setting, anisotropy, texture transform and post-TDE geometry are preserved and recorded. This harness does not implement a divergent fixed-point optimization, and it does not establish derivative/LOD equivalence. A future optimization still requires native filtered subpixel alpha-gap and inclined near-silhouette controls, independent source review, all four real pixel modes and complete actual-main performance gates. The existing nearest-filter synthetic fixture is insufficient for that claim.

Outstanding before any execution: independent implementation review; explicit authorization of the selected execution route. Outstanding after any future execution: inspect native shader/uniform/texture evidence, all eight images per variant, source/state/resource parity, complete ledgers and separate-order drift before interpreting attribution. Browser-free checks cannot establish those facts.
