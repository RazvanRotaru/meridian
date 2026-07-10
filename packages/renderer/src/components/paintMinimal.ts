/**
 * The minimal-graph overlay's PAINT pipeline, extracted pure from `MinimalGraphView` so the
 * overlay's colour parity with the Map lens is unit-testable. Every wire that carries the map's
 * edge-data contract (`data.category`: import / dep / flow) goes through the Map's OWN chain —
 * `suppressRedundantImports` then `emphasize` — so relationship colours (calls / instantiates /
 * extends / implements / references, and the import golds) read identically on both surfaces.
 * Only the overlay-minted [+n] stub tethers (no `data.category`; style fully baked at mint time in
 * `minimalSubgraphLayout`) skip the paint and re-append untouched.
 */

import type { Edge, Node } from "@xyflow/react";
import { emphasize, filterRelKinds, suppressRedundantImports, type HighlightMode } from "./moduleMapPaint";
import { MINIMAL_STUB_NODE } from "../layout/minimalSubgraphLayout";

// The nested-declaration node types an expanded file frame holds (drawn by the Map's own components).
const CHILD_NODE_TYPES: ReadonlySet<string> = new Set(["unit", "block", "step"]);

// A ghost-tier file dims to this at rest. Layered UNDER `emphasize`: an emphasize-dimmed ghost keeps
// the smaller dim (min wins), a LIT ghost still recedes to this opacity — the ghost read is preserved.
export const GHOST_OPACITY = 0.62;

const NO_HIDDEN_KINDS: ReadonlySet<string> = new Set();

/**
 * Paint the laid-out overlay with the Map's own edge chain: suppress a pair's import wire when a
 * typed dep wire already joins it, drop the relationship kinds the Map's toggles hide (the pills
 * stay live over the overlay), then `emphasize` colours every contract-carrying wire by
 * relationship kind and lights the selection's neighbourhood. `emphasize` only understands the
 * file-import graph, so nested declarations (unit/block/step) and the [+n] stubs pass through
 * untouched, after their parent frames. The page's ghost-tier dim layers UNDER emphasize's
 * selection dim (min wins), and the baked stub tethers re-append byte-identical — same order as
 * the component always drew them.
 */
export function paintMinimalLevel(
  nodes: Node[],
  edges: Edge[],
  selected: ReadonlySet<string>,
  radius: number,
  mode: HighlightMode,
  hiddenRelKinds: ReadonlySet<string> = NO_HIDDEN_KINDS,
): { nodes: Node[]; edges: Edge[] } {
  const fileNodes = nodes.filter((node) => node.type === "file");
  const stubNodes = nodes.filter((node) => node.type === MINIMAL_STUB_NODE);
  const childNodes = nodes.filter((node) => CHILD_NODE_TYPES.has(node.type ?? ""));
  const paintedEdges = edges.filter(carriesMapContract);
  const stubEdges = edges.filter((edge) => !carriesMapContract(edge));
  // The Map's exact order (ModuleMapView): suppress redundant imports → filter toggled-off kinds → emphasize.
  const emphasized = emphasize(fileNodes, filterRelKinds(suppressRedundantImports(paintedEdges), hiddenRelKinds), selected, radius, mode);
  const ghostLayered = emphasized.nodes.map((node) => (isGhost(node) ? dimGhost(node) : node));
  return { nodes: [...ghostLayered, ...childNodes, ...stubNodes], edges: [...emphasized.edges, ...stubEdges] };
}

// The map's ModuleTreeEdge data contract stamps a `category` on every wire (import / dep / flow);
// the overlay's stub tethers deliberately carry none — that absence routes them around the paint.
const carriesMapContract = (edge: Edge): boolean =>
  (edge.data as { category?: string } | undefined)?.category !== undefined;

const isGhost = (node: Node): boolean => (node.data as { tier?: string } | undefined)?.tier === "ghost";

// Dim a ghost card, keeping whatever smaller opacity emphasize already applied (a dimmed
// non-neighbour stays dim; a lit ghost drops to GHOST_OPACITY so the ghost tier still reads).
function dimGhost(node: Node): Node {
  const existing = (node.style?.opacity as number | undefined) ?? 1;
  return { ...node, style: { ...node.style, opacity: Math.min(existing, GHOST_OPACITY) } };
}
