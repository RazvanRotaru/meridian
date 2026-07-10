/**
 * The minimal-graph overlay's TWO layout regimes:
 *   - no expanded frame  → the captured-position mirror is returned byte-for-byte (hard regression
 *     constraint: expanding nothing must never move a card);
 *   - one expanded frame → an interactive-layered ELK reflow opens spacing so no two top-level file
 *     rects overlap, even when the captured seeds were overlapping to begin with.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import type { Node } from "@xyflow/react";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "../derive/moduleGraph";
import { buildMinimalSubgraph } from "../derive/minimalSubgraph";
import { layoutMinimalSubgraph } from "./minimalSubgraphLayout";
import type { PlacedRect } from "./minimalPlacement";

function pkg(id: string, name: string, parentId: string | null): GraphNode {
  return { id, kind: "package", qualifiedName: id, displayName: name, parentId, location: { file: name, startLine: 1 } } as GraphNode;
}
function mod(id: string, file: string, parentId: string | null): GraphNode {
  return { id, kind: "module", qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } } as GraphNode;
}
function fn(id: string, name: string, parentId: string): GraphNode {
  return { id, kind: "function", qualifiedName: id, displayName: name, parentId, location: { file: name, startLine: 1 } } as GraphNode;
}
function importEdge(source: string, target: string): GraphEdge {
  return { id: `imports:${source}->${target}`, source, target, kind: "imports", resolution: "resolved" } as GraphEdge;
}

// a.ts declares foo()/bar() (so its card is an expandable, class-heavy frame) and imports b.ts.
const NODES = [
  pkg("p:root", "root", null),
  pkg("p:src", "src", "p:root"),
  mod("m:a", "src/a.ts", "p:src"),
  mod("m:b", "src/b.ts", "p:src"),
  fn("fn:foo", "foo", "m:a"),
  fn("fn:bar", "bar", "m:a"),
];
const EDGES = [importEdge("m:a", "m:b")];

function specFor(expanded: string[]) {
  const index = buildGraphIndex({ nodes: NODES, edges: EDGES } as unknown as GraphArtifact);
  const graph = buildModuleGraph(index);
  const onMap = new Set(["m:a", "m:b"]);
  return buildMinimalSubgraph(index, graph, new Set(["m:a"]), new Set(), [], onMap, {
    expanded: new Set(expanded),
    blockDeps: { edges: [] },
    flows: {},
  });
}

// foo() in a.ts calls baz() in b.ts — the overlay spec carries a per-kind dep wire a→b.
function couplingSpec() {
  const nodes = [...NODES, fn("fn:baz", "baz", "m:b")];
  const calls = { id: "calls:fn:foo->fn:baz", source: "fn:foo", target: "fn:baz", kind: "calls", resolution: "resolved" } as GraphEdge;
  const index = buildGraphIndex({ nodes, edges: EDGES } as unknown as GraphArtifact);
  const graph = buildModuleGraph(index);
  return buildMinimalSubgraph(index, graph, new Set(["m:a"]), new Set(), [], new Set(["m:a", "m:b"]), {
    expanded: new Set(),
    blockDeps: { edges: [calls] },
    flows: {},
  });
}

const rectOf = (node: Node): PlacedRect => {
  const style = (node.style ?? {}) as { width?: number; height?: number };
  return { x: node.position.x, y: node.position.y, width: style.width ?? 0, height: style.height ?? 0 };
};
const overlaps = (a: PlacedRect, b: PlacedRect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const topLevelFiles = (nodes: Node[]): Node[] => nodes.filter((node) => node.type === "file" && node.parentId === undefined);

describe("layoutMinimalSubgraph", () => {
  it("mirrors the captured positions byte-for-byte when nothing is expanded", async () => {
    const base: Record<string, PlacedRect> = {
      "m:a": { x: 10, y: 20, width: 200, height: 50 },
      "m:b": { x: 400, y: 80, width: 180, height: 60 },
    };
    const { nodes } = await layoutMinimalSubgraph(specFor([]), base);
    expect(rectOf(nodes.find((node) => node.id === "m:a")!)).toEqual(base["m:a"]);
    expect(rectOf(nodes.find((node) => node.id === "m:b")!)).toEqual(base["m:b"]);
  });

  it("opens spacing so no two top-level file frames overlap once a file is expanded", async () => {
    // Captured seeds deliberately OVERLAP (a's 210-wide card straddles b at x=50): the flat mirror
    // would keep them overlapping, but expanding a must trigger the reflow that separates them.
    const base: Record<string, PlacedRect> = {
      "m:a": { x: 0, y: 0, width: 210, height: 54 },
      "m:b": { x: 50, y: 0, width: 210, height: 54 },
    };
    const { nodes } = await layoutMinimalSubgraph(specFor(["m:a"]), base);
    const files = topLevelFiles(nodes);
    expect(files).toHaveLength(2);
    for (let i = 0; i < files.length; i += 1) {
      for (let j = i + 1; j < files.length; j += 1) {
        expect(overlaps(rectOf(files[i]), rectOf(files[j]))).toBe(false);
      }
    }
  });

  it("emits a dep wire data-only (category/depKind for the paint chain), with no baked style", async () => {
    const base: Record<string, PlacedRect> = {
      "m:a": { x: 0, y: 0, width: 210, height: 54 },
      "m:b": { x: 400, y: 0, width: 210, height: 54 },
    };
    const { edges } = await layoutMinimalSubgraph(couplingSpec(), base);
    const dep = edges.find((edge) => edge.id === "dep:calls:m:a->m:b");
    expect(dep?.data).toEqual({ weight: 1, crossFrame: false, category: "dep", depKind: "calls", ghost: false });
    expect(dep?.style).toBeUndefined();
  });

  it("re-hangs a stub against its source's reflowed position", async () => {
    // b imports nothing shown outward but a→b means b has a hidden importee (c-less here); ensure any
    // emitted stub sits flush beside its (reflowed) source rather than the stale seed spot.
    const base: Record<string, PlacedRect> = {
      "m:a": { x: 0, y: 0, width: 210, height: 54 },
      "m:b": { x: 50, y: 0, width: 210, height: 54 },
    };
    const { nodes } = await layoutMinimalSubgraph(specFor(["m:a"]), base);
    for (const stub of nodes.filter((node) => node.type === "minimalStub")) {
      const sourceId = (stub.data as { sourceId: string }).sourceId;
      const source = nodes.find((node) => node.id === sourceId);
      expect(source).toBeDefined();
      const s = rectOf(source!);
      const st = rectOf(stub);
      // vertically centred on its source
      expect(st.y + st.height / 2).toBeCloseTo(s.y + s.height / 2, 1);
    }
  });
});
