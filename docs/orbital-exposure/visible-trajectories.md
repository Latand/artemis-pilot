# Short visible-body motion previews

Explore mode defaults to a compact **Motion paths** toggle. This control is independent of the ship's prediction and gravity-inspector controls.

At most ten visible Solar System bodies, the ship, and player-placed holes are shown. A selected visible body wins priority. Previous selections receive a small priority advantage and overlapping anchors share one slot, so edge-of-screen or closely packed bodies do not continually replace each other. Each curved path has exactly 32 segments in a retained buffer.

- A solid short arrow shows the instantaneous parent-relative velocity, projected onto the current view. Its direction follows playback, including reverse. It does not use the end of the curved preview as a velocity estimate.
- A dashed curve is a local osculating two-body preview. Its parent is held at its current location; it is not a world-inertial forecast or the camera's future trajectory. Planetary moons use their current analytic ellipse.
- The preview aims for 65 pixels of motion and stops by 12% of a period. This keeps the displayed horizon useful at different zoom levels rather than assigning every body the same number of days.
- Ship and placed-hole paths are instantaneous linear estimates limited to 60 seconds. Solar System conics also fall back to that short estimate while placed holes, gravity debris, or disruption are active. The visible annotation identifies when linear estimates are included. Such paths do not promise an encounter, capture, or thrust prediction.
- Pause retains the current projection and direction; reversing playback reverses both the short sampled path and the separate tangent arrow.
- Motion exposure is a distinct solid/fading presentation of past motion. The new dashed previews show future motion in playback direction. Neither modifies simulation state or navigation targets.
- At undersampled playback rates, a body's sharp paths/arrows fade with its orbital exposure. Even a camera-followed body has its instantaneous guide faded if its orbital direction turns 10–60 degrees within the display shutter. A note explains this limit; pause restores the exact guide immediately. No slower or invented direction is substituted for the true velocity.

Current scope excludes discovered planetary systems, catalog/procedural stars, and galaxies. Their own analytic models and reference frames must be used before their previews can be included. A zero or directly line-of-sight projected velocity may have no useful arrow. Very short linear estimates can be subpixel at a system overview; their direction arrow remains the readable guide.

Verification: `scripts/smoke-visible-trajectories.mjs` and `scripts/smoke-visible-trajectories-integration.mjs` cover the cap, selected/stable priority, decluttering, scale and time bounds, exact state and anchors, reverse/pause, unchanged ship controls, and persistent geometry. Full production WebGL screenshots still require review before acceptance.
