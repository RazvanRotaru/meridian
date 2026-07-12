import { describe, expect, it } from "vitest";
import type { RequestTrace } from "@meridian/core";
import { STATIC_LOGIC_VIEW_MODES } from "../../derive/flowViewModel";
import {
  flowPanePresentation,
  flowPaneShouldRender,
  requestFlowContext,
  shouldAutoFitFlowPane,
} from "./FlowPane";

describe("flowPanePresentation", () => {
  it.each(STATIC_LOGIC_VIEW_MODES)("uses the reader's configured $mode projection during PR review", ({ mode }) => {
    expect(flowPanePresentation(true, mode)).toBe(mode);
  });

  it.each(STATIC_LOGIC_VIEW_MODES)("keeps the ordinary Code flows explorer on its execution graph when $mode is preferred", ({ mode }) => {
    expect(flowPanePresentation(false, mode)).toBe("graph");
  });
});

describe("flowPaneShouldRender", () => {
  it("hides only the review split when automatic opening is disabled", () => {
    expect(flowPaneShouldRender(true, false)).toBe(false);
    expect(flowPaneShouldRender(true, true)).toBe(true);
  });

  it("keeps ordinary Code-flow panes visible regardless of the review preference", () => {
    expect(flowPaneShouldRender(false, false)).toBe(true);
    expect(flowPaneShouldRender(false, true)).toBe(true);
  });
});

describe("request flow pane context", () => {
  it("summarizes the whole selected request rather than one clicked callable", () => {
    const trace = {
      name: "POST /orders",
      status: "error",
      startedAtUnixNano: "1000000000",
      endedAtUnixNano: "1045000000",
      completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
      spans: [
        { nodeId: "run", events: [{}, {}] },
        { nodeId: "run", events: [{}] },
        { nodeId: "other", events: Array(5).fill({}) },
      ],
    } as unknown as RequestTrace;

    expect(requestFlowContext(trace, "staging")).toEqual({
      requestName: "POST /orders",
      environment: "staging",
      status: "error",
      spanCount: 3,
      eventCount: 8,
      durationMs: 45,
      complete: true,
    });
    expect(requestFlowContext(null, "staging")).toBeNull();
  });
});

describe("request flow camera fitting", () => {
  it("fits a mounted request trace only once but keeps static pane relayout fitting", () => {
    expect(shouldAutoFitFlowPane(true, false)).toBe(true);
    expect(shouldAutoFitFlowPane(true, true)).toBe(false);
    expect(shouldAutoFitFlowPane(false, false)).toBe(true);
    expect(shouldAutoFitFlowPane(false, true)).toBe(true);
  });
});
