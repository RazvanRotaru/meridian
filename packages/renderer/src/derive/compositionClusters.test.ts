/**
 * Cluster assignment: how a unit resolves to its package frame, the "(root)" fallback for a
 * package-less unit, and the per-frame smell tally. Fixtures are hand-built graphs so each rule is
 * pinned independently of any extractor.
 */

import { describe, expect, it } from "vitest";
import type { GraphNode } from "@meridian/core";
import type { Smell, UnitMetrics } from "@meridian/design-metrics";
import type { CompNodeSpec } from "./compositionGraph";
import { buildClusters, clusterIdOf, clusterLabel, ROOT_CLUSTER_ID } from "./compositionClusters";

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

function unitSpec(id: string, smells: Smell[] = []): CompNodeSpec {
  return { id, type: "unit", width: 240, height: 104, data: { unitId: id, kind: "class", label: id, metrics: { smells } as UnitMetrics, members: [] } };
}

function indexOf(nodes: GraphNode[]): Map<string, GraphNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

// A package holding a module, which holds two classes — the common "folder › file › types" shape.
const packagedNodes = [
  node("pkg:app", "package", undefined, "app"),
  node("ts:app/svc", "module", "pkg:app"),
  node("ts:app/svc#A", "class", "ts:app/svc"),
  node("ts:app/svc#B", "class", "ts:app/svc"),
];

describe("clusterIdOf", () => {
  it("walks parentId up to the nearest package ancestor", () => {
    const byId = indexOf(packagedNodes);
    expect(clusterIdOf("ts:app/svc#A", byId)).toBe("pkg:app");
    expect(clusterIdOf("ts:app/svc", byId)).toBe("pkg:app");
  });

  it("falls back to (root) when a unit has no package ancestor", () => {
    const byId = indexOf([node("ts:loose", "module"), node("ts:loose#C", "class", "ts:loose")]);
    expect(clusterIdOf("ts:loose#C", byId)).toBe(ROOT_CLUSTER_ID);
  });

  it("tolerates a parentId cycle without looping forever", () => {
    const byId = indexOf([node("ts:a", "module", "ts:b"), node("ts:b", "module", "ts:a")]);
    expect(clusterIdOf("ts:a", byId)).toBe(ROOT_CLUSTER_ID);
  });
});

describe("clusterLabel", () => {
  it("uses the package node's display name, or (root) for the fallback", () => {
    const byId = indexOf(packagedNodes);
    expect(clusterLabel("pkg:app", byId)).toBe("app");
    expect(clusterLabel(ROOT_CLUSTER_ID, byId)).toBe(ROOT_CLUSTER_ID);
  });
});

describe("buildClusters", () => {
  it("groups units under the same package into one frame", () => {
    const byId = indexOf(packagedNodes);
    const frames = buildClusters([unitSpec("ts:app/svc#A"), unitSpec("ts:app/svc#B")], byId);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: "pkg:app", label: "app", unitIds: ["ts:app/svc#A", "ts:app/svc#B"] });
  });

  it("puts a package-less unit into the (root) frame", () => {
    const byId = indexOf([node("ts:loose", "module"), node("ts:loose#C", "class", "ts:loose")]);
    const frames = buildClusters([unitSpec("ts:loose#C")], byId);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: ROOT_CLUSTER_ID, label: ROOT_CLUSTER_ID, unitIds: ["ts:loose#C"] });
  });

  it("separates units in different packages and sorts frames by label", () => {
    const nodes = [
      node("pkg:z", "package", undefined, "zebra"),
      node("ts:z#Z", "class", "pkg:z"),
      node("pkg:a", "package", undefined, "alpha"),
      node("ts:a#A", "class", "pkg:a"),
    ];
    const frames = buildClusters([unitSpec("ts:z#Z"), unitSpec("ts:a#A")], indexOf(nodes));
    expect(frames.map((f) => f.label)).toEqual(["alpha", "zebra"]);
  });

  it("tallies smellyCount as the units carrying at least one smell", () => {
    const byId = indexOf(packagedNodes);
    const frames = buildClusters(
      [unitSpec("ts:app/svc#A", ["god-module"]), unitSpec("ts:app/svc#B", [])],
      byId,
    );
    expect(frames[0].smellyCount).toBe(1);
    expect(frames[0].unitIds).toHaveLength(2);
  });
});
