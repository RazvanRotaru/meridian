import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type { ReviewFileRow, ReviewUnitRow } from "./reviewFiles";
import { reviewGraphNodeProgress } from "./reviewNodeViewed";

const PACKAGE = "pkg:src";
const FILE_A = "module:src/a.ts";
const CLASS_A = "class:src/a.ts:A";
const METHOD_A = "method:src/a.ts:A.run";
const FILE_B = "module:src/b.ts";
const METHOD_B = "method:src/b.ts:run";

describe("reviewGraphNodeProgress", () => {
  it("counts only visible graph cards that expose review viewed controls", () => {
    const index = buildGraphIndex(artifact());
    const files = [
      reviewFile("src/a.ts", FILE_A, reviewUnit(METHOD_A, "A.run")),
      reviewFile("src/b.ts", FILE_B, reviewUnit(METHOD_B, "run")),
    ];

    const progress = reviewGraphNodeProgress(
      [
        rfNode(PACKAGE, "package"),
        rfNode(FILE_A, "file"),
        rfNode(CLASS_A, "unit"),
        rfNode(METHOD_A, "block"),
        rfNode(FILE_B, "file"),
        // These can carry semantic ids that resolve to review units, but their node components do
        // not expose viewed chrome and therefore must not inflate graph progress.
        rfNode(METHOD_B, "ghost"),
        rfNode("step:run:0", "step"),
        rfNode("service:backend", "serviceDomain"),
        { ...rfNode(METHOD_B, "block"), hidden: true },
      ],
      files,
      { [PACKAGE]: [FILE_A, FILE_B] },
      index,
      {},
      {},
      { "src/a.ts": "VIEWED", "src/b.ts": "UNVIEWED" },
      {},
    );

    // File A, its changed method, and the class aggregate are done. The two-file package aggregate
    // and file B remain todo. Ghost/step/service/hidden cards do not participate.
    expect(progress).toEqual({ viewed: 3, total: 5 });
  });

  it("deduplicates node ids and ignores visible context without a review target", () => {
    const index = buildGraphIndex(artifact());
    const files = [reviewFile("src/a.ts", FILE_A, reviewUnit(METHOD_A, "A.run"))];

    expect(reviewGraphNodeProgress(
      [
        rfNode(METHOD_A, "block"),
        rfNode(METHOD_A, "block"),
        rfNode("method:src/context.ts:read", "block"),
      ],
      files,
      {},
      index,
      {},
      {},
      { "src/a.ts": "VIEWED" },
      {},
    )).toEqual({ viewed: 1, total: 1 });
  });
});

function artifact(): GraphArtifact {
  return {
    schemaVersion: "1.0.0",
    generatedAt: "2026-08-06T00:00:00.000Z",
    generator: { name: "test", version: "0" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes: [
      graphNode(PACKAGE, "package", "src", undefined),
      graphNode(FILE_A, "module", "src/a.ts", PACKAGE),
      graphNode(CLASS_A, "class", "A", FILE_A, "src/a.ts"),
      graphNode(METHOD_A, "method", "A.run", CLASS_A, "src/a.ts"),
      graphNode(FILE_B, "module", "src/b.ts", PACKAGE),
      graphNode(METHOD_B, "function", "run", FILE_B, "src/b.ts"),
    ],
    edges: [],
  };
}

function graphNode(
  id: string,
  kind: string,
  displayName: string,
  parentId?: string,
  file = displayName,
): GraphNode {
  return {
    id,
    kind,
    qualifiedName: displayName,
    displayName,
    ...(parentId === undefined ? {} : { parentId }),
    location: { file, startLine: 1, endLine: 20 },
  };
}

function reviewFile(path: string, moduleId: string, unit: ReviewUnitRow): ReviewFileRow {
  return {
    path,
    status: "modified",
    moduleId,
    isTest: false,
    units: [unit],
    fingerprint: `${path}:fingerprint`,
    address: `file:${path}`,
    blastRadius: 0,
    deletedImpact: null,
  };
}

function reviewUnit(nodeId: string, displayName: string): ReviewUnitRow {
  return {
    nodeId,
    displayName,
    kind: "method",
    startLine: 1,
    endLine: 20,
    depth: 0,
    isTest: false,
    fingerprint: `${nodeId}:fingerprint`,
    address: `unit:${nodeId}`,
  };
}

function rfNode(id: string, type: string): { id: string; type: string } {
  return { id, type };
}
