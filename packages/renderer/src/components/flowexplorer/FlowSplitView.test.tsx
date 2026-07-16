import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  constrainSplitRatio,
  DEFAULT_GRAPH_RATIOS,
  FLOW_SPLIT_EDGE_SNAP_PX,
  FLOW_SPLIT_HANDLE_PX,
  FlowSplitView,
  ResizableSplitView,
  splitRatioForSecondarySize,
  splitRatioForKey,
  splitRatioFromAxisPointer,
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

  it("reuses the splitter as an accessible left/right PR-review layout", () => {
    const markup = renderToStaticMarkup(
      <ResizableSplitView
        open
        orientation="vertical"
        primary={<span>review graph</span>}
        secondary={<span>review sidebar</span>}
        primaryRatio={0.7}
        defaultPrimaryRatio={0.7}
        onPrimaryRatioChange={() => {}}
        primaryPaneId="review-graph-pane"
        secondaryPaneId="review-sidebar-pane"
        primaryLabel="Graph"
        secondaryLabel="PR review"
        separatorLabel="Resize graph and PR review"
      />,
    );

    expect(markup).toContain('data-resizable-split="vertical"');
    expect(markup).toContain('aria-label="Resize graph and PR review"');
    expect(markup).toContain('aria-controls="review-graph-pane review-sidebar-pane"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain('aria-keyshortcuts="ArrowLeft ArrowRight Home End Enter"');
    expect(markup).toContain("Graph 70%; PR review 30%");
    expect(markup).toContain("flex-direction:row");
    expect(markup).toContain("cursor:col-resize");
  });

  it("keeps a fixed reopen rail mounted without leaving an active separator", () => {
    const markup = renderToStaticMarkup(
      <ResizableSplitView
        open={false}
        orientation="vertical"
        primary={<span>review graph</span>}
        secondary={<button>PR review rail</button>}
        primaryRatio={0.7}
        defaultPrimaryRatio={0.7}
        onPrimaryRatioChange={() => {}}
        primaryPaneId="review-graph-pane"
        secondaryPaneId="review-sidebar-pane"
        primaryLabel="Graph"
        secondaryLabel="PR review"
        separatorLabel="Resize graph and PR review"
        keepSecondaryWhenClosed
        closedSecondarySize={30}
      />,
    );

    expect(markup).toContain("review graph");
    expect(markup).toContain("PR review rail");
    expect(markup).toContain("flex:0 0 30px");
    expect(markup).not.toContain('role="separator"');
  });

  it("keeps an unavailable pane mounted but removes it and its orphan separator from layout", () => {
    const markup = renderToStaticMarkup(
      <ResizableSplitView
        open
        orientation="horizontal"
        primary={<button>optional section state</button>}
        secondary={<span>remaining workspace</span>}
        primaryRatio={0.3}
        defaultPrimaryRatio={0.3}
        onPrimaryRatioChange={() => {}}
        primaryPaneId="optional-pane"
        secondaryPaneId="remaining-pane"
        primaryLabel="Optional section"
        secondaryLabel="remaining workspace"
        separatorLabel="Resize optional section and remaining workspace"
        primaryVisible={false}
      />,
    );

    expect(markup).toContain("optional section state");
    expect(markup).toContain("remaining workspace");
    expect(markup).toMatch(/id="optional-pane"[^>]*display:none[^>]*aria-hidden="true"[^>]*inert/);
    expect(markup).toContain('id="remaining-pane"');
    expect(markup).not.toContain('role="separator"');
  });

  it("does the same for an unavailable secondary pane and lets the primary fill the workspace", () => {
    const markup = renderToStaticMarkup(
      <ResizableSplitView
        open
        orientation="horizontal"
        primary={<span>available section</span>}
        secondary={<button>secondary section state</button>}
        primaryRatio={0.3}
        defaultPrimaryRatio={0.3}
        onPrimaryRatioChange={() => {}}
        primaryPaneId="available-pane"
        secondaryPaneId="secondary-pane"
        primaryLabel="Available section"
        secondaryLabel="secondary section"
        separatorLabel="Resize available and secondary sections"
        secondaryVisible={false}
      />,
    );

    expect(markup).toContain("available section");
    expect(markup).toContain("secondary section state");
    expect(markup).toMatch(/id="available-pane"[^>]*flex:1 1 0px/);
    expect(markup).toMatch(/id="secondary-pane"[^>]*display:none[^>]*aria-hidden="true"[^>]*inert/);
    expect(markup).not.toContain('role="separator"');
  });

  it("preserves the controlled split while closing to a rail and reopening", () => {
    const resizedRatio = 0.64;
    const closed = renderReviewSplit({
      open: false,
      primaryRatio: resizedRatio,
      keepSecondaryWhenClosed: true,
      closedSecondarySize: 30,
      defaultSecondarySize: 380,
      initializeDefaultSecondarySize: false,
    });
    const reopened = renderReviewSplit({
      open: true,
      primaryRatio: resizedRatio,
      defaultSecondarySize: 380,
      initializeDefaultSecondarySize: false,
      minimumPrimarySize: 320,
      minimumSecondarySize: 300,
    });

    expect(closed).toContain("review graph");
    expect(closed).toContain("PR review rail");
    expect(closed).toContain("flex:0 0 30px");
    expect(closed).not.toContain('role="separator"');
    expect(reopened).toContain('aria-valuenow="64"');
    expect(reopened).toContain("Graph 64%; PR review 36%");
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

  it("uses the identical grab-offset and ratio math on the horizontal screen axis", () => {
    const containerLeft = 220;
    const containerWidth = 1_000;
    const availableWidth = containerWidth - FLOW_SPLIT_HANDLE_PX;
    const grabOffsetX = 3;
    const clientX = containerLeft + grabOffsetX + availableWidth * 0.4;

    expect(splitRatioFromAxisPointer({
      clientPosition: clientX,
      containerStart: containerLeft,
      containerSize: containerWidth,
      grabOffset: grabOffsetX,
    })).toBeCloseTo(0.4);
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

  it("uses Left and Right for a vertical separator", () => {
    expect(splitRatioForKey(0.7, "ArrowLeft", false, 0.7, "vertical")).toBeCloseTo(0.65);
    expect(splitRatioForKey(0.7, "ArrowRight", false, 0.7, "vertical")).toBeCloseTo(0.75);
    expect(splitRatioForKey(0.7, "ArrowUp", false, 0.7, "vertical")).toBeNull();
    expect(splitRatioForKey(0.7, "Enter", false, 0.62, "vertical")).toBe(0.62);
  });
});

describe("fixed secondary-pane defaults", () => {
  it("preserves a 380px sidebar independent of the viewport width", () => {
    const narrow = splitRatioForSecondarySize(1_000, 380);
    const wide = splitRatioForSecondarySize(1_600, 380);

    expect((1 - narrow) * (1_000 - FLOW_SPLIT_HANDLE_PX)).toBeCloseTo(380);
    expect((1 - wide) * (1_600 - FLOW_SPLIT_HANDLE_PX)).toBeCloseTo(380);
  });

  it("recalculates a 380px reset from the current container size", () => {
    const initialRatio = splitRatioForSecondarySize(1_000, 380);
    const resizedContainerDefault = splitRatioForSecondarySize(1_600, 380);
    const resetAfterResize = splitRatioForKey(
      0.5,
      "Enter",
      false,
      resizedContainerDefault,
      "vertical",
    );

    expect(resetAfterResize).toBe(resizedContainerDefault);
    expect(initialRatio).not.toBe(resizedContainerDefault);
    expect((1 - resizedContainerDefault) * (1_600 - FLOW_SPLIT_HANDLE_PX)).toBeCloseTo(380);
  });
});

describe("split pane minimum sizes", () => {
  const containerSize = 1_000;
  const availableSize = containerSize - FLOW_SPLIT_HANDLE_PX;

  it("clamps intermediate ratios so neither open pane becomes unusably narrow", () => {
    const minimumPrimarySize = 320;
    const minimumSecondarySize = 300;

    const primaryConstrained = constrainSplitRatio(
      0.1,
      containerSize,
      minimumPrimarySize,
      minimumSecondarySize,
    );
    const secondaryConstrained = constrainSplitRatio(
      0.9,
      containerSize,
      minimumPrimarySize,
      minimumSecondarySize,
    );

    expect(primaryConstrained * availableSize).toBeCloseTo(minimumPrimarySize);
    expect((1 - secondaryConstrained) * availableSize).toBeCloseTo(minimumSecondarySize);
    expect(constrainSplitRatio(
      0.5,
      containerSize,
      minimumPrimarySize,
      minimumSecondarySize,
    )).toBe(0.5);
  });

  it("retains exact edge minimization despite open-pane minimums", () => {
    expect(constrainSplitRatio(0, containerSize, 320, 300)).toBe(0);
    expect(constrainSplitRatio(1, containerSize, 320, 300)).toBe(1);
  });

  it("falls back proportionally when both minimums cannot fit", () => {
    const ratio = constrainSplitRatio(0.5, 500, 320, 300);

    expect(ratio).toBeCloseTo(320 / (320 + 300));
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
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

function renderReviewSplit(args: {
  open: boolean;
  primaryRatio: number;
  keepSecondaryWhenClosed?: boolean;
  closedSecondarySize?: number;
  defaultSecondarySize?: number;
  initializeDefaultSecondarySize?: boolean;
  minimumPrimarySize?: number;
  minimumSecondarySize?: number;
}): string {
  return renderToStaticMarkup(
    <ResizableSplitView
      open={args.open}
      orientation="vertical"
      primary={<span>review graph</span>}
      secondary={<button>PR review rail</button>}
      primaryRatio={args.primaryRatio}
      defaultPrimaryRatio={0.7}
      onPrimaryRatioChange={() => {}}
      primaryPaneId="review-graph-pane"
      secondaryPaneId="review-sidebar-pane"
      primaryLabel="Graph"
      secondaryLabel="PR review"
      separatorLabel="Resize graph and PR review"
      keepSecondaryWhenClosed={args.keepSecondaryWhenClosed}
      closedSecondarySize={args.closedSecondarySize}
      defaultSecondarySize={args.defaultSecondarySize}
      initializeDefaultSecondarySize={args.initializeDefaultSecondarySize}
      minimumPrimarySize={args.minimumPrimarySize}
      minimumSecondarySize={args.minimumSecondarySize}
    />,
  );
}
