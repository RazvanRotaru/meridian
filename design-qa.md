# Design QA — Affected Logic Flows header

## Comparison Target

- Source visual truth: selected concept 1, preserved as the left-hand source capture in `artifacts/pr-related-flows/design-qa/option-1-vs-implementation.png`
- Browser-rendered implementation: `artifacts/pr-related-flows/design-qa/implementation-active.png`
- Viewport: source normalized from 1672×941 to 1280×720; implementation captured at 1280×720
- State: PR #7 prepared in the graph, `loyaltyTierFor` selected, Affected Logic Flows expanded, Related filter active
- Full-view comparison: `artifacts/pr-related-flows/design-qa/option-1-vs-implementation.png`
- Focused header comparison: `artifacts/pr-related-flows/design-qa/option-1-header-vs-implementation.png`

## Findings

No actionable P0, P1, or P2 differences remain.

- Typography: The implementation preserves the product's existing uppercase section-label treatment, compact count text, and semantic green status badge. The complete `AFFECTED LOGIC FLOWS` title remains readable instead of inheriting the mock's generated truncation.
- Spacing and layout rhythm: The disclosure, stable totals, new badge, and Related control share one 22 px header row. The trailing control remains separated from the disclosure hit area and the list begins immediately below the divider, matching the selected direction.
- Colors and tokens: The inactive and active controls use Meridian's existing review-panel borders, foregrounds, and blue pressed-state tokens. The green `2 new` state remains consistent with the list's `NEW` badges.
- Image and asset fidelity: This component introduces no image asset. Existing graph, toolbar, and review-panel assets remain unchanged and sharp in the browser capture; no placeholder, CSS-art, or substitute graphic was added.
- Copy and content: The compact `Related 1` label communicates both the action and result count. The long explanatory hint was removed from the visible header and retained as disclosure help text.
- Icons and affordances: The existing disclosure glyph remains attached only to the expandable left side. The Related control intentionally omits the mock's generated trailing arrow because it is a pressed-state filter, not navigation.
- Behavior and accessibility: The disclosure exposes `aria-expanded` and `aria-controls`; the filter exposes a selected-node-specific accessible name and `aria-pressed`. Activating the filter keeps `0/2 · 2 new` stable, shows `loyaltyTierFor`, and removes `reviewFixtureMarker`.
- Responsiveness: At the default 380 px PR-review rail, the full title and trailing action fit without wrapping or overlap. The title has an ellipsis fallback for narrower splitter positions.

## Open Questions

- None for the requested header redesign.

## Implementation Checklist

- [x] Keep disclosure and Related filtering as independent controls.
- [x] Keep aggregate progress totals stable while filtering.
- [x] Preserve a single compact row at the default PR-review width.
- [x] Verify inactive, active, and restored list states in the browser.
- [x] Check browser console errors; none were present.

## Follow-up Polish

- [P3] The first flow name truncates slightly earlier than the generated mock at the default rail width. This predates the header placement change and does not obscure which flow is selected or block the filter interaction.

## Comparison History

- Pass 1: The normalized full-view and focused header comparisons found no actionable P0/P1/P2 mismatch, so no post-comparison visual fix was required. Evidence is the full-view and focused comparison files listed above.

## Primary Interactions Tested

- Selected `loyaltyTierFor` from the extracted graph.
- Closed the code preview and confirmed the compact Related control appeared in the header.
- Activated Related and verified only the related flow remained.
- Deactivated Related and verified both affected flows returned.
- Confirmed the disclosure totals remained `0/2 · 2 new` throughout.

final result: passed
