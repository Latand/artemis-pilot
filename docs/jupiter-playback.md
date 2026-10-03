# Guided Jupiter slingshot

Select Travel simulations → Jupiter slingshot, then Start flight. The ~60-second sequence accelerates the approach and departure, slowing smoothly around closest approach. Pause and Resume retain the exact position. Restart resets only this excursion; Exit (or Escape) restores the pre-scenario flight, clock, camera, settings, black holes, gas formations, encounter state, autopilot and relativistic-travel state. The browser quicksave slot is not touched. Changing Time / second exits the guided excursion before applying the new user-selected rate. Other scenarios retain their existing behavior.

## Physical scope

The initial state is a genuine three-dimensional hyperbolic encounter in Jupiter's live orbital plane. Its osculating two-body targets are 3.5 Jupiter radii at periapsis and 5.6 km/s asymptotic Jupiter-relative speed. The finite entry speed includes the gravitational potential term; it is not incorrectly treated as the asymptotic speed. The production integrator advances the flight under its normal gravity model with no thrust. The seed does not author or interpolate a ship path.

The ship is a test particle: Jupiter's immeasurably small recoil is not applied. Planet-relative energy/angular momentum have small solar perturbations. The changing Sun-relative velocity is a real consequence of passing the moving planet, not a camera animation. Equal-radius entry/exit speed readouts are shown as measured, not claimed to be asymptotic velocities.

The hull is enlarged as a navigation illustration. The existing river shows the natural gravity velocity field; it is not evidence of physical space flowing or a warp propulsion system. No speculative propulsion is engaged by this ballistic scenario.

## Playback contract

`scenarioPlaybackMath.js` is DOM-free. The reusable monotone cubic playhead maps presentation seconds to requested simulation seconds with continuous rate ramps. The app uses the normal `stepWorld` entry point, then derives progress from actually delivered simulation time. A budget shortfall stretches the presentation instead of changing positions or falsely marking completion. Individual wall-delta requests are capped at 120 ms; hidden tabs and graphics-context interruptions drain the app clock without advancing the scenario. Extremely slow rendering can therefore extend the advertised approximate duration.

`scenarioPlayback.js` owns this one guided excursion, its in-memory return snapshot and UI. The main loop calls tick before world advance, settlement after advance, and camera framing after ordinary focus calculation. Both ship and Jupiter are kept inside the desktop/portrait frustum. Focus changes, cockpit entry, manual flight input, a different time driver and XR entry cancel the guided sequence. Quicksave loading restores the return state before applying the requested saved universe.

## Checks

- `npm run smoke:scenario-playback`: three epochs, actual production ship integrator, positive hyperbolic energy, angular momentum, periapsis, heliocentric gain, no propulsive Δv, continuous monotone timing, delivered-time inversion, variable frame rate and stall/completion bounds.
- `npm run verify:scenario-playback -- <output-directory>`: actual app desktop/mobile button flows, the full clock-driven main loop, phase screenshots and projected motion samples, pause/resume, restart, complete hold, return-state equality and panel overflow.
- The GitHub Actions workflow preserves the exact tested head and individual phase screenshots. Its deterministic clock input is a QA hook only, injected by the browser harness; production code has no test clock.
