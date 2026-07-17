import type { LogicFlows, RequestTrace } from "@meridian/core";
import { describe, expect, it } from "vitest";
import { requestSpanMomentId } from "./requestFlowAddress";
import { requestFlowProjectionIds, requestFlowProjectionPassBudget } from "./requestFlowProjection";

const ROOT = "ts:src/root.ts#root";
const A = "ts:src/a.ts#a";
const B = "ts:src/b.ts#b";

describe("requestFlowProjectionIds", () => {
  it("retains a folded parent's and hidden child's exact flow identities", () => {
    const trace = requestTrace();
    const spanRoot = `${requestSpanMomentId(trace.traceId, trace.rootSpanId)}:exec`;
    const childOccurrence = `${spanRoot}::p0/0/0`;
    const rootOnly: LogicFlows = {
      [ROOT]: [{ kind: "call", label: "a", target: A, resolution: "resolved" }],
    };
    const hydrated: LogicFlows = {
      ...rootOnly,
      [A]: [{ kind: "call", label: "b", target: B, resolution: "resolved" }],
    };

    // The parent occurrence itself is absent from the override set: it was collapsed while the
    // child's expansion preference remained. Projection identity is semantic, not layout-derived.
    const overrides = new Set([childOccurrence]);
    expect(requestFlowProjectionIds(trace, rootOnly, overrides)).toEqual([ROOT, A]);
    expect(requestFlowProjectionIds(trace, hydrated, overrides)).toEqual([ROOT, A, B]);
    expect(requestFlowProjectionPassBudget(overrides)).toBeGreaterThanOrEqual(3);
  });

  it("keeps repeated occurrences separate while deduplicating their immutable targets", () => {
    const trace = {
      ...requestTrace(),
      spans: [
        ...requestTrace().spans,
        { ...requestTrace().spans[0]!, spanId: "2".repeat(16) },
      ],
    };
    const flows: LogicFlows = {
      [ROOT]: [{ kind: "call", label: "a", target: A, resolution: "resolved" }],
    };
    const overrides = new Set(trace.spans.map((span) => (
      `${requestSpanMomentId(trace.traceId, span.spanId)}:exec::p0/0`
    )));

    expect(requestFlowProjectionIds(trace, flows, overrides)).toEqual([ROOT, A]);
  });
});

function requestTrace(): RequestTrace {
  return {
    traceId: "1".repeat(32),
    name: "projection plan",
    rootSpanId: "1".repeat(16),
    startedAtUnixNano: "1000000000",
    endedAtUnixNano: "1001000000",
    status: "ok",
    attributes: {},
    spans: [{
      spanId: "1".repeat(16),
      nodeId: ROOT,
      name: "root",
      kind: "server",
      startedAtUnixNano: "1000000000",
      endedAtUnixNano: "1001000000",
      status: "ok",
      attributes: {},
      events: [],
    }],
    completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
  };
}
