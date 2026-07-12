import { describe, expect, it } from "vitest";
import { LOGIC_VIEW_MODES } from "../../derive/flowViewModel";
import { flowPanePresentation } from "./FlowPane";

describe("flowPanePresentation", () => {
  it.each(LOGIC_VIEW_MODES)("uses the reader's configured $mode projection during PR review", ({ mode }) => {
    expect(flowPanePresentation(true, mode)).toBe(mode);
  });

  it.each(LOGIC_VIEW_MODES)("keeps the ordinary Code flows explorer on its execution graph when $mode is preferred", ({ mode }) => {
    expect(flowPanePresentation(false, mode)).toBe("graph");
  });
});
