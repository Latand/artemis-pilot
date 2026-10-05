# Black hole disk continuity release

This PR addresses issue50: the thin disk's emission disappears abruptly when
the camera crosses its plane. Only `src/holeOptics.js` changes in production.
The reviewed normalized raster-support calculation preserves main's inclined
plane hit and clips support at the same camera near/far planes. A conservative
whole-view proof selects a static shader specialization when that support is
provably unclipped. Crossing, boundary, uncertain and unqualified-precision
views keep the normalized calculation. This is raster coverage regularization,
not an added physical disk thickness.

Main lens/ring sampling and planet appearance are byte-identical to actual
main6179f23661591bb4dee89a0bf8e686233e1ba280. Issue49 and the expensive ring-depth
stack in PR52 are not included or claimed fixed. The scalar far-annulus test
establishes numerical stability; it is not proof of GPU visibility at arbitrary
astronomical distance.

## Reviewed source and existing evidence

The release retains source tree3f08fd617780c395cebae6b608b72d594304bfcb, published
as9c80c2d548c3a68a1a3573b02d093a1056ff226e and independently reviewed asff48631d.
Native QA retains the reviewed88 captures,33 crossing cases, eight inclined
pixel pairs, opaque-foreground nonvacuity, pointer neutrality, two resizes,
two native context recoveries and three declared untimed precompiles per mode.
Native mode is read from the actual bound shader definition and effective
precision. Zero-count submissions do not claim uploaded-uniform evidence;
precision queries do not certify IEEE operation rounding.

[Run37265007756](https://github.com/Latand/artemis-pilot/actions/runs/37265007756)
at6c2c6dab passed all four pixel/lifecycle modes. All2,792 PNGs are byte-identical
to the previously reviewed v5 captures. Four-mode cost reports retain all20
trials,4,800 measured frames and992 setup frames. Its original CI conclusion
remains failure because mobile/direct maximum203ms exceeded200ms. All p95,
blocking and count gates passed. The explicitly approved220ms absolute floor
is documented in [disk-plane-only.md](disk-plane-only.md); re-evaluation of
those same raw data passes the new policy, without changing the old CI result.
Fresh final-head checks are required. Earlier failures remain preserved.

## Final-head validation and source bindings

The PR disk workflow replaces the isolated push-only diagnostic workflow.
It checks the exact PR head and actual6179 baseline, runs all four pointer-
controlled pixel/lifecycle modes, then all four five-trial cost modes. The only
cost-policy change is `max(220ms, baseline maximum × 1.05)`; no10% is compounded
onto the relative allowance and no other threshold changes. All frame counts,
source pins, runtime versions, process/job caps and failure uploads remain.

The broad radiance workflow now binds A to actual6179 and B to the exact disk
production fingerprint. Its historical7d45 harness, six views, five trials,
7,200 measured and1,440 warmup frames, phase caps and device-wide gates stay
unchanged. Both sources already contain the same hidden foreign-star object:
the inventory proof requires one per side, its fixed buffers, zero draws and
stable per-page identity. It no longer subtracts a candidate-only object; all
raw CPU/GPU counts remain in comparison. This matching-inventory adapter was
already reviewed for the prior optical integration and is reused here without
a timing change. In particular, the broad suite's200ms maximum floor is not
changed by the disk-only policy.

Foreign-body functional QA consumes the new exact production fingerprint while
retaining all14 pinned source/fixture blobs and the existing ancestor check.
No foreign rendering, movement, field, save or recovery predicate is weakened.
All remaining PR workflows run their normal final-head checks. The published
head, artifact provenance and outcomes must be assessed before merge; prior
timings are not substitutes for these final checks.
