import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRAPH_RATIOS,
  FLOW_SPLIT_EDGE_SNAP_PX,
  FLOW_SPLIT_HANDLE_PX,
  FlowSplitView,
  splitRatioForKey,
  splitRatioFromPointer,
  updateGraphRatio,
} from "./FlowSplitView";

describe("FlowSplitView", () => {
  it("keeps ordinary, review, and synthetic proportions as separate defaults", () => {
    const standard = renderSplit(false);
    const review = renderSplit(true);
    const synthetic = renderToStaticMarkup(
      <FlowSplitView open review={false} synthetic graph={<span>graph surface</span>} flow={<span>flow surface</span>} />,
    );

    expect(standard).toContain(`aria-valuenow="${DEFAULT_GRAPH_RATIOS.standard * 100}"`);
    expect(standard).toContain("Graph 60%; logic flow 40%");
    expect(review).toContain(`aria-valuenow="${DEFAULT_GRAPH_RATIOS.review * 100}"`);
    expect(review).toContain("Graph 70%; logic flow 30%");
    expect(synthetic).toContain(`aria-valuenow="${DEFAULT_GRAPH_RATIOS.synthetic * 100}"`);
    expect(synthetic).toContain("Graph 44%; logic flow 56%");
  });

  it("renders a focusable horizontal separator with resize and minimize instructions", () => {
    const markup = renderSplit(false);

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-label="Resize graph and logic flow"');
    expect(markup).toContain('aria-orientation="horizontal"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="100"');
    expect(markup).toContain('aria-keyshortcuts="ArrowUp ArrowDown Home End Enter"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("Move to an edge to minimize a pane");
  });

  it("removes the separator and flow surface when the flow pane is closed", () => {
    const markup = renderToStaticMarkup(
      <FlowSplitView open={false} review={false} graph={<span>graph surface</span>} flow={<span>flow surface</span>} />,
    );

    expect(markup).toContain("graph surface");
    expect(markup).not.toContain("flow surface");
    expect(markup).not.toContain('role="separator"');
  });
});

describe("flow split pointer geometry", () => {
  const containerTop = 125;
  const containerHeight = 800;
  const grabOffset = FLOW_SPLIT_HANDLE_PX / 2;
  const availableHeight = containerHeight - FLOW_SPLIT_HANDLE_PX;

  it("uses the split container's viewport offset and preserves the handle grab point", () => {
    const clientY = containerTop + grabOffset + availableHeight * 0.4;

    expect(splitRatioFromPointer({ clientY, containerTop, containerHeight, grabOffset })).toBeCloseTo(0.4);
  });

  it("snaps the graph shut near the top and the flow shut near the bottom", () => {
    const nearTop = containerTop + grabOffset + FLOW_SPLIT_EDGE_SNAP_PX - 1;
    const nearBottom = containerTop + grabOffset + availableHeight - FLOW_SPLIT_EDGE_SNAP_PX + 1;

    expect(splitRatioFromPointer({ clientY: nearTop, containerTop, containerHeight, grabOffset })).toBe(0);
    expect(splitRatioFromPointer({ clientY: nearBottom, containerTop, containerHeight, grabOffset })).toBe(1);
  });

  it("clamps pointer positions beyond either container edge", () => {
    expect(splitRatioFromPointer({ clientY: -500, containerTop, containerHeight, grabOffset })).toBe(0);
    expect(splitRatioFromPointer({ clientY: 5_000, containerTop, containerHeight, grabOffset })).toBe(1);
  });

  it("scales the snap zone down in a short container without swallowing the middle", () => {
    const shortHeight = 110;
    const shortAvailable = shortHeight - FLOW_SPLIT_HANDLE_PX;
    const middle = containerTop + grabOffset + shortAvailable / 2;
    const justInsideTop = containerTop + grabOffset + shortAvailable / 4 + 1;
    const justInsideBottom = containerTop + grabOffset + shortAvailable * 3 / 4 - 1;

    expect(splitRatioFromPointer({ clientY: middle, containerTop, containerHeight: shortHeight, grabOffset })).toBeCloseTo(0.5);
    expect(splitRatioFromPointer({ clientY: justInsideTop, containerTop, containerHeight: shortHeight, grabOffset })).toBeCloseTo(0.26);
    expect(splitRatioFromPointer({ clientY: justInsideBottom, containerTop, containerHeight: shortHeight, grabOffset })).toBeCloseTo(0.74);
  });

  it("has a safe fallback when the handle consumes the entire container", () => {
    expect(splitRatioFromPointer({
      clientY: containerTop,
      containerTop,
      containerHeight: FLOW_SPLIT_HANDLE_PX,
      grabOffset: 0,
    })).toBe(0.5);
  });
});

describe("flow split keyboard controls", () => {
  it("moves by small or accelerated steps and clamps at both ends", () => {
    expect(splitRatioForKey(0.6, "ArrowUp", false, 0.6)).toBeCloseTo(0.55);
    expect(splitRatioForKey(0.6, "ArrowDown", false, 0.6)).toBeCloseTo(0.65);
    expect(splitRatioForKey(0.6, "ArrowUp", true, 0.6)).toBeCloseTo(0.45);
    expect(splitRatioForKey(0.98, "ArrowDown", false, 0.6)).toBe(1);
    expect(splitRatioForKey(0.02, "ArrowUp", false, 0.6)).toBe(0);
  });

  it("minimizes either pane, resets the split, and ignores unrelated keys", () => {
    expect(splitRatioForKey(0.6, "Home", false, 0.6)).toBe(0);
    expect(splitRatioForKey(0.6, "End", false, 0.6)).toBe(1);
    expect(splitRatioForKey(0, "Enter", false, 0.6)).toBe(0.6);
    expect(splitRatioForKey(0.6, "Escape", false, 0.6)).toBeNull();
  });
});

describe("flow split mode memory", () => {
  it("keeps ordinary, review, and synthetic positions independent", () => {
    const standardMoved = updateGraphRatio({ ...DEFAULT_GRAPH_RATIOS }, "standard", 0.42);
    const reviewMoved = updateGraphRatio(standardMoved, "review", 0.81);

    expect(standardMoved).toEqual({ standard: 0.42, review: 0.7, synthetic: 0.44 });
    expect(reviewMoved).toEqual({ standard: 0.42, review: 0.81, synthetic: 0.44 });
  });
});

function renderSplit(review: boolean): string {
  return renderToStaticMarkup(
    <FlowSplitView open review={review} graph={<span>graph surface</span>} flow={<span>flow surface</span>} />,
  );
}
