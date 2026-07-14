import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type { BlockData, ModuleCardData } from "./moduleLevel";
import type { GhostData } from "./ghostDeps";
import type { ModuleGroupData, ModuleTree, ModuleTreeEdge, VisibleModuleNode } from "./moduleTreeTypes";
import { decorateGhostInspectionTree } from "./ghostInspection";

const ROOT = "pkg:root";
const A_FILE = "ts:a.ts";
const A = `${A_FILE}#placeOrder`;
const B_FILE = "ts:b.ts";
const B = `${B_FILE}#sendConfirmation`;
const C_FILE = "ts:c.ts";
const C = `${C_FILE}#writeMessage`;
const D_FILE = "ts:d.ts";
const D = `${D_FILE}#triggerConfirmation`;
const E_FILE = "ts:e.ts";
const E = `${E_FILE}#deliver`;
const X_FILE = "ts:x.ts";
const X = `${X_FILE}#unrelated`;

function graphNode(id: string, kind: string, parentId: string | null): GraphNode {
  return {
    id,
    kind,
    parentId,
    displayName: id,
    qualifiedName: id,
    location: { file: id, startLine: 1 },
  } as GraphNode;
}

const index = buildGraphIndex({
  nodes: [
    graphNode(ROOT, "package", null),
    graphNode(A_FILE, "module", ROOT),
    graphNode(A, "method", A_FILE),
    graphNode(B_FILE, "module", ROOT),
    graphNode(B, "method", B_FILE),
    graphNode(C_FILE, "module", ROOT),
    graphNode(C, "function", C_FILE),
    graphNode(D_FILE, "module", ROOT),
    graphNode(D, "function", D_FILE),
    graphNode(E_FILE, "module", ROOT),
    graphNode(E, "function", E_FILE),
    graphNode(X_FILE, "module", ROOT),
    graphNode(X, "function", X_FILE),
  ],
  edges: [],
} as unknown as GraphArtifact);

function packageNode(id: string): VisibleModuleNode {
  const data: ModuleGroupData = {
    label: id,
    fileCount: 6,
    ca: 0,
    ce: 0,
    isContainer: true,
    isExpanded: true,
  };
  return { id, parentId: null, kind: "package", isContainer: true, isExpanded: true, depth: 0, childCount: 6, data };
}

function fileNode(id: string): VisibleModuleNode {
  const data: ModuleCardData = {
    label: id,
    fullPath: id,
    category: "app",
    inCount: 0,
    outCount: 0,
    isEntry: false,
    isContainer: true,
    isExpanded: true,
    unitCount: 1,
  };
  return { id, parentId: ROOT, kind: "file", isContainer: true, isExpanded: true, depth: 1, childCount: 1, data };
}

function blockNode(id: string, parentId: string | null): VisibleModuleNode {
  const data: BlockData = { label: id, blockKind: "function", callable: true, expandable: false, emptyFlow: false, childCount: 0, isExpanded: false };
  return { id, parentId, kind: "block", isContainer: false, isExpanded: false, depth: parentId === null ? 0 : 2, childCount: 0, data };
}

function ghostNode(id: string): VisibleModuleNode {
  const data: GhostData = { label: id, context: `${id}.ts`, ghostKind: "function" };
  return { id, parentId: null, kind: "ghost", isContainer: false, isExpanded: false, depth: 0, childCount: 0, data };
}

function depEdge(id: string, source: string, target: string, kind = "calls", ghost = false): ModuleTreeEdge {
  return {
    id,
    source,
    target,
    weight: 1,
    crossFrame: false,
    crossPackage: false,
    outsideView: ghost,
    category: "dep",
    relationKind: kind,
    depKind: kind,
    ghost: ghost || undefined,
  };
}

function fixture(): ModuleTree {
  return {
    effectiveFocus: null,
    nodes: [
      packageNode(ROOT),
      fileNode(A_FILE),
      blockNode(A, A_FILE),
      fileNode(B_FILE),
      // B models the exact extra root materialized from the clicked ghost.
      blockNode(B, null),
      ghostNode(C),
      ghostNode(D),
      ghostNode(E),
      ghostNode(X),
    ],
    edges: [
      // The original anchor reached B through a non-call relationship. It remains the direct bridge
      // into the visited seed even though only B's new CALL neighbours may expand the trail.
      depEdge("ref:a-b", A, B, "references", true),
      depEdge("call:b-c", B, C, "calls", true),
      depEdge("call:d-b", D, B, "calls", true),
      // A frontier's own call is a second hop and must wait until C is explicitly visited.
      depEdge("call:c-e", C, E, "calls", true),
      depEdge("ref:b-x", B, X, "references", true),
      // Every relation in the provenance anchor's original ghost ring stays visible.
      depEdge("impl:a-x", A, X, "implements", true),
    ],
  };
}

const dataOf = (tree: ModuleTree, id: string) => tree.nodes.find((node) => node.id === id)!.data;
const edgeOf = (tree: ModuleTree, id: string) => tree.edges.find((edge) => edge.id === id)!;

describe("decorateGhostInspectionTree", () => {
  it("retains the anchor's original ring while adding only the visit's incoming/outgoing one-hop calls", () => {
    const base = fixture();
    const decorated = decorateGhostInspectionTree(base, index, {
      anchorIds: new Set([A]),
      visitedIds: new Set([B]),
    }, new Set());

    expect(dataOf(decorated, A)).toMatchObject({ ghostInspectionPath: true });
    expect(dataOf(decorated, B)).toMatchObject({
      ghostInspectionPath: true,
      ghostInspectionVisited: true,
      ghostInspectionPreview: true,
    });
    expect(dataOf(decorated, C)).toMatchObject({ ghostInspectionPath: true, ghostInspectionFrontier: true });
    expect(dataOf(decorated, D)).toMatchObject({ ghostInspectionPath: true, ghostInspectionFrontier: true });

    expect(edgeOf(decorated, "ref:a-b").ghostInspectionPath).toBe(true);
    expect(edgeOf(decorated, "call:b-c").ghostInspectionPath).toBe(true);
    expect(edgeOf(decorated, "call:d-b").ghostInspectionPath).toBe(true);
    expect(edgeOf(decorated, "call:c-e").ghostInspectionPath).toBeUndefined();
    expect(edgeOf(decorated, "ref:b-x").ghostInspectionPath).toBeUndefined();
    expect(edgeOf(decorated, "impl:a-x").ghostInspectionPath).toBe(true);
    expect(dataOf(decorated, E).ghostInspectionPath).toBeUndefined();
    expect(dataOf(decorated, X)).toMatchObject({ ghostInspectionPath: true, ghostInspectionFrontier: true });

    // The decorator never mutates its already-derived input.
    expect(dataOf(base, B).ghostInspectionPath).toBeUndefined();
    expect(edgeOf(base, "call:b-c").ghostInspectionPath).toBeUndefined();
  });

  it("marks canonical and drawn containment ancestors so their clicks remain inside the path", () => {
    const decorated = decorateGhostInspectionTree(fixture(), index, {
      anchorIds: new Set([A]),
      visitedIds: new Set([B]),
    }, new Set());

    // A is visibly nested under A_FILE; B is a detached exact root, but B_FILE is still its
    // canonical GraphIndex ancestor. ROOT is shared by both ancestry paths.
    expect(dataOf(decorated, A_FILE).ghostInspectionPath).toBe(true);
    expect(dataOf(decorated, B_FILE).ghostInspectionPath).toBe(true);
    expect(dataOf(decorated, ROOT).ghostInspectionPath).toBe(true);
  });

  it("retains a container anchor's ghost ring and bridge when wires terminate on its drawn child", () => {
    const decorated = decorateGhostInspectionTree(fixture(), index, {
      anchorIds: new Set([A_FILE]),
      visitedIds: new Set([B]),
    }, new Set());

    expect(dataOf(decorated, A_FILE).ghostInspectionPath).toBe(true);
    expect(dataOf(decorated, A)).toMatchObject({ ghostInspectionPath: true });
    expect(dataOf(decorated, A).ghostInspectionFrontier).toBeUndefined();
    expect(edgeOf(decorated, "ref:a-b").ghostInspectionPath).toBe(true);
    expect(edgeOf(decorated, "impl:a-x").ghostInspectionPath).toBe(true);
  });

  it("does not mark a visited exact node as preview once a committed extra root covers it", () => {
    const inspect = { anchorIds: new Set([A]), visitedIds: new Set([B]) };
    const committed = decorateGhostInspectionTree(fixture(), index, inspect, new Set([B_FILE]));
    const exactCommitted = decorateGhostInspectionTree(fixture(), index, inspect, new Set([B]));
    const unrelated = decorateGhostInspectionTree(fixture(), index, inspect, new Set([X_FILE]));

    expect(dataOf(committed, B)).toMatchObject({ ghostInspectionPath: true, ghostInspectionVisited: true });
    expect(dataOf(committed, B).ghostInspectionPreview).toBeUndefined();
    expect(dataOf(exactCommitted, B).ghostInspectionPreview).toBeUndefined();
    expect(dataOf(unrelated, B).ghostInspectionPreview).toBe(true);
  });

  it("extends exactly one more hop only after the prior frontier is explicitly visited", () => {
    const decorated = decorateGhostInspectionTree(fixture(), index, {
      anchorIds: new Set([A]),
      visitedIds: new Set([B, C]),
    }, new Set());

    expect(dataOf(decorated, C)).toMatchObject({
      ghostInspectionPath: true,
      ghostInspectionVisited: true,
      ghostInspectionPreview: true,
    });
    expect(dataOf(decorated, C).ghostInspectionFrontier).toBeUndefined();
    expect(dataOf(decorated, E)).toMatchObject({ ghostInspectionPath: true, ghostInspectionFrontier: true });
    expect(edgeOf(decorated, "call:c-e").ghostInspectionPath).toBe(true);
  });

  it("clears stale markers and otherwise preserves identity when inspection is empty", () => {
    const base = fixture();
    const unchanged = decorateGhostInspectionTree(base, index, null, new Set());
    expect(unchanged).toBe(base);

    const decorated = decorateGhostInspectionTree(base, index, {
      anchorIds: new Set([A]),
      visitedIds: new Set([B]),
    }, new Set());
    const cleared = decorateGhostInspectionTree(decorated, index, null, new Set());
    expect(dataOf(cleared, B).ghostInspectionPath).toBeUndefined();
    expect(dataOf(cleared, B).ghostInspectionPreview).toBeUndefined();
    expect(edgeOf(cleared, "ref:a-b").ghostInspectionPath).toBeUndefined();
  });
});
