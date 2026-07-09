import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "../graph/graphIndex";
import { deriveReviewNodeGraph } from "./reviewNodeGraph";
import type { ChangedFile, GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";

function node(id: string, kind: string, file: string, startLine: number, endLine: number, parentId: string | null): GraphNode {
  return {
    id,
    kind: kind as GraphNode["kind"],
    qualifiedName: id,
    displayName: id.split(/[#.]/).pop() ?? id,
    location: { file, startLine, endLine },
    parentId,
  };
}

function index(nodes: GraphNode[], edges: GraphEdge[]) {
  return buildGraphIndex({ nodes, edges } as GraphArtifact);
}

const NODES: GraphNode[] = [
  node("ts:a.ts", "module", "a.ts", 1, 100, null),
  node("ts:a.ts#C", "class", "a.ts", 6, 50, "ts:a.ts"),
  node("ts:a.ts#C.m", "method", "a.ts", 40, 44, "ts:a.ts#C"),
  node("ts:a.ts#C.other", "method", "a.ts", 10, 15, "ts:a.ts#C"),
  node("ts:a.ts#top", "function", "a.ts", 60, 70, "ts:a.ts"),
  node("ts:b.ts", "module", "b.ts", 1, 20, null),
  node("ts:b.ts#helper", "function", "b.ts", 1, 5, "ts:b.ts"),
];

const EDGES: GraphEdge[] = [
  { id: "e1", source: "ts:a.ts#C.m", target: "ts:b.ts#helper", kind: "calls", resolution: "resolved" },
];

describe("deriveReviewNodeGraph", () => {
  it("emits file frames, class frames, and the changed leaf blocks — never whole files", () => {
    const changed: ChangedFile[] = [
      { path: "a.ts", status: "modified", hunks: [{ start: 40, end: 44 }] },
      { path: "b.ts", status: "added" },
    ];
    const graph = deriveReviewNodeGraph(index(NODES, EDGES), changed);

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // The class encloses the hunk, so it appears — but as a FRAME (its method is the leaf), not a leaf.
    expect(byId.get("ts:a.ts#C")?.kind).toBe("reviewGroup");
    expect(byId.get("ts:a.ts#C")?.isContainer).toBe(true);
    // The edited method is a leaf block, nested inside its class frame.
    expect(byId.get("ts:a.ts#C.m")?.kind).toBe("reviewBlock");
    expect(byId.get("ts:a.ts#C.m")?.parentId).toBe("ts:a.ts#C");
    // The class frame nests inside the file frame.
    expect(byId.get("ts:a.ts#C")?.parentId).toBe("revfile:a.ts");
    // The whole-file (no-hunk) add surfaces its function directly under the file frame.
    expect(byId.get("ts:b.ts#helper")?.kind).toBe("reviewBlock");
    expect(byId.get("ts:b.ts#helper")?.parentId).toBe("revfile:b.ts");
    // Unchanged siblings never appear.
    expect(byId.has("ts:a.ts#C.other")).toBe(false);
    expect(byId.has("ts:a.ts#top")).toBe(false);
    // The module container is never a node — files are frames, not the unit.
    expect(byId.has("ts:a.ts")).toBe(false);
  });

  it("draws resolved call edges between two changed leaf blocks", () => {
    const changed: ChangedFile[] = [
      { path: "a.ts", status: "modified", hunks: [{ start: 40, end: 44 }] },
      { path: "b.ts", status: "added" },
    ];
    const graph = deriveReviewNodeGraph(index(NODES, EDGES), changed);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ source: "ts:a.ts#C.m", target: "ts:b.ts#helper" });
  });

  it("counts changed leaves on each frame", () => {
    const changed: ChangedFile[] = [{ path: "a.ts", status: "modified", hunks: [{ start: 40, end: 44 }] }];
    const graph = deriveReviewNodeGraph(index(NODES, EDGES), changed);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("revfile:a.ts")?.data.changedCount).toBe(1);
    expect(byId.get("ts:a.ts#C")?.data.changedCount).toBe(1);
  });

  it("reports a changed file with no overlapping block as unmapped", () => {
    const changed: ChangedFile[] = [
      { path: "a.ts", status: "modified", hunks: [{ start: 40, end: 44 }] },
      { path: "docs.md", status: "modified", hunks: [{ start: 1, end: 3 }] },
    ];
    const graph = deriveReviewNodeGraph(index(NODES, EDGES), changed);
    expect(graph.unmapped.map((f) => f.path)).toEqual(["docs.md"]);
  });
});
