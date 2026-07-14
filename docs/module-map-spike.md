# Spike: Module Map (import composition) lens

**Status:** spike / draft PR #61. A 4th renderer lens (`viewMode: "modules"`, **"Module map"**) that
reinvents "service composition" around the **import graph** — a **zoomable containment hierarchy** of
packages → directories → files, wired by real imports. The shipped SOLID "Service composition" lens
(`viewMode: "call"`) is untouched as a control (it answers a different question: health/coupling, not
structural composition).

> One-liner: **level 0 is the package overview**; double-click any package/directory to **zoom in**
> one containment level, breadcrumb to **zoom out**. Each level shows the focus's children
> (sub-dirs as group cards, files as file cards) wired by the import graph *folded to that level*.

## Iteration: inline expand (coexists with zoom)

A group card now also carries a **chevron** that **expands its children nested in place** — the same
gesture as the Logic-flow tab — so you can open several directories at once without leaving the level.
Double-click-to-re-root and the breadcrumb are unchanged; the two gestures coexist. Mechanically this
replaced the flat one-level fold with a **nested containment tree** driven by a `moduleExpanded` set,
reusing the shared `elkNesting` primitives (`INCLUDE_CHILDREN` on the root only) and `liftEdges` — the
same engine the call/logic graphs use. Import wires are lifted to the visible frontier: a collapsed
group swallows its internal imports, and imports leaving the drawn subtree drop, so a view shows only
the coupling between what is currently on screen.

- New: `derive/moduleTree.ts` (`deriveModuleTree`) replaces `derive/moduleLevel.ts`'s flat
  `deriveLevel` (that file is now a small helper module); `layout/moduleLevelLayout.ts` is nested;
  store gains `moduleExpanded` + `toggleModuleExpand`; `?mexp=` deep-links the open set.
- Deferred: inline-expand descends one level per click (no chain-collapse — double-click still
  chain-collapses); `emphasize` dims a parent frame's nested children via inherited opacity; the
  whole-repo overview is still empty for single-package artifacts (keys off the `npm-package` tag —
  focus into a directory to browse those).

## Design evolution (why the code has some ghosts)

It started (commits `18dc79a`…`1c59098`) as an **entry-rooted blast-radius** view: pick an entry file,
BFS the import graph N hops, render reachable files in concentric depth-rings with a depth slider.
Feedback drove two changes: (1) a **package-level fold** so a monorepo reads as packages
(`09f9c8c`), then a **package-overview mode** (`386a5fe`); (2) the realization that a mode *toggle* +
a depth-1 re-root couldn't show real nesting. The final model (`d43ac44`) collapses all of that into
**one zoomable containment hierarchy** — no toggle, no blast-radius-as-layout. The ring layout,
`importReach`, `moduleMap`, and the toggle were **removed**.

## Resolved design decisions

1. **Real `imports` edges** from a new TS-extractor pass (not a behavioural proxy) — misses none of
   the type-only/re-export/side-effect imports a proxy would. `imports` is already in the edge-kind
   vocabulary → **no schema change**; emitted **always-on** so `meridian web` gets it free.
2. **Navigation = containment zoom, not blast-radius.** A single `moduleFocus: string | null` drives
   everything. `focus = null` → package overview; `focus = <dir/package node>` → that level. Import
   edges are **lifted** to the level's nodes (weight = underlying file-import count). Double-click a
   group → zoom in; `ancestorsOf` breadcrumb → zoom out; **single-child levels auto-collapse** (so
   `app → src` isn't a wasted click).
3. **Package fold.** The extractor tags each `package` node whose dir has a `package.json` as
   `npm-package`; the overview (level 0) folds files to their owning package.
4. **Depth slider → paint-only selection radius.** With a node selected it highlights that node's
   N-hop import neighbourhood *at the current level*; hidden when nothing is selected. It never
   relayouts. (Containment now bounds what's *drawn*; imports keep the *inspection* role.)
5. **Per-level ELK `layered` layout** (importers left → dependencies right). The import graph is built
   **once and cached** on the store.

## Architecture / file map (current)

**Extractor:**
- `extractor-typescript/src/import-pass.ts` — walks `getImportDeclarations()` + re-exporting
  `getExportDeclarations()`, resolves to in-project files, emits module→module `imports` edges via the
  existing aggregate/build flow. Externals/self-imports dropped. No dynamic `import()`/re-export
  flattening (deferred).
- `extractor-typescript/src/structural-pass.ts` — tags a `package` node `npm-package` when its dir
  has a `package.json` (`project-loader.ts` exposes the absolute root).

**Renderer — pure core (unit-tested):**
- `derive/moduleGraph.ts` — `buildModuleGraph(index)` (imports adjacency + weights); **cached once**.
- `derive/moduleLevel.ts` — `deriveLevel(index, focus, graph)` → `{ groups, files, edges, effectiveFocus }`;
  `collapseChain` (single-child auto-descend); `childOfFocus` + the sibling fold (lift imports to the
  focus's children).
- `derive/packageOverview.ts` — level-0 npm-package fold + `ModulePackageData` (the group card data);
  reused as the group card at **every** level.
- `derive/moduleCategory.ts` — path classifier (`ui/util/config/app/entry`) for file-card chips.
- `layout/moduleLevelLayout.ts` — `layoutLevel(spec)`: one flat ELK-`layered` pass per level (group
  width scales with file count).

**Renderer — state & surface:**
- `state/store.ts` — `moduleFocus`/`moduleEffectiveFocus`/`moduleRadius` + `setModuleFocus`/
  `setModuleRadius`; import graph cached; `moduleRelayout` derives one level; `setViewMode("modules")`
  lands at `focus=null`.
- `state/urlState.ts` (+ `urlSync.ts`) — `mfocus` (focus node id; absent = level 0), `mdepth` (paint
  radius); `'modules'` in the `view` whitelist.
- `components/ModuleMapView.tsx` — double-click-group zoom, `ancestorsOf` breadcrumb, select/emphasize,
  empty state.
- `components/moduleMapPaint.ts` — `filterVisible` (category/test paint) + `emphasize` (N-hop radius).
- `components/DepthSlider.tsx` — selection radius (hidden until a node is selected).
- `components/nodes/modulemap/ModuleCardNode.tsx` (file card) + `PackageOverviewNode.tsx` (group card);
  registry `{ package, file }`. `Toolbar.tsx` (no toggle); `ViewModeToggle.tsx` 4th segment.

## Autopilot extraction recipe (the reusable, hard-won part)

> **Superseded:** these commands record the original spike. Current product generation always uses
> canonical workspace discovery; do not pass a root or combined tsconfig.

Autopilot (`UiPath/Autopilot`) is a multi-language monorepo of ~10 loosely-federated npm roots.
Getting a correct TS import graph out of it:

```bash
AP=/path/to/Autopilot
# 1. package family (18 packages, 389 cross-package edges):
generate $AP/src/packages --lang typescript --tsconfig $AP/src/packages/tsconfig.typecheck.json
# 2. whole TS surface incl. aria/app (2,861 files; aria/app 1,914; pkgs↔aria both ways):
#    use a combined tsconfig = typecheck.json + explicit aria/app + aria/lib includes, rooted at src.
generate $AP/src          --lang typescript --tsconfig <combined-tsconfig>
```

- **`--lang typescript` is mandatory** — without it, detection falls to Python on stray `node_modules`
  `.py` files and emits garbage.
- **`tsconfig.typecheck.json` is the only config that source-maps** internal `@uipath/autopilot-*`
  aliases to sibling *source* (the root `tsconfig.json` is references-only → 0 edges; per-package
  configs resolve to `.d.ts` which meridian drops).
- **Full aria/app** requires *explicitly* adding `../aria/app/src/**` + `../aria/lib/**` to the
  tsconfig `include` (import-following alone pulled only 1 aria/app file). Overriding
  `@uipath/autopilot-types` → the real package source (vs aria's local shim) is what lifts
  `aria → packages` from 1 edge to 265.
- **Static-analysis blind spots** (not meridian bugs): bundler-only `resolve.alias`
  (delegate-iframe/-web, studiodesktop, uia), Module-Federation `exposes`/`shared`, and dynamic
  `import()`.

## Deferred follow-ups

- **Boundary ghost-stubs** — imports that cross the current focus boundary aren't drawn at that level
  yet (they reappear on zoom-out), so deep leaf-dir levels can look sparse. Aggregate them into
  package-granularity ghost stubs docked at the level edge (like `materializeBoundaryNodes`).
- **tsconfig entry reader** — read `files[0]` / `include`+`rootDir` in `cli/src/entry-points.ts`.
- **Import fidelity** — dynamic `import()`/`require()`, re-export flattening, external-package nodes.
- **Bundler-alias resolution** — an `--alias` map (or a vite/rsbuild `resolve.alias` reader) injected
  as `compilerOptions.paths` to recover the bundler-only cross-package edges.
- **Overflow** — an "+N more" chip past ~200 children on a huge directory level.
- **Category tags in the artifact** — move the renderer classifier into the CLI tag pipeline.

## Known caveats

- Import graphs cycle (barrels, mutual imports) — the level fold + paint BFS are visited-guarded.
- The whole-TS artifact is large (~17k nodes); only the current level materializes, and the overview
  collapses to ~21 nodes, so it renders fine — but the JSON is several MB to load.
- `aria → packages` is only partially resolvable statically (aria shims package types locally); the
  combined-tsconfig override recovers most of it but not the bundler-only paths.

## Handoff prompts (to continue)

- *"Add package-granularity boundary ghost-stubs to `deriveLevel` so cross-focus imports show at every
  level (capped top-N by weight), docked at the level edge."*
- *"Add a tsconfig/`package.json` entry reader to `cli/src/entry-points.ts` and an `--alias` map so
  bundler-only cross-package edges resolve."*
- *"Point the Module map at another app (studioweb / studiodesktop / vscode) and validate the
  containment descent + per-level import lifting hold up."*
