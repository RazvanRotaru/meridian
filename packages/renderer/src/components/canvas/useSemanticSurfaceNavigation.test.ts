import type { Node } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import {
  beginSemanticRetainedCameraReset,
  nodesAtCurrentSemanticDepth,
  SEMANTIC_READING_MIN_ZOOM,
  semanticResetDisposition,
  semanticSurfaceDepths,
} from "./useSemanticSurfaceNavigation";
import {
  reachableSemanticFirstPreviewMax,
  semanticCommitZoomForDepth,
  semanticFirstPreviewMaxForViewport,
} from "./mapLodGeometry";
import { CANVAS_MIN_ZOOM } from "./flowCanvasProps";

function node(id: string, depth?: number): Node {
  return {
    id,
    position: { x: 0, y: 0 },
    data: depth === undefined ? {} : { semanticDepth: depth },
  };
}

describe("semanticSurfaceDepths", () => {
  it("keeps stable absolute node depths and fills parent metadata markers", () => {
    expect(semanticSurfaceDepths(
      [node("parent", 2), node("outer", 3)],
      [{ depth: 3, focus: null, anchorId: "outer" }],
    )).toEqual([2, 3]);
  });

  it("infers an exit surface's current depth immediately inside its advertised parent", () => {
    expect(semanticSurfaceDepths(
      [node("minimal")],
      [{ depth: 1, focus: null, anchorId: "source" }],
    )).toEqual([0, 1]);
  });

  it("returns no semantic depths for an ordinary single graph", () => {
    expect(semanticSurfaceDepths([node("plain")], [])).toEqual([]);
  });
});

describe("nodesAtCurrentSemanticDepth", () => {
  it("selects only the smallest retained depth", () => {
    const nodes = [node("outer", 3), node("current-a", 2), node("current-b", 2)];
    expect(nodesAtCurrentSemanticDepth(nodes, [2, 3]).map(({ id }) => id)).toEqual([
      "current-a",
      "current-b",
    ]);
  });

  it("keeps every node when the surface has no semantic markers", () => {
    const nodes = [node("a"), node("b")];
    expect(nodesAtCurrentSemanticDepth(nodes, [])).toEqual(nodes);
  });
});

describe("exit navigation lifecycle", () => {
  it("keeps the commit boundary reachable above canvas minimum after a minimum fitted zoom", () => {
    const previewMax = reachableSemanticFirstPreviewMax(
      semanticFirstPreviewMaxForViewport(
        { x: 0, y: 0, width: 100_000, height: 100_000 },
        1_000,
        1_000,
      ),
      SEMANTIC_READING_MIN_ZOOM,
    );
    const commitMax = semanticCommitZoomForDepth(0, [0, 1], undefined, previewMax);

    expect(SEMANTIC_READING_MIN_ZOOM).toBeGreaterThan(CANVAS_MIN_ZOOM);
    expect(commitMax).toBeGreaterThan(CANVAS_MIN_ZOOM);
  });

  it("does not cancel an armed exit when its node reset lands during the fade", () => {
    expect(semanticResetDisposition(true, false, false)).toBe("preserve-exit");
    expect(semanticResetDisposition(false, true, false)).toBe("consume-retained");
    expect(semanticResetDisposition(false, true, true)).toBe("reset");
  });
});

describe("retained parent camera handoff", () => {
  it("starts the reading camera immediately and releases after its short animation", () => {
    const setReadingCenter = vi.fn();

    const releaseDelay = beginSemanticRetainedCameraReset(setReadingCenter, false);

    expect(setReadingCenter).toHaveBeenCalledOnce();
    expect(setReadingCenter).toHaveBeenCalledWith(280);
    expect(releaseDelay).toBe(304);
  });

  it("skips camera animation when reduced motion is preferred", () => {
    const setReadingCenter = vi.fn();

    const releaseDelay = beginSemanticRetainedCameraReset(setReadingCenter, true);

    expect(setReadingCenter).toHaveBeenCalledOnce();
    expect(setReadingCenter).toHaveBeenCalledWith(0);
    expect(releaseDelay).toBe(24);
  });
});
