import { readFileSync, writeFileSync } from "node:fs";
import type { ExtractionResult } from "@meridian/core";
import { describe, expect, it } from "vitest";
import {
  compareExtractionResults,
  type DifferentialCategory,
} from "./differential";
import {
  comparePersistedExtractionEvidence,
  disposeExtractionDifferentialEvidence,
  persistExtractionDifferentialEvidence,
} from "./differential-evidence";
import { semanticExtractionDigest } from "./semantic-normalize";

const NODE_ID = "ts:src/service.ts#run";

describe("compareExtractionResults negative controls", () => {
  it("detects a node-field mismatch", () => {
    expectOnlyMismatch("nodes", (incremental) => {
      incremental.nodes[0]!.displayName = "renamedRun";
    });
  });

  it("detects an edge call-site mismatch", () => {
    expectOnlyMismatch("edges", (incremental) => {
      incremental.edges[0]!.callSites![0]!.line = 9;
    });
  });

  it("detects a nested flow mismatch", () => {
    expectOnlyMismatch("flows", (incremental) => {
      const branch = incremental.flows![NODE_ID]![0];
      if (branch?.kind !== "branch") throw new Error("fixture branch is missing");
      const exit = branch.paths[0]?.body[0];
      if (exit?.kind !== "exit") throw new Error("fixture exit is missing");
      exit.label = "changed";
    });
  });

  it("detects a port-field mismatch", () => {
    expectOnlyMismatch("ports", (incremental) => {
      incremental.ports![0]!.channel = "POST /api/items";
    });
  });

  it("detects a diagnostic-field mismatch", () => {
    expectOnlyMismatch("diagnostics", (incremental) => {
      incremental.diagnostics[0]!.message = "changed diagnostic";
    });
  });

  it("compares exact persisted bytes after releasing the complete incremental graph", async () => {
    let incremental: ExtractionResult | null = fixtureResult();
    const evidence = persistExtractionDifferentialEvidence(incremental);
    try {
      expect(evidence.digest).toBe(semanticExtractionDigest(incremental));
      incremental = null;
      const cold = fixtureResult();

      expect(await comparePersistedExtractionEvidence(evidence, cold)).toMatchObject({
        equal: true,
        incrementalDigest: evidence.digest,
        coldDigest: evidence.digest,
        mismatches: [],
      });

      // Keep all advisory digest metadata unchanged and mutate one same-length canonical byte.
      // Literal comparison, rather than digest equality, must still reject the evidence.
      const edgeBytes = readFileSync(evidence.categories.edges.path, "utf8");
      expect(edgeBytes).toContain('"line":3');
      writeFileSync(
        evidence.categories.edges.path,
        edgeBytes.replace('"line":3', '"line":9'),
      );
      expect(await comparePersistedExtractionEvidence(evidence, cold)).toMatchObject({
        equal: false,
        mismatches: [{ category: "edges" }],
      });
      expect(incremental).toBeNull();
    } finally {
      disposeExtractionDifferentialEvidence(evidence);
    }
  });
});

function expectOnlyMismatch(
  category: DifferentialCategory,
  mutate: (incremental: ExtractionResult) => void,
): void {
  const cold = fixtureResult();
  const incremental = structuredClone(cold);
  mutate(incremental);

  const report = compareExtractionResults(incremental, cold);

  expect(report.equal).toBe(false);
  expect(report.incrementalDigest).not.toBe(report.coldDigest);
  expect(report.mismatches.map((mismatch) => mismatch.category)).toEqual([category]);
  expect(report.mismatches[0]!.incrementalDigest).not.toBe(
    report.mismatches[0]!.coldDigest,
  );
}

function fixtureResult(): ExtractionResult {
  return {
    language: "typescript",
    nodes: [{
      id: NODE_ID,
      kind: "function",
      qualifiedName: "run",
      displayName: "run",
      location: {
        file: "src/service.ts",
        startLine: 1,
        endLine: 5,
      },
    }],
    edges: [{
      id: `calls@${NODE_ID}|${NODE_ID}`,
      source: NODE_ID,
      target: NODE_ID,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
      callSites: [{
        file: "src/service.ts",
        line: 3,
        col: 2,
        endLine: 3,
        endCol: 7,
      }],
    }],
    stats: {
      files: 1,
      nodeCountByKind: { function: 1 },
      edgeCountByResolution: { resolved: 1 },
      summaryCoverage: { withSummary: 0, total: 1 },
      externalCallsDropped: 0,
      unresolvedCalls: 1,
    },
    diagnostics: [{
      severity: "warn",
      message: "one unresolved call",
      nodeId: NODE_ID,
    }],
    flows: {
      [NODE_ID]: [{
        kind: "branch",
        label: "if ready",
        branchKind: "if",
        paths: [{
          label: "then",
          role: "then",
          pathId: "then",
          body: [{
            kind: "exit",
            variant: "return",
            label: "ready",
          }],
        }],
      }],
    },
    ports: [{
      nodeId: NODE_ID,
      direction: "out",
      protocol: "http",
      channel: "GET /api/items",
      label: "/api/items",
      callSite: {
        file: "src/service.ts",
        line: 4,
        col: 2,
        endLine: 4,
        endCol: 21,
      },
      surfaceId: "fetch",
      operation: "request",
    }],
  };
}
