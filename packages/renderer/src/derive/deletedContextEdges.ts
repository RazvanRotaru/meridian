interface ContextEdge {
  kind: string;
  source: string;
  target: string;
}

/** Historical relationships admitted around a proven deleted declaration.
 * Calls retain their existing caller/callee neighbourhood. References are intentionally incoming
 * only: they answer who held or passed the deleted value without reviving every value/type
 * dependency that deleted code used. */
export function isDeletedContextEdge(
  edge: ContextEdge,
  isDeleted: (nodeId: string) => boolean,
): boolean {
  if (edge.kind === "calls") {
    return isDeleted(edge.source) || isDeleted(edge.target);
  }
  return edge.kind === "references" && isDeleted(edge.target);
}
