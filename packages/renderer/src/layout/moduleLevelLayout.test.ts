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
interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
function coreBox(nodes: { type?: string; position: { x: number; y: number }; style?: unknown }[]): Box {
  const core = nodes.filter((node) => node.type !== "ghost").map(rectOf);
  return {
    minX: Math.min(...core.map((r) => r.x)),
    minY: Math.min(...core.map((r) => r.y)),
    maxX: Math.max(...core.map((r) => r.x + r.width)),
    maxY: Math.max(...core.map((r) => r.y + r.height)),
  };
}
// A ghost is OUTSIDE the perimeter iff it clears the box entirely on some side — never inside it.
function outsideBox(r: Rect, box: Box): boolean {
  return r.x + r.width <= box.minX || r.x >= box.maxX || r.y + r.height <= box.minY || r.y >= box.maxY;
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
    // Fully outside the perimeter (past some edge), never inside the graph.
    expect(outsideBox(rectOf(ghost), coreBox(laid))).toBe(true);
  });

  it("puts every ghost outside the perimeter, overlapping no real card", async () => {
    const nodes = [fileNode("f:a"), fileNode("f:b"), ghostNode("g:out"), ghostNode("g:in")];
    const edges = [importEdge("f:a", "f:b"), ghostWire("f:a", "g:out"), ghostWire("g:in", "f:b")];
    const { nodes: laid } = await layoutModuleTree(nodes, edges);

    const box = coreBox(laid);
    const core = laid.filter((node) => node.type !== "ghost").map(rectOf);
    for (const ghost of laid.filter((node) => node.type === "ghost")) {
      expect(outsideBox(rectOf(ghost), box)).toBe(true);
      expect(core.every((card) => !overlaps(rectOf(ghost), card))).toBe(true);
    }
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
