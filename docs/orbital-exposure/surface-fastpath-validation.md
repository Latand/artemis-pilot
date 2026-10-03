# Paused surface shader fast path: validation contract

The performance candidate adds two exposure variants for Earth and its cloud
material. The exact variant contains direct source-map sampling; the averaged
variant retains the existing longitude-exposure calculation. It does not change
geometry, shell depth, lighting, source textures, physical time or spin.

## Acceptance remains unchanged

Run the existing `benchmark-explored-systems.mjs` against the exact `cb6601c`
baseline, with all five predeclared ABBA/BAAB trials and its existing 1.05 median
p95 ratio ceiling. Do not substitute shader microbenchmarks, remove trials, or
alter the threshold. The reported regression at `122e698` was 1.1996 for the
paused Earth-near fixture. Performance recovery is **not established** by the
local checks below.

## Hosted cold-entry and cache diagnostic

Run `node scripts/verify-surface-fastpath.mjs`; optional root and output directory
are positional arguments and `DEVICE=mobile` selects the mobile fixture. Output
is retained under `evidence/surface-fastpath/` by default. `--validate` checks
production-hook compatibility without launching a browser. Failure retains the
report, a bounded current-frame screenshot attempt, and any earlier captures.

Use a fresh Chromium context and the same Earth-near fixture, query, camera,
epoch, browser arguments and disabled unrelated layers as the paired
benchmark. The desktop diagnostic uses a smaller 960x640 viewport (mobile
430x932); this declared cost-saving difference does not alter acceptance views. Use the production frame and materials, with test-only explicit frame
delivery. Do not run this diagnostic between paired acceptance windows.

1. Load the day, night and cloud maps. Deliver the same 120 ordinary paused
   warmup frames. Record exact revision, graphics renderer, program keys/count,
   texture count, preparation status and both exposure defines.
2. Prepare the integral CPU buffers without drawing or compiling the active
   variant: call `updateSurfaceRotationExposure` for Earth and cloud materials
   once with the existing 256 days/s presentation shutter. Await the preparation
   queue becoming empty. Do not invoke the Earth variant-switching updater again
   and do not render a high-rate frame yet. Confirm no active program was added.
3. Record ten synchronized paused frames. Set the existing time controls to
   +256 days/s and deliver one first-ready high-rate frame, then ten additional
   high-rate frames. Keep the first sample even if it is expensive.
4. Pause and deliver one transition frame plus ten paused frames. Resume at the
   same rate and deliver one transition frame plus ten active frames. Repeat
   pause/resume ten times, then reverse at -256 days/s and record ten frames.
5. For every sample, measure the production frame on the browser's normal timer
   task queue. Immediately after that frame, call `gl.finish()` and then
   `gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, reusableFourByteArray)`.
   Report frame CPU time, finish time, readback time and total wall time
   separately. The readback must be included in total time; finish alone does not
   establish completion on Chromium/SwiftShader.
6. Record program keys/count, GPU texture count, material version, exposure
   defines/turns and preparation counters at each transition. After the first
   active and paused program variants are acquired, repeated transitions with
   the same material features must reuse the same program-key set and resources.
   Rates within one variant must not bump material versions. Pause must clear
   exposure immediately. Reverse must use the same averaged program.

The first-ready high-rate frame can include first integral texture uploads,
shader compilation and driver JIT. Label that combined cost accurately; do not
attribute all of it to compilation. Preserve its timing and the full repeat
sequence. These are diagnostics on CI software rendering, not hardware FPS.

No asynchronous shader prewarm is included in this candidate. Decide whether it
is needed from the actual hosted cold-entry evidence. A prewarm would require a
separate narrowly reviewed implementation and verification that it compiles the
same production lighting/feature variant without changing visible state or
shifting an unreported long task into startup.

## Local evidence and limits

- `node scripts/smoke-surface-fastpath.mjs`: exact original cloud shader on pause,
  ordinary/paused program reuse, asynchronous readiness, forward/reverse reuse,
  immediate pause and the cloud-shadow-only exposure threshold.
- Existing surface exposure and body-surface smoke suites and production build
  pass.
- Offline Mesa GLES: sixteen actual Three-assembled production shader pairs
  compiled/linked, including logarithmic-depth variants. Twenty-four pixel
  comparisons were byte-identical: paused candidate versus `cb6601c`/previous
  shader, and active candidate versus previous shader at three shutter widths
  and three orientations, for Earth and cloud materials.
- Offline active-uniform inspection confirms no integral sampler is retained in
  either exact program. The averaged program keeps the original sampler set.
- Offline cold compile was approximately 14 ms Earth / 13 ms clouds; first draw
  was approximately 208 ms / 101 ms, compared with exact first draws around
  108 ms / 78 ms. These Mesa JIT timings are not Chromium measurements and do not
  establish acceptance or a hardware performance claim.
