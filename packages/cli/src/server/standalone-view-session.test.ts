import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import { afterEach, describe, expect, it } from "vitest";
import { readGraphProjectionManifest } from "./graph-projection-bundle";
import { readSyntheticCapabilitySidecar } from "./synthetic-capability-sidecar";
import { createStandaloneViewSession } from "./standalone-view-session";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("createStandaloneViewSession", () => {
  it("publishes only paths and bounded metadata, with an absent sidecar when source is disabled", () => {
    const cwd = mkdtempSync(join(tmpdir(), "meridian-view-input-"));
    temporary.push(cwd);
    const graphPath = join(cwd, "graph.json");
    writeFileSync(graphPath, JSON.stringify(fixture()));

    const session = createStandaloneViewSession({ graphPath, cwd, sourceRoot: null });
    temporary.push(session.root);

    expect(session).not.toHaveProperty("artifact");
    expect(session.graphSummary).toMatchObject({ nodeCount: 2, edgeCount: 0 });
    expect(readGraphProjectionManifest(session.projectionDirectory)).toMatchObject({
      formatVersion: 3,
      graphSummary: session.graphSummary,
    });
    expect(readSyntheticCapabilitySidecar(session.syntheticCapabilityPath)).toMatchObject({
      version: 1,
      state: "absent",
      scenarios: [],
    });

    session.cleanup();
    expect(existsSync(session.root)).toBe(false);
  });
});

function fixture(): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-15T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes: [
      { id: "ts:src", kind: "package", qualifiedName: "root", displayName: "root", parentId: null, location: { file: "src", startLine: 1 } },
      { id: "ts:src/a.ts", kind: "module", qualifiedName: "module", displayName: "module", parentId: "ts:src", location: { file: "src/a.ts", startLine: 1 } },
    ],
    edges: [],
  };
}
