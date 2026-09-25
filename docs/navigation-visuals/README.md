# Navigation, external galaxies and compact screens

Continuation of merged PR #11. Baseline: `5a7a88b25ebb0319e7c6d2d8da4dddcdf7268e15`.

This pass addresses three reported failures:

- Sampled flight history forms crossing chords after deep-time jumps and retains too many old orbits.
- Resolved external galaxies have only smooth light profiles, and nearby non-Local-Group galaxies remain limited by GL point size. Merger debris uses isotropic light kernels.
- Narrow screens retain a tall sidebar, six camera buttons and an expanded time dock over the scene.

Implementation and browser evidence are in progress. This document is not a claim that visual or performance acceptance has passed. The existing physics, galaxy catalogs and previously merged Milky Way integration fixes remain the baseline.
