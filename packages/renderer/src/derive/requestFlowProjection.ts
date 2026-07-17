import type { FlowPath, LogicFlows, RequestTrace } from "@meridian/core";
import { resolveLogicFlowOccurrence } from "./logicFlowOccurrence";
import { requestSpanMomentId } from "./requestFlowAddress";

/** Exact graph/flow identities needed to render the selected request-flow state. Static expansion
 * ids are renderer occurrences, so this planner resolves them back through their owning trace span
 * and includes only call targets on that one address path. */
export function requestFlowProjectionIds(
  trace: RequestTrace,
  flows: LogicFlows,
  expansionOverrides: ReadonlySet<string>,
): string[] {
  const ids = new Set<string>();
  const overrides = [...expansionOverrides].sort();
  for (const span of trace.spans) {
    if (span.nodeId === undefined) continue;
    ids.add(span.nodeId);
    const steps = flows[span.nodeId];
    if (steps === undefined) continue;
    const rootId = `${requestSpanMomentId(trace.traceId, span.spanId)}:exec`;
    const occurrencePrefix = `${rootId}::`;
    const bodies: FlowPath[] = [{ label: "observed span", body: steps }];
    for (const occurrenceId of overrides) {
      if (!occurrenceId.startsWith(occurrencePrefix)) continue;
      const resolution = resolveLogicFlowOccurrence({ rootId, bodies, flows, occurrenceId });
      if (resolution === null) continue;
      for (const id of resolution.requiredFlowIds) ids.add(id);
    }
  }
  return [...ids];
}

/** Every refinement pass resolves at least one additional call segment on an override path. The
 * finite address itself therefore supplies a deterministic upper bound—no retry count or timeout
 * participates in correctness. */
export function requestFlowProjectionPassBudget(expansionOverrides: ReadonlySet<string>): number {
  let longestAddress = 0;
  for (const id of expansionOverrides) {
    const marker = id.indexOf(":exec::");
    if (marker < 0) continue;
    const address = id.slice(marker + ":exec::".length);
    longestAddress = Math.max(longestAddress, address.split("/").filter(Boolean).length);
  }
  return longestAddress + 2;
}
