import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore } from "./store";
import type { PrSummary } from "./prTypes";

function node(id: string, kind: string, file: string, parentId?: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } };
}

function pr(number: number, title = `PR ${number}`): PrSummary {
  return {
    number,
    title,
    author: "octo",
    headRef: "feature",
    updatedAt: "2026-07-08T00:00:00.000Z",
    draft: false,
    state: "open",
  };
}

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-08T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [node("ts:src", "package", "src"), node("ts:src/a.ts", "module", "src/a.ts", "ts:src")],
  edges: [],
};

function freshStore() {
  const index = buildGraphIndex(ARTIFACT);
  return createBlueprintStore({
    artifact: ARTIFACT,
    index,
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "/api/prs?id=artifact-1",
    prFilesUrl: "/api/prs/files?id=artifact-1",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PR store slice", () => {
  it("appends paged PRs and dedupes by number", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ prs: [pr(1), pr(2)], hasMore: true }))
      .mockResolvedValueOnce(Response.json({ prs: [pr(2, "PR 2 updated"), pr(3)], hasMore: false }));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    await store.getState().loadPrs(1);
    await store.getState().loadPrs(2);
    expect(store.getState().prsList.open?.map((item) => [item.number, item.title])).toEqual([
      [1, "PR 1"],
      [2, "PR 2 updated"],
      [3, "PR 3"],
    ]);
    expect(store.getState().prsHasMore.open).toBe(false);
    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://meridian.local/api/prs?id=artifact-1&state=open&page=1");
  });

  it("reviews PR files by emphasizing matched modules in the UI graph", () => {
    const store = freshStore();
    store.setState({
      prFiles: [{ path: "repo/src/a.ts", status: "modified" }],
      flowSelection: { rootId: "stale", blockPath: [] },
    });
    store.getState().reviewPrInGraph();
    expect(store.getState().viewMode).toBe("ui");
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().flowEmphasis).toEqual(new Set(["ts:src/a.ts"]));
    expect(store.getState().expanded).toEqual(new Set(["ts:src"]));
  });
});
