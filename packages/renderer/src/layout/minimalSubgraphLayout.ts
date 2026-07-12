/**
 * Lay out a MinimalSubgraphSpec by MIRRORING the Module map: instead of a fresh whole-graph ELK pass,
 * every member box the map had on screen keeps its exact captured map position (`basePositions`), and
 * later promotions are placed relative to a connected placed node (see `minimalPlacement`). Member
 * cards reuse the Map's OWN `file` / `package` components. The overlay is FLAT: containment frames
 * aren't drawn (their file cards sit at absolute positions). GHOST satellites are kept OUT of both
 * placement paths — exactly like the Map (`moduleLevelLayout`), they band outside the member core via
 * `placeGhostBands` (importers left, dependencies right) and reposition selection-relative at paint.
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
import { placeGhostBands } from "./ghostBandPlacement";
import type { MinimalSubgraphEdge, MinimalSubgraphNode, MinimalSubgraphSpec, MinimalTier } from "../derive/minimalSubgraph";
import type { MinimalExpansion } from "../derive/minimalExpansion";
import type { MinimalRollupExpansion } from "../derive/minimalRollupExpansion";
import type { ModuleCardData } from "../derive/moduleLevel";
import type { GhostData } from "../derive/ghostDeps";
import type { ModuleGroupData, ModuleTreeEdge, VisibleModuleNode } from "../derive/moduleTree";
import { MAP_RELATION_POLICY, type LensRelationPolicy } from "../graph/lensRelationPolicy";
import { relationParticipatesInLayout } from "../graph/lensRelationPolicy";

/** One expanded Map subtree laid out by the Map's own nested-ELK pass. Its root sits first, ready to
 * be anchored among the minimal graph's other top-level cards. */
interface LaidExpansion {
  rootId: string;
  nodes: Node[];
  edges: Edge[];
  nodeIds: ReadonlySet<string>;
}

export interface MinimalRollupLayoutExpansion extends MinimalRollupExpansion {
  tier: MinimalTier;
}

/** Mirror the map: place each visible card at its captured spot (others relative), nest each expanded
 * file's declarations inside its frame, then wire. */
export async function layoutMinimalSubgraph(
  spec: MinimalSubgraphSpec,
  basePositions: Record<string, PlacedRect>,
  arrange = false,
  relationPolicy: LensRelationPolicy = MAP_RELATION_POLICY,
  groupExpansions: readonly MinimalRollupLayoutExpansion[] = [],
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (spec.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const groupNodeIds = new Set(groupExpansions.flatMap((expansion) => expansion.nodes.map((node) => node.id)));
  const laidByRoot = await layoutExpansions(
    spec.expansions.filter((expansion) => !groupNodeIds.has(expansion.fileId)),
    groupExpansions,
    relationPolicy,
  );
  // Tiered leaf cards enter placement, except descendants already owned by an expanded package
  // frame. Each such frame contributes one virtual top-level card at its retained package id.
  const cards = [
    ...spec.nodes.filter((node) => node.tier !== null && !groupNodeIds.has(node.id)),
    ...groupRootCards(groupExpansions),
  ];
  const expansionOwner = expansionOwnerByNode(laidByRoot);
  // The map-mirror still grows along imports, matching the Map's own placement substrate. Re-arrange
  // uses every INTERNAL visible relation: valid artifacts (including the bundled sample) may carry
  // calls/instantiates without redundant import edges, and discarding those wires makes ELK see a
  // connected member set as isolated cards. Ghost wires stay outside core placement.
  const importEdges = projectPlacementEdges(
    spec.edges.filter((edge) => edge.kind === "import"),
    expansionOwner,
  );
  const arrangeEdges = spec.edges
    .filter((edge) => edge.ghost !== true && minimalEdgeParticipatesInLayout(edge, relationPolicy))
    .map((edge) => projectPlacementEdge(edge, expansionOwner))
    .filter((edge): edge is { source: string; target: string } => edge !== null);
  // Mirror path overrides only expanded frames and group summary cards: captured FILE cards keep their
  // exact map footprint, while a package member must always use its own 300×60 summary-card footprint.
  // Arrange path needs every card's real size so ELK reserves the right footprint.
  const placement = arrange
    ? await arrangeMinimalCards(cards.map((card) => card.id), cardSizes(cards, laidByRoot), arrangeEdges)
    : await mirrorPlacement(cards, importEdges, basePositions, mirrorSizeOverrides(cards, laidByRoot), laidByRoot.size > 0);
  const { nodes, edges } = emitCards(cards, placement, laidByRoot);
  const banded = ghostSatellites(spec, nodes);
  const placedIds = new Set([...nodes, ...banded].map((node) => node.id));
  const wires = spec.edges
    .filter((edge) => placedIds.has(edge.source) && placedIds.has(edge.target))
    .filter((edge) => !insideSameExpansion(edge, expansionOwner))
    .map(toRfEdge);
  return { nodes: [...nodes, ...banded], edges: [...wires, ...edges] };
}

/** Represent each opened package as one top-level placement card. Emission replaces it with the
 * already-laid canonical frame and leaves every child parent-relative inside that frame. */
function groupRootCards(expansions: readonly MinimalRollupLayoutExpansion[]): MinimalSubgraphNode[] {
  return expansions.flatMap((expansion) => {
    const root = expansion.nodes.find((node) => node.id === expansion.rootId);
    return root === undefined
      ? []
      : [{
          id: expansion.rootId,
          kind: "group" as const,
          parentId: null,
          tier: expansion.tier,
          data: root.data as ModuleGroupData,
        }];
  });
}

/** Every nested endpoint belongs to its top-level expansion root for outer-card placement. */
function expansionOwnerByNode(laidByRoot: ReadonlyMap<string, LaidExpansion>): Map<string, string> {
  const owner = new Map<string, string>();
  for (const [rootId, expansion] of laidByRoot) {
    expansion.nodeIds.forEach((nodeId) => owner.set(nodeId, rootId));
  }
  return owner;
}

function projectPlacementEdges(
  edges: readonly MinimalSubgraphEdge[],
  owner: ReadonlyMap<string, string>,
): Array<{ source: string; target: string }> {
  const projected: Array<{ source: string; target: string }> = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const placed = projectPlacementEdge(edge, owner);
    if (placed === null) {
      continue;
    }
    const key = `${placed.source}\u0000${placed.target}`;
    if (!seen.has(key)) {
      seen.add(key);
      projected.push(placed);
    }
  }
  return projected;
}

function projectPlacementEdge(
  edge: Pick<MinimalSubgraphEdge, "source" | "target">,
  owner: ReadonlyMap<string, string>,
): { source: string; target: string } | null {
  const source = owner.get(edge.source) ?? edge.source;
  const target = owner.get(edge.target) ?? edge.target;
  return source === target ? null : { source, target };
}

/** Canonical Map layout already emitted relationships wholly inside an expanded subtree. */
function insideSameExpansion(
  edge: Pick<MinimalSubgraphEdge, "source" | "target">,
  owner: ReadonlyMap<string, string>,
): boolean {
  const sourceOwner = owner.get(edge.source);
  return sourceOwner !== undefined && sourceOwner === owner.get(edge.target);
}

function minimalEdgeParticipatesInLayout(
  edge: MinimalSubgraphEdge,
  relationPolicy: LensRelationPolicy,
): boolean {
  const kind = edge.kind === "import" ? "imports" : edge.depKind;
  return kind !== undefined && relationParticipatesInLayout(relationPolicy, kind);
}

/** Band the ghost satellites outside the placed member core, exactly like the Map: `placeGhostBands`
 * hangs each past the box edge nearest its anchor (importers left, dependencies right), sized by the
 * Map's own `ghostSize`, emitted as root-level `ghost` React Flow nodes. */
function ghostSatellites(spec: MinimalSubgraphSpec, coreNodes: Node[]): Node[] {
  const ghosts: VisibleModuleNode[] = spec.nodes
    .filter((node) => node.kind === "ghost")
    .map((node) => ({ id: node.id, parentId: null, kind: "ghost" as const, isContainer: false, isExpanded: false, depth: 0, childCount: 0, data: node.data as GhostData }));
  if (ghosts.length === 0 || coreNodes.length === 0) {
    return [];
  }
  const wires: ModuleTreeEdge[] = spec.edges
    .filter((edge) => edge.ghost === true)
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      weight: edge.weight,
      crossFrame: edge.crossFrame,
      crossPackage: edge.crossPackage,
      outsideView: edge.outsideView,
      category: "dep" as const,
      relationKind: edge.depKind,
      depKind: edge.depKind,
      ghost: true,
      underlyingEdgeIds: edge.underlyingEdgeIds,
    }));
  return placeGhostBands(ghosts, wires, coreNodes);
}

// A group (package) leaf card renders wider/taller than a file card; size it so both placement paths
// reserve its real footprint (else neighbours crowd it).
const GROUP_WIDTH = 300;
const GROUP_HEIGHT = 60;

/** The rendered size of every leaf card: an expanded file's ELK frame size, else a group card's wider
 * package box, else the file-card default. Feeds both placement paths so spacing matches the render. */
function cardSizes(cards: MinimalSubgraphNode[], laidByRoot: Map<string, LaidExpansion>): Record<string, { width: number; height: number }> {
  const frames = frameSizes(laidByRoot);
  const sizes: Record<string, { width: number; height: number }> = {};
  for (const card of cards) {
    sizes[card.id] = frames[card.id] ?? (card.kind === "group" ? { width: GROUP_WIDTH, height: GROUP_HEIGHT } : { width: FILE_WIDTH, height: FILE_HEIGHT });
  }
  return sizes;
}

/** The map-mirror keeps captured FILE geometry byte-for-byte, but an overlay group is always the
 * package summary card (not whatever footprint its source map happened to use). Expanded files
 * retain their ELK frame override. */
function mirrorSizeOverrides(cards: MinimalSubgraphNode[], laidByRoot: Map<string, LaidExpansion>): Record<string, { width: number; height: number }> {
  const sizes = frameSizes(laidByRoot);
  for (const card of cards) {
    if (card.kind === "group" && sizes[card.id] === undefined) {
      sizes[card.id] = { width: GROUP_WIDTH, height: GROUP_HEIGHT };
    }
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

/** Run the Map's nested-ELK pass over expanded files and rolled package subtrees, keyed by root. */
async function layoutExpansions(
  fileExpansions: MinimalExpansion[],
  groupExpansions: readonly MinimalRollupLayoutExpansion[],
  relationPolicy: LensRelationPolicy,
): Promise<Map<string, LaidExpansion>> {
  const expansions = [
    ...fileExpansions.map((expansion) => ({
      rootId: expansion.fileId,
      nodes: expansion.nodes,
      edges: expansion.edges,
    })),
    ...groupExpansions.map((expansion) => ({
      rootId: expansion.rootId,
      nodes: expansion.nodes,
      edges: expansion.edges,
    })),
  ];
  const laid = await Promise.all(
    expansions.map(async (exp) => {
      const { nodes, edges } = await layoutModuleTree(exp.nodes, exp.edges, relationPolicy);
      return {
        rootId: exp.rootId,
        nodes,
        edges,
        nodeIds: new Set(exp.nodes.map((node) => node.id)),
      } satisfies LaidExpansion;
    }),
  );
  return new Map(laid.map((entry) => [entry.rootId, entry]));
}

/** The ELK-sized frame box per expanded root, for placement to reserve space. */
function frameSizes(laidByRoot: Map<string, LaidExpansion>): Record<string, { width: number; height: number }> {
  const sizes: Record<string, { width: number; height: number }> = {};
  for (const [rootId, laid] of laidByRoot) {
    const frame = laid.nodes.find((node) => node.id === rootId);
    const style = (frame?.style ?? {}) as { width?: number; height?: number };
    if (typeof style.width === "number" && typeof style.height === "number") {
      sizes[rootId] = { width: style.width, height: style.height };
    }
  }
  return sizes;
}

/** Emit each leaf card: a group card at its rect; a collapsed file the flat card at its rect; an
 * expanded file its ELK-laid frame + children, anchored so the frame's top-left lands at the rect. */
function emitCards(
  cards: MinimalSubgraphNode[],
  placement: Record<string, PlacedRect>,
  laidByRoot: Map<string, LaidExpansion>,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const card of cards) {
    const rect = placement[card.id];
    if (!rect) {
      continue;
    }
    const laid = laidByRoot.get(card.id);
    if (laid) {
      nodes.push(...anchorExpansion(laid.nodes, card.id, card.tier, rect));
      edges.push(...laid.edges);
    } else if (card.kind === "group") {
      nodes.push(toGroupCardNode(card, rect));
    } else {
      nodes.push(toFileNode(card, rect));
    }
  }
  return { nodes, edges };
}

/** Move an expanded file's laid subtree so its frame sits at `rect`: only the frame node (the sole
 * root) is repositioned — its children are parent-relative, so they ride along untouched. The frame
 * keeps its overlay `tier` so an expanded origin still reads seed like its collapsed card. */
function anchorExpansion(laidNodes: Node[], rootId: string, tier: MinimalTier | null, rect: PlacedRect): Node[] {
  return laidNodes.map((node) =>
    node.id === rootId
      ? { ...node, position: { x: rect.x, y: rect.y }, data: { ...node.data, tier } }
      : node,
  );
}

// A file is the Map's own `file` card at an absolute position, carrying its member `tier`.
function toFileNode(node: MinimalSubgraphNode, rect: PlacedRect): Node {
  return {
    id: node.id,
    type: "file",
    position: { x: rect.x, y: rect.y },
    style: { width: rect.width, height: rect.height },
    data: { ...(node.data as ModuleCardData), tier: node.tier },
  };
}

// A group member is the Map's own `package` card at an absolute position — ONE card, never a frame
// of files. `readOnly` hides the (unmeaningful in a subgraph) coupling counts. Expandability is
// already carried by the ordinary ModuleGroupData contract; the shared chevron owns disclosure.
function toGroupCardNode(node: MinimalSubgraphNode, rect: PlacedRect): Node {
  return {
    id: node.id,
    type: "package",
    position: { x: rect.x, y: rect.y },
    style: { width: rect.width, height: rect.height },
    data: { ...(node.data as ModuleGroupData), readOnly: true, tier: node.tier },
  };
}

function toRfEdge(edge: MinimalSubgraphEdge): Edge {
  // No baked stroke/marker on import/dep wires: the overlay's paint chain (suppressRedundantImports →
  // emphasize) styles them by relationship kind at rest and lights the selection's neighbourhood.
  // `data` is the map's edge shape that chain reads. Preserve the ghost bit so the shared paint
  // pruner shows only satellites attached to the current selection. This is what turns the raw ring
  // derived from every current member into an on-demand, member-by-member exploration frontier.
  if (edge.kind === "dep") {
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      data: {
        weight: edge.weight,
        crossFrame: edge.crossFrame,
        crossPackage: edge.crossPackage,
        outsideView: edge.outsideView,
        category: "dep",
        relationKind: edge.depKind,
        depKind: edge.depKind,
        // `outsideView` owns the dash semantic; `ghost` independently owns on-demand visibility.
        ghost: edge.ghost === true,
        underlyingEdgeIds: edge.underlyingEdgeIds,
      },
    };
  }
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: {
      weight: edge.weight,
      crossFrame: edge.crossFrame,
      crossPackage: edge.crossPackage,
      outsideView: edge.outsideView,
      category: "import",
      relationKind: "imports",
      ghost: edge.ghost === true,
      underlyingEdgeIds: edge.underlyingEdgeIds,
    },
  };
}
