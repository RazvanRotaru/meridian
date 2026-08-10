# Design QA — Graph-first pull-request landing page

## Comparison target

- Source visual truth: the selected graph-left / actions-right concept, `exec-374effe1-1676-4a41-a15b-f98cc7ded542.png`.
- Browser-rendered implementation: `landing-graph-dock-public.png` in the active Product Design visualization folder.
- Combined comparison input: `landing-graph-dock-public-comparison.png` in the same folder.
- Viewport: 1280 × 720 CSS pixels and output pixels.
- State: signed out, Review selected by default, public repository `sindresorhus/type-fest` selected, 41 open pull requests loaded, picker closed.

## Findings

No actionable P0, P1, or P2 differences remain.

- Layout: The graph owns the 851 px left stage and the 429 px action dock owns the right edge. The 62 px header and dock footer remain in view; the document is exactly 1280 × 720 with no page scrolling.
- Action hierarchy: Review is first, selected, and keyboard-first. Explore remains one click away. Repository, state, author, and pull-request controls follow the selected concept's compact top-to-bottom rhythm.
- Primary action: The trust note and full-width CTA are pinned in the dock footer at the bottom of the viewport. Only the dock body scrolls when additional content is present.
- Renderer fidelity: The graph is a fresh 1440 × 1024 capture from the current built Meridian renderer, not a reconstructed or generated diagram. The public PNG is copied byte-for-byte into the CLI renderer bundle and served as `image/png`.
- Picker behavior: The PR picker opens below its input as a 164 px list at 1280 × 720, stays above the dock footer, and adds only internal dock-body overflow. The page itself remains fixed.
- Responsive behavior: At 390 × 844, the layout becomes a normal document with a 280 px graph stage above the dock. There is no horizontal overflow; after scrolling to the CTA, the sticky header remains at `top: 0` and the full CTA is visible.
- Accessibility: Existing labels, roles, `aria-pressed` state, focus behavior, source switching, preparation progress, device sign-in, and recent-work semantics remain intact.

## Deliberate differences from the concept

- The graph uses the real current renderer capture, so node positions, renderer chrome, and colors are product-authentic rather than illustrative.
- The desktop dock footer stays fixed while the body can scroll, ensuring the review action never falls below the viewport.
- Recent-work shortcuts remain available when browser-local history exists, but are not fabricated for the production screenshot.

## Verification

- [x] Compared the selected source and browser capture side by side at the same 16:9 viewport.
- [x] Verified Review-first ordering and Review-default state.
- [x] Switched Review → Explore → Review and confirmed the CTA and fields update.
- [x] Opened and closed the live PR picker; its list remains contained within the dock.
- [x] Verified desktop document dimensions, dock geometry, background image dimensions, and zero console warnings or errors.
- [x] Verified mobile page scrolling, sticky header behavior, CTA reachability, and zero horizontal overflow.
- [x] Replaced the README/how-it-works capture with the verified runtime screenshot.

final result: passed
