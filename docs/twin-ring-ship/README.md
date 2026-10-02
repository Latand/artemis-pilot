# Twin-ring exterior

This slice replaces only the external craft mesh with an original procedural
explorer: a central pressure hull and command deck, two chamfered annuli,
radial pylons, and four longitudinal spars. Ceramic, graphite and copper
surfaces carry restrained cyan inner-ring strips and warm habitat windows.

The broad design direction is a speculative twin-ring spacecraft, like the
concept art in the [2014 NASA-hosted Eagleworks presentation, slide 21](https://ntrs.nasa.gov/api/citations/20140006496/downloads/20140006496.pdf).
No imagery or geometry from that presentation is embedded in this project.
This is art direction, **not an implemented or scientifically established
warp propulsion system**. It does not introduce a spacetime-distortion shader,
warp mechanics, new thrust, changed flight controls or different collision physics.

## Integration contract

- Nose remains local +Y, so the existing heading quaternion is unchanged.
- Tail is at -0.995, near the existing -1.05 conventional exhaust anchor.
- The existing adaptive size, distant marker, heading arrow, cockpit hiding,
  observe/pilot mode behavior and thrust/explosion effects are unchanged.
- Geometry lives in `src/shipModel.js`; the only integration in `src/ship.js`
  replaces its former mesh construction with `createShipModel()`.
- Seven opaque, material-batched meshes, 8,612 triangles, 244,984 bytes of
  vertex/index arrays. No textures, new lights, custom shaders or per-frame work.
  Every construction creates independently owned disposable resources;
  temporary geometry is disposed after merging.

## Verification

`node scripts/smoke-ship-model.mjs` checks bounded resources, finite geometry,
unit and outward/inward ring normals, deterministic construction, independent
ownership/disposal and the nose/tail/scale contracts.

`node scripts/verify-ship-appearance.mjs` captures the actual app at desktop
1280×820 and mobile 430×932, using its real camera, lighting, materials,
rendering, sky layers and UI. No scene layers are omitted. Only wall-clock
simulation advancement and the animation loop are replaced by paused,
deterministic frame stepping. An identical harness runs against the base tree.
It captures three-quarter, side, rear and normal flight-scale views and verifies
cockpit transitions, observe/pilot visibility and runtime errors. Pixel images
are unmodified full-app screenshots, not design mockups or isolated render scenes.

The GitHub Actions `Twin-ring ship appearance` workflow preserves exact base
and head revisions with reports and before/after screenshots for both devices.
The local cloud execution sandbox cannot launch Chromium because Unix sockets
are denied; browser verification therefore runs in that repository workflow.
