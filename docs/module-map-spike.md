# Spike: Module Map (import blast-radius) lens

**Status:** spike / draft PR. A 4th renderer lens that reinvents "service composition" around the
**import graph** rather than behavioural coupling.

> One-liner: start at the app's entry module, walk the **import** graph N levels deep (a "blast
> radius" depth slider), and render the reachable **files** grouped into **directory clusters** laid
> out as concentric depth-rings — with toggles to hide utils/ui/config noise.

This is deliberately a *new* lens (`viewMode: "modules"`, labelled **"Module map"**). The shipped
SOLID "Service composition" lens (`viewMode: "call"`) is left untouched as a control group — the two
answer different questions (health report vs. structural composition).

---

## Why a new lens, and what "reinvent" means here

The existing `call` lens is a **SOLID scorecard map** — units are classes/modules ranked by Martin
metrics, wired by *behavioural* coupling (calls/instantiates/extends/implements). The ask here is a
different question: *"what does the app, from its entry point, structurally pull in — file by file,
directory by directory, at a chosen radius?"* That is a **module map**, driven by declared
**imports**. `docs/service-composition-design.md` already parked exactly this (its §7 imports layer /
§8.6 entry-rooted default) — this spike cashes both cheques.

---

## Resolved design decisions (the 4 forks)

1. **Import graph = real `imports` edges** (not a behavioural proxy). A new extractor pass emits
   module→module `imports` edges. Rationale: a proxy would just re-skin the existing coupling graph
   and would miss type-only / re-export / side-effect imports (a large fraction of TS structure) —
   giving *wrong* blast-radius depths. `imports` is already in the edge-kind vocabulary, so **no
   schema change**. Emitted **always-on** (no flag) so `meridian web` gets it for free.
2. **Entry seed = reuse `artifact.extensions.entryModules[0]`** (+ name heuristic fallback +
   double-click re-root). Every fixture's tsconfig `files` is empty, so a literal tsconfig reader
   would fall back to the same `index.ts`/`main.tsx` conventions `cli/src/entry-points.ts` already
   implements. Reading the entry *from tsconfig* is a deferred follow-up (see below).
3. **"Module" = directory (`package` node) frame containing file (`module` node) cards.** Matches
   the user's "clusters of files"; reuses `buildClusters`/`clusterIdOf` verbatim.
4. **Layout = concentric depth-rings.** Frames placed on circles keyed by BFS distance from the
   entry (entry at center); files grid-packed inside each frame. Custom, deterministic, **no ELK** —
   React Flow ignores ELK edge routes here anyway, so leaving `layered` costs nothing. Dragging the
   slider 1→2→3 literally grows a new ring — that's the demo.

---

## Architecture / file map

**Extractor (real import edges):**
- `packages/extractor-typescript/src/import-pass.ts` — walks `getImportDeclarations()` +
  re-exporting `getExportDeclarations()`, resolves `getModuleSpecifierSourceFile()` to in-project
  files, emits module→module `imports` raw edges via the existing aggregate/build flow. Externals
  (node_modules) and self-imports dropped. No dynamic `import()`/`require()`, no barrel flattening
  (spike scope).
- `packages/extractor-typescript/src/extractor.ts` — wires the pass into `runExtraction`.

**Renderer — pure core (all new, unit-tested):**
- `derive/moduleCategory.ts` — path-segment classifier → `'entry'|'ui'|'util'|'config'|'app'`.
- `derive/moduleGraph.ts` — `buildModuleGraph(index)` (imports-only adjacency) + `resolveModuleRoot`.
- `derive/importReach.ts` — `computeReach(graph, rootId, maxDepth)` → `Map<id, depth>`, forward BFS,
  visited-guarded (cycle-safe). **Runs on the full graph** — category hiding never truncates it.
- `derive/moduleMap.ts` — `deriveModuleMap(index, {rootId, maxDepth, entryModules})` → `ModuleMapSpec`
  (files + directory frames + edges + ring/depth). Owns the `ModuleCardData`/`ModuleFrameData` shapes.
- `layout/moduleRingLayout.ts` — `layoutModuleMap(spec)` → React Flow nodes/edges. Two-pass: grid-pack
  inside frames, then place frames on concentric rings by depth. Pure, deterministic.

**Renderer — wiring & surface:**
- `state/store.ts` — `viewMode: 'modules'`, fields `moduleRoot`/`moduleDepth`/`hiddenCategories`,
  actions `setModuleRoot`/`setModuleDepth`/`toggleCategory`; relayout routes to
  `state/deriveModuleMapLayout.ts`. Category hiding is **paint-only** (no relayout).
- `state/urlState.ts` — new keys `mroot`/`mdepth`/`mhide` + `'modules'` added to the `view` whitelist
  (else shared links to the lens break on decode).
- `components/ModuleMapView.tsx` — read-only React Flow surface; click-select, double-click re-root,
  default-dim edges + emphasize the selection's edges (anti-clutter), category paint-filter, empty
  state.
- `components/nodes/modulemap/{ModuleCardNode,ModuleFrameNode}.tsx` — file card + directory frame.
- `components/DepthSlider.tsx` (real range input) + `components/ModuleCategoryToggles.tsx` (pills).
- `components/ViewModeToggle.tsx` — 4th "Module map" segment; `components/Toolbar.tsx` mounts the
  slider + toggles in `modules` mode; `components/BlueprintCanvas.tsx` mounts the surface.

---

## How to run / demo

```bash
pnpm build && pnpm --filter @meridian/cli copy-renderer
node packages/cli/dist/bin.js generate examples/shopfront -o /tmp/mm-shopfront.json
node packages/cli/dist/bin.js view /tmp/mm-shopfront.json    # → switch to the "Module map" lens
```

Drag the **depth** slider (defaults to 1) to grow the blast radius; toggle **utils/ui/config** to
de-noise; double-click a file or frame to re-root.

---

## Deferred follow-ups (obvious seams)

- **tsconfig entry reader** — read `files[0]` / `include`+`rootDir` in `cli/src/entry-points.ts`
  (renderer needs no change) to honor the literal "entry from tsconfig".
- **Import fidelity** — dynamic `import()`/`require()`, barrel/re-export flattening, external-package
  nodes.
- **Depth ≥ 2 clutter** — frame-level aggregation of parallel file→file wires into one weighted
  frame→frame edge when a frame is collapsed; optional edge bundling.
- **Coarser grouping** — "group at top-level dirs" option for deep trees (one-frame-per-leaf-dir today).
- **Category tags in the artifact** — move the renderer-side classifier into the CLI tag pipeline
  (mirror `core/test-detection.ts`), so categories ride the `tags` vocabulary.

## Known risks (from the design consult)

- **Depth ≥ 2 on a real repo reads as wire salad** — mitigated by: slider defaults to 1; edges dimmed
  unless incident to the selection. Frame-level edge aggregation is the next lever if needed.
- Import graphs cycle (barrels, mutual imports) — BFS is visited-guarded; keep it that way.
- One giant directory can distort ring geometry — the ring radius formula grows to fit frame sizes.

---

## Handoff prompts (to continue the spike)

- *"Productionize the imports pass: handle re-export flattening and dynamic `import()`, and add
  external-package nodes behind an includeExternal toggle; update goldens."*
- *"Add a tsconfig entry reader to `cli/src/entry-points.ts` (files[0] / include+rootDir + convention
  fallback) and prefer it over package.json for the module-map seed."*
- *"At depth ≥ 2, aggregate parallel file→file import wires into one weighted frame→frame edge when a
  frame is collapsed; add a collapse/expand affordance on frames."*
- *"Add a 'group by top-level directory' option so deep trees don't explode into one frame per leaf
  directory."*
