import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import type { Edge, Node } from "@xyflow/react";
import { buildGraphIndex } from "../graph/graphIndex";
import type { GhostData } from "./ghostDeps";
import { ghostGroupId, groupLitGhosts, MAX_UNGROUPED_GHOST_SIBLINGS, type GhostGroupData } from "./groupGhosts";

const CORE = "ts:app.ts#selected";
const FILE = "ts:dep.ts";
const PARENT = `${FILE}#Alpha`;

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

function fixtureIndex(memberCount = 6) {
  const nodes: GraphNode[] = [
    graphNode(FILE, "module", null, "dep.ts"),
    graphNode(PARENT, "class", FILE, "Alpha"),
  ];
  for (let index = 1; index <= memberCount; index += 1) {
    nodes.push(graphNode(member(index), "method", PARENT, `m${index}`));
  }
  return buildGraphIndex({ nodes, edges: [] } as unknown as GraphArtifact);
}

function coreNode(id = CORE): Node {
  return { id, type: "unit", position: { x: 0, y: 0 }, data: {}, style: { width: 240, height: 90 } } as Node;
}

function ghostNode(id: string, overrides: Partial<GhostData> = {}, x = 300): Node {
  return {
    id,
    type: "ghost",
    position: { x, y: 10 },
    data: { label: id, context: `${id}.ts`, ghostKind: "method", ...overrides },
    style: { width: 220, height: 54 },
  } as Node;
}

function wire(
  id: string,
  source: string,
  target: string,
  kind = "calls",
  weight = 1,
  extras: { crossPackage?: boolean; outsideView?: boolean; underlyingEdgeIds?: string[]; style?: Edge["style"]; markerEnd?: Edge["markerEnd"] } = {},
): Edge {
  return {
    id,
    source,
    target,
    data: {
      category: "dep",
      depKind: kind,
      ghost: true,
      weight,
      crossPackage: extras.crossPackage ?? false,
      outsideView: extras.outsideView ?? true,
      underlyingEdgeIds: extras.underlyingEdgeIds ?? [id],
    },
    ...(extras.style === undefined ? {} : { style: extras.style }),
    ...(extras.markerEnd === undefined ? {} : { markerEnd: extras.markerEnd }),
  };
}

const options = (overrides: Partial<Parameters<typeof groupLitGhosts>[3]> = {}) => ({
  enabled: true,
  expandedGroupIds: new Set<string>(),
  ...overrides,
});

function exactMembers(count = 4): Node[] {
  return Array.from({ length: count }, (_, index) => ghostNode(member(index + 1)));
}

function ghostIds(nodes: readonly Node[]): string[] {
  return nodes.filter((node) => node.type === "ghost").map((node) => node.id).sort();
}

function hierarchyEdges(edges: readonly Edge[]): Edge[] {
  return edges.filter((edge) => edge.data?.edgeRole === "ghost-hierarchy");
}

describe("groupLitGhosts — persistent real-parent anchors", () => {
  it("is identity when disabled and leaves three siblings exact", () => {
    const four = exactMembers();
    const edges = four.map((node, index) => wire(`e${index}`, CORE, node.id));
    const disabledNodes = [coreNode(), ...four];
    const disabled = groupLitGhosts(disabledNodes, edges, fixtureIndex(), options({ enabled: false }));
    expect(disabled.nodes).toBe(disabledNodes);
    expect(disabled.edges).toBe(edges);

    const three = four.slice(0, MAX_UNGROUPED_GHOST_SIBLINGS);
    const threeEdges = edges.slice(0, MAX_UNGROUPED_GHOST_SIBLINGS);
    const unchangedNodes = [coreNode(), ...three];
    const unchanged = groupLitGhosts(unchangedNodes, threeEdges, fixtureIndex(), options());
    expect(unchanged.nodes).toBe(unchangedNodes);
    expect(unchanged.edges).toBe(threeEdges);
  });

  it("collapses four outgoing siblings into their one real parent and aggregates evidence", () => {
    const children = exactMembers();
    const edges = children.map((node, index) => wire(
      `e${index + 1}`,
      CORE,
      node.id,
      "calls",
      index + 1,
      { crossPackage: index === 2, underlyingEdgeIds: [`artifact-${index + 1}`] },
    ));

    const result = groupLitGhosts([coreNode(), ...children], edges, fixtureIndex(), options());
    const parent = result.nodes.find((node) => node.id === PARENT)!;
    const data = parent.data as unknown as GhostGroupData;
    const aggregate = result.edges[0];

    expect(ghostGroupId("incoming", PARENT)).toBe(PARENT);
    expect(ghostGroupId("outgoing", PARENT)).toBe(PARENT);
    expect(ghostIds(result.nodes)).toEqual([PARENT]);
    expect(data).toMatchObject({
      label: "Alpha",
      ghostKind: "class",
      ghostGroupId: PARENT,
      ghostParentId: PARENT,
      ghostRole: "parent-anchor",
      ghostPromotable: true,
      ghostExpanded: false,
      ghostDirections: ["outgoing"],
      ghostDirection: "outgoing",
      groupedGhostCount: 4,
    });
    expect(data.semanticMembers?.map((entry) => entry.id)).toEqual(children.map((node) => node.id));
    expect(result.edges).toHaveLength(1);
    expect(aggregate).toMatchObject({ source: CORE, target: PARENT });
    expect(aggregate.data).toMatchObject({
      weight: 10,
      crossPackage: true,
      ghostGroupAggregate: true,
      groupedGhostIds: children.map((node) => node.id),
      groupedGhostCount: 4,
      underlyingEdgeIds: ["artifact-1", "artifact-2", "artifact-3", "artifact-4"],
    });
  });

  it("keeps the parent and exact children expanded, with parent→child presentation spokes", () => {
    const children = exactMembers();
    const edges = children.map((node, index) => wire(`e${index + 1}`, CORE, node.id));
    const result = groupLitGhosts(
      [coreNode(), ...children],
      edges,
      fixtureIndex(),
      options({ expandedGroupIds: new Set([PARENT]) }),
    );
    const parentData = result.nodes.find((node) => node.id === PARENT)?.data as unknown as GhostGroupData;
    const spokes = hierarchyEdges(result.edges);

    expect(ghostIds(result.nodes)).toEqual([PARENT, ...children.map((node) => node.id)].sort());
    expect(parentData.ghostExpanded).toBe(true);
    expect(result.edges.filter((edge) => edge.data?.ghostGroupAggregate === true)).toHaveLength(1);
    expect(spokes).toHaveLength(4);
    expect(spokes.every((edge) => edge.type === "ghostHierarchy" && edge.source === PARENT)).toBe(true);
    expect(spokes.map((edge) => edge.target).sort()).toEqual(children.map((node) => node.id).sort());
    expect(spokes.every((edge) =>
      edge.data?.presentationOnly === true &&
      edge.data?.ghostParentId === PARENT &&
      edge.data?.ghostDirection === "outgoing" &&
      edge.data?.category === undefined &&
      edge.data?.depKind === undefined &&
      edge.data?.underlyingEdgeIds === undefined
    )).toBe(true);
    for (const child of children) {
      expect(result.nodes.find((node) => node.id === child.id)?.data).toMatchObject({
        ghostHierarchyMember: true,
        ghostGroupParentId: PARENT,
        ghostHierarchyDirections: ["outgoing"],
        ghostDirection: "outgoing",
      });
    }
  });

  it("uses child→parent presentation spokes for an incoming sibling group", () => {
    const children = exactMembers();
    const edges = children.map((node, index) => wire(`e${index + 1}`, node.id, CORE));
    const result = groupLitGhosts(
      [coreNode(), ...children],
      edges,
      fixtureIndex(),
      options({ expandedGroupIds: new Set([PARENT]) }),
    );
    const evidence = result.edges.find((edge) => edge.data?.ghostGroupAggregate === true)!;
    const spokes = hierarchyEdges(result.edges);

    expect(evidence).toMatchObject({ source: PARENT, target: CORE });
    expect(spokes).toHaveLength(4);
    expect(spokes.every((edge) => edge.target === PARENT && edge.data?.ghostDirection === "incoming")).toBe(true);
  });

  it("shares one parent card across qualifying directions and emits one deterministic spoke per child", () => {
    const children = exactMembers();
    const edges = children.flatMap((node, index) => [
      wire(`out-${index}`, CORE, node.id),
      wire(`in-${index}`, node.id, CORE),
    ]);
    const collapsed = groupLitGhosts([coreNode(), ...children], edges, fixtureIndex(), options());
    expect(ghostIds(collapsed.nodes)).toEqual([PARENT]);
    expect(collapsed.edges).toHaveLength(2);
    expect(collapsed.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: CORE, target: PARENT }),
      expect.objectContaining({ source: PARENT, target: CORE }),
    ]));

    const expanded = groupLitGhosts(
      [coreNode(), ...children],
      edges,
      fixtureIndex(),
      options({ expandedGroupIds: new Set([PARENT]) }),
    );
    const data = expanded.nodes.find((node) => node.id === PARENT)?.data as unknown as GhostGroupData;
    const spokes = hierarchyEdges(expanded.edges);
    expect(data.ghostDirections).toEqual(["incoming", "outgoing"]);
    expect(data.ghostDirection).toBe("outgoing");
    expect(spokes).toHaveLength(4);
    expect(spokes.every((edge) => {
      const directions = (edge.data as { ghostHierarchyDirections?: unknown[] } | undefined)?.ghostHierarchyDirections;
      return edge.source === PARENT && directions?.length === 2;
    })).toBe(true);
  });

  it("reuses an existing exact parent card and merges its own edge evidence with its children", () => {
    const recursiveData: GhostData = {
      label: "m1",
      context: "dep.ts",
      ghostKind: "method",
      semanticMembers: [{ id: "old", data: { label: "old", context: "old.ts", ghostKind: "function" } }],
    };
    const children = [ghostNode(member(1), recursiveData), ...exactMembers().slice(1)];
    const existingParent = ghostNode(PARENT, { label: "Alpha exact", context: "dep.ts", ghostKind: "class" }, 515);
    const markerEnd = "url(#arrow)";
    const parentEdge = wire("parent-edge", CORE, PARENT, "calls", 5, {
      underlyingEdgeIds: ["parent-artifact"],
      style: { opacity: 1, stroke: "#abc" },
      markerEnd,
    });
    const childEdges = children.map((node, index) => wire(`child-${index}`, CORE, node.id));

    const result = groupLitGhosts(
      [coreNode(), existingParent, ...children],
      [parentEdge, ...childEdges],
      fixtureIndex(),
      options(),
    );
    const parents = result.nodes.filter((node) => node.id === PARENT);
    const data = parents[0].data as unknown as GhostGroupData;
    const aggregate = result.edges[0];

    expect(parents).toHaveLength(1);
    expect(parents[0].position.x).toBe(515);
    expect(data.label).toBe("Alpha exact");
    expect(data.semanticMembers?.map((entry) => entry.id)).toEqual(children.map((node) => node.id));
    expect(data.semanticMembers?.[0].data.semanticMembers).toBeUndefined();
    expect(aggregate.data).toMatchObject({ weight: 9, groupedGhostCount: 4 });
    expect(aggregate.data?.underlyingEdgeIds).toEqual(["child-0", "child-1", "child-2", "child-3", "parent-artifact"]);
    expect(aggregate.style).toEqual({ opacity: 1, stroke: "#abc" });
    expect(aggregate.markerEnd).toBe(markerEnd);
  });

  it("keeps a child exact when its opposite direction does not qualify", () => {
    const children = exactMembers();
    const edges = [
      ...children.map((node, index) => wire(`out-${index}`, CORE, node.id)),
      wire("lone-in", children[0].id, CORE, "references"),
    ];
    const result = groupLitGhosts([coreNode(), ...children], edges, fixtureIndex(), options());

    expect(ghostIds(result.nodes)).toEqual([PARENT, children[0].id].sort());
    expect(result.edges.find((edge) => edge.id === "lone-in")).toMatchObject({ source: children[0].id, target: CORE });
  });

  it("leaves protected/beacon children exact and groups a remaining crowd of four", () => {
    const children = exactMembers(6);
    children[1] = ghostNode(member(2), { beacon: true });
    const edges = children.map((node, index) => wire(`e${index}`, CORE, node.id));
    const result = groupLitGhosts(
      [coreNode(), ...children],
      edges,
      fixtureIndex(),
      options({ protectedGhostIds: new Set([member(1)]) }),
    );

    expect(ghostIds(result.nodes)).toEqual([PARENT, member(1), member(2)].sort());
    const data = result.nodes.find((node) => node.id === PARENT)?.data as unknown as GhostGroupData;
    expect(data.groupedGhostIds).toEqual([member(3), member(4), member(5), member(6)]);
  });

  it("skips grouping when the real parent id is already occupied by a core node", () => {
    const children = exactMembers();
    const parentCore = coreNode(PARENT);
    const edges = children.map((node, index) => wire(`e${index}`, CORE, node.id));
    const inputNodes = [coreNode(), parentCore, ...children];

    const result = groupLitGhosts(inputNodes, edges, fixtureIndex(), options());

    expect(result.nodes).toBe(inputNodes);
    expect(result.edges).toBe(edges);
  });
});
