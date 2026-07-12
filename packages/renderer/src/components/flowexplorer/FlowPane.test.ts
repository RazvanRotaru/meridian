import { describe, expect, it } from "vitest";
import { LOGIC_VIEW_MODES } from "../../derive/flowViewModel";
import { flowPanePresentation, flowPaneShouldRender } from "./FlowPane";

describe("flowPanePresentation", () => {
  it.each(LOGIC_VIEW_MODES)("uses the reader's configured $mode projection during PR review", ({ mode }) => {
    expect(flowPanePresentation(true, mode)).toBe(mode);
  });

  it.each(LOGIC_VIEW_MODES)("keeps the ordinary Code flows explorer on its execution graph when $mode is preferred", ({ mode }) => {
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
