import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import type { Edge, Node } from "@xyflow/react";
import { buildGraphIndex } from "../graph/graphIndex";
import { emphasize, emphasisSeeds, type GhostPresentationOptions } from "./moduleMapHighlight";

const CORE = "ts:app.ts#selected";
const FILE = "ts:dep.ts";
const PARENT = `${FILE}#Dependency`;

function graphNode(id: string, kind: string, parentId: string | null, displayName = id): GraphNode {
  return {
    id,
    kind,
    parentId,
    displayName,
    qualifiedName: id.startsWith("ts:") ? id.slice(3) : id,
    location: { file: "dep.ts", startLine: 1 },
  } as GraphNode;
}

function member(index: number): string {
  return `${PARENT}.m${index}`;
}

function presentation(memberCount: number, groupByParent: boolean): GhostPresentationOptions {
  const artifactNodes = [
    graphNode(CORE, "class", null, "selected"),
    graphNode(FILE, "module", null, "dep.ts"),
    graphNode(PARENT, "class", FILE, "Dependency"),
    ...Array.from({ length: memberCount }, (_, index) => graphNode(member(index + 1), "method", PARENT, `m${index + 1}`)),
  ];
  return {
    index: buildGraphIndex({ nodes: artifactNodes, edges: [] } as unknown as GraphArtifact),
    groupByParent,
    expandedGroupIds: new Set<string>(),
  };
}

function coreNode(): Node {
  return {
    id: CORE,
    type: "unit",
    position: { x: 100, y: 120 },
    data: { unitKind: "class" },
    style: { width: 240, height: 90 },
  } as Node;
}

function codeMemberNode(id: string): Node {
  return {
    id,
    type: "block",
    parentId: CORE,
    position: { x: 20, y: 20 },
    data: { blockKind: "method" },
    style: { width: 180, height: 54 },
  } as Node;
}

function ghostNode(id: string, index: number): Node {
  return {
    id,
    type: "ghost",
    position: { x: 500, y: index * 70 },
    data: { label: id, context: "dep.ts", ghostKind: "method" },
    style: { width: 220, height: 54 },
  } as Node;
}

function ghostEdge(target: string, index: number, source = CORE): Edge {
  return {
    id: `ghost-${index}`,
    source,
    target,
    data: {
      category: "dep",
      relationKind: "calls",
      depKind: "calls",
      ghost: true,
      weight: 1,
      crossPackage: false,
      outsideView: true,
      underlyingEdgeIds: [`edge-${index}`],
    },
  } as Edge;
}

function scene(memberCount: number): { nodes: Node[]; edges: Edge[] } {
  const ghosts = Array.from({ length: memberCount }, (_, index) => ghostNode(member(index + 1), index));
  return {
    nodes: [coreNode(), ...ghosts],
    edges: ghosts.map((ghost, index) => ghostEdge(ghost.id, index)),
  };
}

function paintSeedsOf(nodes: readonly Node[], id: string, expected: readonly string[] = [CORE]): Set<string> {
  const node = nodes.find((candidate) => candidate.id === id);
  const ids = (node?.data as { ghostPaintSeedIds?: unknown } | undefined)?.ghostPaintSeedIds;
  expect(ids).toEqual(expected);
  return new Set(ids as string[]);
}

describe("emphasize — ghost selection uses the drawn endpoint as its paint seed", () => {
  it("keeps an exact ghost as the literal selection while matching the originating node's frontier and geometry", () => {
    const firstMember = `${CORE}.first`;
    const secondMember = `${CORE}.second`;
    const nodes = [
      coreNode(),
      codeMemberNode(firstMember),
      codeMemberNode(secondMember),
      ghostNode(member(1), 0),
      ghostNode(member(2), 1),
    ];
    const edges = [
      ghostEdge(member(1), 0, firstMember),
      ghostEdge(member(1), 1, secondMember),
      ghostEdge(member(2), 2, firstMember),
    ];
    const options = presentation(2, false);

    expect(emphasisSeeds(new Set([member(1)]), nodes, edges, options)).toEqual([CORE]);

    const fromCore = emphasize(nodes, edges, new Set([CORE]), 1, "reach", options);
    const fromGhost = emphasize(
      nodes,
      edges,
      new Set([member(1)]),
      1,
      "reach",
      options,
      paintSeedsOf(fromCore.nodes, member(1)),
    );
    expect(fromGhost).toEqual(fromCore);
  });

  it("reconstructs a collapsed grouped ghost's exact members and preserves its grouped frontier and geometry", () => {
    const { nodes, edges } = scene(4);
    const options = presentation(4, true);

    expect(emphasisSeeds(new Set([PARENT]), nodes, edges, options)).toEqual([CORE]);

    const fromCore = emphasize(nodes, edges, new Set([CORE]), 1, "reach", options);
    expect(fromCore.nodes.filter((node) => node.type === "ghost").map((node) => node.id)).toEqual([PARENT]);
    const fromGroup = emphasize(
      nodes,
      edges,
      new Set([PARENT]),
      1,
      "reach",
      options,
      paintSeedsOf(fromCore.nodes, PARENT),
    );
    expect(fromGroup).toEqual(fromCore);
  });

  it("keeps an exact selected child inside its expanded group with the full family and geometry unchanged", () => {
    const { nodes, edges } = scene(4);
    const options: GhostPresentationOptions = {
      ...presentation(4, true),
      expandedGroupIds: new Set([PARENT]),
    };
    const fromCore = emphasize(nodes, edges, new Set([CORE]), 1, "reach", options);
    expect(fromCore.nodes.filter((node) => node.type === "ghost").map((node) => node.id).sort())
      .toEqual([PARENT, member(1), member(2), member(3), member(4)].sort());
    expect(fromCore.edges.filter((edge) => edge.data?.edgeRole === "ghost-hierarchy")).toHaveLength(4);

    const fromExactChild = emphasize(
      nodes,
      edges,
      new Set([member(1)]),
      1,
      "reach",
      options,
      paintSeedsOf(fromCore.nodes, member(1)),
    );

    // This pins the complete node/edge objects, including parent-relative positions. Selection may
    // change identity in the store, but disclosure and paint must not rewrite the visible scene.
    expect(fromExactChild).toEqual(fromCore);
  });

  it("resolves and retains Ctrl-selected ghost provenance per owner instead of their global file LCA", () => {
    const frame: Node = { id: FILE, type: "file", position: { x: 0, y: 0 }, data: {} };
    const ownerA = `${FILE}#OwnerA`;
    const ownerB = `${FILE}#OwnerB`;
    const methodA1 = `${ownerA}.first`;
    const methodA2 = `${ownerA}.second`;
    const methodB1 = `${ownerB}.first`;
    const methodB2 = `${ownerB}.second`;
    const ghostA = member(1);
    const ghostB = member(2);
    const ownerNode = (id: string): Node => ({
      id,
      type: "unit",
      parentId: FILE,
      position: { x: 20, y: 20 },
      data: { unitKind: "class" },
    });
    const methodNode = (id: string, parentId: string): Node => ({
      id,
      type: "block",
      parentId,
      position: { x: 10, y: 10 },
      data: { blockKind: "method" },
    });
    const nodes = [
      frame,
      ownerNode(ownerA),
      methodNode(methodA1, ownerA),
      methodNode(methodA2, ownerA),
      ownerNode(ownerB),
      methodNode(methodB1, ownerB),
      methodNode(methodB2, ownerB),
      ghostNode(ghostA, 0),
      ghostNode(ghostB, 1),
    ];
    const edges = [
      ghostEdge(ghostA, 0, methodA1),
      ghostEdge(ghostA, 1, methodA2),
      ghostEdge(ghostB, 2, methodB1),
      ghostEdge(ghostB, 3, methodB2),
    ];

    expect(emphasisSeeds(new Set([ghostA, ghostB]), nodes, edges))
      .toEqual([ownerA, ownerB]);

    const fromOwners = emphasize(nodes, edges, new Set([ownerA, ownerB]), 1, "reach");
    const provenance = new Set([
      ...paintSeedsOf(fromOwners.nodes, ghostA, [ownerA]),
      ...paintSeedsOf(fromOwners.nodes, ghostB, [ownerB]),
    ]);
    const fromGhosts = emphasize(nodes, edges, new Set([ghostA, ghostB]), 1, "reach", undefined, provenance);
    expect(fromGhosts).toEqual(fromOwners);
  });
});
