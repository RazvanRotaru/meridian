/**
 * Paint parity with the Map lens: every wire carrying the map's edge-data contract goes through the
 * Map's own suppress→emphasize chain (so relationship colours match the Map by construction), a pair's
 * redundant import wire is suppressed exactly as on the Map, and nested declarations join the same
 * emphasis pass.
 */

import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { paintMinimalLevel } from "./paintMinimal";
import { IMPORT_CROSS, IMPORT_SIBLING, REL_COLORS } from "../theme/mapPalette";

const NO_SELECTION: ReadonlySet<string> = new Set();
// emphasize's lit stroke width (not exported); pinned so the tests catch a silent rest-state fallback.
// Lit wires thicken by a constant on top of the weight-scaled base (weight 1 -> 1.1 + 1).
const LIT_WIDTH_W1 = 2.1;

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
    expect(edges[0].style?.strokeWidth).toBe(LIT_WIDTH_W1);
  });

  it("does not leave a selected declaration in the no-selection rest state (reach mode)", () => {
    const rest = paintMinimalLevel([frame, foo, bar], [intraDep], NO_SELECTION, 1, "reach");
    const { edges } = paintMinimalLevel([frame, foo, bar], [intraDep], new Set([foo.id]), 1, "reach");
    expect(rest.edges[0].style?.opacity).not.toBe(1);
    expect(edges[0].style?.opacity).toBe(1);
    expect(edges[0].style?.strokeWidth).toBe(LIT_WIDTH_W1);
  });

  it("selecting the expanded frame seeds its drawn descendants, lighting the intra-frame wire (node mode)", () => {
    const { edges } = paintMinimalLevel([frame, foo, bar], [intraDep], new Set([frame.id]), 1, "node");
    expect(edges[0].style?.opacity).toBe(1);
    expect(edges[0].style?.strokeWidth).toBe(LIT_WIDTH_W1);
  });

  it("keeps every node exactly once in laid-out order — parents before children", () => {
    const painted = paintMinimalLevel([frame, foo, bar], [intraDep], new Set([foo.id]), 1, "node");
    expect(painted.nodes.map((node) => node.id)).toEqual([frame.id, foo.id, bar.id]);
  });
});

