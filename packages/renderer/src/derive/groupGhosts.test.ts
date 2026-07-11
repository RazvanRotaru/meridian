/**
 * Ghost grouping (the Highways treatment for the ghost tier): ghosts sharing a home folder fold into
 * ONE group card carrying the folder's REAL id, wires re-aggregate with summed weights; folders below
 * the threshold and root-level ghosts stay individual.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type { GhostEmission } from "./ghostDeps";
import { groupGhostEmission } from "./groupGhosts";

function node(id: string, kind: string, parentId?: string): GraphNode {
  return { id, kind, qualifiedName: id.slice(3), displayName: id, parentId: parentId ?? null, location: { file: "f.ts", startLine: 1 } } as GraphNode;
}

// A `host` folder with three files (one ghosted symbol each) and a `lone` folder with a single file.
function indexFixture() {
  const nodes = [
    node("ts:t", "package"),
    node("ts:t/host", "package", "ts:t"),
    node("ts:t/host/h1.ts", "module", "ts:t/host"),
    node("ts:t/host/h2.ts", "module", "ts:t/host"),
    node("ts:t/host/h3.ts", "module", "ts:t/host"),
    node("ts:t/host/h1.ts#f1", "function", "ts:t/host/h1.ts"),
    node("ts:t/host/h2.ts#f2", "function", "ts:t/host/h2.ts"),
    node("ts:t/host/h3.ts#f3", "function", "ts:t/host/h3.ts"),
    node("ts:t/lone", "package", "ts:t"),
    node("ts:t/lone/l.ts", "module", "ts:t/lone"),
    node("ts:t/lone/l.ts#g", "function", "ts:t/lone/l.ts"),
  ];
  return buildGraphIndex({ nodes, edges: [] } as unknown as GraphArtifact);
}

function emission(): GhostEmission {
  const ghost = (id: string) => [id, { label: id, context: "", ghostKind: "function" }] as const;
  return {
    ghosts: new Map([ghost("ts:t/host/h1.ts#f1"), ghost("ts:t/host/h2.ts#f2"), ghost("ts:t/host/h3.ts#f3"), ghost("ts:t/lone/l.ts#g")]),
    wires: [
      { source: "ts:t/host/h1.ts#f1", target: "vis", weight: 1, kind: "calls", underlyingEdgeIds: ["e1"] },
      { source: "ts:t/host/h2.ts#f2", target: "vis", weight: 2, kind: "calls", underlyingEdgeIds: ["e2"] },
      { source: "ts:t/host/h3.ts#f3", target: "vis", weight: 1, kind: "references", underlyingEdgeIds: ["e3"] },
      { source: "ts:t/lone/l.ts#g", target: "vis", weight: 1, kind: "calls", underlyingEdgeIds: ["e4"] },
    ],
  };
}

describe("groupGhostEmission", () => {
  it("folds a folder's >=3 ghosts into one group card keyed by the folder's REAL id", () => {
    const grouped = groupGhostEmission(emission(), indexFixture());
    expect([...grouped.ghosts.keys()].sort()).toEqual(["ts:t/host", "ts:t/lone/l.ts#g"]);
    const group = grouped.ghosts.get("ts:t/host");
    expect(group?.ghostKind).toBe("package");
    expect(group?.context).toContain("3 referenced symbols");
  });

  it("re-aggregates the folded wires per (source, target, kind) with summed weights", () => {
    const grouped = groupGhostEmission(emission(), indexFixture());
    const calls = grouped.wires.find((w) => w.source === "ts:t/host" && w.kind === "calls");
    const refs = grouped.wires.find((w) => w.source === "ts:t/host" && w.kind === "references");
    expect(calls?.weight).toBe(3); // 1 + 2, folded across h1/h2
    expect(calls?.underlyingEdgeIds.sort()).toEqual(["e1", "e2"]); // attribution survives the fold
    expect(refs?.weight).toBe(1);
    // The below-threshold lone ghost keeps its own wire untouched.
    expect(grouped.wires.find((w) => w.source === "ts:t/lone/l.ts#g")?.weight).toBe(1);
  });

  it("folds a PAIR from the same folder (threshold 2) but never a lone ghost", () => {
    const ghost = (id: string) => [id, { label: id, context: "", ghostKind: "function" }] as const;
    const input: GhostEmission = {
      ghosts: new Map([ghost("ts:t/host/h1.ts#f1"), ghost("ts:t/host/h2.ts#f2")]),
      wires: [
        { source: "ts:t/host/h1.ts#f1", target: "vis", weight: 1, kind: "calls", underlyingEdgeIds: ["e1"] },
        { source: "ts:t/host/h2.ts#f2", target: "vis", weight: 1, kind: "calls", underlyingEdgeIds: ["e2"] },
      ],
    };
    const grouped = groupGhostEmission(input, indexFixture());
    expect([...grouped.ghosts.keys()]).toEqual(["ts:t/host"]);
    expect(grouped.wires).toEqual([{ source: "ts:t/host", target: "vis", weight: 2, kind: "calls", underlyingEdgeIds: ["e1", "e2"] }]);
  });

  it("returns the emission unchanged when no folder reaches the threshold", () => {
    const input: GhostEmission = {
      ghosts: new Map([["ts:t/host/h1.ts#f1", { label: "f1", context: "", ghostKind: "function" }]]),
      wires: [{ source: "ts:t/host/h1.ts#f1", target: "vis", weight: 1, kind: "calls", underlyingEdgeIds: ["e1"] }],
    };
    expect(groupGhostEmission(input, indexFixture())).toEqual(input);
  });
});
