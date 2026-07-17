import {
  branchKindOf,
  tryArms,
  type FlowPath,
  type FlowStep,
  type LogicFlows,
} from "@meridian/core";
import {
  logicBranchBodyPrefix,
  logicCallBodyPrefix,
  logicControlBodyPrefix,
  logicFinallyBodyPrefix,
  logicNodeId,
  logicStepPath,
  logicTopLevelBodyPrefix,
} from "./logicFlowAddress";
import { canChartFinallyAsSharedPhase } from "./logicFlowShape";

export type LogicFlowOccurrenceResolution =
  | { kind: "target"; targetId: string; requiredFlowIds: string[] }
  | { kind: "structural"; requiredFlowIds: string[] }
  | { kind: "blocked"; missingFlowId: string; requiredFlowIds: string[] };

/** Resolve one renderer occurrence through the immutable Logic-flow address grammar. The walk
 * follows only the requested path, so folded ancestors remain resolvable without constructing a
 * layout or recursively indexing unrelated callees. A missing callee shard is returned as an exact
 * transport requirement; callers can hydrate it and repeat the same deterministic walk. */
export function resolveLogicFlowOccurrence(args: {
  rootId: string;
  bodies: FlowPath[];
  flows: LogicFlows;
  occurrenceId: string;
}): LogicFlowOccurrenceResolution | null {
  if (!args.occurrenceId.startsWith(`${args.rootId}::`)) return null;
  return walkBodies(args.bodies, [], args);
}

function walkBodies(
  bodies: FlowPath[],
  requiredFlowIds: string[],
  args: Parameters<typeof resolveLogicFlowOccurrence>[0],
): LogicFlowOccurrenceResolution | null {
  for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex += 1) {
    const result = walkSequence(
      bodies[bodyIndex]!.body,
      logicTopLevelBodyPrefix(bodyIndex),
      requiredFlowIds,
      args,
    );
    if (result !== null) return result;
  }
  return null;
}

function walkSequence(
  steps: FlowStep[],
  prefix: string,
  requiredFlowIds: string[],
  args: Parameters<typeof resolveLogicFlowOccurrence>[0],
): LogicFlowOccurrenceResolution | null {
  const sequencePrefix = logicNodeId(args.rootId, prefix);
  if (!args.occurrenceId.startsWith(sequencePrefix)) return null;
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const step = steps[stepIndex]!;
    const path = logicStepPath(prefix, stepIndex);
    const id = logicNodeId(args.rootId, path);
    if (args.occurrenceId === id) return exactStep(step, requiredFlowIds);
    if (!args.occurrenceId.startsWith(`${id}/`) && !args.occurrenceId.startsWith(`${id}::`)) {
      continue;
    }
    return descendStep(step, path, id, requiredFlowIds, args);
  }
  return null;
}

function exactStep(step: FlowStep, requiredFlowIds: string[]): LogicFlowOccurrenceResolution {
  if (step.kind !== "call" || step.resolution !== "resolved" || step.target === null) {
    return { kind: "structural", requiredFlowIds };
  }
  return {
    kind: "target",
    targetId: step.target,
    requiredFlowIds: appendUnique(requiredFlowIds, step.target),
  };
}

function descendStep(
  step: FlowStep,
  path: string,
  id: string,
  requiredFlowIds: string[],
  args: Parameters<typeof resolveLogicFlowOccurrence>[0],
): LogicFlowOccurrenceResolution | null {
  if (step.kind === "call") {
    if (step.resolution !== "resolved" || step.target === null) return null;
    const required = appendUnique(requiredFlowIds, step.target);
    const callee = args.flows[step.target];
    if (callee === undefined) {
      return { kind: "blocked", missingFlowId: step.target, requiredFlowIds: required };
    }
    return walkSequence(callee, logicCallBodyPrefix(path), required, args);
  }
  if (step.kind === "loop" || step.kind === "callback") {
    return walkSequence(step.body, logicControlBodyPrefix(path, 0), requiredFlowIds, args);
  }
  if (step.kind !== "branch") return null;

  if (branchKindOf(step) === "try" && canChartFinallyAsSharedPhase(step)) {
    const { tryPath, catchPath, finallyPath } = tryArms(step);
    for (const [pathIndex, protectedPath] of [tryPath, catchPath].entries()) {
      if (protectedPath === undefined) continue;
      const result = walkSequence(
        protectedPath.body,
        logicBranchBodyPrefix(path, pathIndex),
        requiredFlowIds,
        args,
      );
      if (result !== null) return result;
    }
    if (args.occurrenceId === `${id}::finally`) {
      return { kind: "structural", requiredFlowIds };
    }
    return finallyPath === undefined
      ? null
      : walkSequence(finallyPath.body, logicFinallyBodyPrefix(path), requiredFlowIds, args);
  }

  const controlFallback = branchKindOf(step) === "try";
  for (let pathIndex = 0; pathIndex < step.paths.length; pathIndex += 1) {
    const flowPath = step.paths[pathIndex]!;
    const bodyPrefix = controlFallback
      ? logicControlBodyPrefix(path, pathIndex)
      : logicBranchBodyPrefix(path, pathIndex);
    const result = walkSequence(flowPath.body, bodyPrefix, requiredFlowIds, args);
    if (result !== null) return result;
  }
  return null;
}

function appendUnique(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id];
}
