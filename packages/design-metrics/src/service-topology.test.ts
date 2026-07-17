import type { GraphEdge, GraphNode } from "@meridian/core";
import { describe, expect, it } from "vitest";
import {
  deriveSerializedServiceTopology,
  hydrateServiceTopology,
  parseSerializedServiceTopology,
  serializeServiceTopology,
  type SerializedServiceTopologyV1,
} from "./service-topology";

function node(
  id: string,
  kind: string,
  displayName: string,
  parentId: string | null = null,
  extras: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    kind,
    displayName,
    qualifiedName: `example.${displayName}`,
    parentId,
    location: { file: "src/example.ts", startLine: 1, endLine: 3 },
    ...extras,
  } as GraphNode;
}

const NODES: GraphNode[] = [
  node("module:app", "module", "app"),
  node("repo:orders", "class", "OrderRepository", "module:app"),
  node("repo:orders#save", "method", "save", "repo:orders", {
    summary: null,
    signature: "save(order: Order): void",
    tags: ["public", "async", "public"],
  }),
  node("svc:email", "class", "EmailService", "module:app"),
  node("svc:email#send", "method", "send", "svc:email"),
  node("svc:orders", "class", "OrderService", "module:app"),
  node("svc:orders#submit", "method", "submit", "svc:orders", {
    summary: "Submits an order",
  }),
];

const EDGES: GraphEdge[] = [
  {
    id: "z-call",
    source: "svc:orders#submit",
    target: "repo:orders#save",
    kind: "calls",
    weight: 2,
  } as GraphEdge,
  {
    id: "a-inject",
    source: "svc:orders",
    target: "repo:orders",
    kind: "injects",
  } as GraphEdge,
];

function clone(topology: SerializedServiceTopologyV1): SerializedServiceTopologyV1 {
  return structuredClone(topology);
}

describe("serialized service topology", () => {
  it("round-trips the full-revision abstraction without serializing graph nodes", () => {
    const topology = deriveSerializedServiceTopology(NODES, EDGES);
    const roundTrip = parseSerializedServiceTopology(JSON.parse(JSON.stringify(topology)));
    const hydrated = hydrateServiceTopology(roundTrip);

    expect(serializeServiceTopology(hydrated)).toEqual(topology);
    expect(hydrated.metrics.get(roundTrip.metrics[0]!.id)).toBe(roundTrip.metrics[0]);
    expect(hydrated.membersByUnit.get(roundTrip.featuresByUnit[0]![0]))
      .toBe(roundTrip.featuresByUnit[0]![1]);
    expect(topology.clusters).toEqual([
      {
        leadId: "svc:email",
        memberIds: ["svc:email"],
        provenance: "named-service",
      },
      {
        leadId: "svc:orders",
        memberIds: ["repo:orders", "svc:orders"],
        provenance: "named-service",
      },
    ]);
    expect(topology.couplings).toEqual([
      {
        source: "svc:orders",
        target: "repo:orders",
        kinds: ["calls", "injects"],
        inheritanceOnly: false,
        evidenceByKind: [
          ["calls", { weight: 2, underlyingEdgeIds: ["z-call"] }],
          ["injects", { weight: 1, underlyingEdgeIds: ["a-inject"] }],
        ],
      },
    ]);
    expect(topology.metrics.map((metric) => metric.id)).not.toContain("module:app");
    expect(topology.featuresByUnit.map(([unitId]) => unitId)).not.toContain("module:app");

    const repositoryFeatures = topology.featuresByUnit
      .find(([unitId]) => unitId === "repo:orders")?.[1];
    expect(repositoryFeatures).toEqual([{
      id: "repo:orders#save",
      kind: "method",
      displayName: "save",
      qualifiedName: "example.save",
      signature: "save(order: Order): void",
      tags: ["async", "public"],
    }]);
    const json = JSON.stringify(topology);
    expect(json).not.toContain("\"location\"");
    expect(json).not.toContain("\"parentId\"");
    expect(json).not.toContain("\"body\"");
  });

  it("is canonical regardless of full-artifact node and edge insertion order", () => {
    const forward = deriveSerializedServiceTopology(NODES, EDGES);
    const reversed = deriveSerializedServiceTopology([...NODES].reverse(), [...EDGES].reverse());

    expect(reversed).toEqual(forward);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it("rejects unknown fields, non-canonical arrays, and broken references", () => {
    const topology = deriveSerializedServiceTopology(NODES, EDGES);

    const unknown = clone(topology) as SerializedServiceTopologyV1 & { debug?: boolean };
    unknown.debug = true;
    expect(() => parseSerializedServiceTopology(unknown)).toThrow("invalid serialized service topology");

    const unsortedMembers = clone(topology);
    unsortedMembers.clusters[1]!.memberIds.reverse();
    expect(() => parseSerializedServiceTopology(unsortedMembers)).toThrow("cluster members must be canonical");

    const unsortedKinds = clone(topology);
    unsortedKinds.couplings[0]!.kinds.reverse();
    expect(() => parseSerializedServiceTopology(unsortedKinds)).toThrow("coupling references must be canonical");

    const unknownEvidence = clone(topology);
    unknownEvidence.couplings[0]!.evidenceByKind.push([
      "references",
      { weight: 1, underlyingEdgeIds: ["missing-edge"] },
    ]);
    expect(() => parseSerializedServiceTopology(unknownEvidence)).toThrow("coupling evidence must be canonical");

    const missingMetric = clone(topology);
    missingMetric.clusters[0]!.memberIds.unshift("missing:unit");
    expect(() => parseSerializedServiceTopology(missingMetric)).toThrow("unknown unit");
  });

  it("rejects overlapping clusters and non-canonical compact member features", () => {
    const topology = deriveSerializedServiceTopology(NODES, EDGES);

    const overlap = clone(topology);
    overlap.clusters[0]!.memberIds.unshift("repo:orders");
    expect(() => parseSerializedServiceTopology(overlap)).toThrow("clusters must be disjoint");

    const tags = clone(topology);
    const repositoryFeatures = tags.featuresByUnit.find(([unitId]) => unitId === "repo:orders")![1];
    repositoryFeatures[0]!.tags!.reverse();
    expect(() => parseSerializedServiceTopology(tags)).toThrow("feature tags must be canonical");

    const duplicateFeature = clone(topology);
    const emailFeatures = duplicateFeature.featuresByUnit.find(([unitId]) => unitId === "svc:email")![1];
    emailFeatures.push({ ...repositoryFeatures[0]!, tags: ["async", "public"] });
    expect(() => parseSerializedServiceTopology(duplicateFeature)).toThrow("member features must be canonical");
  });
});
