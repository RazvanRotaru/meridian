/**
 * Pure model for one captured request timeline. Unlike `timelineModel` (which assigns pseudo-time to
 * every statically possible FlowStep), this model preserves the one execution represented by the bundle:
 * all rows share the request's real nanosecond clock, parent/child spans become an indented waterfall,
 * and branch/data/loop/async/exception events stay pinned to their owning span at their captured instant.
 */

import type {
  GraphArtifact,
  JsonValue,
  RequestTrace,
  TimelineEvent,
  TimelineSpan,
  TimelineSpanLink,
  TraceGraphRef,
} from "@meridian/core";

export interface RequestTimelineEvent {
  event: TimelineEvent;
  spanId: string;
  nodeId: string | null;
  offsetMs: number;
  offsetRatio: number;
}

export interface RequestTimelineRow {
  span: TimelineSpan;
  depth: number;
  /** Present when this otherwise-root span is nested beneath a same-trace span link rather than a
   * parentSpanId. The UI paints this edge as inferred async causality, never as a call parent. */
  linkedFrom: { spanId: string; relation: TimelineSpanLink["relation"] } | null;
  startMs: number;
  durationMs: number;
  startRatio: number;
  widthRatio: number;
  events: RequestTimelineEvent[];
}

export interface RequestTimelineModel {
  trace: RequestTrace;
  startedAtUnixNano: string;
  endedAtUnixNano: string;
  durationMs: number;
  rows: RequestTimelineRow[];
  events: RequestTimelineEvent[];
}

export interface TraceCandidates {
  traces: RequestTrace[];
  /** False means no loaded trace contains the current callable; `traces` then contains the fallback
   * full request list so the selector remains useful while the UI states that mismatch explicitly. */
  matchesRoot: boolean;
}

/** Bundle validation guarantees trace-wide event-id uniqueness. Keep the owning span in UI/state
 * identity anyway: it makes the event's hierarchy explicit and avoids a breaking key migration if
 * a future transport scopes producer ids per span. */
export function requestEventKey(spanId: string, eventId: string): string {
  return `${spanId}\u0000${eventId}`;
}

/** Build the immutable graph identity used to join telemetry with a complete revision. */
export function traceGraphRevisionIdentity(
  summary: Pick<TraceGraphRef, "schemaVersion" | "generatedAt" | "nodeCount">,
  target: GraphArtifact["target"],
): TraceGraphRef {
  const commit = target.vcs?.commit;
  return {
    schemaVersion: summary.schemaVersion,
    generatedAt: summary.generatedAt,
    nodeCount: summary.nodeCount,
    ...(commit === undefined ? {} : { commit }),
  };
}

/** Compare telemetry provenance with the immutable identity of the complete graph revision.
 * `revision` must come from projection-manifest metadata; a bounded projection's node array is
 * intentionally incomplete and therefore cannot establish revision identity. */
export function traceGraphRefMismatches(ref: TraceGraphRef | null, revision: TraceGraphRef): string[] {
  if (ref === null) return ["trace bundle has no graph reference"];
  const mismatches: string[] = [];
  if (ref.schemaVersion !== revision.schemaVersion) {
    mismatches.push(`schema ${ref.schemaVersion} ≠ ${revision.schemaVersion}`);
  }
  if (ref.generatedAt !== revision.generatedAt) {
    mismatches.push(`generatedAt ${ref.generatedAt} ≠ ${revision.generatedAt}`);
  }
  if (ref.nodeCount !== revision.nodeCount) {
    mismatches.push(`node count ${ref.nodeCount} ≠ ${revision.nodeCount}`);
  }
  if (ref.commit !== undefined && ref.commit !== revision.commit) {
    mismatches.push(`commit ${ref.commit} ≠ ${revision.commit ?? "unavailable"}`);
  }
  return mismatches;
}

/** Prefer requests that actually crossed the callable currently open in Logic. If none did, return
 * the whole bundle (newest first) rather than presenting an unrelated blank selector. */
export function requestTraceCandidates(traces: readonly RequestTrace[], rootId: string): TraceCandidates {
  const sorted = [...traces].sort(compareTraceNewestFirst);
  const matches = sorted.filter((trace) => trace.spans.some((span) => span.nodeId === rootId));
  return { traces: matches.length > 0 ? matches : sorted, matchesRoot: matches.length > 0 };
}

/** Flatten one trace into stable display rows. Orphaned/cyclic spans are retained as roots so malformed
 * producer data cannot make observed work disappear from the investigation. */
export function buildRequestTimeline(trace: RequestTrace): RequestTimelineModel {
  const declaredStart = nano(trace.startedAtUnixNano);
  const declaredEnd = nano(trace.endedAtUnixNano);
  const observedStarts = trace.spans.map((span) => nano(span.startedAtUnixNano));
  const observedEnds = trace.spans.map((span) => nano(span.endedAtUnixNano));
  const start = minNano([declaredStart, ...observedStarts]);
  const end = maxNano([declaredEnd, ...observedEnds]);
  const safeEnd = end > start ? end : start + 1n;
  const totalNano = safeEnd - start;

  const spansById = new Map(trace.spans.map((span) => [span.spanId, span]));
  const children = new Map<string, TimelineSpan[]>();
  const effectiveParent = new Map<string, string>();
  const linkedFrom = new Map<string, { spanId: string; relation: TimelineSpanLink["relation"] }>();
  const roots: TimelineSpan[] = [];

  // Establish real call parents first. Link parents are only a fallback for spans whose producer
  // explicitly omitted parentSpanId; a dangling/wrong call parent must remain visibly malformed.
  for (const span of trace.spans) {
    const parent = span.parentSpanId;
    if (parent && parent !== span.spanId && spansById.has(parent)) {
      effectiveParent.set(span.spanId, parent);
    }
  }
  for (const span of trace.spans) {
    if (span.parentSpanId !== undefined || effectiveParent.has(span.spanId)) continue;
    const link = span.links?.find((candidate) => (
      candidate.traceId === trace.traceId
      && candidate.spanId !== span.spanId
      && spansById.has(candidate.spanId)
    ));
    if (!link || wouldCreateParentCycle(span.spanId, link.spanId, effectiveParent)) continue;
    effectiveParent.set(span.spanId, link.spanId);
    linkedFrom.set(span.spanId, { spanId: link.spanId, relation: link.relation });
  }
  for (const span of trace.spans) {
    const parent = effectiveParent.get(span.spanId);
    if (parent === undefined) {
      roots.push(span);
      continue;
    }
    const list = children.get(parent) ?? [];
    list.push(span);
    children.set(parent, list);
  }
  roots.sort(compareSpanStart);
  for (const list of children.values()) list.sort(compareSpanStart);

  const rows: RequestTimelineRow[] = [];
  const events: RequestTimelineEvent[] = [];
  const visited = new Set<string>();
  const append = (span: TimelineSpan, depth: number): void => {
    if (visited.has(span.spanId)) return;
    visited.add(span.spanId);
    const spanStart = nano(span.startedAtUnixNano);
    const spanEnd = nano(span.endedAtUnixNano);
    const boundedStart = clampNano(spanStart, start, safeEnd);
    const boundedEnd = clampNano(spanEnd, boundedStart, safeEnd);
    const durationNano = boundedEnd > boundedStart ? boundedEnd - boundedStart : 1n;
    const rowEvents = [...span.events]
      .sort(compareEventTime)
      .map((event): RequestTimelineEvent => {
        const eventNano = clampNano(nano(event.timeUnixNano), start, safeEnd);
        return {
          event,
          spanId: span.spanId,
          nodeId: span.nodeId ?? null,
          offsetMs: nanoToMs(eventNano - start),
          offsetRatio: ratio(eventNano - start, totalNano),
        };
      });
    rows.push({
      span,
      depth,
      linkedFrom: linkedFrom.get(span.spanId) ?? null,
      startMs: nanoToMs(boundedStart - start),
      durationMs: nanoToMs(durationNano),
      startRatio: ratio(boundedStart - start, totalNano),
      widthRatio: Math.max(ratio(durationNano, totalNano), 0.002),
      events: rowEvents,
    });
    events.push(...rowEvents);
    for (const child of children.get(span.spanId) ?? []) append(child, depth + 1);
  };

  for (const root of roots) append(root, 0);
  // A pure parent cycle has no root. Keep every unvisited span visible at top level, then let the
  // visited guard stop the cycle when its child chain comes back around.
  for (const span of [...trace.spans].sort(compareSpanStart)) append(span, 0);

  return {
    trace,
    startedAtUnixNano: start.toString(),
    endedAtUnixNano: safeEnd.toString(),
    durationMs: nanoToMs(totalNano),
    rows,
    events: events.sort((left, right) => compareEventTime(left.event, right.event)),
  };
}

/** A graph-generated branch probe preview. It deliberately uses only contract data — stable site/node
 * ids and the observed source condition — so the preview is deterministic and never guesses a path. */
export function branchProbePreview(event: TimelineEvent, nodeId: string | null): string | null {
  if (event.type !== "branch.taken") return null;
  const fields = [
    `siteId: ${literal(event.siteId)}`,
    ...(nodeId ? [`nodeId: ${literal(nodeId)}`] : []),
    `pathId: ${literal(event.pathId)}`,
    `condition: ${literal(event.condition)}`,
    ...("valueName" in event && typeof event.valueName === "string" && event.valueName.length > 0
      ? [`valueName: ${literal(event.valueName)}`]
      : []),
    `source: ${literal(`${event.source.file}:${event.source.line}${event.source.col === undefined ? "" : `:${event.source.col}`}`)}`,
  ];
  return `observeBranch({\n  ${fields.join(",\n  ")}\n});`;
}

/** Stable, compact rendering for attribute/value detail; protects the panel from circular/non-JSON
 * surprises even though a validated TraceBundle normally contains JsonValue only. */
export function displayJson(value: JsonValue | undefined): string {
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compareTraceNewestFirst(left: RequestTrace, right: RequestTrace): number {
  const a = nano(left.startedAtUnixNano);
  const b = nano(right.startedAtUnixNano);
  return a === b ? left.traceId.localeCompare(right.traceId) : a > b ? -1 : 1;
}

function compareSpanStart(left: TimelineSpan, right: TimelineSpan): number {
  const a = nano(left.startedAtUnixNano);
  const b = nano(right.startedAtUnixNano);
  return a === b ? left.spanId.localeCompare(right.spanId) : a < b ? -1 : 1;
}

function compareEventTime(left: TimelineEvent, right: TimelineEvent): number {
  const a = nano(left.timeUnixNano);
  const b = nano(right.timeUnixNano);
  return a === b ? left.eventId.localeCompare(right.eventId) : a < b ? -1 : 1;
}

function wouldCreateParentCycle(childId: string, candidateParentId: string, parents: ReadonlyMap<string, string>): boolean {
  let cursor: string | undefined = candidateParentId;
  const seen = new Set<string>();
  while (cursor !== undefined && !seen.has(cursor)) {
    if (cursor === childId) return true;
    seen.add(cursor);
    cursor = parents.get(cursor);
  }
  return false;
}

function nano(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function minNano(values: bigint[]): bigint {
  return values.reduce((best, value) => value < best ? value : best, values[0] ?? 0n);
}

function maxNano(values: bigint[]): bigint {
  return values.reduce((best, value) => value > best ? value : best, values[0] ?? 0n);
}

function clampNano(value: bigint, low: bigint, high: bigint): bigint {
  return value < low ? low : value > high ? high : value;
}

function nanoToMs(value: bigint): number {
  return Number(value) / 1_000_000;
}

function ratio(value: bigint, total: bigint): number {
  return total <= 0n ? 0 : Number(value * 1_000_000n / total) / 1_000_000;
}

function literal(value: string): string {
  return JSON.stringify(value);
}
