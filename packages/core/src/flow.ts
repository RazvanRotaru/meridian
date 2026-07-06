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
  | { kind: "branch"; label: string; paths: FlowPath[] }
  /** An inline callback handed to a call (`useEffect(() => …)`, `setTimeout(() => …)`) or bound
   * to a JSX attribute (`onClick={() => …}`). Its body nests here rather than charting as flat
   * siblings, because HANDING OVER a callback asserts nothing about when — or whether — it runs. */
  | { kind: "callback"; label: string; body: FlowStep[] };

export interface FlowPath {
  label: string;
  body: FlowStep[];
}

/** Callable node id -> its ordered logic flow. Lives under `artifact.extensions.logicFlow`. */
export type LogicFlows = Record<NodeId, FlowStep[]>;

export const LOGIC_FLOW_EXTENSION = "logicFlow";
