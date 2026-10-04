# Source-density radiance in the combined release

Visible-source sampling keeps the fixed particle budget around sources that are
on screen. The extra samples previously multiplied additive ink. The reviewed
patch applies one display gain to owned line/dot samples after the style gains,
using the ownership distribution committed by the last completed compute pass.
Ambient samples, sparse sources, physical field, advection, source selection and
compute scheduling retain their existing behavior. The 128-sample parameter is
an expected-CDF display budget, not a cap on actual randomly assigned owners.

Production patch: `e2776d974330909a4f1ba08798942b0ad973d956` relative to
`09863eedda25eef36d79e9cf88daa4ff3e377875`. Source review and later QA retained
those two production-file changes exactly. The combined production source tree
is `aa3adfdd6cbc98ce4846817d225f02fd955beb5f`; `public`, `index.html`,
`package.json`, dependency locks, Vite config and the galaxy preview plugin
also match the accepted candidate. The committed identities, index and files
used for execution are checked separately; restoring accepted bytes over an
altered commit cannot make that commit pass.

The served preview dependency chain is `vite.config.js` →
`scripts/galaxy-preview-plugin.mjs` → `src/universe/galaxyMaps.js` →
`src/universe/astroConstants.js` and `src/universe/prng.js`. The latter files
already fall under the complete `src` comparison. Automatic Vite environment,
PostCSS and TS/JS config files are currently absent and guarded against being
introduced, including ignored `.env.local` files. Dependency installation inputs
include the existing `bun.lock` plus package/npm lock/config paths. The workflow
triggers cover the same inputs. This records repository inputs; it does not
claim that arbitrary host environments are identical.

## Accepted evidence and its boundary

[Final acceptance run 37164787136](https://github.com/Latand/artemis-pilot/actions/runs/37164787136)
at `7d45c681f684da27bd84532e1de1d0ddd3f9564f` authenticates the completed
original shards and recomputes six views from raw reports. All 7,200 measured
frames, 1,440 warmup frames and five ABBA/BAAB trials per view are retained.
The median paired p95 ratios for Proxima / Sun / black hole are:

- Desktop: 1.000624 / 1.006179 / 0.998638
- Mobile: 0.992911 / 1.024949 / 0.996048

Each ratio meets the unchanged 1.05 limit. Both device-wide long-task budgets
also pass, including total blocking time, count and maximum duration. The
desktop result retains its actual measured head `8feb71c9`; mobile includes
the final Sun view from `7d45c681`. Older shard heads remain in their original
reports. No historical result is relabelled with the integration commit.

Artifacts 11290472520 (desktop) and 11289988434 (mobile) contain all six raw
reports and their provenance. The integration verifier checks authenticated
run/job/artifact metadata, pinned raw hashes and complete production equality,
then imports the immutable accepted protocol and recomputes every gate. It
compares those results to the original aggregates. Missing, expired, altered
or incomplete evidence fails; it never substitutes partial trials or launches
an automatic performance retry.

This evidence transfers to the combined catalog/core/radiance production tree
because all production inputs match exactly. It does not establish performance
for the different, catalog-free intermediate core tree. The accepted benchmark
and all of its negative regressions remain at the pinned Git ref; disposable
preparation and continuation workflows are not imported into the release.

The measured workload uses hosted Chromium/SwiftShader, desktop/mobile
production quality, all normal render layers and a declared 120-update catalog
streaming prefix. It does not establish physical-device FPS, startup or input
latency, unbounded streaming, or live physical evolution. Pixel cases cover
20-frame transients. Ambient high-rate glare remains a known limitation.

## Final integration checks

The maintained transient and 64-frame lifecycle suites are copied byte-for-byte
from the accepted ref, including their real active-set replacement, forward/
reverse advection, native mobile skip/urgent-refresh and GPU restoration guards.
The functional baseline is actual prior PR55 head `aa13451b`, whose production
is identical to the original measured baseline `09863eed`. Final-head desktop
and mobile runs, image inspection, existing core/catalog tests and the full
source-relative river resource soaks remain required after publication. Earlier
passes are scoped evidence, not a claim that these new runs have happened.

The combined release also preserves actual main
`e69158f8bfa6f2d24d786cb60c247fe66afa1420` as an ancestor. Its Jupiter merge
leaves `river.js`, `riverMath.js` and `flowfield.js` byte-identical to the
original `cb6601c` legacy control. The coverage policy names this actual base
and verifies all three committed blob IDs before permitting its 120-frame
legacy negative control. It does not substitute the older base SHA. Missing
or changed proof fails, unknown refs fail, and the final fixed source still
requires all 1,200 frames and its runtime capability check.

Local commands (no browser for `--validate`):

```sh
node scripts/smoke-river-radiance.mjs
node scripts/smoke-river-radiance-qa.mjs
node scripts/smoke-river-radiance-lifecycle.mjs
node scripts/smoke-radiance-acceptance.mjs
node scripts/verify-river-radiance.mjs /path/to/aa13451b . /tmp/radiance-hooks --validate
```

The resource-QA corrections and their original failures remain separate and
preserved. Radiance setup/timeout failures remain in runs 37145710093,
37148090790 and 37156898245; their partial samples did not contribute to the
accepted aggregates. The inherited pre-existing cloud geometry/depth limitation
also remains; this patch does not include the later cloud hardening change.
