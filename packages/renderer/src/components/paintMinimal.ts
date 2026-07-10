/**
 * The minimal-graph overlay's PAINT pipeline, extracted pure from `MinimalGraphView` so the
 * overlay's colour parity with the Map lens is unit-testable. Every drawn card — file frames, group
 * (package) member cards, ghost satellites, AND an expanded file's nested unit/block/step
 * declarations — goes through the Map's OWN chain (`suppressRedundantImports` → `filterRelKinds` →
 * `emphasize`), so relationship colours (calls / instantiates / extends / implements / references,
 * and the import golds), the dim-at-rest read, and the selection walk are the Map's by construction.
 * Ghost satellites even reposition selection-relative inside `emphasize` (`repositionLitGhosts`) —
 * the Map's own beside-the-selection banding. They stay VISIBLE at rest (unlike the Map's on-demand
 * prune) because their wires are minted `ghost: false` — see `minimalSubgraphLayout`'s toRfEdge.
 */

import type { Edge, Node } from "@xyflow/react";
import { emphasize, filterRelKinds, suppressRedundantImports, type HighlightMode } from "./moduleMapPaint";

const NO_HIDDEN_KINDS: ReadonlySet<string> = new Set();

/**
 * Paint the laid-out overlay with the Map's own edge chain: suppress a pair's import wire when a
 * typed dep wire already joins it, drop the relationship kinds the Map's toggles hide (the pills
 * stay live over the overlay), then `emphasize` colours every wire by relationship kind and lights
 * the selection's neighbourhood. ALL drawn cards go through `emphasize` in their laid-out
 * parents-before-children order (exactly what ModuleMapView feeds it), so clicking a nested
 * declaration lights its wires, selecting an expanded frame seeds its drawn descendants, and a
 * selection re-bands the ghost satellites around its lit subgraph — the same as on the Map.
 */
export function paintMinimalLevel(
  nodes: Node[],
  edges: Edge[],
  selected: ReadonlySet<string>,
  radius: number,
  mode: HighlightMode,
  hiddenRelKinds: ReadonlySet<string> = NO_HIDDEN_KINDS,
): { nodes: Node[]; edges: Edge[] } {
  // The Map's exact order (ModuleMapView): suppress redundant imports → filter toggled-off kinds → emphasize.
  const { nodes: paintedNodes, edges: paintedEdges } = emphasize(nodes, filterRelKinds(suppressRedundantImports(edges), hiddenRelKinds), selected, radius, mode);
  return { nodes: paintedNodes, edges: paintedEdges };
}
