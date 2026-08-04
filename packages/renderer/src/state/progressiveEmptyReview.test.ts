import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GRAPH_PROJECTION_VERSION,
  type GraphArtifact,
  type GraphProjectionV1,
} from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore } from "./store";

const BOOT_ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-31T00:00:00.000Z",
  generator: { name: "test", version: "1" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [{
    id: "ts:src/app.ts",
    kind: "module",
    qualifiedName: "src/app.ts",
    displayName: "app.ts",
    location: { file: "src/app.ts", startLine: 1 },
  }],
  edges: [],
};

function emptyProjection(
  graphId: string,
  seedGraphId: string,
  extensions?: GraphProjectionV1["extensions"],
): GraphProjectionV1 {
  return {
    version: GRAPH_PROJECTION_VERSION,
    graphId,
    seedGraphId,
    generation: `${graphId}-generation`,
    requestedDepth: 1,
    prefetchDepth: 3,
    loadedDepth: 1,
    schemaVersion: "1.0.0",
    generatedAt: "2026-07-31T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "fixture", root: ".", language: "typescript" },
    extensions,
    nodes: [],
    edges: [],
    rootFileIds: [],
    readyFileIds: [],
    loadedFileIds: [],
    frontier: [],
    counts: {
      full: { nodes: 1, edges: 0, files: 1 },
      slice: { nodes: 0, edges: 0, files: 0 },
    },
  };
}

function ndjsonDone(value: object): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("progressive manifest-only PR review", () => {
  it("opens an exact docs-only review from an empty projection pair without loading full artifacts", async () => {
    const pairId = "0123456789abcdefabcd";
    const headGraphId = "pr-head-docs";
    const comparisonGraphId = "pr-base-docs";
    const head = emptyProjection(headGraphId, headGraphId, {
      changedSince: {
        baseRef: "origin/main",
        manifest: [{ path: "README.md", status: "modified" }],
        files: {},
        kinds: {},
        stats: { "README.md": { added: 1, deleted: 1 } },
      },
    });
    const comparison = emptyProjection(comparisonGraphId, headGraphId);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString(), "http://meridian.local");
      if (url.pathname === "/api/pr/analyze") {
        return ndjsonDone({
          stage: "done",
          pairId,
          completeness: "provisional",
          graphId: headGraphId,
          comparisonGraphId,
          headSha: "a".repeat(40),
          mergeBaseSha: "b".repeat(40),
        });
      }
      if (url.pathname === "/api/graph/project") {
        const body = JSON.parse(String(init?.body)) as { graphId: string };
        return Response.json(body.graphId === headGraphId ? head : comparison);
      }
      if (url.pathname === "/api/meta") {
        return Response.json({
          syntheticExecutionUrl: null,
          syntheticScenarios: [],
          syntheticExecutionTrust: null,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = createBlueprintStore({
      artifact: BOOT_ARTIFACT,
      index: buildGraphIndex(BOOT_ARTIFACT),
      provider: null,
      hasOverlay: false,
      sourceUrl: null,
      prSessionSource: { repository: "o/r", subdir: "" },
      prsUrl: "/api/prs?id=boot",
      prOneUrl: "/api/prs/one?id=boot",
      prFilesUrl: "/api/prs/files?id=boot",
      prRelatedUrl: "/api/prs/related?id=boot",
      prCommentsUrl: "/api/prs/comments?id=boot",
      prChecksUrl: "/api/prs/checks?id=boot",
      prReviewUrl: "/api/prs/review?id=boot",
      analyzeUrl: "/api/pr/analyze",
      graphId: "boot",
      graphUrl: "/api/graph?id=boot",
      graphProjectUrl: "/api/graph/project",
      graphSymbolsUrl: "/api/graph/symbols",
      metaUrl: "/api/meta?id=boot",
    });
    store.setState({
      viewMode: "prs",
      prSelected: 7,
      prsList: {
        open: [{
          number: 7,
          title: "Docs only",
          body: null,
          author: "octo",
          headRef: "docs",
          headSha: "a".repeat(40),
          baseRef: "main",
          updatedAt: "2026-07-31T00:00:00.000Z",
          draft: false,
          state: "open",
          url: "https://github.com/o/r/pull/7",
        }],
        closed: null,
      },
      prFiles: [{
        path: "README.md",
        status: "modified",
        additions: 1,
        deletions: 1,
        hunks: [{ start: 1, end: 1 }],
      }],
      prFilesTotal: 1,
    });

    await store.getState().reviewPrInGraph();

    const state = store.getState();
    expect(state.prReviewed).toBe(7);
    expect(state.prReviewBlocked).toBeNull();
    expect(state.viewMode).toBe("modules");
    expect(state.progressiveGraph).toMatchObject({
      head: { graphId: headGraphId, rootFileIds: [] },
      comparison: { graphId: comparisonGraphId, rootFileIds: [] },
      status: "ready",
    });
    expect(state.review?.context.changedFiles).toEqual([
      expect.objectContaining({ path: "README.md", status: "modified" }),
    ]);
    expect(state.reviewFiles).toEqual([
      expect.objectContaining({ path: "README.md", moduleId: null }),
    ]);
    expect(fetchMock.mock.calls.some(([input]) => {
      const url = new URL(input.toString(), "http://meridian.local");
      return url.pathname === "/api/graph";
    })).toBe(false);
  });
});
