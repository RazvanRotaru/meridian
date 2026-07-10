# Lens-carry extensions: multi-anchor, selection panel, scoped Service view

Extends PR #116 (cross-lens path carry) with three features decided with the user on 2026-07-10:
multi-anchor carry, an explicit per-selection reveal panel in the sidebar, and a scoped Service
sub-view (owning cluster + 1-hop) with a breadcrumb exit.

## 1. Multi-anchor carry

Today `anchorNodeId` collapses `moduleSelected` to `firstOf(set)` — an arbitrary pick. Replace the
single-anchor pipeline with a list pipeline:

- `anchorNodeIds(state): string[]` — for `modules`/`call` returns **all** of `moduleSelected`
  (else the effective focus / focus as a singleton); `ui` → `[selectedId ?? focusId]`; `logic` →
  `[logicRoot]`. Empty array when nothing is anchored.
- Per-lens **many** variants union the per-anchor reveals, dropping unplaceable anchors:
  - `mapRevealStateForMany(anchors, index)`: focus = the **deepest common `package` ancestor** of
    the placeable anchors (null → repo root when they share none); expanded = union of
    `containersOnPath(anchor, index, commonFocus)`; selected = all placeable anchors.
  - `serviceRevealStateForMany(anchors, index, edges)`: run `deriveServiceClusters` **once**, then
    per anchor resolve unit → lead; expanded = union of `frameIdOf(lead)` + containers below the
    unit; selected = all placeable anchors; `moduleFocus` stays null (lens invariant).
  - `uiRevealStateForMany(anchors, index)`: expanded = union of `withAncestorsOf`; `selectedId` =
    first placeable anchor (the UI lens has single selection); keep the render-subtree dive only
    if it contains **every** placeable anchor.
- Fallback to the lens top **only when no anchor is placeable** (unchanged semantics, now over the
  whole selection instead of an arbitrary first element).
- `setViewMode` switches to the many-variants; single-selection behavior is unchanged by
  construction (union of one = today's reveal).

## 2. Selection panel (sidebar, under the lens switcher)

New `SelectionPanel` component rendered in `Toolbar.tsx` directly below the Lens group. Visible
whenever the active lens has a selection (`moduleSelected` on Map/Service, `selectedId` on UI).

**Revised (user decision, post-implementation): the explicit "Reveal in <lens>" buttons are
dropped** — the implicit carry on lens switching already covers reveal, so the buttons were a
redundant alias for `setViewMode`. The panel is now just the selection header (selected node
names, capped list, "+N more") plus the single **Scope Service view** button (feature 3 trigger),
enabled iff at least one anchor resolves to a service cluster — the same
`serviceRevealStateForMany` gate the carry uses; when disabled it carries the reason
"No service cluster owns this selection" as its tooltip. Placeability must not re-cluster per
render: clustering depends only on the graph, so `deriveServiceClusters` stays memoized per
`index` (module-level WeakMap cache shared with the carry).

## 3. Scoped Service sub-view (owning cluster + 1-hop)

New store state `serviceScope: { leadIds: string[]; label: string } | null`.

- `openServiceScope()`: from the current anchors → owning cluster lead(s) → scope = those leads
  plus every cluster coupled to them in **either direction** (from `ServiceClustering.couplings`
  lifted to leads). Label = first owning lead's display name (+ count when several). Sets
  `viewMode: "call"`, seeds `moduleExpanded`/`moduleSelected` via `serviceRevealStateForMany`,
  relayouts.
- `clearServiceScope()`: null the scope, relayout (full Service lens).
- `deriveServiceTree` gains an optional `scopeLeadIds?: ReadonlySet<string>`: after clustering,
  keep only scoped clusters; couplings render only when both lifted endpoints are in scope.
  Consistent with the lens's no-ghost rule: out-of-scope edges are dropped, not ghosted.
- Scope clears whenever the lens is left (`setViewMode` to any other mode), mirroring how the
  minimal-graph overlay closes.
- **Exit affordance**: in the Service lens the (currently inert) `LevelBreadcrumb` renders
  `All services › <label> ✕` while scoped; clicking "All services" or ✕ calls
  `clearServiceScope()`.
- Deep links: scope is session-only (not URL-round-tripped) — YAGNI until asked.

## Testing

- `lensPath.test.ts`: multi-anchor union per lens, mixed placeable/unplaceable selections,
  fallback only when nothing is placeable, common-ancestor focus on the Map.
- New scoped-tree test: scoped `deriveServiceTree` yields owning + 1-hop clusters only, drops
  out-of-scope couplings.
- Store-level test for `openServiceScope`/`clearServiceScope` transitions.
- Headless Playwright drive on shopfront: multi-select two services on the Map → Service lens
  shows both frames opened; scope from `CartService` → only its cluster + neighbors drawn;
  breadcrumb exit restores the full lens.
