/**
 * The review checklist's data: every logic flow the PR directly touches, decorated for one row each.
 *
 * The affected-flow predicate and the change-detection fingerprint both live in `@meridian/core` (one
 * tested implementation shared with any future CLI report); this module joins their output to the
 * renderer's node index for display, preserving core's sort (changed flows first, then file/line).
 * `deriveReviewData` returns null when there is no valid `review` extension — the tab gates off.
 */

import { changedPathSet, computeAffectedFlows, flowFingerprint, LOGIC_FLOW_EXTENSION, readReviewContext } from "@meridian/core";
import type { AffectedFlow, GraphArtifact, LogicFlows, ReviewContext } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { ReviewTick } from "../state/reviewTicksPref";

export interface AffectedFlowRow {
  flow: AffectedFlow;
  displayName: string;
  kind: string;
  /** Owner node's location.file; null when the flow's node is missing from the graph. */
  file: string | null;
  /** Owner node's location.startLine; 0 when unknown. */
  startLine: number;
  isTest: boolean;
  group: "changed" | "impacted";
  /** Current flowFingerprint of this flow's steps — compared against stored ticks. */
  fingerprint: string;
}

export interface ReviewData {
  context: ReviewContext;
  /** Order preserved from core sort: group "changed" first, then file asc, then startLine asc. */
  rows: AffectedFlowRow[];
  /** The full logic-flow trees, so the panel can render each affected flow's steps hierarchically. */
  flows: LogicFlows;
}

/** null when extensions.review is absent/malformed. Pure; called once in createBlueprintStore. */
export function deriveReviewData(artifact: GraphArtifact, index: GraphIndex): ReviewData | null {
  const context = readReviewContext(artifact);
  if (!context) {
    return null;
  }
  const flows = readLogicFlows(artifact);
  const changedSet = changedPathSet(context.changedFiles);
  const affected = computeAffectedFlows(artifact.nodes, flows, changedSet);
  const rows = affected.map((flow) => decorate(flow, flows, index));
  return { context, rows, flows };
}

export type TickState = "todo" | "done" | "stale";

/** todo = never ticked; done = ticked fingerprint still matches; stale = the flow changed since. */
export function tickStateOf(row: AffectedFlowRow, ticks: Record<string, ReviewTick>): TickState {
  const tick = ticks[row.flow.flowId];
  if (!tick) {
    return "todo";
  }
  return tick.fingerprint === row.fingerprint ? "done" : "stale";
}

/**
 * The single pure tick transition, shared by the checklist checkbox and "Mark reviewed & back".
 * `toggle` is the checkbox: a done row un-ticks; a todo/stale row ticks fresh. `confirm` only ever
 * CONFIRMS — a done row is left exactly as-is (it must never silently un-tick the flow the reader
 * just finished reviewing). `at` is passed in so this stays pure: the store hands the wall clock, a
 * test hands a fixed string. Returns a new record; the caller persists it whole (never pruned).
 */
export function applyTick(
  ticks: Record<string, ReviewTick>,
  row: AffectedFlowRow,
  mode: "toggle" | "confirm",
  at: string,
): Record<string, ReviewTick> {
  const next = { ...ticks };
  if (tickStateOf(row, ticks) === "done") {
    if (mode === "toggle") {
      delete next[row.flow.flowId];
    }
    return next;
  }
  next[row.flow.flowId] = { at, fingerprint: row.fingerprint };
  return next;
}

/** Join one affected flow to its owner node for display; fall back to the raw id when it is missing. */
function decorate(flow: AffectedFlow, flows: LogicFlows, index: GraphIndex): AffectedFlowRow {
  const node = index.nodesById.get(flow.flowId);
  return {
    flow,
    displayName: node?.displayName ?? flow.flowId,
    kind: node?.kind ?? "function",
    file: node?.location.file ?? null,
    startLine: node?.location.startLine ?? 0,
    isTest: index.testIds.has(flow.flowId),
    group: flow.ownerChanged ? "changed" : "impacted",
    fingerprint: flowFingerprint(flows[flow.flowId] ?? []),
  };
}

/** The logicFlow extension, defensively: a non-object payload reads as no flows (graph-only artifact). */
function readLogicFlows(artifact: GraphArtifact): LogicFlows {
  const raw = artifact.extensions?.[LOGIC_FLOW_EXTENSION];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  return raw as unknown as LogicFlows;
}
