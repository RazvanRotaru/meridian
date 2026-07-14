/**
 * The changed artifact targets represented by one logic flow. The result is ordered for review:
 * the changed flow owner first, followed by changed resolved call targets in source/execution order.
 * Repeated calls to the same target collapse to one entry because Logic selection is target-based.
 */

import type { ChangeStatus, FlowStep, NodeId } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";

export interface ReviewFlowChange {
  targetId: NodeId;
  status: ChangeStatus;
  label: string;
}

/**
 * Return only exact changes recorded in `index.changedStatus`. Calls must be resolved and have a
 * concrete target; external, unresolved, and target-less calls never manufacture review changes.
 * Nested loop/callback bodies and branch paths retain their source order, and the first occurrence
 * of a repeated target owns its place and fallback label.
 */
export function reviewFlowChanges(
  rootId: NodeId,
  steps: readonly FlowStep[],
  index: GraphIndex,
): ReviewFlowChange[] {
  const changes: ReviewFlowChange[] = [];
  const seen = new Set<NodeId>();

  const append = (targetId: NodeId, fallbackLabel: string): void => {
    if (seen.has(targetId)) {
      return;
    }
    const status = index.changedStatus.get(targetId);
    if (status === undefined) {
      return;
    }
    seen.add(targetId);
    changes.push({
      targetId,
      status,
      label: index.nodesById.get(targetId)?.displayName ?? fallbackLabel,
    });
  };

  append(rootId, rootId);
  walkChangedCalls(steps, append);
  return changes;
}

function walkChangedCalls(
  steps: readonly FlowStep[],
  append: (targetId: NodeId, fallbackLabel: string) => void,
): void {
  for (const step of steps) {
    if (step.kind === "call") {
      if (step.resolution === "resolved" && step.target !== null) {
        append(step.target, step.label);
      }
    } else if (step.kind === "loop" || step.kind === "callback") {
      walkChangedCalls(step.body, append);
    } else if (step.kind === "branch") {
      for (const path of step.paths) {
        walkChangedCalls(path.body, append);
      }
    }
  }
}
