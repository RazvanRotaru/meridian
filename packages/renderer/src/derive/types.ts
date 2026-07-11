/** Shared shapes for the pure derive pipeline (lifted edges). */

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
