/**
 * GHOST cards are laid out OFF the ELK core: the drawn (non-ghost) tree keeps its ELK layer layout
 * while every ghost hangs on a ring at a fixed radius from the drawn node its wire touches. These
 * tests pin that contract — ghosts are root nodes at ~equal radius, an OUTGOING ghost rings RIGHT and
 * an INCOMING ghost rings LEFT — and the hard regression: with NO ghost the output is unchanged.
 */

import { describe, expect, it } from "vitest";
import type { GhostData } from "../derive/ghostDeps";
import type { ModuleCardData } from "../derive/moduleLevel";
import type { ModuleTreeEdge, VisibleModuleNode } from "../derive/moduleTree";
import { GHOST_RING_RADIUS } from "./ghostRingPlacement";
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

const center = (node: { position: { x: number; y: number }; style?: unknown }): { x: number; y: number } => {
  const style = (node.style ?? {}) as { width?: number; height?: number };
  return { x: node.position.x + (style.width ?? 0) / 2, y: node.position.y + (style.height ?? 0) / 2 };
};
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

describe("layoutModuleTree ghost rings", () => {
  it("keeps the ELK core ghost-free and emits ghosts as root nodes at the ring radius from their anchor", async () => {
    const nodes = [fileNode("f:a"), fileNode("f:b"), ghostNode("g:x")];
    const edges = [importEdge("f:a", "f:b"), ghostWire("f:a", "g:x")];
    const { nodes: laid } = await layoutModuleTree(nodes, edges);

    const anchor = laid.find((node) => node.id === "f:a")!;
    const ghost = laid.find((node) => node.id === "g:x")!;
    // Emitted as a ROOT node typed "ghost" — never nested, never fed to ELK.
    expect(ghost.type).toBe("ghost");
    expect(ghost.parentId).toBeUndefined();
    // A ghost is a code-dep far end, not an ELK layer: it sits on the ring, not left/right of the core.
    expect(dist(center(ghost), center(anchor))).toBeCloseTo(GHOST_RING_RADIUS, 3);
    // OUTGOING dependency (wire drawn→ghost) rings to the anchor's RIGHT.
    expect(center(ghost).x).toBeGreaterThan(center(anchor).x);
  });

  it("rings ghosts of the same anchor at an equal radius on the correct side by wire direction", async () => {
    const nodes = [fileNode("f:a"), ghostNode("g:out"), ghostNode("g:in")];
    // g:out is an OUTGOING dependency (drawn→ghost, RIGHT); g:in is an INCOMING caller (ghost→drawn, LEFT).
    const edges = [ghostWire("f:a", "g:out"), ghostWire("g:in", "f:a")];
    const { nodes: laid } = await layoutModuleTree(nodes, edges);

    const anchor = center(laid.find((node) => node.id === "f:a")!);
    const out = center(laid.find((node) => node.id === "g:out")!);
    const inc = center(laid.find((node) => node.id === "g:in")!);
    expect(dist(out, anchor)).toBeCloseTo(GHOST_RING_RADIUS, 3);
    expect(dist(inc, anchor)).toBeCloseTo(GHOST_RING_RADIUS, 3);
    expect(out.x).toBeGreaterThan(anchor.x); // right arc
    expect(inc.x).toBeLessThan(anchor.x); // left arc
  });

  it("never overlaps two ghosts sharing an anchor", async () => {
    const nodes = [fileNode("f:a"), ghostNode("g:1"), ghostNode("g:2"), ghostNode("g:3")];
    const edges = [ghostWire("f:a", "g:1"), ghostWire("f:a", "g:2"), ghostWire("f:a", "g:3")];
    const { nodes: laid } = await layoutModuleTree(nodes, edges);
    const ghosts = laid.filter((node) => node.type === "ghost").map(rectOf);
    for (let i = 0; i < ghosts.length; i += 1) {
      for (let j = i + 1; j < ghosts.length; j += 1) {
        expect(overlaps(ghosts[i], ghosts[j])).toBe(false);
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
