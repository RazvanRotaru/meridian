# Map readability plan — making the view work for human eyes

Research audit + prioritized roadmap (2026-07-10). Grounded in the code, a computed palette
validation, and live inspection of the **autopilot-vscode** package — the declared visual quality
bar: every Map state must read well on it (`generate <Autopilot repo> --include
'src/packages/autopilot-vscode/src/**' 'src/packages/tests/vscode/**' --value-refs`).

## The altitude model

A reader operates at three altitudes; each needs different information:

| Altitude | Zoom | The eye needs | Status |
|---|---|---|---|
| **Orientation** | fit ≈ 0.2–0.45 | frame names, big flows, system shape | **fails** (F1) |
| **Reading** | ≈ 0.5–1.2 | card names, wire meanings | good (highways/grouping/spool work) |
| **Tracing** | selection / >1.2 | one wire's story | good (emphasis, un-bundle, spool) |

Measured on the 38-card, 3-frames-expanded state: auto-fit lands at **zoom 0.30**, where a file
card is 98×16 px on screen — its 12.5px label renders at ~3.8px, chips at 2.4px, the 30px frame
title bar at 9px. Everything is drawn; nothing is legible.

## Findings

- **F1 — No level-of-detail.** Zero zoom-dependent rendering anywhere in `nodes/modulemap/*`
  (minZoom is 0.01, maxZoom 4). Card DOM is identical at every zoom; at orientation zoom the map
  communicates nothing a colored rectangle couldn't, at full render cost.
- **F2 — Palette failed computable checks.** Validated against the `#0E1116` surface (dataviz
  skill validator, categorical mode): CVD separation and contrast PASSED, but `references
  #7C8CA3` and `implements #8FB6E3` failed the chroma floor (C < 0.10 — "reads gray"), and
  `references` sat within a hair of the neutral `WIRE_COLOR #7C8696` — after `--value-refs`,
  the *most common* relationship was visually the *least* distinguishable. Lightness band also
  failed: `instantiates`/`extends`/import-gold sat above L 0.67 and visually shouted over `calls`.
- **F3 — Wires carried no weight.** Map edges have `data.weight` (aggregated call sites) but drew
  at a constant 1.5px — a 40-call dependency looked identical to a 1-call one. `BlueprintEdge`
  (call surface) already scales width by `log2(weight)`; the Map never adopted it.
- **F4 — The Map ran the un-tuned ELK config.** The proven compaction options (NETWORK_SIMPLEX,
  EDGE_LENGTH post-compaction, tight layers) lived only in `buildElkGraph.ts` (call surface);
  `moduleLevelLayout.ts` ran 120px layers with no placement strategy, no compaction, no aspect
  hint → half-empty frame interiors and one-tall-column sprawl.
- **F5 — Wires are not interactive.** `interactionWidth: 0` — no hover, so the color vocabulary
  must be memorized from the legend; kind/weight/endpoints are undiscoverable in place.
- **F6 — Small frictions.** Ghost-group labels tail-ellipsize full paths (middle-truncation keeps
  both ends); selection ring wears the card's own kind accent (amber ring on an amber class card,
  colliding with the amber "changed" ring); minimap is dark-on-dark under a 0.7 mask.

## Roadmap

### P2 — wire encoding upgrade ✅ (shipped with this doc)

- **weight→width**: `min(4, 1.1 + 0.55·log2(weight))` at rest, +1 when lit
  (`moduleMapHighlight.ts`). Hot paths pop pre-attentively at any zoom.
- **Validated palette re-snap** (`mapPalette.ts`): keep every hue family, fix the failures —
  `references` → teal `#2FA8A3` (chroma-floor pass, no longer confusable with neutral/dimmed),
  `implements` → `#4E90DE`, `instantiates` → `#CE7040`, `extends` → `#B865AB`, import gold →
  `#AE8A38`/`#7A6630`. Full 7-wire set passes all four checks; the one documented exception is
  `IPC_WIRE #E06CB0` (L 0.689 vs 0.67 band max) — a shared cross-surface constant, the rarest and
  only-animated wire, deliberately hot. Tritan worst-pair is in the 8–12 floor band, legal because
  wires carry secondary encoding (dash styles + legend, P4 adds tooltips).
- Re-validate after any palette change:
  `node <dataviz-skill>/scripts/validate_palette.js "<calls,instantiates,extends,implements,references,IMPORT_CROSS,IPC_WIRE hexes>" --mode dark --surface "#0E1116"`

### P3 — Map ELK tuning ✅ (shipped with this doc)

`moduleLevelLayout.ts` ROOT_OPTIONS: layers 120→64, `nodePlacement.strategy: NETWORK_SIMPLEX`,
`compaction.postCompaction.strategy: EDGE_LENGTH`, `elk.aspectRatio: 1.6`. Mirrors the proven
call-surface config; verified A/B on the autopilot states (fit zoom 0.30→0.32, canvas aspect
2.13 landscape). **Honest residual**: an expanded frame that receives many cross-hierarchy edges
(protocol) still keeps an interior desert on its entry side — ELK reserves routing space inside
the frame. Config alone doesn't fix it; candidates are frame-boundary ports/gates or laying the
frame's children out without INCLUDE_CHILDREN pass-through. Tracked as follow-up under P1/P4.

### P3b — gutter-bus edge routing ✅ (shipped with this doc)

Field feedback on the spool: a fan whose far ends are DISTRIBUTED inside an expanded frame knotted
at one gather point and then swept vertically BEHIND the member cards — worse than plain curves.
Root cause: spooling controls where wires meet, not what path they take. Fix (`edgeRouting.ts` +
`RoutedEdge`): a frame-crossing wire enters through a GATE on the frame boundary at its source's
height, rides a vertical RAIL inside the frame's padding gutter (widened to 30px; rail at +12 —
a column no card ever occupies), and peels off horizontally into its target at the target's own
height. Wires sharing the rail overlap into a literal bus bar; every strand stays individually
addressable. Precedence: bundle (container pairs) → route (frame-crossing) → spool (open-canvas
fans only, e.g. the minimal overlay's ghost ring). Verified on the envelope.ts state: 16/25 wires
routed, knot gone, zero wires behind cards. The spool itself gained a GEOMETRY VETO: a wire
whose free end lacks forward room to approach the gather (a ghost card hugging its hub) falls
back to a plain curve instead of folding into an S-loop — trunks only where trunks make sense.

### P1 — semantic zoom ✅ (shipped)

CSS-driven, zero per-card React work (MapLod.tsx): ONE controller mirrors the zoom into a
`--map-zoom` variable + a `data-map-tier` attribute on the canvas; the whole tier is a stylesheet
acting on `lod-label` / `lod-hide` / `lod-tint` class tags the cards carry. Below z=0.45
(ORIENTATION): chrome hides, cards become accent-tinted blocks, one name per card inverse-scales
(`scale(clamp(1, 0.92/zoom, 4))`) toward legible — measured 3.8px → 13.3px on-screen at the
38-card fit. Above: untouched. `!important` on the tier rules is deliberate — cards are
inline-styled and the mode must win.

Residuals: unit/block/step internals keep full chrome at orientation (nested detail, rarely
visible zoomed out); the minimal overlay isn't LOD'd; the zoom-compensated minimum wire width
remains an idea.

### P4 — wire hover layer + lit lanes ✅ (shipped with this doc)

Field feedback: selecting a hub lit its wires but the shared bus made individual strands
unattributable — "you don't really see what each connection does". Two answers:
- **Hover**: every non-bundle wire is interactive (`interactionWidth 14`); pointing at a strand
  lights it alone and names it — `references ×4 · Bridge.ts → BridgeEventMap` (WireTooltip).
- **Lit lanes**: LIT wires sharing a rail spread into parallel lanes (3px apart, clamped inside
  the gutter) — a ribbon whose strands stay followable from gate to peel-off. Unlit wires keep
  overlapping into the single bus bar; collective legibility at rest, attribution under focus.

### P5 — polish (small)

Middle-truncate ghost-group paths (keep first + last segments); one consistent selection
treatment (uniform halo, not the kind accent, so it never collides with the amber diff ring);
minimap contrast bump (lighter node fills / thinner mask).

## Verification discipline

Every step gets re-verified against the autopilot-vscode states before merging: overview, folder
focus, frames expanded, Tests on/off, Highways on/off, a selection with summoned ghosts — headless
browser, screenshots, and counted DOM assertions (not just unit tests).
