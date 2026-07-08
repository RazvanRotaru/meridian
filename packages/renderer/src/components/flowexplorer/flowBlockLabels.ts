import { pathRole, type FlowPath, type FlowStep, type LogicFlows } from "@meridian/core";
import type { FlowBlockSegment, FlowSelectionRef } from "../../derive/flowBlocks";
import { ancestorSelection } from "./flowSelection";

export interface FlowBlockCrumb {
  label: string;
  ref: FlowSelectionRef;
}

export function blockDisplayLabel(steps: readonly FlowStep[], segment: FlowBlockSegment, fallback: string): string {
  const step = steps[segment.step];
  if (!step) {
    return fallback;
  }
  if (step.kind === "loop") {
    return `↻ ${step.label}`;
  }
  if (step.kind === "callback") {
    return `λ ${step.label}`;
  }
  if (step.kind === "branch" && segment.path !== undefined) {
    const path = step.paths[segment.path];
    return path ? `⑂ ${step.label} · ${branchPathLabel(path)}` : fallback;
  }
  return fallback;
}

export function blockBreadcrumbs(flows: LogicFlows, ref: FlowSelectionRef): FlowBlockCrumb[] {
  let steps = flows[ref.rootId];
  if (!steps) {
    return [];
  }
  const crumbs: FlowBlockCrumb[] = [];
  ref.blockPath.forEach((segment, index) => {
    const label = blockDisplayLabel(steps, segment, `${segment.step}`);
    crumbs.push({ label, ref: ancestorSelection(ref, index + 1) });
    steps = childSteps(steps, segment) ?? [];
  });
  return crumbs;
}

function childSteps(steps: readonly FlowStep[], segment: FlowBlockSegment): FlowStep[] | null {
  const step = steps[segment.step];
  if (!step) {
    return null;
  }
  if ((step.kind === "loop" || step.kind === "callback") && segment.path === undefined) {
    return step.body;
  }
  if (step.kind === "branch" && segment.path !== undefined) {
    return step.paths[segment.path]?.body ?? null;
  }
  return null;
}

function branchPathLabel(path: FlowPath): string {
  const role = pathRole(path);
  return role === path.label ? role : `${role}: ${path.label}`;
}
