/**
 * Minimal-overlay ghost visibility at the REAL UI boundary: derive the current member ring, lay it
 * out, then run the same paint pass GraphSurface runs. Satellite cards are on-demand context, so
 * their layout wires must retain `ghost:true` for the shared paint pruner to hide every unlit hop.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import type { Edge, Node } from "@xyflow/react";
import { paintMinimalLevel } from "../components/paintMinimal";
import { buildMinimalSubgraph } from "../derive/minimalSubgraph";
import { buildModuleGraph } from "../derive/moduleGraph";
import { buildGraphIndex } from "../graph/graphIndex";
import { layoutMinimalSubgraph } from "./minimalSubgraphLayout";

const A_FILE = "ts:src/a.ts";
const A_BLOCK = `${A_FILE}#runA`;
const B_FILE = "ts:src/b.ts";
const B_UNIT = `${B_FILE}#Worker`;
const B_BLOCK = `${B_UNIT}.runB`;
const A_GHOST_FILE = "ts:deps/a/aGhost.ts";
const A_GHOST = `${A_GHOST_FILE}#aGhost`;
const B_GHOST_FILE = "ts:deps/b/bGhost.ts";
const B_GHOST = `${B_GHOST_FILE}#bGhost`;

function graphNode(id: string, kind: string, file: string, parentId: string | null): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } } as GraphNode;
}

const NODES: GraphNode[] = [
  graphNode("p:root", "package", ".", null),
  graphNode("p:src", "package", "src", "p:root"),
  graphNode(A_FILE, "module", "src/a.ts", "p:src"),
  graphNode(A_BLOCK, "function", "src/a.ts", A_FILE),
  graphNode(B_FILE, "module", "src/b.ts", "p:src"),
  graphNode(B_UNIT, "class", "src/b.ts", B_FILE),
  graphNode(B_BLOCK, "method", "src/b.ts", B_UNIT),
  graphNode("p:deps", "package", "deps", "p:root"),
  graphNode("p:deps/a", "package", "deps/a", "p:deps"),
  graphNode(A_GHOST_FILE, "module", "deps/a/aGhost.ts", "p:deps/a"),
  graphNode(A_GHOST, "function", "deps/a/aGhost.ts", A_GHOST_FILE),
  graphNode("p:deps/b", "package", "deps/b", "p:deps"),
  graphNode(B_GHOST_FILE, "module", "deps/b/bGhost.ts", "p:deps/b"),
  graphNode(B_GHOST, "function", "deps/b/bGhost.ts", B_GHOST_FILE),
];

const CALLS: GraphEdge[] = [
  { id: "calls:a->aGhost", source: A_BLOCK, target: A_GHOST, kind: "calls", resolution: "resolved" } as GraphEdge,
  { id: "calls:b->bGhost", source: B_BLOCK, target: B_GHOST, kind: "calls", resolution: "resolved" } as GraphEdge,
];

async function laidMemberRing(): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const artifact = { nodes: NODES, edges: CALLS } as unknown as GraphArtifact;
  const index = buildGraphIndex(artifact);
  const members = new Set([A_FILE, B_FILE]);
  // A is the original seed; B models a previously promoted member whose next hop should become the
  // only satellite context when B is selected.
  const spec = buildMinimalSubgraph(index, buildModuleGraph(index), members, new Set([A_FILE]), {
    expanded: new Set(),
    blockDeps: { edges: CALLS },
    flows: {},
  });
  return layoutMinimalSubgraph(spec, {
    [A_FILE]: { x: 0, y: 0, width: 210, height: 54 },
    [B_FILE]: { x: 400, y: 0, width: 210, height: 54 },
  });
}

async function laidExpandedMemberRing(): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const artifact = { nodes: NODES, edges: CALLS } as unknown as GraphArtifact;
  const index = buildGraphIndex(artifact);
  const members = new Set([A_FILE, B_FILE]);
  const spec = buildMinimalSubgraph(index, buildModuleGraph(index), members, new Set([A_FILE]), {
    // Model the promoted home file opened down to the calling method, as the real ghost-promotion
    // reveal path does after the reader expands its unit.
    expanded: new Set([B_FILE, B_UNIT]),
    blockDeps: { edges: CALLS },
    flows: {},
  });
  return layoutMinimalSubgraph(spec, {
    [A_FILE]: { x: 0, y: 0, width: 210, height: 54 },
    [B_FILE]: { x: 400, y: 0, width: 210, height: 54 },
  });
}

const satelliteEdges = (edges: Edge[]): Edge[] =>
  edges.filter((edge) => (edge.data as { outsideView?: boolean } | undefined)?.outsideView === true);

const satelliteIds = (nodes: Node[]): string[] =>
  nodes
    .filter((node) => node.type === "ghost")
    .map((node) => node.id)
    .sort();

describe("minimal member-ring paint", () => {
  it("marks laid satellite wires as ghost edges for the shared paint pruner", async () => {
    const laid = await laidMemberRing();
    expect(satelliteEdges(laid.edges)).toHaveLength(2);
    expect(satelliteEdges(laid.edges).map((edge) => (edge.data as { ghost?: boolean }).ghost)).toEqual([true, true]);
  });

  it("prunes every satellite when no member is selected", async () => {
    const laid = await laidMemberRing();
    const painted = paintMinimalLevel(laid.nodes, laid.edges, new Set(), 1, "reach");

    expect(satelliteIds(painted.nodes)).toEqual([]);
    expect(satelliteEdges(painted.edges)).toEqual([]);
  });

  it("shows only member A's incident satellite when A is selected", async () => {
    const laid = await laidMemberRing();
    const painted = paintMinimalLevel(laid.nodes, laid.edges, new Set([A_FILE]), 1, "reach");

    expect(satelliteIds(painted.nodes)).toEqual([A_GHOST]);
    expect(satelliteEdges(painted.edges).map((edge) => edge.target)).toEqual([A_GHOST]);
  });

  it("swaps to promoted member B's next-hop satellite when B is selected", async () => {
    const laid = await laidMemberRing();
    expect((laid.nodes.find((node) => node.id === B_FILE)?.data as { tier?: string }).tier).toBe("persistent");

    const painted = paintMinimalLevel(laid.nodes, laid.edges, new Set([B_FILE]), 1, "reach");
    expect(satelliteIds(painted.nodes)).toEqual([B_GHOST]);
    expect(satelliteEdges(painted.edges).map((edge) => edge.target)).toEqual([B_GHOST]);
  });

  it("anchors an expanded promoted member's ghost at its drawn caller and lights it from the caller's unit", async () => {
    const laid = await laidExpandedMemberRing();
    expect(laid.nodes).toContainEqual(expect.objectContaining({ id: B_UNIT, type: "unit", parentId: B_FILE }));
    expect(laid.nodes).toContainEqual(expect.objectContaining({ id: B_BLOCK, type: "block", parentId: B_UNIT }));

    const nextHop = satelliteEdges(laid.edges).find((edge) => edge.target === B_GHOST);
    expect(nextHop).toEqual(expect.objectContaining({ source: B_BLOCK, target: B_GHOST }));

    const painted = paintMinimalLevel(laid.nodes, laid.edges, new Set([B_UNIT]), 1, "reach");
    expect(satelliteIds(painted.nodes)).toEqual([B_GHOST]);
    expect(satelliteEdges(painted.edges)).toContainEqual(expect.objectContaining({ source: B_BLOCK, target: B_GHOST }));
  });

  it("reveals descendant-anchored ghosts when the expanded file frame is selected", async () => {
    const laid = await laidExpandedMemberRing();
    const painted = paintMinimalLevel(laid.nodes, laid.edges, new Set([B_FILE]), 1, "reach");

    expect(satelliteIds(painted.nodes)).toEqual([B_GHOST]);
    expect(satelliteEdges(painted.edges)).toContainEqual(expect.objectContaining({ source: B_BLOCK, target: B_GHOST }));
  });
});
