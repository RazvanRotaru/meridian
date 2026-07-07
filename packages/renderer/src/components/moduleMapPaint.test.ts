/**
 * Multi-select emphasis: `emphasize` takes the SET of selected node ids and lights the union of
 * their N-hop import neighbourhoods — each selection contributes its own blast radius. An empty
 * set is the resting state: every wire dim, no node faded.
 */

import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { emphasize } from "./moduleMapPaint";

const LIT_OPACITY = 1;
const DIM_EDGE_OPACITY = 0.12;
const DIM_NODE_OPACITY = 0.28;

function fileNode(id: string): Node {
  return { id, type: "file", position: { x: 0, y: 0 }, data: { category: "app" } };
}

function importEdge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target };
}

// A chain a→b→c→d plus a disconnected pair x→y, so union vs single-seed reach is observable.
const NODES: Node[] = ["a", "b", "c", "d", "x", "y"].map(fileNode);
const EDGES: Edge[] = [importEdge("a", "b"), importEdge("b", "c"), importEdge("c", "d"), importEdge("x", "y")];

function edgeOpacity(edges: Edge[], id: string): number | undefined {
  return edges.find((edge) => edge.id === id)?.style?.opacity as number | undefined;
}

function nodeOpacity(nodes: Node[], id: string): number | undefined {
  return nodes.find((node) => node.id === id)?.style?.opacity as number | undefined;
}

describe("emphasize with a selection set", () => {
  it("dims every wire and fades nothing when the selection is empty", () => {
    const { nodes, edges } = emphasize(NODES, EDGES, new Set(), 1);
    for (const edge of edges) {
      expect(edge.style?.opacity).toBe(DIM_EDGE_OPACITY);
    }
    for (const node of nodes) {
      expect(node.style?.opacity).toBeUndefined();
    }
  });

  it("lights a single selection's direct neighbourhood at radius 1", () => {
    const { nodes, edges } = emphasize(NODES, EDGES, new Set(["b"]), 1);
    expect(edgeOpacity(edges, "a->b")).toBe(LIT_OPACITY);
    expect(edgeOpacity(edges, "b->c")).toBe(LIT_OPACITY);
    expect(edgeOpacity(edges, "c->d")).toBe(DIM_EDGE_OPACITY);
    expect(nodeOpacity(nodes, "a")).toBeUndefined();
    expect(nodeOpacity(nodes, "c")).toBeUndefined();
    expect(nodeOpacity(nodes, "d")).toBe(DIM_NODE_OPACITY);
    expect(nodeOpacity(nodes, "x")).toBe(DIM_NODE_OPACITY);
  });

  it("lights the UNION of neighbourhoods when several nodes are selected", () => {
    const { nodes, edges } = emphasize(NODES, EDGES, new Set(["b", "x"]), 1);
    expect(edgeOpacity(edges, "a->b")).toBe(LIT_OPACITY);
    expect(edgeOpacity(edges, "b->c")).toBe(LIT_OPACITY);
    expect(edgeOpacity(edges, "x->y")).toBe(LIT_OPACITY);
    expect(edgeOpacity(edges, "c->d")).toBe(DIM_EDGE_OPACITY);
    expect(nodeOpacity(nodes, "y")).toBeUndefined();
    expect(nodeOpacity(nodes, "d")).toBe(DIM_NODE_OPACITY);
  });

  it("honours the hop radius from every seed", () => {
    const { edges } = emphasize(NODES, EDGES, new Set(["a"]), 2);
    expect(edgeOpacity(edges, "a->b")).toBe(LIT_OPACITY);
    expect(edgeOpacity(edges, "b->c")).toBe(LIT_OPACITY);
    expect(edgeOpacity(edges, "c->d")).toBe(DIM_EDGE_OPACITY); // d is 3 hops out
  });
});
