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

  it("focuses a selected ghost's adjacent block without removing or moving sibling ghosts", () => {
    const placeOrder = `${CORE}.placeOrder`;
    const assemble = `${CORE}.assemble`;
    const email = member(1);
    const pricing = member(2);
    const nodes = [
      coreNode(),
      codeMemberNode(placeOrder),
      codeMemberNode(assemble),
      ghostNode(email, 0),
      ghostNode(pricing, 1),
    ];
    const edges = [
      ghostEdge(email, 0, placeOrder),
      // The real orders-service fixture fans both calls out of placeOrder. Literal ghost focus must
      // light only the selected Email strand; resolving back to placeOrder would light Pricing too.
      ghostEdge(pricing, 1, placeOrder),
    ];
    const options = presentation(2, false);
    const fromCore = emphasize(nodes, edges, new Set([CORE]), 1, "node", options);
    const provenance = paintSeedsOf(fromCore.nodes, email);

    const fromEmail = emphasize(
      nodes,
      edges,
      new Set([email]),
      1,
      "node",
      options,
      provenance,
      new Set([email]),
    );

    const ghostGeometry = (level: typeof fromCore) => level.nodes
      .filter((node) => node.type === "ghost")
      .map((node) => ({ id: node.id, position: node.position, parentId: node.parentId }));
    expect(ghostGeometry(fromEmail)).toEqual(ghostGeometry(fromCore));
    expect(fromEmail.nodes.find((node) => node.id === placeOrder)?.style?.opacity).toBeUndefined();
    expect(fromEmail.nodes.find((node) => node.id === assemble)?.style?.opacity).toBe(0.28);
    expect(fromEmail.nodes.find((node) => node.id === email)?.style?.opacity).toBeUndefined();
    expect(fromEmail.nodes.find((node) => node.id === pricing)?.style?.opacity).toBe(0.28);
    expect(fromEmail.edges).toHaveLength(2);
    expect(fromEmail.edges.find((edge) => edge.target === email)?.style?.opacity).toBe(1);
    expect(fromEmail.edges.find((edge) => edge.target === pricing)?.style?.opacity).toBe(0.4);
  });

  it("focuses literal adjacency for selected ghosts from independent provenance families", () => {
    const ownerA = `${CORE}.ownerA`;
    const ownerB = `${CORE}.ownerB`;
    const ghostA = member(1);
    const siblingA = member(2);
    const ghostB = member(3);
    const siblingB = member(4);
    const nodes = [
      coreNode(),
      codeMemberNode(ownerA),
      codeMemberNode(ownerB),
      ghostNode(ghostA, 0),
      ghostNode(siblingA, 1),
      ghostNode(ghostB, 2),
      ghostNode(siblingB, 3),
    ];
    const edges = [
      ghostEdge(ghostA, 0, ownerA),
      ghostEdge(siblingA, 1, ownerA),
      ghostEdge(ghostB, 2, ownerB),
      ghostEdge(siblingB, 3, ownerB),
    ];
    const options = presentation(4, false);
    const fromOwners = emphasize(nodes, edges, new Set([ownerA, ownerB]), 1, "node", options);
    const focused = emphasize(
      nodes,
      edges,
      new Set([ghostA, ghostB]),
      1,
      "node",
      options,
      new Set([ownerA, ownerB]),
      new Set([ghostA, ghostB]),
    );

    const ghostGeometry = (level: typeof focused) => level.nodes
      .filter((node) => node.type === "ghost")
      .map((node) => ({ id: node.id, position: node.position }));
    expect(ghostGeometry(focused)).toEqual(ghostGeometry(fromOwners));
    expect(focused.nodes.find((node) => node.id === ownerA)?.style?.opacity).toBeUndefined();
    expect(focused.nodes.find((node) => node.id === ownerB)?.style?.opacity).toBeUndefined();
    expect(focused.nodes.find((node) => node.id === ghostA)?.style?.opacity).toBeUndefined();
    expect(focused.nodes.find((node) => node.id === ghostB)?.style?.opacity).toBeUndefined();
    expect(focused.nodes.find((node) => node.id === siblingA)?.style?.opacity).toBe(0.28);
    expect(focused.nodes.find((node) => node.id === siblingB)?.style?.opacity).toBe(0.28);
    expect(focused.edges.find((edge) => edge.target === ghostA)?.style?.opacity).toBe(1);
    expect(focused.edges.find((edge) => edge.target === ghostB)?.style?.opacity).toBe(1);
    expect(focused.edges.find((edge) => edge.target === siblingA)?.style?.opacity).toBe(0.4);
    expect(focused.edges.find((edge) => edge.target === siblingB)?.style?.opacity).toBe(0.4);
  });

  it("keeps a nested call step's visible block ancestors highlighted from a ghost selection", () => {
    const placeOrder = `${CORE}.placeOrder`;
    const callStep = `step:${placeOrder}:4`;
    const email = member(1);
    const nodes = [
      coreNode(),
      codeMemberNode(placeOrder),
      {
        id: callStep,
        type: "step",
        parentId: placeOrder,
        position: { x: 10, y: 10 },
        data: { stepKind: "call" },
        style: { width: 160, height: 40 },
      } as Node,
      ghostNode(email, 0),
    ];
    const edges = [ghostEdge(email, 0, callStep)];
    const options = presentation(1, false);
    const fromPlaceOrder = emphasize(nodes, edges, new Set([placeOrder]), 1, "node", options);
    const fromEmail = emphasize(
      nodes,
      edges,
      new Set([email]),
      1,
      "node",
      options,
      paintSeedsOf(fromPlaceOrder.nodes, email, [placeOrder]),
      new Set([email]),
    );

    expect(fromEmail.nodes.find((node) => node.id === callStep)?.style?.opacity).toBeUndefined();
    expect(fromEmail.nodes.find((node) => node.id === placeOrder)?.style?.opacity).toBeUndefined();
    expect(fromEmail.nodes.find((node) => node.id === CORE)?.style?.opacity).toBeUndefined();
    expect(fromEmail.edges[0].style?.opacity).toBe(1);
  });

  it("clears provenance beacons before focusing a ghost's literal adjacency", () => {
    const placeOrder = `${CORE}.placeOrder`;
    const callStep = `step:${placeOrder}:4`;
    const email = member(1);
    const realDefinition = "ts:notifications.ts#EmailService";
    const nodes = [
      coreNode(),
      codeMemberNode(placeOrder),
      {
        id: callStep,
        type: "step",
        parentId: placeOrder,
        position: { x: 10, y: 10 },
        data: { stepKind: "call" },
      } as Node,
      ghostNode(email, 0),
      { id: realDefinition, type: "file", position: { x: 700, y: 0 }, data: {} } as Node,
    ];
    const edges: Edge[] = [
      ghostEdge(email, 0, callStep),
      {
        id: "real-definition",
        source: callStep,
        target: realDefinition,
        data: { category: "dep", relationKind: "calls", depKind: "calls" },
      } as Edge,
    ];
    const focused = emphasize(
      nodes,
      edges,
      new Set([email]),
      1,
      "node",
      presentation(1, false),
      new Set([callStep]),
      new Set([email]),
    );

    const definition = focused.nodes.find((node) => node.id === realDefinition);
    expect(focused.beacons).toEqual(new Set());
    expect(definition?.style?.opacity).toBe(0.28);
    expect(definition?.style?.boxShadow).toBeUndefined();
    expect(definition?.style?.borderRadius).toBeUndefined();
  });

  it("keeps container neighbourhood semantics for a ghost plus file selection in reach mode", () => {
    const fileA: Node = { id: "file-a", type: "file", position: { x: 0, y: 0 }, data: {} } as Node;
    const fileB: Node = { id: "file-b", type: "file", position: { x: 300, y: 0 }, data: {} } as Node;
    const fileC: Node = { id: "file-c", type: "file", position: { x: 600, y: 0 }, data: {} } as Node;
    const email = member(1);
    const ghost = ghostNode(email, 0);
    const ghostWire = ghostEdge(email, 0, fileA.id);
    const importWire: Edge = {
      id: "file-b->file-c",
      source: fileB.id,
      target: fileC.id,
      data: { category: "import", relationKind: "imports", depKind: "imports" },
    } as Edge;

    const focused = emphasize(
      [fileA, fileB, fileC, ghost],
      [ghostWire, importWire],
      new Set([email, fileB.id]),
      1,
      "reach",
      presentation(1, false),
      new Set([fileA.id, fileB.id]),
      new Set([email, fileB.id]),
    );

    expect(focused.nodes.find((node) => node.id === fileC.id)?.style?.opacity).toBeUndefined();
    expect(focused.edges.find((edge) => edge.id === importWire.id)?.style?.opacity).toBe(1);
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

    const focusedGroup = emphasize(
      nodes,
      edges,
      new Set([PARENT]),
      1,
      "node",
      options,
      paintSeedsOf(fromCore.nodes, PARENT),
      new Set([PARENT]),
    );
    expect(focusedGroup.nodes.filter((node) => node.type === "ghost").map((node) => ({
      id: node.id,
      position: node.position,
    }))).toEqual(fromCore.nodes.filter((node) => node.type === "ghost").map((node) => ({
      id: node.id,
      position: node.position,
    })));
    expect(focusedGroup.nodes.find((node) => node.id === CORE)?.style?.opacity).toBeUndefined();
    expect(focusedGroup.nodes.find((node) => node.id === PARENT)?.style?.opacity).toBeUndefined();
    expect(focusedGroup.edges.find((edge) => edge.data?.ghostGroupAggregate === true)?.style?.opacity).toBe(1);
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

    const focusedExactChild = emphasize(
      nodes,
      edges,
      new Set([member(1)]),
      1,
      "node",
      options,
      paintSeedsOf(fromCore.nodes, member(1)),
      new Set([member(1)]),
    );
    expect(focusedExactChild.nodes.filter((node) => node.type === "ghost").map((node) => ({
      id: node.id,
      position: node.position,
      parentId: node.parentId,
    }))).toEqual(fromCore.nodes.filter((node) => node.type === "ghost").map((node) => ({
      id: node.id,
      position: node.position,
      parentId: node.parentId,
    })));
    expect(focusedExactChild.nodes.find((node) => node.id === CORE)?.style?.opacity).toBeUndefined();
    expect(focusedExactChild.nodes.find((node) => node.id === PARENT)?.style?.opacity).toBeUndefined();
    expect(focusedExactChild.nodes.find((node) => node.id === member(1))?.style?.opacity).toBeUndefined();
    expect(focusedExactChild.nodes.find((node) => node.id === member(2))?.style?.opacity).toBe(0.28);
    expect(focusedExactChild.edges.find((edge) => edge.data?.ghostGroupAggregate === true)?.style?.opacity).toBe(1);
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
