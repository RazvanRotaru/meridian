# Service Composition — Design Notes

> **Purpose & audience.** This is a design-rationale document for the *Service composition* tab in
> `meridian`'s renderer. It is written to be read by an LLM (or a human) acting as a **reviewer**:
> it states each design decision, the alternatives considered, and the trade-off taken, plus the
> exact data model and thresholds so correctness can be reasoned about directly. It is *not* the
> user-facing explainer (see `docs/service-composition.html` for that). Where it names files and
> functions, they are real and current as of the PR sequence in §9.

---

## 1. Problem & reframe

`meridian` turns a codebase into a Blueprints-style graph. The first tab used to be **Call flow** —
a function-to-function call graph, drilled system → module → class → function. That answers *"how
does execution move?"* — good for tracing a request or a bug.

It does **not** answer the question you ask when you're about to *build* or *refactor*: *"are these
the right units, and are they coupled/cohesive enough that I can change one without breaking the
others?"* That is an architecture question, and it is what SOLID is about.

**Decision (user-directed): replace Call flow with Service composition.** The raw call graph is not
lost — it remains reachable via drill-in and is the whole subject of the **Logic flow** tab. The
`"call"` view-mode key is retained internally; only what it *renders* changed.

Non-goal, explicitly rejected by the user: a **full dependency graph** (import-wire dump). "I don't
think a full dependency graph would help really." The view is a *scored composition map*, not a
wire salad.

---

## 2. Core idea: Martin's component metrics

The person who codified **SOLID** (Robert C. Martin) also defined the metrics for reasoning about
how components fit together: **Instability**, **Abstractness**, and **Distance from the main
sequence**, plus the Zone of Pain / Zone of Uselessness. These are exactly the "how should I compose
this" metrics, and — critically — they need **only data the extractor already emits**:

- node kinds: `package`, `module`, `namespace`, `class`, `interface`, `object`, `function`, `method`
- edge kinds: `calls`, `instantiates`, `extends`, `implements` (also `references`, `imports`, `renders`)
- `"abstract"` in `node.tags` for abstract classes/members

So **zero schema change**. `imports` is already in the `EdgeKind` vocabulary too, which is why the
optional imports layer (§7, fast-follow) also needs no schema change.

---

## 3. Data model & metric definitions (authoritative)

Implemented in `packages/renderer/src/derive/composition.ts` (formulas) and
`composition-graph.ts` (graph primitives). All pure, no React/DOM. Fully unit-tested.

### 3.1 Units and members
- **Unit** = a node whose kind ∈ `{class, interface, object, module}`. These are the composition
  units — the things you'd move, split, or merge.
- **`enclosingUnit(member)`** = the nearest self-or-ancestor (via `parentId`) whose kind is a unit
  kind. Because a class/interface/object always nests inside a module, a method resolves to its
  class; a top-level function resolves to its module. **Units are therefore a disjoint partition of
  all callables** — no member is counted twice.
- **`members(unit)`** = the `function`/`method` nodes assigned to it by `enclosingUnit`.

### 3.2 Coupling
- Coupling edges = edges of kind `{calls, instantiates, extends, implements}`. `references` and
  `imports` are **ignored** for v1 metrics.
- Each edge's `source`/`target` is mapped to its `enclosingUnit`. Self-unit edges are internal;
  edges to `ext:` / `unresolved:` / absent targets are **external fan-out**, not internal coupling.
- **`Ce`** (efferent) = count of *distinct* other units this unit depends on.
- **`Ca`** (afferent) = count of *distinct* other units that depend on this one.
- **`externalFanout`** = distinct external/unresolved targets (tracked but not scored; a heavy value
  is itself a signal).

### 3.3 Scores
- **Instability** `I = Ce / (Ca + Ce)`; `I = 0` when `Ca + Ce == 0`. (0 = maximally stable, 1 = maximally unstable.)
- **Abstractness** `A`: `interface` → `1`; else `(# abstract-tagged members) / (# members)`; `0` members → `A = 0`.
- **Distance** `D = |A + I − 1|`. 0 = on the main sequence, 1 = a far corner. **`D` drives the card's health colour.**
- **Cohesion (LCOM4)**: build an undirected graph over the unit's members with an edge when one
  member *calls* another (internal calls only); `lcomComponents` = number of weakly-connected
  components (union-find). `cohesion = members > 1 ? 1 − (lcomComponents − 1)/(members − 1) : 1`.
  1 = one connected cluster; → 0 = fragments into unrelated jobs.

### 3.4 Smells (named tunable constants)
| Smell | Chip | Condition |
|---|---|---|
| `god-module` | HUB | `Ca ≥ 5 && Ce ≥ 5` |
| `zone-of-pain` | PAIN | `A ≤ 0.3 && I ≤ 0.3 && Ca ≥ 3` |
| `zone-of-uselessness` | UNUSED | `A ≥ 0.7 && I ≥ 0.7` |
| `low-cohesion` | SPLIT | `members ≥ 4 && cohesion ≤ 0.34` (fragmentation relative to size) |

Smells are computed from **raw (unrounded)** ratios; the stored/displayed metrics are rounded to 2
decimals afterward, so a rounding boundary can't flip a threshold. `rankRefactorCandidates()` orders
worst-first by a weighted severity (`god-module 4, low-cohesion 3, zone-of-pain 3, zone-of-uselessness 2`),
then `D`, then member count, then id.

---

## 4. Visual & interaction model

- **Scorecard node** (`components/nodes/composition/CompositionNode.tsx`): a card per unit — a
  4px **left rail coloured by `D`** (green ≤ 0.2, red ≥ 0.7, amber between; `colorForDistance`), a
  kind glyph + tag, `members·cohesion` / `Ce·Ca·I·A` rows, a prominent `D`, and smell chips (red for
  HUB/PAIN, amber for SPLIT/UNUSED). Selected unit gets a green ring.
- **Cluster frame** (`ClusterFrameNode.tsx`): a titled frame per **package (folder)** — the nearest
  `package` ancestor of the units it holds (fallback `"(root)"`). Shows the package name, unit count,
  and an `N⚠` badge when it contains smelly units.
- **Edges** (styled in `layout/compositionElk.ts`) share the Logic-flow wire feel — **2px stroke +
  a matching arrowhead** (`arrowMarker`) — keeping their semantic colours; priority order:
  - `inheritanceOnly` (`extends`/`implements` only) → **dashed violet** `#A78BFA`, static.
  - internal (same cluster) → **quiet grey** `#5B6675`, opacity 0.7, static (expected cohesion, recedes).
  - cross-boundary (different cluster) → **warm gold** `#C9A24B`, full opacity, **animated** — the
    flowing packaging (Common-Closure) signal, like Logic's exec thread.
- **Interaction** — **single-click selects** (`CompositionView.emphasizeSelection`, repaint-only, no
  relayout, **the viewport never moves**): it lights the unit's 1-hop coupling neighbourhood and fades
  the rest (frames are never dimmed; a cluster-frame click clears the selection, like empty canvas).
  **Double-click focuses/re-roots** — on a unit, a boundary card, or a package frame — mirroring the
  call graph's double-click-to-dive, then re-fits the viewport to the new root. A compact
  always-visible legend (`components/composition/CompositionLegend.tsx`) keys the wire colours and
  these gestures in the sidebar.
- **File-rooting** (PR 4): the tab opens on the **whole-system overview** (default root `null`; see
  §8 open question 6 for why not the entry module), with rooting as the explicit focus gesture. Rooting
  at a unit/package shows the units the root *contains* plus their **1-hop neighbours** as faded
  **boundary** cards. Double-click a unit, boundary card, or package frame to root there; `⌘P` roots
  anywhere (the palette is mode-aware — it lists modules/packages in composition mode, callables
  elsewhere); a breadcrumb's **"Whole system"** clears the root. `isWithinRoot(unit, root)` = root is
  ancestor-or-self via `parentId`; empty root set → fall back to whole-system.

---

## 5. Architecture & code map

The feature deliberately **mirrors the existing Logic-flow stack** (its own derive → ELK → React-Flow
surface + store slice), so it composes with the renderer with no changes to the ADR-0001 contract
(stable `node.id`, flat + `parentId`, open kind vocabulary).

| Concern | File | Notes |
|---|---|---|
| Metric formulas + ranking | `derive/composition.ts` | pure |
| Graph primitives (unit index, coupling, LCOM, coupling edges, containment guard) | `derive/composition-graph.ts` | pure |
| Cluster assignment | `derive/compositionClusters.ts` | pure |
| Pre-layout spec (units→cards, edges, `colorForDistance`, `sizeFor`, root filter) | `derive/compositionGraph.ts` | pure |
| ELK build + RF mapping + edge styling | `layout/compositionElk.ts` | via shared `layout/elkNesting.ts` |
| Orchestrator | `state/deriveCompositionLayout.ts` | pure of store |
| Store slice (`compRfNodes/Edges`, `compRoot`, `compSelectedId`, `compRelayout`, `setCompRoot`, `selectCompUnit`) | `state/store.ts` | `relayout()` routes `viewMode==="call"` → `compRelayout()` |
| Surface + selection + breadcrumb | `components/CompositionView.tsx` | read-only `<ReactFlow>` |
| Scorecard / frame nodes | `components/nodes/composition/*.tsx` | |
| Mode-aware quick-open | `components/CommandPalette.tsx` | |
| View switch | `components/BlueprintCanvas.tsx` | `"call"`→Composition, `"logic"`→Logic, else UI |

**Trigger flow:** `relayout()` (called on boot since `viewMode` starts `"call"`, and by `setViewMode`)
routes `"call"` straight to `compRelayout()`, which is guarded by a monotonic `compLayoutSeq` so a slow
ELK pass can't overwrite a newer one — the same stale-guard pattern the call graph and logic graph use.

---

## 6. Key design decisions & rationale

Each is stated as **decision → why → alternative rejected → trade-off**.

1. **Replace Call flow (not add a 4th lens).** User-directed. The call graph survives via drill-in
   and the Logic tab. *Alt:* keep both top-level. *Trade-off:* the raw call graph is one interaction
   deeper, but the top-level real estate goes to the higher-value structural question.

2. **Metrics live in `renderer/derive`, not `core`.** Matches the existing pure-analysis modules
   (`logicGraph`, `flowInspect`). *Alt:* put them in `@meridian/core` so a headless `meridian audit`
   / CI gate could reuse them. *Trade-off:* if we later want CI enforcement, these functions must be
   promoted to core (they're already dependency-free, so the move is mechanical). **Open question §8.**

3. **Units are a disjoint partition** (method→its class, loose function→its module; class and module
   are *separate* units). *Why:* clean, non-double-counted `Ca`/`Ce`. *Alt:* nest class metrics inside
   module metrics. *Trade-off:* a module's metrics reflect only its loose functions, and a
   module→its-own-class dependency is *containment* (a frame), not a wire — handled in decision 6.

4. **Coupling = `calls|instantiates|extends|implements`; ignore `references`/`imports`.** *Why:*
   `references` is weak/noisy (type refs, re-exports); `imports` is a *different* signal (a file can
   import what it barely uses) and deserves its own opt-in layer. *Trade-off:* the coupling graph
   slightly *understates* structural dependency vs. imports — accepted, and addressed by the optional
   imports layer.

5. **Cohesion is LCOM4 over call edges.** *Why:* it's the only intra-unit relationship we extract.
   *Alt:* true LCOM (shared field access). *Trade-off:* **pessimistic in TypeScript** — methods
   commonly reach through `this.repo.x()` rather than calling sibling methods, so `SPLIT` fires
   broadly. This is the single biggest known caveat (§8). We keep it because it still flags genuinely
   fragmented units, but it is a *prompt to look*, not a verdict.

6. **Containment pairs are excluded from the coupling graph** (`isContainmentPair` in
   `composition-graph.ts`: drop an edge if one unit is a `parentId`-ancestor of the other). *Why:* a
   module and a class it declares are *composition* (a frame), not a peer dependency. *Trade-off:*
   none material; it de-noises the wires.

7. **Cluster by declared package; flag cross-boundary edges.** *Why:* shows the *intended* structure
   and where coupling violates it (Common-Closure signal), using data we have for free. *Alt:*
   algorithmic community detection to infer where boundaries *should* be. *Trade-off:* we show
   "your packaging vs your coupling," not "the ideal packaging." Community detection is a strong
   future addition. **Open question §8.**

8. **File-rooted by default, not whole-system.** User-emphasised ("start from a given file... not a
   whole-system dump"). *Why:* a full graph is a hairball; you read code from a point of interest
   outward. *Alt:* whole-system default with rooting as opt-in. *Trade-off:* the first impression is
   a focused subgraph; the "Whole system" breadcrumb restores the overview in one click.

9. **Thresholds are tunable constants; A/I zone cut-offs are the canonical ones** (0.3 / 0.7),
   hub is count-based, split is a cohesion-ratio threshold (`cohesion ≤ 0.34`, fragmentation relative
   to size). *Trade-off:* they're opinions; see §8.

10. **ELK lays out units inside frames (not hand-gridded).** *Why:* composition units carry coupling
    edges, so the layered algorithm orders them sensibly — unlike the Logic-flow definition grid,
    which is hand-positioned precisely *because* those nodes are edgeless and ELK would splay them
    into one wide row. *Residual risk:* a frame of entirely edgeless-in-coupling units could still
    splay; not observed on fixtures, flagged as a follow-up.

---

## 7. The imports layer (fast-follow, not in v1)

Reconciles the "not a full dependency graph" constraint with the recurring "imports under a toggle?"
question: `import` statements become a separate **layer toggle**, off by default. It needs a small
extractor pass to emit `imports` edges (the edge kind already exists in the schema), so it ships
*after* the v1 sequence. The v1 coupling wires do not depend on it.

---

## 8. Known limitations & open questions for review

**Limitations (already baked into the doc/UI honesty section):**
- **LCOM/SPLIT is pessimistic** for TypeScript (decision 5). This dilutes the SPLIT signal.
- **Not a dependency graph** — coupling is behavioural (calls/instantiate/inherit), not declared imports.
- **Thresholds are opinions**, not universal truths.
- Health colour is **stepwise** (green/amber/red), not a continuous gradient — legible, but coarse.

**Open questions we want the review to weigh in on:**
1. **SPLIT noise — RESOLVED.** A POC on `shopfront` showed the flat `lcomComponents ≥ 2` rule was
   size-blind: it flagged cohesive classes (e.g. `CartService`, cohesion 0.80 — five methods in one
   call-cluster plus one stray) as false positives. We adopted the **cohesion-ratio rule (V3):
   `members ≥ 4 && cohesion ≤ 0.34`**, flagging fragmentation *relative to size* rather than a raw
   component count. On `shopfront` it drops the 6 mostly-cohesive false positives (16 → 10 SPLIT
   flags) while keeping the genuinely low-cohesion units and the trench-coat `legacy.ts`. **Residual
   caveat stands:** SPLIT remains a *soft hint* because call-based LCOM still cannot distinguish
   cohesive-by-responsibility delegation (cohesion-0 route/repository classes that reach through
   `this.repo.x()`) from a true trench-coat — the full fix is field-access-aware LCOM, which needs an
   extractor pass.
2. **Ship the imports layer?** Is a *scored* map sufficient, or do reviewers want declared
   `import` structure alongside behavioural coupling?
3. **Cluster granularity:** nearest package (current) vs. immediate folder vs. algorithmic community
   detection. Which is most decision-useful?
4. **Promote metrics to `core`?** Worth it for a headless `meridian audit` / CI architecture gate, or
   premature?
5. **Refactor-ranking weights** (`god-module 4, low-cohesion 3, zone-of-pain 3, zone-of-uselessness 2`)
   — do these priorities match how a team actually triages?
6. **Default root = entry module** — right default, or should the tab open whole-system-first with an
   explicit "focus" action?

---

## 9. Implementation status

Shipped as a 5-PR sequence on `main` (all merged), with one fast-follow:

1. **Metrics engine + tab rename** — merged (#37).
2. **Scorecard nodes + composition graph** — merged (#38).
3. **Package cluster frames + cross-boundary flags** — merged (#39).
4. **File-rooted entry + ⌘P root + 1-hop boundary ghosts** — merged (#40). Default is whole-system (see decision 8 / open question §8).
5. **Refactor-candidates panel + A/I main-sequence scatter** — merged (#41).
- **fast-follow (not yet built):** imports extractor pass → layer toggle — gated on open question §8.2.

All merged PRs verified live (headless Chromium) on the `shopfront` fixture (a deliberately tangled
TS+React app): 58 units / 8 package frames; `PAIN` on `response.ts` (Ca 4, Ce 0, D 1.0) and
`BaseRepository` (Ca 9, A 0.2, D 0.62); `UNUSED` on an orphan interface; `HUB` on `CatalogService`
(Ca 5 / Ce 5); **97 of 126 edges cross a package boundary** — the packaging signal the view exists to
surface.
