import type {
  JsonValue,
  SyntheticExecution,
  SyntheticNodeSnapshot,
  TimelineEvent,
  TimelineSpan,
  TraceAttributeScalar,
  TraceAttributeValue,
} from "@meridian/core";
import { buildRequestTimeline } from "../derive/requestTimelineModel";
import { diffSyntheticValues, type SyntheticValueChange } from "./syntheticValueDiff";

export type SyntheticComparisonConfidence = "complete" | "partial";
export type SyntheticOccurrencePresence = "matched" | "before-only" | "after-only";

export interface SyntheticOccurrenceCapture {
  spanId: string;
  status: TimelineSpan["status"];
  snapshot: SyntheticNodeSnapshot | null;
}

export type SyntheticCapturedOutcome =
  | { kind: "value"; value: JsonValue }
  | { kind: "void" }
  | { kind: "error"; message: string }
  | { kind: "uncaptured" };

export interface SyntheticOutcomeChange {
  before: SyntheticCapturedOutcome;
  after: SyntheticCapturedOutcome;
  /** Populated only for value-to-value transitions. State transitions remain explicit above. */
  valueChanges: SyntheticValueChange[];
}

export type SyntheticDecision =
  | {
      type: "branch";
      siteId: string;
      pathId: string;
      condition: string;
      outcome: TraceAttributeScalar;
      valueName: string | null;
      value: TraceAttributeValue | null;
    }
  | {
      type: "loop";
      siteId: string;
      label: string;
      iterations: number;
      emittedIterations: number;
      truncated: boolean;
    }
  | {
      type: "exception";
      siteId: string | null;
      exceptionType: string;
      message: string | null;
      handled: boolean;
    };

export interface SyntheticDecisionChange {
  key: string;
  type: SyntheticDecision["type"];
  kind: "added" | "removed" | "changed";
  before: SyntheticDecision | null;
  after: SyntheticDecision | null;
}

export interface SyntheticOccurrenceComparison {
  /** Stable within a same-root comparison; it never contains trace/span ids or timestamps. */
  key: string;
  nodeId: string | null;
  name: string;
  parentKey: string | null;
  ordinal: number;
  presence: SyntheticOccurrencePresence;
  before: SyntheticOccurrenceCapture | null;
  after: SyntheticOccurrenceCapture | null;
  statusChanged: boolean;
  /** Null means one side did not capture this boundary; [] means both inputs are identical. */
  snapshotInputChanges: SyntheticValueChange[] | null;
  snapshotAvailabilityChanged: boolean;
  outcomeChange: SyntheticOutcomeChange | null;
  decisionChanges: SyntheticDecisionChange[];
  changed: boolean;
}

export interface SyntheticExecutionComparisonSummary {
  inputChangeCount: number;
  pathChangeCount: number;
  outputChangeCount: number;
  statusChangeCount: number;
  changedOccurrenceCount: number;
  hasChanges: boolean;
}

export interface SyntheticExecutionComparison {
  compatible: boolean;
  incompatibilityReason: string | null;
  confidence: SyntheticComparisonConfidence;
  partialReasons: string[];
  inputChanges: SyntheticValueChange[];
  /** Current-run order first, followed by occurrences observed only in the previous run. */
  occurrences: SyntheticOccurrenceComparison[];
  summary: SyntheticExecutionComparisonSummary;
}

interface CanonicalDecision {
  key: string;
  value: SyntheticDecision;
}

interface CanonicalOccurrence {
  key: string;
  nodeId: string | null;
  name: string;
  parentKey: string | null;
  ordinal: number;
  capture: SyntheticOccurrenceCapture;
  decisions: CanonicalDecision[];
}

/**
 * Compare two successful executions of the same configured root without relying on per-run ids,
 * wall-clock timing, or duration. Repeated calls are aligned by their semantic parent path and
 * capture ordinal. Without a producer correlation id, that ordinal is intentionally best-effort
 * for repeated same-node siblings; the model never claims field-level lineage.
 */
export function compareSyntheticExecutions(
  before: SyntheticExecution,
  after: SyntheticExecution,
): SyntheticExecutionComparison {
  const partialReasons = comparisonPartialReasons(before, after);
  if (before.scenarioId !== after.scenarioId || before.rootId !== after.rootId) {
    return {
      compatible: false,
      incompatibilityReason: before.rootId !== after.rootId
        ? "Synthetic executions target different flow roots."
        : "Synthetic executions use different scenarios.",
      confidence: "partial",
      partialReasons,
      inputChanges: [],
      occurrences: [],
      summary: emptySummary(),
    };
  }

  const inputChanges = diffSyntheticValues(before.input, after.input);
  const beforeOccurrences = canonicalOccurrences(before);
  const afterOccurrences = canonicalOccurrences(after);
  const beforeByKey = new Map(beforeOccurrences.map((occurrence) => [occurrence.key, occurrence]));
  const afterByKey = new Map(afterOccurrences.map((occurrence) => [occurrence.key, occurrence]));
  const orderedKeys = [
    ...afterOccurrences.map((occurrence) => occurrence.key),
    ...beforeOccurrences.map((occurrence) => occurrence.key).filter((key) => !afterByKey.has(key)),
  ];
  const occurrences = orderedKeys.map((key) => compareOccurrence(beforeByKey.get(key), afterByKey.get(key)));
  const summary = summarize(inputChanges, occurrences);

  return {
    compatible: true,
    incompatibilityReason: null,
    confidence: partialReasons.length === 0 ? "complete" : "partial",
    partialReasons,
    inputChanges,
    occurrences,
    summary,
  };
}

function canonicalOccurrences(execution: SyntheticExecution): CanonicalOccurrence[] {
  const timeline = buildRequestTimeline(execution.trace);
  const snapshotsBySpanId = new Map(execution.snapshots.map((snapshot) => [snapshot.spanId, snapshot]));
  const keysBySpanId = new Map<string, string>();
  const ordinalByParentAndIdentity = new Map<string, number>();

  return timeline.rows.map((row) => {
    const span = row.span;
    const parentKey = span.parentSpanId === undefined ? null : keysBySpanId.get(span.parentSpanId) ?? null;
    const identity = span.nodeId === undefined ? `name:${span.name}` : `node:${span.nodeId}`;
    const ordinalGroup = `${parentKey ?? "$"}\u0000${identity}`;
    const ordinal = (ordinalByParentAndIdentity.get(ordinalGroup) ?? 0) + 1;
    ordinalByParentAndIdentity.set(ordinalGroup, ordinal);
    const key = `${parentKey ?? "$"}/${encodeURIComponent(identity)}[${ordinal}]`;
    keysBySpanId.set(span.spanId, key);
    const candidateSnapshot = snapshotsBySpanId.get(span.spanId);
    const snapshot = candidateSnapshot !== undefined && candidateSnapshot.nodeId === span.nodeId
      ? candidateSnapshot
      : null;
    return {
      key,
      nodeId: span.nodeId ?? null,
      name: span.name,
      parentKey,
      ordinal,
      capture: { spanId: span.spanId, status: span.status, snapshot },
      decisions: canonicalDecisions(row.events.map(({ event }) => event), key),
    };
  });
}

function canonicalDecisions(events: readonly TimelineEvent[], occurrenceKey: string): CanonicalDecision[] {
  const ordinals = new Map<string, number>();
  const decisions: CanonicalDecision[] = [];
  for (const event of events) {
    const value = decisionFor(event);
    if (value === null) continue;
    const semanticSite = value.type === "exception"
      ? value.siteId ?? "unsited"
      : value.siteId;
    const group = `${value.type}:${semanticSite}`;
    const ordinal = (ordinals.get(group) ?? 0) + 1;
    ordinals.set(group, ordinal);
    decisions.push({
      key: `${occurrenceKey}::${encodeURIComponent(group)}[${ordinal}]`,
      value,
    });
  }
  return decisions;
}

function decisionFor(event: TimelineEvent): SyntheticDecision | null {
  if (event.type === "branch.taken") {
    return {
      type: "branch",
      siteId: event.siteId,
      pathId: event.pathId,
      condition: event.condition,
      outcome: event.outcome,
      valueName: event.valueName ?? null,
      value: event.value ?? null,
    };
  }
  if (event.type === "loop.summary") {
    return {
      type: "loop",
      siteId: event.siteId,
      label: event.label,
      iterations: event.iterations,
      emittedIterations: event.emittedIterations,
      truncated: event.truncated,
    };
  }
  if (event.type === "exception") {
    return {
      type: "exception",
      siteId: event.siteId ?? null,
      exceptionType: event.exceptionType,
      message: event.message ?? null,
      handled: event.handled,
    };
  }
  return null;
}

function compareOccurrence(
  before: CanonicalOccurrence | undefined,
  after: CanonicalOccurrence | undefined,
): SyntheticOccurrenceComparison {
  const reference = after ?? before!;
  const presence: SyntheticOccurrencePresence = before === undefined
    ? "after-only"
    : after === undefined
      ? "before-only"
      : "matched";
  const statusChanged = before !== undefined && after !== undefined
    && before.capture.status !== after.capture.status;
  const snapshotAvailabilityChanged = before !== undefined && after !== undefined
    && (before.capture.snapshot === null) !== (after.capture.snapshot === null);
  const snapshotInputChanges = before?.capture.snapshot !== null
    && before?.capture.snapshot !== undefined
    && after?.capture.snapshot !== null
    && after?.capture.snapshot !== undefined
    ? diffSyntheticValues(before.capture.snapshot.input, after.capture.snapshot.input)
    : null;
  const outcomeChange = before !== undefined && after !== undefined
    ? compareOutcome(capturedOutcome(before.capture.snapshot), capturedOutcome(after.capture.snapshot))
    : null;
  const decisionChanges = before !== undefined && after !== undefined
    ? compareDecisions(before.decisions, after.decisions)
    : [];
  const changed = presence !== "matched"
    || statusChanged
    || snapshotAvailabilityChanged
    || (snapshotInputChanges?.length ?? 0) > 0
    || outcomeChange !== null
    || decisionChanges.length > 0;

  return {
    key: reference.key,
    nodeId: reference.nodeId,
    name: reference.name,
    parentKey: reference.parentKey,
    ordinal: reference.ordinal,
    presence,
    before: before?.capture ?? null,
    after: after?.capture ?? null,
    statusChanged,
    snapshotInputChanges,
    snapshotAvailabilityChanged,
    outcomeChange,
    decisionChanges,
    changed,
  };
}

function capturedOutcome(snapshot: SyntheticNodeSnapshot | null): SyntheticCapturedOutcome {
  if (snapshot === null) return { kind: "uncaptured" };
  if (snapshot.error !== undefined) return { kind: "error", message: snapshot.error };
  if (snapshot.output === undefined) return { kind: "void" };
  return { kind: "value", value: snapshot.output };
}

function compareOutcome(
  before: SyntheticCapturedOutcome,
  after: SyntheticCapturedOutcome,
): SyntheticOutcomeChange | null {
  if (before.kind === "value" && after.kind === "value") {
    const valueChanges = diffSyntheticValues(before.value, after.value);
    return valueChanges.length === 0 ? null : { before, after, valueChanges };
  }
  if (before.kind === "error" && after.kind === "error" && before.message === after.message) return null;
  if (before.kind === after.kind && (before.kind === "void" || before.kind === "uncaptured")) return null;
  return { before, after, valueChanges: [] };
}

function compareDecisions(
  before: readonly CanonicalDecision[],
  after: readonly CanonicalDecision[],
): SyntheticDecisionChange[] {
  const beforeByKey = new Map(before.map((decision) => [decision.key, decision]));
  const afterByKey = new Map(after.map((decision) => [decision.key, decision]));
  const keys = [
    ...after.map((decision) => decision.key),
    ...before.map((decision) => decision.key).filter((key) => !afterByKey.has(key)),
  ];
  const changes: SyntheticDecisionChange[] = [];
  for (const key of keys) {
    const left = beforeByKey.get(key)?.value ?? null;
    const right = afterByKey.get(key)?.value ?? null;
    if (left !== null && right !== null && sameDecision(left, right)) continue;
    const value = right ?? left!;
    changes.push({
      key,
      type: value.type,
      kind: left === null ? "added" : right === null ? "removed" : "changed",
      before: left,
      after: right,
    });
  }
  return changes;
}

function sameDecision(left: SyntheticDecision, right: SyntheticDecision): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparisonPartialReasons(before: SyntheticExecution, after: SyntheticExecution): string[] {
  const reasons: string[] = [];
  if (!before.trace.completeness.complete) reasons.push("Previous execution is a partial capture.");
  if (!after.trace.completeness.complete) reasons.push("Current execution is a partial capture.");
  if (before.warnings.length > 0) reasons.push("Previous execution reported capture warnings.");
  if (after.warnings.length > 0) reasons.push("Current execution reported capture warnings.");
  return reasons;
}

function summarize(
  inputChanges: readonly SyntheticValueChange[],
  occurrences: readonly SyntheticOccurrenceComparison[],
): SyntheticExecutionComparisonSummary {
  const pathChangeCount = occurrences.reduce((count, occurrence) => (
    count
    + (occurrence.presence === "matched" ? 0 : 1)
    + occurrence.decisionChanges.length
  ), 0);
  const outputChangeCount = occurrences.filter((occurrence) => occurrence.outcomeChange !== null).length;
  const statusChangeCount = occurrences.filter((occurrence) => occurrence.statusChanged).length;
  const changedOccurrenceCount = occurrences.filter((occurrence) => occurrence.changed).length;
  return {
    inputChangeCount: inputChanges.length,
    pathChangeCount,
    outputChangeCount,
    statusChangeCount,
    changedOccurrenceCount,
    hasChanges: inputChanges.length > 0 || changedOccurrenceCount > 0,
  };
}

function emptySummary(): SyntheticExecutionComparisonSummary {
  return {
    inputChangeCount: 0,
    pathChangeCount: 0,
    outputChangeCount: 0,
    statusChangeCount: 0,
    changedOccurrenceCount: 0,
    hasChanges: false,
  };
}
