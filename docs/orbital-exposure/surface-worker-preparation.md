# Surface preparation: off-thread image work

The retained mobile failure on `0ed732d` measured 120 idle slices with a maximum
of 41.4 ms against the unchanged 16 ms main-thread gate. A separate cold-entry
run measured 49 slices with a 19.7 ms maximum. Those aggregate records do not
separate image drawing/readback from row integration, so they do not prove which
stage caused either tail stall.

The candidate exposes separate main-thread setup, copy, mathematical-fallback
and result-attachment totals/maxima. Worker fetch, decode, draw, readback and math
have separate counters. `maxSliceMs` still measures **main-thread wall time**;
worker duration is never added to it. Existing failed evidence and the 16 ms,
paired p95, long-task and cold shader-entry measurements remain unchanged.

## Execution and limits

- One serial module worker fetches the exact already-selected same-origin image
  URL, decodes it, reads bounded source strips through OffscreenCanvas and
  computes the latitude-preserving, linear-light longitude integral.
- Fetch uses same-origin mode/credentials and rejects redirects. Fetch, decode,
  canvas, unsupported-image and access failures retain exact source sampling.
  They do not trigger an alternate main-thread image read route.
- Typed-array textures are copied in 64 KiB main-thread chunks, then transferred
  without detaching the original texture pixels. If workers fail or are absent,
  these already-readable bytes retain the sliced mathematical fallback.
- Desktop sources are limited to 4,194,304 pixels (16 MiB RGBA); compact/low-
  memory sources to 2,097,152 pixels (8 MiB RGBA, including bundled 2K maps).
  Dimensions are at most 8192 each. Encoded downloads are streamed with an
  8 MiB desktop / 4 MiB compact cap. At most 1 MiB of JPEG/PNG headers is
  inspected before decode; unknown formats, changed dimensions and oversized
  responses fall back exactly before allocating a decoded bitmap. One job is active;
  output remains at most 512x256 (mobile 256x128), with the existing 24 MiB/8 MiB
  ready-cache ceilings. Temporary source-copy, decoded-image and strip buffers
  are separate bounded working memory, not included in ready-cache bytes.
  The worker's explicit buffer budgets allow, conservatively, encoded chunks
  plus blob (up to twice the encoded cap), a 1 MiB header, a decoded image up to
  the RGBA cap, one narrow row strip, and one output prefix. These are roughly
  18 MiB compact / 36 MiB desktop before browser-internal decoder overhead;
  they cannot silently become an 8192x8192 decoded source. Typed-array jobs
  instead add one capped transferred RGBA copy plus the output prefix.
- The worker has a 15-second work deadline. A 60-second main-thread watchdog also
  covers a broken worker while allowing message delivery after slow software
  rendering. Cancellation aborts fetch and is checked during integration.
- Disposal and source replacement cancel the job only when its last owner
  releases it. Late/stale replies cannot resurrect a released map. The worker
  closes its decoded bitmap; transferred Float32 prefix buffers remain on the
  main thread so Three can re-upload them after WebGL context restoration.
- DOM canvas/ImageBitmap sources without an exact supported source URL, and
  cross-origin sources, use exact-display fallback. No synchronous image
  readback is introduced for compatibility.

## Verification

`node scripts/smoke-surface-worker.mjs` runs the actual worker module through a
Node worker_threads adapter. It covers linear/nonlinear byte sources, flipY,
bit-identical prefix values, original/result buffer retention, serial reuse,
last-owner cancellation, shared owners, stale replacement, unsupported image
behavior, worker crash/timeout and bounded byte fallback. Existing exposure and
fast-path smoke suites also pass.

`node scripts/verify-surface-worker.mjs` is the hosted browser check, with output
under `evidence/surface-worker/`. It uses the actual 2K Earth day/night/cloud
assets and production worker/materials. It preserves the 16 ms gate, compares
worker prefix floats against a deliberately replayed legacy DOM-image row path,
then loses/restores the actual WebGL context and requires identical rendered
pixels, unchanged retained prefix identities and stable restored resources.
The legacy probe reports draw/read/math stage attribution after the production
measurement; its intentionally blocking diagnostic work is not passed off as
production timing. `--validate` checks fixture syntax without launching a
browser. Hosted results are still required; Node tests cannot validate browser
image decoding, GPU restoration or the mobile timing gate.
