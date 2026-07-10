import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { revealTargets } from "./selectionReveal";

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
// bare helper under lib/ — so each lens has both a placeable and an unplaceable anchor on hand.
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

function targetFor(targets: ReturnType<typeof revealTargets>, mode: string) {
  const target = targets.find((candidate) => candidate.mode === mode);
  expect(target).toBeDefined();
  return target!;
}

describe("revealTargets", () => {
  it("returns ALL reveal-capable lenses in Map/Service/UI order — the active-lens filter is the panel's, and Scope reads the Service entry", () => {
    expect(revealTargets([METHOD], index).map((t) => t.mode)).toEqual(["modules", "call", "ui"]);
  });

  it("enables every target (reason null) for a fully placeable anchor", () => {
    for (const target of revealTargets([METHOD], index)) {
      expect(target.enabled).toBe(true);
      expect(target.reason).toBeNull();
    }
  });

  it("disables Service with its exact reason for an unclustered helper, keeping Map and UI live", () => {
    const targets = revealTargets([FORMAT], index);
    expect(targetFor(targets, "call")).toMatchObject({ enabled: false, reason: "No service cluster owns this selection" });
    expect(targetFor(targets, "modules").enabled).toBe(true);
    expect(targetFor(targets, "ui").enabled).toBe(true);
  });

  it("disables Map with its exact reason for a bare package (no containing file)", () => {
    const targets = revealTargets(["ts:app/src"], index);
    expect(targetFor(targets, "modules")).toMatchObject({ enabled: false, reason: "No file contains this selection" });
  });

  it("disables everything, each with its own reason, for an id not in the graph", () => {
    const targets = revealTargets(["ts:nope#ghost"], index);
    expect(targetFor(targets, "modules")).toMatchObject({ enabled: false, reason: "No file contains this selection" });
    expect(targetFor(targets, "call")).toMatchObject({ enabled: false, reason: "No service cluster owns this selection" });
    expect(targetFor(targets, "ui")).toMatchObject({ enabled: false, reason: "Selection is not in the graph" });
  });

  it("enables a target when ANY anchor of a mixed selection is placeable there", () => {
    const targets = revealTargets([FORMAT, METHOD], index);
    expect(targetFor(targets, "call").enabled).toBe(true);
    expect(targetFor(targets, "modules").enabled).toBe(true);
  });

  it("disables every target for an empty selection", () => {
    for (const target of revealTargets([], index)) {
      expect(target.enabled).toBe(false);
      expect(target.reason).not.toBeNull();
    }
  });

  it("gates 'Scope Service view' through the Service entry: enabled exactly when Reveal-in-Service is", () => {
    expect(targetFor(revealTargets([METHOD], index), "call").enabled).toBe(true);
    expect(targetFor(revealTargets([FORMAT, METHOD], index), "call").enabled).toBe(true);
    expect(targetFor(revealTargets([FORMAT], index), "call").enabled).toBe(false);
    expect(targetFor(revealTargets([], index), "call").enabled).toBe(false);
  });
});
