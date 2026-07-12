/**
 * Append-only presentation geometry for one short-lived graph-inspection session.
 *
 * Layout and paint are free to replace a ghost with a real card, move it into a frame, or rerun the
 * whole graph.  The ledger records the position the reader actually saw in absolute flow space, so
 * applying it to the next candidate graph can convert that point back into whatever parent-relative
 * coordinates the new node shape needs.  Semantic depth is part of the identity because the shared
 * canvas can mount several copies of the same semantic id at once.
 *
 * Session ownership deliberately lives outside this module.  Pass an empty ledger to begin a new
 * inspection; every later capture retains entries for nodes that are temporarily absent.
 */

import type { Edge, Node } from "@xyflow/react";

export interface AbsoluteNodePosition {
  x: number;
  y: number;
}

export type AdditiveNodePositionLedger = ReadonlyMap<string, AbsoluteNodePosition>;

/** Stable ledger key for one rendered semantic population. */
export function additiveNodePositionKey(node: Pick<Node, "id" | "data">): string {
  return positionKey(node.id, semanticDepthOf(node));
}

/**
 * Append every newly visible node to a position ledger without changing an existing entry.
 *
 * A fresh node normally records its candidate absolute position.  When it belongs to a candidate
 * subgraph whose already-recorded parent or wire-neighbour was moved by the new layout, it inherits
 * that node's old→candidate translation.  This keeps a newly revealed frontier beside the stable
 * card that revealed it while preserving the frontier's candidate relative geometry.
 */
export function captureAdditiveNodePositions(
  nodes: readonly Node[],
  previous: AdditiveNodePositionLedger = new Map(),
  edges: readonly Edge[] = [],
): Map<string, AbsoluteNodePosition> {
  const graph = indexNodes(nodes);
  const next = new Map(previous);
  const offsets = new Map<string, AbsoluteNodePosition>();

  // Visible recorded nodes are fixed seeds. Their delta explains how far the candidate layout moved
  // the thing the reader saw; new neighbours can reuse that delta without inheriting its exact point.
  for (const key of graph.keys) {
    const locked = previous.get(key);
    const candidate = graph.absolute.get(key);
    if (locked && candidate) {
      offsets.set(key, { x: locked.x - candidate.x, y: locked.y - candidate.y });
    }
  }

  // Parent-relative families should move as one unit. Resolve descendants first so a direct parent
  // wins over an unrelated relationship edge when both could anchor a newly visible node.
  let inheritedParentOffset = true;
  while (inheritedParentOffset) {
    inheritedParentOffset = false;
    for (const key of graph.keys) {
      if (offsets.has(key)) continue;
      const parentKey = graph.parentByKey.get(key);
      const parentOffset = parentKey === undefined ? undefined : offsets.get(parentKey);
      if (parentOffset === undefined) continue;
      offsets.set(key, parentOffset);
      inheritedParentOffset = true;
    }
  }

  // Reach the remaining new frontier from any locked node. Parent/child links are included in both
  // directions (a real frame can appear around a previously-root ghost), as are same-depth wires.
  const neighbours = adjacencyOf(graph, edges);
  const queue = [...offsets.keys()].sort();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const key = queue[cursor];
    const offset = offsets.get(key);
    if (!offset) continue;
    for (const neighbour of [...(neighbours.get(key) ?? [])].sort()) {
      if (offsets.has(neighbour)) continue;
      offsets.set(neighbour, offset);
      queue.push(neighbour);
    }
  }

  for (const key of graph.keys) {
    if (next.has(key)) continue;
    const candidate = graph.absolute.get(key);
    if (!candidate) continue;
    const offset = offsets.get(key);
    next.set(key, offset
      ? { x: candidate.x + offset.x, y: candidate.y + offset.y }
      : candidate);
  }
  return avoidRetainedCollisions(graph, previous, next);
}

const NEW_NODE_GAP = 18;

/** Candidate layout guarantees do not survive when old cards each snap back by different deltas.
 * Move only newly admitted root subtrees to the nearest free row; existing ledger points are never
 * changed. Nested descendants travel with their new root, while a new wrapper around a locked
 * descendant stays where that descendant anchored it so containment remains valid. */
function avoidRetainedCollisions(
  graph: NodeIndex,
  previous: AdditiveNodePositionLedger,
  captured: Map<string, AbsoluteNodePosition>,
): Map<string, AbsoluteNodePosition> {
  const next = new Map(captured);
  const retainedKeys = graph.keys.filter((key) => previous.has(key));
  const newKeys = new Set(graph.keys.filter((key) => !previous.has(key)));
  const occupied: PositionedNodeRect[] = retainedKeys.flatMap((key) => {
    const node = graph.byKey.get(key);
    const position = previous.get(key);
    return node && position ? [positionedNodeRect(key, node, position)] : [];
  });

  const newRoots = [...newKeys]
    .filter((key) => !graph.parentByKey.has(key))
    .sort();
  for (const rootKey of newRoots) {
    const root = graph.byKey.get(rootKey);
    const proposed = next.get(rootKey);
    if (!root || !proposed) continue;
    const subtree = [...newKeys].filter((key) => topAncestorKey(key, graph.parentByKey) === rootKey);
    const hasLockedDescendant = retainedKeys.some(
      (key) => key !== rootKey && topAncestorKey(key, graph.parentByKey) === rootKey,
    );
    const placed = hasLockedDescendant
      ? proposed
      : nearestFreeRootPosition(rootKey, root, proposed, occupied, graph.parentByKey);
    const dx = placed.x - proposed.x;
    const dy = placed.y - proposed.y;
    if (dx !== 0 || dy !== 0) {
      for (const key of subtree) {
        const position = next.get(key);
        if (position) next.set(key, { x: position.x + dx, y: position.y + dy });
      }
    }
    for (const key of subtree) {
      const node = graph.byKey.get(key);
      const position = next.get(key);
      if (node && position) occupied.push(positionedNodeRect(key, node, position));
    }
  }
  return next;
}

interface PositionedNodeRect extends AbsoluteNodePosition {
  key: string;
  width: number;
  height: number;
  depth: number | undefined;
}

function positionedNodeRect(key: string, node: Node, position: AbsoluteNodePosition): PositionedNodeRect {
  const style = (node.style ?? {}) as { width?: unknown; height?: unknown };
  const width = typeof style.width === "number" ? style.width : node.measured?.width ?? node.width ?? 0;
  const height = typeof style.height === "number" ? style.height : node.measured?.height ?? node.height ?? 0;
  return { key, ...position, width, height, depth: semanticDepthOf(node) };
}

function nearestFreeRootPosition(
  key: string,
  node: Node,
  proposed: AbsoluteNodePosition,
  occupied: readonly PositionedNodeRect[],
  parentByKey: ReadonlyMap<string, string>,
): AbsoluteNodePosition {
  const base = positionedNodeRect(key, node, proposed);
  if (base.width <= 0 || base.height <= 0) return proposed;
  const blockers = occupied.filter((other) =>
    other.depth === base.depth
    && !isContainmentRelative(key, other.key, parentByKey)
    && horizontalOverlap(base, other));
  const candidateYs = new Set<number>([proposed.y]);
  for (const blocker of blockers) {
    candidateYs.add(blocker.y + blocker.height + NEW_NODE_GAP);
    candidateYs.add(blocker.y - base.height - NEW_NODE_GAP);
  }
  const orderedYs = [...candidateYs].sort(
    (left, right) => Math.abs(left - proposed.y) - Math.abs(right - proposed.y) || left - right,
  );
  for (const y of orderedYs) {
    const candidate = { ...base, y };
    if (!blockers.some((other) => rectanglesOverlap(candidate, other))) {
      return { x: proposed.x, y };
    }
  }
  return proposed;
}

function horizontalOverlap(left: PositionedNodeRect, right: PositionedNodeRect): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x;
}

function rectanglesOverlap(left: PositionedNodeRect, right: PositionedNodeRect): boolean {
  return horizontalOverlap(left, right)
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function isContainmentRelative(
  left: string,
  right: string,
  parentByKey: ReadonlyMap<string, string>,
): boolean {
  return isAncestorKey(left, right, parentByKey) || isAncestorKey(right, left, parentByKey);
}

function isAncestorKey(
  ancestor: string,
  descendant: string,
  parentByKey: ReadonlyMap<string, string>,
): boolean {
  const seen = new Set<string>();
  let current = parentByKey.get(descendant);
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = parentByKey.get(current);
  }
  return false;
}

function topAncestorKey(key: string, parentByKey: ReadonlyMap<string, string>): string {
  const seen = new Set<string>([key]);
  let current = key;
  let parent = parentByKey.get(current);
  while (parent !== undefined && !seen.has(parent)) {
    current = parent;
    seen.add(parent);
    parent = parentByKey.get(current);
  }
  return current;
}

/**
 * Apply absolute ledger points to the current node hierarchy without changing its shape.
 * Recorded nodes keep exact canvas positions; unrecorded descendants keep their current relative
 * offset and therefore naturally travel with a recorded parent.  Objects whose relative position is
 * already correct retain identity.
 */
export function applyAdditiveNodePositions(
  nodes: readonly Node[],
  ledger: AdditiveNodePositionLedger,
): Node[] {
  if (nodes.length === 0 || ledger.size === 0) {
    return nodes as Node[];
  }
  const graph = indexNodes(nodes);
  const targetAbsolute = new Map<string, AbsoluteNodePosition>();
  const visiting = new Set<string>();

  const targetOf = (key: string): AbsoluteNodePosition | undefined => {
    const cached = targetAbsolute.get(key);
    if (cached) return cached;
    const node = graph.byKey.get(key);
    if (!node) return undefined;
    const locked = ledger.get(key);
    if (locked) {
      targetAbsolute.set(key, locked);
      return locked;
    }
    // A malformed parent cycle should not make presentation fail. The candidate absolute point is a
    // deterministic fallback; valid hierarchies take the normal parent-relative branch below.
    if (visiting.has(key)) {
      return graph.absolute.get(key) ?? node.position;
    }
    visiting.add(key);
    const parentKey = graph.parentByKey.get(key);
    const parent = parentKey === undefined ? undefined : targetOf(parentKey);
    const target = parent
      ? { x: parent.x + node.position.x, y: parent.y + node.position.y }
      : node.position;
    visiting.delete(key);
    targetAbsolute.set(key, target);
    return target;
  };

  return nodes.map((node) => {
    const key = additiveNodePositionKey(node);
    const target = targetOf(key);
    if (!target) return node;
    const parentKey = graph.parentByKey.get(key);
    const parent = parentKey === undefined ? undefined : targetOf(parentKey);
    const position = parent
      ? { x: target.x - parent.x, y: target.y - parent.y }
      : target;
    return position.x === node.position.x && position.y === node.position.y
      ? node
      : { ...node, position };
  });
}

interface NodeIndex {
  byKey: Map<string, Node>;
  keys: string[];
  parentByKey: Map<string, string>;
  absolute: Map<string, AbsoluteNodePosition>;
  keysById: Map<string, string[]>;
}

function indexNodes(nodes: readonly Node[]): NodeIndex {
  const byKey = new Map<string, Node>();
  const keysById = new Map<string, string[]>();
  for (const node of nodes) {
    const key = additiveNodePositionKey(node);
    byKey.set(key, node);
    const peers = keysById.get(node.id) ?? [];
    if (!peers.includes(key)) peers.push(key);
    keysById.set(node.id, peers);
  }
  const keys = [...byKey.keys()].sort();
  const parentByKey = new Map<string, string>();
  for (const key of keys) {
    const node = byKey.get(key)!;
    if (!node.parentId) continue;
    const candidate = positionKey(node.parentId, semanticDepthOf(node));
    if (byKey.has(candidate)) parentByKey.set(key, candidate);
  }
  const absolute = new Map<string, AbsoluteNodePosition>();
  for (const key of keys) {
    const node = byKey.get(key)!;
    let x = node.position.x;
    let y = node.position.y;
    let parentKey = parentByKey.get(key);
    const seen = new Set([key]);
    while (parentKey !== undefined && !seen.has(parentKey)) {
      const parent = byKey.get(parentKey);
      if (!parent) break;
      x += parent.position.x;
      y += parent.position.y;
      seen.add(parentKey);
      parentKey = parentByKey.get(parentKey);
    }
    absolute.set(key, { x, y });
  }
  return { byKey, keys, parentByKey, absolute, keysById };
}

function adjacencyOf(graph: NodeIndex, edges: readonly Edge[]): Map<string, Set<string>> {
  const adjacent = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    if (left === right || !graph.byKey.has(left) || !graph.byKey.has(right)) return;
    const leftPeers = adjacent.get(left) ?? new Set<string>();
    const rightPeers = adjacent.get(right) ?? new Set<string>();
    leftPeers.add(right);
    rightPeers.add(left);
    adjacent.set(left, leftPeers);
    adjacent.set(right, rightPeers);
  };
  for (const [child, parent] of graph.parentByKey) connect(child, parent);
  for (const edge of edges) {
    const depth = semanticDepthOf(edge);
    if (depth !== undefined) {
      connect(positionKey(edge.source, depth), positionKey(edge.target, depth));
      continue;
    }
    // Unstamped single-level edges are common. In a semantic composite, connect only endpoint
    // populations that share a depth; never let an id collision anchor one level to another.
    const targets = new Set(graph.keysById.get(edge.target) ?? []);
    for (const sourceKey of graph.keysById.get(edge.source) ?? []) {
      const sourceDepth = depthFromKey(sourceKey);
      const targetKey = positionKey(edge.target, sourceDepth);
      if (targets.has(targetKey)) connect(sourceKey, targetKey);
    }
  }
  return adjacent;
}

function semanticDepthOf(entry: Pick<Node | Edge, "data">): number | undefined {
  const depth = (entry.data as { semanticDepth?: unknown } | undefined)?.semanticDepth;
  return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : undefined;
}

function positionKey(id: string, depth: number | undefined): string {
  return JSON.stringify([depth ?? null, id]);
}

function depthFromKey(key: string): number | undefined {
  const [depth] = JSON.parse(key) as [number | null, string];
  return depth ?? undefined;
}
