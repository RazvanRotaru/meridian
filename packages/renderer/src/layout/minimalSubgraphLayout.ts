/**
 * Lay out a MinimalSubgraphSpec by MIRRORING the Module map: instead of a fresh whole-graph ELK pass,
 * every box the map had on screen keeps its exact captured map position (`basePositions`), and the rest
 * — off-map ghosts and later promotions — is placed relative to a connected placed node (see
 * `minimalPlacement`). Leaf cards reuse the Map's OWN `file` / `package` components (a ghost-tier card
 * dims in place). The overlay is FLAT: containment frames aren't drawn (their file cards sit at absolute
 * positions).
 *
 * The one exception to the flat mirror is IN-PLACE expansion: an expanded file becomes a frame whose
 * declarations nest inside. To size that frame and place its children WITHOUT reshuffling the rest, we
 * run the Map's OWN per-file nested-ELK pass (`layoutModuleTree`) on just that file's subtree, then
 * ANCHOR the frame's top-left at the file's captured/placed spot (its children ride along via
 * React Flow `parentId`). Deterministic — placement + ELK are both pure.
 */

import type { Edge, Node } from "@xyflow/react";
import { placeMinimalNodes, FILE_WIDTH, FILE_HEIGHT, type PlacedRect } from "./minimalPlacement";
import { reflowMinimalFiles } from "./minimalReflow";
import { arrangeMinimalCards } from "./minimalArrange";
import { layoutModuleTree } from "./moduleLevelLayout";
import type { MinimalSubgraphEdge, MinimalSubgraphNode, MinimalSubgraphSpec, MinimalTier } from "../derive/minimalSubgraph";
import type { MinimalExpansion } from "../derive/minimalExpansion";
import type { ModuleCardData } from "../derive/moduleLevel";
import type { ModulePackageData } from "../derive/packageOverview";

/** One expanded file laid out by the Map's own nested-ELK pass: its frame + child cards and their
 * intra-frame wires. The frame node (id === fileId) sits first, ready to be anchored. */
interface LaidExpansion {
  fileId: string;
  nodes: Node[];
  edges: Edge[];
}

/** Mirror the map: place each visible card at its captured spot (others relative), nest each expanded
 * file's declarations inside its frame, then wire. */
export async function layoutMinimalSubgraph(
  spec: MinimalSubgraphSpec,
  basePositions: Record<string, PlacedRect>,
  arrange = false,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (spec.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  // Only tiered LEAF cards render (a file, or a group member/ghost); tier-null containment frames are
  // flattened away — the overlay places their file cards at absolute positions.
  const cards = spec.nodes.filter((node) => node.tier !== null);
  // Placement rides on the IMPORT graph only (dep wires are a redundant subset — a→b calls implies
  // a→b imports), matching the Map's own layout substrate.
  const importEdges = spec.edges.filter((edge) => edge.kind === "import").map((edge) => ({ source: edge.source, target: edge.target }));
  const laidByFile = await layoutExpansions(spec.expansions);
  // Mirror path overrides sizes ONLY for expanded frames (captured cards keep their captured size — the
  // byte-for-byte mirror). Arrange path needs every card's real size so ELK reserves the right footprint.
  const placement = arrange
    ? await arrangeMinimalCards(cards.map((card) => card.id), cardSizes(cards, laidByFile), importEdges)
    : await mirrorPlacement(cards, importEdges, basePositions, frameSizes(laidByFile), laidByFile.size > 0);
  const { nodes, edges } = emitCards(cards, placement, laidByFile);
  const placedIds = new Set(nodes.map((node) => node.id));
  const importWires = spec.edges.filter((edge) => placedIds.has(edge.source) && placedIds.has(edge.target)).map(toRfEdge);
  return { nodes, edges: [...importWires, ...edges] };
}

// A group (package) leaf card renders wider/taller than a file card; size it so both placement paths
// reserve its real footprint (else neighbours crowd it).
const GROUP_WIDTH = 300;
const GROUP_HEIGHT = 60;

/** The rendered size of every leaf card: an expanded file's ELK frame size, else a group card's wider
 * package box, else the file-card default. Feeds both placement paths so spacing matches the render. */
function cardSizes(cards: MinimalSubgraphNode[], laidByFile: Map<string, LaidExpansion>): Record<string, { width: number; height: number }> {
  const frames = frameSizes(laidByFile);
  const sizes: Record<string, { width: number; height: number }> = {};
  for (const card of cards) {
    sizes[card.id] = frames[card.id] ?? (card.kind === "group" ? { width: GROUP_WIDTH, height: GROUP_HEIGHT } : { width: FILE_WIDTH, height: FILE_HEIGHT });
  }
  return sizes;
}

/** The map-mirror placement: captured cards at their exact map spot, the rest relative. With NO expanded
 * frame the mirror is returned UNCHANGED; with one, an interactive-layered ELK pass opens spacing around
 * the grown frames while preserving the arrangement (see `minimalReflow`). */
async function mirrorPlacement(
  cards: MinimalSubgraphNode[],
  importEdges: { source: string; target: string }[],
  basePositions: Record<string, PlacedRect>,
  sizes: Record<string, { width: number; height: number }>,
  hasExpansion: boolean,
): Promise<Record<string, PlacedRect>> {
  const seed = placeMinimalNodes({ fileIds: cards.map((card) => card.id), stubs: [], importEdges, basePositions, sizeOverrides: sizes });
  return hasExpansion ? reflowMinimalFiles(cards.map((card) => card.id), seed, importEdges) : seed;
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

/** Emit each leaf card: a group card at its rect; a collapsed file the flat card at its rect; an
 * expanded file its ELK-laid frame + children, anchored so the frame's top-left lands at the rect. */
function emitCards(
  cards: MinimalSubgraphNode[],
  placement: Record<string, PlacedRect>,
  laidByFile: Map<string, LaidExpansion>,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const card of cards) {
    const rect = placement[card.id];
    if (!rect) {
      continue;
    }
    if (card.kind === "group") {
      nodes.push(toGroupCardNode(card, rect));
      continue;
    }
    const laid = laidByFile.get(card.id);
    if (laid) {
      nodes.push(...anchorExpansion(laid.nodes, card.id, card.tier, rect));
      edges.push(...laid.edges);
    } else {
      nodes.push(toFileNode(card, rect));
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

// A group member/ghost is the Map's own `package` card at an absolute position — ONE card, never a
// frame of files. `readOnly` hides the (unmeaningful in a subgraph) coupling counts; `tier` dims a ghost.
function toGroupCardNode(node: MinimalSubgraphNode, rect: PlacedRect): Node {
  return {
    id: node.id,
    type: "package",
    position: { x: rect.x, y: rect.y },
    style: { width: rect.width, height: rect.height },
    data: { ...(node.data as ModulePackageData), isContainer: false, isExpanded: false, readOnly: true, tier: node.tier },
  };
}

function toRfEdge(edge: MinimalSubgraphEdge): Edge {
  // No baked stroke/marker on import/dep wires: the overlay's paint chain (suppressRedundantImports →
  // emphasize) styles them by relationship kind at rest and lights the selection's neighbourhood.
  // `data` is the map's edge shape that chain reads.
  if (edge.kind === "dep") {
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      data: { weight: edge.weight, crossFrame: false, category: "dep", depKind: edge.depKind, ghost: false },
    };
  }
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: { weight: edge.weight, crossFrame: edge.crossPackage ?? false, category: "import", ghost: false },
  };
}
