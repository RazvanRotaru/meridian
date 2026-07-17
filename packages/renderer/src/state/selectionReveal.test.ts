import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { selectedAnchorIds } from "./lensPath";
import { scopeTarget } from "./selectionReveal";

function node(id: string, kind: string, parentId?: string, displayName?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: displayName ?? id,
    parentId: parentId ?? null,
    location: { file: "f.ts", startLine: 1 },
  } as GraphNode;
}

// Same shape as lensPath.test.ts: a clustered service+repository pair under src/, an UNclustered
// bare helper under lib/ — so the Service gate has both a placeable and an unplaceable anchor.
const NODES: GraphNode[] = [
  node("ts:app", "package", undefined, "app"),
  node("ts:app/src", "package", "ts:app", "src"),
  node("ts:app/src/orders.ts", "module", "ts:app/src", "orders.ts"),
  node("ts:app/src/orders.ts#OrderService", "class", "ts:app/src/orders.ts", "OrderService"),
  node("ts:app/src/orders.ts#OrderService.place", "method", "ts:app/src/orders.ts#OrderService", "place"),
  node("ts:app/src/repo.ts", "module", "ts:app/src", "repo.ts"),
  node("ts:app/src/repo.ts#OrderRepository", "class", "ts:app/src/repo.ts", "OrderRepository"),
  node("ts:app/lib", "package", "ts:app", "lib"),
  node("ts:app/lib/util.ts", "module", "ts:app/lib", "util.ts"),
  node("ts:app/lib/util.ts#format", "function", "ts:app/lib/util.ts", "format"),
];

const EDGES: GraphEdge[] = [
  { id: "e1", source: "ts:app/src/orders.ts#OrderService", target: "ts:app/src/repo.ts#OrderRepository", kind: "instantiates", resolution: "resolved" },
] as GraphEdge[];

const index = buildGraphIndex({ nodes: NODES, edges: EDGES } as GraphArtifact);
const METHOD = "ts:app/src/orders.ts#OrderService.place";
const FORMAT = "ts:app/lib/util.ts#format";
const NO_CLUSTER_REASON = "No service cluster owns this selection";

describe("scopeTarget", () => {
  it("enables the Scope button (reason null) for a clustered unit's member", () => {
    expect(scopeTarget([METHOD], index)).toEqual({ availability: "available", enabled: true, reason: null });
  });

  it("disables with the exact reason for an unclustered helper", () => {
    expect(scopeTarget([FORMAT], index)).toEqual({ availability: "unavailable", enabled: false, reason: NO_CLUSTER_REASON });
  });

  it("disables with the exact reason for a folder with NO clustered units beneath it", () => {
    expect(scopeTarget(["ts:app/lib"], index)).toEqual({ availability: "unavailable", enabled: false, reason: NO_CLUSTER_REASON });
    // A folder OVER clustered units decomposes to them (the folder group-ghost reveal), so it scopes.
    expect(scopeTarget(["ts:app/src"], index)).toEqual({ availability: "available", enabled: true, reason: null });
  });

  it("disables for an empty selection and for an id not in the graph", () => {
    expect(scopeTarget([], index).enabled).toBe(false);
    expect(scopeTarget(["ts:nope#ghost"], index)).toEqual({ availability: "unavailable", enabled: false, reason: NO_CLUSTER_REASON });
  });

  it("enables when ANY anchor of a mixed selection is clustered", () => {
    expect(scopeTarget([FORMAT, METHOD], index).enabled).toBe(true);
  });

  it("enables for a selected `svc:` cluster frame — the panel's anchors normalize it to its lead unit", () => {
    const anchors = selectedAnchorIds({
      viewMode: "call",
      moduleSelected: new Set(["svc:ts:app/src/orders.ts#OrderService"]),
    });
    expect(anchors).toEqual(["ts:app/src/orders.ts#OrderService"]);
    expect(scopeTarget(anchors, index)).toEqual({ availability: "available", enabled: true, reason: null });
  });

  it("enables for a FILE anchor, which resolves through its contained clustered units", () => {
    expect(scopeTarget(["ts:app/src/orders.ts"], index)).toEqual({ availability: "available", enabled: true, reason: null });
  });

  it("defers eligibility to destination hydration when the bounded Map omits Service facts", () => {
    const boundedMap = buildGraphIndex(
      { nodes: NODES, edges: EDGES } as GraphArtifact,
      {
        structure: index.structure,
        graphSummary: index.graphSummary,
        serviceTopology: null,
        artifactComplete: false,
      },
    );

    expect(scopeTarget([METHOD], boundedMap)).toEqual({
      availability: "unresolved",
      enabled: true,
      reason: null,
    });
  });
});
