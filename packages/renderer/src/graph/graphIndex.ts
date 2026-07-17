/**
 * The graph index: O(1) lookups the renderer needs on every toggle.
 *
 * `node.id` from the artifact is the React Flow node id AND the telemetry join key, so the
 * index keys everything by that id verbatim and never mints a parallel identifier.
 */

import { collectChangedIds, collectTestIds, deriveGraphStructure } from "@meridian/core";
import type {
  ChangeStatus,
  GraphArtifact,
  GraphEdge,
  GraphNode,
  GraphStructureFacts,
} from "@meridian/core";
import type { SerializedServiceTopologyV1 } from "@meridian/design-metrics";

export interface GraphIndex {
  /** Immutable full-revision identity/size, never inferred from a bounded slice. */
  graphSummary: GraphRevisionSummary;
  /** Authoritative repository/containment facts. In a projection these describe only bounded
   * identities plus O(1) repository totals; they never imply that omitted nodes are loaded. */
  structure: GraphStructureFacts;
  /** Complete-revision service abstraction supplied only by Service projections. */
  serviceTopology: SerializedServiceTopologyV1 | null;
  /** True only when this index was built from a complete local GraphArtifact. */
  artifactComplete: boolean;
  nodesById: Map<string, GraphNode>;
  childrenByParent: Map<string, GraphNode[]>;
  roots: GraphNode[];
  parentOf: Map<string, string | null>;
  outEdges: Map<string, GraphEdge[]>;
  edges: GraphEdge[];
  /** Artifact edges by id — the Wire Inspector resolves a wire's `underlyingEdgeIds` through this. */
  edgesById: Map<string, GraphEdge>;
  /** Every test-code node (tag or path heuristic), closed over containment — the hide-tests set. */
  testIds: Set<string>;
  /** Every `private`-tagged node (the open tags vocabulary) — the Map's hide-privates set. */
  privateIds: Set<string>;
  /** Every node tagged "changed" (`--changed-since`) — the exact edits, no containment closure. */
  changedIds: Set<string>;
  /** The change status (added/modified/deleted) per changed node — includes the file/module nodes a
   * PR touched, so the ring paints green/gold/red by kind. `--changed-since` seeds every id "modified". */
  changedStatus: Map<string, ChangeStatus>;
  /** Changed nodes strictly inside each container, so a COLLAPSED ancestor can hint at them. */
  changedDescendants: Map<string, number>;
  /** Exact direct-child count, optionally restricted to renderer-relevant node kinds. */
  childCount(nodeId: string, kinds?: ReadonlySet<string>): number;
  isContainer(nodeId: string): boolean;
  /** Ordered children actually loaded in this graph slice (source order). */
  childrenOf(nodeId: string): GraphNode[];
  /** The containment path root..id INCLUSIVE, for the dive-in breadcrumb. */
  ancestorsOf(nodeId: string): GraphNode[];
  /** Whether nodeId lies in focusId's subtree (inclusive); a null focus contains everything. */
  isWithinFocus(focusId: string | null, nodeId: string): boolean;
}

export interface GraphRevisionSummary {
  schemaVersion: string;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
}

export interface GraphIndexMetadata {
  structure?: GraphStructureFacts;
  graphSummary?: GraphRevisionSummary;
  serviceTopology?: SerializedServiceTopologyV1 | null;
  artifactComplete?: boolean;
}

/**
 * Conservative ownership charge for one presentation-only index over shared HEAD/base objects.
 *
 * The composite reuses node/edge objects already owned by the decoded pair, but allocates fresh
 * arrays, maps, sets, hierarchy slots, and (in the worst case) shallow tombstone node wrappers.
 * Charge those containers structurally so pending and Back/Forward budgets never treat a third
 * GraphIndex as free.
 */
export function estimateGraphPresentationResidentBytes(
  maxNodeCount: number,
  maxEdgeCount: number,
): number {
  const nodes = boundedCount(maxNodeCount, "maxNodeCount");
  const edges = boundedCount(maxEdgeCount, "maxEdgeCount");
  const map = (entries: number) => saturatedResidentAdd(56, entries * 40);
  const set = (entries: number) => saturatedResidentAdd(56, entries * 24);
  const array = (entries: number) => saturatedResidentAdd(40, entries * 8);
  let bytes = 2_048; // GraphIndex/artifact/structure objects and callable closures.
  bytes = saturatedResidentAdd(bytes, map(nodes)); // nodesById
  bytes = saturatedResidentAdd(bytes, map(nodes)); // childrenByParent
  bytes = saturatedResidentAdd(bytes, array(nodes)); // all grouped child slots
  bytes = saturatedResidentAdd(bytes, array(nodes)); // roots upper bound
  bytes = saturatedResidentAdd(bytes, map(nodes)); // parentOf
  bytes = saturatedResidentAdd(bytes, map(Math.min(nodes, edges))); // outEdges buckets
  bytes = saturatedResidentAdd(bytes, array(edges)); // all grouped outbound-edge slots
  bytes = saturatedResidentAdd(bytes, array(edges)); // edges
  bytes = saturatedResidentAdd(bytes, map(edges)); // edgesById
  bytes = saturatedResidentAdd(bytes, set(nodes) * 3); // test/private/changed ids
  bytes = saturatedResidentAdd(bytes, map(nodes) * 2); // changedStatus/changedDescendants
  bytes = saturatedResidentAdd(bytes, map(nodes)); // presentation hierarchyById
  bytes = saturatedResidentAdd(bytes, array(nodes)); // moduleOverviewRootIds upper bound
  bytes = saturatedResidentAdd(bytes, array(nodes)); // presentation artifact nodes array
  bytes = saturatedResidentAdd(bytes, nodes * 128); // shallow remapped tombstone wrappers
  return bytes;
}

type AuthoritativeGraphIndexMetadata = Pick<
  GraphIndex,
  "graphSummary" | "structure" | "serviceTopology" | "artifactComplete"
>;

/**
 * Extend a revision index with presentation-only nodes without redefining the revision itself.
 *
 * Review tombstones are not part of HEAD, so repository totals, overview roots, and hierarchy
 * facts for HEAD identities remain authoritative. Only hierarchy facts wholly local to the newly
 * appended nodes are derived and added. In particular, a tombstone attached to a surviving HEAD
 * parent must not change that parent's exact revision child counts.
 */
export function graphIndexMetadataWithPresentationNodes(
  authoritative: AuthoritativeGraphIndexMetadata,
  appendedNodes: readonly GraphNode[],
): GraphIndexMetadata {
  if (appendedNodes.length === 0) {
    return {
      graphSummary: authoritative.graphSummary,
      structure: authoritative.structure,
      serviceTopology: authoritative.serviceTopology,
      artifactComplete: authoritative.artifactComplete,
    };
  }

  const appendedStructure = deriveGraphStructure(appendedNodes, []);
  const hierarchyById = new Map(authoritative.structure.hierarchyById);
  for (const [id, fact] of appendedStructure.hierarchyById) {
    if (!hierarchyById.has(id)) hierarchyById.set(id, fact);
  }
  return {
    graphSummary: authoritative.graphSummary,
    serviceTopology: authoritative.serviceTopology,
    artifactComplete: authoritative.artifactComplete,
    structure: {
      hierarchyById,
      moduleOverviewRootIds: authoritative.structure.moduleOverviewRootIds,
      moduleOverview: authoritative.structure.moduleOverview,
      repositorySummary: authoritative.structure.repositorySummary,
    },
  };
}

/**
 * Remove presentation-only identities while preserving the underlying revision's exact metadata.
 * This is the inverse boundary used before a review composite is rebuilt; it deliberately filters
 * known overlay facts instead of inferring new revision facts from the currently loaded slice.
 */
export function graphIndexMetadataWithoutPresentationNodes(
  source: AuthoritativeGraphIndexMetadata,
  removedIds: ReadonlySet<string>,
): GraphIndexMetadata {
  if (removedIds.size === 0) {
    return {
      graphSummary: source.graphSummary,
      structure: source.structure,
      serviceTopology: source.serviceTopology,
      artifactComplete: source.artifactComplete,
    };
  }

  const hierarchyById = new Map(source.structure.hierarchyById);
  for (const id of removedIds) hierarchyById.delete(id);
  return {
    graphSummary: source.graphSummary,
    serviceTopology: source.serviceTopology,
    artifactComplete: source.artifactComplete,
    structure: {
      hierarchyById,
      moduleOverviewRootIds: source.structure.moduleOverviewRootIds.filter((id) => !removedIds.has(id)),
      moduleOverview: source.structure.moduleOverview,
      repositorySummary: source.structure.repositorySummary,
    },
  };
}

export function buildGraphIndex(
  artifact: GraphArtifact,
  metadata: GraphIndexMetadata = {},
): GraphIndex {
  const structure = metadata.structure ?? deriveGraphStructure(artifact.nodes, artifact.edges);
  const nodesById = indexById(artifact.nodes);
  const childrenByParent = groupByParent(artifact.nodes);
  const parentOf = mapParents(artifact.nodes);
  const changedIds = collectChangedIds(artifact.nodes);
  return {
    graphSummary: metadata.graphSummary ?? {
      schemaVersion: artifact.schemaVersion,
      generatedAt: artifact.generatedAt,
      nodeCount: artifact.nodes.length,
      edgeCount: artifact.edges.length,
    },
    structure,
    serviceTopology: metadata.serviceTopology ?? null,
    artifactComplete: metadata.artifactComplete
      ?? (metadata.structure === undefined && metadata.graphSummary === undefined),
    nodesById,
    childrenByParent,
    roots: artifact.nodes.filter(isRoot),
    parentOf,
    outEdges: groupOutEdges(artifact.edges),
    edges: artifact.edges,
    edgesById: new Map(artifact.edges.map((edge) => [edge.id, edge])),
    testIds: collectTestIds(artifact.nodes),
    privateIds: new Set(artifact.nodes.filter((node) => node.tags?.includes("private")).map((node) => node.id)),
    changedIds,
    // A tag-based (`--changed-since`) artifact carries no per-node status, so every changed id defaults
    // to "modified" (gold) — a PR review overwrites this via applyChangedStatus with real add/mod kinds.
    changedStatus: new Map<string, ChangeStatus>([...changedIds].map((id) => [id, "modified"] as [string, ChangeStatus])),
    changedDescendants: countChangedDescendants(changedIds, parentOf),
    childCount: (nodeId, kinds) => childCount(structure, nodeId, kinds),
    isContainer: (nodeId) => childCount(structure, nodeId) > 0,
    childrenOf: (nodeId) => childrenByParent.get(nodeId) ?? [],
    ancestorsOf: (nodeId) => ancestorsOf(nodeId, nodesById, parentOf),
    isWithinFocus: (focusId, nodeId) => isWithinFocus(focusId, nodeId, parentOf),
  };
}

function boundedCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function saturatedResidentAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(right) || right < 0 || left >= Number.MAX_SAFE_INTEGER - right) {
    return Number.MAX_SAFE_INTEGER;
  }
  return left + right;
}

function childCount(
  structure: GraphStructureFacts,
  nodeId: string,
  kinds?: ReadonlySet<string>,
): number {
  const counts = structure.hierarchyById.get(nodeId)?.childKindCounts;
  if (counts === undefined) return 0;
  let total = 0;
  for (const [kind, count] of Object.entries(counts)) {
    if (kinds === undefined || kinds.has(kind)) total += count;
  }
  return total;
}

/**
 * Overwrite the "changed" set at runtime, in place, and rebuild changedDescendants to match. A GitHub
 * PR review reuses the same `--changed-since` channel every card already paints from: computing the
 * modified code blocks (diff hunks ∩ node ranges) and pushing them here makes the Map + minimal
 * overlay ring exactly those blocks amber, for free. Mutating the one index object every card reads
 * means the next store `set()` re-runs their `changedIds.has(id)` selectors and repaints.
 */
export function applyChangedIds(index: GraphIndex, changedIds: Iterable<string>): void {
  index.changedIds.clear();
  for (const id of changedIds) {
    index.changedIds.add(id);
  }
  // Seed a "modified" status for each id; a caller with real per-node statuses (a PR review) follows
  // up with applyChangedStatus to overwrite this with the actual add/modified/deleted kinds.
  index.changedStatus.clear();
  index.changedDescendants.clear();
  for (const changedId of index.changedIds) {
    index.changedStatus.set(changedId, "modified");
    const seen = new Set<string>([changedId]);
    let current = index.parentOf.get(changedId) ?? null;
    while (current && !seen.has(current)) {
      seen.add(current);
      index.changedDescendants.set(current, (index.changedDescendants.get(current) ?? 0) + 1);
      current = index.parentOf.get(current) ?? null;
    }
  }
}

/**
 * Overwrite the per-node change STATUS in place. A PR review derives each touched node's kind from
 * the exact line edits inside its span (falling back to file status when that detail is unavailable),
 * which is richer than the boolean changedIds. Kept separate from changedIds/changedDescendants so
 * the "contains changes" bubbling is unaffected; this map drives colour only. The next store `set()`
 * re-runs the cards' `changedStatus.get(id)` selectors and repaints green/gold/red.
 */
export function applyChangedStatus(index: GraphIndex, entries: Iterable<readonly [string, ChangeStatus]>): void {
  index.changedStatus.clear();
  for (const [id, status] of entries) {
    index.changedStatus.set(id, status);
  }
}

/** Bubble each changed node up its parent chain so collapsed ancestors can count what they hide. */
function countChangedDescendants(
  changedIds: Set<string>,
  parentOf: ReadonlyMap<string, string | null>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const changedId of changedIds) {
    const seen = new Set<string>([changedId]);
    let current = parentOf.get(changedId) ?? null;
    while (current && !seen.has(current)) {
      seen.add(current);
      counts.set(current, (counts.get(current) ?? 0) + 1);
      current = parentOf.get(current) ?? null;
    }
  }
  return counts;
}

/** Walk parentId up to a root, collecting nodes, then reverse to root..id order. */
function ancestorsOf(
  nodeId: string,
  nodesById: ReadonlyMap<string, GraphNode>,
  parentOf: ReadonlyMap<string, string | null>,
): GraphNode[] {
  const path: GraphNode[] = [];
  const seen = new Set<string>();
  let current: string | null | undefined = nodeId;
  // A parentId cycle is tolerated by the lenient viewer, so guard against spinning forever.
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = nodesById.get(current);
    if (node) {
      path.push(node);
    }
    current = parentOf.get(current) ?? null;
  }
  return path.reverse();
}

function isWithinFocus(
  focusId: string | null,
  nodeId: string,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  if (focusId === null) {
    return true;
  }
  const seen = new Set<string>();
  let current: string | null | undefined = nodeId;
  while (current && !seen.has(current)) {
    if (current === focusId) {
      return true;
    }
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return false;
}

function isRoot(node: GraphNode): boolean {
  return node.parentId === null || node.parentId === undefined;
}

function indexById(nodes: GraphNode[]): Map<string, GraphNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

/** Children keep artifact (source) order so siblings render in a stable, meaningful sequence. */
function groupByParent(nodes: GraphNode[]): Map<string, GraphNode[]> {
  const byParent = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (isRoot(node)) {
      continue;
    }
    appendTo(byParent, node.parentId as string, node);
  }
  return byParent;
}

function mapParents(nodes: GraphNode[]): Map<string, string | null> {
  return new Map(nodes.map((node) => [node.id, node.parentId ?? null]));
}

function groupOutEdges(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  const bySource = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    appendTo(bySource, edge.source, edge);
  }
  return bySource;
}

function appendTo<Value>(map: Map<string, Value[]>, key: string, value: Value): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(key, [value]);
}
