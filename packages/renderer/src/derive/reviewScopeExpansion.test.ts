import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type { ReviewFileRow, ReviewUnitRow } from "./reviewFiles";
import { expandReviewScopeBaseUnits } from "./reviewScopeExpansion";

const FILE_A = "ts:src/a.ts";
const CLASS_A = `${FILE_A}#A`;
const METHOD_A = `${CLASS_A}.removed`;
const FILE_B = "ts:src/b.ts";
const CLASS_B = `${FILE_B}#B`;
const METHOD_B = `${CLASS_B}.removed`;

function node(id: string, kind: string, file: string, parentId?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file, startLine: 1, endLine: 20 },
  };
}

const artifact: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-14T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node(FILE_A, "module", "src/a.ts"),
    node(CLASS_A, "class", "src/a.ts", FILE_A),
    node(METHOD_A, "method", "src/a.ts", CLASS_A),
    node(FILE_B, "module", "src/b.ts"),
    node(CLASS_B, "class", "src/b.ts", FILE_B),
    node(METHOD_B, "method", "src/b.ts", CLASS_B),
  ],
  edges: [],
};

function unit(nodeId: string, sourceSide?: "head" | "base"): ReviewUnitRow {
  return {
    nodeId,
    displayName: nodeId,
    kind: "method",
    startLine: 5,
    endLine: 8,
    sourceSide,
    depth: 1,
    isTest: false,
    fingerprint: nodeId,
  };
}

function file(path: string, moduleId: string, units: ReviewUnitRow[]): ReviewFileRow {
  return {
    path,
    status: "modified",
    moduleId,
    isTest: false,
    units,
    blastRadius: 0,
    deletedImpact: null,
  };
}

describe("expandReviewScopeBaseUnits", () => {
  it("opens the base-only containment path for included files only", () => {
    const index = buildGraphIndex(artifact);
    const expanded = expandReviewScopeBaseUnits(
      new Set(["keep-open"]),
      index,
      [
        file("./src/a.ts", FILE_A, [unit(METHOD_A, "base")]),
        file("src/b.ts", FILE_B, [unit(METHOD_B, "base")]),
      ],
      new Set(["src/a.ts"]),
      { baseNodeIds: new Set(), deletedNodeIds: new Set() },
    );

    expect(expanded).toEqual(new Set(["keep-open", FILE_A, CLASS_A]));
  });

  it("recognizes a legacy base row by comparison/deleted membership", () => {
    const index = buildGraphIndex(artifact);
    const expanded = expandReviewScopeBaseUnits(
      new Set(),
      index,
      [file("src/a.ts", FILE_A, [unit(METHOD_A)])],
      new Set(["src/a.ts"]),
      { baseNodeIds: new Set([CLASS_A]), deletedNodeIds: new Set([METHOD_A]) },
    );

    expect(expanded).toEqual(new Set([FILE_A, CLASS_A]));
  });

  it("does not pre-open declaration paths hidden beneath a collapsed rollup", () => {
    const index = buildGraphIndex(artifact);
    const expanded = expandReviewScopeBaseUnits(
      new Set(),
      index,
      [file("src/a.ts", FILE_A, [unit(METHOD_A, "base")])],
      new Set(["src/a.ts"]),
      { baseNodeIds: new Set(), deletedNodeIds: new Set() },
      new Set([FILE_A]),
    );

    expect(expanded).toEqual(new Set());
  });
});
