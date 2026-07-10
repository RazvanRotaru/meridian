/**
 * Paint parity with the Map lens: every wire carrying the map's edge-data contract goes through the
 * Map's own suppress→emphasize chain (so relationship colours match the Map by construction), the
 * overlay-minted stub tethers pass through byte-identical, and a pair's redundant import wire is
 * suppressed exactly as on the Map.
 */

import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { GHOST_OPACITY, paintMinimalLevel } from "./paintMinimal";
import { IMPORT_CROSS, IMPORT_SIBLING, REL_COLORS } from "../theme/mapPalette";
import { MINIMAL_STUB_NODE } from "../layout/minimalSubgraphLayout";

const NO_SELECTION: ReadonlySet<string> = new Set();
// emphasize's lit stroke width (not exported); pinned so the tests catch a silent rest-state fallback.
const EMPHASIS_WIDTH = 2.5;

function fileNode(id: string, tier: string | null = "seed"): Node {
  return { id, type: "file", position: { x: 0, y: 0 }, data: { category: "app", tier } } as Node;
}

// A drawn declaration card inside an expanded file frame (the Map's own `unit` component).
function unitNode(id: string, parentId: string): Node {
  return { id, type: "unit", parentId, position: { x: 0, y: 0 }, data: { unitKind: "function" } } as Node;
}

function depEdge(source: string, target: string, depKind?: string): Edge {
  return { id: `dep:${depKind ?? "step"}:${source}->${target}`, source, target, data: { weight: 1, crossFrame: false, category: "dep", ghost: false, ...(depKind ? { depKind } : {}) } } as Edge;
}

function importEdge(source: string, target: string, crossFrame: boolean): Edge {
  return { id: `imp:${source}->${target}`, source, target, data: { weight: 1, crossFrame, category: "import", ghost: false } } as Edge;
}

function paint(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  return paintMinimalLevel(nodes, edges, NO_SELECTION, 1, "reach");
}

const TWO_FILES = [fileNode("ts:a.ts"), fileNode("ts:b.ts")];

describe("paintMinimalLevel — relationship colours match the Map", () => {
  it("strokes a dep wire by its depKind, for every relationship in the shared palette", () => {
    for (const [depKind, colour] of Object.entries(REL_COLORS)) {
      const { edges } = paint(TWO_FILES, [depEdge("ts:a.ts", "ts:b.ts", depKind)]);
      expect(edges).toHaveLength(1);
      expect(edges[0].style?.stroke).toBe(colour);
    }
  });

  it("strokes an import wire gold when it crosses a package, muted gold within one", () => {
    const wires = [importEdge("ts:a.ts", "ts:b.ts", true), importEdge("ts:b.ts", "ts:a.ts", false)];
    const { edges } = paint(TWO_FILES, wires);
    expect(edges.find((edge) => edge.id === wires[0].id)?.style?.stroke).toBe(IMPORT_CROSS);
    expect(edges.find((edge) => edge.id === wires[1].id)?.style?.stroke).toBe(IMPORT_SIBLING);
  });
});

describe("paintMinimalLevel — the baked stub layer stays out of the paint", () => {
  it("passes a data-less stub tether (and the [+n] stub node) through byte-identical", () => {
    const stubNode = { id: "stub:ts:a.ts:out", type: MINIMAL_STUB_NODE, position: { x: 0, y: 0 }, data: { sourceId: "ts:a.ts", direction: "out" } } as Node;
    const tether: Edge = { id: "stubedge:ts:a.ts:out", source: "ts:a.ts", target: stubNode.id, style: { stroke: "#2A313C", strokeWidth: 1, strokeDasharray: "2 3", opacity: 0.6 }, selectable: false };
    const painted = paint([fileNode("ts:a.ts"), stubNode], [tether]);
    expect(painted.edges.find((edge) => edge.id === tether.id)).toBe(tether);
    expect(painted.nodes.find((node) => node.id === stubNode.id)).toBe(stubNode);
  });
});

describe("paintMinimalLevel — redundant-import suppression (the Map's rule)", () => {
  it("drops the import wire when a typed dep wire joins the same pair, keeping the dep wire", () => {
    const dep = depEdge("ts:a.ts", "ts:b.ts", "calls");
    const imp = importEdge("ts:a.ts", "ts:b.ts", true);
    const { edges } = paint(TWO_FILES, [dep, imp]);
    expect(edges.map((edge) => edge.id)).toEqual([dep.id]);
    expect(edges[0].style?.stroke).toBe(REL_COLORS.calls);
  });
});

describe("paintMinimalLevel — nested declarations join the Map's emphasis, not a side bucket", () => {
  // An expanded file frame with two drawn declaration cards and their intra-frame dep wire —
  // the PRIMARY PR-review surface (clicking a changed block inside an amber frame).
  const frame = fileNode("ts:a.ts");
  const foo = unitNode("ts:a.ts#Foo", "ts:a.ts");
  const bar = unitNode("ts:a.ts#bar", "ts:a.ts");
  const intraDep = depEdge("ts:a.ts#Foo", "ts:a.ts#bar", "calls");

  it("lights a selected declaration's incident intra-frame dep wire at full emphasis (node mode)", () => {
    const { edges } = paintMinimalLevel([frame, foo, bar], [intraDep], new Set([foo.id]), 1, "node");
    expect(edges[0].style?.opacity).toBe(1);
    expect(edges[0].style?.strokeWidth).toBe(EMPHASIS_WIDTH);
  });

  it("does not leave a selected declaration in the no-selection rest state (reach mode)", () => {
    const rest = paintMinimalLevel([frame, foo, bar], [intraDep], NO_SELECTION, 1, "reach");
    const { edges } = paintMinimalLevel([frame, foo, bar], [intraDep], new Set([foo.id]), 1, "reach");
    expect(rest.edges[0].style?.opacity).not.toBe(1);
    expect(edges[0].style?.opacity).toBe(1);
    expect(edges[0].style?.strokeWidth).toBe(EMPHASIS_WIDTH);
  });

  it("selecting the expanded frame seeds its drawn descendants, lighting the intra-frame wire (node mode)", () => {
    const { edges } = paintMinimalLevel([frame, foo, bar], [intraDep], new Set([frame.id]), 1, "node");
    expect(edges[0].style?.opacity).toBe(1);
    expect(edges[0].style?.strokeWidth).toBe(EMPHASIS_WIDTH);
  });

  it("keeps every node exactly once in laid-out order — parents before children, stubs still last", () => {
    const stubNode = { id: "stub:ts:a.ts:out", type: MINIMAL_STUB_NODE, position: { x: 0, y: 0 }, data: { sourceId: "ts:a.ts", direction: "out" } } as Node;
    const painted = paintMinimalLevel([frame, foo, bar, stubNode], [intraDep], new Set([foo.id]), 1, "node");
    expect(painted.nodes.map((node) => node.id)).toEqual([frame.id, foo.id, bar.id, stubNode.id]);
  });
});

describe("paintMinimalLevel — the ghost-tier dim still layers under the paint", () => {
  it("dims a ghost-tier file to GHOST_OPACITY when nothing is selected", () => {
    const { nodes } = paint([fileNode("ts:a.ts", "ghost"), fileNode("ts:b.ts")], [importEdge("ts:a.ts", "ts:b.ts", false)]);
    expect(nodes.find((node) => node.id === "ts:a.ts")?.style?.opacity).toBe(GHOST_OPACITY);
    expect(nodes.find((node) => node.id === "ts:b.ts")?.style?.opacity).toBeUndefined();
  });
});
