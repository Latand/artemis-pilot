# Stable explored systems

A selected stellar system now stays attached to its host while the camera explores a planet or moon, pans freely, or enters and leaves Pilot mode. The ship does not need to travel to that host.

In Explore, select a stellar destination and use **Next planet**, **Next moon** (when the selected planet has moons), and **Host star**. Shift+F still cycles the current system's planets. Camera movement and selection do not change the ship or simulation clock; pause remains a separate control.

## Identity and persistence

Child targets carry the existing deterministic host key, followed by planet/moon indices. The host key is URI-escaped so catalog and procedural IDs cannot collide with the target grammar. Generation equations are unchanged. Valid existing host identities retain their planet parameters and surface seeds. Missing/blank HIP IDs previously collided as `cat:`; these now fall through to a namespaced HYG index or unique name, so formerly collided hosts receive distinct deterministic systems. HYG child tokens also carry a catalog locator, validated against the stable identity. The selected context is one record, not a growing registry; a second bounded CPU-only local-system cache preserves the ship’s orbit/contact/landing behavior during remote exploration; the existing renderer still owns eight reusable planet slots and six moon slots per planet.

Quicksave v11 gains an additive camera pose/world-space target and `exploredSystem` descriptor and includes a selected procedural host among restored pins. Quickload resolves the stable host identity after restoring universe seed and catalog/procedural data. A saved array position cannot replace that identity. Same-host generation is invalidated when the universe seed changes, including its rendered slots.

Legacy `planet:0` / `planet:0:moon:0` saves cannot identify a host. They return to Earth unless an explicit saved context establishes ownership. They are never assigned to the star nearest the ship. The camera preference also carries the context; unavailable hosts use a safe fallback rather than a different system. Camera-only automatic startup does not wait for HYG loading and can return to Earth for a not-yet-loaded HYG host. Explicit quickload waits for that catalog before changing the ship/world; a failed fetch still restores the save with a clearly reported Earth-view fallback.

Quickload cancels old autopilot/relativistic travel plans. A camera preference from another universe seed falls back to Earth rather than changing the selected body. A stale autopilot child target does not read the same-numbered body from a newly selected system. Moon targets have their own analytic state and physical radius.

## Scope

This is the stable-target milestone. It does not unify the camera's visual stellar field with the local physics generator, generate the interiors of external galaxies, or replace the existing Keplerian planetary model. Planet/moon surfaces remain deterministic illustrations; catalog-backed planets retain their measured/inferred status. The ship's existing bounded gravity neighborhood remains unchanged.

## Verification

- `npm run smoke:explored-systems`: repeated non-nearest-host routes, identical body parameters and surface seeds, explicit context save/restore, reordered catalog indices, procedural host recovery, universe-seed invalidation, no writes to ship/clock state, stale-target guards, escaped IDs, and safe legacy fallback
- `node scripts/verify-explored-systems.mjs`: actual full-app desktop/mobile browser route, screenshots, real input controls, paused movement and mode transitions, quicksave/reload, resource counts and matched frame timing
- `BASE_ROOT=/exact/main node scripts/benchmark-explored-systems.mjs`: one-browser paired comparison, five fixed ABBA/BAAB trials per view, every raw sample retained, median paired p95 ratio at most 1.05
- Existing planetary, exoplanet, body surface, gravity inspector, gas-world, application tests and build remain regression gates

The cloud workspace cannot launch Chromium because its sandbox blocks the browser's process-singleton socket. Browser verification runs in the repository's GitHub Actions environment using Chromium/SwiftShader. These are software-rendered desktop/mobile-emulation comparisons, not physical phone or hardware-GPU performance certification. Timing acceptance uses alternating baseline/candidate pages on the same browser/runner to separate revision cost from machine-time drift. Earlier sequential-process measurements, including failed comparisons, remain visible as diagnostics. Both protocols preload the same normally delayed Earth/Moon assets. Timing targets are a paired p95 regression no greater than 5%, a mandatory paired-window blocking-time/count/maximum budget, and warmed switch-handler CPU below 50 ms; results are attached to the pull request when available.

### Frame completion and evidence interpretation

The paired harness delivers each production frame through a normal browser timer task and proves its Long Tasks observer with a one-time 80 ms calibration outside measured windows. Every frame then reads one framebuffer pixel into a reusable four-byte array; that cost is included. [Chromium implements WebGL `finish()` as a flush](https://chromium.googlesource.com/chromium/src/third_party/+/master/blink/renderer/modules/webgl/webgl_rendering_context_base.cc#3557), so the older finish-only measurements did not drain the GPU queue between baseline/candidate blocks. Their intermittent multi-second stalls and failed gates remain in prior artifacts, rather than being discarded as outliers. CPU profiling and fine-grained diagnostics now run only after **all** acceptance fixtures, and block boundaries reject a lost/error GL context.

The fixed experiment at `f6262c8`, against the frozen pre-ship `848f476` baseline, passed all mandatory p95 and tail gates: desktop median paired ratios 1.0014 / 0.9925 / 0.9974; mobile 1.0087 / 1.0049 / 1.0267 (Earth / catalog star / system overview). Absolute Earth median p95 was 214.5→215.1 ms desktop and 136.8→137.3 ms mobile emulation; these slow software-rendered numbers are not hardware FPS claims. The workflow subsequently returns to the current-main baseline for final integration acceptance.

Screenshots named `08b-hyg-retained-host-photosphere` deliberately keep the planet selected while framing its host to verify render retention without selecting the host again. Early planet/moon navigation captures can show the existing low-detail material before the asynchronous surface settles; the separate settled-moon capture verifies actual crater detail. The camera-only HYG startup limitation and existing Pilot overlay/cropped world-label cosmetics above are not hidden by those images.
