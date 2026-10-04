# Lens invariant reuse: local candidate

This candidate starts from PR52 source48a9da40. Only `src/lensing.js` changes in production. It computes each lens's original-pixel offset, clamped squared radius, original-depth eligibility and nearest participating depth once, then reuses them in the existing three source-depth iterations and final residual check.

The source-depth multiply/divide order is unchanged. No vector coefficient is pre-divided, and no depth or ring texture call is removed, moved or placed behind a new early exit. All finite-source clamps, final-depth residual, opaque-foreground comparison, frame-border fallback and accepted colour/depth pairing remain unchanged. Disk, ring, TDE and physical-source code are untouched. Existing conditional lens eligibility stays conditional; this is not a new divergent sampling shortcut.

The diagnostic that motivated the candidate is run37213450176, artifact11307357889. The three-to-one-iteration treatment reduced mean synchronized frame cost by19.17/18.19ms with rings in forward/reverse orders, but it changed visible pixels. This candidate preserves all three iterations. Compiler optimization or array/register cost can erase its hoped-for benefit; no speedup or five-percent pass is claimed.

## Local validation

`node scripts/smoke-lens-invariants.mjs` binds the complete production delta to exact48 source and checks23382 float32 cases. It uses native GL uniforms captured after that diagnostic's timing orders, plus synthetic discontinuous depth/ring fields. It compares all three sampled UVs, final residual, eligibility, foreground and accepted depth, with zero differences. Cases cover zero through four lenses, overlapping/nearly cancelling lenses, the singular-radius floor, viewport edges, wide near/far ranges and no-depth input. Three negative controls verify that incorrect radial floors, a single iteration and source-dependent eligibility are detected.

The capture fixture identifies the exact run/artifact/source and distinguishes real uniforms from synthetic depth data. The CPU oracle does not emulate GPU instruction fusion, texture derivatives or native filtering. Offline compilation is an additional syntax/link check; browser pixels and performance remain separate future gates.

The existing partial-release smoke accepts only this exact, numerically tested cache delta before comparing the restored lens and untouched optical files with the reviewed531 source. It retains all source-depth, disk crossing, zero-change opaque-foreground and unresolved-edge checks. Historical edge-prototype scripts requiring `bodyUvBounds` are still not applicable to this partial production source.

## Outstanding gates and retained failures

No new hosted benchmark or publication is part of this local preparation. The current actual-main-to48 cohort still fails all four active-optics performance modes and desktop black-hole radiance; its original five trials and earlier three maximum-task failures remain preserved. The component diagnostic used Chromium148/SwiftShader on AMD9V45 and does not substitute for the Chromium153 acceptance cohort.

Issue49's thin-edge artifact remains open. The existing scoped disk/ring pixel improvements are not a whole-PR performance pass. After independent source review, any authorized hosted candidate must bind fresh source provenance and pass unchanged actual-main four-mode optical and six-view radiance gates. The frozen48 workflow fingerprints must not be bypassed for this new source.
