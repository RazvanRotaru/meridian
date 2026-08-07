# Design QA — Task-first landing page

## Comparison target

- Source visual truth: the selected option 1 concept with option 2's recent-work section, normalized to the implementation capture size.
- Browser-rendered implementation: `implementation-landing-review-default.png` in the active Product Design visualization folder.
- Combined comparison input: `landing-comparison-review-default.png` in the same folder.
- Viewport: 1440 × 1024 CSS-pixel target; the in-app browser's 1429 × 1016 content capture was compared at its native size and the README copy was normalized to 1440 × 1024.
- State: signed out, Review selected by default, empty repository input, and three deterministic public-safe recent-work rows.

## Findings

No actionable P0, P1, or P2 differences remain.

- Typography: The two-line hero, supporting copy, task prompt, labels, and compact recent-work hierarchy match the selected direction while retaining Meridian's Space Grotesk and JetBrains Mono families.
- Spacing and layout rhythm: The implementation follows the concept's open left-column sequence—hero, task choice, repository field, primary action, source alternative, trust note, then recent work. All three recent rows remain above the fold at the target viewport.
- Colors and tokens: The existing Meridian dark palette, selected-state green, blue secondary accents, semantic renderer wires, and subdued hairlines are preserved. The selected task has the same green emphasis as the concept.
- Image and asset fidelity: The obsolete hand-drawn Canvas reconstruction was removed. The background is a 1440 × 1024 deterministic capture from the current built renderer using `examples/orders-service`, so its dotted canvas, compact cards, routed wires, action bar, zoom controls, and minimap are product-authentic. Task, source, trust, and GitHub icons continue to use Meridian's established Radix/GitHub sources.
- Copy and content: The implementation uses the selected friendly hero and task copy. Recent examples are injected only by the QA fixture; production renders validated browser-local history and never hardcodes the concept's illustrative repository names.
- Behavior and accessibility: Review is first in both visual and keyboard order and synchronized across the selected class, `aria-pressed`, hidden progressive fields, CTA copy, and runtime intent. Task buttons expose `aria-pressed`; source switching moves focus into the revealed source field; the GitHub field remains a labelled combobox; recent rows are native buttons with visible focus rings and source-specific accessible names. Repository and PR recents clear stale picker data and rerun the existing validated generation/preparation flows instead of persisting stale graph URLs or handoff claims.
- Responsiveness: At 390 × 844, task choices stack, the background recedes behind an opaque content scrim, the layout has no horizontal overflow (`379 px` document and viewport width), and all content remains reachable through normal page scrolling. The mobile hero retains the required space when its desktop line break is suppressed.

## Open questions

- None for the requested landing-page redesign.

## Implementation checklist

- [x] Match the selected task-first visual hierarchy.
- [x] Add up to three truthful browser-local recent shortcuts.
- [x] Exclude local paths, graph ids, view URLs, commit snapshots, and PR handoff claims from persistence.
- [x] Verify Review as the initial state, then Explore and Local modes in the in-app browser.
- [x] Verify repository and PR recent rows submit the expected source descriptors and navigate successfully.
- [x] Verify desktop and mobile layouts.
- [x] Replace the README landing image with the verified runtime capture.

## Follow-up polish

- [P3] The runtime capture uses Meridian's representative orders-service nodes rather than the concept generator's illustrative filenames. This keeps the landing faithful to the shipped product while preserving the selected composition.
- [P3] Recent rows favor compact type and source metadata over the concept's decorative badges, keeping every persisted field semantically truthful.

## Comparison history

- Pass 1: Opened the layout, recent hierarchy, and source action; the first implementation was too compressed below the primary action.
- Pass 2: Added the concept's divider rhythm, established product icons, left-aligned trust/source affordances, and smaller right-side graph nodes.
- Pass 3: Corrected the hero line break and scale, aligned vertical rhythm, added the GitHub input icon, and rechecked the combined source/implementation image. No P0/P1/P2 mismatch remained.
- Pass 4: Switched the synchronized initial workflow to Review and replaced the old Canvas reconstruction with a capture from the current renderer.
- Pass 5: The 390 px check exposed a missing space where the desktop hero break is hidden; corrected it, repeated mobile and desktop comparison, and found no remaining P0/P1/P2 difference.
- Pass 6: Moved Review ahead of Explore in the DOM so the visual, reading, and tab orders all match the default workflow; refreshed the README and comparison captures.

## Primary interactions tested

- Verified Review is selected on first render, then switched to Explore, Local, and back; the heading, fields, CTA, inverse source action, and recents visibility updated correctly.
- Verified keyboard focus follows source switches and each recent-work row has a visible focus treatment and a source-specific accessible name.
- Switched to Review with an empty repository; repository-first progressive disclosure remained intact.
- Reopened `openai/openai-python` at `main`; the normal generate request received exactly the stored GitHub source and branch.
- Reopened PR `#418`; the normal prepare request received repository, PR number, base ref, and head ref with no stored `headSha`, graph id, URL, or handoff claim.
- Forced a recent repository reopen to fail and confirmed the restored branch remained available while fresh picker metadata was requested.
- Verified the 390 × 844 stacked layout and absence of horizontal overflow.

final result: passed
