import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { routeFrameEdges, ROUTED_EDGE_TYPE, type RoutedEdgeData } from "./edgeRouting";

// A 400×600 frame at (500, 0) holding two member cards, plus outside sources on either side.
const nodes: Node[] = [
  { id: "frame", position: { x: 500, y: 0 }, style: { width: 400, height: 600 }, data: {} },
  { id: "top", parentId: "frame", position: { x: 60, y: 80 }, style: { width: 200, height: 40 }, data: {} },
  { id: "low", parentId: "frame", position: { x: 60, y: 480 }, style: { width: 200, height: 40 }, data: {} },
  { id: "left", position: { x: 0, y: 280 }, style: { width: 150, height: 40 }, data: {} },
  { id: "right", position: { x: 1100, y: 280 }, style: { width: 150, height: 40 }, data: {} },
  { id: "peer", parentId: "frame", position: { x: 60, y: 280 }, style: { width: 200, height: 40 }, data: {} },
];

const edge = (id: string, source: string, target: string): Edge => ({ id, source, target, data: {} });
const pathOf = (e: Edge): string => (e.data as RoutedEdgeData).routedPath;

describe("routeFrameEdges", () => {
  it("routes a left-side wire through the gate onto the left rail, peeling off at the target height", () => {
    const [routed] = routeFrameEdges([edge("e1", "left", "top")], nodes);
    expect(routed.type).toBe(ROUTED_EDGE_TYPE);
    const path = pathOf(routed);
    // Rail rides the frame's LEFT gutter (frame.x=500 + inset 12 = 512), never card territory.
    expect(path).toContain("L 512 ");
    // The peel-off ends at the target's left handle: x = 500+60 = 560, y = 80+20 = 100.
    expect(path.endsWith("L 560 100")).toBe(true);
  });

  it("enters from the RIGHT gutter when the source sits right of the frame", () => {
    const [routed] = routeFrameEdges([edge("e2", "right", "low")], nodes);
    const path = pathOf(routed);
    // Right rail: frame right edge 900 − inset 12 = 888; target right handle (760, 480+20=500).
    expect(path).toContain("L 888 ");
    expect(path.endsWith("L 760 500")).toBe(true);
  });

  it("wires from different sources into the same frame share the rail x (the bus)", () => {
    const [a, b] = routeFrameEdges([edge("a", "left", "top"), edge("b", "left", "low")], nodes);
    const railSegments = (p: string) => p.match(/L 512 [\d.]+/g) ?? [];
    expect(railSegments(pathOf(a)).length).toBeGreaterThan(0);
    expect(railSegments(pathOf(b)).length).toBeGreaterThan(0);
  });

  it("leaves intra-frame, frame-targeted, and already-typed edges alone", () => {
    const intra = edge("i", "peer", "top");
    const toFrame = edge("f", "left", "frame");
    const bundled: Edge = { ...edge("bu", "left", "top"), type: "bundle" };
    const result = routeFrameEdges([intra, toFrame, bundled], nodes);
    expect(result[0].type).toBeUndefined(); // both ends inside the same frame
    expect(result[1].type).toBeUndefined(); // the frame itself is the target — no interior to cross
    expect(result[2].type).toBe("bundle"); // container highways keep their renderer
  });

  it("emits a flat entry (no rail) when the target sits at the gate's own height", () => {
    const [routed] = routeFrameEdges([edge("e3", "left", "peer")], nodes);
    expect(routed.type).toBe(ROUTED_EDGE_TYPE);
    expect(pathOf(routed)).not.toContain("Q"); // no corners — straight flat entry
  });
});
