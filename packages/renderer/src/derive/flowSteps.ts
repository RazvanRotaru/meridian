/**
 * POC — logic flows ON the Map canvas: unroll a callable block's logic flow (from
 * `extensions.logicFlow`) into STEP nodes nested inside the block's frame, chained by execution
 * wires, with each resolved call step wiring OUT to wherever its target is drawn. Step ids are
 * view-only pseudo-ids (`step:<block>:<n>`, like the Logic tab's own React Flow ids) — they never
 * enter the artifact id space. Top-level steps only for the POC: a loop/branch/callback renders as
 * one step carrying its label (its nested calls stay folded). Pure; no React, no ELK.
 */

import type { FlowStep, NodeId } from "@meridian/core";

/** What a drawn step needs: its label, shape kind, and whether it is a resolved call. */
export type StepData = {
  label: string;
  stepKind: "call" | "loop" | "branch" | "callback";
  resolved: boolean;
};

export interface StepEmission {
  steps: Array<{ id: string; data: StepData }>;
  /** Execution-order wires: step i → step i+1. */
  chain: Array<{ id: string; source: string; target: string }>;
  /** Resolved call steps and their artifact targets, for dep wires to visible definitions. */
  calls: Array<{ stepId: string; target: NodeId }>;
}

/** Unroll a block's top-level flow steps into drawable pseudo-nodes + wires. */
export function emitFlowSteps(blockId: string, flow: FlowStep[]): StepEmission {
  const steps = flow.map((step, i) => ({ id: stepId(blockId, i), data: stepData(step) }));
  const chain = steps.slice(1).map((step, i) => ({
    id: `flow:${blockId}:${i}`,
    source: steps[i].id,
    target: step.id,
  }));
  const calls: StepEmission["calls"] = [];
  flow.forEach((step, i) => {
    if (step.kind === "call" && step.resolution === "resolved" && step.target) {
      calls.push({ stepId: stepId(blockId, i), target: step.target });
    }
  });
  return { steps, chain, calls };
}

function stepId(blockId: string, index: number): string {
  return `step:${blockId}:${index}`;
}

function stepData(step: FlowStep): StepData {
  if (step.kind === "call") {
    return { label: step.label, stepKind: "call", resolved: step.resolution === "resolved" };
  }
  // A container step folds to one node for the POC; its label already carries the construct
  // (`for …`, `if …`, `useEffect(…)`), so the shape reads without unrolling the body.
  return { label: step.label, stepKind: step.kind, resolved: false };
}
