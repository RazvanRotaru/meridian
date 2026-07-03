/**
 * The intra-procedural "logic flow" model — a per-callable control-flow tree.
 *
 * A flow is an ordered list of `FlowStep`s: only method calls and control structures survive;
 * everything else collapses away. It rides in the artifact's `extensions` record under the
 * `logicFlow` key (no schema change, no version bump), keyed by the same `node.id` grammar the
 * rest of the graph joins on.
 */

import type { EdgeResolution, NodeId } from "./types";

export type FlowStep =
  | { kind: "call"; label: string; target: NodeId | null; resolution: EdgeResolution }
  | { kind: "loop"; label: string; body: FlowStep[] }
  | { kind: "branch"; label: string; paths: FlowPath[] };

export interface FlowPath {
  label: string;
  body: FlowStep[];
}

/** Callable node id -> its ordered logic flow. Lives under `artifact.extensions.logicFlow`. */
export type LogicFlows = Record<NodeId, FlowStep[]>;

export const LOGIC_FLOW_EXTENSION = "logicFlow";
