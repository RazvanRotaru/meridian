/**
 * Presentation-only folding for Logic-flow edges.
 *
 * Folding is a directed graph cut, not a descendant-tree filter. Removing a branch edge from a
 * diamond therefore hides only the branch-exclusive region: a join (and everything after it) stays
 * visible whenever another live route still reaches it. A compact `fold` node replaces the cut and
 * reconnects to every visible boundary reached by the hidden region, yielding e.g.
 * `if -> +3 -> merge` instead of either erasing the merge or leaving it unexplained.
 *
 * Expanded calls and controls need one extra piece of topology. Their nested body roots have no
 * real edge from the owning container, so treating every indegree-zero child as a graph root would
 * let that body survive after its owner was cut away. We model those relationships as implicit,
 * non-collapsible scope gates from each executable container to the source components in its body.
 * Service/definition frames are transparent presentation parents and never become reachability
 * roots themselves.
 */

import type {
  CollapsedEdgeData,
  LogicEdgeSpec,
  LogicGraphSpec,
  LogicNodeSpec,
} from "./logicGraph";

const FOLD_WIDTH = 88;
const FOLD_HEIGHT = 34;
const ROOT_SCOPE = "\u0000logic-root-scope";

/** Fields that give one rendered connection its semantic identity. Sequential `e0` ids are
 * intentionally excluded: expanding an unrelated node can renumber them. */
type EdgeCollapseIdentity = Pick<
  LogicEdgeSpec,
  "kind" | "source" | "target" | "sourcePort" | "targetPort" | "taskId" | "branchRole"
>;

/** Stable, occurrence-scoped identity persisted by the UI. Equal semantic connections deliberately
 * share a key; duplicate paint edges should fold and restore as one relationship. */
export function logicEdgeCollapseKey(edge: EdgeCollapseIdentity): string {
  return JSON.stringify([
    edge.kind,
    edge.source,
    edge.sourcePort ?? null,
    edge.target,
    edge.targetPort ?? null,
    edge.taskId ?? null,
    edge.branchRole ?? null,
  ]);
}

/** Stable synthetic id used by both the fold node and its replacement edge segments. */
export function logicEdgeFoldNodeId(collapseKey: string): string {
  return `logic-fold:${encodeURIComponent(collapseKey)}`;
}

/**
 * Apply all currently folded semantic edges to a canonical (unfolded) Logic graph spec.
 *
 * The input is never mutated. Stale keys and keys for projection-owned, non-collapsible segments
 * are ignored. Async rails can be folded, but because they represent correlation rather than
 * execution they never affect downstream node reachability.
 */
export function collapseLogicEdges(
  spec: LogicGraphSpec,
  collapsedKeys: ReadonlySet<string>,
): LogicGraphSpec {
  if (spec.nodes.length === 0 || spec.edges.length === 0 || collapsedKeys.size === 0) {
    return spec;
  }

  const cutEdges = spec.edges.filter((edge) => (
    edge.collapsible !== false && collapsedKeys.has(logicEdgeCollapseKey(edge))
  ));
  if (cutEdges.length === 0) {
    return spec;
  }

  const nodesById = new Map(spec.nodes.map((node) => [node.id, node]));
  const executableIds = new Set(
    spec.nodes.filter((node) => !isTransparentFrame(node)).map((node) => node.id),
  );
  const scopeOf = executionScopes(spec.nodes, nodesById, executableIds);
  const gates = executionScopeGates(spec.nodes, spec.edges, executableIds, scopeOf);
  const cutKeys = new Set(cutEdges.map(logicEdgeCollapseKey));
  const allControl = controlAdjacency(spec.edges, executableIds, new Set<string>());
  const liveControl = controlAdjacency(spec.edges, executableIds, cutKeys);
  const baselineExecutable = reachableExecutables(gates.rootEntries, allControl, gates.byOwner);
  const visibleExecutable = reachableExecutables(gates.rootEntries, liveControl, gates.byOwner);
  const hiddenExecutable = difference(baselineExecutable, visibleExecutable);

  // A React Flow child whose parent is omitted is promoted to the root by the ELK adapter. Retain
  // the complete ancestor chain of every actually reachable executable node instead.
  const visibleNodeIds = ancestorClosure(visibleExecutable, nodesById);
  const nodes: LogicNodeSpec[] = spec.nodes.filter((node) => visibleNodeIds.has(node.id));
  const edges: LogicEdgeSpec[] = spec.edges.filter((edge) => (
    (edge.collapsible === false || !cutKeys.has(logicEdgeCollapseKey(edge)))
    && visibleExecutable.has(edge.source)
    && visibleExecutable.has(edge.target)
  ));

  // Identical semantic duplicates share one control and one stub.
  const representativeByKey = new Map<string, LogicEdgeSpec>();
  for (const edge of cutEdges) {
    const key = logicEdgeCollapseKey(edge);
    if (!representativeByKey.has(key)) representativeByKey.set(key, edge);
  }

  for (const [collapseKey, edge] of representativeByKey) {
    if (!visibleExecutable.has(edge.source)) {
      // An upstream fold currently owns this boundary. Keep its key in state; reopening the outer
      // fold will reveal this independently folded continuation again.
      continue;
    }

    const stubId = logicEdgeFoldNodeId(collapseKey);
    const hiddenRegion = edge.kind === "async"
      ? new Set<string>()
      : intersection(
          reachableExecutables([edge.target], liveControl, gates.byOwner),
          hiddenExecutable,
        );
    const boundaryEdges = visibleBoundaryEdges(
      edge,
      hiddenRegion,
      visibleExecutable,
      spec.edges,
      cutKeys,
    );
    const target = nodesById.get(edge.target);
    const data: CollapsedEdgeData = {
      targetId: null,
      isContainer: false,
      collapseKey,
      edgeKind: edge.kind,
      targetLabel: nodeLabel(target) ?? edge.target,
      hiddenStepCount: countHiddenSteps(hiddenRegion, nodesById),
      ...(edge.label ? { edgeLabel: edge.label } : {}),
      ...(edge.branchRole ? { branchRole: edge.branchRole } : {}),
    };
    nodes.push({
      id: stubId,
      parentId: deepestVisibleCommonParent(edge.source, edge.target, nodesById, visibleNodeIds),
      type: "fold",
      data,
      width: FOLD_WIDTH,
      height: FOLD_HEIGHT,
    });
    edges.push(foldIncomingEdge(edge, stubId));
    boundaryEdges.forEach((boundary, index) => {
      edges.push(foldOutgoingEdge(edge, boundary, stubId, index));
    });
  }

  return { nodes, edges };
}

interface ScopeGates {
  rootEntries: string[];
  byOwner: Map<string, string[]>;
}

/** The nearest executable container ancestor owns a nested execution scope. Transparent frames do
 * not interrupt it, and a container belongs to its parent's scope rather than to its own body. */
function executionScopes(
  nodes: readonly LogicNodeSpec[],
  nodesById: ReadonlyMap<string, LogicNodeSpec>,
  executableIds: ReadonlySet<string>,
): Map<string, string> {
  const scopes = new Map<string, string>();
  for (const node of nodes) {
    if (!executableIds.has(node.id)) continue;
    let parentId = node.parentId;
    const seen = new Set<string>();
    let owner = ROOT_SCOPE;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = nodesById.get(parentId);
      if (!parent) break;
      if (executableIds.has(parent.id) && parent.data.isContainer) {
        owner = parent.id;
        break;
      }
      parentId = parent.parentId;
    }
    scopes.set(node.id, owner);
  }
  return scopes;
}

/** Source strongly-connected components are the fixed, pre-cut entries of each scope. Logic exec
 * graphs are normally acyclic; SCCs make the projection total for imported/runtime graphs too. */
function executionScopeGates(
  nodes: readonly LogicNodeSpec[],
  edges: readonly LogicEdgeSpec[],
  executableIds: ReadonlySet<string>,
  scopeOf: ReadonlyMap<string, string>,
): ScopeGates {
  const members = new Map<string, string[]>();
  for (const node of nodes) {
    if (!executableIds.has(node.id)) continue;
    const scope = scopeOf.get(node.id) ?? ROOT_SCOPE;
    const bucket = members.get(scope) ?? [];
    bucket.push(node.id);
    members.set(scope, bucket);
  }

  const rootEntries: string[] = [];
  const byOwner = new Map<string, string[]>();
  for (const [scope, ids] of members) {
    const entries = sourceComponentEntries(ids, edges, executableIds, scopeOf);
    if (scope === ROOT_SCOPE) {
      rootEntries.push(...entries);
    } else {
      byOwner.set(scope, entries);
    }
  }
  return { rootEntries, byOwner };
}

/** Pick one deterministic entry per source SCC. A component with a real incoming edge from another
 * execution scope is not gate-opened: that edge remains responsible for making it reachable. */
function sourceComponentEntries(
  ids: readonly string[],
  edges: readonly LogicEdgeSpec[],
  executableIds: ReadonlySet<string>,
  scopeOf: ReadonlyMap<string, string>,
): string[] {
  const idsSet = new Set(ids);
  const internalOut = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (!isControlEdge(edge) || !executableIds.has(edge.source) || !executableIds.has(edge.target)) continue;
    if (idsSet.has(edge.source) && idsSet.has(edge.target)) {
      internalOut.get(edge.source)?.push(edge.target);
    }
  }

  const components = stronglyConnectedComponents(ids, internalOut);
  const componentOf = new Map<string, number>();
  components.forEach((component, index) => component.forEach((id) => componentOf.set(id, index)));
  const incoming = new Set<number>();
  for (const [source, targets] of internalOut) {
    const sourceComponent = componentOf.get(source);
    for (const target of targets) {
      const targetComponent = componentOf.get(target);
      if (sourceComponent !== undefined && targetComponent !== undefined && sourceComponent !== targetComponent) {
        incoming.add(targetComponent);
      }
    }
  }
  for (const edge of edges) {
    if (!isControlEdge(edge) || !idsSet.has(edge.target) || !executableIds.has(edge.source)) continue;
    if ((scopeOf.get(edge.source) ?? ROOT_SCOPE) !== (scopeOf.get(edge.target) ?? ROOT_SCOPE)) {
      const targetComponent = componentOf.get(edge.target);
      if (targetComponent !== undefined) incoming.add(targetComponent);
    }
  }

  return components.flatMap((component, index) => incoming.has(index) ? [] : component.slice(0, 1));
}

function stronglyConnectedComponents(
  ids: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (id: string): void => {
    const index = nextIndex++;
    indices.set(id, index);
    lowLinks.set(id, index);
    stack.push(id);
    onStack.add(id);

    for (const target of adjacency.get(id) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indices.get(target)!));
      }
    }

    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    components.push(component);
  };

  ids.forEach((id) => {
    if (!indices.has(id)) visit(id);
  });
  return components;
}

function controlAdjacency(
  edges: readonly LogicEdgeSpec[],
  executableIds: ReadonlySet<string>,
  cutKeys: ReadonlySet<string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    if (
      !isControlEdge(edge)
      || !executableIds.has(edge.source)
      || !executableIds.has(edge.target)
      || (edge.collapsible !== false && cutKeys.has(logicEdgeCollapseKey(edge)))
    ) {
      continue;
    }
    const targets = out.get(edge.source) ?? [];
    targets.push(edge.target);
    out.set(edge.source, targets);
  }
  return out;
}

function reachableExecutables(
  entries: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  gatesByOwner: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const reached = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reached.has(current)) continue;
    reached.add(current);
    pending.push(...(adjacency.get(current) ?? []));
    pending.push(...(gatesByOwner.get(current) ?? []));
  }
  return reached;
}

function ancestorClosure(
  executableIds: ReadonlySet<string>,
  nodesById: ReadonlyMap<string, LogicNodeSpec>,
): Set<string> {
  const visible = new Set(executableIds);
  for (const id of executableIds) {
    let parentId = nodesById.get(id)?.parentId ?? null;
    const seen = new Set<string>();
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      visible.add(parentId);
      parentId = nodesById.get(parentId)?.parentId ?? null;
    }
  }
  return visible;
}

interface VisibleBoundary {
  target: string;
  edge: LogicEdgeSpec | null;
}

function visibleBoundaryEdges(
  collapsed: LogicEdgeSpec,
  hiddenRegion: ReadonlySet<string>,
  visibleExecutable: ReadonlySet<string>,
  edges: readonly LogicEdgeSpec[],
  cutKeys: ReadonlySet<string>,
): VisibleBoundary[] {
  if (visibleExecutable.has(collapsed.target)) {
    return [{ target: collapsed.target, edge: null }];
  }
  const boundaries = new Map<string, VisibleBoundary>();
  for (const edge of edges) {
    if (
      !isControlEdge(edge)
      || !hiddenRegion.has(edge.source)
      || !visibleExecutable.has(edge.target)
      || (edge.collapsible !== false && cutKeys.has(logicEdgeCollapseKey(edge)))
    ) {
      continue;
    }
    const key = `${edge.target}\u0000${edge.targetPort ?? ""}`;
    if (!boundaries.has(key)) boundaries.set(key, { target: edge.target, edge });
  }
  return [...boundaries.values()];
}

function foldIncomingEdge(edge: LogicEdgeSpec, stubId: string): LogicEdgeSpec {
  const { targetPort: _targetPort, ...rest } = edge;
  return {
    ...rest,
    id: `${stubId}:in`,
    target: stubId,
    collapsible: false,
  };
}

function foldOutgoingEdge(
  collapsed: LogicEdgeSpec,
  boundary: VisibleBoundary,
  stubId: string,
  index: number,
): LogicEdgeSpec {
  if (boundary.edge === null) {
    return {
      id: `${stubId}:out:${index}`,
      source: stubId,
      target: boundary.target,
      kind: collapsed.kind === "async" ? "async" : "seq",
      ...(collapsed.kind === "async" && collapsed.targetPort ? { targetPort: collapsed.targetPort } : {}),
      ...(collapsed.taskId ? { taskId: collapsed.taskId } : {}),
      ...(collapsed.branchRole ? { branchRole: collapsed.branchRole } : {}),
      ...(collapsed.requestTraversal ? { requestTraversal: collapsed.requestTraversal } : {}),
      collapsible: false,
    };
  }
  const {
    sourcePort: _sourcePort,
    targetPort: _targetPort,
    ...rest
  } = boundary.edge;
  return {
    ...rest,
    id: `${stubId}:out:${index}`,
    source: stubId,
    target: boundary.target,
    collapsible: false,
  };
}

function deepestVisibleCommonParent(
  sourceId: string,
  targetId: string,
  nodesById: ReadonlyMap<string, LogicNodeSpec>,
  visibleNodeIds: ReadonlySet<string>,
): string | null {
  const sourceParents = parentChain(sourceId, nodesById);
  const targetParents = new Set(parentChain(targetId, nodesById));
  for (let index = sourceParents.length - 1; index >= 0; index -= 1) {
    const parent = sourceParents[index];
    if (targetParents.has(parent) && visibleNodeIds.has(parent)) return parent;
  }
  return null;
}

function parentChain(id: string, nodesById: ReadonlyMap<string, LogicNodeSpec>): string[] {
  const reversed: string[] = [];
  const seen = new Set<string>();
  let parentId = nodesById.get(id)?.parentId ?? null;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    reversed.push(parentId);
    parentId = nodesById.get(parentId)?.parentId ?? null;
  }
  return reversed.reverse();
}

function countHiddenSteps(
  hiddenRegion: ReadonlySet<string>,
  nodesById: ReadonlyMap<string, LogicNodeSpec>,
): number {
  let count = 0;
  for (const id of hiddenRegion) {
    const node = nodesById.get(id);
    if (!node || node.type === "join" || node.type === "fold") continue;
    if (node.type === "terminal") {
      const terminal = "terminal" in node.data ? node.data.terminal : null;
      if (terminal === "entry" || terminal === "exit") continue;
    }
    count += 1;
  }
  return count;
}

function nodeLabel(node: LogicNodeSpec | undefined): string | null {
  if (!node || !("label" in node.data) || typeof node.data.label !== "string") return null;
  return node.data.label;
}

function isTransparentFrame(node: LogicNodeSpec): boolean {
  const type = String(node.type);
  return type === "servicegroup" || type === "defgroup";
}

function isControlEdge(edge: LogicEdgeSpec): boolean {
  return edge.kind === "seq" || edge.kind === "branch";
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((id) => !right.has(id)));
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((id) => right.has(id)));
}
