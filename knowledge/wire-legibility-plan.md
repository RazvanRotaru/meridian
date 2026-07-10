# Wire legibility — the links roadmap

The Map's readability work (see `map-readability-plan.md`) made the *cards* legible at every
altitude. This plan does the same for the *wires*: today a wire is a *claim* ("these two are
coupled, calls ×7") that the reader cannot interrogate, and dense levels still drown in
low-information strands. The through-line of every phase below: **a wire must be attributable
down to real lines of code, and the field of wires must foreground the few that matter.**

## What the data already knows (the foundation)

- Every artifact edge carries `callSites: {file, line, col}[]`, and `weight` = the call-site
  count (`schema.ts`, `edge-build.ts`). The evidence exists; the renderer just never shows it.
- `liftEdges` keeps `underlyingEdgeIds` on every aggregate — a lifted wire knows exactly which
  symbol→symbol edges it stands for. **But the Map drops this** in `blockDeps.ts`
  (`LiftedDepEdge`), `moduleTree.ts` (`packageDepEdges`), `moduleTreeData.ts`
  (`importTreeEdges`) and the ghost path — the one plumbing gap between a pixel and a line.
- `graphIndex` keeps the raw `edges` array; nodes carry `location` (file/line); `revealModule`
  already implements refocus-to-a-symbol (the ghost double-click); `codeView` already shows a
  node's source.

## W1 — the Wire Inspector + direction (THIS PR)

**Click a wire → a pinned inspector that lists the real links it aggregates, each traceable.**

1. **Attribution plumbing** (pure derive changes, no visuals):
   - `LiftedDepEdge` gains `underlyingEdgeIds: string[]`; `liftDepEdges` concats them when
     merging pairs. Same for `packageDepEdges`, `importTreeEdges`, and the ghost wire path
     (`ghostDepWires` → `groupGhostEmission` aggregate).
   - `ModuleTreeEdge` gains optional `underlyingEdgeIds`; `moduleLevelLayout` copies it into
     the RF edge `data`. Step/flow/IPC wires may omit it — the inspector falls back to the
     aggregate header alone.
2. **The WireInspector panel** (new component, WireTooltip's design family):
   - `onEdgeClick` on the Map pins the inspector (local view state; pane click / Esc closes;
     clicking another wire repins). The clicked wire stays force-lit while pinned.
   - Header: source → target labels, kind pill in the wire's colour, total weight.
   - Body: one row per underlying edge — source symbol → target symbol (labels via
     `unitLabel`), its call sites as `file:line` chips. Resolve ids through a memoized
     `Map(index.edges by id)`. Rows sorted by call-site count desc; long lists capped with
     "show all N".
   - Row actions: **reveal** source/target on canvas (`revealModule` — the ghost gesture,
     reused); open the source symbol's code (`codeView`) where available.
   - Bundle highways (`bundle` type) open the inspector too, listing their member wires first
     (the existing breakdown), each expandable into its underlying links.
3. **Direction on lit wires**: drifting pulse dots (SMIL `animateMotion` over the drawn path)
   ONLY on lit strands — motion reads as direction, animating only the selection keeps the
   canvas calm. (Dash animation was rejected during implementation: dash already means
   "crosses a package boundary".)
4. **The parallel-pair fix** (shipped in the same PR after field feedback): same-(source,target)
   strands used to draw on identical geometry — the topmost kind captured every click and hid
   the others. `assignPairLanes` now spreads them into a multi-strand cable (4px lanes), and the
   inspector reports the clicked strand's WHOLE ordered pair — one section per kind, clicked
   first — so the z-order can never hide a relationship.

## W2 — hub demotion (the commons dock)

The biggest spaghetti reducer: a handful of utility modules (logger/types/config) attract wires
from everywhere. Nodes whose visible in-degree crosses a threshold leave the wire field: drawn
once in a **commons dock** strip, each dependent card wears a tiny chip (`log`, `cfg`) instead
of a wire. Selecting a commons card lights its real connections as usual; the inspector (W1)
still attributes every chip. Touches layout (dock placement + wire suppression) — its own PR.

## W3 — more grouping strategies

- **Cycle fusion**: `A→B` + `B→A` fuse into one double-headed wire with an amber tension
  marker — mutual coupling is a smell, and today it renders as two curves the reader must
  visually match. `design-metrics` already reasons about coupling; reuse its vocabulary.
- **Multi-kind ribbon**: several kinds on one pair (calls + references + extends) draw as one
  ribbon with segmented colour instead of parallel curves; the inspector splits them back out.
- **Ghost grouping v2**: at the orientation tier, fold ghost folder-cards one level further
  (per top-level package) so far-context density scales with zoom.

## W4 — salience filtering

- **Weight floor**: when a level draws more than ~N wires, fade weight-1 strands so heavy
  structural couplings pop first (the kind pills filter by *type*; this filters by *strength*).
  Auto with a manual override in the control panel.
- **Midpoint chips**: lit wires at reading zoom get a small `calls ×7` label at the path
  midpoint — attribution without hovering.

## W5 — experiment: partial edge drawing

At rest draw only the first/last ~20% of each *unlit* wire (directed stubs); full paths on
hover/selection. The PED literature shows large clutter reduction with traceability retained,
and it matches the house philosophy (collective at rest, individual under focus) — but it
changes the map's character, so it ships behind a toggle and is judged against autopilot-vscode
before it can become a default.

## Verification bar (every phase)

Real-browser Playwright against the quality standard (`autopilot-vscode` +
`tests/vscode/**`, generated with `--value-refs`), screenshots at overview / expanded-frame /
selection / orientation-zoom states; unit tests for every derive/paint pass; adversarial review
before commit.
