# Design QA: PR review discussion filter

## Reference and implementation

- Reference: selected Product Design concept 2 (`exec-ae07694a-91db-4066-8643-85163fe1f872.png`)
- Implementation capture: `artifacts/pr-comment-filters/option-2-initial.png`
- Combined comparison: `artifacts/pr-comment-filters/design-qa-comparison.png`
- Viewport: 1440 x 1024

## Visual review

- The Discussion toolbar occupies the same location immediately above Files changed.
- Typography, dark surfaces, restrained borders, compact spacing, and blue active treatment match Meridian's existing review and search-modal language.
- The dropdown trigger carries the active scope and result ratio; its menu uses checked rows and right-aligned counts as in the selected concept.
- The visibility action is a compact icon control at the far edge of the toolbar.
- Pending drafts remain separate from GitHub comment filtering and render as an amber count chip when present.
- The implementation capture's fixture had no pending draft and the dropdown was closed; those are data/interaction states rather than layout differences. Both states are covered by the implemented control logic and renderer tests.

## Interaction and accessibility review

- All, Mine, and Participated update every existing-comment projection: files, code rows, and graph indicators.
- Pending comments remain visible in every filter mode.
- Changing filters re-enables comment visibility so a selected focus always produces visible feedback.
- The menu supports Arrow Up/Down, Home/End, Enter/Space, Escape, focus return, and outside-click dismissal.
- Menu rows expose `menuitemradio` and `aria-checked`; the trigger and visibility toggle expose descriptive accessible names and state.

## Validation

- Renderer typecheck: passed.
- Renderer tests: 225 files, 2017 tests passed.
- Monorepo production build: passed.

final result: passed
