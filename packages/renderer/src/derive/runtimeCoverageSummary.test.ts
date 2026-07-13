import { describe, expect, it } from "vitest";
import type { GraphArtifact, JsonValue, TestExecutionCoverage } from "@meridian/core";
import { runtimeCoverageSummary } from "./runtimeCoverageSummary";

describe("runtimeCoverageSummary", () => {
  it("counts hit functions and branch paths across every reported file", () => {
    const summary = runtimeCoverageSummary(artifact(coverage({
      "src/a.ts": {
        functions: [fn(3), fn(0)],
        branches: [{ type: "if", location: span(), paths: [path(0, 2), path(1, 0)] }],
      },
      "src/b.ts": {
        functions: [fn(1), fn(0), fn(0)],
        branches: [{ type: "cond-expr", location: span(), paths: [path(0, 0), path(1, 4)] }],
      },
    })));

    expect(summary).toEqual({
      functions: { hit: 2, total: 5, percent: 40 },
      branchPaths: { hit: 2, total: 4, percent: 50 },
    });
  });

  it("keeps an empty reported category distinct from zero-percent coverage", () => {
    const summary = runtimeCoverageSummary(artifact(coverage({
      "src/a.ts": { functions: [fn(0)], branches: [] },
    })));

    expect(summary).toEqual({
      functions: { hit: 0, total: 1, percent: 0 },
      branchPaths: { hit: 0, total: 0, percent: null },
    });
  });

  it("returns null when runtime coverage is absent", () => {
    expect(runtimeCoverageSummary(artifact())).toBeNull();
  });

  it("returns null when the open extension payload is malformed", () => {
    const malformed = artifact();
    malformed.extensions = { testExecutionCoverage: { version: "1.0.0" } };
    expect(runtimeCoverageSummary(malformed)).toBeNull();
  });
});

function artifact(runtime?: TestExecutionCoverage): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-14T00:00:00.000Z",
    generator: { name: "test", version: "0" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes: [],
    edges: [],
    ...(runtime ? { extensions: { testExecutionCoverage: runtime as unknown as JsonValue } } : {}),
  };
}

function coverage(files: TestExecutionCoverage["files"]): TestExecutionCoverage {
  return {
    version: "1.0.0",
    aggregate: true,
    producer: { inputFormat: "istanbul-coverage-map" },
    files,
  };
}

function fn(hits: number): TestExecutionCoverage["files"][string]["functions"][number] {
  return { name: "fn", hits, decl: span(), location: span() };
}

function path(
  index: number,
  hits: number,
): TestExecutionCoverage["files"][string]["branches"][number]["paths"][number] {
  return { index, hits, location: span() };
}

function span() {
  return { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };
}
