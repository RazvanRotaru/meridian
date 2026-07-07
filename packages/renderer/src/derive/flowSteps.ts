/**
 * POC — logic flows ON the Map canvas: unroll a callable block's logic flow (from
 * `extensions.logicFlow`) into STEP nodes nested inside the block's frame, chained by execution
 * wires, with each resolved call step wiring OUT to wherever its target is drawn. Step ids are
 * view-only pseudo-ids (`step:<owner>:<n>`, like the Logic tab's own React Flow ids) — they never
 * enter the artifact id space. Steps are RECURSIVELY expandable, the same gesture as blocks: a
 * resolved call whose target has a charted flow opens the CALLEE's flow inside the step; a
 * loop/branch/callback opens its own body — so the flow unrolls as deep as the reader asks. The
 * nested ids (`step:step:…`) are path-unique, so a recursive call chain still terminates: each
 * deeper level is a distinct id the reader expanded explicitly. Pure; no React, no ELK.
 */

import type { FlowStep, LogicFlows, NodeId } from "@meridian/core";

/** What a drawn step needs: its label, shape kind, whether it is a resolved call, and its own
 * expansion state (a container step opens into a frame of deeper steps). */
export type StepData = {
  label: string;
  stepKind: "call" | "loop" | "branch" | "callback";
  resolved: boolean;
  isContainer: boolean;
  isExpanded: boolean;
};

export interface StepEmission {
  steps: Array<{ id: string; parentId: string; depth: number; data: StepData }>;
  /** Execution-order wires: step i → step i+1, per nesting level (never across branch paths). */
  chain: Array<{ id: string; source: string; target: string }>;
  /** Resolved call steps and their artifact targets, for dep wires to visible definitions. An
   * EXPANDED call keeps its wire — the frame still points at where the inlined code is defined. */
  calls: Array<{ stepId: string; target: NodeId }>;
}

/** Unroll a block's flow into drawable pseudo-nodes + wires, recursing into every step whose id is
 * in `expanded` — call steps inline their target's flow, constructs their bodies. `resolveTarget`
 * maps a call target to the callable that actually charts it (a `new X()` step targets the CLASS;
 * its flow lives on the constructor) — every emitted call target is already resolved through it. */
export function emitFlowSteps(
  ownerId: string,
  flow: FlowStep[],
  flows: LogicFlows,
  expanded: ReadonlySet<string>,
  resolveTarget: (target: NodeId) => NodeId = (target) => target,
): StepEmission {
  const out: StepEmission = { steps: [], chain: [], calls: [] };
  emitRun(ownerId, flow, 1, 0, out, { flows, expanded, resolveTarget });
  return out;
}

interface EmitContext {
  flows: LogicFlows;
  expanded: ReadonlySet<string>;
  resolveTarget: (target: NodeId) => NodeId;
}

/** Emit one contiguous run of steps under `ownerId`, chained in order, starting at `base` (branch
 * paths share a parent, so later paths offset their indices to keep child ids unique). */
function emitRun(ownerId: string, steps: FlowStep[], depth: number, base: number, out: StepEmission, ctx: EmitContext): void {
  let previous: string | null = null;
  steps.forEach((step, i) => {
    const id = `step:${ownerId}:${base + i}`;
    const isContainer = hasInside(step, ctx);
    const isExpanded = isContainer && ctx.expanded.has(id);
    out.steps.push({ id, parentId: ownerId, depth, data: stepData(step, isContainer, isExpanded) });
    if (previous !== null) {
      out.chain.push({ id: `flow:${ownerId}:${base + i}`, source: previous, target: id });
    }
    previous = id;
    if (step.kind === "call" && step.resolution === "resolved" && step.target) {
      out.calls.push({ stepId: id, target: ctx.resolveTarget(step.target) });
    }
    if (isExpanded) {
      emitInside(id, step, depth + 1, out, ctx);
    }
  });
}

/** What expanding this step charts: nothing across branch PATHS is chained — they are alternatives. */
function emitInside(id: string, step: FlowStep, depth: number, out: StepEmission, ctx: EmitContext): void {
  if (step.kind === "branch") {
    let offset = 0;
    for (const path of step.paths) {
      emitRun(id, path.body, depth, offset, out, ctx);
      offset += path.body.length;
    }
    return;
  }
  const inside = step.kind === "call" ? (step.target ? ctx.flows[ctx.resolveTarget(step.target)] ?? [] : []) : step.body;
  emitRun(id, inside, depth, 0, out, ctx);
}

/** Whether the step has anything to open: a charted callee flow, or a non-empty construct body. */
function hasInside(step: FlowStep, ctx: EmitContext): boolean {
  if (step.kind === "call") {
    return step.resolution === "resolved" && step.target !== null && (ctx.flows[ctx.resolveTarget(step.target)]?.length ?? 0) > 0;
  }
  if (step.kind === "branch") {
    return step.paths.some((path) => path.body.length > 0);
  }
  return step.body.length > 0;
}

function stepData(step: FlowStep, isContainer: boolean, isExpanded: boolean): StepData {
  return {
    label: step.label,
    stepKind: step.kind,
    resolved: step.kind === "call" ? step.resolution === "resolved" : false,
    isContainer,
    isExpanded,
  };
}
