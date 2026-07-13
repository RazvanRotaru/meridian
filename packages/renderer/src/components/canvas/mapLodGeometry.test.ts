import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import {
  advanceSemanticFirstPreviewMaxInward,
  enclosingParentFrame,
  graphBounds,
  normalizedSemanticDepths,
  rebaseSemanticFirstPreviewMax,
  renderedNodesAtSemanticDepth,
  reachableSemanticFirstPreviewMax,
  semanticCommitDepthForZoomChange,
  semanticCommitZoomForDepth,
  semanticFirstPreviewMaxForViewport,
  semanticZoomBandRatio,
  semanticZoomBandForZoom,
  structuralGraphBounds,
} from "./mapLodGeometry";

const node = (id: string, x: number, y: number, width: number, height: number, parentId?: string, type = "file"): Node => ({
  id,
  type,
  parentId,
  position: { x, y },
  style: { width, height },
  data: {},
});

describe("structuralGraphBounds", () => {
  it("bounds the structural graph and accounts for parent-relative positions", () => {
    const nodes = [node("frame", 100, 40, 200, 120, undefined, "package"), node("child", 30, 20, 40, 30, "frame")];

    expect(structuralGraphBounds(nodes)).toEqual({ x: 100, y: 40, width: 200, height: 120 });
  });

  it("counts a visible ghost for occupancy without letting it enlarge the parent frame", () => {
    const nodes = [node("left", 0, 0, 100, 50), node("right", 300, 100, 100, 50), node("ghost", 2000, 900, 180, 50, undefined, "ghost")];
    const visibleBounds = graphBounds(nodes);

    expect(visibleBounds).toEqual({ x: 0, y: 0, width: 2180, height: 950 });
    expect(semanticFirstPreviewMaxForViewport(visibleBounds, 1_000, 1_000)).toBeCloseTo(0.4 / 2.18);
    expect(structuralGraphBounds(nodes)).toEqual({ x: 0, y: 0, width: 400, height: 150 });
  });

  it("bounds a subset while resolving its positions through omitted ancestors", () => {
    const frame = node("frame", 100, 40, 300, 180, undefined, "package");
    const left = node("left", 30, 20, 40, 30, "frame");
    const right = node("right", 180, 90, 60, 40, "frame");

    expect(structuralGraphBounds([frame, left, right], [left, right])).toEqual({
      x: 130,
      y: 60,
      width: 210,
      height: 110,
    });
  });

  it("returns null for an empty graph", () => {
    expect(structuralGraphBounds([])).toBeNull();
  });
});

describe("enclosingParentFrame", () => {
  it("adds a stable-screen header and gutters around every child", () => {
    expect(enclosingParentFrame({ x: 0, y: 0, width: 400, height: 150 }, 0.5)).toEqual({
      x: -36,
      y: -100,
      width: 472,
      height: 286,
    });
  });
});

describe("semanticFirstPreviewMaxForViewport", () => {
  it("measures only the post-paint population at the active depth", () => {
    const current = { ...node("current", 0, 0, 100, 50), data: { semanticDepth: 1 } };
    const ancestor = { ...node("ancestor", 2_000, 0, 100, 50), data: { semanticDepth: 2 } };

    expect(renderedNodesAtSemanticDepth([current, ancestor], 1)).toEqual([current]);
  });

  it("uses undecorated current nodes when only the parent is described by semantic metadata", () => {
    const current = node("current", 0, 0, 100, 50);
    const describedParent = {
      ...node("parent", 2_000, 0, 100, 50),
      data: { semanticDepth: 1 },
    };

    expect(renderedNodesAtSemanticDepth([current, describedParent], 0)).toEqual([current]);
  });

  it("starts preview only after the graph's constraining dimension falls below 40%", () => {
    const previewMax = semanticFirstPreviewMaxForViewport(
      { x: 0, y: 0, width: 1_000, height: 400 },
      1_000,
      1_000,
    );

    expect(previewMax).toBe(0.4);
    expect(semanticZoomBandForZoom(0.4, [0, 1], undefined, previewMax)).toEqual({
      depth: 0,
      stage: "reading",
    });
    expect(semanticZoomBandForZoom(0.399, [0, 1], undefined, previewMax)).toEqual({
      depth: 0,
      stage: "preview",
      previewDepth: 1,
    });
  });

  it("uses the dominant dimension instead of area and is symmetric for tall graphs", () => {
    const wide = semanticFirstPreviewMaxForViewport(
      { x: 0, y: 0, width: 800, height: 80 },
      1_000,
      1_000,
    );
    const tall = semanticFirstPreviewMaxForViewport(
      { x: 0, y: 0, width: 80, height: 800 },
      1_000,
      1_000,
    );
    const scaledAndPanned = semanticFirstPreviewMaxForViewport(
      { x: -12_000, y: 8_000, width: 1_600, height: 160 },
      2_000,
      2_000,
    );

    expect(wide).toBe(0.5);
    expect(tall).toBe(wide);
    expect(scaledAndPanned).toBe(wide);
  });

  it("keeps an initially tiny graph readable until the next outward gesture", () => {
    const occupancyThreshold = semanticFirstPreviewMaxForViewport(
      { x: 0, y: 0, width: 80, height: 80 },
      1_000,
      1_000,
    );

    expect(occupancyThreshold).toBe(5);
    expect(reachableSemanticFirstPreviewMax(occupancyThreshold, 2)).toBe(2);
    const rearmedAtZoomIn = reachableSemanticFirstPreviewMax(occupancyThreshold, 4);
    expect(rearmedAtZoomIn).toBe(4);
    expect(semanticZoomBandForZoom(4, [0, 1], undefined, rearmedAtZoomIn)).toEqual({
      depth: 0,
      stage: "reading",
    });
    expect(semanticZoomBandForZoom(3.99, [0, 1], undefined, rearmedAtZoomIn)).toEqual({
      depth: 0,
      stage: "preview",
      previewDepth: 1,
    });
    const reversedBeforeClamp = advanceSemanticFirstPreviewMaxInward(
      rearmedAtZoomIn,
      occupancyThreshold,
      3.95,
      [0, 1],
    );
    expect(reversedBeforeClamp).toBe(4);
    expect(semanticZoomBandForZoom(3.95, [0, 1], undefined, reversedBeforeClamp)).toMatchObject({
      depth: 0,
      stage: "preview",
    });
    expect(semanticZoomBandForZoom(4, [0, 1], undefined, reversedBeforeClamp)).toEqual({
      depth: 0,
      stage: "reading",
    });
  });

  it("separates the exact occupancy threshold from the minimum-zoom reachability fallback", () => {
    expect(semanticFirstPreviewMaxForViewport(null, 0, 1_000)).toBe(0.45);

    const occupancyThreshold = semanticFirstPreviewMaxForViewport(
      { x: 0, y: 0, width: 100_000, height: 100_000 },
      1_000,
      1_000,
    );
    const previewMax = reachableSemanticFirstPreviewMax(occupancyThreshold);

    expect(occupancyThreshold).toBe(0.004);
    expect(semanticCommitZoomForDepth(0, [0, 1], undefined, previewMax)).toBeGreaterThan(0.01);
  });

  it("keeps a programmatic camera at the canvas floor on the current graph", () => {
    const occupancyThreshold = semanticFirstPreviewMaxForViewport(
      { x: 0, y: 0, width: 100_000, height: 100_000 },
      1_000,
      1_000,
    );
    const readingThreshold = reachableSemanticFirstPreviewMax(occupancyThreshold, 0.01);

    expect(readingThreshold).toBe(0.01);
    expect(semanticZoomBandForZoom(0.01, [0, 1], undefined, readingThreshold)).toEqual({
      depth: 0,
      stage: "reading",
    });
    const nearFloorThreshold = reachableSemanticFirstPreviewMax(occupancyThreshold, 0.012);
    expect(semanticCommitZoomForDepth(0, [0, 1], undefined, nearFloorThreshold)).toBeGreaterThan(0.01);
  });

  it("rebases a resized reading graph without letting resize navigate to its parent", () => {
    expect(rebaseSemanticFirstPreviewMax(0.5, 1, 0.6, [0, 1])).toBe(0.6);
    expect(semanticZoomBandForZoom(
      0.6,
      [0, 1],
      undefined,
      rebaseSemanticFirstPreviewMax(0.5, 1, 0.6, [0, 1]),
    )).toEqual({ depth: 0, stage: "reading" });
  });

  it("preserves preview when a resize-derived threshold would navigate without a gesture", () => {
    expect(semanticZoomBandForZoom(0.4, [0, 1], undefined, 0.5)).toEqual({
      depth: 0,
      stage: "preview",
      previewDepth: 1,
    });
    expect(rebaseSemanticFirstPreviewMax(0.5, 0.625, 0.4, [0, 1])).toBe(0.5);
  });

  it("does not cancel an active preview when resize makes the graph occupy more of the pane", () => {
    const previewMax = rebaseSemanticFirstPreviewMax(0.5, 0.25, 0.4, [0, 1]);

    expect(previewMax).toBe(0.5);
    expect(semanticZoomBandForZoom(0.4, [0, 1], undefined, previewMax)).toEqual({
      depth: 0,
      stage: "preview",
      previewDepth: 1,
    });
  });
});

describe("semanticZoomBandForZoom", () => {
  it("alternates reading and preview windows across every available semantic layer", () => {
    const depths = [0, 1, 2];

    expect(semanticZoomBandForZoom(0.45, depths)).toEqual({ depth: 0, stage: "reading" });
    expect(semanticZoomBandForZoom(0.449, depths)).toEqual({ depth: 0, stage: "preview", previewDepth: 1 });
    expect(semanticZoomBandForZoom(0.3, depths)).toEqual({ depth: 0, stage: "preview", previewDepth: 1 });
    expect(semanticZoomBandForZoom(0.299, depths)).toEqual({ depth: 1, stage: "reading" });
    expect(semanticZoomBandForZoom(0.2, depths)).toEqual({ depth: 1, stage: "reading" });
    expect(semanticZoomBandForZoom(0.199, depths)).toEqual({ depth: 1, stage: "preview", previewDepth: 2 });
    expect(semanticZoomBandForZoom(0.1, depths)).toEqual({ depth: 2, stage: "reading" });
  });

  it("has no sticky navigation state when the user reverses across multiple levels", () => {
    const depths = [0, 1, 2];
    expect([0.5, 0.4, 0.25, 0.18, 0.1, 0.18, 0.25, 0.4, 0.5].map((zoom) => semanticZoomBandForZoom(zoom, depths))).toEqual([
      { depth: 0, stage: "reading" },
      { depth: 0, stage: "preview", previewDepth: 1 },
      { depth: 1, stage: "reading" },
      { depth: 1, stage: "preview", previewDepth: 2 },
      { depth: 2, stage: "reading" },
      { depth: 1, stage: "preview", previewDepth: 2 },
      { depth: 1, stage: "reading" },
      { depth: 0, stage: "preview", previewDepth: 1 },
      { depth: 0, stage: "reading" },
    ]);
  });

  it("restarts the transition windows around the promoted current layer", () => {
    const fullDepths = [0, 1, 2];
    const retainedDepths = [1, 2];

    expect(semanticZoomBandForZoom(0.299, fullDepths)).toEqual({ depth: 1, stage: "reading" });
    expect(semanticZoomBandForZoom(0.45, retainedDepths)).toEqual({ depth: 1, stage: "reading" });
    expect(semanticZoomBandForZoom(0.449, retainedDepths)).toEqual({
      depth: 1,
      stage: "preview",
      previewDepth: 2,
    });
    expect(semanticZoomBandForZoom(0.3, retainedDepths)).toEqual({
      depth: 1,
      stage: "preview",
      previewDepth: 2,
    });
    expect(semanticZoomBandForZoom(0.299, retainedDepths)).toEqual({ depth: 2, stage: "reading" });
  });

  it("preserves the preceding bands until the promoted parent's camera reset completes", () => {
    const retainedDepths = [1, 2];

    expect(semanticZoomBandForZoom(0.299, retainedDepths, 0)).toEqual({ depth: 1, stage: "reading" });
    expect(semanticZoomBandForZoom(0.199, retainedDepths, 0)).toEqual({
      depth: 1,
      stage: "preview",
      previewDepth: 2,
    });
    expect(semanticZoomBandForZoom(1, retainedDepths, 0)).toEqual({ depth: 1, stage: "reading" });
    expect(semanticZoomBandForZoom(1, retainedDepths)).toEqual({ depth: 1, stage: "reading" });
  });

  it("stays on the deepest available graph instead of inventing another transition", () => {
    expect(semanticZoomBandForZoom(0.001, [0, 1])).toEqual({ depth: 1, stage: "reading" });
    expect(semanticZoomBandForZoom(1, [])).toBeNull();
  });

  it("compresses unusually deep stacks so their final level is reachable at minimum zoom", () => {
    const depths = Array.from({ length: 10 }, (_, depth) => depth);

    expect(semanticZoomBandRatio(depths.length)).toBeGreaterThan(2 / 3);
    expect(semanticZoomBandForZoom(0.01, depths)).toEqual({ depth: 9, stage: "reading" });
  });

  it("uses a retained stack's relative position while preserving its absolute depth identity", () => {
    const retainedDepths = [7, 8, 9];
    const threshold = semanticCommitZoomForDepth(7, retainedDepths);

    expect(threshold).toBeCloseTo(0.3);
    expect(semanticZoomBandForZoom(threshold, retainedDepths)).toEqual({
      depth: 7,
      stage: "preview",
      previewDepth: 8,
    });
    expect(semanticZoomBandForZoom(threshold - 0.000001, retainedDepths)).toEqual({ depth: 8, stage: "reading" });
  });

  it("can retain the preceding origin's threshold during a handoff", () => {
    const retainedDepths = [8, 9];
    const threshold = semanticCommitZoomForDepth(8, retainedDepths, 7);

    expect(threshold).toBeCloseTo(0.45 * (2 / 3) ** 3);
    expect(semanticZoomBandForZoom(threshold, retainedDepths, 7)).toEqual({
      depth: 8,
      stage: "preview",
      previewDepth: 9,
    });
  });

  it("uses one viewport-occupancy threshold for both rendered bands and outward commit detection", () => {
    const depths = [0, 1];
    const fittedZoom = 0.12;
    const previewMax = reachableSemanticFirstPreviewMax(
      semanticFirstPreviewMaxForViewport(
        { x: 0, y: 0, width: 6_250, height: 2_000 },
        1_000,
        1_000,
      ),
      fittedZoom,
    );
    const commitMax = previewMax * (2 / 3);

    expect(previewMax).toBeCloseTo(0.064);
    expect(semanticZoomBandForZoom(fittedZoom, depths, undefined, previewMax)).toEqual({
      depth: 0,
      stage: "reading",
    });
    expect(semanticZoomBandForZoom(previewMax - 0.001, depths, undefined, previewMax)).toEqual({
      depth: 0,
      stage: "preview",
      previewDepth: 1,
    });
    expect(semanticZoomBandForZoom(commitMax - 0.001, depths, undefined, previewMax)).toEqual({
      depth: 1,
      stage: "reading",
    });
    expect(
      semanticCommitDepthForZoomChange(commitMax, commitMax - 0.001, depths, undefined, previewMax),
    ).toBe(1);
  });
});

describe("semanticCommitDepthForZoomChange", () => {
  it("returns the nearest parent after an outward movement sample crosses its commit threshold", () => {
    expect(semanticCommitDepthForZoomChange(null, 0.29, [0, 1, 2])).toBeNull();
    expect(semanticCommitDepthForZoomChange(0.4, 0.3, [0, 1, 2])).toBeNull();
    expect(semanticCommitDepthForZoomChange(0.3, 0.299, [0, 1, 2])).toBe(1);
  });

  it("never fires while zooming back in across the same boundary", () => {
    expect(semanticCommitDepthForZoomChange(0.28, 0.31, [0, 1, 2])).toBeNull();
    expect(semanticCommitDepthForZoomChange(0.31, 0.31, [0, 1, 2])).toBeNull();
  });

  it("resolves the canonical target shown after a coarse outward sample crosses several boundaries", () => {
    expect(semanticCommitDepthForZoomChange(0.5, 0.12, [0, 1, 2])).toBe(2);
  });

  it("uses the first transition threshold again after the parent camera resets", () => {
    expect(semanticCommitDepthForZoomChange(0.4, 0.3, [1, 2])).toBeNull();
    expect(semanticCommitDepthForZoomChange(0.3, 0.299, [1, 2])).toBe(2);
  });

  it("does not cascade while the previous origin remains active for the reset animation", () => {
    expect(semanticCommitDepthForZoomChange(0.3, 0.299, [1, 2], 0)).toBeNull();
    expect(semanticCommitDepthForZoomChange(0.14, 0.132, [1, 2], 0)).toBe(2);
  });
});

describe("normalizedSemanticDepths", () => {
  it("sorts, deduplicates, and rejects invalid layer markers", () => {
    expect(normalizedSemanticDepths([3, 1, 1, -1, Number.NaN, 0, 2.5])).toEqual([0, 1, 3]);
  });
});
