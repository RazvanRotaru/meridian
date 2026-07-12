import { describe, expect, it } from "vitest";
import type { GraphArtifact, RequestTrace, TimelineEvent, TimelineSpan } from "@meridian/core";
import {
  branchProbePreview,
  buildRequestTimeline,
  requestEventKey,
  requestTraceCandidates,
  traceGraphRefMismatches,
} from "./requestTimelineModel";

const ROOT = "ts:src/api/orderRoutes.ts#OrderRoutes.handleCreateOrder";
const CHILD = "ts:src/services/orderService.ts#OrderService.placeOrder";

function span(overrides: Partial<TimelineSpan> & Pick<TimelineSpan, "spanId" | "startedAtUnixNano" | "endedAtUnixNano">): TimelineSpan {
  return {
    name: overrides.spanId,
    kind: "internal",
    status: "ok",
    attributes: {},
    events: [],
    ...overrides,
  };
}

function trace(overrides: Partial<RequestTrace> = {}): RequestTrace {
  return {
    traceId: "trace-1",
    name: "POST /orders",
    rootSpanId: "root",
    startedAtUnixNano: "1000000000",
    endedAtUnixNano: "1100000000",
    status: "ok",
    attributes: {},
    spans: [],
    completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
    ...overrides,
  };
}

describe("buildRequestTimeline", () => {
  it("places nested spans on one real millisecond axis", () => {
    const model = buildRequestTimeline(trace({
      spans: [
        span({ spanId: "child", parentSpanId: "root", nodeId: CHILD, startedAtUnixNano: "1020000000", endedAtUnixNano: "1060000000" }),
        span({ spanId: "root", nodeId: ROOT, startedAtUnixNano: "1000000000", endedAtUnixNano: "1100000000" }),
      ],
    }));
    expect(model.durationMs).toBe(100);
    expect(model.rows.map((row) => [row.span.spanId, row.depth])).toEqual([["root", 0], ["child", 1]]);
    expect(model.rows[1]).toMatchObject({ startMs: 20, durationMs: 40, startRatio: 0.2, widthRatio: 0.4 });
  });

  it("pins observed events to their owning span and global request clock", () => {
    const branch: TimelineEvent = {
      eventId: "event-1",
      type: "branch.taken",
      timeUnixNano: "1040000000",
      siteId: "site:discount",
      pathId: "then",
      condition: "code === WELCOME10",
      outcome: true,
      source: { file: "src/pricing.ts", line: 28 },
      attributes: {},
    };
    const model = buildRequestTimeline(trace({
      spans: [span({ spanId: "root", nodeId: ROOT, startedAtUnixNano: "1000000000", endedAtUnixNano: "1100000000", events: [branch] })],
    }));
    expect(model.events[0]).toMatchObject({ spanId: "root", nodeId: ROOT, offsetMs: 40, offsetRatio: 0.4 });
  });

  it("retains async handoffs as typed event pins", () => {
    const handoff: TimelineEvent = {
      eventId: "handoff-1",
      type: "async.handoff",
      timeUnixNano: "1030000000",
      mode: "detached",
      siteId: "site:queue",
      source: { file: "src/jobs.ts", line: 14 },
      targetSpanId: "2000000000000002",
      attributes: {},
    };
    const model = buildRequestTimeline(trace({
      spans: [span({ spanId: "1000000000000001", startedAtUnixNano: "1000000000", endedAtUnixNano: "1100000000", events: [handoff] })],
    }));
    expect(model.events[0]).toMatchObject({ spanId: "1000000000000001", event: { type: "async.handoff", mode: "detached" } });
  });

  it("retains orphaned and cyclic spans instead of silently dropping them", () => {
    const model = buildRequestTimeline(trace({
      spans: [
        span({ spanId: "a", parentSpanId: "b", startedAtUnixNano: "1000000000", endedAtUnixNano: "1010000000" }),
        span({ spanId: "b", parentSpanId: "a", startedAtUnixNano: "1000000000", endedAtUnixNano: "1010000000" }),
        span({ spanId: "orphan", parentSpanId: "missing", startedAtUnixNano: "1000000000", endedAtUnixNano: "1010000000" }),
      ],
    }));
    expect(model.rows.map((row) => row.span.spanId).sort()).toEqual(["a", "b", "orphan"]);
  });

  it("derives parentless work beneath a same-trace linked span and preserves the link relation", () => {
    const request = trace({
      traceId: "11111111111111111111111111111111",
      spans: [
        span({ spanId: "1000000000000001", startedAtUnixNano: "1000000000", endedAtUnixNano: "1100000000" }),
        span({
          spanId: "2000000000000002",
          startedAtUnixNano: "1020000000",
          endedAtUnixNano: "1060000000",
          links: [{
            traceId: "11111111111111111111111111111111",
            spanId: "1000000000000001",
            relation: "async",
            attributes: {},
          }],
        }),
      ],
    });
    const model = buildRequestTimeline(request);
    expect(model.rows.map((row) => [row.span.spanId, row.depth, row.linkedFrom])).toEqual([
      ["1000000000000001", 0, null],
      ["2000000000000002", 1, { spanId: "1000000000000001", relation: "async" }],
    ]);
  });
});

describe("requestTraceCandidates", () => {
  it("filters to traces containing the current Logic root, newest first", () => {
    const oldMatch = trace({ traceId: "old", startedAtUnixNano: "1", endedAtUnixNano: "2", spans: [span({ spanId: "a", nodeId: ROOT, startedAtUnixNano: "1", endedAtUnixNano: "2" })] });
    const newMatch = trace({ traceId: "new", startedAtUnixNano: "3", endedAtUnixNano: "4", spans: [span({ spanId: "b", nodeId: ROOT, startedAtUnixNano: "3", endedAtUnixNano: "4" })] });
    const other = trace({ traceId: "other", spans: [span({ spanId: "c", nodeId: CHILD, startedAtUnixNano: "1", endedAtUnixNano: "2" })] });
    expect(requestTraceCandidates([oldMatch, other, newMatch], ROOT)).toMatchObject({ matchesRoot: true, traces: [newMatch, oldMatch] });
  });

  it("falls back to all traces while reporting that none matched", () => {
    const other = trace({ traceId: "other", spans: [span({ spanId: "c", nodeId: CHILD, startedAtUnixNano: "1", endedAtUnixNano: "2" })] });
    expect(requestTraceCandidates([other], ROOT)).toEqual({ matchesRoot: false, traces: [other] });
  });
});

it("generates a stable branch-probe preview only for branch events", () => {
  const branch: TimelineEvent = {
    eventId: "event-1",
    type: "branch.taken",
    timeUnixNano: "1",
    siteId: "site:discount",
    pathId: "then",
    condition: "code === WELCOME10",
    outcome: true,
    source: { file: "src/pricing.ts", line: 28, col: 5 },
    attributes: {},
  };
  expect(branchProbePreview(branch, ROOT)).toContain('siteId: "site:discount"');
  expect(branchProbePreview(branch, ROOT)).toContain('source: "src/pricing.ts:28:5"');
  const data: TimelineEvent = {
    eventId: "event-2",
    type: "data.observe",
    timeUnixNano: "2",
    name: "total",
    valueId: "value-1",
    value: 42,
    attributes: {},
  };
  expect(branchProbePreview(data, ROOT)).toBeNull();
});

it("keys repeated event ids by their owning span", () => {
  expect(requestEventKey("span-a", "event-1")).not.toBe(requestEventKey("span-b", "event-1"));
  expect(requestEventKey("span-a", "event-1")).toBe(requestEventKey("span-a", "event-1"));
});

it("compares the bundle graph reference with every loaded artifact identity coordinate", () => {
  const artifact: GraphArtifact = {
    schemaVersion: "1.0.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: { name: "test", version: "0" },
    target: { name: "fixture", root: ".", language: "typescript", vcs: { commit: "abc123" } },
    nodes: [{ id: ROOT, kind: "function", qualifiedName: "run", displayName: "run", location: { file: "src/a.ts", startLine: 1 } }],
    edges: [],
  };
  expect(traceGraphRefMismatches({
    schemaVersion: "1.0.0",
    generatedAt: artifact.generatedAt,
    nodeCount: 1,
    commit: "abc123",
  }, artifact)).toEqual([]);
  expect(traceGraphRefMismatches({
    schemaVersion: "1.1.0",
    generatedAt: "older",
    nodeCount: 2,
    commit: "def456",
  }, artifact)).toHaveLength(4);
  expect(traceGraphRefMismatches(null, artifact)).toEqual(["trace bundle has no graph reference"]);
});
