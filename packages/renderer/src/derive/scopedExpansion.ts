/**
 * Surface-agnostic scoped expand/collapse: given the CURRENT visible node frontier and a scope
 * (a selection, or `[null]` meaning "the whole current view / root container"), return the node
 * ids to open or close. Pure — no store, no React.
 *
 * Expand reveals ONE more containment level (the collapsed containers in scope). Collapse closes
 * EVERY open container in scope in a single click (a full collapse of the selection) — deliberately
 * not a one-level peel, so it behaves the same on surfaces whose open-ness isn't a plain expanded
 * set (the Logic graph's XOR-from-default set).
 */

export interface ExpandableNode {
  id: string;
  parentId: string | null;
  isContainer: boolean;
  isExpanded: boolean;
}

/** Ids of every collapsed container within scope — revealing them opens one more level. */
export function idsToExpand(nodes: readonly ExpandableNode[], scope: readonly (string | null)[]): string[] {
  const inScope = inScopeIds(nodes, scope);
  return nodes.filter((node) => inScope.has(node.id) && node.isContainer && !node.isExpanded).map((node) => node.id);
}

/** Ids of every OPEN container within scope — closing them all collapses the selection in one click. */
export function idsToCollapse(nodes: readonly ExpandableNode[], scope: readonly (string | null)[]): string[] {
  const inScope = inScopeIds(nodes, scope);
  return nodes.filter((node) => inScope.has(node.id) && node.isContainer && node.isExpanded).map((node) => node.id);
}

/** The in-scope node ids: everything for a `null` scope, else each id plus its visible descendants. */
function inScopeIds(nodes: readonly ExpandableNode[], scope: readonly (string | null)[]): Set<string> {
  if (scope.some((entry) => entry === null)) {
    return new Set(nodes.map((node) => node.id));
  }
  const childrenOf = childrenByParent(nodes);
  const result = new Set<string>();
  for (const rootId of scope) {
    collectSubtree(rootId as string, childrenOf, result);
  }
  return result;
}

function collectSubtree(id: string, childrenOf: ReadonlyMap<string, ExpandableNode[]>, into: Set<string>): void {
  if (into.has(id)) {
    return;
  }
  into.add(id);
  for (const child of childrenOf.get(id) ?? []) {
    collectSubtree(child.id, childrenOf, into);
  }
}

function childrenByParent(nodes: readonly ExpandableNode[]): Map<string, ExpandableNode[]> {
  const byParent = new Map<string, ExpandableNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) {
      continue;
    }
    const siblings = byParent.get(node.parentId);
    if (siblings) {
      siblings.push(node);
    } else {
      byParent.set(node.parentId, [node]);
    }
  }
  return byParent;
}
