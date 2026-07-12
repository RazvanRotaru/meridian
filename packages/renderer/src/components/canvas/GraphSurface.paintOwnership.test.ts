import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { BUNDLE_EDGE_TYPE, type BundleEdgeData } from "../../layout/edgeBundling";
import { CYCLE_EDGE_TYPE, type CycleEdgeData } from "../../layout/cycleFusion";
import { resolveSurfacePaintOwnership } from "./GraphSurface";
import { prepareCanvasEdges } from "./presentationEdgePipeline";

describe("GraphSurface paint ownership", () => {
  it("keeps ghost provenance for disclosure while adding literal adjacency and highway focus", () => {
    const selected = new Set(["ghost"]);
    const provenance = new Set(["owner"]);

    const ownership = resolveSurfacePaintOwnership(selected, null, true, provenance);

    expect(ownership.protectedSelection).toBe(selected);
    expect(ownership.paintSeeds).toBe(provenance);
    expect(ownership.focusSeeds).toBe(selected);
    expect(ownership.highwaySeeds).toBe(selected);
  });

  it("gives transient PR review paint and highway precedence over retained ghost provenance", () => {
    const selected = new Set(["ghost"]);
    const reviewLit = new Set(["review-target"]);
    const provenance = new Set(["old-owner"]);

    const ownership = resolveSurfacePaintOwnership(selected, reviewLit, true, provenance);

    expect(ownership.protectedSelection).toBe(selected);
    expect(ownership.paintSeeds).toBe(reviewLit);
    expect(ownership.focusSeeds).toBeNull();
    expect(ownership.highwaySeeds).toBe(ownership.paintSeeds);
  });

  it("ignores review state outside review mounts and resumes ghost provenance after review paint clears", () => {
    const selected = new Set(["ghost"]);
    const provenance = new Set(["owner"]);
    const strayReviewLit = new Set(["review-target"]);

    const outsideReview = resolveSurfacePaintOwnership(selected, strayReviewLit, false, provenance);
    const clearedReview = resolveSurfacePaintOwnership(selected, null, true, provenance);

    expect(outsideReview.paintSeeds).toBe(provenance);
    expect(outsideReview.focusSeeds).toBe(selected);
    expect(clearedReview.paintSeeds).toBe(provenance);
    expect(clearedReview.focusSeeds).toBe(selected);
  });

  it("extracts only strands represented by the literal selection while retaining its paint owner's highway strand", () => {
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
      child("ghost", "left"),
      child("group-parent", "left"),
      child("owner", "left"),
      ...[4, 5, 6].map((index) => child(`a${index}`, "left")),
      ...[1, 2, 3, 4, 5, 6].map((index) => child(`b${index}`, "right")),
    ];
    const groupedData = {
      category: "dep",
      depKind: "calls",
      relationKind: "calls",
      weight: 1,
      ghostGroupAggregate: true,
      groupedGhostIds: ["ghost"],
      groupedGhostCount: 1,
    };
    const edges: Edge[] = [
      { id: "e1", source: "ghost", target: "b1", data: { category: "dep", depKind: "calls", relationKind: "calls", weight: 1 }, style: { opacity: 1 } },
      { id: "e2", source: "group-parent", target: "b2", data: groupedData, style: { opacity: 1 } },
      { id: "e3", source: "owner", target: "b3", data: { category: "dep", depKind: "calls", relationKind: "calls", weight: 1 }, style: { opacity: 0.4 } },
      ...[4, 5, 6].map((index) => ({
        id: `e${index}`,
        source: `a${index}`,
        target: `b${index}`,
        data: { category: "dep", depKind: "calls", relationKind: "calls", weight: 1 },
        style: { opacity: 0.4 },
      } as Edge)),
      { id: "e7", source: "b2", target: "group-parent", data: groupedData, style: { opacity: 1 } },
    ];
    const ownership = resolveSurfacePaintOwnership(
      new Set(["ghost"]),
      null,
      false,
      new Set(["owner"]),
    );

    const prepared = prepareCanvasEdges(
      edges,
      nodes,
      ownership.highwaySeeds,
      true,
      { bundling: true, routing: false, spooling: false },
    ).semanticEdges;

    expect(prepared).toContainEqual(expect.objectContaining({
      id: "e1",
      style: expect.objectContaining({ opacity: 1 }),
    }));
    const groupedCycle = prepared.find((edge) => edge.type === CYCLE_EDGE_TYPE);
    expect((groupedCycle?.data as CycleEdgeData | undefined)?.members.map((edge) => edge.id))
      .toEqual(["e2", "e7"]);
    expect(prepared.some((edge) => edge.id === "e3")).toBe(false);
    const highway = prepared.find((edge) => edge.type === BUNDLE_EDGE_TYPE);
    const highwayData = highway?.data as BundleEdgeData | undefined;
    expect(highwayData?.count).toBe(4);
    expect(highwayData?.constituents.map((edge) => edge.id)).toContain("e3");
    expect(highwayData?.hasLit).toBe(false);
    expect(highway?.style?.opacity).toBe(0.45);
  });
});
