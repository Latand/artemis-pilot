# Static disk specialization proposal

The native selection diagnostic at6c6dfcef, run37255339064, observed four
highp draws with the existing uniform fast path enabled. It did not measure
performance or establish uniforms in prior timed draws. Earlier performance
failures and the first diagnostic setup failure37252663287 remain valid.

This local candidate is based on actual a21d5d137659d81193a196414e31c8c0012718ff.
Only src/holeOptics.js changes in production. The conservative all-frustum
float32 proof and every ray, clipping, coverage, emission and depth expression
remain unchanged. The normalized body is selected at preprocessing time for
fallback; the fast body omits that body entirely. Both share the same original
plane-hit initialization. This remains raster-footprint regularization for a
thin disk, not a physical thickness model. Issue49 and the held PR52 ring stack
remain outside scope.

## Selection and cache safety

Three r164 invokes the object's draw callback before program selection, but
computes its program key before onBeforeCompile. The draw callback computes the
same conservative eligibility. It changes a0/1 material define and version only
when mode changes. A custom program-key hook validates storage capability before
that define enters the key. The static shader also requires Three's effective
HIGH_PRECISION macro; inherited/cached lower precision always compiles normalized
support. Unsupported or uncertain compiled precision remains sticky per
material/renderer, as before.

Fallback compilation can qualify a renderer, including normal startup
renderer.compile/compileAsync. An unarmed precompile uses the normalized key.
Normal draw completion clears the arm. A stale arm from an interrupted draw on
another renderer can only create a normalized program under a foreign renderer
key, which cannot alias that renderer's valid fast key. This exceptional safe
fallback does not authorize a stale draw. Valid keys contain only the static
mode and a renderer identity shared by all holes; no camera/frame values enter
them. The normalized key is common to precompile and actual fallback draws.

Within each ordinary renderer/output/precision configuration there are two
programs, shared by holes. The installed-Three CPU harness exercises64 boundary
switches without further compilation,120 stable fast draws without a new query,
lookup-triggering version change or build, and both color-target configurations
with exactly four programs. Mode switches can incur cache lookup and capability
queries. First use of the fast program adds one compilation; no warmup frame is
added to hide it. The native recovery check must verify recompilation under the
restored context. These costs could outweigh shader savings in some views.

The first local candidate b68a5d59 failed review: an unarmed compile on rendererB
changed the shared define without invalidating rendererA's material version.
A subsequent plane-crossing draw could reuse A's fast program. Every persistent
mode change now advances the material version, including key-hook downgrades.
The exact cross-renderer and direct-key-call cases are covered; an in-memory
mutation reproduces the prior failure. The harness also preserves r164's actual
ordering of version storage before getProgram. A downgrade within key generation
may cause one further cached lookup, after which version/queries/builds stabilize.

Capability queries qualify storage precision; they do not certify IEEE operation
rounding. This change can remove unused branch/register work, but no performance
gain or5% acceptance is established.

## Local evidence

- The unchanged scalar/full-frustum suites retain their previous crossing,
  clipping, reflection, far-annulus/cancellation and weakened-proof negatives.
  They include20 pinned older cases plus the actual four matching native draws
  from run37255339064, with578 additional float32 helper-halo ray samples.
- smoke-disk-static-programs.mjs uses the installed Three renderObject,
  getProgram, getParameters and getProgramCacheKey implementations. It stubs GL
  allocation and models the relevant material-version/output-target admission
  conditions; it is not a browser or GPU-recovery test.
- Source comparison proves both specialized arithmetic bodies equal the
  corresponding previous uniform-selected body. Offline preprocessing verifies
  lower/unknown precision retains normalized support; removing that guard is a
  detected negative control.
- compile-disk-static-offline.py uses the pinned captured native Three shader
  prefix and surfaceless Mesa to compile/link the previous shader plus four
  static/precision variants. The fast variant has no normalized-support body,
  and both static variants eliminate the runtime branch uniform. No draw,
  image, driver timing or performance acceptance is produced.

The offline command takes checkout, downloaded selection-report.json and output
report paths. It requires the exact report SHA256
299549f8614478dfd9b20e9faa8d816fe6d0d04792fe2b95951c1039637b5ee0 from artifact11322556548.
The report contains the exact input/head/script hashes and whether the tracked
checkout was clean. Dirty preliminary reports are not final-head evidence.

## Proposed native validation, after source review

The old native observer assumes an uploaded uDiskUnclipped uniform and a format
query in every compile callback. Those assumptions no longer describe static
programs. Adapt it separately and review the adapter before any launch: observe
the actual linked program's shader definitions/effective precision, all existing
native geometry inputs, and capability calls in the program-key/compile hooks.
Preserve returned keys, callback order and native bindings. An optimized-out
uniform is not itself proof that the fast variant was selected. Every fast draw
must have matching conservative geometry and current qualified program evidence.

Retain all four pointer-controlled pixel/lifecycle modes, including dense signed
plane crossings, near/far clipping, native sampler controls, inclined parity,
opaque-foreground nonvacuity, resize and actual context loss/restoration. Add
fast↔fallback program transitions, unarmed startup precompile, shared-hole and
precision/cache transitions without adding hidden preparation or weakening an
image threshold. Program/capability observations belong to untimed evidence.
The shader arithmetic equivalence is not a substitute for those native pixels.

Pin actual6179 baseline and the final source tree in the unchanged active-cost
runner. The same five paired trials and p95/count/blocking/maximum gates remain
mandatory. All four modes are required for release; a reviewed single-mode
preflight can reject the candidate early but cannot provide release acceptance.
Keep prior failed trials alongside new results. No six-view sweep, hosted job,
publication, retry or merge is authorized by this local proposal.
