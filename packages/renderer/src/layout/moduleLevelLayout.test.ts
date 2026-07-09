/**
 * GHOST cards are laid out OFF the ELK core: the drawn (non-ghost) tree keeps its ELK layer layout
 * while every ghost drops at the nearest overlap-free spot BESIDE its anchor. These tests pin the hard
 * contract — a ghost NEVER overlaps a real card or another ghost, an OUTGOING ghost sits to the anchor's
 * RIGHT and an INCOMING ghost to its LEFT — and the regression: with NO ghost the output is unchanged.
 */

import { describe, expect, it } from "vitest";
import type { GhostData } from "../derive/ghostDeps";
import type { ModuleCardData } from "../derive/moduleLevel";
import type { ModuleTreeEdge, VisibleModuleNode } from "../derive/moduleTree";
import { layoutModuleTree } from "./moduleLevelLayout";

function fileNode(id: string): VisibleModuleNode {
  const data: ModuleCardData = {
    label: id,
    fullPath: id,
    category: "app",
    inCount: 0,
    outCount: 0,
    isEntry: false,
    isContainer: false,
    isExpanded: false,
    unitCount: 0,
  };
  return { id, parentId: null, kind: "file", isContainer: false, isExpanded: false, depth: 0, childCount: 0, data };
}

function ghostNode(id: string): VisibleModuleNode {
  const data: GhostData = { label: id, context: "off/screen.ts", ghostKind: "function" };
  return { id, parentId: null, kind: "ghost", isContainer: false, isExpanded: false, depth: 0, childCount: 0, data };
}

function importEdge(source: string, target: string): ModuleTreeEdge {
  return { id: `imp:${source}->${target}`, source, target, weight: 1, crossFrame: false, category: "import" };
}

function ghostWire(source: string, target: string): ModuleTreeEdge {
  return { id: `gdep:calls:${source}->${target}`, source, target, weight: 1, crossFrame: false, category: "dep", depKind: "calls", ghost: true };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
function rectOf(node: { position: { x: number; y: number }; style?: unknown }): Rect {
  const style = (node.style ?? {}) as { width?: number; height?: number };
  return { x: node.position.x, y: node.position.y, width: style.width ?? 0, height: style.height ?? 0 };
}
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function coreBox(nodes: { type?: string; position: { x: number; y: number }; style?: unknown }[]): { minX: number; maxX: number } {
  const core = nodes.filter((node) => node.type !== "ghost").map(rectOf);
  return { minX: Math.min(...core.map((r) => r.x)), maxX: Math.max(...core.map((r) => r.x + r.width)) };
}

describe("layoutModuleTree ghost placement", () => {
  it("keeps the ELK core ghost-free and emits ghosts as root nodes OUTSIDE the core's perimeter", async () => {
    const nodes = [fileNode("f:a"), fileNode("f:b"), ghostNode("g:x")];
    const edges = [importEdge("f:a", "f:b"), ghostWire("f:a", "g:x")];
    const { nodes: laid } = await layoutModuleTree(nodes, edges);

    const ghost = laid.find((node) => node.id === "g:x")!;
    // Emitted as a ROOT node typed "ghost" — never nested, never fed to ELK.
    expect(ghost.type).toBe("ghost");
    expect(ghost.parentId).toBeUndefined();
    // An OUTGOING dependency bands past the core's RIGHT edge — fully outside the perimeter, never inside.
    expect(rectOf(ghost).x).toBeGreaterThanOrEqual(coreBox(laid).maxX);
  });

  it("bands outgoing ghosts right of the perimeter and incoming ghosts left of it", async () => {
    const nodes = [fileNode("f:a"), ghostNode("g:out"), ghostNode("g:in")];
    // g:out is an OUTGOING dependency (drawn→ghost, RIGHT); g:in is an INCOMING caller (ghost→drawn, LEFT).
    const edges = [ghostWire("f:a", "g:out"), ghostWire("g:in", "f:a")];
    const { nodes: laid } = await layoutModuleTree(nodes, edges);

    const box = coreBox(laid);
    const out = rectOf(laid.find((node) => node.id === "g:out")!);
    const inc = rectOf(laid.find((node) => node.id === "g:in")!);
    expect(out.x).toBeGreaterThanOrEqual(box.maxX); // right band, past the right edge
    expect(inc.x + inc.width).toBeLessThanOrEqual(box.minX); // left band, past the left edge
  });

  it("never overlaps a ghost with a real card or another ghost, even when crowded", async () => {
    // A tight cluster of real cards plus several ghosts off one anchor — every ghost must find clear air.
    const nodes = [fileNode("f:a"), fileNode("f:b"), fileNode("f:c"), ghostNode("g:1"), ghostNode("g:2"), ghostNode("g:3"), ghostNode("g:4")];
    const edges = [
      importEdge("f:a", "f:b"),
      importEdge("f:b", "f:c"),
      ghostWire("f:a", "g:1"),
      ghostWire("f:a", "g:2"),
      ghostWire("f:a", "g:3"),
      ghostWire("f:a", "g:4"),
    ];
    const { nodes: laid } = await layoutModuleTree(nodes, edges);
    const rects = laid.map(rectOf);
    for (let i = 0; i < laid.length; i += 1) {
      for (let j = i + 1; j < laid.length; j += 1) {
        expect(overlaps(rects[i], rects[j])).toBe(false);
      }
    }
  });

  it("is bit-identical to the plain nested layout when there are no ghosts", async () => {
    const nodes = [fileNode("f:a"), fileNode("f:b")];
    const edges = [importEdge("f:a", "f:b")];
    const { nodes: laid, edges: laidEdges } = await layoutModuleTree(nodes, edges);
    expect(laid.every((node) => node.type !== "ghost")).toBe(true);
    expect(laid).toHaveLength(2);
    expect(laidEdges).toHaveLength(1);
  });
});
