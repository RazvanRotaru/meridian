import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { deriveServiceDomains } from "../../derive/serviceDomains";
import { clusteringFor } from "../../derive/serviceClusteringCache";
import { buildGraphIndex } from "../../graph/graphIndex";
import {
  adaptMinimalGraphToSemanticSource,
  MINIMAL_SOURCE_GRAPH_ANCHOR_ID,
  minimalSemanticLayersAtReviewBoundary,
  minimalSourceGraphLabel,
  minimalSourceSemanticLayer,
  stampMinimalGraphAsSemanticDetail,
  type MinimalSourceGraphState,
} from "./minimalSemanticSource";

function graphNode(
  id: string,
  kind: string,
  parentId: string | null,
  displayName: string,
  file = "fixture.ts",
): GraphNode {
  return {
    id,
    kind,
    parentId,
    displayName,
    qualifiedName: id,
    location: { file, startLine: 1 },
  } as GraphNode;
}

const APP = "ts:app";
const SRC = "ts:app/src";
const FILE = "ts:app/src/a.ts";
const INDEX = buildGraphIndex({
  nodes: [
    graphNode(APP, "package", null, "app"),
    graphNode(SRC, "package", APP, "src"),
    graphNode(FILE, "module", SRC, "a.ts"),
  ],
  edges: [],
} as unknown as GraphArtifact);

function source(overrides: Partial<MinimalSourceGraphState> = {}): MinimalSourceGraphState {
  return {
    index: INDEX,
    viewMode: "modules",
    moduleFocus: SRC,
    moduleEffectiveFocus: SRC,
    serviceScope: null,
    ...overrides,
  };
}

describe("stampMinimalGraphAsSemanticDetail", () => {
  it("canonically stamps nodes and edges at depth zero without mutating their inputs", () => {
    const node: Node = {
      id: "member",
      type: "file",
      position: { x: 10, y: 20 },
      className: "member semantic-layer semantic-layer-7 semantic-context",
      data: { label: "member.ts", semanticDepth: 7, semanticRole: "context", semanticAnchorId: "old" },
    };
    const edge: Edge = {
      id: "wire",
      source: "member",
      target: "satellite",
      className: "wire semantic-layer-7 semantic-context-edge",
      data: { kind: "calls", semanticDepth: 7 },
    };

    const stamped = stampMinimalGraphAsSemanticDetail({ nodes: [node], edges: [edge] });

    expect(stamped.nodes[0]).not.toBe(node);
    expect(stamped.nodes[0]).toMatchObject({ id: "member", position: { x: 10, y: 20 } });
    expect(stamped.nodes[0].className?.split(/\s+/)).toEqual([
      "member",
      "semantic-layer",
      "semantic-layer-0",
      "semantic-detail",
    ]);
    expect(stamped.nodes[0].data).toMatchObject({
      label: "member.ts",
      semanticDepth: 0,
      semanticRole: "detail",
      semanticAnchorId: null,
    });
    expect(stamped.edges[0]).not.toBe(edge);
    expect(stamped.edges[0].className?.split(/\s+/)).toEqual([
      "wire",
      "semantic-layer",
      "semantic-layer-0",
      "semantic-detail-edge",
    ]);
    expect(stamped.edges[0].data).toMatchObject({
      kind: "calls",
      semanticDepth: 0,
      semanticRole: "detail",
      semanticAnchorId: null,
    });
    expect(node.data).toMatchObject({ semanticDepth: 7, semanticAnchorId: "old" });
    expect(edge.data).toMatchObject({ semanticDepth: 7 });
  });
});

describe("minimal source scene metadata", () => {
  it("uses the final laid breadcrumb before scope or root labels", () => {
    expect(minimalSourceGraphLabel(source({ serviceScope: { leadIds: ["lead"], label: "Scoped services" } }))).toBe("src");
  });

  it("uses a Service scope when there is no focused crumb, then each surface's root label", () => {
    expect(minimalSourceGraphLabel(source({
      viewMode: "call",
      moduleFocus: null,
      moduleEffectiveFocus: null,
      serviceScope: { leadIds: ["lead"], label: "  CheckoutService (+2)  " },
    }))).toBe("CheckoutService (+2)");
    expect(minimalSourceGraphLabel(source({ moduleFocus: null, moduleEffectiveFocus: null }))).toBe("Repository");
    expect(minimalSourceGraphLabel(source({
      moduleFocus: null,
      moduleEffectiveFocus: null,
      serviceScope: { leadIds: ["stale"], label: "Stale Service scope" },
    }))).toBe("Repository");
    expect(minimalSourceGraphLabel(source({ viewMode: "ui", moduleFocus: null, moduleEffectiveFocus: null }))).toBe("UI");
    expect(minimalSourceGraphLabel(source({ viewMode: "logic", moduleFocus: null, moduleEffectiveFocus: null }))).toBe("Graph");
  });

  it("uses the active non-default Service grouping when naming a focused source domain", () => {
    const nodes: GraphNode[] = [graphNode("ts:src", "package", null, "src", "src")];
    const edges: GraphEdge[] = [];
    const leads: string[] = [];
    for (let position = 0; position < 12; position += 1) {
      const file = `src/services/service${position}.ts`;
      const moduleId = `ts:${file}`;
      const lead = `${moduleId}#Service${position}`;
      nodes.push(graphNode(moduleId, "module", "ts:src", `service${position}.ts`, file));
      nodes.push(graphNode(lead, "class", moduleId, `Service${position}`, file));
      leads.push(lead);
      if (position > 0) {
        edges.push({
          id: `edge-${position}`,
          source: leads[position - 1],
          target: lead,
          kind: "calls",
          resolution: "resolved",
        } as GraphEdge);
      }
    }
    const artifact = { ...({} as GraphArtifact), nodes, edges } as GraphArtifact;
    const index = buildGraphIndex(artifact);
    const model = deriveServiceDomains(clusteringFor(index), "dependency", 4);
    const domain = model.domains[0]!;

    expect(minimalSourceGraphLabel(source({
      index,
      viewMode: "call",
      moduleFocus: domain.id,
      moduleEffectiveFocus: domain.id,
      serviceScope: null,
      serviceGroupingMode: "dependency",
      serviceGroupingTargetSize: 4,
    }))).toBe(domain.label);
  });

  it("builds one metadata-only parent with the captured raw focus", () => {
    expect(minimalSourceSemanticLayer(source({ moduleFocus: FILE, moduleEffectiveFocus: SRC }))).toEqual({
      depth: 1,
      focus: FILE,
      anchorId: MINIMAL_SOURCE_GRAPH_ANCHOR_ID,
      label: "src",
    });
  });

  it("adapts a multi-origin flat graph without requiring a real parent anchor", () => {
    const nodes: Node[] = [
      { id: "first", position: { x: 0, y: 0 }, data: { label: "first" } },
      { id: "second", position: { x: 100, y: 0 }, data: { label: "second" } },
    ];
    const adapted = adaptMinimalGraphToSemanticSource({ nodes, edges: [] }, source());

    expect(adapted.semanticDepths).toEqual([0, 1]);
    expect(adapted.semanticLayers).toEqual([
      { depth: 1, focus: SRC, anchorId: MINIMAL_SOURCE_GRAPH_ANCHOR_ID, label: "src" },
    ]);
    expect(adapted.nodes.map((node) => node.id)).toEqual(["first", "second"]);
    expect(adapted.nodes.every((node) => node.data.semanticDepth === 0)).toBe(true);
    expect(adapted.nodes.some((node) => node.id === MINIMAL_SOURCE_GRAPH_ANCHOR_ID)).toBe(false);
  });

  it("removes the outward semantic parent only at the PR review boundary", () => {
    const layers = [minimalSourceSemanticLayer(source())];

    expect(minimalSemanticLayersAtReviewBoundary(layers, true)).toEqual([]);
    expect(minimalSemanticLayersAtReviewBoundary(layers, false)).toBe(layers);
  });
});
