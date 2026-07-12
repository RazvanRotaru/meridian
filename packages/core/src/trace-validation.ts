/** Cross-span invariants that cannot be expressed by the request trace's structural zod shape. */

import type { RequestTrace } from "./trace";

export const MAX_EVENTS_PER_TRACE = 2_000;

interface IssueSink {
  addIssue(issue: { code: "custom"; message: string; path: Array<string | number> }): void;
}

export function validateRequestTrace(trace: RequestTrace, ctx: IssueSink): void {
  const traceStart = nanoOrNull(trace.startedAtUnixNano);
  const traceEnd = nanoOrNull(trace.endedAtUnixNano);
  if (traceStart !== null && traceEnd !== null && traceStart > traceEnd) {
    issue(ctx, ["endedAtUnixNano"], "trace end must not precede trace start");
  }
  if (trace.completeness.complete && hasDrops(trace)) {
    issue(ctx, ["completeness", "complete"], "a complete trace cannot report dropped data");
  }

  const spanById = new Map<string, { span: RequestTrace["spans"][number]; index: number }>();
  const eventIds = new Set<string>();
  let eventCount = 0;
  for (const [spanIndex, span] of trace.spans.entries()) {
    if (spanById.has(span.spanId)) issue(ctx, ["spans", spanIndex, "spanId"], "span ids must be unique within a trace");
    else spanById.set(span.spanId, { span, index: spanIndex });
    const spanStart = nanoOrNull(span.startedAtUnixNano);
    const spanEnd = nanoOrNull(span.endedAtUnixNano);
    validateSpanTimes(traceStart, traceEnd, spanStart, spanEnd, spanIndex, ctx);
    for (const [eventIndex, event] of span.events.entries()) {
      eventCount += 1;
      if (eventIds.has(event.eventId)) {
        issue(ctx, ["spans", spanIndex, "events", eventIndex, "eventId"], "event ids must be unique within a trace");
      } else {
        eventIds.add(event.eventId);
      }
      const eventTime = nanoOrNull(event.timeUnixNano);
      if (eventTime !== null && spanStart !== null && spanEnd !== null && (eventTime < spanStart || eventTime > spanEnd)) {
        issue(ctx, ["spans", spanIndex, "events", eventIndex, "timeUnixNano"], "event time must fall within its span");
      }
      if (event.type === "loop.summary" && event.emittedIterations > event.iterations) {
        issue(ctx, ["spans", spanIndex, "events", eventIndex, "emittedIterations"], "emitted iterations cannot exceed total iterations");
      }
    }
  }
  if (eventCount > MAX_EVENTS_PER_TRACE) issue(ctx, ["spans"], `a trace may contain at most ${MAX_EVENTS_PER_TRACE} events`);
  if (!spanById.has(trace.rootSpanId)) issue(ctx, ["rootSpanId"], "root span id must resolve within the trace");

  for (const { span, index } of spanById.values()) {
    if (span.parentSpanId && !spanById.has(span.parentSpanId)) {
      issue(ctx, ["spans", index, "parentSpanId"], "parent span id must resolve within the trace");
    }
  }
  validateParentAcyclicity(spanById, ctx);
}

function validateSpanTimes(
  traceStart: bigint | null,
  traceEnd: bigint | null,
  start: bigint | null,
  end: bigint | null,
  spanIndex: number,
  ctx: IssueSink,
): void {
  if (start !== null && end !== null && start > end) {
    issue(ctx, ["spans", spanIndex, "endedAtUnixNano"], "span end must not precede span start");
  }
  if (start !== null && end !== null && traceStart !== null && traceEnd !== null && (start < traceStart || end > traceEnd)) {
    issue(ctx, ["spans", spanIndex], "span time must fall within its request trace");
  }
}

function validateParentAcyclicity(
  spanById: Map<string, { span: RequestTrace["spans"][number]; index: number }>,
  ctx: IssueSink,
): void {
  const state = new Map<string, "visiting" | "visited">();
  let reported = false;
  const visit = (id: string): void => {
    if (state.get(id) === "visited" || reported) return;
    if (state.get(id) === "visiting") {
      issue(ctx, ["spans", spanById.get(id)?.index ?? 0, "parentSpanId"], "span parent references must be acyclic");
      reported = true;
      return;
    }
    state.set(id, "visiting");
    const parentId = spanById.get(id)?.span.parentSpanId;
    if (parentId && spanById.has(parentId)) visit(parentId);
    state.set(id, "visited");
  };
  for (const id of spanById.keys()) visit(id);
}

function hasDrops(trace: RequestTrace): boolean {
  const drops = trace.completeness;
  return drops.droppedSpans > 0 || drops.droppedEvents > 0 || drops.droppedValues > 0;
}

function issue(ctx: IssueSink, path: Array<string | number>, message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

function nanoOrNull(value: unknown): bigint | null {
  return typeof value === "string" && value.length <= 20 && /^\d+$/.test(value) ? BigInt(value) : null;
}
