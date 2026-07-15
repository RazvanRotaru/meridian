import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import {
  graphSummaryFor,
  InspectionSnapshotStore,
  isInspectionSnapshotId,
} from "./inspection-snapshot-store";
import { writeSyntheticCapabilitySidecar } from "./synthetic-capability-sidecar";

let cacheRoot: string;
let outsideRoot: string;
const SUMMARY = graphSummaryFor(artifactFor("summary"));

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "meridian-snapshot-store-"));
  outsideRoot = mkdtempSync(join(tmpdir(), "meridian-snapshot-outside-"));
});

afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

describe("InspectionSnapshotStore", () => {
  it("recovers graph and source lookups in a fresh process without loading the graph eagerly", () => {
    const files = createSnapshotFiles("first", artifactFor("first"));
    const original = new InspectionSnapshotStore({ cacheRoot });
    const descriptor = original.publish({
      id: "pr-a1b2c3-head",
      artifactPath: files.artifactPath,
      graphSummary: SUMMARY,
      sourceRoot: files.sourceRoot,
      sourceSubdir: "apps/api",
      source: { kind: "github", owner: "acme", repo: "service", subdir: "apps/api" },
      publishedAt: "2026-07-14T10:00:00.000Z",
    });

    expect(descriptor.artifact.path).not.toContain(cacheRoot);
    expect(descriptor.source.rootPath).not.toContain(cacheRoot);
    expect(original.cacheStats().artifactEntries).toBe(0);

    const restarted = new InspectionSnapshotStore({ cacheRoot });
    expect(restarted.resolveDescriptor("pr-a1b2c3-head")).toEqual(descriptor);
    expect(restarted.cacheStats().artifactEntries).toBe(0);
    expect(restarted.resolveSource("pr-a1b2c3-head")).toMatchObject({
      rootDir: realpathSync(files.sourceRoot),
      sourceDir: realpathSync(join(files.sourceRoot, "apps", "api")),
      subdir: "apps/api",
      metadata: { kind: "github", owner: "acme", repo: "service", subdir: "apps/api" },
    });
    expect(restarted.resolveArtifact("pr-a1b2c3-head")).toMatchObject({
      path: realpathSync(files.artifactPath),
      size: Buffer.byteLength(`${JSON.stringify(artifactFor("first"))}\n`),
    });
    expect(restarted.cacheStats().artifactEntries).toBe(0);
  });

  it("never retains or reparses the publisher's graph object", () => {
    const artifact = artifactFor("seeded");
    const files = createSnapshotFiles("seeded", artifact);
    const store = new InspectionSnapshotStore({ cacheRoot });
    store.publish({
      id: "seeded-id",
      artifactPath: files.artifactPath,
      graphSummary: graphSummaryFor(artifact),
      sourceRoot: files.sourceRoot,
      source: { kind: "other" },
    });

    expect(store.resolveArtifact("seeded-id")).toMatchObject({ path: realpathSync(files.artifactPath) });
    expect(store.resolveDescriptor("seeded-id")?.graphSummary).toEqual(graphSummaryFor(artifact));
    expect(store.cacheStats().artifactEntries).toBe(0);
  });

  it("publishes idempotently but never lets an id change which immutable files it names", () => {
    const first = createSnapshotFiles("first", artifactFor("first"));
    const second = createSnapshotFiles("second", artifactFor("second"));
    const store = new InspectionSnapshotStore({ cacheRoot });
    const input = {
      id: "stable-id",
      artifactPath: first.artifactPath,
      graphSummary: SUMMARY,
      sourceRoot: first.sourceRoot,
      source: { kind: "other" } as const,
      publishedAt: "2026-07-14T10:00:00.000Z",
    };

    const published = store.publish(input);
    const repeated = store.publish({ ...input, publishedAt: "2026-07-14T11:00:00.000Z" });
    expect(repeated).toEqual(published);
    expect(() => store.publish({
      ...input,
      artifactPath: second.artifactPath,
      sourceRoot: second.sourceRoot,
    })).toThrow(/already bound/);
    expect(store.resolveArtifact("stable-id")?.path).toBe(realpathSync(first.artifactPath));
    expect(readdirSync(join(cacheRoot, "inspection-snapshots", "st"))).toEqual(["stable-id"]);
  });

  it("rejects unsafe ids, paths outside the cache, traversal descriptors, and source symlink escapes", () => {
    const files = createSnapshotFiles("safe", artifactFor("safe"));
    const store = new InspectionSnapshotStore({ cacheRoot });
    const publish = (id: string) => store.publish({
      id,
      artifactPath: files.artifactPath,
      graphSummary: SUMMARY,
      sourceRoot: files.sourceRoot,
      source: { kind: "other" },
    });

    for (const id of ["", ".", "../escape", "a/b", "a\\b", "%2e%2e"]) {
      expect(isInspectionSnapshotId(id)).toBe(false);
      expect(() => publish(id)).toThrow(/snapshot id/);
      expect(store.resolveDescriptor(id)).toBeNull();
    }
    expect(isInspectionSnapshotId("pr-0123.dead_beef")).toBe(true);

    const outsideArtifact = join(outsideRoot, "artifact.json");
    writeFileSync(outsideArtifact, JSON.stringify(artifactFor("outside")));
    expect(() => store.publish({
      id: "outside-artifact",
      artifactPath: outsideArtifact,
      graphSummary: SUMMARY,
      sourceRoot: files.sourceRoot,
      source: { kind: "other" },
    })).toThrow(/inside the cache root/);
    expect(() => store.publish({
      id: "subdir-traversal",
      artifactPath: files.artifactPath,
      graphSummary: SUMMARY,
      sourceRoot: files.sourceRoot,
      sourceSubdir: "../stolen",
      source: { kind: "other" },
    })).toThrow(/subdirectory is unsafe/);

    writeRawDescriptor("malicious-id", {
      formatVersion: 4,
      id: "malicious-id",
      publishedAt: "2026-07-14T10:00:00.000Z",
      graphSummary: SUMMARY,
      artifact: { path: "../outside.json", vcsBranch: null },
      source: { rootPath: "repositories/safe", subdir: "", metadata: { kind: "other" } },
      synthetic: null,
    });
    expect(store.resolveDescriptor("malicious-id")).toBeNull();
    expect(store.resolveArtifact("malicious-id")).toBeNull();

    if (process.platform !== "win32") {
      mkdirSync(join(outsideRoot, "stolen"), { recursive: true });
      symlinkSync(join(outsideRoot, "stolen"), join(files.sourceRoot, "escape"), "dir");
      expect(() => store.publish({
        id: "symlink-escape",
        artifactPath: files.artifactPath,
        graphSummary: SUMMARY,
        sourceRoot: files.sourceRoot,
        sourceSubdir: "escape",
        source: { kind: "other" },
      })).toThrow(/escapes its root/);
    }
  });

  it("does not follow an injected descriptor-directory symlink outside the cache", () => {
    if (process.platform === "win32") return;
    symlinkSync(outsideRoot, join(cacheRoot, "inspection-snapshots"), "dir");
    expect(() => new InspectionSnapshotStore({ cacheRoot })).toThrow(/not a private directory/);
    expect(readdirSync(outsideRoot)).toEqual([]);
  });

  it("never reads or parses graph bytes while publishing and resolving immutable files", () => {
    const files = createSnapshotFiles("invalid", null);
    writeFileSync(files.artifactPath, "{ definitely not a graph", "utf8");
    const store = new InspectionSnapshotStore({ cacheRoot });

    expect(() => store.publish({
      id: "lazy-invalid",
      artifactPath: files.artifactPath,
      graphSummary: SUMMARY,
      sourceRoot: files.sourceRoot,
      source: { kind: "other" },
    })).not.toThrow();
    expect(store.resolveDescriptor("lazy-invalid")).not.toBeNull();
    expect(store.resolveSource("lazy-invalid")?.sourceDir).toBe(realpathSync(files.sourceRoot));
    expect(store.resolveArtifact("lazy-invalid")).toMatchObject({
      path: realpathSync(files.artifactPath),
      size: Buffer.byteLength("{ definitely not a graph"),
    });
    expect(store.cacheStats().artifactEntries).toBe(0);
  });

  it("keeps only descriptors inside the byte-aware LRU budget", () => {
    const store = new InspectionSnapshotStore({ cacheRoot, maxCacheBytes: 700 });
    for (const name of ["alpha", "bravo", "charlie"]) {
      const files = createSnapshotFiles(name, artifactFor(name, 4_000));
      store.publish({
        id: name,
        artifactPath: files.artifactPath,
        graphSummary: SUMMARY,
        sourceRoot: files.sourceRoot,
        source: { kind: "other" },
      });
    }
    store.clearMemoryCache();

    expect(store.resolveDescriptor("alpha")?.id).toBe("alpha");
    expect(store.resolveDescriptor("alpha")?.id).toBe("alpha");
    const afterHit = store.cacheStats();
    expect(afterHit.hits).toBeGreaterThan(0);
    expect(afterHit.bytes).toBeLessThanOrEqual(afterHit.maxBytes);
    expect(afterHit.artifactEntries).toBe(0);

    expect(store.resolveDescriptor("bravo")?.id).toBe("bravo");
    expect(store.resolveDescriptor("charlie")?.id).toBe("charlie");
    const afterEviction = store.cacheStats();
    expect(afterEviction.evictions).toBeGreaterThan(0);
    expect(afterEviction.artifactEntries).toBe(0);
    expect(afterEviction.bytes).toBeLessThanOrEqual(700);

    const missesBeforeReload = afterEviction.misses;
    expect(store.resolveDescriptor("alpha")?.id).toBe("alpha");
    expect(store.cacheStats().misses).toBeGreaterThan(missesBeforeReload);
  });

  it("never charges graph file bytes to the descriptor cache", () => {
    const files = createSnapshotFiles("large", artifactFor("large", 4_000));
    const store = new InspectionSnapshotStore({ cacheRoot, maxCacheBytes: 512 });
    store.publish({
      id: "large",
      artifactPath: files.artifactPath,
      graphSummary: SUMMARY,
      sourceRoot: files.sourceRoot,
      source: { kind: "other" },
    });
    store.clearMemoryCache();

    expect(store.resolveArtifact("large")?.size).toBeGreaterThan(4_000);
    expect(store.cacheStats()).toMatchObject({ artifactEntries: 0, descriptorEntries: 1 });
  });

  it("does not make a successfully published graph unreadable behind an implicit artifact-size ceiling", () => {
    const files = createSnapshotFiles("readable", artifactFor("readable", 4_000));
    const publish = (store: InspectionSnapshotStore, id: string) => store.publish({
      id,
      artifactPath: files.artifactPath,
      graphSummary: SUMMARY,
      sourceRoot: files.sourceRoot,
      source: { kind: "other" },
    });

    const defaultStore = new InspectionSnapshotStore({ cacheRoot });
    publish(defaultStore, "default-readable");
    expect(defaultStore.resolveArtifact("default-readable")?.size).toBeGreaterThan(4_000);

    const explicitlyCapped = new InspectionSnapshotStore({ cacheRoot, maxArtifactBytes: 128 });
    publish(explicitlyCapped, "explicitly-capped");
    expect(explicitlyCapped.resolveArtifact("explicitly-capped")).toBeNull();
  });

  it("retains request branch provenance in the descriptor without mutating the artifact", () => {
    const artifact = artifactFor("shared");
    artifact.target.vcs = { repository: "https://github.com/acme/service.git", commit: "a".repeat(40), branch: "first" };
    const files = createSnapshotFiles("shared", artifact);
    const store = new InspectionSnapshotStore({ cacheRoot });
    store.publish({
      id: "from-main",
      artifactPath: files.artifactPath,
      graphSummary: graphSummaryFor(artifact),
      vcsBranch: "main",
      sourceRoot: files.sourceRoot,
      source: { kind: "other" },
    });
    store.publish({
      id: "detached",
      artifactPath: files.artifactPath,
      graphSummary: graphSummaryFor(artifact),
      sourceRoot: files.sourceRoot,
      source: { kind: "other" },
    });

    expect(store.resolveArtifact("from-main")?.descriptor.artifact.vcsBranch).toBe("main");
    expect(store.resolveArtifact("detached")?.descriptor.artifact.vcsBranch).toBeNull();
    expect(JSON.parse(readFileSync(files.artifactPath, "utf8")).target.vcs.branch).toBe("first");
  });

  it("digest-binds a bounded adjacent sidecar and exact prepared-HEAD trust", () => {
    const headSha = "a".repeat(40);
    const artifact = artifactFor("prepared-head");
    artifact.target.vcs = {
      repository: "https://github.com/acme/service.git",
      commit: headSha,
      branch: "feature",
    };
    artifact.nodes.push({
      id: "ts:index.ts#run",
      kind: "function",
      qualifiedName: "run",
      displayName: "run",
      parentId: null,
      location: { file: "index.ts", startLine: 1, endLine: 1 },
    });
    const files = createSnapshotFiles("prepared-head", artifact);
    writeFileSync(join(files.sourceRoot, "apps", "api", "meridian.synthetic.json"), JSON.stringify({
      manifestVersion: "1.0.0",
      scenarios: [{
        id: "run",
        label: "Run",
        rootId: "ts:index.ts#run",
        defaultInput: null,
        invoke: { module: "index.ts", export: "run" },
      }],
    }), "utf8");
    writeSyntheticCapabilitySidecar(files.artifactPath, join(files.sourceRoot, "apps", "api"), artifact);
    const store = new InspectionSnapshotStore({ cacheRoot });
    const descriptor = store.publish({
      id: "prepared-head",
      artifactPath: files.artifactPath,
      graphSummary: graphSummaryFor(artifact),
      sourceRoot: files.sourceRoot,
      sourceSubdir: "apps/api",
      source: { kind: "github", owner: "acme", repo: "service", subdir: "apps/api" },
      syntheticExecutionTrust: {
        mode: "sandboxed-pr",
        provenance: { repository: "acme/service", headSha },
      },
    });

    expect(descriptor.synthetic).toMatchObject({
      path: expect.stringContaining("synthetic-capability.json"),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      executionTrust: { provenance: { repository: "acme/service", headSha } },
    });
    expect(store.resolveSyntheticCapability("prepared-head")).toMatchObject({
      capability: { state: "ready", artifactCommit: headSha },
      executionTrust: { provenance: { repository: "acme/service", headSha } },
    });

    const sidecarPath = join(dirname(files.artifactPath), "synthetic-capability.json");
    writeFileSync(sidecarPath, `${readFileSync(sidecarPath, "utf8")} `, "utf8");
    expect(store.resolveSyntheticCapability("prepared-head")).toBeNull();
  });

  it("rejects sandbox trust that does not exactly match source and artifact commit provenance", () => {
    const artifact = artifactFor("mismatch");
    artifact.target.vcs = { repository: "https://github.com/acme/service.git", commit: "b".repeat(40) };
    const files = createSnapshotFiles("mismatch", artifact);
    writeSyntheticCapabilitySidecar(files.artifactPath, files.sourceRoot, artifact);
    const store = new InspectionSnapshotStore({ cacheRoot });
    expect(() => store.publish({
      id: "mismatch",
      artifactPath: files.artifactPath,
      graphSummary: graphSummaryFor(artifact),
      sourceRoot: files.sourceRoot,
      source: { kind: "github", owner: "acme", repo: "service" },
      syntheticExecutionTrust: {
        mode: "sandboxed-pr",
        provenance: { repository: "acme/service", headSha: "c".repeat(40) },
      },
    })).toThrow(/trust is invalid/);
  });

  it("treats a descriptor from a noncurrent format as a cache miss", () => {
    createSnapshotFiles("stale", artifactFor("stale"));
    writeRawDescriptor("stale-format", {
      formatVersion: 2,
      id: "stale-format",
      publishedAt: "2026-07-14T10:00:00.000Z",
      graphSummary: SUMMARY,
      artifact: { path: "generations/stale/artifact.json", vcsBranch: null },
      source: { rootPath: "generations/stale/repo", subdir: "", metadata: { kind: "other" } },
    });

    const store = new InspectionSnapshotStore({ cacheRoot });
    expect(store.resolveDescriptor("stale-format")).toBeNull();
    expect(store.resolveArtifact("stale-format")).toBeNull();
    expect(store.cacheStats().artifactEntries).toBe(0);
  });
});

function createSnapshotFiles(name: string, artifact: GraphArtifact | null): { artifactPath: string; sourceRoot: string } {
  const generation = join(cacheRoot, "generations", name);
  const sourceRoot = join(generation, "repo");
  const artifactPath = join(generation, "artifact.json");
  mkdirSync(join(sourceRoot, "apps", "api"), { recursive: true });
  writeFileSync(join(sourceRoot, "apps", "api", "index.ts"), `export const name = '${name}';\n`);
  if (artifact) writeFileSync(artifactPath, `${JSON.stringify(artifact)}\n`, "utf8");
  else writeFileSync(artifactPath, "null\n", "utf8");
  return { artifactPath, sourceRoot };
}

function artifactFor(name: string, padding = 0): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-14T00:00:00.000Z",
    generator: { name: "meridian", version: "test" },
    target: { name, root: ".", language: "typescript" },
    nodes: [],
    edges: [],
    ...(padding > 0 ? { extensions: { padding: "x".repeat(padding) } } : {}),
  };
}

function writeRawDescriptor(id: string, value: unknown): void {
  const directory = join(cacheRoot, "inspection-snapshots", id.slice(0, 2).padEnd(2, "_"), id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "descriptor.json"), `${JSON.stringify(value)}\n`, "utf8");
  expect(readFileSync(join(directory, "descriptor.json"), "utf8")).toContain(id);
}
