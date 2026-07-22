import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type GraphArtifact } from "@meridian/core";
import {
  changedMetadataForWorker,
  emptySideHintsForWorker,
  isRepositoryAnalysisFacts,
  isRepositoryAnalysisWorkerResponse,
} from "./repository-analysis-worker-job";

describe("repository analysis worker protocol", () => {
  it("sorts canonical status-rich changed files without losing rename provenance", () => {
    const artifact = fixtureArtifact();
    artifact.extensions = {
      changedSince: {
        baseRef: "base",
        manifest: [
          { path: "z/new.ts", previousPath: "z/old.ts", status: "renamed" },
          { path: "a/deleted.py", status: "deleted" },
        ],
      },
    };

    expect(changedMetadataForWorker(artifact, "base")).toEqual({
      changedFiles: [
        { path: "a/deleted.py", status: "deleted" },
        { path: "z/new.ts", previousPath: "z/old.ts", status: "renamed" },
      ],
      changedSinceBaseRef: "base",
    });
  });

  it("returns one representative hint for every selected extractor language", () => {
    const artifact = fixtureArtifact();
    artifact.nodes.push({
      id: "py:src/job.py#run",
      kind: "function",
      qualifiedName: "run",
      displayName: "run",
      language: "python",
      location: { file: "src/job.py", startLine: 1 },
    });

    expect(emptySideHintsForWorker(artifact, [], [
      { extensions: [".ts", ".tsx"] },
      { extensions: [".py"] },
    ])).toEqual(["src/index.ts", "src/job.py"]);
  });

  it("rejects a compact child attestation for any schema other than the current schema", () => {
    const response = {
      type: "result",
      result: {
        kind: "file",
        operation: "analyze",
        id: "analysis",
        artifactPath: "/tmp/artifact.json",
        artifactBytes: 10,
        artifactSha256: "a".repeat(64),
        branchVariant: null,
        graphSummary: {
          schemaVersion: "1.99.0",
          generatedAt: "2026-07-21T00:00:00.000Z",
          nodeCount: 0,
          edgeCount: 0,
        },
        target: fixtureArtifact().target,
        changedFiles: [],
        emptySideHints: [],
        sourceFiles: [],
        changedSinceBaseRef: null,
        warnings: [],
      },
    };

    expect(isRepositoryAnalysisWorkerResponse(response)).toBe(false);
    response.result.graphSummary.schemaVersion = SCHEMA_VERSION;
    expect(isRepositoryAnalysisWorkerResponse(response)).toBe(true);
  });

  it("strictly validates persisted compact analysis facts without a worker envelope", () => {
    const facts = {
      summary: {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: "2026-07-21T00:00:00.000Z",
        nodeCount: 1,
        edgeCount: 0,
      },
      target: fixtureArtifact().target,
      changedFiles: [{ path: "src/index.ts", status: "modified" }],
      emptySideHints: ["src/index.ts"],
      sourceFiles: ["src/index.ts"],
      changedSinceBaseRef: "base",
      warnings: [],
    };

    expect(isRepositoryAnalysisFacts(facts)).toBe(true);
    expect(isRepositoryAnalysisFacts({ ...facts, unexpected: true })).toBe(false);
    expect(isRepositoryAnalysisFacts({
      ...facts,
      summary: { ...facts.summary, schemaVersion: "1.99.0" },
    })).toBe(false);
  });
});

function fixtureArtifact(): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-21T00:00:00.000Z",
    generator: { name: "meridian", version: "test" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes: [{
      id: "ts:src/index.ts",
      kind: "module",
      qualifiedName: "src/index.ts",
      displayName: "index.ts",
      language: "typescript",
      location: { file: "src/index.ts", startLine: 1 },
    }],
    edges: [],
  };
}
