# Match explicit render quality after deferred startup

The first startup-quality hosted run (`352a717`, workflow `37451131979`)
completed baseline and candidate functional routes on desktop and mobile. Its
paired measurement stopped before timing: the old app had rendered one
initialization frame, while the new app correctly deferred that frame; candidate
Auto also selected software Minimal, unlike the old full-detail baseline.
The raw failed reports remain evidence. The desktop sequential system-overview
comparison was +7.5%; that comparison remains non-authoritative under the
existing protocol and is not relabeled as passing.

The corrected fixture requests explicit High on both revisions. High restores
the old framebuffer AA and full particle allocation. Each source receives
exactly one untimed initialization frame: the test calls the real frame only
when the source has not delivered one. It does not add a second frame to the old
source or change the production frame body. The existing 120 warmup frames and
all five ABBA/BAAB trials with 60 samples per block remain unchanged.

The strict workload equality assertion still compares frame ordinal, cursors,
seeds, all minor-swarm records/capacities, mobile classification, physics rate,
mode and camera/ship/maps. The obsolete internal `loadShed` ordinal is replaced
with actual DPR, context antialiasing, river capacity and active bloom/lensing/
volume paths. New negative controls reject a mismatch in any of those six
render properties. The archived benchmark digest is reconstructed by reversing
only these explicit fixture adaptations plus its pre-existing render-call hook.
All unknown edits, performance thresholds, sample counts and trial-order changes
remain detectable.

No 5% p95 or long-task budget changes. No performance acceptance is claimed
until the corrected paired hosted measurement succeeds. Default startup and
adaptive behavior are separately covered by `verify-adaptive-quality.mjs`;
this fixed-detail performance comparison does not replace those checks.
