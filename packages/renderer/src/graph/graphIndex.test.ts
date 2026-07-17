/**
 * The dive-in index helpers: childrenOf (the focus scope's roots), ancestorsOf (the breadcrumb
 * path), isWithinFocus (subtree membership for edge scoping), and the UI-mode focus target.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import type { SerializedServiceTopologyV1 } from "@meridian/design-metrics";
import {
  buildGraphIndex,
  graphIndexMetadataWithPresentationNodes,
  graphIndexMetadataWithoutPresentationNodes,
} from "./graphIndex";
import { uiFocusTarget } from "../derive/uiFocus";

function node(id: string, parentId?: string): GraphNode {
  return { id, kind: "module", qualifiedName: id, displayName: id, parentId, location: { file: id, startLine: 1 } };
}

function rendersEdge(source: string, target: string): GraphEdge {
  return { id: `renders@${source}|${target}`, source, target, kind: "renders" };
}

// App{ ui{ Page, Card }, services{ svc } } — a component subtree plus an unrelated service.
const NODES: GraphNode[] = [
  node("app"),
  node("app/ui", "app"),
  node("app/ui#Page", "app/ui"),
  node("app/ui#Card", "app/ui"),
  node("app/services", "app"),
  node("app/services#svc", "app/services"),
];

function makeIndex(edges: GraphEdge[] = []) {
  const artifact: GraphArtifact = {
    schemaVersion: "1.0.0",
    generatedAt: "2026-06-27T00:00:00.000Z",
    generator: { name: "test", version: "0" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes: NODES,
    edges,
  };
  return buildGraphIndex(artifact);
}

describe("childrenOf", () => {
  it("returns the ordered children of a container", () => {
    const index = makeIndex();
    expect(index.childrenOf("app/ui").map((n) => n.id)).toEqual(["app/ui#Page", "app/ui#Card"]);
    expect(index.childrenOf("app").map((n) => n.id)).toEqual(["app/ui", "app/services"]);
  });

  it("returns an empty list for a leaf or unknown node", () => {
    const index = makeIndex();
    expect(index.childrenOf("app/ui#Page")).toEqual([]);
    expect(index.childrenOf("nope")).toEqual([]);
  });
});

describe("ancestorsOf", () => {
  it("returns the root..id inclusive path", () => {
    const index = makeIndex();
    expect(index.ancestorsOf("app/ui#Page").map((n) => n.id)).toEqual(["app", "app/ui", "app/ui#Page"]);
  });

  it("is just the node itself for a root", () => {
    const index = makeIndex();
    expect(index.ancestorsOf("app").map((n) => n.id)).toEqual(["app"]);
  });
});

describe("isWithinFocus", () => {
  it("treats a null focus as containing everything", () => {
    const index = makeIndex();
    expect(index.isWithinFocus(null, "app/services#svc")).toBe(true);
  });

  it("holds for a descendant and the focus node itself, but not for outsiders", () => {
    const index = makeIndex();
    expect(index.isWithinFocus("app/ui", "app/ui#Card")).toBe(true);
    expect(index.isWithinFocus("app/ui", "app/ui")).toBe(true);
    expect(index.isWithinFocus("app/ui", "app/services#svc")).toBe(false);
    expect(index.isWithinFocus("app/ui", "app")).toBe(false);
  });
});

describe("presentation-only index metadata", () => {
  it("adds and removes overlay facts without redefining the authoritative revision", () => {
    const serviceTopology: SerializedServiceTopologyV1 = {
      version: 1,
      clusters: [],
      metrics: [],
      featuresByUnit: [],
      couplings: [],
    };
    const headArtifact: GraphArtifact = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-06-27T00:00:00.000Z",
      generator: { name: "test", version: "0" },
      target: { name: "fixture", root: ".", language: "typescript" },
      nodes: NODES,
      edges: [],
    };
    const headIndex = buildGraphIndex(headArtifact, {
      serviceTopology,
      artifactComplete: false,
    });
    const deletedFile = node("app/deleted", "app");
    const deletedMember = node("app/deleted#member", deletedFile.id);
    const presentationNodes = [deletedFile, deletedMember];
    const compositeArtifact = {
      ...headArtifact,
      nodes: [...headArtifact.nodes, ...presentationNodes],
    };
    const compositeIndex = buildGraphIndex(
      compositeArtifact,
      graphIndexMetadataWithPresentationNodes(headIndex, presentationNodes),
    );

    expect(compositeIndex.graphSummary).toBe(headIndex.graphSummary);
    expect(compositeIndex.structure.repositorySummary).toBe(headIndex.structure.repositorySummary);
    expect(compositeIndex.structure.moduleOverviewRootIds).toBe(headIndex.structure.moduleOverviewRootIds);
    expect(compositeIndex.structure.moduleOverview).toBe(headIndex.structure.moduleOverview);
    expect(compositeIndex.serviceTopology).toBe(serviceTopology);
    expect(compositeIndex.artifactComplete).toBe(false);
    expect(compositeIndex.structure.hierarchyById.get("app")).toBe(
      headIndex.structure.hierarchyById.get("app"),
    );
    expect(compositeIndex.childCount("app")).toBe(headIndex.childCount("app"));
    expect(compositeIndex.childCount(deletedFile.id)).toBe(1);

    const removedIds = new Set(presentationNodes.map((candidate) => candidate.id));
    const restoredIndex = buildGraphIndex(
      headArtifact,
      graphIndexMetadataWithoutPresentationNodes(compositeIndex, removedIds),
    );

    expect(restoredIndex.graphSummary).toBe(headIndex.graphSummary);
    expect(restoredIndex.structure.repositorySummary).toBe(headIndex.structure.repositorySummary);
    expect(restoredIndex.structure.moduleOverview).toBe(headIndex.structure.moduleOverview);
    expect(restoredIndex.serviceTopology).toBe(serviceTopology);
    expect(restoredIndex.artifactComplete).toBe(false);
    expect(restoredIndex.structure.hierarchyById.get("app")).toBe(
      headIndex.structure.hierarchyById.get("app"),
    );
    expect(restoredIndex.structure.hierarchyById.has(deletedFile.id)).toBe(false);
    expect(restoredIndex.structure.hierarchyById.has(deletedMember.id)).toBe(false);
  });
});

describe("uiFocusTarget", () => {
  it("is the nearest common ancestor of the renders participants", () => {
    const index = makeIndex([rendersEdge("app/ui#Page", "app/ui#Card")]);
    // Page and Card share ancestor app/ui — diving there puts the render tree front-and-centre.
    expect(uiFocusTarget(index)).toBe("app/ui");
  });

  it("is null when there are no renders edges (caller falls home)", () => {
    expect(uiFocusTarget(makeIndex([]))).toBeNull();
  });

  it("ignores unresolved pseudo-id targets that are not real nodes", () => {
    // The pseudo-id (Fragment) is skipped, so the real participants Page + Card still resolve to
    // their container app/ui — including it would have poisoned the common-ancestor to null.
    const index = makeIndex([
      rendersEdge("app/ui#Page", "app/ui#Card"),
      rendersEdge("app/ui#Page", "ext:react#Fragment"),
    ]);
    expect(uiFocusTarget(index)).toBe("app/ui");
  });
});
