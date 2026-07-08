import { pathRole, type FlowPath, type FlowStep, type LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { flowCallTargets } from "./flowInspect";

export interface FlowBlockSegment {
  step: number;
  path?: number;
}

export interface FlowSelectionRef {
  rootId: string;
  blockPath: FlowBlockSegment[];
}

export function stepsAt(flows: LogicFlows, ref: FlowSelectionRef): FlowStep[] | null {
  let steps = flows[ref.rootId];
  if (!steps) {
    return null;
  }
  for (const segment of ref.blockPath) {
    const step = steps[segment.step];
    if (!step) {
      return null;
    }
    if (step.kind === "loop" || step.kind === "callback") {
      if (segment.path !== undefined) {
        return null;
      }
      steps = step.body;
    } else if (step.kind === "branch") {
      if (segment.path === undefined) {
        return null;
      }
      const path = step.paths[segment.path];
      if (!path) {
        return null;
      }
      steps = path.body;
    } else {
      return null;
    }
  }
  return steps;
}

export function blockChildren(steps: FlowStep[]): { segment: FlowBlockSegment; kind: "loop" | "branch-path" | "callback"; label: string }[] {
  const children: { segment: FlowBlockSegment; kind: "loop" | "branch-path" | "callback"; label: string }[] = [];
  steps.forEach((step, stepIndex) => {
    if (step.kind === "loop") {
      children.push({ segment: { step: stepIndex }, kind: "loop", label: step.label });
    } else if (step.kind === "callback") {
      children.push({ segment: { step: stepIndex }, kind: "callback", label: step.label });
    } else if (step.kind === "branch") {
      step.paths.forEach((path, pathIndex) => {
        children.push({
          segment: { step: stepIndex, path: pathIndex },
          kind: "branch-path",
          label: `${step.label}: ${branchPathLabel(path)}`,
        });
      });
    }
  });
  return children;
}

export function relatedNodeIds(index: GraphIndex, flows: LogicFlows, ref: FlowSelectionRef): Set<string> {
  const related = new Set<string>([ref.rootId]);
  const steps = stepsAt(flows, ref);
  if (!steps) {
    return related;
  }
  for (const target of flowCallTargets(steps)) {
    if (index.nodesById.has(target)) {
      related.add(target);
    }
  }
  return related;
}

function branchPathLabel(path: FlowPath): string {
  const role = pathRole(path);
  return role === path.label ? role : `${role}: ${path.label}`;
}
