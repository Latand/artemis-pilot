# Orbital exposure at accelerated time

The selected simulation rate, delivered time, ephemerides, gravity, object transforms, camera target and picking positions are unchanged. A point moving many pixels per frame cannot be made temporally accurate by interpolating just its two endpoints; a small moon can complete multiple revolutions between those endpoints.

Unresolved Solar System bodies therefore have a separate presentation layer:

- Below two projected pixels of orbital travel per presentation shutter, use the exact existing body and marker.
- Blend the marker and label into a colored curved exposure arc from two to fourteen pixels of travel. The shutter covers at least 1/30 real second, or the actual delivered frame when longer.
- Between 0.18 and 0.75 revolutions per shutter, continuously extend the arc into an orbit-averaged band. The complete band is phase-independent, so undersampled moons do not appear to orbit backward or blink around a ring.
- Pause immediately restores exact markers/labels. Reverse changes the arc direction. Rate changes take effect immediately, without an accumulating delayed visual clock.
- Selected bodies stay exact and camera-followed. The exposure fades out for resolved disks between 2 and 6 pixels radius; detailed close-up surfaces are not replaced with colored ribbons.
- Only visible orbital envelopes larger than three pixels receive geometry updates. Each has a fixed 64-segment allocation, with no physics substeps. No more than 31 bodies can be sampled, and typical inner-system views sample fewer than ten.

The Time Dock identifies the approximation while active: “Orbit motion averaged · pause for exact positions”. The arc itself is a guide, not a new selection target; navigation and picking still use the exact current body.

## Scope and limits

The curved exposure uses the current osculating two-body ellipse, holding its parent at its current position. Analytic planetary moons use their existing Kepler model. It does not reconstruct perturbations, encounters or the observer's full trajectory during the shutter. Unbound and near-parabolic trajectories are excluded. The layer currently covers the Solar System, not discovered exoplanet systems. Physically resolved, unfocused fast-moving bodies can still be undersampled; pausing or following that body gives an exact legible view.

Earth also receives its missing heliocentric orbit guide. Earth is not stored in the `PL` array, so the previous planet-ring loop never created one. Its guide now uses the same representative ellipse, Sun-centered transform, scale fade and destruction behavior as other planetary guides. It remains visible independently of temporal exposure.

## Verification

- `node scripts/smoke-orbital-exposure.mjs`: conic reconstruction, forward/reverse sampling, finite bounds, 24/30/60/120 Hz, pause/focus/scale gates, rate transitions and stable full-orbit averaging.
- `node scripts/verify-orbital-exposure.mjs`, with `DEVICE=mobile` for touch: real production WebGL sequences at 1x, 1/16/256 days per second, reverse, pause, resume, Earth–Moon and Jupiter-moon views, resolved focus, and gravity-flow on. Captures include physical-position equality, Earth-guide presence, bounded samples, errors and sampling overhead.
- Existing planet-phase, reverse, time-dock, physics and application checks remain required.

Visual approval requires inspecting the individual sequence frames, not just passing coordinate assertions. A software-renderer timing check is an overhead guard, not a consumer FPS claim.
