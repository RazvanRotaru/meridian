/** Map analyzer-owned Python flow trees onto the canonical language-neutral FlowStep contract. */

import { externalTargetId, unresolvedTargetId } from "@meridian/core";
import type { EdgeResolution, FlowPath, FlowSourceAnchor, FlowStep, GraphNode, LogicFlows } from "@meridian/core";
import type { NodeIndex } from "./nodes";
import type {
  AnalyzeFlowPath,
  AnalyzeFlowSource,
  AnalyzeFlowStep,
  AnalyzeModule,
  AnalyzeOutput,
  AnalyzeTarget,
} from "./types";

const ECOSYSTEM = "python";
const UNRESOLVED_TARGET = unresolvedTargetId(ECOSYSTEM);

export function buildFlows(output: AnalyzeOutput, index: NodeIndex, nodes: readonly GraphNode[]): LogicFlows {
  const keepIds = new Set(nodes.map((node) => node.id));
  const flows: LogicFlows = {};
  for (const module of output.modules) {
    for (const flow of module.flows) {
      const owner = index.sourceId(module, flow.sourceQualname, flow.sourceLine);
      if (!owner || !keepIds.has(owner)) continue;
      const steps = flow.steps.map((step) => mapStep(module, step, index));
      if (steps.some((step) => step.kind !== "exit")) flows[owner] = steps;
    }
  }
  return flows;
}

function mapStep(module: AnalyzeModule, step: AnalyzeFlowStep, index: NodeIndex): FlowStep {
  const source = sourceOf(module, step);
  switch (step.kind) {
    case "call": {
      const target = targetOf(step.target, index);
      return {
        kind: "call",
        label: step.label,
        target: target.id,
        resolution: target.resolution,
        ...(step.awaited ? { awaited: true } : {}),
        source,
      };
    }
    case "await":
      return { kind: "await", label: step.label, mode: "single", inputs: step.inputs, source };
    case "loop":
      return { kind: "loop", label: step.label, body: step.body.map((child) => mapStep(module, child, index)), source };
    case "callback":
      return { kind: "callback", label: step.label, body: step.body.map((child) => mapStep(module, child, index)), source };
    case "branch":
      return {
        kind: "branch",
        label: step.label,
        branchKind: step.branchKind,
        paths: step.paths.map((path) => mapPath(module, path, index)),
        source,
      };
    case "exit":
      return { kind: "exit", variant: step.variant, label: step.label, source };
  }
}

function mapPath(module: AnalyzeModule, path: AnalyzeFlowPath, index: NodeIndex): FlowPath {
  return {
    label: path.label,
    role: path.role,
    pathId: path.pathId,
    body: path.body.map((step) => mapStep(module, step, index)),
    ...(path.source ? { source: sourceOf(module, path.source) } : {}),
  };
}

function sourceOf(module: AnalyzeModule, source: AnalyzeFlowSource): FlowSourceAnchor {
  return {
    file: module.file,
    line: source.line,
    // The analyzer wire follows call-site conventions (1-based columns); FlowSourceAnchor is 0-based.
    col: Math.max(0, source.col - 1),
    endLine: source.endLine,
    endCol: Math.max(0, source.endCol - 1),
  };
}

function targetOf(target: AnalyzeTarget, index: NodeIndex): { id: string; resolution: EdgeResolution } {
  if (target.resolution === "resolved") {
    const id = index.targetId(target.modulePath, target.qualname, target.targetLine);
    if (id) return { id, resolution: "resolved" };
    return index.modulePaths.has(target.modulePath)
      ? { id: UNRESOLVED_TARGET, resolution: "unresolved" }
      : {
          id: externalTargetId(ECOSYSTEM, target.modulePath, target.qualname ?? undefined),
          resolution: "external",
        };
  }
  if (target.resolution === "external") {
    return {
      id: externalTargetId(ECOSYSTEM, target.module, target.name ?? undefined),
      resolution: "external",
    };
  }
  return { id: UNRESOLVED_TARGET, resolution: "unresolved" };
}
