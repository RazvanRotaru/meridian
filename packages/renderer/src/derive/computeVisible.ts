/**
 * computeVisible: the visible node set as a DFS preorder (parent BEFORE its children).
 *
 * Progressive disclosure: only roots show until expanded, so a container only descends into
 * its children when it is BOTH a container AND in the `expanded` set. Hidden descendants are
 * absent from the result entirely — React Flow never learns they exist.
 *
 * When `focusId` is set (dive-in), the tree is rooted at that node's CHILDREN — you are INSIDE
 * the box, so `focusId` itself is not drawn (the breadcrumb represents it). A null focus keeps
 * the default behavior of starting at the graph roots.
 */

import type { GraphIndex } from "../graph/graphIndex";
import type { VisibleNode } from "./types";

export function computeVisible(
  index: GraphIndex,
  expanded: ReadonlySet<string>,
  focusId: string | null = null,
): VisibleNode[] {
  const roots = focusId ? index.childrenOf(focusId) : index.roots;
  const visible: VisibleNode[] = [];
  for (const root of roots) {
    visit(root.id, 0, index, expanded, visible);
  }
  return visible;
}

function visit(
  nodeId: string,
  depth: number,
  index: GraphIndex,
  expanded: ReadonlySet<string>,
  visible: VisibleNode[],
): void {
  const node = index.nodesById.get(nodeId);
  if (!node) {
    return;
  }
  const children = index.childrenByParent.get(nodeId) ?? [];
  const isContainer = children.length > 0;
  const isExpanded = isContainer && expanded.has(nodeId);
  visible.push({ id: nodeId, node, isContainer, isExpanded, depth, childCount: children.length });
  if (!isExpanded) {
    return;
  }
  for (const child of children) {
    visit(child.id, depth + 1, index, expanded, visible);
  }
}

export function visibleIdSet(visible: VisibleNode[]): Set<string> {
  return new Set(visible.map((entry) => entry.id));
}

/**
 * The visible set for an isolated flow: the DFS is pruned to `keep` (the flow's nodes plus their
 * ancestors) and every kept container is treated as expanded, so the tree opens straight down to
 * the flow's real functions rather than the collapsed package boxes.
 */
export function computeVisibleWithin(index: GraphIndex, keep: ReadonlySet<string>): VisibleNode[] {
  const visible: VisibleNode[] = [];
  for (const root of index.roots) {
    visitWithin(root.id, 0, index, keep, visible);
  }
  return visible;
}

function visitWithin(
  nodeId: string,
  depth: number,
  index: GraphIndex,
  keep: ReadonlySet<string>,
  visible: VisibleNode[],
): void {
  const node = index.nodesById.get(nodeId);
  if (!node || !keep.has(nodeId)) {
    return;
  }
  const children = (index.childrenByParent.get(nodeId) ?? []).filter((child) => keep.has(child.id));
  const isContainer = children.length > 0;
  visible.push({ id: nodeId, node, isContainer, isExpanded: isContainer, depth, childCount: children.length });
  for (const child of children) {
    visitWithin(child.id, depth + 1, index, keep, visible);
  }
}
