import { describe, expect, it } from "vitest";
import type { SyntheticExecution, TimelineSpan } from "@meridian/core";
import { ALPHA_RUN, freshStore } from "../parity/surfaceFixture";
import {
  adjacentSyntheticOccurrence,
  defaultSyntheticMomentId,
  selectedSyntheticOccurrenceIndex,
  syntheticOccurrenceSteps,
} from "./syntheticFlowModel";

const TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROOT_SPAN = "0000000000000001";
const CHILD_SPAN = "0000000000000002";
const REPEATED_SPAN = "0000000000000003";

describe("synthetic flow player model", () => {
  it("orders captured occurrences, preserves repeats, and derives parent breadcrumbs", () => {
    const execution = syntheticExecution();
    const index = freshStore().getState().index;
    const steps = syntheticOccurrenceSteps(execution, index);

    expect(steps.map((step) => step.spanId)).toEqual([ROOT_SPAN, CHILD_SPAN, REPEATED_SPAN]);
    expect(steps[1]).toMatchObject({
      nodeId: ALPHA_RUN,
      callerBreadcrumb: [steps[0]!.label],
      durationMs: 0.000002,
      snapshot: { spanId: CHILD_SPAN, input: { value: 2 }, output: 4 },
    });
    expect(steps[2]?.nodeId).toBe(ALPHA_RUN);
    expect(steps[2]?.id).not.toBe(steps[1]?.id);
  });

  it("uses the declared root by default and keeps previous/next bounded", () => {
    const execution = syntheticExecution();
    const steps = syntheticOccurrenceSteps(execution, freshStore().getState().index);
    const rootId = defaultSyntheticMomentId(execution.trace);

    expect(rootId).toBe(steps[0]?.id);
    expect(selectedSyntheticOccurrenceIndex(steps, "stale")).toBe(0);
    expect(adjacentSyntheticOccurrence(steps, steps[0]!.id, -1)).toBeNull();
    expect(adjacentSyntheticOccurrence(steps, steps[0]!.id, 1)?.id).toBe(steps[1]?.id);
    expect(adjacentSyntheticOccurrence(steps, steps.at(-1)!.id, 1)).toBeNull();
  });
});

function syntheticExecution(): SyntheticExecution {
  const spans: TimelineSpan[] = [
    span(ROOT_SPAN, undefined, "3", "9", "root"),
    // Deliberately reverse producer array order; capture order is timestamp + span id.
    span(REPEATED_SPAN, CHILD_SPAN, "6", "8", "repeat"),
    span(CHILD_SPAN, ROOT_SPAN, "4", "6", "child"),
  ];
  return {
    executionVersion: "1.0.0",
    outcome: "completed",
    scenarioId: "demo",
    rootId: ALPHA_RUN,
    generatedAt: "2026-07-13T00:00:00.000Z",
    input: { value: 1 },
    trace: {
      traceId: TRACE_ID,
      name: "Synthetic demo",
      rootSpanId: ROOT_SPAN,
      startedAtUnixNano: "3",
      endedAtUnixNano: "9",
      status: "ok",
      attributes: {},
      spans,
      completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
    },
    snapshots: [
      { spanId: CHILD_SPAN, nodeId: ALPHA_RUN, occurrenceKey: "alpha:1", input: { value: 2 }, output: 4 },
      // Mismatched snapshots are never attached to an occurrence.
      { spanId: REPEATED_SPAN, nodeId: "ts:src/missing.ts#missing", occurrenceKey: "missing:1", input: null },
    ],
    inputOverrideResults: [],
    watchHits: [],
    warnings: [],
  };
}

function span(
  spanId: string,
  parentSpanId: string | undefined,
  startedAtUnixNano: string,
  endedAtUnixNano: string,
  name: string,
): TimelineSpan {
  return {
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    nodeId: ALPHA_RUN,
    name,
    kind: "internal",
    startedAtUnixNano,
    endedAtUnixNano,
    status: "ok",
    attributes: {},
    events: [],
  };
}
