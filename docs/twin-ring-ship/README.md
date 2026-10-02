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
- Seven opaque, material-batched meshes, 8,996 triangles, 271,864 bytes of
  vertex/index arrays. The prior exterior had 17 meshes, 11 materials, 2,074
  triangles and 79,324 geometry bytes: this spends an extra ~188 KiB and
  6,922 triangles while reducing draw calls by 10. No textures, new lights,
  custom shaders or per-frame work.
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
It captures dorsal/ventral three-quarter, side, rear, closest-zoom and normal
flight-scale views and verifies
a supplemental fitted close-up using the app’s existing clean-render mode,
repeated cockpit transitions, stable mesh/geometry/material identities,
observe/pilot visibility, conventional W thrust/release and runtime errors. Pixel images
are unmodified full-app screenshots, not design mockups or isolated render scenes.

The GitHub Actions `Twin-ring ship appearance` workflow preserves exact base
and head revisions with reports and before/after screenshots for both devices.
The local cloud execution sandbox cannot launch Chromium because Unix sockets
are denied; browser verification therefore runs in that repository workflow.


## First pixel review (8d8e200)

All 28 before/after screenshots were individually inspected. The two rings,
radial pylons and longitudinal spars formed a coherent silhouette, and the
rear lighting exposed the engine aperture and ring segments correctly.
The main defects were shadow-side material contrast and an invalid thrust
capture after camera-mode transitions. Both are addressed in the next pass:

- A stylized material-emission floor keeps the unlit exterior readable, while
  retaining solar highlights. Panel seams give the broad annuli surface detail.
- Each capture recenters the real camera target on the ship and asserts its
  projected center lies in the viewport. This catches the formerly empty
  thrust frame; the same issue was present in the baseline screenshot.
- At minimum zoom, both the legacy and new model extend beyond the mobile
  viewport and behind the desktop time dock. Controls are unchanged. The
  supplemental fitted clean-render shot checks the whole exterior without
  those UI occlusions; ordinary full-UI evidence is retained.
- The legacy save suite's network-idle wait timed out before save assertions.
  Its coordinated readiness patch retains every assertion, waits for the
  initialized app and pauses expensive ongoing rendering for data-only save
  scenarios. The separate ship screenshot harness omits no scene layers.
