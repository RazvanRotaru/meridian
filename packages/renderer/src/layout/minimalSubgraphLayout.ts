/**
 * Lay out a MinimalSubgraphSpec by MIRRORING the Module map: instead of a fresh whole-graph ELK pass,
 * every file the map had on screen keeps its exact captured map position (`basePositions`), and the
 * rest — off-map neighbours, later expansions, and the [+n] stubs — is placed relative to a connected
 * placed node (see `minimalPlacement`). File cards reuse the Map's OWN `file` card (ghost-tier dims in
 * place), a `minimalStub` is the single all-neighbours [+n] expander.
 *
 * The one exception to the flat mirror is IN-PLACE expansion: an expanded file becomes a frame whose
 * declarations nest inside. To size that frame and place its children WITHOUT reshuffling the rest, we
 * run the Map's OWN per-file nested-ELK pass (`layoutModuleTree`) on just that file's subtree, then
 * ANCHOR the frame's top-left at the file's captured/placed spot (its children ride along via
 * React Flow `parentId`). The frame's real ELK height feeds back into placement so the [+n] stubs hang
 * off the taller box and neighbour files step past it. Deterministic — placement + ELK are both pure.
 */

import type { Edge, Node } from "@xyflow/react";
import { placeMinimalNodes, placeStubs, type PlacedRect, type PlacementStub } from "./minimalPlacement";
import { reflowMinimalFiles } from "./minimalReflow";
import { layoutModuleTree } from "./moduleLevelLayout";
import type { MinimalStubData, MinimalSubgraphEdge, MinimalSubgraphNode, MinimalSubgraphSpec, MinimalTier } from "../derive/minimalSubgraph";
import type { MinimalExpansion } from "../derive/minimalExpansion";
import type { ModuleCardData } from "../derive/moduleLevel";

/** The React Flow node type the overlay registers on top of `moduleNodeTypes` for the [+n] expanders. */
export const MINIMAL_STUB_NODE = "minimalStub";

// A stub tether is styled here (it stays untouched by the component's emphasis pass). Import wires
// carry only map-shaped `data` — the component's `emphasize` colours them by coupling / selection.
const STUB_EDGE_COLOR = "#2A313C";

/** One expanded file laid out by the Map's own nested-ELK pass: its frame + child cards and their
 * intra-frame wires. The frame node (id === fileId) sits first, ready to be anchored. */
interface LaidExpansion {
  fileId: string;
  nodes: Node[];
  edges: Edge[];
}

/** Mirror the map: place each visible file at its captured spot (others relative), nest each expanded
 * file's declarations inside its frame, then wire. */
export async function layoutMinimalSubgraph(
  spec: MinimalSubgraphSpec,
  basePositions: Record<string, PlacedRect>,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (spec.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const files = spec.nodes.filter((node) => node.kind === "file");
  const stubs = spec.nodes.filter((node) => node.kind === "stub");
  const stubDescriptors = stubs.map((node) => stubDescriptor(node));
  const importEdges = spec.edges.filter((edge) => edge.kind === "import").map((edge) => ({ source: edge.source, target: edge.target }));
  const laidByFile = await layoutExpansions(spec.expansions);
  const seed = placeMinimalNodes({ fileIds: files.map((node) => node.id), stubs: stubDescriptors, importEdges, basePositions, sizeOverrides: frameSizes(laidByFile) });
  // Constraint: with NO expanded frame the captured-position mirror (`seed`) is returned UNCHANGED —
  // the reflow is never reached. With one, an interactive-layered ELK pass opens spacing around the
  // grown frames while preserving the arrangement (see `minimalReflow`).
  const placement = laidByFile.size > 0 ? await reflowAroundFrames(files, stubDescriptors, importEdges, seed) : seed;
  const { nodes, edges } = emitFiles(files, placement, laidByFile);
  for (const stub of stubs) {
    const rect = placement[stub.id];
    if (rect) {
      nodes.push(toStubNode(stub, rect));
    }
  }
  const placedIds = new Set(nodes.map((node) => node.id));
  const importWires = spec.edges.filter((edge) => placedIds.has(edge.source) && placedIds.has(edge.target)).map(toRfEdge);
  return { nodes, edges: [...importWires, ...edges] };
}

/** Expanded state only: reflow the file rects with position-seeded interactive-layered ELK (opens
 * spacing, keeps arrangement), then re-hang the stubs against the reflowed files. */
async function reflowAroundFrames(
  files: MinimalSubgraphNode[],
  stubs: PlacementStub[],
  importEdges: { source: string; target: string }[],
  seed: Record<string, PlacedRect>,
): Promise<Record<string, PlacedRect>> {
  const fileRects = await reflowMinimalFiles(files.map((file) => file.id), seed, importEdges);
  return { ...fileRects, ...placeStubs(stubs, fileRects) };
}

/** Run the Map's per-file nested-ELK pass over each expanded file's subtree, keyed by file id. */
async function layoutExpansions(expansions: MinimalExpansion[]): Promise<Map<string, LaidExpansion>> {
  const laid = await Promise.all(
    expansions.map(async (exp) => {
      const { nodes, edges } = await layoutModuleTree(exp.nodes, exp.edges);
      return { fileId: exp.fileId, nodes, edges } satisfies LaidExpansion;
    }),
  );
  return new Map(laid.map((entry) => [entry.fileId, entry]));
}

/** The ELK-sized frame box per expanded file (its width/height), for placement to reserve space. */
function frameSizes(laidByFile: Map<string, LaidExpansion>): Record<string, { width: number; height: number }> {
  const sizes: Record<string, { width: number; height: number }> = {};
  for (const [fileId, laid] of laidByFile) {
    const frame = laid.nodes.find((node) => node.id === fileId);
    const style = (frame?.style ?? {}) as { width?: number; height?: number };
    if (typeof style.width === "number" && typeof style.height === "number") {
      sizes[fileId] = { width: style.width, height: style.height };
    }
  }
  return sizes;
}

/** Emit each file: a collapsed file is the flat card at its rect; an expanded file is its ELK-laid
 * frame + children, anchored so the frame's top-left lands at the placed rect. */
function emitFiles(
  files: MinimalSubgraphNode[],
  placement: Record<string, PlacedRect>,
  laidByFile: Map<string, LaidExpansion>,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const file of files) {
    const rect = placement[file.id];
    if (!rect) {
      continue;
    }
    const laid = laidByFile.get(file.id);
    if (laid) {
      nodes.push(...anchorExpansion(laid.nodes, file.id, file.tier, rect));
      edges.push(...laid.edges);
    } else {
      nodes.push(toFileNode(file, rect));
    }
  }
  return { nodes, edges };
}

/** Move an expanded file's laid subtree so its frame sits at `rect`: only the frame node (the sole
 * root) is repositioned — its children are parent-relative, so they ride along untouched. The frame
 * carries its overlay `tier` so a ghost-tier expanded file still dims like its collapsed card. */
function anchorExpansion(laidNodes: Node[], fileId: string, tier: MinimalTier | null, rect: PlacedRect): Node[] {
  return laidNodes.map((node) =>
    node.id === fileId
      ? { ...node, position: { x: rect.x, y: rect.y }, data: { ...(node.data as ModuleCardData), tier } }
      : node,
  );
}

function stubDescriptor(node: MinimalSubgraphNode): { id: string; sourceId: string } {
  const data = node.data as MinimalStubData;
  return { id: node.id, sourceId: data.sourceId };
}

// A file is the Map's own `file` card at an absolute position. It carries its `tier` so the component
// can dim ghosts UNDER the shared `emphasize` selection paint (no opacity is baked here anymore).
function toFileNode(node: MinimalSubgraphNode, rect: PlacedRect): Node {
  return {
    id: node.id,
    type: "file",
    position: { x: rect.x, y: rect.y },
    style: { width: rect.width, height: rect.height },
    data: { ...(node.data as ModuleCardData), tier: node.tier },
  };
}

function toStubNode(node: MinimalSubgraphNode, rect: PlacedRect): Node {
  return {
    id: node.id,
    type: MINIMAL_STUB_NODE,
    position: { x: rect.x, y: rect.y },
    style: { width: rect.width, height: rect.height },
    data: node.data as MinimalStubData,
  };
}

function toRfEdge(edge: MinimalSubgraphEdge): Edge {
  if (edge.kind === "stub") {
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      style: { stroke: STUB_EDGE_COLOR, strokeWidth: 1, strokeDasharray: "2 3", opacity: 0.6 },
      selectable: false,
    };
  }
  // No baked stroke/marker: the component's `emphasize` styles import wires by coupling at rest and
  // lights the selection's neighbourhood. `data` is the map's edge shape emphasize reads.
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: { weight: edge.weight, crossFrame: edge.crossPackage ?? false, category: "import", ghost: false },
  };
}
