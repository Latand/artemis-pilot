# README media

The gallery contains actual application captures. The PNGs are copied byte-for-byte from the reviewed browser artifacts, with their original dimensions and UI intact. They have no cropping, compositing, generative editing or added effects.

## Screenshots

Travel stills come from [continuous travel run 37192492764](https://github.com/Latand/artemis-pilot/actions/runs/37192492764), artifact 11299539061. Artifact downloads require GitHub access and expire; the PNG copies in this directory remain available.

All six screenshots were captured from commit [`64e08118`](https://github.com/Latand/artemis-pilot/commit/64e081181a698adb07df34334290066f68bbdf82), tree `7b185b45a344738d6299856362b455b18c8a9484`. That tree is identical to merged main [`ab510298`](https://github.com/Latand/artemis-pilot/commit/ab51029827cf9324eb737673e46c49ab74aa1718).

| Published file | Original capture | Dimensions | Source |
| --- | --- | --- | --- |
| `earth-explore.png` | `01-departure.png` | 1100 × 760 | Continuous travel artifact 11299539061 |
| `intergalactic.png` | `03-intergalactic.png` | 1100 × 760 | Continuous travel artifact 11299539061 |
| `andromeda-star.png` | `07-stellar-photosphere.png` | 1100 × 760 | Continuous travel artifact 11299539061 |
| `andromeda-planet.png` | `08-planet.png` | 1100 × 760 | Continuous travel artifact 11299539061 |
| `andromeda-planet-reloaded.png` | `10-reloaded-same-planet.png` | 1100 × 760 | Continuous travel artifact 11299539061 |
| `jupiter-slingshot.png` | `flight/desktop-30-flight.png` | 1366 × 900 | [Jupiter playback run 37192492663](https://github.com/Latand/artemis-pilot/actions/runs/37192492663), artifact 11300275101 |

The travel captures use Chromium/SwiftShader, DPR 1, bloom and the AT-HYG tier-1 layer disabled, with the galaxy layers and local M31 provider enabled. The selected star is `gx:m31:2654435769:1249:0:-1:28`; the displayed planet is its first generated planet. The capture report verifies that the host, planet, ship state and paused simulation time survive quickload.

The Jupiter capture uses the production guided encounter with its deterministic QA clock. The visible hull is enlarged for navigation. Its river fixture uses 9,216 particles; the normal desktop default can use a different population. Flow strokes illustrate the active gravity model.

## Recording

[`andromeda-walkthrough.mp4`](andromeda-walkthrough.mp4) is a 44.083-second H.264 video, 1100 × 760, encoded at 12 fps. It contains real browser-recorded motion from [capture run 37211222265](https://github.com/Latand/artemis-pilot/actions/runs/37211222265), [artifact 11307251719](https://github.com/Latand/artemis-pilot/actions/runs/37211222265/artifacts/11307251719). Capture commit [`f86fecbc`](https://github.com/Latand/artemis-pilot/commit/f86fecbc4e8756f9ce7bf03aa5e0ee4393b1a0a8) has the exact reviewed capture tree `634dd44378ebcfef66f02c25a00bcba85c4e6036` and unchanged application inputs from `ab510298`.

The source recording is 1,349 seconds of VP8 at 1100 × 760. The complete real-control route passed, including manual camera movement, target identity, return, quickload, and final video/cleanup checks. All 33,725 source frames decoded successfully. A full-source scan found no uniform grey padding region; the route timeline and full-size frames show the full app viewport.

The edit retains source ranges **90–266 s, 534–580 s, 750–1115 s, and 1230–1349 s**, each played at **16× wall-clock speed**. Long holds and low-change intervals are omitted. The application frame, dimensions and aspect ratio are preserved. The only overlay is a permanent speed/edit disclosure between the navigation bar and panels. There is no frame interpolation, generative editing, crop, color grade or added soundtrack. Every one of the 529 encoded output frames was reviewed in ordered contact sheets, with full-resolution spot checks.

The opening Earth view advances the clock for roughly the first 3.4 seconds of the edit. The simulation is then paused for the approaches and free camera movement. The final jump back to the planet is the actual **quickload** action.

[`andromeda-preview.gif`](andromeda-preview.gif) loops video seconds 4–11 at 550 × 380 and 6 fps, using a 128-color palette for GitHub's inline image display. It keeps the same 16× speed disclosure. Encoded video/GIF frame rates describe these files, not application performance.

Source ZIP SHA-256: `f2f71488be33ff949c1d8b20301e5736cdce9494be168455eda705697ec47334`.
Source WebM SHA-256: `b4c7d906c548b45672e85adb524d04b48720f74708755cbdcb3ad20b33dc41c1`.
Published media hashes, dimensions and sizes are in [`manifest.json`](manifest.json).

## Reproduce the recording

The dedicated helper follows the real-control route from `scripts/verify-galaxy-travel.mjs`. It fixes the viewport, screen and recorded video to 1100 × 760 and takes no screenshots during recording. Only delivery of the production frame loop is controlled: each delivered step uses 1/30 s. Camera positions, star selection, generated systems, free-camera movement, return and quickload use the application code and controls.

The helper verifies that served/build inputs match `ab510298`, including the build-time galaxy preview, `.env` files and implicit Vite configuration. It also checks committed helper identity against the index and worktree. It refuses dirty, masked or untracked inputs. The isolated Actions workflow installs dependencies without creating a new package lock and records the dependency versions in its artifact.

```bash
npm install --ignore-scripts --no-package-lock
npx playwright install chromium
node docs/media/smoke-readme-capture.mjs
node docs/media/capture-readme-media.mjs evidence/readme-media
```

To reproduce this revision, run from a clean checkout of capture commit `f86fecbc4e8756f9ce7bf03aa5e0ee4393b1a0a8`. The workflow is restricted to pushes of its capture files on `diagnostic/readme-media-20261004`; the final README/media branch does not trigger another recording. The helper has a 32-minute recording budget and bounded cleanup, within the job's 40-minute cap. Failure leaves `passed: false`; success requires route assertions, a finalized nonempty video, and clean shutdown.

The earlier 22-minute route recording was excluded because many frames contain partial-viewport grey padding that cuts off the app's controls. Its clean screenshots remain usable. The replacement recording above passed its route and media checks.

## Interpretation

These assets document the current interface and modeled behavior. Software-rendered captures do not certify physical-device frame rates. After its initial pause, the route uses accelerated camera navigation with simulation time stopped; it is separate from a spacecraft travel-time calculation. M31's generated local population follows prescribed disk motion, with bounded discovery and gravity. No full mutual stellar N-body simulation or universal 50 ms transition guarantee is claimed.
