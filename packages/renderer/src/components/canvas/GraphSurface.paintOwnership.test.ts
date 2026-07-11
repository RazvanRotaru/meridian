import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { BUNDLE_EDGE_TYPE, type BundleEdgeData } from "../../layout/edgeBundling";
import { resolveSurfacePaintOwnership } from "./GraphSurface";
import { prepareCanvasEdges } from "./presentationEdgePipeline";

describe("GraphSurface paint ownership", () => {
  it("keeps literal ghost selection protected while minimal uses its provenance for paint and highways", () => {
    const selected = new Set(["ghost"]);
    const provenance = new Set(["owner"]);

    const ownership = resolveSurfacePaintOwnership(selected, null, true, provenance);

    expect(ownership.protectedSelection).toBe(selected);
    expect(ownership.paintSeeds).toBe(provenance);
    expect(ownership.highwaySeeds).toBe(ownership.paintSeeds);
  });

  it("gives transient PR review paint precedence over retained ghost provenance", () => {
    const selected = new Set(["ghost"]);
    const reviewLit = new Set(["review-target"]);
    const provenance = new Set(["old-owner"]);

    const ownership = resolveSurfacePaintOwnership(selected, reviewLit, true, provenance);

    expect(ownership.protectedSelection).toBe(selected);
    expect(ownership.paintSeeds).toBe(reviewLit);
    expect(ownership.highwaySeeds).toBe(ownership.paintSeeds);
  });

  it("ignores review state outside review mounts and resumes ghost provenance after review paint clears", () => {
    const selected = new Set(["ghost"]);
    const provenance = new Set(["owner"]);
    const strayReviewLit = new Set(["review-target"]);

    expect(resolveSurfacePaintOwnership(selected, strayReviewLit, false, provenance).paintSeeds)
      .toBe(provenance);
    expect(resolveSurfacePaintOwnership(selected, null, true, provenance).paintSeeds)
      .toBe(provenance);
  });

  it("feeds paint owners into highway extraction while retaining literal selection protection", () => {
    const container = (id: string): Node => ({ id, type: "file", position: { x: 0, y: 0 }, data: {} });
    const child = (id: string, parentId: string): Node => ({
      id,
      type: "block",
      parentId,
      position: { x: 0, y: 0 },
      data: {},
    });
    const nodes = [
      container("left"),
      container("right"),
      ...[1, 2, 3, 4].flatMap((index) => [child(`a${index}`, "left"), child(`b${index}`, "right")]),
      { id: "ghost", type: "ghost", position: { x: 0, y: 0 }, data: {} } as Node,
    ];
    const edges: Edge[] = [1, 2, 3, 4].map((index) => ({
      id: `e${index}`,
      source: `a${index}`,
      target: `b${index}`,
      data: { category: "dep", depKind: "calls", relationKind: "calls", weight: 1 },
      style: { opacity: 1 },
    }));
    const ownership = resolveSurfacePaintOwnership(
      new Set(["ghost"]),
      null,
      false,
      new Set(["a1"]),
    );

    const prepared = prepareCanvasEdges(
      edges,
      nodes,
      ownership.highwaySeeds,
      true,
      { bundling: true, routing: false, spooling: false },
    ).semanticEdges;

    expect(prepared).toContainEqual(expect.objectContaining({ id: "e1" }));
    const highway = prepared.find((edge) => edge.type === BUNDLE_EDGE_TYPE);
    expect((highway?.data as BundleEdgeData | undefined)?.count).toBe(3);
    expect(ownership.protectedSelection).toEqual(new Set(["ghost"]));
  });
});
