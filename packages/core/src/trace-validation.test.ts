import { describe, expect, it } from "vitest";
import type { RequestTrace, TimelineEvent, TimelineSpan } from "./trace";
import {
  requestTraceSchema,
  timelineEventSchema,
  traceAttributeValueSchema,
  traceBundleSchema,
  traceIdSchema,
  unixNanoSchema,
} from "./trace";

const TRACE_ID = "11111111111111111111111111111111";
const ROOT_ID = "1000000000000001";

describe("request trace cross-field validation", () => {
  it("returns validation failures instead of throwing on malformed nested payloads", () => {
    expect(() => requestTraceSchema.safeParse({})).not.toThrow();
    expect(() => requestTraceSchema.safeParse({ ...trace(), spans: [{ ...span(), events: [{}] }] })).not.toThrow();
    expect(requestTraceSchema.safeParse({ ...trace(), spans: [{ ...span(), events: [{}] }] }).success).toBe(false);
  });

  it("rejects zero ids and nanoseconds outside uint64", () => {
    expect(traceIdSchema.safeParse("00000000000000000000000000000000").success).toBe(false);
    expect(unixNanoSchema.safeParse("18446744073709551616").success).toBe(false);
    expect(() => unixNanoSchema.safeParse("not-a-timestamp")).not.toThrow();
    expect(unixNanoSchema.safeParse("not-a-timestamp").success).toBe(false);
    expect(() => requestTraceSchema.safeParse(trace({ startedAtUnixNano: "not-a-timestamp" }))).not.toThrow();
    expect(requestTraceSchema.safeParse(trace({ startedAtUnixNano: "not-a-timestamp" })).success).toBe(false);
    expect(requestTraceSchema.safeParse(trace({ rootSpanId: "0000000000000000" })).success).toBe(false);
  });

  it("requires unique span and event ids", () => {
    const duplicateSpan = trace({ spans: [span(), span()] });
    expect(requestTraceSchema.safeParse(duplicateSpan).success).toBe(false);
    const duplicateEvent = trace({
      spans: [
        span({ events: [observed("same")] }),
        span({ spanId: "1000000000000002", parentSpanId: ROOT_ID, events: [observed("same")] }),
      ],
    });
    expect(requestTraceSchema.safeParse(duplicateEvent).success).toBe(false);
  });

  it("requires unique trace ids within a fetched bundle", () => {
    const request = trace();
    const result = traceBundleSchema.safeParse({
      traceVersion: "1.0.0",
      source: "mock",
      env: "demo",
      generatedAt: "2026-01-01T00:00:00.000Z",
      graphRef: { schemaVersion: "1.0.0", generatedAt: "2026-01-01T00:00:00.000Z", nodeCount: 1 },
      traces: [request, { ...request }],
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["traces", 1, "traceId"]);
  });

  it("requires a resolvable root and parent-acyclic span forest", () => {
    expect(requestTraceSchema.safeParse(trace({ rootSpanId: "1000000000000009" })).success).toBe(false);
    expect(requestTraceSchema.safeParse(trace({ spans: [span({ parentSpanId: "1000000000000009" })] })).success).toBe(false);
    const cycle = trace({
      spans: [
        span({ parentSpanId: "1000000000000002" }),
        span({ spanId: "1000000000000002", parentSpanId: ROOT_ID }),
      ],
    });
    expect(requestTraceSchema.safeParse(cycle).success).toBe(false);
  });

  it("enforces trace, span, and event time ordering and bounds", () => {
    expect(requestTraceSchema.safeParse(trace({ startedAtUnixNano: "201" })).success).toBe(false);
    expect(requestTraceSchema.safeParse(trace({ spans: [span({ endedAtUnixNano: "99" })] })).success).toBe(false);
    expect(requestTraceSchema.safeParse(trace({ spans: [span({ startedAtUnixNano: "99" })] })).success).toBe(false);
    expect(requestTraceSchema.safeParse(trace({ spans: [span({ events: [observed("late", "201")] })] })).success).toBe(false);
  });

  it("bounds loop summaries and completeness claims", () => {
    const loop: TimelineEvent = {
      type: "loop.summary",
      eventId: "loop-1",
      timeUnixNano: "150",
      attributes: {},
      siteId: "site:loop",
      label: "for items",
      iterations: 1,
      emittedIterations: 2,
      truncated: false,
      source: { file: "src/a.ts", line: 1 },
    };
    expect(requestTraceSchema.safeParse(trace({ spans: [span({ events: [loop] })] })).success).toBe(false);
    expect(requestTraceSchema.safeParse(trace({ completeness: { complete: true, droppedSpans: 1, droppedEvents: 0, droppedValues: 0 } })).success).toBe(false);
  });

  it("caps spans, total events, strings, and attribute arrays", () => {
    const spans = Array.from({ length: 2_001 }, (_, index) => span({
      spanId: index === 0 ? ROOT_ID : (index + 1).toString(16).padStart(16, "0"),
      ...(index === 0 ? {} : { parentSpanId: ROOT_ID }),
    }));
    expect(requestTraceSchema.safeParse(trace({ spans })).success).toBe(false);
    const events = Array.from({ length: 2_001 }, (_, index) => observed(`event-${index}`));
    expect(requestTraceSchema.safeParse(trace({
      spans: [span({ events: events.slice(0, 1_001) }), span({ spanId: "1000000000000002", parentSpanId: ROOT_ID, events: events.slice(1_001) })],
    })).success).toBe(false);
    expect(traceAttributeValueSchema.safeParse("x".repeat(4_097)).success).toBe(false);
    expect(traceAttributeValueSchema.safeParse(Array.from({ length: 129 }, () => true)).success).toBe(false);
  });

  it("rejects a zero async handoff target", () => {
    expect(timelineEventSchema.safeParse({
      type: "async.handoff",
      eventId: "handoff",
      timeUnixNano: "150",
      attributes: {},
      mode: "awaited",
      siteId: "site:call",
      source: { file: "src/a.ts", line: 1 },
      targetSpanId: "0000000000000000",
    }).success).toBe(false);
  });
});

function trace(overrides: Partial<RequestTrace> = {}): RequestTrace {
  return {
    traceId: TRACE_ID,
    name: "GET /run",
    rootSpanId: ROOT_ID,
    startedAtUnixNano: "100",
    endedAtUnixNano: "200",
    status: "ok",
    attributes: {},
    spans: [span()],
    completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
    ...overrides,
  };
}

function span(overrides: Partial<TimelineSpan> = {}): TimelineSpan {
  return {
    spanId: ROOT_ID,
    name: "run",
    kind: "server",
    startedAtUnixNano: "100",
    endedAtUnixNano: "200",
    status: "ok",
    attributes: {},
    events: [],
    ...overrides,
  };
}

function observed(eventId: string, timeUnixNano = "150"): TimelineEvent {
  return { type: "data.observe", eventId, timeUnixNano, attributes: {}, name: "value", valueId: eventId, value: true };
}
