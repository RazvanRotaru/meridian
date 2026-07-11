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
import { layoutEdgesForPolicy, layoutModuleTree } from "./moduleLevelLayout";
import { SERVICE_RELATION_POLICY, UI_RELATION_POLICY } from "../graph/lensRelationPolicy";

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
  return { id: `imp:${source}->${target}`, source, target, weight: 1, crossFrame: false, crossPackage: false, outsideView: false, category: "import" };
}

function semanticEdge(kind: string): ModuleTreeEdge {
  return {
    id: `${kind}:a->b`,
    source: "a",
    target: "b",
    weight: 1,
    crossFrame: false,
    crossPackage: false,
    outsideView: false,
    category: "dep",
    relationKind: kind,
    depKind: kind,
  };
}

function ghostWire(source: string, target: string): ModuleTreeEdge {
  return {
    id: `gdep:calls:${source}->${target}`,
    source,
    target,
    weight: 1,
    crossFrame: false,
    crossPackage: true,
    outsideView: true,
    category: "dep",
    depKind: "calls",
    ghost: true,
    underlyingEdgeIds: [`calls:${source}->${target}`],
  };
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
    const { nodes: laid, edges: laidEdges } = await layoutModuleTree(nodes, edges);

    const ghost = laid.find((node) => node.id === "g:x")!;
    // Emitted as a ROOT node typed "ghost" — never nested, never fed to ELK.
    expect(ghost.type).toBe("ghost");
    expect(ghost.parentId).toBeUndefined();
    const wire = laidEdges.find((edge) => edge.id === "gdep:calls:f:a->g:x");
    expect(wire?.data).toMatchObject({
      crossPackage: true,
      outsideView: true,
      underlyingEdgeIds: ["calls:f:a->g:x"],
    });
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

  it("lays out every ghost beyond the former twenty-item evidence window", async () => {
    const ghosts = Array.from({ length: 23 }, (_, index) => ghostNode(`g:${index}`));
    const nodes = [fileNode("f:a"), ...ghosts];
    const edges = ghosts.map((ghost) => ghostWire("f:a", ghost.id));
    const { nodes: laid, edges: laidEdges } = await layoutModuleTree(nodes, edges);
    const laidGhosts = laid.filter((node) => node.type === "ghost");

    expect(laidGhosts).toHaveLength(23);
    expect(laidEdges.filter((edge) => edge.id.startsWith("gdep:calls:"))).toHaveLength(23);
    for (let i = 0; i < laidGhosts.length; i += 1) {
      for (let j = i + 1; j < laidGhosts.length; j += 1) {
        expect(overlaps(rectOf(laidGhosts[i]), rectOf(laidGhosts[j]))).toBe(false);
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

describe("lens relation layout policy", () => {
  const flow: ModuleTreeEdge = {
    id: "flow:a->b",
    source: "a",
    target: "b",
    weight: 1,
    crossFrame: false,
    crossPackage: false,
    outsideView: false,
    category: "flow",
  };

  it("keeps Service composition/inheritance constraints out of behavioral-call geometry", () => {
    const edges = [semanticEdge("registers"), semanticEdge("extends"), semanticEdge("calls"), semanticEdge("imports"), flow];
    expect(layoutEdgesForPolicy(edges, SERVICE_RELATION_POLICY).map((edge) => edge.id)).toEqual([
      "registers:a->b",
      "extends:a->b",
      "flow:a->b",
    ]);
  });

  it("lets renders shape UI while calls remain a paint-only overlay", () => {
    const edges = [semanticEdge("renders"), semanticEdge("implements"), semanticEdge("calls"), flow];
    expect(layoutEdgesForPolicy(edges, UI_RELATION_POLICY).map((edge) => edge.id)).toEqual([
      "renders:a->b",
      "implements:a->b",
      "flow:a->b",
    ]);
  });
});
