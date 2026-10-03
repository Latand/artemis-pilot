# Explored-system label first use

The mobile resource failure on integrated head `e7596e77` was reproduced by the
[bounded texture census](https://github.com/Latand/artemis-pilot/actions/runs/37124161083)
on diagnostic head `8d37137c`. Production source and the original verifier were
unchanged. Artifact `11274634583` has SHA256
`62466eac21b9f299a5316cb86b49aa0e64d571dd6a399792c1cd75142d1c06b5`.

The warm baseline had 28 GPU textures. Frame 465, in the first rapid round trip,
first drew the existing Barnard P2 label sprite at a camera distance of 1,349.73
scene units. Its 256×64 canvas texture (UUID
`5f849847-a09c-4cfa-a7ca-fc835b41b538`, source
`01dd4e10-565f-4d49-88bd-a2b409436b35`) already existed before that transition,
but had no WebGL handle. Its first upload increased the count to 29. The count
then stayed at 29 for all 20 repeats. The instrumented first-upload frame took
7.7 ms; diagnostic overhead and asynchronous scheduling prevent treating this
as an uninstrumented performance result. All 20 original no-growth checks failed.

Settling each close view had not exercised the wider intermediate view of the
rapid button sequence. The corrected verifier adds exactly one such sequence
before defining the warm baseline. It records every first-use frame cost and
the before/after inventory. It requires unchanged material identities, texture
UUIDs, sources and dimensions, the known P2 label initialized before the baseline,
and an allocation delta explained solely by that existing label (zero if it was
already initialized). It performs no upload itself and changes no visibility.

All 20 subsequent no-growth checks remain strict. Negative cases reject an
uninitialized label, replacement identity, unexplained first-use allocations,
and any extra texture after the baseline. The old failure is retained above;
final hosted desktop/mobile results are still required.
