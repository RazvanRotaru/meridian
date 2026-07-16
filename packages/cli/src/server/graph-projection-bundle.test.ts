import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import {
  canonicalizeGraphProjectionRequest,
  canonicalizeGraphSymbolSearchRequest,
  GraphProjectionBundle,
  GraphProjectionRequestError,
  GraphSymbolSearchRequestError,
  readGraphProjectionManifest,
  writeGraphProjectionBundle,
} from "./graph-projection-bundle";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GraphProjectionBundle", () => {
  it("keeps the complete graph on disk and returns only the disclosed current view", () => {
    const { bundle, root } = createBundle();
    const result = bundle.query({ view: "modules", depth: 1 });

    expect(result.artifact.nodes.map((node) => node.id)).toEqual(["root", "file-a", "file-b"]);
    expect(result.artifact.nodes.some((node) => node.summary?.includes("WHOLE_GRAPH_SENTINEL"))).toBe(false);
    expect(result.childCounts).toMatchObject({ root: 2, "file-a": 1, "file-b": 2 });
    expect(result.completeness.complete).toBe(true);
    expect(readGraphProjectionManifest(root)?.graphSummary.nodeCount).toBe(7);
    expect(readGraphProjectionManifest(root)).toMatchObject({
      formatVersion: 3,
      filePathCount: 3,
      symbols: {
        map: { count: 7, scopeCounts: { public: 7, all: 7, private: 0 } },
        logic: { count: 5, scopeCounts: { public: 5, all: 5, private: 0 } },
      },
    });
  });

  it("searches compact mode-sorted symbol pages with exact palette scope semantics", async () => {
    const input = artifact();
    input.nodes.push({
      id: "private-method",
      kind: "method",
      qualifiedName: "Example.__private",
      displayName: "__private",
      parentId: "file-a",
      location: { file: "src/a.ts", startLine: 9 },
    });
    input.extensions = {
      ...input.extensions,
      logicFlow: {
        ...(input.extensions?.logicFlow as object),
        "private-method": [{ kind: "exit", label: "exit" }],
      },
    };
    const { bundle, root } = createBundle(input);

    await expect(bundle.search({ version: 1, query: "", mode: "logic", scope: "public" })).resolves.toMatchObject({
      version: 1,
      contentId: expect.stringMatching(/^[0-9a-f]{64}$/),
      mode: "logic",
      scope: "public",
      scopeCounts: { public: 5, all: 6, private: 1 },
      results: [
        { id: "method-a", stepCount: 1 },
        { id: "method-b", stepCount: 0 },
      ],
    });
    await expect(bundle.search({ version: 1, query: "  EXAMPLE.__PR  ", mode: "logic", scope: "all" }))
      .resolves.toMatchObject({
        scopeCounts: { public: 5, all: 6, private: 1 },
        results: [{ id: "private-method", displayName: "__private", isPrivateMethod: true, stepCount: 0 }],
      });
    await expect(bundle.search({ version: 1, query: "private", mode: "map", scope: "public" }))
      .resolves.toMatchObject({ results: [] });
    await expect(bundle.search({ version: 1, query: "private", mode: "map", scope: "private" }))
      .resolves.toMatchObject({
        scopeCounts: { public: 7, all: 8, private: 1 },
        results: [{ id: "private-method" }],
      });

    expect(readFileSync(join(root, "symbols-map.ndjson"), "utf8")).not.toContain("WHOLE_GRAPH_SENTINEL");
  });

  it("caps symbol search at 40 rows and participates in the reader's bounded page cache", async () => {
    const input = artifact();
    for (let index = 0; index < 600; index += 1) {
      input.nodes.push({
        id: `search-${index}`,
        kind: "function",
        qualifiedName: `Search.symbol${String(index).padStart(3, "0")}`,
        displayName: `symbol${String(index).padStart(3, "0")}`,
        parentId: "file-a",
        location: { file: "src/a.ts", startLine: 10 + index },
      });
    }
    const { root } = createBundle(input);
    const bundle = new GraphProjectionBundle(root, { maxCacheBytes: 32_000, maxCacheEntries: 1 });

    const result = await bundle.search({ version: 1, query: "symbol", mode: "map", scope: "all" });

    expect(result.results).toHaveLength(40);
    expect(result.results[0]?.displayName).toBe("symbol000");
    expect(bundle.cacheStats().entries).toBeLessThanOrEqual(1);
    expect(bundle.cacheStats().bytes).toBeLessThanOrEqual(32_000);
  });

  it("strictly validates the versioned symbol search envelope before reading catalog pages", () => {
    expect(() => canonicalizeGraphSymbolSearchRequest({
      version: 1,
      query: "method",
      mode: "map",
      scope: "public",
      legacyGraph: true,
    } as never)).toThrow(GraphSymbolSearchRequestError);
    expect(() => canonicalizeGraphSymbolSearchRequest({
      version: 0,
      query: "method",
      mode: "map",
      scope: "public",
    } as never)).toThrow(/version must be 1/);
    expect(() => canonicalizeGraphSymbolSearchRequest({
      version: 1,
      query: "x".repeat(257),
      mode: "logic",
      scope: "all",
    })).toThrow(/256 bytes/);
  });

  it("hydrates an expanded branch while retaining ancestors and never emits dangling edges", () => {
    const { bundle } = createBundle();
    const result = bundle.query({
      view: "modules",
      focusIds: ["file-a"],
      expandedIds: ["file-a", "unit-a"],
      depth: 1,
    });
    const ids = new Set(result.artifact.nodes.map((node) => node.id));

    expect(ids).toEqual(new Set(["root", "file-a", "unit-a", "method-a"]));
    expect(result.artifact.edges.map((edge) => edge.id)).toEqual(["contains-call"]);
    expect(result.artifact.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(result.artifact.nodes.find((node) => node.id === "method-a")?.parentId).toBe("unit-a");
  });

  it("includes relationship neighbours for service-like views without loading unrelated branches", () => {
    const { bundle } = createBundle();
    const result = bundle.query({ view: "call", focusIds: ["method-a"], depth: 0, radius: 1 });
    const ids = new Set(result.artifact.nodes.map((node) => node.id));

    expect(ids.has("method-b")).toBe(true);
    expect(ids.has("huge-hidden")).toBe(false);
    expect(result.artifact.edges.map((edge) => edge.id)).toContain("cross-call");
  });

  it("loads only the focused logic flow and its target nodes", () => {
    const { bundle } = createBundle();
    const result = bundle.query({ view: "logic", focusIds: ["method-a"], depth: 0 });
    const flows = result.artifact.extensions?.logicFlow as Record<string, unknown>;

    expect(Object.keys(flows)).toEqual(["method-a"]);
    expect(result.artifact.nodes.map((node) => node.id)).toContain("method-b");
  });

  it("hydrates a deleted base-only file through the disk path index without changed tags", () => {
    const base = artifact();
    base.extensions = { entryModules: ["file-a"] };
    const { bundle } = createBundle(base);
    const result = bundle.query({ view: "review", filePaths: ["src/a.ts"], depth: 0 });

    expect(result.artifact.nodes.map((node) => node.id)).toEqual(["root", "file-a", "unit-a", "method-a"]);
    expect(result.artifact.nodes.some((node) => node.location.file === "src/b.ts")).toBe(false);
    expect(result.artifact.extensions?.entryModules).toEqual(["file-a"]);
    expect(result.completeness.complete).toBe(true);
  });

  it("returns change metadata only for relevant current paths", () => {
    const { bundle } = createBundle();
    const result = bundle.query({ view: "review", filePaths: ["src/a.ts"], depth: 0 });
    const changed = result.artifact.extensions?.changedSince as Record<string, unknown>;

    expect(changed).toMatchObject({
      baseRef: "origin/main",
      files: { "src/a.ts": [{ start: 1, end: 2 }] },
      stats: { "src/a.ts": { added: 2, deleted: 1 } },
      kinds: { "src/a.ts": [{ start: 1, end: 2, kind: "modified" }] },
      manifest: [{ path: "src/a.ts", status: "modified" }],
    });
    expect(Object.keys(changed.files as object)).toEqual(["src/a.ts"]);
    expect(Object.keys(changed.stats as object)).toEqual(["src/a.ts"]);
    expect(Object.keys(changed.kinds as object)).toEqual(["src/a.ts"]);
    expect(Object.keys(changed.diffLines as object)).toEqual(["src/a.ts"]);
    expect(JSON.stringify(changed)).not.toContain("src/b.ts");
  });

  it("never persists or transports arbitrary artifact extensions", () => {
    const { bundle, root } = createBundle();
    const result = bundle.query({ view: "review", filePaths: ["src/a.ts"], depth: 0 });

    expect(readAllFiles(root)).not.toContain("UNRELATED_EXTENSION_SENTINEL");
    expect(JSON.stringify(result)).not.toContain("UNRELATED_EXTENSION_SENTINEL");
    expect(Object.keys(result.artifact.extensions ?? {}).sort()).toEqual(["changedSince", "entryModules"]);
  });

  it("rejects malformed known change data instead of publishing a partial projection", () => {
    const malformed: unknown[] = [
      { files: { "src/a.ts": [{ start: 1, end: 2 }, { start: "bad", end: 3 }] } },
      { stats: { "src/a.ts": { added: 1, deleted: "bad" } } },
      { kinds: { "src/a.ts": [{ start: 1, end: 2, kind: "modified" }, { start: 3, end: 3, kind: "bad" }] } },
      {
        diffLines: {
          "src/a.ts": [
            { kind: "added", oldLine: null, newLine: 1, beforeNewLine: 1, text: "valid" },
            { kind: "added", oldLine: 1, newLine: 2, beforeNewLine: 2, text: "invalid" },
          ],
        },
      },
      { manifest: [{ path: "src/a.ts", status: "copied" }] },
      { files: { "../outside.ts": [{ start: 1, end: 1 }] } },
    ];

    for (const changedSince of malformed) {
      const input = artifact();
      input.extensions = { ...input.extensions, changedSince: changedSince as never };
      const root = temporaryRoot();
      expect(() => writeGraphProjectionBundle(root, input)).toThrow(/extensions\.changedSince/);
    }
  });

  it("includes telemetry in immutable bundle identity", () => {
    const first = artifact();
    first.telemetry = {
      joinKey: "node.id",
      requiredRuntimeAttributes: ["service.name"],
      serviceDefaulting: "forbidden",
      semconvVersion: "1.0",
    };
    const second = structuredClone(first);
    second.telemetry = { ...first.telemetry, semconvVersion: "2.0" };

    const firstManifest = writeGraphProjectionBundle(temporaryRoot(), first);
    const secondManifest = writeGraphProjectionBundle(temporaryRoot(), second);
    expect(firstManifest.contentId).not.toBe(secondManifest.contentId);
  });

  it("canonicalizes unordered navigation state into one stable projection id", () => {
    const { bundle } = createBundle();
    const first = bundle.query({ view: "modules", focusIds: ["file-b", "file-a", "file-a"], expandedIds: ["file-b", "file-a"] });
    const second = bundle.query({ view: "modules", focusIds: ["file-a", "file-b"], expandedIds: ["file-a", "file-b"] });

    expect(first.request).toEqual(second.request);
    expect(first.projectionId).toBe(second.projectionId);
    expect(first.projectionId).toBe(createHash("sha256")
      .update(`projection-v3\0${bundle.manifest.contentId}\0${JSON.stringify(first.request)}`)
      .digest("hex"));

    const reviewFirst = bundle.query({ view: "review", filePaths: ["src/b.ts", "src/a.ts", "src/a.ts"] });
    const reviewSecond = bundle.query({ view: "review", filePaths: ["src/a.ts", "src/b.ts"] });
    expect(reviewFirst.request.filePaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(reviewFirst.projectionId).toBe(reviewSecond.projectionId);
  });

  it("rejects the incompatible v2 bundle manifest without a compatibility reader", () => {
    const { root } = createBundle();
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.formatVersion = 2;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(readGraphProjectionManifest(root)).toBeNull();
    expect(() => new GraphProjectionBundle(root)).toThrow(/manifest is unavailable or invalid/);
  });

  it("reports truncation explicitly and retains a structurally closed subset", () => {
    const { bundle } = createBundle();
    const result = bundle.query({ view: "modules", depth: 4, maxNodes: 3 });
    const ids = new Set(result.artifact.nodes.map((node) => node.id));

    expect(result.completeness.complete).toBe(false);
    expect(result.completeness.reasons).toContain("node-limit");
    expect(result.completeness.omittedNodes).toBeGreaterThan(0);
    expect(result.artifact.nodes.every((node) => node.parentId == null || ids.has(node.parentId))).toBe(true);
    expect(result.artifact.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
  });

  it("keeps the complete serialized response inside the requested byte limit", () => {
    const input = artifact();
    const hidden = input.nodes.find((node) => node.id === "huge-hidden");
    if (hidden) hidden.summary = `RESPONSE_LIMIT_SENTINEL:${"x".repeat(128_000)}`;
    const { bundle } = createBundle(input);
    const result = bundle.query({ view: "modules", depth: 4, maxResponseBytes: 64 * 1024 });

    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64 * 1024);
    expect(result.completeness).toMatchObject({ complete: false, reasons: expect.arrayContaining(["byte-limit"]) });
    expect(JSON.stringify(result)).not.toContain("RESPONSE_LIMIT_SENTINEL");
  });

  it("bounds parsed shard pages with a byte-and-entry LRU", () => {
    const { root } = createBundle();
    const bundle = new GraphProjectionBundle(root, { maxCacheBytes: 4_000, maxCacheEntries: 2 });

    bundle.query({ view: "modules", focusIds: ["file-a"], depth: 1 });
    bundle.query({ view: "modules", focusIds: ["file-b"], depth: 1 });

    expect(bundle.cacheStats().entries).toBeLessThanOrEqual(2);
    expect(bundle.cacheStats().bytes).toBeLessThanOrEqual(4_000);
    expect(bundle.cacheStats().evictions + bundle.cacheStats().oversizeSkips).toBeGreaterThan(0);
    bundle.clearMemoryCache();
    expect(bundle.cacheStats()).toMatchObject({ bytes: 0, entries: 0 });
  });

  it("rejects oversized or malformed view requests before touching bundle data", () => {
    expect(() => canonicalizeGraphProjectionRequest({
      view: "modules",
      expandedIds: Array.from({ length: 513 }, (_, index) => `node-${index}`),
    })).toThrow(GraphProjectionRequestError);
    expect(() => canonicalizeGraphProjectionRequest({ view: "modules", depth: 99 })).toThrow(/depth/);
    expect(() => canonicalizeGraphProjectionRequest({ view: "review", filePaths: ["../src/a.ts"] })).toThrow(/canonical/);
    expect(() => canonicalizeGraphProjectionRequest({ view: "modules", filePaths: ["src/a.ts"] })).toThrow(/review/);
    expect(() => canonicalizeGraphProjectionRequest({
      view: "review",
      filePaths: Array.from({ length: 513 }, (_, index) => `src/${index}.ts`),
    })).toThrow(GraphProjectionRequestError);
    expect(() => canonicalizeGraphProjectionRequest({
      view: "modules",
      unexpected: true,
    } as never)).toThrow(/unknown graph projection request field/);
  });
});

function createBundle(input: GraphArtifact = artifact()): { bundle: GraphProjectionBundle; root: string } {
  const root = temporaryRoot();
  writeGraphProjectionBundle(root, input);
  return { root, bundle: new GraphProjectionBundle(root) };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-projections-"));
  roots.push(root);
  return root;
}

function artifact(): GraphArtifact {
  const node = (
    id: string,
    parentId: string | null,
    file: string,
    summary?: string,
  ): GraphArtifact["nodes"][number] => ({
    id,
    kind: id === "root" ? "package" : id.startsWith("file") ? "module" : id.startsWith("unit") ? "class" : "method",
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file, startLine: 1 },
    ...(summary ? { summary } : {}),
  });
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-14T00:00:00.000Z",
    generator: { name: "test", version: "1.0.0" },
    target: { name: "projection-test", root: ".", language: "typescript" },
    nodes: [
      node("root", null, "src"),
      node("file-a", "root", "src/a.ts"),
      node("unit-a", "file-a", "src/a.ts"),
      node("method-a", "unit-a", "src/a.ts"),
      node("file-b", "root", "src/b.ts"),
      node("method-b", "file-b", "src/b.ts"),
      node("huge-hidden", "file-b", "src/b.ts", `WHOLE_GRAPH_SENTINEL:${"x".repeat(32_000)}`),
    ],
    edges: [
      { id: "contains-call", source: "unit-a", target: "method-a", kind: "owns" },
      { id: "cross-call", source: "method-a", target: "method-b", kind: "calls" },
      { id: "hidden-call", source: "method-b", target: "huge-hidden", kind: "calls" },
    ],
    extensions: {
      entryModules: ["file-a"],
      logicFlow: {
        "method-a": [{ kind: "call", label: "method-b", target: "method-b", resolution: "resolved" }],
        "method-b": [],
      },
      changedSince: {
        baseRef: "origin/main",
        files: {
          "src/a.ts": [{ start: 1, end: 2 }],
          "src/b.ts": [{ start: 1, end: 1 }],
        },
        stats: {
          "src/a.ts": { added: 2, deleted: 1 },
          "src/b.ts": { added: 0, deleted: 1 },
        },
        kinds: {
          "src/a.ts": [{ start: 1, end: 2, kind: "modified" }],
          "src/b.ts": [{ start: 1, end: 1, kind: "deleted" }],
        },
        diffLines: {
          "src/a.ts": [{ kind: "added", oldLine: null, newLine: 1, beforeNewLine: 1, text: "added" }],
          "src/b.ts": [{ kind: "deleted", oldLine: 1, newLine: null, beforeNewLine: 1, text: "removed" }],
        },
        manifest: [
          { path: "src/a.ts", status: "modified" },
          { path: "src/b.ts", status: "deleted" },
        ],
      },
      unrelatedExtension: { marker: "UNRELATED_EXTENSION_SENTINEL" },
    },
  } as GraphArtifact;
}

function readAllFiles(root: string): string {
  let result = "";
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) result += readAllFiles(path);
    else result += readFileSync(path, "utf8");
  }
  return result;
}
