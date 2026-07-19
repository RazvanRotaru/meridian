import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareCanonicalPrPreparePaths,
  graphProjectionIdentityPreimage,
  type ChangedFileManifestEntry,
  type GraphArtifact,
} from "@meridian/core";
import {
  BoundedGraphProjectionPageCache,
  canonicalizeGraphProjectionRequest,
  canonicalizeGraphSymbolSearchRequest,
  defaultGraphProjectionRequest,
  GraphProjectionBundle,
  GraphProjectionRequestError,
  GraphSymbolSearchRequestError,
  readGraphProjectionManifest,
  writeGraphProjectionBundle,
  type GraphProjectionPageCache,
  type GraphProjectionRequest,
} from "./graph-projection-bundle";
import {
  readReviewComparisonContext,
  reviewFileCursor,
  writeReviewComparisonContext,
  type ReviewComparisonSide,
} from "./review-comparison-context";

const roots: string[] = [];

function projectionRequest(
  overrides: Partial<GraphProjectionRequest> = {},
): GraphProjectionRequest {
  return { ...defaultGraphProjectionRequest(), ...overrides };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GraphProjectionBundle", () => {
  it("keeps the complete graph on disk and returns only the disclosed current view", async () => {
    const { bundle, root } = createBundle();
    const result = await bundle.query(projectionRequest({ view: "modules", depth: 1 }));

    expect(result.artifact.nodes.map((node) => node.id)).toEqual(["root", "file-a", "file-b"]);
    expect(result.artifact.nodes.some((node) => node.summary?.includes("WHOLE_GRAPH_SENTINEL"))).toBe(false);
    expect("childCounts" in result).toBe(false);
    expect(result).toMatchObject({
      version: 9,
      contentId: bundle.manifest.contentId,
      hierarchy: {
        moduleOverviewRootIds: ["root"],
        nodes: {
          root: { isTest: false, childKindCounts: { module: 2 }, descendantSourceFileCount: 2, ownedSourceFileCount: 2 },
          "file-a": { isTest: false, childKindCounts: { class: 1 }, descendantSourceFileCount: 0, ownedSourceFileCount: 0 },
          "file-b": { isTest: false, childKindCounts: { method: 2 }, descendantSourceFileCount: 0, ownedSourceFileCount: 0 },
        },
      },
    });
    expect(result.completeness.complete).toBe(true);
    expect(readGraphProjectionManifest(root)?.graphSummary.nodeCount).toBe(7);
    expect(readGraphProjectionManifest(root)).toMatchObject({
      formatVersion: 9,
      repositorySummary: { overviewPackageCount: 1, sourceFileCount: 2, testSourceFileCount: 0 },
      filePathCount: 3,
      symbols: {
        map: { count: 7, scopeCounts: { public: 7, all: 7, private: 0 } },
        logic: { count: 5, scopeCounts: { public: 5, all: 5, private: 0 } },
      },
    });
  });

  it("uses bounded canonical module-overview roots as seeds, including nested npm packages", async () => {
    const input = artifact();
    input.nodes = [
      fixtureNode("workspace", "package", null, "workspace"),
      fixtureNode("workspace/packages", "package", "workspace", "workspace/packages"),
      { ...fixtureNode("workspace/packages/a", "package", "workspace/packages", "workspace/packages/a"), tags: ["npm-package"] },
      fixtureNode("workspace/packages/a/src", "package", "workspace/packages/a", "workspace/packages/a/src"),
      fixtureNode("workspace/packages/a/src/a.ts", "module", "workspace/packages/a/src", "workspace/packages/a/src/a.ts"),
      { ...fixtureNode("workspace/packages/a/nested", "package", "workspace/packages/a", "workspace/packages/a/nested"), tags: ["npm-package"] },
      fixtureNode("workspace/packages/a/nested/n.ts", "module", "workspace/packages/a/nested", "workspace/packages/a/nested/n.ts"),
      { ...fixtureNode("workspace/packages/b", "package", "workspace/packages", "workspace/packages/b"), tags: ["npm-package"] },
      fixtureNode("workspace/packages/b/b.ts", "module", "workspace/packages/b", "workspace/packages/b/b.ts"),
    ];
    input.edges = [];
    input.extensions = {};
    const { bundle } = createBundle(input);

    const result = await bundle.query(projectionRequest({ view: "modules", depth: 0 }));

    expect(result.hierarchy.moduleOverviewRootIds).toEqual([
      "workspace/packages/a",
      "workspace/packages/a/nested",
      "workspace/packages/b",
    ]);
    expect(result.artifact.nodes.map((entry) => entry.id)).toEqual([
      "workspace",
      "workspace/packages",
      "workspace/packages/a",
      "workspace/packages/a/nested",
      "workspace/packages/b",
    ]);
    expect(result.artifact.nodes.some((entry) => entry.kind === "module")).toBe(false);
    expect(result.hierarchy.nodes["workspace/packages/a"]).toEqual({
      isTest: false,
      childKindCounts: { package: 2 },
      descendantSourceFileCount: 2,
      ownedSourceFileCount: 1,
    });
    expect(result.hierarchy.nodes["workspace/packages/a/nested"]?.ownedSourceFileCount).toBe(1);
    expect(bundle.manifest.repositorySummary).toEqual({
      overviewPackageCount: 3,
      sourceFileCount: 3,
      testSourceFileCount: 0,
    });
  });

  it("publishes test-filtered structural facts without retaining test nodes", async () => {
    const input = artifact();
    input.nodes.push({
      ...fixtureNode("file-test", "module", "root", "src/a.test.ts"),
      tags: ["test"],
    });
    const { bundle } = createBundle(input);

    const hidden = await bundle.query(projectionRequest({ view: "modules", depth: 1, includeTests: false }));
    const shown = await bundle.query(projectionRequest({ view: "modules", depth: 1, includeTests: true }));

    expect(hidden.artifact.nodes.map((entry) => entry.id)).not.toContain("file-test");
    expect(hidden.hierarchy.nodes.root).toEqual({
      isTest: false,
      childKindCounts: { module: 2 },
      descendantSourceFileCount: 2,
      ownedSourceFileCount: 2,
    });
    expect(shown.artifact.nodes.map((entry) => entry.id)).toContain("file-test");
    expect(shown.hierarchy.nodes.root).toEqual({
      isTest: false,
      childKindCounts: { module: 3 },
      descendantSourceFileCount: 3,
      ownedSourceFileCount: 3,
    });
    expect(bundle.manifest.repositorySummary.sourceFileCount).toBe(3);
  });

  it("fails closed for a stale explicit node selector without misclassifying a filtered test node", async () => {
    const input = artifact();
    input.nodes.push({
      ...fixtureNode("file-test", "module", "root", "src/a.test.ts"),
      tags: ["test"],
    });
    const { bundle } = createBundle(input);

    const stale = await bundle.query(projectionRequest({ view: "modules", focusIds: ["missing-node"], depth: 0 }));
    expect(stale.artifact.nodes).toEqual([]);
    expect(stale.completeness).toMatchObject({
      complete: false,
      reasons: ["projection-data-unavailable"],
      omittedNodes: 1,
    });

    const filtered = await bundle.query(projectionRequest({
      view: "modules",
      focusIds: ["file-test"],
      depth: 0,
      includeTests: false,
    }));
    expect(filtered.artifact.nodes).toEqual([]);
    expect(filtered.completeness).toMatchObject({ complete: true, reasons: [], omittedNodes: 0 });
  });

  it("fails closed when a referenced overview page is truncated after publication", async () => {
    const { bundle, root } = createBundle();
    writeFileSync(join(root, "module-overview-roots-without-tests.ndjson"), "");

    await expect(bundle.query(projectionRequest({ view: "modules", depth: 0, includeTests: false })))
      .rejects.toThrow(/graph projection bundle data is unavailable/);
  });

  it("fails closed when co-paged reachability paint is semantically corrupted", async () => {
    const { bundle, root } = createBundle();
    const shard = projectionShard("method-a").toString(16).padStart(2, "0");
    const path = join(root, "hierarchy", `${shard}.ndjson`);
    const lines = readFileSync(path, "utf8").split("\n");
    let corrupted = false;
    for (let line = 0; line < lines.length && !corrupted; line += 1) {
      if (lines[line] === "") continue;
      const page = JSON.parse(lines[line]!) as Array<[string, {
        reachability: { leaf: { status: string } | null };
      }]>;
      const entry = page.find(([id]) => id === "method-a");
      const status = entry?.[1].reachability.leaf?.status;
      if (status === undefined) continue;
      entry![1].reachability.leaf!.status = "x".repeat(status.length);
      const encoded = JSON.stringify(page);
      expect(Buffer.byteLength(encoded)).toBe(Buffer.byteLength(lines[line]!));
      lines[line] = encoded;
      corrupted = true;
    }
    expect(corrupted).toBe(true);
    writeFileSync(path, lines.join("\n"));

    await expect(bundle.query(projectionRequest({
      view: "modules",
      focusIds: ["method-a"],
      depth: 0,
      includeReachability: true,
    }))).rejects.toThrow(/hierarchy fact for method-a is malformed/);
  });

  it("keeps node and hierarchy pages aligned beyond 192 entries in one shard", async () => {
    const ids = sameProjectionShardIds(193);
    const input = artifact();
    input.nodes = ids.map((id, index) => fixtureNode(id, "module", null, `src/generated-${index}.ts`));
    input.edges = [];
    input.extensions = {};
    const { bundle } = createBundle(input);
    const target = ids.at(-1)!;

    const result = await bundle.query(projectionRequest({
      view: "modules",
      focusIds: [target],
      depth: 0,
      includeReachability: true,
    }));

    expect(result.artifact.nodes.map((node) => node.id)).toEqual([target]);
    expect(result.hierarchy.nodes[target]).toEqual({
      isTest: false,
      childKindCounts: {},
      descendantSourceFileCount: 0,
      ownedSourceFileCount: 1,
    });
    expect(result.analysis.reachability).not.toBeNull();
  });

  it("cooperatively stops a projection query after its client cancels", async () => {
    const ids = sameProjectionShardIds(193);
    const input = artifact();
    input.nodes = ids.map((id, index) => fixtureNode(id, "module", null, `src/generated-${index}.ts`));
    input.edges = [];
    input.extensions = {};
    const { bundle } = createBundle(input);
    const controller = new AbortController();
    const reason = new Error("projection client disconnected");
    reason.name = "AbortError";

    const pending = bundle.query(projectionRequest({ view: "logic", depth: 0 }), controller.signal);
    setImmediate(() => setImmediate(() => controller.abort(reason)));

    await expect(pending).rejects.toBe(reason);
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
    expect(bundle.cacheStats().residentBytes).toBeLessThanOrEqual(32_000);
  });

  it("strictly validates the versioned symbol search envelope before reading catalog pages", async () => {
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

  it("hydrates an expanded branch while retaining ancestors and never emits dangling edges", async () => {
    const { bundle } = createBundle();
    const result = await bundle.query(projectionRequest({
      view: "modules",
      focusIds: ["file-a"],
      expandedIds: ["file-a", "unit-a"],
      depth: 1,
    }));
    const ids = new Set(result.artifact.nodes.map((node) => node.id));

    expect(ids).toEqual(new Set(["root", "file-a", "file-b", "unit-a", "method-a", "method-b"]));
    expect(result.artifact.edges.map((edge) => edge.id)).toEqual(["contains-call", "cross-call"]);
    expect(result.artifact.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(result.artifact.nodes.find((node) => node.id === "method-a")?.parentId).toBe("unit-a");
    expect(result.hierarchy.nodes["file-a"]).toEqual({
      isTest: false,
      childKindCounts: { class: 1 },
      descendantSourceFileCount: 0,
      ownedSourceFileCount: 0,
    });
    expect(result.hierarchy.nodes["unit-a"]).toEqual({
      isTest: false,
      childKindCounts: { method: 1 },
      descendantSourceFileCount: 0,
      ownedSourceFileCount: 0,
    });
  });

  it("takes one typed boundary hop from an explicit Service anchor without recursing", async () => {
    const { bundle } = createBundle();
    const result = await bundle.query(projectionRequest({
      view: "service",
      focusIds: ["method-a"],
      depth: 0,
    }));
    const ids = new Set(result.artifact.nodes.map((node) => node.id));

    expect(ids.has("method-b")).toBe(true);
    expect(ids.has("huge-hidden")).toBe(false);
    expect(result.artifact.edges.map((edge) => edge.id)).toContain("cross-call");
    expect(result.viewFacts.service).not.toBeNull();
  });

  it("seeds the Service overview from topology leads and expands only named lead memberships", async () => {
    const input = artifact();
    input.nodes = [
      fixtureNode("orders.ts", "module", null, "src/orders.ts"),
      fixtureNode("OrderRepository", "class", "orders.ts", "src/orders.ts"),
      fixtureNode("OrderRepository.save", "method", "OrderRepository", "src/orders.ts"),
      fixtureNode("OrderService", "class", "orders.ts", "src/orders.ts"),
      fixtureNode("OrderService.submit", "method", "OrderService", "src/orders.ts"),
    ];
    input.edges = [{
      id: "injects-repository",
      source: "OrderService",
      target: "OrderRepository",
      kind: "injects",
    }];
    input.extensions = {};
    const { bundle } = createBundle(input);
    const collapsed = await bundle.query(projectionRequest({ view: "service", depth: 0 }));
    const topology = collapsed.viewFacts.service!;
    const expandable = topology.clusters.find((cluster) => cluster.memberIds.length > 1);

    expect(topology.clusters.length).toBeGreaterThan(0);
    expect(topology.clusters.every((cluster) => collapsed.artifact.nodes.some(
      (node) => node.id === cluster.leadId,
    ))).toBe(true);
    expect(expandable).toBeDefined();

    const expanded = await bundle.query(projectionRequest({
      view: "service",
      depth: 0,
      serviceExpandedLeadIds: [expandable!.leadId],
    }));
    const expandedIds = new Set(expanded.artifact.nodes.map((node) => node.id));
    expect(expandable!.memberIds.every((id) => expandedIds.has(id))).toBe(true);
  });

  it("seeds UI roots from renders endpoints and falls back explicitly to module overview", async () => {
    const uiArtifact = artifact();
    uiArtifact.edges.push({
      id: "renders-peer",
      source: "method-a",
      target: "method-b",
      kind: "renders",
    });
    const { bundle: uiBundle } = createBundle(uiArtifact);
    const ui = await uiBundle.query(projectionRequest({ view: "ui", depth: 0 }));
    const uiIds = new Set(ui.artifact.nodes.map((node) => node.id));

    expect(uiBundle.manifest.uiEntryIds.withoutTests.count).toBe(2);
    expect(uiIds.has("method-a")).toBe(true);
    expect(uiIds.has("method-b")).toBe(true);
    expect(uiIds.has("huge-hidden")).toBe(false);
    expect(ui.hierarchy.moduleOverviewRootIds).toEqual([]);
    expect(ui.viewFacts.moduleOverview).not.toBeNull();

    const { bundle: nonUiBundle } = createBundle();
    const fallback = await nonUiBundle.query(projectionRequest({ view: "ui", depth: 0 }));
    expect(fallback.artifact.nodes.map((node) => node.id)).toEqual(["root"]);
    expect(fallback.hierarchy.moduleOverviewRootIds).toEqual(["root"]);
    expect(fallback.viewFacts.moduleOverview?.roots.map((root) => root.id)).toEqual(["root"]);
  });

  it("emits logic flows for expanded callables in every lens", async () => {
    const { bundle } = createBundle();
    const result = await bundle.query(projectionRequest({
      view: "modules",
      focusIds: ["file-a"],
      expandedIds: ["method-a"],
      depth: 0,
    }));

    expect(result.artifact.extensions?.logicFlow).toMatchObject({
      "method-a": [{ kind: "call", target: "method-b" }],
    });
    expect(result.artifact.nodes.map((node) => node.id)).toContain("method-b");
  });

  it("preserves an external typed boundary edge without traversing from partners or ancestors", async () => {
    const input = artifact();
    input.edges.push(
      {
        id: "external-reference",
        source: "method-a",
        target: "ext:library",
        kind: "references",
        resolution: "external",
      },
      {
        id: "ancestor-import",
        source: "file-a",
        target: "huge-hidden",
        kind: "imports",
      },
    );
    const { bundle } = createBundle(input);
    const result = await bundle.query(projectionRequest({
      view: "modules",
      focusIds: ["method-a"],
      depth: 0,
    }));

    expect(result.artifact.nodes.map((node) => node.id)).not.toContain("huge-hidden");
    expect(result.artifact.edges).toContainEqual(expect.objectContaining({
      id: "external-reference",
      target: "ext:library",
      resolution: "external",
    }));
    expect(result.artifact.edges.map((edge) => edge.id)).not.toContain("ancestor-import");
    expect(result.completeness.complete).toBe(true);
  });

  it("returns full reachability summaries with paint facts only for represented nodes", async () => {
    const { bundle } = createBundle();
    const result = await bundle.query(projectionRequest({
      view: "modules",
      focusIds: ["method-a"],
      depth: 0,
      includeReachability: true,
    }));
    const reachability = result.analysis.reachability!;
    const nodeIds = new Set(result.artifact.nodes.map((node) => node.id));

    expect(reachability.summary.callables).toBeGreaterThan(0);
    expect([...Object.keys(reachability.leaves), ...Object.keys(reachability.containers)]
      .every((id) => nodeIds.has(id))).toBe(true);
    expect(reachability.leaves).not.toHaveProperty("huge-hidden");
  });

  it("loads only the focused logic flow and its target nodes", async () => {
    const { bundle } = createBundle();
    const result = await bundle.query(projectionRequest({ view: "logic", focusIds: ["method-a"], depth: 0 }));
    const flows = result.artifact.extensions?.logicFlow as Record<string, unknown>;

    expect(Object.keys(flows)).toEqual(["method-a"]);
    expect(result.artifact.nodes.map((node) => node.id)).toContain("method-b");
  });

  it("hydrates a deleted base-only file through the disk path index without changed tags", async () => {
    const base = artifact();
    base.extensions = { entryModules: ["file-a"] };
    const { bundle } = createBundle(base);
    const result = await bundle.query(projectionRequest({ view: "review", filePaths: ["src/a.ts"], depth: 0 }));

    expect(result.artifact.nodes.map((node) => node.id)).toEqual([
      "root",
      "file-a",
      "unit-a",
      "method-a",
      "file-b",
      "method-b",
    ]);
    expect(result.artifact.nodes.some((node) => node.id === "huge-hidden")).toBe(false);
    expect(result.artifact.extensions?.entryModules).toEqual(["file-a"]);
    expect(result.completeness.complete).toBe(true);
  });

  it("returns change metadata only for relevant current paths", async () => {
    const { bundle } = createBundle();
    const result = await bundle.query(projectionRequest({ view: "review", filePaths: ["src/a.ts"], depth: 0 }));
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

  it("returns a complete representative overview while disclosing unmapped paths", async () => {
    const { bundle } = createBundle();
    const review = comparisonContext([
      { path: "src/a.ts", status: "modified" },
      { path: "src/unmapped.ts", status: "modified" },
    ], "head");

    const overview = await bundle.query(projectionRequest({
      view: "review",
      reviewCursor: null,
      depth: 4,
    }), undefined, { review });

    expect(overview.artifact.nodes.map((node) => node.id)).toEqual(["root", "file-a"]);
    expect(overview.artifact.edges).toEqual([]);
    expect(overview.artifact.extensions).toBeUndefined();
    expect(overview.completeness).toEqual({
      complete: true,
      reasons: [],
      omittedNodes: 0,
      omittedEdges: 0,
    });
    expect(overview.viewFacts.review).toMatchObject({
      selection: null,
      metadataId: "d".repeat(64),
      overview: {
        entries: [
          { index: 0, state: "included", isTest: false },
          { index: 1, state: "unmapped", isTest: null },
        ],
      },
    });
  });

  it("retains graph-backed test truth when an ordinary-looking file is filtered or deferred", async () => {
    const input = artifact();
    input.nodes.push({
      ...fixtureNode("tagged-test-file", "module", "root", "src/ordinary.ts"),
      tags: ["test"],
    });
    const { bundle } = createBundle(input);
    const review = comparisonContext([{ path: "src/ordinary.ts", status: "modified" }], "head");

    const filtered = await bundle.query(projectionRequest({
      view: "review",
      reviewCursor: null,
      includeTests: false,
    }), undefined, { review });
    expect(filtered.artifact.nodes).toEqual([]);
    expect(filtered.viewFacts.review?.overview?.entries)
      .toEqual([{ index: 0, state: "filtered", isTest: true }]);

    const deferred = await bundle.query(projectionRequest({
      view: "review",
      reviewCursor: null,
      includeTests: true,
      maxNodes: 1,
      maxEdges: 0,
    }), undefined, { review });
    expect(deferred.artifact.nodes).toEqual([]);
    expect(deferred.viewFacts.review?.overview?.entries)
      .toEqual([{ index: 0, state: "deferred", isTest: true }]);
  });

  it("classifies an ordinary-named tagged test beyond page zero for overview and exact hidden-Test coordinates", async () => {
    const input = artifact();
    input.nodes.push({
      ...fixtureNode("late-tagged-test-file", "module", "root", "src/zzz-ordinary.ts"),
      tags: ["test"],
    });
    const { bundle } = createBundle(input);
    const changedFiles = [
      ...Array.from({ length: 64 }, (_value, index) => ({
        path: `src/${String(index).padStart(3, "0")}-unmapped.ts`,
        status: "modified" as const,
      })),
      { path: "src/zzz-ordinary.ts", status: "modified" as const },
    ];
    const review = comparisonContext(changedFiles, "head");
    expect(await bundle.reviewTestClassifications(changedFiles, "head"))
      .toEqual([{ index: 64, isTest: true }]);

    const pageZero = await bundle.query(projectionRequest({
      view: "review",
      reviewCursor: null,
      includeTests: false,
    }), undefined, { review });
    expect(pageZero.viewFacts.review?.page?.index).toBe(0);
    expect(pageZero.viewFacts.review?.overview?.entries)
      .toHaveLength(64);
    expect(pageZero.viewFacts.review?.overview?.entries
      .every((entry) => entry.state === "unmapped" && entry.isTest === null)).toBe(true);

    const pageOne = await bundle.query(projectionRequest({
      view: "review",
      reviewCursor: "page:1",
      includeTests: false,
    }), undefined, { review });
    expect(pageOne.artifact.nodes).toEqual([]);
    expect(pageOne.viewFacts.review?.overview?.entries)
      .toEqual([{ index: 64, state: "filtered", isTest: true }]);

    const exact = await bundle.query(projectionRequest({
      view: "review",
      reviewCursor: "file:64",
      includeTests: false,
    }), undefined, { review });
    expect(exact.artifact.nodes).toEqual([]);
    expect(exact.viewFacts.review?.selection).toMatchObject({
      index: 64,
      graphMatched: false,
      isTest: true,
    });
  });

  it("fails closed when an indexed source path loses its overview representative", async () => {
    const { root } = createBundle();
    const graphPath = "src/a.ts";
    const shard = projectionShard(graphPath).toString(16).padStart(2, "0");
    const indexPath = join(root, "file-overview", `${shard}.index.json`);
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>;
    expect(index[graphPath]).toBeDefined();
    delete index[graphPath];
    writeFileSync(indexPath, JSON.stringify(index));
    const bundle = new GraphProjectionBundle(root);
    const review = comparisonContext([{ path: graphPath, status: "modified" }], "head");

    await expect(bundle.query(projectionRequest({
      view: "review",
      reviewCursor: null,
      depth: 4,
    }), undefined, { review })).rejects.toThrow(
      `file-overview for indexed source path ${graphPath} is unavailable`,
    );
  });

  it("admits the complete induced overview edge set or defers its candidate atomically", async () => {
    const input = artifact();
    input.edges.push({ id: "module-import", source: "file-a", target: "file-b", kind: "imports" });
    const { bundle } = createBundle(input);
    const review = comparisonContext([
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "modified" },
    ], "head");

    const complete = await bundle.query(projectionRequest({
      view: "review",
      reviewCursor: null,
      depth: 4,
    }), undefined, { review });
    expect(complete.artifact.nodes.map((node) => node.id)).toEqual(["root", "file-a", "file-b"]);
    expect(complete.artifact.edges.map((edge) => edge.id)).toEqual(["module-import"]);
    expect(complete.viewFacts.review?.overview?.entries)
      .toEqual([
        { index: 0, state: "included", isTest: false },
        { index: 1, state: "included", isTest: false },
      ]);
    expect(complete.completeness.complete).toBe(true);

    const edgeLimited = await bundle.query(projectionRequest({
      view: "review",
      reviewCursor: null,
      depth: 4,
      maxEdges: 0,
    }), undefined, { review });
    expect(edgeLimited.artifact.nodes.map((node) => node.id)).toEqual(["root", "file-a"]);
    expect(edgeLimited.artifact.edges).toEqual([]);
    expect(edgeLimited.viewFacts.review?.overview?.entries)
      .toEqual([
        { index: 0, state: "included", isTest: false },
        { index: 1, state: "deferred", isTest: false },
      ]);
    expect(edgeLimited.completeness).toEqual({
      complete: true,
      reasons: [],
      omittedNodes: 0,
      omittedEdges: 0,
    });
  });

  it("stops ancestor staging at maxNodes before touching the rest of a pathological chain", async () => {
    const input = artifact();
    input.nodes.push(
      fixtureNode("deep-parent", "package", "missing-grandparent", "src"),
      fixtureNode("deep-file", "module", "deep-parent", "src/deep.ts"),
    );
    const { bundle } = createBundle(input);
    const review = comparisonContext([{ path: "src/deep.ts", status: "modified" }], "head");

    const overview = await bundle.query(projectionRequest({
      view: "review",
      reviewCursor: null,
      maxNodes: 1,
    }), undefined, { review });

    expect(overview.artifact.nodes).toEqual([]);
    expect(overview.viewFacts.review?.overview?.entries)
      .toEqual([{ index: 0, state: "deferred", isTest: false }]);
    expect(overview.completeness).toEqual({
      complete: true,
      reasons: [],
      omittedNodes: 0,
      omittedEdges: 0,
    });
  });

  it("stops a high-degree induced-edge scan on the first edge that exceeds maxEdges", async () => {
    const input = artifact();
    const peerCount = 1_024;
    input.nodes.push(...Array.from({ length: peerCount }, (_, index) => (
      fixtureNode(`peer-${index}`, "module", "root", `src/peer-${index}.ts`)
    )));
    input.edges.push(
      { id: "first-represented", source: "file-b", target: "file-a", kind: "imports" },
      ...Array.from({ length: peerCount }, (_, index) => ({
        id: `high-degree-${index}`,
        source: "file-b",
        target: `peer-${index}`,
        kind: "imports" as const,
      })),
    );
    const root = temporaryRoot();
    writeGraphProjectionBundle(root, input);
    const shard = projectionShard("file-b").toString(16).padStart(2, "0");
    const outIndex = JSON.parse(readFileSync(join(root, "out-edges", `${shard}.index.json`), "utf8")) as Record<
      string,
      { refs: unknown[] }
    >;
    expect(outIndex["file-b"]?.refs.length).toBeGreaterThan(1);
    const retained = new BoundedGraphProjectionPageCache({ maxBytes: 64 * 1024, maxEntries: 8 });
    const pageReads: string[] = [];
    const cache: GraphProjectionPageCache = {
      get: (namespace, key) => retained.get(namespace, key),
      set: (namespace, key, value, bytes) => {
        pageReads.push(key);
        retained.set(namespace, key, value, bytes);
      },
      stats: (namespace) => retained.stats(namespace),
      deleteNamespace: (namespace) => retained.deleteNamespace(namespace),
    };
    const bundle = new GraphProjectionBundle(root, { pageCache: cache });
    const review = comparisonContext([
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "modified" },
    ], "head");

    const overview = await bundle.query(projectionRequest({
      view: "review",
      reviewCursor: null,
      maxEdges: 0,
    }), undefined, { review });

    expect(overview.artifact.nodes.map((node) => node.id)).toEqual(["root", "file-a"]);
    expect(overview.viewFacts.review?.overview?.entries)
      .toEqual([
        { index: 0, state: "included", isTest: false },
        { index: 1, state: "deferred", isTest: false },
      ]);
    expect(pageReads.filter((key) => key.startsWith(`page:out-edges/${shard}.ndjson`))).toHaveLength(1);
    expect(retained.stats().entries).toBeLessThanOrEqual(8);
    expect(retained.stats().residentBytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("cancels cooperatively while scanning a high-degree overview adjacency", async () => {
    const input = artifact();
    const peerCount = 512;
    input.nodes.push(...Array.from({ length: peerCount }, (_, index) => (
      fixtureNode(`cancel-peer-${index}`, "module", "root", `src/cancel-peer-${index}.ts`)
    )));
    input.edges.push(...Array.from({ length: peerCount }, (_, index) => ({
      id: `cancel-edge-${index}`,
      source: "file-b",
      target: `cancel-peer-${index}`,
      kind: "imports" as const,
    })));
    const root = temporaryRoot();
    writeGraphProjectionBundle(root, input);
    const controller = new AbortController();
    const retained = new BoundedGraphProjectionPageCache({ maxBytes: 64 * 1024, maxEntries: 8 });
    const cache: GraphProjectionPageCache = {
      get: (namespace, key) => retained.get(namespace, key),
      set: (namespace, key, value, bytes) => {
        retained.set(namespace, key, value, bytes);
        if (key.startsWith("page:out-edges/")) controller.abort(new Error("cancel overview adjacency"));
      },
      stats: (namespace) => retained.stats(namespace),
      deleteNamespace: (namespace) => retained.deleteNamespace(namespace),
    };
    const bundle = new GraphProjectionBundle(root, { pageCache: cache });
    const review = comparisonContext([{ path: "src/b.ts", status: "modified" }], "head");

    await expect(bundle.query(projectionRequest({
      view: "review",
      reviewCursor: null,
    }), controller.signal, { review })).rejects.toThrow("cancel overview adjacency");
    expect(retained.stats().entries).toBeLessThanOrEqual(8);
    expect(retained.stats().residentBytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("defers an overview representative atomically when node or byte admission cannot hold it", async () => {
    const input = artifact();
    const file = input.nodes.find((node) => node.id === "file-a")!;
    file.summary = `OVERVIEW_BUDGET_SENTINEL:${"x".repeat(128_000)}`;
    const { bundle } = createBundle(input);
    const review = comparisonContext([{ path: "src/a.ts", status: "modified" }], "head");

    const overview = await bundle.query(projectionRequest({
      view: "review",
      reviewCursor: null,
      depth: 4,
      maxNodes: 1,
      maxEdges: 0,
      maxResponseBytes: 64 * 1024,
    }), undefined, { review });

    expect(overview.artifact.nodes).toEqual([]);
    expect(overview.artifact.edges).toEqual([]);
    expect(overview.viewFacts.review?.overview?.entries)
      .toEqual([{ index: 0, state: "deferred", isTest: false }]);
    expect(overview.completeness).toEqual({
      complete: true,
      reasons: [],
      omittedNodes: 0,
      omittedEdges: 0,
    });
    expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.stringify(overview)).not.toContain("OVERVIEW_BUDGET_SENTINEL");
  });

  it("serves a bounded comparison page before lazily projecting one file beyond page one", async () => {
    const input = artifact();
    input.nodes.push(fixtureNode("first-page", "module", "root", "src/0000.ts"));
    const { bundle } = createBundle(input);
    const handoffFiles: ChangedFileManifestEntry[] = [
      ...Array.from({ length: 130 }, (_, index) => ({
        path: `src/${index.toString().padStart(4, "0")}.ts`,
        status: "modified" as const,
      })),
      { path: "src/a.ts", status: "modified" as const },
    ].sort((left, right) => compareCanonicalPrPreparePaths(left.path, right.path));
    const review = comparisonContext(handoffFiles, "head");

    const overview = await bundle.query(projectionRequest({
      view: "review",
      filePaths: [],
      reviewCursor: null,
      depth: 0,
    }), undefined, { review });

    expect(overview.artifact.nodes.map((node) => node.id)).toEqual(["root", "first-page"]);
    expect(overview.artifact.edges).toEqual([]);
    expect(overview.artifact.extensions).toBeUndefined();
    expect(overview.completeness).toEqual({
      complete: true,
      reasons: [],
      omittedNodes: 0,
      omittedEdges: 0,
    });
    expect(overview.viewFacts.review).toMatchObject({
      totalFiles: 131,
      pageCount: 3,
      page: { index: 0, nextCursor: "page:1" },
      selection: null,
    });
    expect(overview.viewFacts.review?.page?.entries).toHaveLength(64);
    expect(overview.viewFacts.review?.overview?.entries).toHaveLength(64);
    expect(overview.viewFacts.review?.overview?.entries[0])
      .toEqual({ index: 0, state: "included", isTest: false });
    expect(overview.viewFacts.review?.overview?.entries.slice(1)
      .every((entry) => entry.state === "unmapped" && entry.isTest === null)).toBe(true);
    expect(JSON.stringify(overview)).not.toContain("src/a.ts");

    const selectedIndex = handoffFiles.findIndex((file) => file.path === "src/a.ts");
    expect(selectedIndex).toBeGreaterThan(64);
    const selected = await bundle.query(projectionRequest({
      view: "review",
      filePaths: [],
      reviewCursor: reviewFileCursor(selectedIndex),
      depth: 0,
    }), undefined, { review });

    expect(selected.request.filePaths).toEqual([]);
    expect(selected.artifact.nodes.map((node) => node.id)).toContain("file-a");
    expect(selected.viewFacts.review?.selection).toMatchObject({
      index: selectedIndex,
      entry: handoffFiles[selectedIndex],
      graphPath: "src/a.ts",
      graphMatched: true,
    });
    expect(selected.contentId).not.toBe(bundle.manifest.contentId);
    expect(selected.projectionId).toBe(createHash("sha256")
      .update(graphProjectionIdentityPreimage(selected.contentId, selected.request))
      .digest("hex"));
  });

  it("routes added, deleted, and renamed coordinates to the correct comparison side", async () => {
    const input = artifact();
    input.nodes.push(fixtureNode("file-old", "module", "root", "src/old.ts"));
    const { bundle } = createBundle(input);
    const files: ChangedFileManifestEntry[] = [
      { path: "src/added.ts", status: "added" },
      { path: "src/b.ts", status: "deleted" },
      { path: "src/a.ts", previousPath: "src/old.ts", status: "renamed" },
    ];
    const head = comparisonContext(files, "head");
    const mergeBase = { ...head, side: "mergeBase" as const };
    const contextFiles = head.context.changedFiles;
    const cursorFor = (path: string) => reviewFileCursor(
      contextFiles.findIndex((file) => file.path === path),
    );
    const query = (cursor: string, side: typeof head | typeof mergeBase) => bundle.query(
      projectionRequest({ view: "review", reviewCursor: cursor, depth: 0 }),
      undefined,
      { review: side },
    );

    const [headOverview, baseOverview] = await Promise.all([
      bundle.query(projectionRequest({ view: "review", reviewCursor: null, depth: 4 }), undefined, { review: head }),
      bundle.query(projectionRequest({ view: "review", reviewCursor: null, depth: 4 }), undefined, { review: mergeBase }),
    ]);
    expect(headOverview.artifact.nodes.map((node) => node.id)).toEqual(["root", "file-a"]);
    expect(baseOverview.artifact.nodes.map((node) => node.id)).toEqual(["root", "file-old", "file-b"]);
    expect(headOverview.completeness.complete).toBe(true);
    expect(baseOverview.completeness.complete).toBe(true);
    const overviewState = (result: typeof headOverview, path: string) => {
      const page = result.viewFacts.review?.page?.entries ?? [];
      const index = page.find((entry) => entry.path === path)?.index;
      return result.viewFacts.review?.overview?.entries.find((entry) => entry.index === index)?.state;
    };
    expect(overviewState(headOverview, "src/added.ts")).toBe("unmapped");
    expect(overviewState(baseOverview, "src/added.ts")).toBe("absent");
    expect(overviewState(headOverview, "src/b.ts")).toBe("absent");
    expect(overviewState(baseOverview, "src/b.ts")).toBe("included");
    expect(overviewState(headOverview, "src/a.ts")).toBe("included");
    expect(overviewState(baseOverview, "src/a.ts")).toBe("included");

    const [addedBase, deletedHead, deletedBase, renamedHead, renamedBase] = await Promise.all([
      query(cursorFor("src/added.ts"), mergeBase),
      query(cursorFor("src/b.ts"), head),
      query(cursorFor("src/b.ts"), mergeBase),
      query(cursorFor("src/a.ts"), head),
      query(cursorFor("src/a.ts"), mergeBase),
    ]);

    expect(addedBase.artifact.nodes).toEqual([]);
    expect(addedBase.completeness.complete).toBe(true);
    expect(deletedHead.artifact.nodes).toEqual([]);
    expect(deletedHead.viewFacts.review?.selection?.graphPath).toBeNull();
    expect((deletedHead.artifact.extensions?.changedSince as Record<string, unknown>).diffLines).toEqual({
      "src/b.ts": [{ kind: "deleted", oldLine: 1, newLine: null, beforeNewLine: 1, text: "removed" }],
    });
    expect(deletedBase.viewFacts.review?.selection).toMatchObject({ graphPath: "src/b.ts", graphMatched: true });
    expect(renamedHead.viewFacts.review?.selection).toMatchObject({ graphPath: "src/a.ts", graphMatched: true });
    expect(renamedBase.viewFacts.review?.selection).toMatchObject({ graphPath: "src/old.ts", graphMatched: true });
    expect(renamedHead.contentId).not.toBe(renamedBase.contentId);
  });

  it("indexes a valid 4096-byte review path without admitting it through the public path selector", async () => {
    const longPath = `src/${"a".repeat(4_089)}.ts`;
    const input = artifact();
    input.nodes.push(fixtureNode("long-path", "module", "root", longPath));
    const { bundle } = createBundle(input);
    const review = comparisonContext([{ path: longPath, status: "modified" }], "head");

    const selected = await bundle.query(projectionRequest({
      view: "review",
      reviewCursor: "file:0",
      depth: 0,
    }), undefined, { review });

    expect(selected.artifact.nodes.map((node) => node.id)).toContain("long-path");
    expect(selected.viewFacts.review?.selection).toMatchObject({ graphPath: longPath, graphMatched: true });
    expect(() => canonicalizeGraphProjectionRequest(projectionRequest({
      view: "review",
      filePaths: [longPath],
    }))).toThrow(/filePaths contains a non-canonical file path/);
  });

  it("never persists or transports arbitrary artifact extensions", async () => {
    const { bundle, root } = createBundle();
    const result = await bundle.query(projectionRequest({ view: "review", filePaths: ["src/a.ts"], depth: 0 }));

    expect(readAllFiles(root)).not.toContain("UNRELATED_EXTENSION_SENTINEL");
    expect(JSON.stringify(result)).not.toContain("UNRELATED_EXTENSION_SENTINEL");
    expect(Object.keys(result.artifact.extensions ?? {}).sort()).toEqual(["changedSince", "entryModules"]);
  });

  it("rejects malformed known change data instead of publishing a partial projection", async () => {
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

  it("includes telemetry in immutable bundle identity", async () => {
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

  it("canonicalizes unordered navigation state into one stable projection id", async () => {
    const { bundle } = createBundle();
    const first = await bundle.query(projectionRequest({
      view: "modules",
      focusIds: ["file-b", "file-a", "file-a"],
      expandedIds: ["file-b", "file-a"],
    }));
    const second = await bundle.query(projectionRequest({
      view: "modules",
      focusIds: ["file-a", "file-b"],
      expandedIds: ["file-a", "file-b"],
    }));
    const reverseOrderInput = Object.fromEntries(Object.entries(projectionRequest({
      view: "modules",
      focusIds: ["file-a", "file-b"],
      expandedIds: ["file-a", "file-b"],
    })).reverse()) as unknown as GraphProjectionRequest;
    const reverseOrder = await bundle.query(reverseOrderInput);

    expect(first.request).toEqual(second.request);
    expect(first.projectionId).toBe(second.projectionId);
    expect(reverseOrder.request).toEqual(second.request);
    expect(reverseOrder.projectionId).toBe(second.projectionId);
    expect(first.projectionId).toBe(createHash("sha256")
      .update(graphProjectionIdentityPreimage(bundle.manifest.contentId, first.request))
      .digest("hex"));

    const reviewFirst = await bundle.query(projectionRequest({
      view: "review",
      filePaths: ["src/b.ts", "src/a.ts", "src/a.ts"],
    }));
    const reviewSecond = await bundle.query(projectionRequest({
      view: "review",
      filePaths: ["src/a.ts", "src/b.ts"],
    }));
    expect(reviewFirst.request.filePaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(reviewFirst.projectionId).toBe(reviewSecond.projectionId);
  });

  it("rejects an incompatible legacy bundle manifest without a compatibility reader", async () => {
    const { root } = createBundle();
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.formatVersion = 3;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(readGraphProjectionManifest(root)).toBeNull();
    expect(() => new GraphProjectionBundle(root)).toThrow(/manifest is unavailable or invalid/);
  });

  it("does not advertise a bundle whose required fact sidecars are unreadable", async () => {
    const { root } = createBundle();
    writeFileSync(join(root, "module-overview.json"), "");

    expect(readGraphProjectionManifest(root)).toBeNull();
    expect(() => new GraphProjectionBundle(root)).toThrow(/manifest is unavailable or invalid/);
  });

  it("reports truncation explicitly and retains a structurally closed subset", async () => {
    const { bundle } = createBundle();
    const result = await bundle.query(projectionRequest({ view: "modules", depth: 4, maxNodes: 3 }));
    const ids = new Set(result.artifact.nodes.map((node) => node.id));

    expect(result.completeness.complete).toBe(false);
    expect(result.completeness.reasons).toContain("node-limit");
    expect(result.completeness.omittedNodes).toBeGreaterThan(0);
    expect(result.artifact.nodes.every((node) => node.parentId == null || ids.has(node.parentId))).toBe(true);
    expect(result.artifact.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
  });

  it("keeps the complete serialized response inside the requested byte limit", async () => {
    const input = artifact();
    const hidden = input.nodes.find((node) => node.id === "huge-hidden");
    if (hidden) hidden.summary = `RESPONSE_LIMIT_SENTINEL:${"x".repeat(128_000)}`;
    const { bundle } = createBundle(input);
    const result = await bundle.query(projectionRequest({
      view: "modules",
      depth: 4,
      maxResponseBytes: 64 * 1024,
    }));

    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64 * 1024);
    expect(result.completeness).toMatchObject({ complete: false, reasons: expect.arrayContaining(["byte-limit"]) });
    expect(JSON.stringify(result)).not.toContain("RESPONSE_LIMIT_SENTINEL");
  });

  it("charges parsed cache data at a conservative decoded size and skips undersized budgets", async () => {
    const { root } = createBundle();
    const charges: Array<{ key: string; residentBytes: number }> = [];
    const recordingCache: GraphProjectionPageCache = {
      get: () => undefined,
      set: (_namespace, key, _value, residentBytes) => charges.push({ key, residentBytes }),
      stats: () => ({
        residentBytes: 0,
        entries: 0,
        trackedNamespaces: 0,
        hits: 0,
        misses: 0,
        evictions: 0,
        oversizeSkips: 0,
      }),
      deleteNamespace: () => {},
    };
    const request = projectionRequest({ view: "modules", focusIds: ["file-a"], depth: 1 });

    await new GraphProjectionBundle(root, { pageCache: recordingCache }).query(request);

    const parsedCharges = charges.filter(({ key }) => key.startsWith("json:") || key.startsWith("page:"));
    expect(parsedCharges.length).toBeGreaterThan(0);
    for (const charge of parsedCharges) {
      const encodedBytes = encodedBytesForCacheKey(root, charge.key);
      expect(charge.residentBytes).toBe(Math.max(encodedBytes * 3, encodedBytes + 1_024));
    }

    const minimumCharge = Math.min(...parsedCharges.map(({ residentBytes }) => residentBytes));
    const bounded = new GraphProjectionBundle(root, {
      maxCacheBytes: minimumCharge - 1,
      maxCacheEntries: 128,
    });
    await bounded.query(request);
    expect(bounded.cacheStats()).toMatchObject({
      residentBytes: 0,
      entries: 0,
      oversizeSkips: expect.any(Number),
    });
    expect(bounded.cacheStats().oversizeSkips).toBeGreaterThan(0);
  });

  it("bounds parsed shard pages with a byte-and-entry LRU", async () => {
    const { root } = createBundle();
    const bundle = new GraphProjectionBundle(root, { maxCacheBytes: 4_000, maxCacheEntries: 2 });

    await bundle.query(projectionRequest({ view: "modules", focusIds: ["file-a"], depth: 1 }));
    await bundle.query(projectionRequest({ view: "modules", focusIds: ["file-b"], depth: 1 }));

    expect(bundle.cacheStats().entries).toBeLessThanOrEqual(2);
    expect(bundle.cacheStats().residentBytes).toBeLessThanOrEqual(4_000);
    expect(bundle.cacheStats().evictions + bundle.cacheStats().oversizeSkips).toBeGreaterThan(0);
    bundle.clearMemoryCache();
    expect(bundle.cacheStats()).toMatchObject({ residentBytes: 0, entries: 0 });
  });

  it("namespaces a shared page cache by immutable bundle root", async () => {
    const firstArtifact = artifact();
    const secondArtifact = artifact();
    firstArtifact.nodes[0]!.displayName = "first-root";
    secondArtifact.nodes[0]!.displayName = "second-root";
    const firstRoot = createBundle(firstArtifact).root;
    const secondRoot = createBundle(secondArtifact).root;
    const cache = new BoundedGraphProjectionPageCache({ maxBytes: 1024 * 1024, maxEntries: 128 });
    const first = new GraphProjectionBundle(firstRoot, { pageCache: cache });
    const second = new GraphProjectionBundle(secondRoot, { pageCache: cache });
    const request = projectionRequest({ view: "modules", focusIds: ["root"], depth: 1 });

    const firstResult = await first.query(request);
    const secondResult = await second.query(request);

    expect(firstResult.artifact.nodes.find((node) => node.id === "root")?.displayName).toBe("first-root");
    expect(secondResult.artifact.nodes.find((node) => node.id === "root")?.displayName).toBe("second-root");
    expect(first.cacheStats().entries).toBeGreaterThan(0);
    expect(second.cacheStats().entries).toBeGreaterThan(0);
  });

  it("retains namespace identity only for bounded resident entries during root churn", () => {
    const cache = new BoundedGraphProjectionPageCache({ maxBytes: 300, maxEntries: 3 });

    for (let index = 0; index < 256; index += 1) {
      cache.set(`/immutable/graph-${index}`, "page:index:0:1", { index }, 100);
    }

    expect(cache.stats()).toMatchObject({
      residentBytes: 300,
      entries: 3,
      trackedNamespaces: 3,
      evictions: 253,
    });
  });

  it("invalidates only one root in a shared cache and preserves single-reader reuse", async () => {
    const firstRoot = createBundle().root;
    const secondRoot = createBundle().root;
    const cache = new BoundedGraphProjectionPageCache({ maxBytes: 1024 * 1024, maxEntries: 128 });
    const first = new GraphProjectionBundle(firstRoot, { pageCache: cache });
    const second = new GraphProjectionBundle(secondRoot, { pageCache: cache });
    const request = projectionRequest({ view: "modules", focusIds: ["file-a"], depth: 1 });

    await first.query(request);
    const firstHits = cache.stats().hits;
    await first.query(request);
    expect(cache.stats().hits).toBeGreaterThan(firstHits);
    await second.query(request);
    const secondBeforeInvalidation = second.cacheStats();
    const sharedHits = cache.stats().hits;

    first.clearMemoryCache();

    expect(first.cacheStats()).toEqual({
      residentBytes: 0,
      entries: 0,
      trackedNamespaces: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
      oversizeSkips: 0,
    });
    expect(cache.stats().entries).toBe(secondBeforeInvalidation.entries);
    await second.query(request);
    expect(cache.stats().hits).toBeGreaterThan(sharedHits);
  });

  it("rejects oversized or malformed view requests before touching bundle data", async () => {
    expect(() => canonicalizeGraphProjectionRequest(projectionRequest({
      expandedIds: Array.from({ length: 513 }, (_, index) => `node-${index}`),
    }))).toThrow(GraphProjectionRequestError);
    expect(() => canonicalizeGraphProjectionRequest(projectionRequest({ depth: 99 }))).toThrow(/depth/);
    expect(() => canonicalizeGraphProjectionRequest(projectionRequest({
      view: "review",
      filePaths: ["../src/a.ts"],
    }))).toThrow(/canonical/);
    expect(() => canonicalizeGraphProjectionRequest(projectionRequest({
      view: "modules",
      filePaths: ["src/a.ts"],
    }))).toThrow(/review/);
    expect(() => canonicalizeGraphProjectionRequest(projectionRequest({
      view: "modules",
      reviewCursor: "file:0",
    }))).toThrow(/review/);
    expect(() => canonicalizeGraphProjectionRequest(projectionRequest({
      view: "review",
      reviewCursor: "file:01",
    }))).toThrow(/canonical comparison coordinate/);
    expect(() => canonicalizeGraphProjectionRequest(projectionRequest({
      view: "review",
      filePaths: Array.from({ length: 513 }, (_, index) => `src/${index}.ts`),
    }))).toThrow(GraphProjectionRequestError);
    expect(() => canonicalizeGraphProjectionRequest(projectionRequest({
      causalIds: Array.from({ length: 2_000 }, (_, index) => `${index}:${"x".repeat(140)}`),
    }))).toThrow(/causalIds exceeds its byte limit/);
    expect(() => canonicalizeGraphProjectionRequest({
      ...projectionRequest(),
      unexpected: true,
    } as never)).toThrow(/fields do not match the v9 contract/);
  });
});

function comparisonContext(
  changedFiles: readonly ChangedFileManifestEntry[],
  side: ReviewComparisonSide,
) {
  const root = temporaryRoot();
  const reference = writeReviewComparisonContext(join(root, "review-context.json"), {
    headSha: "1".repeat(40),
    mergeBaseSha: "2".repeat(40),
    headContentId: "a".repeat(64),
    mergeBaseContentId: "b".repeat(64),
    analysisKey: "test-analysis-v1",
    changedFiles,
    testClassifications: [],
  });
  const context = readReviewComparisonContext(reference);
  if (context === null) throw new Error("test review comparison context did not verify");
  return { context, contextId: reference.sha256, metadataId: "d".repeat(64), side };
}

function createBundle(input: GraphArtifact = artifact()): { bundle: GraphProjectionBundle; root: string } {
  const root = temporaryRoot();
  writeGraphProjectionBundle(root, input);
  return { root, bundle: new GraphProjectionBundle(root) };
}

function encodedBytesForCacheKey(root: string, key: string): number {
  if (key.startsWith("json:")) return statSync(join(root, key.slice("json:".length))).size;
  const lengthSeparator = key.lastIndexOf(":");
  const length = Number(key.slice(lengthSeparator + 1));
  if (!key.startsWith("page:") || !Number.isSafeInteger(length) || length < 0) {
    throw new Error(`unsupported cache key: ${key}`);
  }
  return length;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-projections-"));
  roots.push(root);
  return root;
}

function fixtureNode(
  id: string,
  kind: GraphArtifact["nodes"][number]["kind"],
  parentId: string | null,
  file: string,
): GraphArtifact["nodes"][number] {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file, startLine: 1 },
  };
}

function sameProjectionShardIds(count: number): string[] {
  const buckets = new Map<number, string[]>();
  for (let ordinal = 0; ; ordinal += 1) {
    const id = `ts:same-shard-${ordinal}`;
    const shard = projectionShard(id);
    const ids = buckets.get(shard) ?? [];
    ids.push(id);
    if (ids.length === count) return ids;
    buckets.set(shard, ids);
  }
}

function projectionShard(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0xff;
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
