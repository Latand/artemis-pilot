# Visual checkpoint: 122e698

This is an intermediate checkpoint, not final acceptance.

- Source: `122e698d8eef7d221fb92db8f7d491289e7750a5`.
- [Hosted run](https://github.com/Latand/artemis-pilot/actions/runs/37111050681).
- [Mobile artifact](https://github.com/Latand/artemis-pilot/actions/runs/37111050681/artifacts/11270772002): 42 frames, 233 assertions passed, no JavaScript/shader/console errors. All 42 images were inspected individually, including the forward/reverse and close-up sequences.
- [Desktop artifact](https://github.com/Latand/artemis-pilot/actions/runs/37111050681/artifacts/11270467224): 42 steady-size frames, 230 assertions passed, no JavaScript/shader/console errors. Representative orbit, Jupiter-band, focus-transition and Earth-surface images were inspected individually. The job failed when Chromium rejected the final full-size resize while its window was not in normal state. The required full-size capture and final cost checks did not run.

The mobile sequence shows continuous orbital arcs at 256 days/s and stable full bands for the fastest Jovian moons. Reversal changes the direction of motion, and pause restores exact markers and texture details. Earth has its baseline solar orbit guide. The real DOM speed, Play, Reverse, Pause and independent Motion paths controls pass with the controlled frame clock; these are separate from the injected-state frame sequences.

Pixel inspection caught defects that position assertions did not:

1. Instantaneous arrows jump around the otherwise stable high-speed bands. Sharp guides must fade with temporal exposure, including unresolved turning directions on followed bodies, rather than introducing a slower invented direction.
2. On the first Jupiter→Moon and Moon→Earth frames, hidden local labels briefly appear at the screen origin. Their transforms are cleared while CSS still animates opacity for 200 ms. Local hides need to be immediate; the separate star-label fade can remain.
3. Motion paths uses an unstyled native button. It needs the same dark, sized control treatment as the Time Dock.
4. Faint moving speckles remain on the exposed Earth hemisphere. Cloud-shell depth interference is a hypothesis, not an established cause. The next capture adds a frozen cloud-layer off/restored comparison without changing the renderer or clock.

Mobile orbital sampling averaged 0.508 ms in its isolated repeated-update measurement, with 390 samples/update and unchanged GPU resource counts (160 geometries, 40 textures). Full-application software-rendered frames took about 5.2 seconds in the final scene. These measurements do not demonstrate real-device frame rate.

The separate Time Dock live-page test passed startup at the first viewports but timed out during a DOM read at the coarse-tablet viewport. Its result remains incomplete. The next revision records per-phase diagnostics and declares the unrelated background-layer omissions used by the existing UI/save smoke; the full-layer motion captures remain separate and unchanged in scope.
