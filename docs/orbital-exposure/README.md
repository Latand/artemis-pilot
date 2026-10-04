# Orbital exposure at accelerated time

The selected simulation rate, delivered time, ephemerides, gravity, object transforms, camera target and picking positions are unchanged. A point moving many pixels per frame cannot be made temporally accurate by interpolating just its two endpoints; a small moon can complete multiple revolutions between those endpoints.

Unresolved Solar System bodies therefore have a separate presentation layer:

- Below two projected pixels of orbital travel per presentation shutter, use the exact existing body and marker.
- Blend the marker and label into a colored curved exposure arc from two to fourteen pixels of travel. The shutter covers at least 1/30 real second, or the actual delivered frame when longer.
- Between 0.18 and 0.75 revolutions per shutter, continuously extend the arc into an orbit-averaged band. The complete band is phase-independent, so undersampled moons do not appear to orbit backward or blink around a ring.
- Pause immediately restores exact markers/labels. Reverse changes the arc direction. Rate changes take effect immediately, without an accumulating delayed visual clock.
- Selected body centers stay exact and camera-followed. Orbital exposure fades out for resolved disks between 2 and 6 pixels radius; their surface rotation has the separate texture exposure below.
- Only visible orbital envelopes larger than three pixels receive geometry updates. Each has a fixed 64-segment allocation, with no physics substeps. No more than 31 bodies can be sampled, and typical inner-system views sample fewer than ten.

The Time Dock identifies the active approximation as orbit, surface, or combined averaging and offers pause for exact detail. The arc itself is a guide, not a new selection target; navigation and picking still use the exact current body.

## Scope and limits

The curved exposure uses the current osculating two-body ellipse, holding its parent at its current position. Analytic planetary moons use their existing Kepler model. It does not reconstruct perturbations, encounters or the observer's full trajectory during the shutter. Unbound and near-parabolic trajectories are excluded. Orbital translation exposure currently covers the Solar System; surface-rotation exposure also covers discovered planets and their moons. Stellar granule evolution is a separate model, not planetary rotation. Physically resolved, unfocused fast-moving bodies can still be undersampled; pausing or following that body gives an exact legible view.

Earth also receives its missing heliocentric orbit guide. Earth is not stored in the `PL` array, so the previous planet-ring loop never created one. Its guide now uses the same representative ellipse, Sun-centered transform, scale fade and destruction behavior as other planetary guides. It remains visible independently of temporal exposure.

## Close-up rotation

Planet and moon meshes retain their exact current spin angles. When texture features rotate through the presentation shutter, longitude prefix-integral textures average their linear-light colors across that interval, preserving latitude. A shutter spanning a complete revolution uses the phase-independent row mean. Earth day, night, cloud shadows and cloud alpha share the treatment; generic normal detail and procedural grain fade as their rotation becomes unresolved. Pause selects the original texture immediately.

Integral textures are prepared in short idle slices from the current map, using bounded row-strip readback. The render call only queues work and keeps exact shading until ready. Shared map sources reuse one reference-counted integral, including Earth cloud shadow/alpha. Source bins are capped at 512×256, or 256×128 on compact/low-memory devices; ready caches are limited to 24 MiB/8 MiB respectively, plus one in-progress map. They use nearest-filtered floats with explicit interpolation, without requiring a float-linear extension. This is a display-only longitude exposure, not a new orientation clock or a change to sunlight, physics, or the selected time rate. The short future previews are separately documented in [visible-trajectories.md](visible-trajectories.md).

## Verification

- `node scripts/smoke-orbital-exposure.mjs`: conic reconstruction, forward/reverse sampling, finite bounds, 24/30/60/120 Hz, pause/focus/scale gates, rate transitions and stable full-orbit averaging.
- `node scripts/verify-orbital-exposure.mjs`, with `DEVICE=mobile` for touch: real production WebGL sequences at 1x, 1/16/256 days per second, reverse, pause, resume, Earth–Moon and Jupiter-moon views, resolved focus, and gravity-flow on. Captures include physical-position equality, Earth-guide presence, bounded samples, errors and sampling overhead.
- `node scripts/smoke-surface-exposure.mjs`: periodic linear-light integrals, latitude/flipY, 30/60/120 Hz, forward/reverse, pause, stable high-rate output and resource lifecycle.
- `node scripts/smoke-visible-trajectories.mjs` and `node scripts/smoke-visible-trajectories-integration.mjs`: capped stable candidate selection, exact-state previews, perspective-correct velocity arrows, reverse/pause and conservative linear limits.
- Existing planet-phase, reverse, time-dock, physics and application checks remain required.

Visual approval requires inspecting the individual sequence frames, not just passing coordinate assertions. A software-renderer timing check is an overhead guard, not a consumer FPS claim.
