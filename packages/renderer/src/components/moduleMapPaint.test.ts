/**
 * The Map's paint rules: hiding closes over a hidden frame's drawn subtree (an expanded test file
 * takes its nested unit cards with it — the Tests toggle's contract), and a selection that is no
 * longer drawn paints as no-selection instead of dimming the whole level.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import type { Edge, Node } from "@xyflow/react";
import { buildGraphIndex } from "../graph/graphIndex";
import { ghostGroupId } from "../derive/groupGhosts";
import { emphasize, filterExternalGhosts, filterRelationsForLens, filterVisible, type HideOptions } from "./moduleMapPaint";
import { SERVICE_RELATION_POLICY } from "../graph/lensRelationPolicy";

/** Baseline options with nothing hidden; tests override the one filter they exercise. */
const SHOW_ALL: HideOptions = {
  hiddenCategories: new Set(),
  showTests: true,
  testIds: new Set(),
  showPrivate: true,
  privateIds: new Set(),
};

function fileNode(id: string, extra?: Partial<Node>): Node {
  return { id, type: "file", position: { x: 0, y: 0 }, data: { category: "app", isExpanded: false }, ...extra } as Node;
}

function unitNode(id: string, parentId: string): Node {
  return { id, type: "unit", position: { x: 0, y: 0 }, parentId, data: { unitKind: "class" } } as Node;
}

function edge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target, data: {} } as Edge;
}

function ghostNode(id: string, ghostKind = "function"): Node {
  return { id, type: "ghost", position: { x: 100, y: 100 }, data: { label: id, context: `${id}.ts`, ghostKind }, style: { width: 220, height: 54 } } as Node;
}

function ghostEdge(source: string, target: string, weight = 1, onDemand = true): Edge {
  return {
    id: `g:${source}->${target}`,
    source,
    target,
    data: { category: "dep", depKind: "calls", ghost: onDemand, weight },
  } as Edge;
}

describe("filterVisible — subtree closure", () => {
  it("hides an expanded test file's frame AND its nested unit cards when tests are hidden", () => {
    const frame = fileNode("ts:t.test.ts", { data: { category: "app", isExpanded: true } });
    const nodes = [frame, unitNode("ts:t.test.ts#Helper", "ts:t.test.ts"), fileNode("ts:prod.ts")];
    const edges = [edge("ts:t.test.ts", "ts:prod.ts"), edge("ts:t.test.ts#Helper", "ts:prod.ts")];
    const testIds = new Set(["ts:t.test.ts", "ts:t.test.ts#Helper"]);
    const shown = filterVisible(nodes, edges, { ...SHOW_ALL, showTests: false, testIds });
    expect(shown.nodes.map((n) => n.id)).toEqual(["ts:prod.ts"]);
    expect(shown.edges).toEqual([]);
  });

  it("hides an expanded file's unit cards with it when its category is toggled off", () => {
    const frame = fileNode("ts:cfg.ts", { data: { category: "config", isExpanded: true } });
    const nodes = [frame, unitNode("ts:cfg.ts#Settings", "ts:cfg.ts"), fileNode("ts:prod.ts")];
    const shown = filterVisible(nodes, [], { ...SHOW_ALL, hiddenCategories: new Set(["config"]) });
    expect(shown.nodes.map((n) => n.id)).toEqual(["ts:prod.ts"]);
  });

  it("hides private blocks (and their wires) in place when the Private toggle is off", () => {
    const frame = fileNode("ts:svc.ts", { data: { category: "app", isExpanded: true } });
    const priv: Node = { id: "ts:svc.ts#S.helper", type: "block", position: { x: 0, y: 0 }, parentId: "ts:svc.ts", data: { blockKind: "method" } } as Node;
    const pub: Node = { id: "ts:svc.ts#S.run", type: "block", position: { x: 0, y: 0 }, parentId: "ts:svc.ts", data: { blockKind: "method" } } as Node;
    const nodes = [frame, priv, pub];
    const edges = [edge("ts:svc.ts#S.run", "ts:svc.ts#S.helper")];
    const shown = filterVisible(nodes, edges, { ...SHOW_ALL, showPrivate: false, privateIds: new Set(["ts:svc.ts#S.helper"]) });
    // The private block vanishes IN PLACE — the frame and its sibling keep their positions.
    expect(shown.nodes.map((n) => n.id)).toEqual(["ts:svc.ts", "ts:svc.ts#S.run"]);
    expect(shown.edges).toEqual([]);
  });
});

describe("filterExternalGhosts", () => {
  it("hides only ext: ghost cards and their incident wires without moving the remaining graph", () => {
    const source = fileNode("ts:src/app.ts", { position: { x: 12, y: 34 } });
    const external = ghostNode("ext:rxjs#BehaviorSubject", "external");
    const workspace = ghostNode("ts:src/service.ts#Service");
    const unresolved = ghostNode("unresolved:dynamic-call", "unresolved");
    const nodes = [source, external, workspace, unresolved];
    const externalWire = ghostEdge(source.id, external.id);
    const workspaceWire = ghostEdge(source.id, workspace.id);
    const unresolvedWire = ghostEdge(source.id, unresolved.id);
    const legacyDanglingExternalWire = ghostEdge(source.id, "ext:legacy-package#missing-node");

    const shown = filterExternalGhosts(
      nodes,
      [externalWire, workspaceWire, unresolvedWire, legacyDanglingExternalWire],
      false,
    );

    expect(shown.nodes.map((node) => node.id)).toEqual([source.id, workspace.id, unresolved.id]);
    expect(shown.edges.map((wire) => wire.id)).toEqual([workspaceWire.id, unresolvedWire.id]);
    expect(shown.nodes[0].position).toEqual({ x: 12, y: 34 });
  });

  it("returns the laid-out arrays unchanged while external ghosts are enabled", () => {
    const nodes = [fileNode("ts:src/app.ts"), ghostNode("ext:rxjs#BehaviorSubject", "external")];
    const edges = [ghostEdge(nodes[0].id, nodes[1].id)];
    const shown = filterExternalGhosts(nodes, edges, true);
    expect(shown.nodes).toBe(nodes);
    expect(shown.edges).toBe(edges);
  });
});

describe("emphasize — beacon read (a selected call step's definition)", () => {
  it("withholds the step's dep wire, rings the definition, and flips a ghost's border", () => {
    const frame = fileNode("ts:svc.ts", { data: { category: "app", isExpanded: true } });
    const step: Node = { id: "step:ts:svc.ts#S.run:0", type: "step", position: { x: 0, y: 0 }, parentId: "ts:svc.ts", data: { stepKind: "call" } } as Node;
    const ghost: Node = { id: "ts:pay.ts#Gateway.charge", type: "ghost", position: { x: 0, y: 0 }, data: { label: "Gateway.charge" } } as Node;
    const dep: Edge = { id: "gdep:step->ghost", source: step.id, target: ghost.id, data: { category: "dep", ghost: true } } as Edge;
    const other: Edge = { id: "lvl:a->b", source: "ts:svc.ts", target: ghost.id, data: {} } as Edge;
    const { edges, nodes, beacons } = emphasize([frame, step, ghost], [dep, other], new Set([step.id]), 1, "reach");
    expect(beacons).toEqual(new Set([ghost.id]));
    // Dep wires are now the primary always-visible layer, so the beacon wire is withheld VISUALLY
    // (opacity 0) rather than removed: the definition reads through the ring, not a dangling wire.
    expect(edges.find((e) => e.id === dep.id)?.style?.opacity).toBe(0);
    expect(edges.find((e) => e.id === other.id)?.style?.opacity).not.toBe(0);
    const ringed = nodes.find((n) => n.id === ghost.id);
    expect(ringed?.style?.boxShadow).toContain("#6BE38A");
    expect((ringed?.data as { beacon?: boolean }).beacon).toBe(true);
  });

  it("keeps every wire and reports no beacons for a non-step selection", () => {
    const a = fileNode("ts:a.ts");
    const b = fileNode("ts:b.ts");
    const wire = edge("ts:a.ts", "ts:b.ts");
    const { beacons, edges } = emphasize([a, b], [wire], new Set(["ts:a.ts"]), 1, "reach");
    expect(beacons.size).toBe(0);
    expect(edges[0].style?.opacity).not.toBe(0);
  });
});

describe("emphasize — stale selection", () => {
  it("paints as no-selection when the selected id is no longer drawn (frame collapsed)", () => {
    const nodes = [fileNode("ts:a.ts"), fileNode("ts:b.ts")];
    const edges = [edge("ts:a.ts", "ts:b.ts")];
    const { nodes: styled } = emphasize(nodes, edges, new Set(["ts:a.ts#Gone"]), 1, "reach");
    // No node dims: the vanished selection must not fade the whole level.
    expect(styled.every((node) => node.style?.opacity === undefined)).toBe(true);
  });
});

describe("emphasize — whole logic-flow subgraph", () => {
  it("highlights flow members and their internal wire without revealing unrelated incident ghosts", () => {
    const frame = fileNode("ts:root.ts", { data: { category: "app", isExpanded: true } });
    const root: Node = {
      id: "ts:root.ts#run",
      type: "block",
      parentId: frame.id,
      position: { x: 0, y: 0 },
      data: { blockKind: "function" },
    } as Node;
    const flowTarget = ghostNode("ts:flow.ts#target");
    const unrelatedGhost = ghostNode("ts:other.ts#helper");
    const unrelatedReal = fileNode("ts:unrelated.ts");
    const internal = ghostEdge(root.id, flowTarget.id);
    const outside = ghostEdge(root.id, unrelatedGhost.id);

    const painted = emphasize(
      [frame, root, flowTarget, unrelatedGhost, unrelatedReal],
      [internal, outside],
      new Set([root.id, flowTarget.id]),
      1,
      "subgraph",
    );

    expect(painted.nodes.map((node) => node.id)).toEqual([frame.id, root.id, flowTarget.id, unrelatedReal.id]);
    expect(painted.nodes.find((node) => node.id === frame.id)?.style?.opacity).toBeUndefined();
    expect(painted.nodes.find((node) => node.id === unrelatedReal.id)?.style?.opacity).toBe(0.28);
    expect(painted.edges).toHaveLength(1);
    expect(painted.edges[0]).toMatchObject({ id: internal.id, style: expect.objectContaining({ opacity: 1 }) });
  });

  it("retains an explicitly highlighted flow ghost even when its chart edge is absent", () => {
    const isolated = ghostNode("ts:flow.ts#isolated");
    const painted = emphasize([isolated], [], new Set([isolated.id]), 1, "subgraph");
    expect(painted.nodes).toContainEqual(expect.objectContaining({ id: isolated.id }));
  });
});

describe("emphasize — complete semantic ghosts", () => {
  it("shows every related caller and dependency", () => {
    const anchor = fileNode("ts:anchor.ts");
    const incoming = Array.from({ length: 23 }, (_, index) => ghostNode(`ts:caller-${index}.ts#run`));
    const outgoing = Array.from({ length: 23 }, (_, index) => ghostNode(`ts:dep-${index}.ts#run`));
    const edges = [
      ...incoming.map((ghost) => ghostEdge(ghost.id, anchor.id)),
      ...outgoing.map((ghost) => ghostEdge(anchor.id, ghost.id)),
    ];

    const painted = emphasize([anchor, ...incoming, ...outgoing], edges, new Set([anchor.id]), 1, "node");

    expect(painted.nodes.filter((node) => node.type === "ghost")).toHaveLength(46);
    expect(painted.edges).toHaveLength(46);
  });

  it("keeps exact callables and an honest module fallback instead of ranking either away", () => {
    const anchor = fileNode("ts:anchor.ts");
    const exact = Array.from({ length: 8 }, (_, index) => ghostNode(`ts:dep-${index}.ts#run`, "method"));
    const fallback = ghostNode("ts:fallback.ts", "module");
    const edges = [
      ...exact.map((ghost) => ghostEdge(anchor.id, ghost.id)),
      ghostEdge(anchor.id, fallback.id, 100),
    ];

    const painted = emphasize([anchor, ...exact, fallback], edges, new Set([anchor.id]), 1, "node");

    expect(painted.nodes.filter((node) => node.type === "ghost")).toHaveLength(9);
    expect(painted.nodes.some((node) => node.id === fallback.id)).toBe(true);
  });

  it("keeps every minimal-overlay satellite visible at rest", () => {
    const anchor = fileNode("ts:anchor.ts");
    const satellites = Array.from({ length: 31 }, (_, index) => ghostNode(`ts:satellite-${index}.ts#run`));
    const edges = satellites.map((ghost) => ghostEdge(anchor.id, ghost.id, 1, false));

    const painted = emphasize([anchor, ...satellites], edges, new Set(), 1, "node");

    expect(painted.nodes.filter((node) => node.type === "ghost")).toHaveLength(31);
    expect(painted.edges).toHaveLength(31);
  });

  it("keeps every related ghost across a multi-selection", () => {
    const anchors = [fileNode("ts:a.ts"), fileNode("ts:b.ts")];
    const ghosts = anchors.flatMap((_anchor, anchorIndex) =>
      Array.from({ length: 6 }, (_, index) => ghostNode(`ts:${anchorIndex}-${index}.ts#run`)),
    );
    const edges = ghosts.map((ghost, index) => ghostEdge(anchors[index < 6 ? 0 : 1].id, ghost.id));

    const painted = emphasize([...anchors, ...ghosts], edges, new Set(anchors.map((node) => node.id)), 1, "node");

    expect(painted.nodes.filter((node) => node.type === "ghost")).toHaveLength(12);
    expect(painted.edges).toHaveLength(12);
  });

  it("keeps a persistent parent anchor and discloses exact children as its neighbours", () => {
    const anchor = fileNode("ts:anchor.ts");
    const parentId = "ts:dep.ts#Worker";
    const ids = [1, 2, 3, 4].map((index) => `${parentId}.m${index}`);
    const graphNodes: GraphNode[] = [
      { id: "ts:dep.ts", kind: "module", qualifiedName: "dep.ts", displayName: "dep.ts", parentId: null, location: { file: "dep.ts", startLine: 1 } },
      { id: parentId, kind: "class", qualifiedName: "Worker", displayName: "Worker", parentId: "ts:dep.ts", location: { file: "dep.ts", startLine: 1 } },
      ...ids.map((id, index) => ({ id, kind: "method", qualifiedName: `Worker.m${index + 1}`, displayName: `m${index + 1}`, parentId, location: { file: "dep.ts", startLine: index + 2 } } as GraphNode)),
    ];
    const index = buildGraphIndex({ nodes: graphNodes, edges: [] } as unknown as GraphArtifact);
    const ghosts = ids.map((id) => ghostNode(id, "method"));
    const edges = ghosts.map((ghost) => ghostEdge(anchor.id, ghost.id));
    const groupId = ghostGroupId("outgoing", parentId);

    const grouped = emphasize([anchor, ...ghosts], edges, new Set([anchor.id]), 1, "node", {
      index,
      groupByParent: true,
      expandedGroupIds: new Set(),
    });
    expect(grouped.nodes.filter((node) => node.type === "ghost").map((node) => node.id)).toEqual([groupId]);
    expect(grouped.edges).toEqual([
      expect.objectContaining({ source: anchor.id, target: parentId }),
    ]);

    const expanded = emphasize([anchor, ...ghosts], edges, new Set([anchor.id]), 1, "node", {
      index,
      groupByParent: true,
      expandedGroupIds: new Set([groupId]),
    });
    expect(expanded.nodes.filter((node) => node.type === "ghost").map((node) => node.id).sort()).toEqual([parentId, ...ids].sort());
    expect(expanded.edges.filter((edge) => edge.data?.edgeRole === "ghost-hierarchy")).toHaveLength(4);
    expect(expanded.edges.filter((edge) => edge.data?.edgeRole === "ghost-hierarchy").every((edge) => edge.source === parentId)).toBe(true);
    expect(expanded.edges.filter((edge) => edge.data?.ghostGroupAggregate === true)).toEqual([
      expect.objectContaining({ source: anchor.id, target: parentId }),
    ]);

    // The parent is a paint-time card: selecting its real id must seed from the canonical children
    // on the next repaint, or the selected card would immediately disappear.
    const selectedParent = emphasize([anchor, ...ghosts], edges, new Set([parentId]), 1, "node", {
      index,
      groupByParent: true,
      expandedGroupIds: new Set(),
    });
    expect(selectedParent.nodes.filter((node) => node.type === "ghost").map((node) => node.id)).toEqual([parentId]);
    expect(selectedParent.edges).toEqual([
      expect.objectContaining({ source: anchor.id, target: parentId }),
    ]);
  });
});

describe("lens relation filtering", () => {
  it("starts Service on structure and can opt behavioral calls back in", () => {
    const dep = (kind: string): Edge => ({
      id: `${kind}:a->b`,
      source: "a",
      target: "b",
      data: { category: "dep", relationKind: kind, depKind: kind },
    } as Edge);
    const edges = [
      dep("registers"),
      dep("extends"),
      dep("calls"),
      { id: "unknown-dep", source: "a", target: "b", data: { category: "dep" } } as Edge,
      { id: "flow", source: "a", target: "b", data: { category: "flow" } } as Edge,
    ];
    const kindOf = (item: Edge) => item.data?.relationKind ?? item.data?.category;

    expect(filterRelationsForLens(edges, SERVICE_RELATION_POLICY, {}).map(kindOf))
      .toEqual(["registers", "extends", "flow"]);
    expect(filterRelationsForLens(edges, SERVICE_RELATION_POLICY, { service: { calls: true } }))
      .toHaveLength(4);
  });
});
