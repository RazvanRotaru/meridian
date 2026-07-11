import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { bundleEdges, bundleLabel, BUNDLE_EDGE_TYPE, type BundleEdgeData } from "./edgeBundling";
import { BOUNDARY_DASH_PATTERN, type EdgeBoundaryData } from "./edgeBoundary";
import { IMPORT_CROSS } from "../theme/mapPalette";

// Two packages, each holding three files. All three files in A import their counterpart in B, so the
// A→B pair carries three cross-container edges — exactly the bundle threshold.
const nodes: Node[] = [
  { id: "pkgA", position: { x: 0, y: 0 }, data: {} },
  { id: "pkgB", position: { x: 0, y: 0 }, data: {} },
  { id: "a1", parentId: "pkgA", position: { x: 0, y: 0 }, data: {} },
  { id: "a2", parentId: "pkgA", position: { x: 0, y: 0 }, data: {} },
  { id: "a3", parentId: "pkgA", position: { x: 0, y: 0 }, data: {} },
  { id: "b1", parentId: "pkgB", position: { x: 0, y: 0 }, data: {} },
  { id: "b2", parentId: "pkgB", position: { x: 0, y: 0 }, data: {} },
  { id: "b3", parentId: "pkgB", position: { x: 0, y: 0 }, data: {} },
];

const edge = (id: string, source: string, target: string, boundary: EdgeBoundaryData = {}): Edge => ({
  id,
  source,
  target,
  data: { depKind: "imports", crossPackage: false, outsideView: false, ...boundary },
});

const crossEdges: Edge[] = [edge("e1", "a1", "b1"), edge("e2", "a2", "b2"), edge("e3", "a3", "b3")];

describe("bundleEdges", () => {
  it("merges cross-container edges above the threshold into one highway", () => {
    const result = bundleEdges(crossEdges, nodes);
    expect(result).toHaveLength(1);
    const highway = result[0];
    expect(highway.type).toBe(BUNDLE_EDGE_TYPE);
    expect(highway.source).toBe("pkgA");
    expect(highway.target).toBe("pkgB");
    expect((highway.data as BundleEdgeData).count).toBe(3);
    // Cross-container remains the bundle's geometric/color signal, not a reason to dash.
    expect(highway.data).toMatchObject({ crossFrame: true, crossPackage: false, outsideView: false });
    expect(highway.style?.strokeDasharray).toBeUndefined();
  });

  it.each(["crossPackage", "outsideView"] as const)("dashes when any constituent carries %s", (flag) => {
    const flagged = [edge("e1", "a1", "b1"), edge("e2", "a2", "b2", { [flag]: true }), edge("e3", "a3", "b3")];
    const [highway] = bundleEdges(flagged, nodes);
    expect(highway.data).toMatchObject({ [flag]: true });
    expect(highway.style?.strokeDasharray).toBe(BOUNDARY_DASH_PATTERN);
  });

  it("un-bundles a selected node's own wires so its links draw individually", () => {
    const result = bundleEdges(crossEdges, nodes, new Set(["a1"]));
    // a1's edge escapes the highway (drawn individually); the remaining two are below threshold,
    // so they too pass through — no highway survives here.
    const highways = result.filter((e) => e.type === BUNDLE_EDGE_TYPE);
    const individuals = result.filter((e) => e.type !== BUNDLE_EDGE_TYPE);
    expect(individuals.map((e) => e.id)).toContain("e1");
    expect(highways).toHaveLength(0);
    expect(result).toHaveLength(3);
  });

  it("keeps the highway (minus the extracted edge) when enough edges remain", () => {
    const fourth = edge("e4", "a1", "b1");
    const result = bundleEdges([...crossEdges, fourth], nodes, new Set(["a2"]));
    const highways = result.filter((e) => e.type === BUNDLE_EDGE_TYPE);
    // a2's edge (e2) is extracted; e1, e3, e4 stay bundled (3 ≥ threshold).
    expect(highways).toHaveLength(1);
    expect((highways[0].data as BundleEdgeData).count).toBe(3);
    expect(result.some((e) => e.id === "e2" && e.type !== BUNDLE_EDGE_TYPE)).toBe(true);
  });

  it("never bundles intra-container edges", () => {
    const intra = edge("i1", "a1", "a2");
    const result = bundleEdges([intra], nodes);
    expect(result).toEqual([intra]);
  });

  it("never bundles between nested containers (ancestor ↔ descendant)", () => {
    // A root frame whose loose file fans out to files inside a nested sub-frame. The sub-frame's
    // parent is the root frame, so grouping by parent would collapse all edges onto one nonsensical
    // trunk between the frame and the container nested inside it.
    const nested: Node[] = [
      { id: "root", position: { x: 0, y: 0 }, data: {} },
      { id: "sub", parentId: "root", position: { x: 0, y: 0 }, data: {} },
      { id: "loose", parentId: "root", position: { x: 0, y: 0 }, data: {} },
      { id: "s1", parentId: "sub", position: { x: 0, y: 0 }, data: {} },
      { id: "s2", parentId: "sub", position: { x: 0, y: 0 }, data: {} },
      { id: "s3", parentId: "sub", position: { x: 0, y: 0 }, data: {} },
    ];
    // loose (parent root) → three files in sub (parent sub); sub is nested within root.
    const edges = [edge("e1", "loose", "s1"), edge("e2", "loose", "s2"), edge("e3", "loose", "s3")];
    const result = bundleEdges(edges, nested);
    expect(result.filter((e) => e.type === BUNDLE_EDGE_TYPE)).toHaveLength(0);
    expect(result).toHaveLength(3);
  });

  it("still bundles between two SIBLING containers (neither nests the other)", () => {
    // Same shape but the source lives in its own sibling sub-frame — a legitimate peer-to-peer
    // highway that should still merge.
    const siblings: Node[] = [
      { id: "root", position: { x: 0, y: 0 }, data: {} },
      { id: "subA", parentId: "root", position: { x: 0, y: 0 }, data: {} },
      { id: "subB", parentId: "root", position: { x: 0, y: 0 }, data: {} },
      { id: "a1", parentId: "subA", position: { x: 0, y: 0 }, data: {} },
      { id: "b1", parentId: "subB", position: { x: 0, y: 0 }, data: {} },
      { id: "b2", parentId: "subB", position: { x: 0, y: 0 }, data: {} },
      { id: "b3", parentId: "subB", position: { x: 0, y: 0 }, data: {} },
    ];
    const edges = [edge("e1", "a1", "b1"), edge("e2", "a1", "b2"), edge("e3", "a1", "b3")];
    const result = bundleEdges(edges, siblings);
    expect(result.filter((e) => e.type === BUNDLE_EDGE_TYPE)).toHaveLength(1);
  });

  it("preserves the painted cross-frame colour for untyped Service dependency highways", () => {
    const serviceEdges = crossEdges.map((item) => ({
      ...item,
      data: { category: "dep", crossFrame: true, crossPackage: false, outsideView: false },
      style: { stroke: IMPORT_CROSS, opacity: 0.12 },
    }));
    const [highway] = bundleEdges(serviceEdges, nodes);

    expect(highway.style?.stroke).toBe(IMPORT_CROSS);
    expect(bundleLabel((highway.data as BundleEdgeData).breakdown)).toBe("3 dependencies");
  });
});
