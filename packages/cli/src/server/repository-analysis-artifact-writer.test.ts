import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type GraphArtifact } from "@meridian/core";
import { writeValidatedRepositoryArtifact } from "./repository-analysis-artifact-writer";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("writeValidatedRepositoryArtifact", () => {
  it("matches JSON.stringify byte-for-byte while streaming nodes, edges, and Unicode", () => {
    const directory = mkdtempSync(join(tmpdir(), "meridian-artifact-writer-"));
    directories.push(directory);
    const path = join(directory, "artifact.json");
    const artifact: GraphArtifact = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-07-21T12:34:56.000Z",
      generator: { name: "meridian", version: "test" },
      target: {
        name: "多言語 / café 🚀",
        root: ".",
        language: "typescript",
        vcs: { repository: "https://example.test/é.git", commit: "a".repeat(40) },
      },
      telemetry: {
        joinKey: "node.id",
        requiredRuntimeAttributes: ["service.name", "環境"],
        serviceDefaulting: "forbidden",
      },
      nodes: [{
        id: "ts:src/café.ts#実行",
        kind: "function",
        qualifiedName: "実行",
        displayName: "実行 🚀",
        summary: undefined,
        language: "typescript",
        location: { file: "src/café.ts", startLine: 1, endLine: 3, startCol: 0 },
        tags: ["changed", "tést"],
      }],
      edges: [{
        id: "calls@ts:src/café.ts#実行|ext:世界",
        source: "ts:src/café.ts#実行",
        target: "ext:世界",
        kind: "calls",
        resolution: "external",
        callSites: [{ file: "src/café.ts", line: 2, col: 4 }],
      }],
      extensions: {
        nested: { message: "line one\n雪と🌨️", values: [null, true, 42, "é"] },
      },
    };
    const expected = Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8");

    const written = writeValidatedRepositoryArtifact(path, artifact);

    expect(readFileSync(path)).toEqual(expected);
    expect(written.byteLength).toBe(expected.byteLength);
    expect(written.byteDigest).toBe(createHash("sha256").update(expected).digest("hex"));
    expect(written.summary).toEqual({
      schemaVersion: SCHEMA_VERSION,
      generatedAt: artifact.generatedAt,
      nodeCount: 1,
      edgeCount: 1,
    });
  });
});
