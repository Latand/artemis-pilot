# Recorded Milky Way rendering evidence

## Revisions and artifacts

Comparison base: `549079a18c348efdac8e303c5156129d2f08bd4a`. The renderer implementation is unchanged between `419bc0cd14b9f6129abf002de207e5c3963ddc0a`, `336e769789963b37a918c41810a685499f69fee7` and `61823a8fee736ea41fdd95a85b6a0717fb18ad94`; later changes add or correct tests and documentation.

The initial resize probe passed on [run 36159091837](https://github.com/Latand/artemis-pilot/actions/runs/36159091837). The expanded 800x500 comparison is in [run 36159531978](https://github.com/Latand/artemis-pilot/actions/runs/36159531978), artifact `galaxy-rendering-evidence`. Every new-renderer assertion passed there; the overall job failed because the baseline additionally exposed stale post-resize refinement on returning to the camera pose. The revised harness records that baseline defect explicitly, keeps the same strict assertion for HEAD, and compares the origin-metadata check with the fresh returned frame rather than the already-corrupted resize reference.

[Run 36162253686](https://github.com/Latand/artemis-pilot/actions/runs/36162253686) passed all five jobs: model/build, before/after volume regressions, and before/after full-app capture scripts. Its app captures paused at a machine-dependent simulation offset after startup, so they are route smoke evidence, not exactly epoch-matched pixel references. The app harness now freezes simulation before the first frame and asserts time zero in every capture. Refer to the PR checks for the resulting corrected app artifacts.

Artifacts expire after 14 days. The capture scripts, revision IDs and dependency-lock snapshots make the runs reproducible. The application adds no astronomical image files or runtime dependencies.

## Verified disappearance

At observer `[8178, 0, 20.8]` pc looking toward the Galactic centre, vertical FOV 48 degrees, DPR 1, fixed shared exposure 0.15, resizing the initial probe from 640x400 to 800x500 without moving the observer produced:

| First resized framebuffer | Baseline | Fixed |
| --- | ---: | ---: |
| Mean RGB channel value, 0..255 | 0 | 54.9496 |
| Fraction of nonblack pixels | 0 | 1 |

The settled pre-resize images in this initial probe were byte-identical. A brighter exposure or a replacement galaxy was not used to conceal the disappearing render target.

## Moving structure, not just average brightness

The 800x500 expanded comparison captured 16 consecutive local-yaw rotations of 0.002 radians each, at the same physical observer and model time. Full frames `motion-00.png` through `motion-15.png` show the moving views, not selected settled frames. The baseline drops fine dust and stellar-complex structure during rotation; the new renderer retains it.

The following measurements were computed from those PNGs with the method in `analyze-galaxy-motion.py`. The reference is the fresh `04-return.png` in each revision, reprojected into the actual new view with the known perspective homography. The comparison excludes an 8-pixel boundary and very dark/clipped reference regions. High-frequency texture is mean RGB minus a Gaussian blur with sigma 1.5 pixels. These are sequence-specific diagnostic measurements, not general quality ratings.

| Mean over 16 moving frames | Baseline | Fixed |
| --- | ---: | ---: |
| Corresponding-pixel RGB absolute error, 0..255 | 3.9424 | 0.2095 |
| Texture correlation with reprojected settled reference | 0.1140 | 0.9901 |
| Texture RMS / reference texture RMS | 0.2031 | 1.0098 |

The analysis script also creates equal native-size crops and a side-by-side motion GIF without sharpening or upscaling. Run it on the `before` and `after` directories from the 800x500 artifact to reproduce this table. Newer CI uses smaller buffers to bound software-renderer runtime; its measurements should be labeled with those dimensions rather than substituted into this table.

## Costs and coverage limits

The recorded renderer was Chromium 153 / ANGLE / Vulkan SwiftShader (Subzero), not a hardware GPU. At 800x500 DPR 1, the new renderer reported 8,266,667 bytes for its draft/full/history targets, including history mips. This excludes maps, the rest of the application and driver allocations.

The 16-frame draw-plus-`gl.finish()` measurements had baseline/new medians of 8.8/7.1 ms, but GPU work and readback can be deferred in this browser. They must not be converted into FPS or presented as GPU execution times. The corrected harness additionally records the complete browser capture round trip, including readback. Translation and fresh refinements remain more expensive than reusing valid angular history. Hardware frame-time distributions, Safari and headsets are not certified by these software runs.

The isolated renderer passed resize/DPR, same-observer rotation, return-to-pose, translation/model-history rejection, delayed startup, injected worker failure, depth tiers, an opaque foreground sphere, composer and bloom, and galactic observer poses inside/above/outside the disk. Origin testing checks metadata invariance under the current absolute-camera contract, not every layer of experimental rebasing. XR flag restoration is tested; the separate XR rendering dispatch still needs integration work.

## Reference-image constraints

The [ESA Gaia EDR3 page](https://www.esa.int/ESA_Multimedia/Images/2020/12/Interactive_map_of_the_sky_from_Gaia_s_Early_Data_Release_3) describes an observed all-sky brightness/colour map and offers equirectangular and Hammer versions, credited ESA/Gaia/DPAC; acknowledgement A. Moitinho. The [ESO panorama page](https://www.eso.org/public/images/eso0932a/) explicitly distinguishes its unavailable 800-million-pixel original from the public 6000x3000 image, credited ESO/S. Brunier. These are Solar-neighbourhood observational references, not arbitrary-observer 3D density reconstructions. No files from either are redistributed by this change. Quantitative astronomical appearance calibration and the full perceptual 8K target remain unverified; the supported result here is disappearance repair and demonstrably better detail retention in motion.
