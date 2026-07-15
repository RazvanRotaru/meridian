import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import { traceBundleSchema } from "@meridian/core";
import { afterEach, describe, expect, it } from "vitest";
import { runStandaloneMockTelemetry } from "./standalone-view-mock-worker";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("runStandaloneMockTelemetry", () => {
  it("derives traces in a child and returns only a bounded response file", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-standalone-mock-"));
    temporary.push(root);
    const artifactPath = join(root, "artifact.json");
    writeFileSync(artifactPath, JSON.stringify(fixture()));

    const result = await runStandaloneMockTelemetry({
      artifactPath,
      scratchRoot: root,
      kind: "traces",
      environment: "demo",
    });
    const body = JSON.parse(readFileSync(result.path, "utf8"));

    expect(result).not.toHaveProperty("artifact");
    expect(traceBundleSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ source: "mock", env: "demo", traces: expect.any(Array) });
    result.cleanup();
  });
});

function fixture(): GraphArtifact {
  return {
    schemaVersion: "1.0.0",
    generatedAt: "2026-07-15T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "fixture", root: ".", language: "typescript" },
    telemetry: { joinKey: "node.id", requiredRuntimeAttributes: ["service.name"], serviceDefaulting: "forbidden" },
    nodes: [{
      id: "ts:src/a.ts#run",
      kind: "function",
      qualifiedName: "run",
      displayName: "run",
      location: { file: "src/a.ts", startLine: 1, endLine: 2 },
    }],
    edges: [],
  };
}
