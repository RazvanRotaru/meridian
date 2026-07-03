/** Shared shapes for the pure derive pipeline (visible nodes + lifted edges). */

import type { GraphNode } from "@meridian/core";

export interface VisibleNode {
  id: string;
  node: GraphNode;
  /** Has at least one child — renders as a box ("N items") when collapsed, a frame when open. */
  isContainer: boolean;
  isExpanded: boolean;
  depth: number;
  childCount: number;
}

export interface LiftedEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  weight: number;
  /** Underlying artifact edge ids, retained for click-through and telemetry drill-down. */
  underlyingEdgeIds: string[];
  /** True when at least one endpoint was raised to an ancestor (this wire is an aggregate). */
  lifted: boolean;
  /** False when any contributing edge was external/unresolved — drives dashed/dim honesty. */
  resolved: boolean;
}
