# Untimed native disk observation

The changed-source cohort retains the existing four pointer-controlled pixel
and lifecycle modes. Only the candidate receives this observer. It observes
the existing setup, asset-settlement and capture draws; it adds no app frames,
warm-up draws, render passes or pixel reads. The operation budget remains
62 saved captures, 26 stability captures and 629 pixel reads per root, with
132 healthy manual app-frame calls plus the existing startup frame. The timed
runner is unchanged and does not inherit this observer or its input guarantees.

The observer wraps the disk material callback, then inspects `CURRENT_PROGRAM`
at its next real `drawArrays`/`drawElements`, after Three uploads uniforms. It
reads the compiled vertex and fragment shader sources and compilation/link
status once per actual program, checks the disk-layer identity, and records
the fragment float-precision declaration and native `HIGH_FLOAT` format. A
highp declaration and precision/range thresholds qualify storage only; this
does not certify IEEE arithmetic rounding on a particular GPU.

Every observed disk draw records uploaded `uDiskUnclipped`, the uploaded proof
inputs, native/current-renderer viewport, camera eligibility and lifecycle
epoch. Uploaded values must equal the float32 material inputs. The unchanged
production proof is also evaluated against those native uploaded inputs. The
recorded shortcut must agree with that proof and compilation history.

Wrapping `onBeforeCompile` preserves its original callback and exact original
`customProgramCacheKey` result. This matters because Three's default key uses
the callback's source text. The compile wrapper observes the reset to zero
and independently records the production rule that unsupported/uncertain
precision permanently rejects that material/renderer, even after a later
highp variant. Actual bound shader precision is checked separately, including
cached-program draws. A positive native draw whose compilation occurs after its
material callback must use fallback. Every observed compile/reset is linked to
the exact armed native submission using arm identity, compile serial interval,
preceding submission count, draw label and lifecycle snapshot. Compilation may
occur on a native zero-count call. A later cached, eligible positive draw may
then use the shortcut; it is not required to replay the compilation reset.

Setup and capture evidence is persisted before acceptance checks, including
failed native reads. Shader text is emitted once per program, with compact
program references in draw records. Original callbacks and property descriptors
are restored on normal completion and in finalization. Queries never bind a
program, texture or framebuffer; binding identities are checked afterward.
Observation failures are collected without suppressing the original draw.
The disk callback arms the scope and its after-render callback clears it even
when no native call occurs. A real Three zero-count `drawElements` or
`drawArrays` submission is forwarded and recorded as a skip, with no native
program/uniform inspection. A skip never counts as rendered production evidence.
Zero-count records retain compile/submission linkage and explicitly state that
native uniforms were not observed. CPU reset-to-zero evidence on these calls
must not be presented as proof of an uploaded GPU uniform. Compilation with no
native submission at all cannot borrow a later draw to satisfy the reset gate.
Unrelated world draws cause no observer GL
queries. Batches report query counts and cumulative disk-draw counts; 8,192
draw/skip records and 64 compile/program records bound the observation, and
truncated/error-overflow history rejects acceptance.
Observer stop has a two-second deadline and browser close has an independent
five-second deadline, both inside the existing ten-second outer cleanup bound.
The normal stop promise is memoized; late timed-out inspection cannot publish
evidence. Stop and close failures are both retained, server cleanup remains
independent, and an original capture failure remains the primary error.

All eight original signed inclined poses (`+.48`/`-.48` for the four existing
scenarios) require exact baseline/candidate production PNG hashes and actual
candidate shortcut use in their production draw. This adds eight nonvacuous
whole-frame pairs per mode. Compilation/reset linked to a native submission and
later positive shortcut use must be observed in the initial epoch and both
existing context restorations. Positive compilation draws must additionally
show uploaded fallback. Plane and dense crossing draws retain normalized fallback.
Every one of the 88 planned capture entries (62 saved plus 26 stability) must
have positive native evidence for its unmodified production draw, with exact
phase/scenario/pitch/capture-index identity. All 33 plane/dense-crossing captures
across original, resize and recovery phases must use fallback. These requirements
come from the existing configured case arrays; a surviving pitch-zero record
cannot stand in for omitted signed cases. Native draw/compile/skip IDs and
cumulative totals must be complete and unique, and production records must
belong to their planned restoration epoch. Omitted, duplicated or mislabeled
entries, ablation substitution and zero-count substitution fail closed.
No new frames are permitted to satisfy missing evidence. Existing dense-plane,
foreground, ring, pointer, resize and recovery gates remain in force.

`smoke-native-disk-proof.mjs` uses deterministic CPU mocks to cover native
upload timing, float32 values, callback/cache-key restoration, compile reset,
sticky low-precision rejection, actual shader precision mismatch, missing or
wrong native programs/uniforms, failed queries, viewport mismatch, lost context,
real-draw exceptions, missing native draws and vacuous parity/lifecycle claims.
The zero-count regression calls the installed Three indexed and non-indexed
buffer renderers, retaining their real native zero submissions. Both cover the
observed sequence of compilation on the first of 16 zero calls followed by a
cached positive draw with flag one, then positive compilation/reset draws in
the two recovery epochs. The 27 added negative controls reject absent CPU reset,
missing or incorrect submission linkage, omitted or duplicate zero submissions,
false native-uniform claims on zero calls, unmatched compilations and stale flags.
A complete
88-entry mock dataset and 14 direct checker negatives cover missing one or all
but one dense case, missing production, duplicate or mislabeled replacement,
missing resized/recovered evidence, wrong epoch and incomplete native ledgers.
These tests do not establish GPU acceptance. The historical failed timings
and uncertain desktop hover event history remain valid separate evidence.

The v4 run 37240668460 at ede227e3 failed all four modes on the overstrong
requirement for a positive compilation draw in epoch zero. It preserved 715
valid positive draw records and 16 initial zero submissions per mode. Those old
zero records have no compile serial linkage or uploaded-uniform evidence; this
correction does not retroactively supply either. All 60 official artifact
digests and 496 production PNG hashes were verified. All 2,792 PNGs match the
previously inspected v3 evidence exactly. Cost jobs did not execute. Original
failed reports, prior long-task failures and their acceptance limits remain
unchanged; a corrected checker requires a separately authorized new cohort.
