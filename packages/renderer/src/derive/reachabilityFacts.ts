import {
  buildReachabilityProjection,
  collectTestIds,
  type GraphEdge,
  type GraphNode,
  type NodeId,
  type ReachabilityProjectionFacts,
} from "@meridian/core";

/**
 * Renderer reachability state: complete-revision summary/diagnostics, paint facts for the current
 * bounded slice, and test identities only for nodes resident in that slice.
 */
export type RendererReachabilityReport = ReachabilityProjectionFacts & {
  testIds: Set<NodeId>;
};

/** Full in-memory artifacts use the same core fact builder as persisted projection bundles. */
export function buildRendererReachabilityReport(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): RendererReachabilityReport {
  return withReachabilityTestIds(buildReachabilityProjection(nodes, edges), collectTestIds([...nodes]));
}

/** Attach current-slice test paint identities without retaining any additional graph data. */
export function withReachabilityTestIds(
  facts: ReachabilityProjectionFacts,
  testIds: ReadonlySet<NodeId>,
): RendererReachabilityReport {
  return { ...facts, testIds: new Set(testIds) };
}
