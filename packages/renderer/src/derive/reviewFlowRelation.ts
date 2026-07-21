import { affectedFlowTouchesIds, type AffectedFlowRow } from "./reviewData";

/**
 * Flow roots related to the selected graph nodes: a selected callable's own flow plus every flow
 * that contains a resolved call to it. The returned ids stay in flow-root space so grouped review
 * stories can match any of their original members without being split apart.
 */
export function reviewFlowRootsRelatedToNodes(
  containment: ReadonlyMap<string, readonly string[]>,
  selectedNodeIds: ReadonlySet<string>,
): Set<string> {
  const related = new Set<string>();
  for (const nodeId of selectedNodeIds) {
    related.add(nodeId);
    for (const rootId of containment.get(nodeId) ?? []) {
      related.add(rootId);
    }
  }
  return related;
}

/** Keep a grouped causal story whole when the selected node is either one of its flow roots, a
 * resolved target reached by one of those roots, or the Promise resource that grouped the story. */
export function affectedReviewFlowRelatesToNodes(
  row: AffectedFlowRow,
  relatedFlowRootIds: ReadonlySet<string>,
  selectedNodeIds: ReadonlySet<string>,
): boolean {
  return affectedFlowTouchesIds(row, relatedFlowRootIds)
    || (row.causalResourceId !== null && selectedNodeIds.has(row.causalResourceId));
}
