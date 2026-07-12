/**
 * Reversible ghost-neighbour inspection over an already-derived module tree. The caller adds every
 * visited exact artifact as a temporary extra root before this pass; the ordinary module derive then
 * does all of the important work for free: visited ghosts become real code cards, calls between
 * visible cards become ordinary dependency wires, and each visited card's off-view callers/callees
 * become the normal one-hop ghost ring.
 *
 * This decorator records which of those existing nodes and edges belong to the retained trail. It
 * never adds graph content, walks through a frontier node, or mutates persistent membership. Thus
 * A -> B -> C with only B visited retains A/B/C and the two incident call wires, but does not retain
 * C -> D until C itself is visited. The provenance anchor's original ghost ring is retained across
 * relationship kinds (the click must not discard its sibling context), and any direct seed-to-seed
 * bridge survives even when it is not a call. Containment ancestors are marked too, giving
 * interaction code one `ghostInspectionPath` test for a trail card or any frame enclosing it.
 */

import type { GraphIndex } from "../graph/graphIndex";
import { relationKindOf } from "../graph/relationEdge";
import type {
  GhostInspectionNodeData,
  ModuleTree,
  ModuleTreeEdge,
  VisibleModuleNode,
} from "./moduleTreeTypes";

export interface GhostInspectionPath {
  /** Drawn provenance owners which connect the temporary trail back to the original scene. */
  anchorIds: ReadonlySet<string>;
  /** Exact artifact ids the reader explicitly visited, accumulated one click at a time. */
  visitedIds: ReadonlySet<string>;
}

const NODE_MARKERS = [
  "ghostInspectionPath",
  "ghostInspectionVisited",
  "ghostInspectionFrontier",
  "ghostInspectionPreview",
] as const satisfies readonly (keyof GhostInspectionNodeData)[];

/** Decorate one freshly derived tree for the active inspection trail. `committedExtraIds` is the
 * existing `mapExtra` set: a committed file/unit/block covers every exact descendant beneath it,
 * so those visited cards stay on the path but no longer wear the reversible-preview marker. */
export function decorateGhostInspectionTree(
  tree: ModuleTree,
  index: GraphIndex,
  inspection: GhostInspectionPath | null,
  committedExtraIds: ReadonlySet<string>,
): ModuleTree {
  const visited = inspection?.visitedIds ?? EMPTY_IDS;
  if (inspection === null || visited.size === 0) {
    return clearInspectionMarkers(tree);
  }

  const anchors = inspection.anchorIds;
  const pathEdges = new Set<string>();
  const frontier = new Set<string>();
  const pathNodes = new Set<string>([...anchors, ...visited]);
  const nodeById = new Map(tree.nodes.map((node) => [node.id, node]));
  const anchorEndpoint = anchorEndpointPredicate(anchors, index, nodeById);

  const seeds = new Set([...anchors, ...visited]);
  // The anchor keeps the COMPLETE ghost ring which existed before inspection, across relation kinds.
  // Newly materialized visited nodes reveal only direct calls. A non-call edge directly joining two
  // seed nodes is still the bridge which explains the retained trail and must therefore survive.
  // Newly found frontier nodes are deliberately not fed back as seeds: recursion requires a click.
  for (const edge of tree.edges) {
    // A provenance owner can be a selected file/unit frame while the ghost wire terminates on one
    // of its drawn descendants. Treat both canonical and synthetic drawn containment as the anchor.
    const sourceAnchor = anchorEndpoint(edge.source);
    const targetAnchor = anchorEndpoint(edge.target);
    const sourceVisited = visited.has(edge.source);
    const targetVisited = visited.has(edge.target);
    const anchorGhostRing = edge.ghost === true && (sourceAnchor || targetAnchor);
    const visitedCall = relationKindOf(edge) === "calls" && (sourceVisited || targetVisited);
    const seedBridge = (sourceVisited && (targetVisited || targetAnchor))
      || (targetVisited && sourceAnchor)
      || (seeds.has(edge.source) && seeds.has(edge.target));
    if (!anchorGhostRing && !visitedCall && !seedBridge) continue;
    pathEdges.add(edge.id);
    pathNodes.add(edge.source);
    pathNodes.add(edge.target);
    if (!sourceVisited && !sourceAnchor) frontier.add(edge.source);
    if (!targetVisited && !targetAnchor) frontier.add(edge.target);
  }

  // A click on a visible container around any trail/frontier card is still a click inside the
  // inspection path. Cover both canonical GraphIndex ancestry and drawn parentId ancestry: Service
  // frames/domains are synthetic and therefore exist only in the latter.
  const ancestrySeeds = [...pathNodes];
  for (const id of ancestrySeeds) {
    for (const ancestor of index.ancestorsOf(id)) pathNodes.add(ancestor.id);
    addDrawnAncestors(id, nodeById, pathNodes);
  }

  const nodes = tree.nodes.map((node) => decorateNode(
    node,
    pathNodes.has(node.id),
    visited.has(node.id),
    frontier.has(node.id) && !visited.has(node.id) && !anchors.has(node.id),
    visited.has(node.id) && !coveredByCommittedRoot(node.id, committedExtraIds, index),
  ));
  const edges = tree.edges.map((edge) => decorateEdge(edge, pathEdges.has(edge.id)));
  if (sameObjects(nodes, tree.nodes) && sameObjects(edges, tree.edges)) return tree;
  return { ...tree, nodes, edges };
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

function anchorEndpointPredicate(
  anchorIds: ReadonlySet<string>,
  index: GraphIndex,
  nodeById: ReadonlyMap<string, VisibleModuleNode>,
): (id: string) => boolean {
  const cache = new Map<string, boolean>();
  return (id) => {
    const known = cache.get(id);
    if (known !== undefined) return known;
    const owned = [...anchorIds].some((anchorId) =>
      index.isWithinFocus(anchorId, id) || isWithinDrawnParent(anchorId, id, nodeById),
    );
    cache.set(id, owned);
    return owned;
  };
}

function isWithinDrawnParent(
  ancestorId: string,
  id: string,
  nodeById: ReadonlyMap<string, VisibleModuleNode>,
): boolean {
  const seen = new Set<string>();
  let current: string | null = id;
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = nodeById.get(current)?.parentId ?? null;
  }
  return false;
}

function addDrawnAncestors(
  id: string,
  nodeById: ReadonlyMap<string, VisibleModuleNode>,
  pathNodes: Set<string>,
): void {
  const seen = new Set<string>();
  let current = nodeById.get(id)?.parentId ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    pathNodes.add(current);
    current = nodeById.get(current)?.parentId ?? null;
  }
}

function coveredByCommittedRoot(
  id: string,
  committedExtraIds: ReadonlySet<string>,
  index: GraphIndex,
): boolean {
  for (const rootId of committedExtraIds) {
    if (rootId === id || index.isWithinFocus(rootId, id)) return true;
  }
  return false;
}

function decorateNode(
  node: VisibleModuleNode,
  onPath: boolean,
  visited: boolean,
  frontier: boolean,
  preview: boolean,
): VisibleModuleNode {
  const current = node.data as GhostInspectionNodeData;
  const desired = { onPath, visited, frontier, preview };
  if (
    (current.ghostInspectionPath === true) === desired.onPath
    && (current.ghostInspectionVisited === true) === desired.visited
    && (current.ghostInspectionFrontier === true) === desired.frontier
    && (current.ghostInspectionPreview === true) === desired.preview
  ) {
    return node;
  }
  const data = { ...node.data } as GhostInspectionNodeData;
  for (const marker of NODE_MARKERS) delete data[marker];
  if (onPath) data.ghostInspectionPath = true;
  if (visited) data.ghostInspectionVisited = true;
  if (frontier) data.ghostInspectionFrontier = true;
  if (preview) data.ghostInspectionPreview = true;
  return { ...node, data: data as VisibleModuleNode["data"] };
}

function decorateEdge(edge: ModuleTreeEdge, onPath: boolean): ModuleTreeEdge {
  if ((edge.ghostInspectionPath === true) === onPath) return edge;
  if (onPath) return { ...edge, ghostInspectionPath: true };
  const clean = { ...edge };
  delete clean.ghostInspectionPath;
  return clean;
}

/** Reusing a previously decorated tree with an empty inspection must not leak stale preview/path
 * semantics. Fresh production derives normally take the fast identity branch here. */
function clearInspectionMarkers(tree: ModuleTree): ModuleTree {
  const nodes = tree.nodes.map((node) => decorateNode(node, false, false, false, false));
  const edges = tree.edges.map((edge) => decorateEdge(edge, false));
  if (sameObjects(nodes, tree.nodes) && sameObjects(edges, tree.edges)) return tree;
  return { ...tree, nodes, edges };
}

function sameObjects<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
