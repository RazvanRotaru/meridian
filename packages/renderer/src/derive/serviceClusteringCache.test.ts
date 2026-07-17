import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import {
  deriveSerializedServiceTopology,
  serializeServiceTopology,
} from "@meridian/design-metrics";
import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "../graph/graphIndex";
import { clusteringFor, clusteringForIfAvailable } from "./serviceClusteringCache";

function node(id: string, kind: string, displayName: string, parentId: string | null = null): GraphNode {
  return {
    id,
    kind,
    displayName,
    qualifiedName: id,
    parentId,
    location: { file: "src/services.ts", startLine: 1 },
  } as GraphNode;
}

const NODES = [
  node("module:services", "module", "services"),
  node("repo:orders", "class", "OrderRepository", "module:services"),
  node("repo:orders#save", "method", "save", "repo:orders"),
  node("svc:orders", "class", "OrderService", "module:services"),
  node("svc:orders#submit", "method", "submit", "svc:orders"),
];

const EDGES = [{
  id: "injects:orders",
  source: "svc:orders",
  target: "repo:orders",
  kind: "injects",
}] as GraphEdge[];

function artifact(nodes: GraphNode[], edges: GraphEdge[]): GraphArtifact {
  return { nodes, edges } as unknown as GraphArtifact;
}

describe("clusteringFor", () => {
  it("hydrates the authoritative full-revision topology for a bounded Service projection", () => {
    const full = buildGraphIndex(artifact(NODES, EDGES));
    const serviceTopology = deriveSerializedServiceTopology(NODES, EDGES);
    const bounded = buildGraphIndex(
      artifact(NODES.filter((item) => item.id.startsWith("svc:orders")), []),
      { graphSummary: full.graphSummary, serviceTopology, artifactComplete: false },
    );

    const clustering = clusteringFor(bounded);
    expect(serializeServiceTopology(clustering)).toEqual(serviceTopology);
    expect(clustering.clusters[0]).toEqual({
      leadId: "svc:orders",
      memberIds: ["repo:orders", "svc:orders"],
      provenance: "named-service",
    });
    expect(clustering.membersByUnit.get("repo:orders")?.map((feature) => feature.id))
      .toEqual(["repo:orders#save"]);
  });

  it("never derives a misleading service graph from an incomplete projection slice", () => {
    const full = buildGraphIndex(artifact(NODES, EDGES));
    const bounded = buildGraphIndex(
      artifact(NODES.filter((item) => item.id.startsWith("svc:orders")), []),
      { graphSummary: full.graphSummary, artifactComplete: false },
    );

    expect(() => clusteringFor(bounded)).toThrow("request a Service projection");
    expect(clusteringForIfAvailable(bounded)).toBeNull();
  });

  it("derives once from a genuinely complete local artifact and memoizes by index", () => {
    const complete = buildGraphIndex(artifact(NODES, EDGES));

    expect(complete.artifactComplete).toBe(true);
    expect(clusteringFor(complete)).toBe(clusteringFor(complete));
    expect(clusteringFor(complete).leadOf.get("repo:orders")).toBe("svc:orders");
  });
});
