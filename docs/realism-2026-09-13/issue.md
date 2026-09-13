The current rendered Earth has a thick saturated blue shell, a hard white ocean highlight, and no default cloud layer. Planet illumination, photosphere rendering, and stellar point sizes need a coherent photographic treatment.

Recovered operator requirements (original conversation turns, 14 June and 13 July 2026 Kyiv): maximum realism and scientific correctness with efficient interaction; real stellar positions and properties; visual inspection at every scale; black space background. This lane addresses planet/star appearance within the existing simulation.

Scope: `src/bodies.js`, `src/textures.js`, `src/realSky.js`, `src/stars.js`, the cosmic/AT-HYG render shaders, rendering helpers, and dedicated visual verification/evidence. Preserve the unpublished UI/time/events/physics work on local main and all existing worktrees. Paginated GitHub inventory before this issue found zero open PRs and zero open issues, including zero user-authored open issues.

Acceptance:
- Improve Earth surface illumination, terminator, ocean reflection, clouds and thin atmosphere; improve rocky/gas-planet lighting and surface readability using the existing attributed maps.
- Resolve stellar color/luminance/angular-size problems seen in the baseline, retain magnitude ordering, and avoid stars showing through opaque planets.
- Preserve physical radii, dynamics and catalog data. Keep rendering bounded, stable when paused and across scale transitions.
- Capture and visually inspect identical fixed-epoch/camera before/after Earth, rocky planet, gas giant, Sun and star-field scenes. Record browser errors and performance; run relevant physics/rendering smoke gates and build.
- Publish a linked, reviewed PR with images, reproducible commands and scientific limitations. No merge or deployment.
