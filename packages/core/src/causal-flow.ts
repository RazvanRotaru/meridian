import type { GraphEdge, GraphNode, NodeId } from "./types";

/** A graph edge rewritten into the direction in which effects propagate. */
export interface CausalArc {
  /** Stable id of the graph edge that proves this relationship. */
  edgeId: string;
  source: NodeId;
  target: NodeId;
  kind: CausalArcKind;
  /** Original open-vocabulary graph edge kind. */
  edgeKind: string;
  confidence: number;
  /** True when the graph edge points opposite to causal time (currently `awaitsPromise`). */
  reversed: boolean;
}

export type CausalArcKind =
  | "call"
  | "instantiate"
  | "send"
  | "handle"
  | "create"
  | "resolve"
  | "reject"
  | "await"
  /** Identity/resource correspondence used for discovery, not a runtime event. */
  | "alias";

export interface CausalSliceNode {
  id: NodeId;
  /** Number of causal hops from this node to the nearest seed, or null when only downstream. */
  backwardDepth: number | null;
  /** Number of causal hops from the nearest seed to this node, or null when only upstream. */
  forwardDepth: number | null;
}

export interface CausalSlice {
  seedIds: NodeId[];
  /** Nodes ordered from upstream causes, through seeds, to downstream consequences. */
  nodes: CausalSliceNode[];
  /** Traversed causal relationships (plus resource aliases), in deterministic display order. */
  arcs: CausalArc[];
  /** Lowest confidence among the included arcs; 1 when the slice has no arcs. */
  confidence: number;
  /** True when a depth or node bound omitted a reachable node. */
  truncated: boolean;
  /**
   * Admitted boundary nodes whose next causal relationship was omitted by a traversal bound.
   * Kept directional so focused projections can distinguish a cut trigger path from an unrelated
   * deep consequence branch (and vice versa).
   */
  truncationFrontier: {
    backward: NodeId[];
    forward: NodeId[];
  };
  /** Stable content fingerprint suitable for memoization and UI identity. */
  fingerprint: string;
}

export interface ComposeCausalSliceInput {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  seedIds: readonly NodeId[];
}

export interface CausalSliceOptions {
  /** Maximum number of hops explored in each direction from a seed. Defaults to 8. */
  maxDepth?: number;
  /** Maximum number of admitted nodes, excluding no requested seed. Defaults to 64. */
  maxNodes?: number;
  /** Ignore relationships below this confidence. Defaults to 0. */
  minConfidence?: number;
}

interface NormalizedOptions {
  maxDepth: number;
  maxNodes: number;
  minConfidence: number;
}

interface WalkResult {
  depths: Map<NodeId, number>;
  traversedEdgeIds: Set<string>;
  frontierNodeIds: Set<NodeId>;
  truncated: boolean;
}

interface TraversalState {
  id: NodeId;
  depth: number;
  /** The await edge after which effects in this callable must occur, if any. */
  afterAwaitEdgeId: string | null;
}

interface WalkPolicy {
  canTraverse(state: TraversalState, arc: CausalArc): boolean;
  nextContext(arc: CausalArc): string | null;
}

/**
 * Compose a bounded causal neighborhood around one or more graph resources/callables.
 *
 * The composer deliberately knows only generic graph semantics. Promise settlement and IPC
 * channel edges are normalized into causal time, then the same backward/forward traversal handles
 * both. Framework-specific matching belongs in extraction/linking, before this function runs.
 */
export function composeCausalSlice(
  input: ComposeCausalSliceInput,
  options: CausalSliceOptions = {},
): CausalSlice {
  const knownNodeIds = new Set(input.nodes.map((node) => node.id));
  const seedIds = [...new Set(input.seedIds.filter((id) => knownNodeIds.has(id)))].sort();
  const normalizedOptions = normalizeOptions(options, seedIds.length);
  const arcs = input.edges
    .map(normalizeCausalArc)
    .filter((arc): arc is CausalArc =>
      arc !== null
      && arc.confidence >= normalizedOptions.minConfidence
      && knownNodeIds.has(arc.source)
      && knownNodeIds.has(arc.target))
    .sort(compareArcs);

  const runtimeArcs = arcs.filter((arc) => arc.kind !== "alias");
  const aliases = groupAliases(arcs.filter((arc) => arc.kind === "alias"));
  const incoming = preferRuntimeDeliveries(groupArcs(runtimeArcs, (arc) => arc.target));
  const outgoing = groupArcs(runtimeArcs, (arc) => arc.source);
  const edgeById = new Map(input.edges.map((edge) => [edge.id, edge]));
  const admitted = new Set<NodeId>(seedIds);

  const backward = walk(
    seedIds,
    incoming,
    aliases,
    (arc) => arc.source,
    admitted,
    normalizedOptions,
  );
  const forwardPolicy: WalkPolicy = {
    // Crossing `Promise -> awaiter` establishes a source-order boundary inside the awaiter.
    // Function-level call edges otherwise conflate calls before and after the wait. Admit only an
    // occurrence proven to start after the whole await expression; absent ranges are insufficient
    // evidence and therefore stop expansion at the awaiter.
    canTraverse: (state, arc) => state.afterAwaitEdgeId === null
      || occursAfter(edgeById.get(arc.edgeId), edgeById.get(state.afterAwaitEdgeId)),
    // The boundary applies only to effects in the awaiting callable. Once one such effect invokes
    // another callable, all work inside that new invocation is downstream of the wait.
    nextContext: (arc) => arc.kind === "await" ? arc.edgeId : null,
  };
  const forward = walk(
    seedIds,
    outgoing,
    aliases,
    (arc) => arc.target,
    admitted,
    normalizedOptions,
    forwardPolicy,
  );

  const nodes = [...admitted]
    .map((id): CausalSliceNode => ({
      id,
      backwardDepth: backward.depths.get(id) ?? null,
      forwardDepth: forward.depths.get(id) ?? null,
    }))
    .sort(compareSliceNodes);
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const traversedEdgeIds = new Set([
    ...backward.traversedEdgeIds,
    ...forward.traversedEdgeIds,
  ]);
  const includedArcs = arcs
    .filter((arc) => admitted.has(arc.source)
      && admitted.has(arc.target)
      && (arc.kind === "alias" || traversedEdgeIds.has(arc.edgeId)))
    .sort((a, b) => compareArcsForDisplay(a, b, nodeOrder));
  const confidence = includedArcs.reduce(
    (minimum, arc) => Math.min(minimum, arc.confidence),
    1,
  );

  return {
    seedIds,
    nodes,
    arcs: includedArcs,
    confidence,
    truncated: backward.truncated || forward.truncated,
    truncationFrontier: {
      backward: [...backward.frontierNodeIds].sort(),
      forward: [...forward.frontierNodeIds].sort(),
    },
    fingerprint: fingerprint(seedIds, nodes, includedArcs),
  };
}

function normalizeOptions(options: CausalSliceOptions, seedCount: number): NormalizedOptions {
  const requestedMaxNodes = integerAtLeast(options.maxNodes, 64, 1);
  return {
    maxDepth: integerAtLeast(options.maxDepth, 8, 0),
    maxNodes: Math.max(seedCount, requestedMaxNodes),
    minConfidence: clamp(options.minConfidence ?? 0, 0, 1),
  };
}

function integerAtLeast(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(minimum, Math.floor(value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeCausalArc(edge: GraphEdge): CausalArc | null {
  // Ordinary unresolved/external calls have no proven target relationship. Candidate boundary
  // correlations, in contrast, carry an explicit confidence and remain useful to the viewer.
  if (edge.resolution !== undefined && edge.resolution !== "resolved" && edge.confidence === undefined) {
    return null;
  }

  const confidence = clamp(edge.confidence ?? 1, 0, 1);
  const base = {
    edgeId: edge.id,
    confidence,
    edgeKind: edge.kind,
    reversed: false,
  } as const;

  switch (edge.kind) {
    case "calls":
      return { ...base, source: edge.source, target: edge.target, kind: "call" };
    case "instantiates":
      return { ...base, source: edge.source, target: edge.target, kind: "instantiate" };
    case "sends":
      return { ...base, source: edge.source, target: edge.target, kind: "send" };
    case "handles":
      return { ...base, source: edge.source, target: edge.target, kind: "handle" };
    case "createsPromise":
      return { ...base, source: edge.source, target: edge.target, kind: "create" };
    case "resolvesPromise":
      return { ...base, source: edge.source, target: edge.target, kind: "resolve" };
    case "rejectsPromise":
      return { ...base, source: edge.source, target: edge.target, kind: "reject" };
    case "returnsPromise":
      return { ...base, source: edge.source, target: edge.target, kind: "alias" };
    case "awaitsPromise":
      return {
        ...base,
        source: edge.target,
        target: edge.source,
        kind: "await",
        reversed: true,
      };
    default:
      return null;
  }
}

function groupAliases(arcs: readonly CausalArc[]): Map<NodeId, NodeId[]> {
  const groups = new Map<NodeId, Set<NodeId>>();
  for (const arc of arcs) {
    addAlias(groups, arc.source, arc.target);
    addAlias(groups, arc.target, arc.source);
  }
  return new Map(
    [...groups.entries()].map(([id, aliases]) => [id, [...aliases].sort()]),
  );
}

function addAlias(groups: Map<NodeId, Set<NodeId>>, source: NodeId, target: NodeId): void {
  const group = groups.get(source);
  if (group) {
    group.add(target);
  } else {
    groups.set(source, new Set([target]));
  }
}

function groupArcs(
  arcs: readonly CausalArc[],
  keyOf: (arc: CausalArc) => NodeId,
): Map<NodeId, CausalArc[]> {
  const groups = new Map<NodeId, CausalArc[]>();
  for (const arc of arcs) {
    const key = keyOf(arc);
    const group = groups.get(key);
    if (group) {
      group.push(arc);
    } else {
      groups.set(key, [arc]);
    }
  }
  return groups;
}

/**
 * When a callable is reached through a materialized channel, that delivery is its runtime entry.
 * Ordinary static callers alongside it are typically setup code, direct unit tests, or framework
 * registration paths; following all of them produces a broad fan-in instead of the event/RPC
 * sequence. Prefer the proven delivery and stop those competing call paths at the boundary.
 */
function preferRuntimeDeliveries(
  incoming: Map<NodeId, CausalArc[]>,
): Map<NodeId, CausalArc[]> {
  for (const [target, arcs] of incoming) {
    if (arcs.some((arc) => arc.kind === "handle")) {
      incoming.set(target, arcs.filter((arc) => arc.kind === "handle"));
    }
  }
  return incoming;
}

function walk(
  seedIds: readonly NodeId[],
  adjacency: ReadonlyMap<NodeId, readonly CausalArc[]>,
  aliases: ReadonlyMap<NodeId, readonly NodeId[]>,
  nextNode: (arc: CausalArc) => NodeId,
  admitted: Set<NodeId>,
  options: NormalizedOptions,
  policy?: WalkPolicy,
): WalkResult {
  const depths = new Map<NodeId, number>();
  const traversedEdgeIds = new Set<string>();
  const frontierNodeIds = new Set<NodeId>();
  const queue: TraversalState[] = [];
  const queued = new Set<string>();
  let cursor = 0;
  let truncated = false;

  const admitAliasClosure = (starts: readonly TraversalState[]): void => {
    const aliasQueue = [...starts]
      .sort(compareTraversalStates)
      .map((state) => ({ state, boundaryNodeId: null as NodeId | null }));
    let aliasCursor = 0;
    while (aliasCursor < aliasQueue.length) {
      const { state: current, boundaryNodeId } = aliasQueue[aliasCursor++];
      const key = traversalStateKey(current);
      if (queued.has(key)) {
        continue;
      }
      if (!admitted.has(current.id) && admitted.size >= options.maxNodes) {
        truncated = true;
        if (boundaryNodeId !== null) frontierNodeIds.add(boundaryNodeId);
        continue;
      }
      admitted.add(current.id);
      const knownDepth = depths.get(current.id);
      if (knownDepth === undefined || current.depth < knownDepth) {
        depths.set(current.id, current.depth);
      }
      queued.add(key);
      queue.push(current);
      for (const alias of aliases.get(current.id) ?? []) {
        aliasQueue.push({ state: { ...current, id: alias }, boundaryNodeId: current.id });
      }
    }
  };

  admitAliasClosure(seedIds.map((id) => ({ id, depth: 0, afterAwaitEdgeId: null })));

  while (cursor < queue.length) {
    const current = queue[cursor++];
    for (const arc of adjacency.get(current.id) ?? []) {
      if (policy && !policy.canTraverse(current, arc)) {
        continue;
      }
      const next = nextNode(arc);
      const nextDepth = current.depth + 1;
      if (nextDepth > options.maxDepth) {
        truncated = true;
        frontierNodeIds.add(current.id);
        continue;
      }
      if (!admitted.has(next) && admitted.size >= options.maxNodes) {
        truncated = true;
        frontierNodeIds.add(current.id);
        continue;
      }
      traversedEdgeIds.add(arc.edgeId);
      admitAliasClosure([{
        id: next,
        depth: nextDepth,
        afterAwaitEdgeId: policy?.nextContext(arc) ?? null,
      }]);
    }
  }

  return { depths, traversedEdgeIds, frontierNodeIds, truncated };
}

function traversalStateKey(state: TraversalState): string {
  return `${state.id}\u0000${state.afterAwaitEdgeId ?? ""}`;
}

function compareTraversalStates(a: TraversalState, b: TraversalState): number {
  return a.id.localeCompare(b.id)
    || (a.afterAwaitEdgeId ?? "").localeCompare(b.afterAwaitEdgeId ?? "")
    || a.depth - b.depth;
}

/** Whether at least one occurrence represented by `candidate` begins after an await occurrence. */
function occursAfter(candidate: GraphEdge | undefined, boundary: GraphEdge | undefined): boolean {
  const candidateSites = candidate?.callSites ?? [];
  const boundarySites = boundary?.callSites ?? [];
  return candidateSites.some((candidateSite) => boundarySites.some((boundarySite) => {
    if (candidateSite.file !== boundarySite.file) return false;
    const boundaryEndLine = boundarySite.endLine ?? boundarySite.line;
    if (candidateSite.line !== boundaryEndLine) return candidateSite.line > boundaryEndLine;
    // A same-line comparison is safe only with the await's exclusive end column. Comparing with
    // its start would incorrectly classify the call *inside* `await call()` as a consequence.
    return boundarySite.endCol !== undefined
      && candidateSite.col !== undefined
      && candidateSite.col >= boundarySite.endCol;
  }));
}

function compareArcs(a: CausalArc, b: CausalArc): number {
  return a.source.localeCompare(b.source)
    || a.target.localeCompare(b.target)
    || a.kind.localeCompare(b.kind)
    || a.edgeKind.localeCompare(b.edgeKind)
    || a.edgeId.localeCompare(b.edgeId);
}

function compareSliceNodes(a: CausalSliceNode, b: CausalSliceNode): number {
  const aPosition = causalPosition(a);
  const bPosition = causalPosition(b);
  return aPosition - bPosition || a.id.localeCompare(b.id);
}

function causalPosition(node: CausalSliceNode): number {
  if (node.backwardDepth !== null && node.backwardDepth > 0) {
    return -node.backwardDepth;
  }
  return node.forwardDepth ?? 0;
}

function compareArcsForDisplay(
  a: CausalArc,
  b: CausalArc,
  nodeOrder: ReadonlyMap<NodeId, number>,
): number {
  return (nodeOrder.get(a.source) ?? 0) - (nodeOrder.get(b.source) ?? 0)
    || (nodeOrder.get(a.target) ?? 0) - (nodeOrder.get(b.target) ?? 0)
    || compareArcs(a, b);
}

function fingerprint(
  seedIds: readonly NodeId[],
  nodes: readonly CausalSliceNode[],
  arcs: readonly CausalArc[],
): string {
  const canonical = JSON.stringify({
    seeds: [...seedIds].sort(),
    nodes: nodes
      .map((node) => [node.id, node.backwardDepth, node.forwardDepth])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    arcs: arcs
      .map((arc) => [
        arc.edgeId,
        arc.source,
        arc.target,
        arc.kind,
        arc.edgeKind,
        arc.confidence,
        arc.reversed,
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
  return fnv1a(canonical);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
