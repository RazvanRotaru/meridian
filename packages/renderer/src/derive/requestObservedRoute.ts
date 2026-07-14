import type {
  ExceptionTimelineEvent,
  RequestTrace,
  TimelineEvent,
  TimelineSpan,
} from "@meridian/core";
import { buildRequestTimeline, requestEventKey } from "./requestTimelineModel";
import { observedBranchValue } from "./requestEventPresentation";

export type ObservedRouteRelation = "entry" | "call" | "next" | "resume" | "catch" | "separate";
export type ObservedRouteObservationKind = "branch" | "loop" | "exception";

export interface ObservedRouteObservation {
  key: string;
  kind: ObservedRouteObservationKind;
  /** Short, prominent captured outcome such as `else`, `loop ×2`, or `threw`. */
  outcome: string;
  /** The captured value/type which explains the outcome. */
  evidence: string | null;
  /** Full non-inferred event evidence for hover and accessibility text. */
  detail: string;
  tone: "observed" | "loop" | "error" | "caught";
}

export interface ObservedRouteRun {
  key: string;
  spanId: string;
  nodeId: string | null;
  spanName: string;
  relation: ObservedRouteRelation;
  observations: ObservedRouteObservation[];
}

export interface ObservedRequestRoute {
  runs: ObservedRouteRun[];
  complete: boolean;
  observationCount: number;
}

type RouteEvent = Extract<TimelineEvent, { type: "branch.taken" | "loop.summary" | "exception" }>;

interface StartToken {
  kind: "start";
  timeUnixNano: string;
  span: TimelineSpan;
  /** `buildRequestTimeline` already emits parent-before-child rows, including equal starts. */
  rowOrder: number;
}

interface EventToken {
  kind: "event";
  timeUnixNano: string;
  span: TimelineSpan;
  event: RouteEvent;
}

type RouteToken = StartToken | EventToken;

/**
 * Reconstruct a compact request route from evidence only. Span starts provide the observed call
 * sequence; branch, loop, and exception events explain the concrete alternatives it took. Returning
 * to a parent for its catch/continuation creates a new owner run instead of inventing a child call.
 */
export function deriveObservedRequestRoute(trace: RequestTrace): ObservedRequestRoute {
  const timeline = buildRequestTimeline(trace);
  const spansById = new Map(timeline.rows.map((row) => [row.span.spanId, row.span]));
  const tokens: RouteToken[] = [];

  for (const [rowOrder, row] of timeline.rows.entries()) {
    tokens.push({ kind: "start", timeUnixNano: row.span.startedAtUnixNano, span: row.span, rowOrder });
    for (const { event } of row.events) {
      if (!isRouteEvent(event)) continue;
      tokens.push({ kind: "event", timeUnixNano: event.timeUnixNano, span: row.span, event });
    }
  }
  tokens.sort(compareRouteTokens);

  const runs: ObservedRouteRun[] = [];
  let observationCount = 0;
  for (const token of tokens) {
    const previous = runs[runs.length - 1];
    if (token.kind === "event" && previous?.spanId === token.span.spanId) {
      previous.observations.push(observationFor(token.span, token.event));
      observationCount += 1;
      continue;
    }

    const relation = relationFor(previous, token, spansById);
    const run: ObservedRouteRun = {
      key: token.kind === "start"
        ? `${token.span.spanId}:start`
        : requestEventKey(token.span.spanId, token.event.eventId),
      spanId: token.span.spanId,
      nodeId: token.span.nodeId ?? null,
      spanName: token.span.name,
      relation,
      observations: token.kind === "event" ? [observationFor(token.span, token.event)] : [],
    };
    if (token.kind === "event") observationCount += 1;
    runs.push(run);
  }

  return { runs, complete: trace.completeness.complete, observationCount };
}

function isRouteEvent(event: TimelineEvent): event is RouteEvent {
  return event.type === "branch.taken" || event.type === "loop.summary" || event.type === "exception";
}

function relationFor(
  previous: ObservedRouteRun | undefined,
  token: RouteToken,
  spansById: ReadonlyMap<string, TimelineSpan>,
): ObservedRouteRelation {
  if (previous === undefined) return "entry";
  if (token.kind === "event") {
    const resumesAncestor = isAncestor(token.span.spanId, previous.spanId, spansById);
    const previousSpan = spansById.get(previous.spanId);
    const resumesAfterPreviousCompleted = resumesAncestor
      && previousSpan !== undefined
      && safeNano(previousSpan.endedAtUnixNano) <= safeNano(token.event.timeUnixNano);
    if (resumesAfterPreviousCompleted && token.event.type === "branch.taken" && token.event.pathId === "catch") return "catch";
    return resumesAfterPreviousCompleted ? "resume" : "separate";
  }
  if (token.span.parentSpanId === previous.spanId) return "call";
  const followsSameParentPath = token.span.parentSpanId !== undefined && (
    token.span.parentSpanId === spansById.get(previous.spanId)?.parentSpanId
    || isAncestor(token.span.parentSpanId, previous.spanId, spansById)
  );
  if (followsSameParentPath) {
    const previousSpan = spansById.get(previous.spanId);
    // Sibling work can overlap. Chronological token order alone must not draw a sequential arrow
    // between concurrent spans which merely share the same captured parent.
    return previousSpan !== undefined
      && safeNano(previousSpan.endedAtUnixNano) <= safeNano(token.span.startedAtUnixNano)
      ? "next"
      : "separate";
  }
  return "separate";
}

function isAncestor(
  candidateId: string,
  descendantId: string,
  spansById: ReadonlyMap<string, TimelineSpan>,
): boolean {
  let cursor = spansById.get(descendantId)?.parentSpanId;
  const visited = new Set<string>();
  while (cursor !== undefined && !visited.has(cursor)) {
    if (cursor === candidateId) return true;
    visited.add(cursor);
    cursor = spansById.get(cursor)?.parentSpanId;
  }
  return false;
}

function observationFor(span: TimelineSpan, event: RouteEvent): ObservedRouteObservation {
  const key = requestEventKey(span.spanId, event.eventId);
  if (event.type === "branch.taken") {
    const evidence = observedBranchValue(event);
    return {
      key,
      kind: "branch",
      outcome: event.pathId,
      evidence,
      detail: `${event.condition} → ${event.pathId} · ${evidence} · site ${event.siteId} · ${sourceLabel(event.source)}`,
      tone: event.pathId === "catch" ? "caught" : "observed",
    };
  }
  if (event.type === "loop.summary") {
    const captured = event.truncated || event.emittedIterations !== event.iterations
      ? ` · ${event.emittedIterations}/${event.iterations} captured${event.truncated ? " · truncated" : ""}`
      : "";
    return {
      key,
      kind: "loop",
      outcome: `loop ×${event.iterations}`,
      evidence: event.label,
      detail: `${event.label} · ${event.iterations} iteration${event.iterations === 1 ? "" : "s"}${captured} · site ${event.siteId} · ${sourceLabel(event.source)}`,
      tone: "loop",
    };
  }
  return exceptionObservation(key, event);
}

function exceptionObservation(key: string, event: ExceptionTimelineEvent): ObservedRouteObservation {
  const source = event.source === undefined ? "source unavailable" : sourceLabel(event.source);
  return {
    key,
    kind: "exception",
    outcome: event.handled ? "caught" : "threw",
    evidence: event.exceptionType,
    detail: `${event.handled ? "Caught" : "Threw"} ${event.exceptionType}${event.message ? ` · ${event.message}` : ""} · ${source}`,
    tone: event.handled ? "caught" : "error",
  };
}

function sourceLabel(source: { file: string; line: number; col?: number }): string {
  return `${source.file}:${source.line}${source.col === undefined ? "" : `:${source.col}`}`;
}

function compareRouteTokens(left: RouteToken, right: RouteToken): number {
  const time = compareNano(left.timeUnixNano, right.timeUnixNano);
  if (time !== 0) return time;
  if (left.kind !== right.kind) return left.kind === "start" ? -1 : 1;
  if (left.kind === "start" && right.kind === "start" && left.rowOrder !== right.rowOrder) {
    return left.rowOrder - right.rowOrder;
  }
  const leftKey = left.kind === "start" ? left.span.spanId : requestEventKey(left.span.spanId, left.event.eventId);
  const rightKey = right.kind === "start" ? right.span.spanId : requestEventKey(right.span.spanId, right.event.eventId);
  return leftKey.localeCompare(rightKey);
}

function compareNano(left: string, right: string): number {
  const a = safeNano(left);
  const b = safeNano(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function safeNano(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}
