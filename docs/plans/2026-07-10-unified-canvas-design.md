# Unified graph canvas: one base surface for Map, Service, UI, and the minimal overlay

Follow-up to PR #116, decided with the user on 2026-07-10. The Map lens is the reference; a base
canvas extracted from it is applied to every graph view so the lenses behave the same. Decisions:
**full UI-lens unification** (Map's cards and machinery, not just behaviors), **Service focus =
zoom into one cluster** (containment dive; Scope remains the coupling filter), **Service ghosts on
with expand-based reveal**, and **ghost promotion ("+") generalized** to every surface.

## Where the code already is (post-#128)

Map, Service, and the minimal overlay share one component set, one layout (`layoutModuleTree` /
map-mirror), one paint chain (`moduleMapHighlight` via `paintMinimal`), one interaction hook
(`useModuleNodeInteractions`), and one expansion id-space (`moduleExpanded`). #128 unified the
overlay's ghosts onto the Map's projection (`ghostDepWires` + `groupGhostEmission` +
`placeGhostBands`, shared `withoutHidden`). The remaining seams:

1. **Tree derives**: `deriveModuleTree` (Map) / `deriveServiceTree` (Service) /
   `buildMinimalSubgraph` (overlay) / `computeVisible`→`deriveLayout` (UI — the outlier).
2. **Focus models**: `moduleFocus` (Map) / none (Service; `serviceScope` is a filter, not a zoom) /
   none (overlay) / `focusId` (UI).
3. **Ghosts**: Map+overlay unified; Service deliberately none; UI none.
4. **Highways + relationship colors**: Map+Service full; overlay spool-only (flat graph — correct);
   UI none (renders-only edges, separate `BlueprintEdge`).
5. **Minimal graph**: Map full; Service button renders but `svc:` frame seeds don't decompose;
   UI absent.
6. **Promotion**: overlay-only ("+" promotes a satellite's home file into the member set).
7. `CompositionView` is dead code; the `comp*` slice feeds only `CompositionPanel` (a Toolbar side
   panel) and the dead component.

## Target architecture

### The base canvas

`components/canvas/GraphSurface.tsx` — the shared React Flow surface extracted from
`ModuleMapView`: modulemap node/edge types, the three highway passes (`bundleEdges` →
`routeFrameEdges` → `spoolFanEdges`, each pass opt-in per surface shape), the paint chain
(`suppressRedundantImports` → `filterRelKinds` → `emphasize`), `WireTooltip`, ghost band placement,
recenter, breadcrumb slot, and the selection-driven action strip (Build minimal graph). Surfaces
mount `GraphSurface` with a `SurfaceSpec`.

### SurfaceSpec (the seam made explicit)

```ts
interface SurfaceSpec {
  deriveTree(state): { nodes; edges; effectiveFocus };   // the ONLY required difference
  focus: { of(state): string | null; dive(id): void; crumbs(state): Crumb[] };
  ghostReveal(id): void;        // Map/UI: focus-based; Service: expand-frame-based
  minimalSeeds(selection): string[];  // decomposes svc: frames to cluster members
  highways: { bundling: boolean; routing: boolean; spooling: boolean };
}
```

Store-side, a `viewMode → SurfaceSpec` registry replaces the scattered `viewMode === "call"`
ternaries (`moduleRelayout`, `useModuleNodeInteractions`, `applyScoped`, `moduleTreeNodes`).

### Per-surface work

- **Service**: gains ghosts (same `ghostLevel` projection; reveal opens the owning cluster frame +
  selects — never sets a folder focus) and focus (double-click a cluster frame header zooms into
  that one cluster; breadcrumb `All services › CartService`; coexists with Scope — focus is
  containment, Scope is the coupling-neighborhood filter). Minimal-graph seeds from a `svc:` frame
  decompose to the cluster's member units.
- **UI**: full unification. A new `deriveUiTree` produces `VisibleModuleNode[]` through the shared
  `codeWalk`, rooted at `uiFocusTarget`, edges filtered to `renders` (+ the dep wires of expanded
  cards, colored by the shared relationship palette). The UI lens keeps its identity as the
  renders-rooted projection but renders Map cards, shares `moduleExpanded`/`moduleSelected`/
  `moduleFocus` (its `expanded`/`selectedId`/`focusId` slices are migrated and deleted), and gains
  ghosts, highways, minimal graph, and multi-select. `FlowCanvas`, `ContainerNode`, `LeafNode`
  are deleted (Logic keeps its own standalone render — out of scope per PR #116's scope note).
- **Overlay**: already conforms; it becomes a `SurfaceSpec` with `highways: spool-only` and
  no focus.
- **Promotion generalized**: `GhostNode` renders the overlay's "+" on every surface. On the
  overlay it keeps promoting into the member ring; on Map/Service/UI it pins the ghost's home
  file into `mapExtra` (the ⌘P "add to view" mechanism) — one gesture, one meaning: "make this
  ghost permanent on this canvas".
- **comp\* cleanup**: delete `CompositionView`; keep `CompositionPanel` (side panel, not canvas);
  excise store fields only the dead component read.

## Phasing (each phase lands green before the next starts)

- **A — extract the seams** (no behavior change): `GraphSurface` + `SurfaceSpec` registry;
  ModuleMapView and MinimalGraphView become thin mounts; store ternaries collapse into the
  registry. Golden: every existing renderer test still passes untouched.
- **B — Service parity**: ghosts + expand-reveal, cluster-frame focus + breadcrumb, minimal seeds
  from frames.
- **C — UI unification**: `deriveUiTree`, slice migration, component deletion.
- **D — general promotion**: "+" on all surfaces → `mapExtra` pin (overlay unchanged).
- **E — the CI parity suite**: the ONLY tests this project wants (user decision) — a table-driven
  spec proving the four views behave the same, run in CI, plus a headless parity drive.

## Verifying the lenses behave the same (phase E detail)

**POC verification convention (user decisions, 2026-07-10): no TDD, and exactly one test suite.**
Iterate first; features are verified by driving the app, not by writing tests. The single
exception — explicitly wanted as CI tests — is the **cross-lens parity suite**: tests that the
Map, Service, UI, and minimal-graph views behave the same. No other new tests ("just those").

`surfaceParity.test.ts` runs each capability against each `SurfaceSpec` over one fixture graph:
same off-level dep ⇒ ghost with the same node id everywhere; same expand toggle ⇒ same
`moduleExpanded` delta and same cards drawn; focus dive ⇒ breadcrumb crumbs with the surface's
root label; same edge kind ⇒ same relationship color; same selection ⇒ same minimal member set
(frames decomposed); same ghost ⇒ promotion pins the same file. It runs with the normal vitest
suite in CI. A headless Playwright drive (select → expand → focus dive → scope → ghost-reveal →
promote → extract, replayed per lens with screenshots) backs it as the e2e layer, wired into the
CLI's existing `e2e` script.

## Known layout pathologies the unification must fix (user-reported)

- **UI lens single-column stacking**: `buildElkGraph`'s root options lack `elk.aspectRatio`
  (the Map sets 1.6, `moduleLevelLayout.ts:89`), so ELK stacks disconnected components
  vertically. Phase C fixes this by construction — the UI projection adopts the Map's
  `layoutModuleTree` path. Acceptance: a renders-forest with several roots lays out packed, not
  one column.
  **Enforcement (user: "make sure those elk options are never used again")**: the canonical root
  options now live in `layout/elkCanvasOptions.ts` — the ONLY place `elk.*` root literals may be
  defined (CLAUDE.md gotcha added). `moduleLevelLayout.ts` and `buildElkGraph.ts` switch to
  importing it (the swap lands right after phase B to avoid colliding with its in-flight review;
  phase C then deletes `buildElkGraph.ts` entirely). The CI parity suite asserts every
  `SurfaceSpec` layout path uses `CANVAS_ROOT_ELK_OPTIONS` by identity, so a forked config can
  never come back silently.
- **Minimal overlay column growth on "+" promote**: `placeMinimalNodes` places promoted files
  with no import edge to an already-placed member via `placeDisconnectedFiles`, which stacks
  them in a vertical band (`V_STEP` stepping). Phase D fixes placement: a promoted ghost's home
  file inherits the ghost card's current band position (it is already on screen — keep it where
  the reader's eye is) instead of falling into the disconnected column.
