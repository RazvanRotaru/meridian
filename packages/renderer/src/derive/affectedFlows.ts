/**
 * PR-review derive: which logic flows a change set touches DIRECTLY. A flow (keyed by its callable
 * node id in `extensions.logicFlow`) is "affected" iff its own node changed, or one of its DIRECT
 * call steps lands on a changed node. "Direct" means this flow's own steps only — no transitive
 * closure into the flows of the callees. Pure; no React, no store.
 */

import type { FlowStep, GraphNode } from "@meridian/core";

export interface AffectedFlow {
  /** Callable node id — the key in `extensions.logicFlow`. */
  flowId: string;
  /** Owner node.displayName, falling back to the raw flow id. */
  displayName: string;
  /** Owner node.kind, falling back to "function". */
  kind: string;
  /** Owner node.location.file, or null when the owner isn't in the graph. */
  file: string | null;
  /** The flow's own callable id is in the change set. */
  ownerChanged: boolean;
  /** Resolved direct call targets that are themselves changed (deduped, sorted). */
  changedTargets: string[];
}

export function computeAffectedFlows(
  nodes: readonly GraphNode[],
  logicFlows: Record<string, FlowStep[]>,
  changedIds: ReadonlySet<string>,
): AffectedFlow[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const affected: AffectedFlow[] = [];
  for (const [flowId, steps] of Object.entries(logicFlows)) {
    const ownerChanged = changedIds.has(flowId);
    const changedTargets = collectChangedTargets(steps, changedIds);
    if (!ownerChanged && changedTargets.length === 0) {
      continue;
    }
    affected.push(describeFlow(flowId, nodeById.get(flowId), ownerChanged, changedTargets));
  }
  return affected.sort(byImpact);
}

function describeFlow(
  flowId: string,
  owner: GraphNode | undefined,
  ownerChanged: boolean,
  changedTargets: string[],
): AffectedFlow {
  return {
    flowId,
    displayName: owner?.displayName ?? flowId,
    kind: owner?.kind ?? "function",
    file: owner?.location.file ?? null,
    ownerChanged,
    changedTargets,
  };
}

/** Recursively walk a flow's step tree, gathering resolved call targets that are changed. */
function collectChangedTargets(steps: readonly FlowStep[], changedIds: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  walkSteps(steps, changedIds, found);
  return [...found].sort();
}

function walkSteps(steps: readonly FlowStep[], changedIds: ReadonlySet<string>, found: Set<string>): void {
  for (const step of steps) {
    if (step.kind === "call") {
      if (step.resolution === "resolved" && step.target != null && changedIds.has(step.target)) {
        found.add(step.target);
      }
      continue;
    }
    for (const body of bodiesOf(step)) {
      walkSteps(body, changedIds, found);
    }
  }
}

/** The nested step lists a non-call step carries: loop/callback bodies, and each branch path body.
 * Leaf steps (e.g. `exit`) carry no nested flow, so they contribute nothing. */
function bodiesOf(step: Exclude<FlowStep, { kind: "call" }>): FlowStep[][] {
  if (step.kind === "branch") {
    return step.paths.map((path) => path.body);
  }
  if (step.kind === "loop" || step.kind === "callback") {
    return [step.body];
  }
  return [];
}

/** ownerChanged first, then file ascending (nulls last), then displayName ascending. */
function byImpact(a: AffectedFlow, b: AffectedFlow): number {
  if (a.ownerChanged !== b.ownerChanged) {
    return a.ownerChanged ? -1 : 1;
  }
  const byFile = compareNullableAsc(a.file, b.file);
  if (byFile !== 0) {
    return byFile;
  }
  return a.displayName.localeCompare(b.displayName);
}

function compareNullableAsc(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a.localeCompare(b);
}
