# Minimal graph = "Extract selection" (MEMBER / GHOST curation)

Rework the Module-map "Build minimal graph" so it **extracts the selected nodes as-is** into a
curated view, instead of decomposing/expanding them.

## Requirements (from the user)
1. Selected nodes are **members at their own level** — a selected package stays a package card.
   Never auto-decomposed into files, never auto-expanded into declarations, never interaction-pruned.
2. Inspect the selection **without the noise** of non-selected nodes.
3. **Excluded, related nodes appear as ghosts** (dimmed, present, not in the working set).
4. **Click a ghost to promote** it into the working set; **remove a member** back to ghost.

## Decisions (user-confirmed)
- **Sequencing:** build now on `feat/pr-diff-fullscreen`; accept a later merge with PR #102
  (`feat/minimal-single-expand-stub`), which rewrites the same files in a parallel session.
- **Ghost scope:** the **1-hop neighbours** of the current member set (restricted to on-map ids),
  not every non-selected node.
- **Demote:** a **selected-members panel** in the overlay listing members, each with a remove ✕.
- **Stubs:** **removed entirely.** Clicking a ghost is the only growth mechanism → therefore
  **promoting a ghost recomputes the ring** from the new member set (so you can reach past 1 hop by
  walking ghost→member→its ghosts). No `[+n]` expanders anywhere.

## Resolved open questions (defaults)
- **Expansion state:** members start **collapsed**; the overlay's own chevron still expands a member
  in place for inward inspection (user-driven, allowed). Do not inherit the map's `moduleExpanded`.
- **Group + file both selected:** a descendant member nests inside its ancestor-member frame; else flat.

## Model
- `minimalOriginIds: string[]` — the raw selection, verbatim (any kind). Immutable per build; the
  seed ring + Reset baseline. (Keep the field name `minimalSeedIds` to limit churn.)
- `minimalMemberIds: string[]` — mutable working set, starts = origin. Replaces `minimalKeptIds`.
- Ghosts are derived, not stored: 1-hop neighbours of members (on-map), minus members.
- Tiers keep the existing `seed | persistent | ghost` vocabulary: `seed` = origin member,
  `persistent` = promoted member, `ghost` = ghost. (Avoids touching paint/minimap/PR code.)
- Transitions: `promoteMinimalGhost(id)` (+member → relayout), `demoteMinimalMember(id)`
  (−member → relayout; reappears as ghost iff still 1-hop of a remaining member),
  `resetMinimalGraph` (members := origin).

## Build order (each increment ends green)
1. **Pure core + unit tests** — store slice (origin/member, promote/demote, stop calling
   `seedModuleIdsFor`, drop stub/expand coupling) and `minimalSubgraph` (members as leaf cards of any
   kind via lifted adjacency; ghost ring from members; `computeStubs` gone). Update
   `minimalSubgraph.test.ts` + add promote/demote cases. **PR closed-set path stays bit-identical**
   (all seed-tier, no ghosts) — regression-tested.
2. **Layout for group members** — `minimalSubgraphLayout` emits package/leaf cards (not just files);
   `mapPositions` captures package cards too. File-only case stays bit-identical.
3. **View** — `MinimalGraphView`: ghost single-click → `promoteMinimalGhost`; a members panel with
   remove ✕; panel title "N members"; Reset when members ≠ origin. Override/PR mode untouched.
4. **Cleanup + verify** — delete `selectionSeeds.ts` (+ test) and the stub node/type if fully dead;
   relabel the trigger "Extract selection (N)"; headless drive + screenshots.

## Risks
- Head-on file collision with PR #102 (parallel session) — mitigated by keeping logic in store/derive
  and the view diff additive; a manual rebase/merge is expected.
- Any `buildMinimalSubgraph`/`deriveMinimalGraphLayout` signature change touches `prMinimalGraph.ts`;
  invariant: PR output stays ghost-free, stub-free, seed-tier only.
