# Disk-plane QA pointer input

The pixel fixture parks a real Playwright mouse over the existing `#exploreHelp`
toolbar button. The selector is present in `index.html`; `explorerUI.css` and
`compactExplorer.css` give it desktop and compact layouts outside `#gl`.
The button is never clicked. The fixture makes one move before adding the
diagnostic hole and one after each of four resizes, for five moves per root.
It alternates two interior points of the button to require a fresh trusted
mouse event at each planned park. There are no retries, synthetic events,
production-state setters, or forced mesh visibility changes.

Before accepting every frozen draw, including stability ablations, the report
must contain before/after evidence of a trusted mouse event, the button's live
`:hover` state and hit-test ownership, and read-only production hover state.
Both label/body hover targets must be empty and both world-space hover glyphs
must be invisible. The read-only hook records `scene.lastPtr`, the label pointer,
line positions/version, and the cone's position, quaternion, scale, matrix, and
material depth flags. It performs no GL reads.

`scene.lastPtr` is deliberately left under ordinary production input handling.
It is retained by the production canvas listener, so moving over a toolbar is
not assumed to clear it. If it still activates a glyph, the capture fails with
structured evidence; the fixture does not clear the variable as a fallback.
The normal existing app frames apply the pointer callbacks. App-frame, draw,
readback, exact-pixel, foreground-depth, and source-binding gates are unchanged.

Pointer evidence is persisted in each variant's `pointerEvidence` before its
acceptance assertion. Saved cases and stability cases refer to that evidence
by ID. An after-draw inspection error is recorded without skipping the existing
lens, bloom, or disk-depth restoration, and then fails pointer acceptance.

## Historical evidence and limits

Runs `37224058358` and `37228705833` had desktop exact-pixel failures. A retained
cyan hover cone from observation `37227613763` projects into both failing image
regions and matches the production hover geometry's length and scale. Mobile
explicitly suppresses the same glyphs. However, the failed captures did not
record hover flags or pointer-event timestamps, so the historical event order
and causal attribution remain unproven. The observation run's disappearing
mismatch remains inconclusive.

This input correction does not establish that rendering is fixed or excuse any
historical failure. A later authorized validation establishes only its own
result and must retain all exact comparison gates. The local preparation uses
only source checks and CPU mocks; actual visibility, trusted input, and neutral
state still require verification in that later run.
