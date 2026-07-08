/**
 * Ghost dependencies read at SERVICE granularity: when a drawn code node depends on a class that
 * lives off the level (e.g. imported from another package), the ghost is the CLASS, not its
 * `constructor` / method blocks — and every member dep on that class folds into one ghost card.
 * A bare module-level function (no unit ancestor) stays a function ghost.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildBlockDeps } from "./blockDeps";
import { ghostDepWires } from "./ghostDeps";

function node(id: string, kind: string, parentId?: string): GraphNode {
  return { id, kind, qualifiedName: id.split("#").pop() ?? id, displayName: id.split(".").pop() ?? id, parentId, location: { file: id, startLine: 1 } };
}

function edge(kind: string, source: string, target: string): GraphEdge {
  return { id: `${kind}@${source}|${target}`, source, target, kind, weight: 1 };
}

// Consumer file with one drawn function `use`; an off-level service class `Svc` (ctor + method) in
// another package, plus a bare module-level function `helper` — none of the service package drawn.
const NODES: GraphNode[] = [
  node("ts:cons", "package"),
  node("ts:cons/c.ts", "module", "ts:cons"),
  node("ts:cons/c.ts#use", "function", "ts:cons/c.ts"),
  node("ts:svc", "package"),
  node("ts:svc/s.ts", "module", "ts:svc"),
  node("ts:svc/s.ts#Svc", "class", "ts:svc/s.ts"),
  node("ts:svc/s.ts#Svc.constructor", "method", "ts:svc/s.ts#Svc"),
  node("ts:svc/s.ts#Svc.mount", "method", "ts:svc/s.ts#Svc"),
  node("ts:svc/s.ts#helper", "function", "ts:svc/s.ts"),
];

const EDGES: GraphEdge[] = [
  edge("instantiates", "ts:cons/c.ts#use", "ts:svc/s.ts#Svc"),
  edge("calls", "ts:cons/c.ts#use", "ts:svc/s.ts#Svc.mount"),
  edge("calls", "ts:cons/c.ts#use", "ts:svc/s.ts#helper"),
];

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-08T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: NODES,
  edges: EDGES,
};

const index = buildGraphIndex(ARTIFACT);
const blockDeps = buildBlockDeps(index);
// Only the consumer function's chain is drawn; the whole service package is off-level.
const visibleIds = new Set(["ts:cons", "ts:cons/c.ts", "ts:cons/c.ts#use"]);
const isCode = (id: string) => id === "ts:cons/c.ts#use";

describe("ghostDepWires — service-level ghosts", () => {
  const emission = ghostDepWires(blockDeps, [], visibleIds, index, isCode, new Set());
  const ghostIds = [...emission.ghosts.keys()].sort();

  it("ghosts the CLASS, never its constructor or method blocks", () => {
    expect(ghostIds).toContain("ts:svc/s.ts#Svc");
    expect(ghostIds).not.toContain("ts:svc/s.ts#Svc.constructor");
    expect(ghostIds).not.toContain("ts:svc/s.ts#Svc.mount");
    expect(emission.ghosts.get("ts:svc/s.ts#Svc")?.ghostKind).toBe("class");
  });

  it("folds a class's constructor + method deps into one ghost wire", () => {
    const toSvc = emission.wires.filter((wire) => wire.target === "ts:svc/s.ts#Svc");
    expect(toSvc).toHaveLength(1);
    expect(toSvc[0].source).toBe("ts:cons/c.ts#use");
    expect(toSvc[0].weight).toBe(2); // instantiates(→ctor) + calls(→mount) summed
  });

  it("leaves a bare module-level function as its own ghost (no unit to lift to)", () => {
    expect(ghostIds).toContain("ts:svc/s.ts#helper");
    expect(emission.ghosts.get("ts:svc/s.ts#helper")?.ghostKind).toBe("function");
  });
});
