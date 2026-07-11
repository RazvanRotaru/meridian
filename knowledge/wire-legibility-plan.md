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
4. **The pair RIBBON** (shipped in the same PR after field feedback; this IS W3's multi-kind
   ribbon, pulled forward): same-(source,target) strands used to draw on identical geometry —
   overlapping dashes wove into confetti, every strand carried its own arrowhead into a pile-up,
   and the topmost kind captured every click. `foldPairRibbons` now folds each such group into
   ONE cable edge: tight parallel stripes (one per kind, its colour, its own lit/dim emphasis),
   offset perpendicular to the cable, a single arrowhead on the heaviest strand, one hover/click
   target. Cross-package cables dash AS A UNIT via a background-coloured notch overlay (per-
   stripe dashes can never share phase on parallel curves). Clicking the cable opens the pair
   inspector — one evidence section per kind.

   ✅ Rail ribbons (shipped with W3/W4): the fold now PRECEDES routing, and a routed cable
   stripes CONCENTRICALLY along the rail path (heaviest kind as the core, lighter kinds as
   rings) — one striped line through gate, rail, and peel-off; side-by-side offsets can't
   follow a multi-segment rail, nested stroke widths follow any geometry.

## W2 — hub demotion (the commons dock) ✅ SHIPPED

The biggest spaghetti reducer: a handful of utility modules (logger/types/config) attract wires
from everywhere. A top-level leaf file whose distinct dependents reach the LEVEL-RELATIVE bar
(`max(4, 30% of the level's other top cards)` — a fixed count misses a small level's logger)
demotes: it leaves ELK entirely and parks inside the labelled DOCK TRAY — a non-interactive
dashed shelf titled "COMMONS · n" (`commonsDockPlacement` emits it as the docked cards' parent,
so ghost banding treats the dock as one footprint) — its wires hide at rest (paint opacity 0,
non-hoverable, BOTH directions), and every dependent — file or directory card — wears a small
chip naming it (nested member wires lift to their top-level frame for both the bar and the
chips). Selecting a docked card lights its real connections; the Wire Inspector still
attributes everything. The whole treatment is a TOGGLE ("Commons", beside Highways; a relayout
toggle like Tests). Frames, packages, expanded files, and the entry file never demote.
Residuals: paint-time kind filters can strand a docked hub's chips (dim them in a follow-up);
invisible commons strands still count toward spool fan thresholds.

## W3 — more grouping strategies (cycle fusion ✅ SHIPPED; ghost-grouping v2 deferred)

- **Cycle fusion**: `A→B` + `B→A` fuse into one double-headed wire with an amber tension
  marker — mutual coupling is a smell, and today it renders as two curves the reader must
  visually match. `design-metrics` already reasons about coupling; reuse its vocabulary.
- **Multi-kind ribbon**: several kinds on one pair (calls + references + extends) draw as one
  ribbon with segmented colour instead of parallel curves; the inspector splits them back out.
- **Ghost grouping v2**: at the orientation tier, fold ghost folder-cards one level further
  (per top-level package) so far-context density scales with zoom.

## W4 — salience filtering ✅ SHIPPED (weight floor auto on dense levels; lit midpoint chips)

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
