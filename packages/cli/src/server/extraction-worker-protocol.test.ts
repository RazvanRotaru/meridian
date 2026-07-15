import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@meridian/core";
import type { ChangedFileManifestEntry, GraphArtifact } from "@meridian/core";
import {
  boundedWorkerWarnings,
  changedSinceWorkerMetadata,
  isExtractionWorkerResponse,
  MAX_WORKER_HINTED_FILES,
  MAX_WORKER_WARNINGS,
  representativeHintedFiles,
} from "./extraction-worker-protocol";

const MERGE_BASE = "cccccccccccccccccccccccccccccccccccccccc";

describe("extraction worker changed-file IPC", () => {
  it("accepts the canonical added/modified/deleted/renamed manifest", () => {
    expect(isExtractionWorkerResponse(responseWith([
      { path: "src/added.ts", status: "added" },
      { path: "src/changed.ts", status: "modified" },
      { path: "src/deleted.ts", status: "deleted" },
      { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
    ]))).toBe(true);
  });

  it("rejects malformed rename provenance and unsafe paths", () => {
    expect(isExtractionWorkerResponse(responseWith([
      { path: "src/new.ts", status: "renamed" },
    ]))).toBe(false);
    expect(isExtractionWorkerResponse(responseWith([
      { path: "../escape.ts", status: "added" },
    ]))).toBe(false);
    expect(isExtractionWorkerResponse(responseWith([
      { path: "src/a.ts", status: "modified", previousPath: "src/old.ts" },
    ]))).toBe(false);
  });

  it("fails closed when a changed-since artifact omits its canonical manifest", () => {
    expect(() => changedSinceWorkerMetadata(
      artifactWithChangedSince({ baseRef: MERGE_BASE }),
      { changedSince: "refs/meridian/base", changedSinceLabel: MERGE_BASE },
    )).toThrowError(/canonical file manifest/);
  });

  it("fails closed when changed-since base provenance does not exactly match the request", () => {
    expect(() => changedSinceWorkerMetadata(
      artifactWithChangedSince({ baseRef: "main", manifest: [] }),
      { changedSince: "refs/meridian/base", changedSinceLabel: MERGE_BASE },
    )).toThrowError(/mismatched base provenance/);
  });

  it("returns the exact canonical manifest and base provenance for valid changed-since output", () => {
    const manifest: ChangedFileManifestEntry[] = [
      { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
    ];
    expect(changedSinceWorkerMetadata(
      artifactWithChangedSince({ baseRef: MERGE_BASE, manifest }),
      { changedSince: "refs/meridian/base", changedSinceLabel: MERGE_BASE },
    )).toEqual({ changedFiles: manifest, changedSinceBaseRef: MERGE_BASE });
  });

  it("reduces mixed TypeScript/Python repositories to one canonical hint per extractor", () => {
    const artifact = artifactWithChangedSince(undefined, [
      "z/second.ts",
      "a/worker.py",
      "b/other.py",
      "m/view.tsx",
    ]);
    expect(representativeHintedFiles(artifact, [
      { path: "0/added.ts", status: "added" },
      { path: "src/deleted.py", status: "deleted" },
    ])).toEqual(["0/added.ts", "a/worker.py"]);
  });

  it("bounds changed files, hints, and warnings at the worker response boundary", () => {
    expect(isExtractionWorkerResponse(responseWith([
      { path: `${"x".repeat(4_097)}.ts`, status: "added" },
    ]))).toBe(false);
    expect(isExtractionWorkerResponse(responseWith([], {
      hintedFiles: Array.from({ length: MAX_WORKER_HINTED_FILES + 1 }, (_, index) => `src/${index}.ts`),
    }))).toBe(false);
    expect(isExtractionWorkerResponse(responseWith([], {
      warnings: Array.from({ length: MAX_WORKER_WARNINGS + 1 }, (_, index) => `warning ${index}`),
    }))).toBe(false);
  });

  it("caps and redacts warnings before they leave the child process", () => {
    const token = "github_pat_worker_warning_secret_123456789";
    const warnings = boundedWorkerWarnings([
      `unsafe ${token}`,
      ...Array.from({ length: MAX_WORKER_WARNINGS + 10 }, (_, index) => `${index}:${"x".repeat(5_000)}`),
    ], token);
    expect(warnings.length).toBeLessThanOrEqual(MAX_WORKER_WARNINGS);
    expect(warnings.every((warning) => Buffer.byteLength(warning) <= 4_000)).toBe(true);
    expect(warnings.join("\n")).not.toContain(token);
  });
});

function artifactWithChangedSince(changedSince: unknown, files: string[] = []): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-15T00:00:00.000Z",
    generator: { name: "meridian", version: "test" },
    target: { name: "org/repo", root: ".", language: "typescript" },
    telemetry: {
      joinKey: "node.id",
      requiredRuntimeAttributes: [],
      serviceDefaulting: "forbidden",
    },
    nodes: files.map((file, index) => ({
      id: `module:${index}`,
      kind: "module",
      qualifiedName: `module.${index}`,
      displayName: `module-${index}`,
      location: { file, startLine: 1 },
    })),
    edges: [],
    extensions: { changedSince } as GraphArtifact["extensions"],
  };
}

function responseWith(
  changedFiles: unknown[],
  overrides: { hintedFiles?: string[]; warnings?: string[] } = {},
): unknown {
  return {
    type: "result",
    result: {
      kind: "file",
      artifactPath: "/tmp/artifact.json",
      artifactBytes: 1,
      artifactSha256: "a".repeat(64),
      projectionDirectory: "/tmp/graph-projections",
      graphSummary: {
        schemaVersion: "1.0.0",
        generatedAt: "2026-07-15T00:00:00.000Z",
        nodeCount: 0,
        edgeCount: 0,
      },
      changedFiles,
      hintedFiles: overrides.hintedFiles ?? ["src/a.ts"],
      warnings: overrides.warnings ?? [],
    },
  };
}
