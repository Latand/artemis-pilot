Artemis exploration and time UX

The operator's September 13 direction prioritizes freely exploring space and gravity, with time control central and spacecraft piloting secondary. The July 12 original prompt requested a complete UX rethink for gravity, planets, compact objects, dark energy and cosmic phenomena. Existing work organizes these into observe, inspect, control time, create and compare.

Base: local main 8bc8fa8bb0806ff8de0b53731b3e3c9da997aee7. It includes nine unpublished commits after remote main 62e80d8: identity, modes, time authority, Time Dock, contact math, events, approach predictions, TDE determinism and model documentation. Preserve this foundation. Rendering PR #2 remains separate.

Implement a coherent exploration entry point: default to Earth for fresh Explore sessions, expose object search and destinations, show selected-object context, and provide mouse/touch movement plus keyboard free camera without thrust. Keep Pilot and Create available through explicit mode controls. Restore normal Tab navigation and protect typing in forms from global shortcuts.

Make time controls understandable: persistent date, playback and direction, readable speed presets with per-second meaning, and visible access to existing event jumps. All time actions must use timeCtl and preserve pause, cancellation, reverse limits and delivered-time reporting. Keep model status and refusal reasons available. Changes to the physics integrator or event models are out of scope.

Verify desktop/mobile layouts, keyboard and pointer controls, search typing, focus selection, camera movement while paused, unchanged ship state during camera movement, mode transitions, time preset/direction/pause controls, event access and relevant existing smoke suites. Capture before/after browser evidence, check console errors and build. Publish a reviewable PR with this nine-commit base dependency explicit; no deployment.
