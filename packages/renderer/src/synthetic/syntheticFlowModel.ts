import type { RequestTrace, SyntheticExecution, SyntheticNodeSnapshot, TimelineSpan } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { requestSpanMomentId } from "../derive/requestFlowAddress";

/** One already-derived runtime occurrence in capture order. */
export interface SyntheticFlowStep {
  id: string;
  nodeId: string | null;
  label: string;
  callerBreadcrumb: readonly string[];
}

export interface SyntheticOccurrenceStep extends SyntheticFlowStep {
  spanId: string;
  status: TimelineSpan["status"];
  durationMs: number;
  snapshot: SyntheticNodeSnapshot | null;
}

/** Capture order is deterministic but deliberately does not claim sibling causality. Parent links
 * supply the breadcrumb; start time plus span id supplies only the reader's previous/next order. */
export function syntheticOccurrenceSteps(
  execution: SyntheticExecution,
  index: GraphIndex,
): SyntheticOccurrenceStep[] {
  const trace = execution.trace;
  const spansById = new Map(trace.spans.map((span) => [span.spanId, span]));
  const snapshotsBySpanId = new Map(execution.snapshots.map((snapshot) => [snapshot.spanId, snapshot]));
  return [...trace.spans]
    .sort(compareCapturedSpans)
    .map((span) => ({
      id: requestSpanMomentId(trace.traceId, span.spanId),
      spanId: span.spanId,
      nodeId: span.nodeId !== undefined && index.nodesById.has(span.nodeId) ? span.nodeId : null,
      label: spanLabel(span, index),
      callerBreadcrumb: callerBreadcrumb(span, spansById, index),
      status: span.status,
      durationMs: durationMs(span),
      snapshot: matchingSnapshot(span, snapshotsBySpanId.get(span.spanId)),
    }));
}

export function selectedSyntheticOccurrenceIndex(
  steps: readonly Pick<SyntheticOccurrenceStep, "id">[],
  selectedId: string | null,
): number {
  if (steps.length === 0) return -1;
  const index = selectedId === null ? -1 : steps.findIndex((step) => step.id === selectedId);
  return index < 0 ? 0 : index;
}

export function adjacentSyntheticOccurrence(
  steps: readonly SyntheticOccurrenceStep[],
  selectedId: string | null,
  direction: -1 | 1,
): SyntheticOccurrenceStep | null {
  const current = selectedSyntheticOccurrenceIndex(steps, selectedId);
  if (current < 0) return null;
  return steps[current + direction] ?? null;
}

export function defaultSyntheticMomentId(trace: RequestTrace): string | null {
  const root = trace.spans.find((span) => span.spanId === trace.rootSpanId);
  const fallback = [...trace.spans].sort(compareCapturedSpans)[0];
  const span = root ?? fallback;
  return span === undefined ? null : requestSpanMomentId(trace.traceId, span.spanId);
}

function matchingSnapshot(
  span: TimelineSpan,
  snapshot: SyntheticNodeSnapshot | undefined,
): SyntheticNodeSnapshot | null {
  return snapshot !== undefined && snapshot.nodeId === span.nodeId ? snapshot : null;
}

function callerBreadcrumb(
  span: TimelineSpan,
  spansById: ReadonlyMap<string, TimelineSpan>,
  index: GraphIndex,
): string[] {
  const labels: string[] = [];
  const visited = new Set<string>([span.spanId]);
  let parentId = span.parentSpanId;
  while (parentId !== undefined && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = spansById.get(parentId);
    if (parent === undefined) break;
    labels.unshift(spanLabel(parent, index));
    parentId = parent.parentSpanId;
  }
  return labels;
}

function spanLabel(span: TimelineSpan, index: GraphIndex): string {
  return span.nodeId === undefined ? span.name : index.nodesById.get(span.nodeId)?.displayName ?? span.name;
}

function durationMs(span: TimelineSpan): number {
  return Number(BigInt(span.endedAtUnixNano) - BigInt(span.startedAtUnixNano)) / 1_000_000;
}

function compareCapturedSpans(left: TimelineSpan, right: TimelineSpan): number {
  const time = BigInt(left.startedAtUnixNano) - BigInt(right.startedAtUnixNano);
  if (time < 0n) return -1;
  if (time > 0n) return 1;
  return left.spanId.localeCompare(right.spanId);
}
