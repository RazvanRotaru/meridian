/**
 * The nested-ELK layout primitives shared by the call-flow and logic-flow pipelines.
 *
 * Both build the visible set as a NESTED ELK graph that mirrors React Flow's parentId nesting:
 * containers recurse as ELK children carrying padding for a title bar; leaf/collapsed nodes carry
 * a fixed size. `elk.hierarchyHandling: INCLUDE_CHILDREN` MUST live on the ROOT ONLY — setting it
 * per-subgraph throws UnsupportedGraphException. This module enforces that BY CONSTRUCTION: only
 * the root node receives `rootOptions`, while child containers receive `adapter.containerOptions`,
 * which must never carry `hierarchyHandling`. All edges live on the root graph so the layered
 * algorithm can route them across container boundaries.
 *
 * ELK child coordinates come back PARENT-RELATIVE, which is exactly React Flow's parentId
 * semantics, so a placement maps straight through with `parentId` + `extent: "parent"`.
 */

import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";

export const ELK_ROOT_ID = "__blueprint_root__";

/** Projects a domain node onto the shape ELK needs, keeping id/nesting/sizing decisions per-pipeline. */
export interface ElkNestAdapter<T> {
  id(node: T): string;
  parentId(node: T): string | null | undefined;
  isContainer(node: T): boolean;
  leafSize(node: T): { width: number; height: number };
  /** Optional per-container size floor fed to ELK. A compound node is otherwise sized to its
   * children alone, so a frame with narrow children can crowd its own title bar; omit to keep the
   * pure children-driven sizing. */
  containerMinSize?(node: T): { width: number; height: number } | null;
  /** Layout options for child container subgraphs. NEVER includes `hierarchyHandling` (root-only). */
  containerOptions: Record<string, string>;
  /** Optional node-specific override, used when a container's visible chrome needs more room than
   * the pipeline default (for example synthetic IN/OUT snapshot rows under a runtime title). */
  containerOptionsFor?(node: T): Record<string, string> | null;
}

type ElkNestEdge = { id: string; source: string; target: string };

export function buildNestedElkGraph<T>(
  nodes: T[],
  edges: ReadonlyArray<ElkNestEdge>,
  adapter: ElkNestAdapter<T>,
  rootOptions: Record<string, string>,
): ElkNode {
  const elkById = new Map<string, ElkNode>(nodes.map((node) => [adapter.id(node), toElkNode(node, adapter)]));
  const ids = new Set(nodes.map((node) => adapter.id(node)));
  const roots: ElkNode[] = [];
  for (const node of nodes) {
    attachToParent(node, adapter, elkById, ids, roots);
  }
  return { id: ELK_ROOT_ID, layoutOptions: rootOptions, children: roots, edges: edges.map(toElkEdge) };
}

function toElkNode<T>(node: T, adapter: ElkNestAdapter<T>): ElkNode {
  if (adapter.isContainer(node)) {
    return { id: adapter.id(node), children: [], layoutOptions: containerLayoutOptions(node, adapter) };
  }
  const { width, height } = adapter.leafSize(node);
  return { id: adapter.id(node), width, height };
}

/** Container options, plus an ELK size floor when the adapter supplies one — so a frame is never laid
 * out narrower than its own title bar (ELK sizes a compound node to its children otherwise). */
function containerLayoutOptions<T>(node: T, adapter: ElkNestAdapter<T>): Record<string, string> {
  const base = adapter.containerOptionsFor?.(node) ?? adapter.containerOptions;
  const min = adapter.containerMinSize?.(node);
  if (!min) {
    return base;
  }
  return {
    ...base,
    "elk.nodeSize.constraints": "MINIMUM_SIZE",
    "elk.nodeSize.minimum": `(${Math.round(min.width)},${Math.round(min.height)})`,
  };
}

function attachToParent<T>(
  node: T,
  adapter: ElkNestAdapter<T>,
  elkById: Map<string, ElkNode>,
  ids: ReadonlySet<string>,
  roots: ElkNode[],
): void {
  const elkNode = elkById.get(adapter.id(node));
  if (!elkNode) {
    return;
  }
  const parentId = adapter.parentId(node);
  const parentElk = parentId ? elkById.get(parentId) : undefined;
  if (parentId && ids.has(parentId) && parentElk) {
    parentElk.children?.push(elkNode);
    return;
  }
  roots.push(elkNode);
}

function toElkEdge(edge: ElkNestEdge): ElkExtendedEdge {
  return { id: edge.id, sources: [edge.source], targets: [edge.target] };
}

/**
 * Walk the laid-out ELK tree in DFS preorder (parents first — React Flow requires a parent node to
 * appear before its children) and collect the nodes `makeNode` produces. A node that maps to `null`
 * (the synthetic root, or an id `makeNode` does not recognise) is skipped along with its subtree.
 */
export function emitReactFlowNodes<N>(
  laidOut: ElkNode,
  makeNode: (elkNode: ElkNode, parentId: string | undefined) => N | null,
): N[] {
  const out: N[] = [];
  emitChildren(laidOut.children ?? [], undefined, makeNode, out);
  return out;
}

function emitChildren<N>(
  elkNodes: ElkNode[],
  parentId: string | undefined,
  makeNode: (elkNode: ElkNode, parentId: string | undefined) => N | null,
  out: N[],
): void {
  for (const elkNode of elkNodes) {
    if (elkNode.id === ELK_ROOT_ID) {
      continue;
    }
    const node = makeNode(elkNode, parentId);
    if (node === null) {
      continue;
    }
    out.push(node);
    emitChildren(elkNode.children ?? [], elkNode.id, makeNode, out);
  }
}

/** ELK's parent-relative {x,y,width,height} as a React Flow placement, wired to its parent frame. */
export function parentRelativePlacement(
  elkNode: ElkNode,
  parentId: string | undefined,
): { position: { x: number; y: number }; width: number | undefined; height: number | undefined; parentId?: string; extent?: "parent" } {
  return {
    position: { x: elkNode.x ?? 0, y: elkNode.y ?? 0 },
    width: elkNode.width,
    height: elkNode.height,
    ...(parentId ? { parentId, extent: "parent" as const } : {}),
  };
}
