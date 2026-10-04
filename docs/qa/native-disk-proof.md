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
cached-program draws. The newly compiled first draw must use fallback.

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
whole-frame pairs per mode. Native compilation/reset fallback and later
shortcut use must be observed in the initial epoch and both existing context
restorations. Plane and dense crossing draws must retain normalized fallback.
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
buffer renderers, retaining their real native zero submissions. A complete
88-entry mock dataset and 14 direct checker negatives cover missing one or all
but one dense case, missing production, duplicate or mislabeled replacement,
missing resized/recovered evidence, wrong epoch and incomplete native ledgers.
These tests do not establish GPU acceptance. The historical failed timings
and uncertain desktop hover event history remain valid separate evidence.
