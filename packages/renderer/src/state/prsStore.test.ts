import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrReviewSection } from "../components/controlpanel/PrReviewSection";
import { countTestFiles } from "../components/controlpanel/OverlaysSection";
import { ReviewPanel } from "../components/review/ReviewPanel";
import { applyChangedIds, buildGraphIndex } from "../graph/graphIndex";
import { restorePrReviewBaseline, swapToPreparedArtifact } from "./prReviewSession";
import { createBlueprintStore, selectedPrSummary, type StoreDependencies } from "./store";
import { StoreProvider } from "./StoreContext";
import type { PrGitHubComment, PrSummary } from "./prTypes";

function node(id: string, kind: string, file: string, parentId?: string, lines?: { start: number; end: number }): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file, startLine: lines?.start ?? 1, endLine: lines?.end },
  };
}

function pr(number: number, title = `PR ${number}`): PrSummary {
  return {
    number,
    title,
    body: null,
    author: "octo",
    headRef: "feature",
    headSha: null,
    baseRef: "main",
    updatedAt: "2026-07-08T00:00:00.000Z",
    draft: false,
    state: "open",
    url: `https://github.com/o/r/pull/${number}`,
  };
}

const PACKAGE_ID = "ts:src";
const FILE_ID = "ts:src/a.ts";
const CLASS_ID = `${FILE_ID}#Svc`;
const METHOD_ID = `${CLASS_ID}.run`;
const UNCHANGED_METHOD_ID = `${CLASS_ID}.idle`;
const TEST_FILE_ID = "ts:src/a.test.ts";
const TEST_METHOD_ID = `${TEST_FILE_ID}#coversRun`;

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-08T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node(PACKAGE_ID, "package", "src"),
    node(FILE_ID, "module", "src/a.ts", PACKAGE_ID),
    node(CLASS_ID, "class", "src/a.ts", FILE_ID, { start: 3, end: 20 }),
    node(METHOD_ID, "method", "src/a.ts", CLASS_ID, { start: 10, end: 12 }),
  ],
  edges: [],
};

const REVIEW_WITH_TESTS_ARTIFACT: GraphArtifact = {
  ...ARTIFACT,
  nodes: [
    ...ARTIFACT.nodes,
    node(TEST_FILE_ID, "module", "src/a.test.ts", PACKAGE_ID),
    node(TEST_METHOD_ID, "function", "src/a.test.ts", TEST_FILE_ID, { start: 5, end: 8 }),
  ],
  edges: [
    { id: "test-calls-run", source: TEST_METHOD_ID, target: METHOD_ID, kind: "calls", resolution: "resolved" },
  ],
  extensions: {
    logicFlow: {
      [METHOD_ID]: [],
      [TEST_METHOD_ID]: [{ kind: "call", label: "run", target: METHOD_ID, resolution: "resolved" }],
    },
  },
};

const REVIEW_WITH_CONTEXT_ARTIFACT: GraphArtifact = {
  ...ARTIFACT,
  nodes: [
    ...ARTIFACT.nodes,
    node(UNCHANGED_METHOD_ID, "method", "src/a.ts", CLASS_ID, { start: 14, end: 16 }),
  ],
};

function freshStore(extra?: Partial<StoreDependencies>) {
  return freshStoreForArtifact(ARTIFACT, extra);
}

function freshStoreForArtifact(artifact: GraphArtifact, extra?: Partial<StoreDependencies>) {
  const index = buildGraphIndex(artifact);
  return createBlueprintStore({
    artifact,
    index,
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prSessionSource: { repository: "https://github.com/o/r", subdir: "" },
    prsUrl: "/api/prs?id=artifact-1",
    prOneUrl: "/api/prs/one?id=artifact-1",
    prFilesUrl: "/api/prs/files?id=artifact-1",
    prRelatedUrl: "/api/prs/related?id=artifact-1",
    prCommentsUrl: "/api/prs/comments?id=artifact-1",
    prChecksUrl: "/api/prs/checks?id=artifact-1",
    prReviewUrl: "/api/prs/review?id=artifact-1",
    ...extra,
  });
}

function stubReviewStorage(): Record<string, string> {
  const data: Record<string, string> = {};
  vi.stubGlobal("window", {
    location: { origin: "http://meridian.local" },
    localStorage: {
      getItem: (key: string) => data[key] ?? null,
      setItem: (key: string, value: string) => {
        data[key] = value;
      },
      removeItem: (key: string) => {
        delete data[key];
      },
    },
  });
  return data;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PR store slice", () => {
  it("counts raw PR test files only on PR/review surfaces and deduplicates graph matches", () => {
    const addedTest = { path: "repo/src/new.test.ts", status: "added" as const, additions: 1, deletions: 0 };
    const plainStore = freshStore();
    plainStore.setState({ viewMode: "modules", prFiles: [addedTest] });
    expect(countTestFiles(plainStore.getState())).toBe(0);
    plainStore.setState({ viewMode: "prs" });
    expect(countTestFiles(plainStore.getState())).toBe(1);

    const matchedStore = freshStoreForArtifact(REVIEW_WITH_TESTS_ARTIFACT);
    matchedStore.setState({
      viewMode: "prs",
      prFiles: [{ ...addedTest, path: "repo/src/a.test.ts" }],
    });
    expect(countTestFiles(matchedStore.getState())).toBe(1);

    const taggedDeletedArtifact = {
      ...ARTIFACT,
      nodes: [
        ...ARTIFACT.nodes,
        { ...node("ts:src/checks.ts", "module", "src/checks.ts", PACKAGE_ID), tags: ["test"] },
      ],
    } as GraphArtifact;
    plainStore.setState({
      viewMode: "modules",
      prReviewed: 7,
      prFiles: [],
      review: {
        context: {
          changedFiles: [{ path: "src/checks.ts", status: "deleted" }],
          baseRef: "main",
          baseSha: null,
          headRef: "feature",
          reviewKey: "deleted-test-review",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
      prReviewBaseline: {
        artifact: taggedDeletedArtifact,
        index: buildGraphIndex(taggedDeletedArtifact),
        review: null,
      },
    });
    expect(countTestFiles(plainStore.getState())).toBe(1);

    plainStore.setState({
      prReviewed: null,
      prReviewBaseline: null,
      prFiles: null,
      review: {
        context: {
          changedFiles: [{ path: "src/added.spec.ts", status: "added" }],
          baseRef: null,
          baseSha: null,
          headRef: null,
          reviewKey: "artifact-review",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
    });
    expect(countTestFiles(plainStore.getState())).toBe(1);
  });

  it("projects artifact-carried review paint and rows through the Tests toggle", () => {
    const artifactReview = {
      ...REVIEW_WITH_TESTS_ARTIFACT,
      extensions: {
        ...REVIEW_WITH_TESTS_ARTIFACT.extensions,
        review: {
          changedFiles: [
            { path: "src/a.ts", status: "modified", hunks: [{ start: 10, end: 10 }] },
            { path: "src/a.test.ts", status: "modified", hunks: [{ start: 5, end: 5 }] },
            { path: "src/added.spec.ts", status: "added" },
          ],
          baseRef: "main",
          baseSha: null,
          headRef: "feature",
          reviewKey: "artifact-review",
          warnings: [],
        },
      },
    } as GraphArtifact;
    const store = freshStoreForArtifact(artifactReview);

    expect(store.getState().reviewFiles.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(store.getState().reviewAffectedIds).toEqual(new Set([METHOD_ID]));
    expect(store.getState().index.changedIds).toEqual(new Set([METHOD_ID]));
    expect(countTestFiles(store.getState())).toBe(2);

    store.getState().toggleShowTests();

    expect(store.getState().reviewFiles.map((file) => file.path)).toEqual([
      "src/a.test.ts",
      "src/a.ts",
      "src/added.spec.ts",
    ]);
    expect(store.getState().reviewAffectedIds).toEqual(new Set([METHOD_ID, TEST_METHOD_ID]));
    expect(store.getState().index.changedIds).toEqual(new Set([METHOD_ID, TEST_METHOD_ID]));
  });

  it("does not call PR endpoints for a graph that is not connected to GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore({ prSessionSource: null });

    await store.getState().loadPrs(1);
    await store.getState().selectPr(8);
    store.getState().togglePrsView();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getState().prSelected).toBeNull();
    expect(store.getState().viewMode).toBe("modules");
  });

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

  it("fetches a missing PR summary into the extra cache without loading a page", async () => {
    const summary = { ...pr(42), state: "closed" as const };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ pr: summary }));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    await store.getState().ensurePrSummary(42);
    expect(store.getState().prExtraSummaries).toEqual({ 42: summary });
    expect(store.getState().prsList).toEqual({ open: null, closed: null });
    expect(store.getState().prsHasMore).toEqual({ open: false, closed: false });
    store.setState({ prSelected: 42 });
    expect(selectedPrSummary(store.getState())).toEqual(summary);
    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://meridian.local/api/prs/one?id=artifact-1&n=42");
  });

  it("does not fetch a PR summary already present in a list or extra cache", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    store.setState({
      prsList: { open: null, closed: [{ ...pr(42), state: "closed" }] },
      prExtraSummaries: { 7: pr(7) },
    });
    await store.getState().ensurePrSummary(42);
    await store.getState().ensurePrSummary(7);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers a paged summary over a one-off cached summary", () => {
    const listed = pr(42, "Listed PR");
    const store = freshStore();
    store.setState({
      prSelected: 42,
      prsList: { open: [listed], closed: null },
      prExtraSummaries: { 42: pr(42, "Cached PR") },
    });
    expect(selectedPrSummary(store.getState())).toEqual(listed);
  });

  it("reviews a PR with only the visible graph layout, then restores the Map on close", async () => {
    const store = freshStore();
    const moduleRelayout = vi.fn(async () => {});
    const minimalRelayout = vi.fn(async () => {});
    store.setState({
      viewMode: "prs",
      prSelected: 7,
      prsList: { open: [pr(7)], closed: null },
      prFiles: [{ path: "repo/src/a.ts", status: "modified", additions: 1, deletions: 0, hunks: [{ start: 1, end: 1 }] }],
      moduleRelayout,
      minimalRelayout,
    });
    await store.getState().reviewPrInGraph();
    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts"]);
    expect(minimalRelayout).toHaveBeenCalledOnce();
    expect(moduleRelayout).not.toHaveBeenCalled();
    // The PR's line diff is joined into changedSince so the code panel's </> highlights the added
    // lines (green) over the block-level review.
    const changedSince = (store.getState().artifact.extensions as { changedSince?: { files?: Record<string, unknown>; kinds?: Record<string, unknown> } })?.changedSince;
    expect(changedSince?.files?.["src/a.ts"]).toEqual([{ start: 1, end: 1 }]);
    expect(changedSince?.kinds?.["src/a.ts"]).toEqual([{ start: 1, end: 1, kind: "added" }]);

    store.getState().closeMinimalGraph();
    await vi.waitFor(() => expect(moduleRelayout).toHaveBeenCalledOnce());
    expect(store.getState().minimalSeedIds).toEqual([]);
  });

  it("toggles a session-only diff-node graph projection and clears selections it hides", async () => {
    const store = freshStoreForArtifact(REVIEW_WITH_CONTEXT_ARTIFACT);
    const minimalRelayout = vi.fn(async () => {});
    store.setState({
      viewMode: "prs",
      prSelected: 7,
      prsList: { open: [pr(7)], closed: null },
      prFiles: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, hunks: [{ start: 10, end: 10 }] }],
      minimalRelayout,
    });
    await store.getState().reviewPrInGraph();
    minimalRelayout.mockClear();
    store.setState({
      moduleSelected: new Set([METHOD_ID, UNCHANGED_METHOD_ID]),
      reviewSelectedId: UNCHANGED_METHOD_ID,
      reviewLitNodeIds: new Set([METHOD_ID, UNCHANGED_METHOD_ID]),
      logicSelected: UNCHANGED_METHOD_ID,
    });

    store.getState().toggleReviewDiffOnly();

    expect(store.getState().reviewDiffOnly).toBe(true);
    expect(store.getState().moduleSelected).toEqual(new Set([METHOD_ID]));
    expect(store.getState().reviewSelectedId).toBeNull();
    expect(store.getState().reviewLitNodeIds).toEqual(new Set([METHOD_ID]));
    expect(store.getState().logicSelected).toBeNull();
    expect(minimalRelayout).toHaveBeenCalledOnce();
    expect(minimalRelayout).toHaveBeenLastCalledWith({ label: "Hiding unchanged graph context…" });

    store.getState().toggleShowTests();
    expect(store.getState().reviewDiffOnly).toBe(true);

    minimalRelayout.mockClear();
    store.getState().toggleReviewDiffOnly();
    expect(store.getState().reviewDiffOnly).toBe(false);
    expect(minimalRelayout).toHaveBeenCalledWith({ label: "Restoring graph context…" });
  });

  it("uses the existing Tests toggle to remove and losslessly restore every PR-review test surface", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStoreForArtifact(REVIEW_WITH_TESTS_ARTIFACT);
    store.setState({
      viewMode: "prs",
      prSelected: 7,
      prsList: { open: [pr(7)], closed: null },
      prFiles: [
        { path: "src/a.ts", status: "modified", additions: 1, deletions: 0, hunks: [{ start: 10, end: 10 }] },
        { path: "src/a.test.ts", status: "modified", additions: 1, deletions: 0, hunks: [{ start: 5, end: 5 }] },
      ],
    });

    await store.getState().reviewPrInGraph();

    expect(store.getState().showTests).toBe(false);
    expect(store.getState().review?.context.changedFiles.map((file) => file.path)).toEqual([
      "src/a.ts",
      "src/a.test.ts",
    ]);
    expect(store.getState().reviewFiles.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(store.getState().minimalSeedIds).toEqual([FILE_ID]);
    expect(store.getState().minimalMemberIds).toEqual([FILE_ID]);
    expect(store.getState().reviewAffectedIds).toEqual(new Set([METHOD_ID]));
    expect(store.getState().review?.rows.some((row) => row.flow.flowId === TEST_METHOD_ID)).toBe(false);
    expect(Object.keys((store.getState().artifact.extensions as { changedSince: { files: object } }).changedSince.files)).toEqual(["src/a.ts"]);

    store.getState().toggleShowTests();

    expect(store.getState().reviewFiles.map((file) => file.path)).toEqual([
      "src/a.test.ts",
      "src/a.ts",
    ]);
    expect(store.getState().minimalSeedIds).toEqual([TEST_FILE_ID, FILE_ID]);
    expect(store.getState().minimalMemberIds).toEqual([TEST_FILE_ID, FILE_ID]);
    expect(store.getState().reviewAffectedIds).toEqual(new Set([METHOD_ID, TEST_METHOD_ID]));
    expect(store.getState().review?.rows.some((row) => row.flow.flowId === TEST_METHOD_ID)).toBe(true);
    expect(Object.keys((store.getState().artifact.extensions as { changedSince: { files: object } }).changedSince.files).sort()).toEqual([
      "src/a.test.ts",
      "src/a.ts",
    ]);

    const testFile = store.getState().reviewFiles.find((file) => file.path.endsWith("a.test.ts"))!;
    store.getState().toggleReviewFileViewed(testFile.path);
    store.getState().addReviewComment(testFile.path, null, "Keep this hidden test draft");
    store.setState({
      moduleSelected: new Set([FILE_ID]),
      reviewSelectedId: FILE_ID,
      reviewLitNodeIds: new Set([METHOD_ID]),
    });
    expect(store.getState().reviewUnitTicks[TEST_METHOD_ID]).toBeDefined();
    expect(store.getState().reviewComments).toHaveLength(1);

    store.getState().toggleShowTests();

    expect(store.getState().reviewFiles.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(store.getState().minimalSeedIds).toEqual([FILE_ID]);
    expect(store.getState().minimalMemberIds).toEqual([FILE_ID]);
    expect(store.getState().reviewAffectedIds).toEqual(new Set([METHOD_ID]));
    expect(store.getState().moduleSelected).toEqual(new Set([FILE_ID]));
    expect(store.getState().reviewSelectedId).toBe(FILE_ID);
    expect(store.getState().reviewLitNodeIds).toEqual(new Set([METHOD_ID]));
    expect(Object.keys((store.getState().artifact.extensions as { changedSince: { files: object } }).changedSince.files)).toEqual(["src/a.ts"]);
    expect(store.getState().reviewUnitTicks[TEST_METHOD_ID]).toBeDefined();
    expect(store.getState().reviewComments).toHaveLength(1);

    await store.getState().submitReviewComments();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getState().reviewComments).toHaveLength(1);

    store.getState().toggleShowTests();
    expect(store.getState().reviewFiles.some((file) => file.path === testFile.path)).toBe(true);
    expect(store.getState().reviewUnitTicks[TEST_METHOD_ID]).toBeDefined();
    expect(store.getState().reviewComments[0]?.body).toBe("Keep this hidden test draft");
  });

  it("keeps an all-test review open as an empty workspace until Tests is turned on", async () => {
    const store = freshStoreForArtifact(REVIEW_WITH_TESTS_ARTIFACT);
    store.setState({
      viewMode: "prs",
      prSelected: 8,
      prsList: { open: [pr(8)], closed: null },
      prFiles: [
        { path: "src/a.test.ts", status: "modified", additions: 1, deletions: 0, hunks: [{ start: 5, end: 5 }] },
      ],
    });

    await store.getState().reviewPrInGraph();

    expect(store.getState().prReviewed).toBe(8);
    expect(store.getState().minimalSeedIds).toEqual([TEST_FILE_ID]);
    expect(store.getState().minimalMemberIds).toEqual([]);
    expect(store.getState().reviewFiles).toEqual([]);
    expect(store.getState().reviewAffectedIds).toEqual(new Set());
    store.getState().resetMinimalGraph();
    store.getState().rearrangeMinimalGraph();
    expect(store.getState().minimalMemberIds).toEqual([]);
    expect(store.getState().minimalArrange).toBe(false);
    store.getInitialState = store.getState;
    const hiddenPanel = renderToStaticMarkup(
      createElement(StoreProvider, { store, children: createElement(ReviewPanel) }),
    );
    expect(hiddenPanel).toContain("Test changes are excluded");
    expect(hiddenPanel).toContain("Open <strong>Review preferences</strong>");
    expect(hiddenPanel).toContain("turn off <strong>Exclude test changes</strong>");

    store.getState().toggleShowTests();

    expect(store.getState().minimalSeedIds).toEqual([TEST_FILE_ID]);
    expect(store.getState().minimalMemberIds).toEqual([TEST_FILE_ID]);
    expect(store.getState().reviewFiles.map((file) => file.path)).toEqual(["src/a.test.ts"]);
    expect(store.getState().reviewAffectedIds).toEqual(new Set([TEST_METHOD_ID]));
  });

  it("keeps added review comments local until Submit review performs the one POST", async () => {
    let submittedPath = "";
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/api/prs/review")) {
        return Promise.resolve(Response.json({ url: "https://github.com/o/r/pull/7#pullrequestreview-1" }));
      }
      if (url.includes("/api/prs/comments")) {
        return Promise.resolve(Response.json({
          comments: [{
            path: submittedPath,
            line: 1,
            side: "RIGHT",
            body: "Keep this in the review draft",
            author: "octo",
            updatedAt: "2026-07-12T00:00:00.000Z",
            url: "https://github.com/o/r/pull/7#discussion_r1",
          }],
          reviews: { approved: [], changesRequested: [], commented: 1 },
          hasMore: false,
        }));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();

    const path = store.getState().reviewFiles[0].path;
    submittedPath = path;
    store.getState().addReviewComment(path, null, "Keep this in the review draft");

    expect(store.getState().reviewComments).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();

    await store.getState().submitReviewComments();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/prs/review?id=artifact-1");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      number: 7,
      comments: [{ path, line: 1, body: "Keep this in the review draft" }],
      notes: [],
    });
    expect(fetchMock.mock.calls[1][0].toString()).toBe("http://meridian.local/api/prs/comments?id=artifact-1&n=7");
    expect(store.getState().reviewComments).toEqual([]);
    expect(store.getState().prDiscussion?.comments[0]?.body).toBe("Keep this in the review draft");
  });

  it("toggles existing canvas comments while keeping rail links and unsafe full-body fallbacks", async () => {
    const store = freshStore();
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();
    const path = store.getState().reviewFiles[0].path;
    const comments: PrGitHubComment[] = [
      {
        path,
        line: 1,
        side: "RIGHT",
        body: "Moved into the canvas code row",
        author: "octo",
        updatedAt: "2026-07-12T00:00:00.000Z",
        url: "https://github.com/o/r/pull/7#discussion_r1",
      },
      {
        path,
        line: 1,
        side: "LEFT",
        body: "Base-side fallback stays in the rail",
        author: "mina",
        updatedAt: "2026-07-12T00:01:00.000Z",
        url: "https://github.com/o/r/pull/7#discussion_r2",
      },
      {
        path,
        line: 999,
        side: "RIGHT",
        body: "Truncated-source comment body stays out of the rail",
        author: "zoe",
        updatedAt: "2026-07-12T00:02:00.000Z",
        url: "https://github.com/o/r/pull/7#discussion_r3",
      },
    ];
    const discussion = {
      comments,
      reviews: { approved: [], changesRequested: [], commented: 3 },
    };
    store.setState({ prDiscussion: discussion });
    const renderPanel = () => {
      const state = store.getState();
      Object.assign(store, { getInitialState: () => state });
      return renderToStaticMarkup(
        createElement(StoreProvider, { store, children: createElement(ReviewPanel) }),
      );
    };

    expect(store.getState().reviewCommentsVisible).toBe(true);
    const visible = renderPanel();
    expect(visible).toContain("3 existing comments");
    expect(visible).toMatch(/<button(?=[^>]*aria-pressed="true")[^>]*>Hide comments<\/button>/);
    expect(visible).not.toContain("Moved into the canvas code row");
    expect(visible).toContain("Base-side fallback stays in the rail");
    expect(visible).not.toContain("Truncated-source comment body stays out of the rail");
    expect(visible).toContain("https://github.com/o/r/pull/7#discussion_r1");
    expect(visible).toContain("https://github.com/o/r/pull/7#discussion_r3");

    store.getState().toggleReviewCommentsVisible();

    expect(store.getState().reviewCommentsVisible).toBe(false);
    expect(store.getState().prDiscussion).toBe(discussion);
    const hidden = renderPanel();
    expect(hidden).toContain("3 existing comments");
    expect(hidden).toMatch(/<button(?=[^>]*aria-pressed="false")[^>]*>View comments<\/button>/);
    expect(hidden).not.toContain("Moved into the canvas code row");
    expect(hidden).not.toContain("Base-side fallback stays in the rail");
    expect(hidden).not.toContain("Truncated-source comment body stays out of the rail");
    expect(hidden).not.toContain("https://github.com/o/r/pull/7#discussion_r1");
    expect(hidden).not.toContain("https://github.com/o/r/pull/7#discussion_r3");
  });

  it("does not submit review comments programmatically while the review is stale or refreshing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();
    store.getState().addReviewComment(store.getState().reviewFiles[0].path, null, "Wait for current contents");
    const drafts = store.getState().reviewComments;

    store.setState({ prReviewStale: true, prReviewRefreshing: false });
    await store.getState().submitReviewComments();
    store.setState({ prReviewStale: false, prReviewRefreshing: true });
    await store.getState().submitReviewComments();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getState().reviewComments).toBe(drafts);
    expect(store.getState().reviewSubmitStatus).toBe("idle");
  });

  it("does not refresh or duplicate-submit while a review POST is already in flight", async () => {
    let resolveSubmit!: (response: Response) => void;
    const submitResponse = new Promise<Response>((resolve) => {
      resolveSubmit = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      return url.includes("/api/prs/review")
        ? submitResponse
        : Promise.reject(new Error(`Unexpected request while submitting: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();
    store.getState().addReviewComment(store.getState().reviewFiles[0].path, null, "Submit once");

    const submit = store.getState().submitReviewComments();
    expect(store.getState().reviewSubmitStatus).toBe("submitting");
    store.getState().toggleShowTests();
    expect(store.getState().reviewSubmitStatus).toBe("submitting");
    await store.getState().submitReviewComments();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    store.setState({ prReviewStale: true });
    await Promise.all([
      store.getState().refreshPrReview(),
      store.getState().submitReviewComments(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/prs/review?id=artifact-1");
    expect(store.getState().prReviewRefreshing).toBe(false);
    expect(store.getState().reviewComments).toHaveLength(1);

    resolveSubmit(Response.json({ url: "https://github.com/o/r/pull/7#pullrequestreview-1" }));
    await submit;
    expect(store.getState().reviewSubmitStatus).toBe("idle");
    expect(store.getState().reviewComments).toEqual([]);
  });

  it("lets only the newest post-submit discussion refresh update the canvas comments", async () => {
    let resolveFirstDiscussion!: (response: Response) => void;
    const firstDiscussion = new Promise<Response>((resolve) => {
      resolveFirstDiscussion = resolve;
    });
    let discussionReads = 0;
    const discussionResponse = (body: string) => Response.json({
      comments: [{
        path: "repo/src/a.ts",
        line: 1,
        side: "RIGHT",
        body,
        author: "octo",
        updatedAt: "2026-07-12T00:00:00.000Z",
        url: `https://github.com/o/r/pull/7#${body}`,
      }],
      reviews: { approved: [], changesRequested: [], commented: 1 },
      hasMore: false,
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/api/prs/review")) {
        return Promise.resolve(Response.json({ url: "https://github.com/o/r/pull/7#review" }));
      }
      if (url.includes("/api/prs/comments")) {
        discussionReads += 1;
        return discussionReads === 1 ? firstDiscussion : Promise.resolve(discussionResponse("newer-comment"));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();
    const path = store.getState().reviewFiles[0].path;
    store.getState().addReviewComment(path, null, "first draft");

    const firstSubmit = store.getState().submitReviewComments();
    await vi.waitFor(() => expect(discussionReads).toBe(1));
    expect(store.getState().reviewSubmitStatus).toBe("idle");
    store.getState().addReviewComment(path, null, "second draft");
    await store.getState().submitReviewComments();
    expect(store.getState().prDiscussion?.comments[0]?.body).toBe("newer-comment");

    resolveFirstDiscussion(discussionResponse("older-comment"));
    await firstSubmit;

    expect(store.getState().prDiscussion?.comments[0]?.body).toBe("newer-comment");
    expect(fetchMock.mock.calls.filter(([input]) => input.toString().includes("/api/prs/review"))).toHaveLength(2);
    expect(discussionReads).toBe(2);
  });

  it("keeps the review fresh at the loaded head and marks it stale when that head changes", async () => {
    const loaded = { ...pr(7), headSha: "head-1" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ pr: { ...loaded, updatedAt: "2026-07-12T10:00:00.000Z" } }))
      .mockResolvedValueOnce(Response.json({ pr: { ...loaded, headSha: "head-2" } }));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    store.setState({ ...selectedPrState(7), prsList: { open: [loaded], closed: null } });
    await store.getState().reviewPrInGraph();

    await store.getState().checkPrReviewFreshness();
    expect(store.getState().prReviewStale).toBe(false);

    await store.getState().checkPrReviewFreshness();
    expect(store.getState().prReviewStale).toBe(true);
    expect(selectedPrSummary(store.getState())?.headSha).toBe("head-2");
    const staleRevision = store.getState().prReviewRevision;
    store.getState().toggleShowTests();
    expect(store.getState().prReviewStale).toBe(true);
    expect(store.getState().prReviewRevision).toBe(staleRevision);
    store.getState().addReviewComment(store.getState().reviewFiles[0].path, null, "Do not submit stale review contents");
    await store.getState().submitReviewComments();
    expect(fetchMock.mock.calls.map(([input]) => input.toString())).toEqual([
      "http://meridian.local/api/prs/one?id=artifact-1&n=7",
      "http://meridian.local/api/prs/one?id=artifact-1&n=7",
    ]);
  });

  it("ignores a late freshness response after the rendered review revision changes", async () => {
    let resolveFreshness!: (response: Response) => void;
    const freshnessResponse = new Promise<Response>((resolve) => {
      resolveFreshness = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(freshnessResponse);
    vi.stubGlobal("fetch", fetchMock);
    const loaded = { ...pr(7), headSha: "head-1" };
    const store = freshStore();
    store.setState({ ...selectedPrState(7), prsList: { open: [loaded], closed: null } });
    await store.getState().reviewPrInGraph();

    const freshness = store.getState().checkPrReviewFreshness();
    const replacementRevision = { ...store.getState().prReviewRevision!, headSha: "head-2" };
    store.setState({ prReviewRevision: replacementRevision, prReviewStale: false });
    resolveFreshness(Response.json({ pr: { ...loaded, headSha: "head-3" } }));
    await freshness;

    expect(store.getState().prReviewRevision).toBe(replacementRevision);
    expect(store.getState().prReviewStale).toBe(false);
    expect(selectedPrSummary(store.getState())?.headSha).toBe("head-1");
  });

  it("refreshes a stale synchronous review from GitHub while preserving its draft comments", async () => {
    const loaded = { ...pr(7), headSha: "head-1" };
    const latest = { ...loaded, headSha: "head-2", updatedAt: "2026-07-12T11:00:00.000Z" };
    const refreshedFiles = {
      files: [{ path: "repo/src/a.ts", status: "modified" as const, additions: 2, deletions: 1, hunks: [{ start: 10, end: 11 }] }],
      truncated: false,
      totalFiles: 1,
      outsideCount: 0,
      suggestedSubdir: "",
    };
    const discussion = {
      comments: [{ path: "repo/src/a.ts", line: 10, side: "RIGHT" as const, body: "Already on GitHub", author: "octo", updatedAt: latest.updatedAt, url: latest.url }],
      reviews: { approved: ["reviewer"], changesRequested: [], commented: 1 },
      hasMore: false,
    };
    const checks = { total: 2, passed: 1, failed: 0, pending: 1, url: `${latest.url}/checks` };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/api/prs/one")) return Promise.resolve(Response.json({ pr: latest }));
      if (url.includes("/api/prs/files")) return Promise.resolve(Response.json(refreshedFiles));
      if (url.includes("/api/prs/comments")) return Promise.resolve(Response.json(discussion));
      if (url.includes("/api/prs/checks")) return Promise.resolve(Response.json(checks));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    store.setState({ ...selectedPrState(7), prsList: { open: [loaded], closed: null } });
    await store.getState().reviewPrInGraph();
    const path = store.getState().reviewFiles[0].path;
    store.getState().addReviewComment(path, null, "Keep my local draft");
    const drafts = store.getState().reviewComments;
    store.setState({ prReviewStale: true });

    await store.getState().refreshPrReview();

    expect(fetchMock.mock.calls.map(([input]) => input.toString()).sort()).toEqual([
      "http://meridian.local/api/prs/checks?id=artifact-1&n=7&sha=head-2",
      "http://meridian.local/api/prs/comments?id=artifact-1&n=7",
      "http://meridian.local/api/prs/files?id=artifact-1&n=7",
      "http://meridian.local/api/prs/one?id=artifact-1&n=7",
    ].sort());
    expect(selectedPrSummary(store.getState())?.headSha).toBe("head-2");
    expect(store.getState().prFiles).toEqual(refreshedFiles.files);
    expect(store.getState().prDiscussion).toEqual({ comments: discussion.comments, reviews: discussion.reviews });
    expect(store.getState().prChecks).toEqual(checks);
    expect(store.getState().review?.context.changedFiles[0].hunks).toEqual([{ start: 10, end: 11 }]);
    expect(store.getState().reviewComments).toEqual(drafts);
    expect(store.getState().prReviewRevision?.headSha).toBe("head-2");
    expect(store.getState().prReviewStale).toBe(false);
    expect(store.getState().prReviewRefreshing).toBe(false);
  });

  it("keeps the prior file inputs resumable when a refreshed PR no longer matches the graph", async () => {
    const loaded = { ...pr(7), headSha: "head-1" };
    const latest = { ...loaded, headSha: "head-2", updatedAt: "2026-07-12T11:00:00.000Z" };
    const unmatchedFiles = {
      files: [{ path: "repo/src/removed-from-graph.ts", status: "modified" as const, additions: 2, deletions: 1 }],
      truncated: true,
      totalFiles: 4,
      outsideCount: 3,
      suggestedSubdir: "repo/src",
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/api/prs/one")) return Promise.resolve(Response.json({ pr: latest }));
      if (url.includes("/api/prs/files")) return Promise.resolve(Response.json(unmatchedFiles));
      if (url.includes("/api/prs/comments")) {
        return Promise.resolve(Response.json({ comments: [], reviews: { approved: [], changesRequested: [], commented: 0 }, hasMore: false }));
      }
      if (url.includes("/api/prs/checks")) {
        return Promise.resolve(Response.json({ total: 0, passed: 0, failed: 0, pending: 0, url: null }));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));
    const store = freshStore();
    store.setState({
      ...selectedPrState(7),
      prsList: { open: [loaded], closed: null },
      prFilesTruncated: false,
      prFilesTotal: 1,
      prFilesOutside: 0,
      prFilesSuggestedSubdir: "",
    });
    await store.getState().reviewPrInGraph();
    const priorFiles = store.getState().prFiles;
    const priorReview = store.getState().review;
    store.setState({ prReviewStale: true });

    await store.getState().refreshPrReview();

    expect(store.getState().review).toBe(priorReview);
    expect(store.getState().prFiles).toBe(priorFiles);
    expect(store.getState().prFilesTruncated).toBe(false);
    expect(store.getState().prFilesTotal).toBe(1);
    expect(store.getState().prFilesOutside).toBe(0);
    expect(store.getState().prFilesSuggestedSubdir).toBe("");
    expect(store.getState().prPrepareError).toBe("The refreshed pull request no longer matches this graph.");

    store.getState().closeMinimalGraph();
    store.getState().resumePrReview();

    expect(store.getState().minimalSeedIds).toEqual([FILE_ID]);
    expect(store.getState().review).not.toBeNull();
  });

  it("a close cancels a deferred synchronous refresh without repopulating its overlay or revision", async () => {
    let resolveFiles!: (response: Response) => void;
    const filesResponse = new Promise<Response>((resolve) => {
      resolveFiles = resolve;
    });
    const loaded = { ...pr(7), headSha: "head-1" };
    const latest = { ...loaded, headSha: "head-2", updatedAt: "2026-07-12T11:00:00.000Z" };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/api/prs/one")) return Promise.resolve(Response.json({ pr: latest }));
      if (url.includes("/api/prs/files")) return filesResponse;
      if (url.includes("/api/prs/comments")) {
        return Promise.resolve(Response.json({ comments: [], reviews: { approved: [], changesRequested: [], commented: 0 }, hasMore: false }));
      }
      if (url.includes("/api/prs/checks")) {
        return Promise.resolve(Response.json({ total: 0, passed: 0, failed: 0, pending: 0, url: null }));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    store.setState({ ...selectedPrState(7), prsList: { open: [loaded], closed: null } });
    await store.getState().reviewPrInGraph();
    const revision = store.getState().prReviewRevision;
    const review = store.getState().review;
    store.setState({ prReviewStale: true });

    const refresh = store.getState().refreshPrReview();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => input.toString().includes("/api/prs/files"))).toBe(true));
    store.getState().closeMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().prReviewRefreshing).toBe(false);

    resolveFiles(Response.json({
      files: [{ path: "repo/src/a.ts", status: "modified", additions: 2, deletions: 1, hunks: [{ start: 10, end: 11 }] }],
      truncated: false,
      totalFiles: 1,
      outsideCount: 0,
      suggestedSubdir: "",
    }));
    await refresh;

    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().minimalMemberIds).toEqual([]);
    expect(store.getState().prReviewRevision).toBe(revision);
    expect(store.getState().review).toBe(review);
    expect(store.getState().prReviewStale).toBe(true);
    expect(selectedPrSummary(store.getState())?.headSha).toBe("head-1");
  });

  it("renders the stale review refresh control and its disabled refreshing state", async () => {
    const store = freshStore();
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();
    store.getInitialState = store.getState;
    const renderPanel = () => renderToStaticMarkup(
      createElement(StoreProvider, { store, children: createElement(ReviewPanel) }),
    );

    store.setState({ prReviewStale: true });
    expect(renderPanel()).toContain("New changes · Refresh");

    store.setState({ prReviewRefreshing: true });
    const refreshing = renderPanel();
    expect(refreshing).toContain("Refreshing…");
    expect(refreshing).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*>Refreshing…<\/button>/);
  });

  it("pre-expands changed files to declaration level only: the class stays a collapsed card", () => {
    const store = freshStore();
    store.setState({
      viewMode: "prs",
      prSelected: 9,
      prsList: { open: [pr(9)], closed: null },
      // The hunk overlaps the METHOD's range (10-12), so the method is an affected code block.
      prFiles: [{ path: "src/a.ts", status: "modified", additions: 2, deletions: 0, hunks: [{ start: 10, end: 11 }] }],
    });
    store.getState().reviewPrInGraph();
    expect(store.getState().reviewAffectedIds.has(METHOD_ID)).toBe(true);
    // Leaf-level marking: the class must NOT self-mark off its whole-body span when only a method
    // body changed — its amber ring/count comes from upward aggregation, not from being "affected".
    expect(store.getState().reviewAffectedIds.has(CLASS_ID)).toBe(false);
    // Auto-expansion opens the package chain down to the file (deriveModuleTree only descends
    // into expanded packages, so the file card is invisible without them) and caps at the file:
    // its declarations show, but the class does not open into members and the method never charts
    // flow steps — deeper drilling stays a manual gesture.
    const expanded = store.getState().moduleExpanded;
    expect(expanded.has(PACKAGE_ID)).toBe(true);
    expect(expanded.has(FILE_ID)).toBe(true);
    expect(expanded.has(CLASS_ID)).toBe(false);
    expect(expanded.has(METHOD_ID)).toBe(false);
  });

  it("waits for the selected PR's files, then keeps a zero-match review on the PRs page", async () => {
    let resolveFiles!: (response: Response) => void;
    const filesResponse = new Promise<Response>((resolve) => {
      resolveFiles = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/api/prs/files")) {
        return filesResponse;
      }
      if (url.includes("/api/prs/comments")) {
        return Promise.resolve(Response.json({ comments: [], reviews: { approved: [], changesRequested: [], commented: 0 }, hasMore: false }));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    store.setState({
      viewMode: "prs",
      prsList: { open: [pr(7)], closed: null },
    });
    const selection = store.getState().selectPr(7);
    const review = store.getState().reviewPrInGraph();
    expect(fetchMock.mock.calls.filter(([input]) => input.toString().includes("/api/prs/files"))).toHaveLength(1);
    resolveFiles(Response.json({
      files: [{ path: "docs/readme.md", status: "modified", additions: 1, deletions: 0 }],
      truncated: false,
      totalFiles: 1,
      outsideCount: 0,
      suggestedSubdir: "",
    }));
    await Promise.all([selection, review]);

    expect(store.getState().viewMode).toBe("prs");
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().reviewAllSeedIds).toEqual([]);
    expect(store.getState().prReviewBlocked).toEqual({
      number: 7,
      reason: "None of this PR's 1 changed files match this session's graph",
    });
  });

  it("keeps Resume review available on the PR page even when cached seeds were cleared", async () => {
    const store = freshStore();
    store.setState({
      viewMode: "prs",
      prsList: { open: [pr(7)], closed: null },
      prSelected: 7,
      prFiles: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
    });
    await store.getState().reviewPrOnBaseGraph();
    expect(store.getState().minimalSeedIds).toEqual([FILE_ID]);
    store.getState().closeMinimalGraph();
    store.setState({ reviewAllSeedIds: [] });
    store.getInitialState = store.getState;
    const renderSection = () => renderToStaticMarkup(
      createElement(StoreProvider, { store, children: createElement(PrReviewSection) }),
    );

    const parked = renderSection();
    expect(parked).toContain("PR review");
    expect(parked).toContain("1 open");
    expect(parked).toContain("Resume review #7");

    await store.getState().resumePrReview();
    expect(store.getState().minimalSeedIds).toEqual([FILE_ID]);
  });

  it("renders the Resume chip only for a saved review payload and never replaces the queue row", () => {
    const store = freshStore();
    store.setState({
      viewMode: "modules",
      prsList: { open: [pr(7)], closed: null },
      prReviewed: 7,
      minimalSeedIds: [],
      reviewAllSeedIds: [],
    });
    store.getInitialState = store.getState;
    const renderSection = () => renderToStaticMarkup(
      createElement(StoreProvider, { store, children: createElement(PrReviewSection) }),
    );

    const withoutSeeds = renderSection();
    expect(withoutSeeds).toContain("PR review");
    expect(withoutSeeds).toContain("1 open");
    expect(withoutSeeds).not.toContain("Resume review #7");

    const files = [{ path: "src/a.ts", status: "modified" as const, additions: 1, deletions: 0 }];
    store.setState({
      viewMode: "prs",
      review: {
        context: {
          changedFiles: files,
          baseRef: "main",
          baseSha: null,
          headRef: "feature",
          reviewKey: "pr#7",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
      prReviewSource: {
        number: 7,
        files,
        truncated: false,
        total: 1,
        outside: 0,
        suggestedSubdir: "",
      },
    });
    const withSeeds = renderSection();
    expect(withSeeds).toContain("PR review");
    expect(withSeeds).toContain("1 open");
    expect(withSeeds).toContain("Resume review #7");

    store.setState({ prReviewStatus: "preparing" });
    expect(renderSection()).toContain("Resuming review #7");
    store.setState({ prReviewStatus: "error", prPrepareError: "graph expired" });
    const failedResume = renderSection();
    expect(failedResume).toContain("Retry review #7");
    expect(failedResume).toContain("graph expired");
  });

  it("togglePrsView opens the PR page, then a second toggle returns to the Map", () => {
    const store = freshStore();
    // A non-empty module layout means the return skips a re-layout (nothing async to await here).
    store.setState({ viewMode: "modules", prsList: { open: [], closed: null }, moduleRfNodes: [{ id: "x", position: { x: 0, y: 0 }, data: {} }] });
    store.getState().togglePrsView();
    expect(store.getState().viewMode).toBe("prs");
    store.getState().togglePrsView();
    expect(store.getState().viewMode).toBe("modules");
  });

  it("togglePrsView resumes the exact lens it was opened from", () => {
    const store = freshStore();
    store.setState({ viewMode: "logic", prsList: { open: [], closed: null } });
    store.getState().togglePrsView();
    expect(store.getState().viewMode).toBe("prs");
    store.getState().togglePrsView();
    expect(store.getState().viewMode).toBe("logic");
  });

  it("loads an isolated hover preview without replacing the open code modal", async () => {
    vi.stubGlobal("window", { location: { origin: "http://meridian.local" } });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: "line10\nline11\nline12", startLine: 10, truncated: false }));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore({ sourceUrl: "/api/source?id=artifact-1" });
    const method = store.getState().index.nodesById.get(METHOD_ID)!;
    const openModal = { node: method, code: "already open", loading: false, error: null, mode: "modal" as const };
    store.setState({ codeView: openModal });

    const preview = await store.getState().loadCodePreview(method);

    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://meridian.local/api/source?id=artifact-1&file=src%2Fa.ts&start=10&end=12");
    expect(preview?.code).toBe("line10\nline11\nline12");
    expect(preview?.baseLine).toBe(10);
    expect(store.getState().codeView).toBe(openModal);
  });

  it("does not issue a source request for a package directory", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore({ sourceUrl: "/api/source?id=artifact-1" });
    const packageNode = store.getState().index.nodesById.get(PACKAGE_ID)!;

    expect(await store.getState().loadCodePreview(packageNode)).toBeNull();
    await store.getState().showCode(packageNode);
    expect(store.getState().codeView).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a changed file from the PR head even when GitHub omitted its patch", async () => {
    vi.stubGlobal("window", { location: { origin: "http://meridian.local" } });
    const fullCode = Array.from({ length: 20 }, (_value, index) => `line${index + 1}`).join("\n");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: fullCode, truncated: false }));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore({ sourceUrl: "/api/source?id=artifact-1", prFileUrl: "/api/prs/file?id=artifact-1" });
    store.setState({
      prReviewed: 7,
      reviewHeadRef: "feature",
      reviewFileDelta: { "src/a.ts": { added: 100, deleted: 20 } },
      reviewDiffByFile: {}, // binary/oversized patches carry no edits or line kinds
    });
    const method = store.getState().index.nodesById.get(METHOD_ID)!;

    const preview = await store.getState().loadCodePreview(method);

    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://meridian.local/api/prs/file?id=artifact-1&path=src%2Fa.ts&ref=feature");
    expect(preview?.code).toBe("line10\nline11\nline12");
  });

  it("reads a removed file from base source because it no longer exists at PR head", async () => {
    vi.stubGlobal("window", { location: { origin: "http://meridian.local" } });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: "old10\nold11\nold12", startLine: 10, truncated: false }));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore({ sourceUrl: "/api/source?id=artifact-1", prFileUrl: "/api/prs/file?id=artifact-1" });
    store.setState({
      prReviewed: 7,
      reviewHeadRef: "feature",
      reviewFileDelta: { "src/a.ts": { added: 0, deleted: 20, status: "removed" } },
      reviewDiffByFile: {
        "src/a.ts": {
          edits: [{ oldStart: 1, oldLines: 20, newStart: 0, newLines: 0 }],
          kinds: [{ start: 1, end: 20, kind: "deleted" }],
        },
      },
    });
    const method = store.getState().index.nodesById.get(METHOD_ID)!;

    const preview = await store.getState().loadCodePreview(method);

    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://meridian.local/api/source?id=artifact-1&file=src%2Fa.ts&start=10&end=12");
    expect(preview?.code).toBe("old10\nold11\nold12");
    expect(preview?.baseLine).toBe(10);
    expect([...preview!.changedLineKinds!.entries()]).toEqual([[10, "deleted"], [11, "deleted"], [12, "deleted"]]);
  });

  it("shares one PR-head file response across previews for nodes in that file", async () => {
    vi.stubGlobal("window", { location: { origin: "http://meridian.local" } });
    const fullCode = Array.from({ length: 20 }, (_value, index) => `line${index + 1}`).join("\n");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: fullCode, truncated: false }));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore({ prFileUrl: "/api/prs/file?id=artifact-1" });
    store.setState({
      prReviewed: 7,
      reviewHeadRef: "feature",
      reviewFileDelta: { "src/a.ts": { added: 2, deleted: 0 } },
    });
    const method = store.getState().index.nodesById.get(METHOD_ID)!;
    const service = store.getState().index.nodesById.get(CLASS_ID)!;

    const [methodPreview, servicePreview] = await Promise.all([
      store.getState().loadCodePreview(method),
      store.getState().loadCodePreview(service),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(methodPreview?.code).toBe("line10\nline11\nline12");
    expect(servicePreview?.code).toBe(Array.from({ length: 18 }, (_value, index) => `line${index + 3}`).join("\n"));
  });
});

/** Store deps of a GitHub `web` session, where the server can prepare the PR head. */
const ANALYZE_DEPS: Partial<StoreDependencies> = {
  analyzeUrl: "/api/pr/analyze",
  graphId: "artifact-1",
  graphUrl: "/api/graph?id=artifact-1",
};

/**
 * The PR-HEAD-shaped sibling of ARTIFACT: same node ids, but the method MOVED to lines 20-22 (the
 * head branch's coordinates), and the extract pipeline's `changedSince` stamp already on it — the
 * shape `/api/pr/analyze` stores and `/api/graph?id=pr-…` serves back.
 */
const HEAD_ARTIFACT: GraphArtifact = {
  ...ARTIFACT,
  generatedAt: "2026-07-09T00:00:00.000Z",
  nodes: [
    node(PACKAGE_ID, "package", "src"),
    node(FILE_ID, "module", "src/a.ts", PACKAGE_ID),
    node(CLASS_ID, "class", "src/a.ts", FILE_ID, { start: 3, end: 30 }),
    node(METHOD_ID, "method", "src/a.ts", CLASS_ID, { start: 20, end: 22 }),
  ],
  extensions: {
    changedSince: {
      baseRef: "origin/main",
      files: { "src/a.ts": [{ start: 20, end: 21 }] },
      kinds: { "src/a.ts": [{ start: 20, end: 21, kind: "modified" }] },
    },
  } as GraphArtifact["extensions"],
};

const REFRESHED_HEAD_SHA = "def5678abc1234000000";
const REFRESHED_GRAPH_ID = "pr-head-2";
const REFRESHED_SUMMARY: PrSummary = {
  ...pr(7),
  headSha: REFRESHED_HEAD_SHA,
  updatedAt: "2026-07-12T12:00:00.000Z",
};
const REFRESHED_FILES = {
  files: [{ path: "src/a.ts", status: "modified" as const, additions: 2, deletions: 1, hunks: [{ start: 31, end: 31 }] }],
  truncated: false,
  totalFiles: 1,
  outsideCount: 0,
  suggestedSubdir: "",
};
const REFRESHED_HEAD_ARTIFACT: GraphArtifact = {
  ...HEAD_ARTIFACT,
  generatedAt: "2026-07-12T12:00:00.000Z",
  nodes: [
    node(PACKAGE_ID, "package", "src"),
    node(FILE_ID, "module", "src/a.ts", PACKAGE_ID),
    node(CLASS_ID, "class", "src/a.ts", FILE_ID, { start: 3, end: 40 }),
    node(METHOD_ID, "method", "src/a.ts", CLASS_ID, { start: 30, end: 32 }),
  ],
  extensions: {
    changedSince: {
      baseRef: "origin/main",
      files: { "src/a.ts": [{ start: 31, end: 31 }] },
      kinds: { "src/a.ts": [{ start: 31, end: 31, kind: "modified" }] },
    },
  } as GraphArtifact["extensions"],
};

/** A fetch stub routing the three endpoints a head extraction hits; `graph` overrides the GET. */
function routedFetch(options?: { graphId?: string; graph?: () => Promise<Response> }) {
  const graphId = options?.graphId ?? "pr-head-1";
  return vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("/api/pr/analyze")) {
      return Promise.resolve(
        ndjsonResponse([{ stage: "clone" }, { stage: "checkout" }, { stage: "extract" }, { stage: "done", graphId, headSha: "abc1234def5678900000" }]),
      );
    }
    if (url.includes("/api/graph")) {
      return options?.graph ? options.graph() : Promise.resolve(Response.json(HEAD_ARTIFACT));
    }
    return Promise.resolve(Response.json({ files: [], truncated: false }));
  });
}

/** Route an in-place refresh of an already prepared review, optionally failing before graph fetch. */
function preparedRefreshFetch(options: { analyzeError?: string } = {}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/api/prs/one")) {
      return Promise.resolve(Response.json({ pr: REFRESHED_SUMMARY }));
    }
    if (url.includes("/api/prs/files")) {
      return Promise.resolve(Response.json(REFRESHED_FILES));
    }
    if (url.includes("/api/prs/comments")) {
      return Promise.resolve(Response.json({ comments: [], reviews: { approved: [], changesRequested: [], commented: 0 }, hasMore: false }));
    }
    if (url.includes("/api/prs/checks")) {
      return Promise.resolve(Response.json({ total: 1, passed: 1, failed: 0, pending: 0, url: null }));
    }
    if (url.includes("/api/pr/analyze")) {
      return Promise.resolve(options.analyzeError
        ? ndjsonResponse([{ stage: "clone" }, { stage: "error", message: options.analyzeError }])
        : ndjsonResponse([{ stage: "clone" }, { stage: "checkout" }, { stage: "extract" }, { stage: "done", graphId: REFRESHED_GRAPH_ID, headSha: REFRESHED_HEAD_SHA }]));
    }
    if (url.includes("/api/graph")) {
      return Promise.resolve(Response.json(REFRESHED_HEAD_ARTIFACT));
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  });
}

/** One NDJSON Response streaming the given lines (single chunk — boundary cases live in prAnalysis.test). */
function ndjsonResponse(lines: readonly object[]): Response {
  const body = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function selectedPrState(number: number) {
  return {
    viewMode: "prs" as const,
    prSelected: number,
    prsList: { open: [pr(number)], closed: null },
    prFiles: [{ path: "repo/src/a.ts", status: "modified" as const, additions: 1, deletions: 0, hunks: [{ start: 1, end: 1 }] }],
  };
}

/** A selected PR whose hunk (line 21) only exists in HEAD coordinates: it overlaps the method at
 * its head position (20-22) but NOTHING in the boot artifact (method 10-12, class 3-20). */
function headSelectedPrState(number: number) {
  return {
    viewMode: "prs" as const,
    prSelected: number,
    prsList: { open: [pr(number)], closed: null },
    prFiles: [{ path: "src/a.ts", status: "modified" as const, additions: 1, deletions: 0, hunks: [{ start: 21, end: 21 }] }],
  };
}

/** Complete prepare-first entry; returns the swapped store plus the boot pair for restore asserts. */
async function swappedReviewStore() {
  const fetchMock = routedFetch();
  vi.stubGlobal("fetch", fetchMock);
  const store = freshStore({
    ...ANALYZE_DEPS,
    sourceUrl: "/api/source?id=artifact-1",
    prFileUrl: "/api/prs/file?id=artifact-1",
  });
  const bootIndex = store.getState().index;
  store.setState(headSelectedPrState(7));
  await store.getState().reviewPrInGraph();
  return { store, bootIndex, fetchMock };
}

describe("PR head preparation (prepareHeadGraph)", () => {
  it("keeps the PRs view until the stream and prepared-graph swap complete", async () => {
    const encoder = new TextEncoder();
    let finishAnalyze!: () => void;
    const analyzeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"stage":"clone"}\n'));
        finishAnalyze = () => {
          controller.enqueue(encoder.encode('{"stage":"done","graphId":"pr-gated","headSha":"abc1234"}\n'));
          controller.close();
        };
      },
    });
    let releaseGraph!: (response: Response) => void;
    const graphResponse = new Promise<Response>((resolve) => {
      releaseGraph = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => input.toString().includes("/api/pr/analyze")
      ? Promise.resolve(new Response(analyzeStream, { status: 200 }))
      : graphResponse);
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore(ANALYZE_DEPS);
    store.setState(selectedPrState(7));

    const review = store.getState().reviewPrInGraph();
    // The base graph is not an intermediate review while the stream is open.
    expect(store.getState().viewMode).toBe("prs");
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().review).toBe(null);
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().prReviewStatus).toBe("preparing");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://meridian.local/api/pr/analyze");
    expect(store.getState().prPreparedGraphId).toBe(null);
    expect(store.getState().prReviewBaseline).toBe(null);

    finishAnalyze();
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => call[0].toString().includes("/api/graph"))).toBe(true);
    });
    // Even a completed stream cannot enter the Map before the commit-pinned artifact arrives.
    expect(store.getState().viewMode).toBe("prs");
    expect(store.getState().prReviewed).toBe(null);

    releaseGraph(Response.json(HEAD_ARTIFACT));
    await review;
    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts"]);
    expect(store.getState().artifact.generatedAt).toBe(HEAD_ARTIFACT.generatedAt);
    expect(store.getState().prPreparedGraphId).toBe("pr-gated");
  });

  it("walks clone→checkout→extract, stores the prepared graph id + head sha, and re-lands the review's post-conditions", async () => {
    const fetchMock = routedFetch({ graphId: "pr-deadbeef" });
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore(ANALYZE_DEPS);
    store.setState(selectedPrState(7));
    const stages: (string | null)[] = [];
    store.subscribe((state) => {
      if (stages[stages.length - 1] !== state.prPrepareStage) {
        stages.push(state.prPrepareStage);
      }
    });
    await store.getState().reviewPrInGraph();
    expect(stages).toEqual(["clone", "checkout", "extract", null]);
    expect(store.getState().prReviewStatus).toBe("idle");
    expect(store.getState().prPrepareError).toBe(null);
    expect(store.getState().prPreparedGraphId).toBe("pr-deadbeef");
    expect(store.getState().prPreparedHeadSha).toBe("abc1234def5678900000");
    expect(store.getState().prPreparedArtifactCurrent).toBe(true);
    // The analyze POST carries the contract body before any review state is applied.
    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://meridian.local/api/pr/analyze");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ id: "artifact-1", prNumber: 7, baseRef: "main", headRef: "feature" });
    // After the stream, the first review application runs against the swapped prepared artifact.
    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts"]);
  });

  it("evaluates the zero-match guard against the prepared graph", async () => {
    const unmatchedHead: GraphArtifact = {
      ...HEAD_ARTIFACT,
      nodes: [
        node("ts:other", "package", "other"),
        node("ts:other/b.ts", "module", "other/b.ts", "ts:other"),
      ],
    };
    const fetchMock = routedFetch({ graph: () => Promise.resolve(Response.json(unmatchedHead)) });
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore(ANALYZE_DEPS);
    const bootIndex = store.getState().index;
    store.setState(selectedPrState(7));

    await store.getState().reviewPrInGraph();

    expect(store.getState().viewMode).toBe("prs");
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().review).toBe(null);
    expect(store.getState().prReviewBlocked).toEqual({
      number: 7,
      reason: "None of this PR's 1 changed files match this session's graph",
    });
    // The HEAD graph was used for the decision, then the unreviewed swap was put away.
    expect(store.getState().index).toBe(bootIndex);
    expect(store.getState().prPreparedGraphId).toBe(null);
    expect(store.getState().prReviewBaseline).toBe(null);
  });

  it("a second review while preparation is in flight does not start a duplicate", async () => {
    const encoder = new TextEncoder();
    let releaseFirst!: () => void;
    const firstStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"stage":"clone"}\n'));
        releaseFirst = () => {
          controller.enqueue(encoder.encode('{"stage":"done","graphId":"pr-first"}\n'));
          controller.close();
        };
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(firstStream, { status: 200 }))
      .mockResolvedValue(Response.json(HEAD_ARTIFACT));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore(ANALYZE_DEPS);
    store.setState(selectedPrState(7));
    const firstReview = store.getState().reviewPrInGraph();
    const secondReview = store.getState().reviewPrInGraph();
    let secondSettled = false;
    void secondReview.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(fetchMock.mock.calls.filter(([input]) => input.toString().includes("/api/pr/analyze"))).toHaveLength(1);
    expect(secondSettled).toBe(false);
    expect(store.getState().prReviewStatus).toBe("preparing");
    expect(store.getState().viewMode).toBe("prs");
    releaseFirst();
    await Promise.all([firstReview, secondReview]);
    // The one in-flight run is the only entry and lands after its swap.
    expect(store.getState().prPreparedGraphId).toBe("pr-first");
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().prPreparedArtifactCurrent).toBe(true);
    expect(store.getState().prReviewStatus).toBe("idle");
    expect(store.getState().prPrepareStage).toBe(null);
  });

  it("a failed prepare keeps the PRs view with an error and no review state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([{ stage: "clone" }, { stage: "error", message: "clone failed" }])));
    const store = freshStore(ANALYZE_DEPS);
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();
    expect(store.getState().prReviewStatus).toBe("error");
    expect(store.getState().prPrepareError).toBe("clone failed");
    expect(store.getState().prPrepareStage).toBe(null);
    expect(store.getState().viewMode).toBe("prs");
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().review).toBe(null);
    expect(store.getState().reviewFiles).toEqual([]);
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().prPreparedGraphId).toBe(null);
    expect(store.getState().prReviewBaseline).toBe(null);
  });

  it("reviewPrOnBaseGraph enters a synchronous review after prepare failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([{ stage: "error", message: "fetch failed" }])));
    const store = freshStore(ANALYZE_DEPS);
    const bootIndex = store.getState().index;
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();

    await store.getState().reviewPrOnBaseGraph();

    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts"]);
    expect(store.getState().index).toBe(bootIndex);
    expect(store.getState().prPreparedArtifactCurrent).toBe(false);
    expect(store.getState().reviewHeadRef).toBe("feature");
  });

  it("cancel bumps the prepare sequence and abandons entry", async () => {
    const encoder = new TextEncoder();
    let finishAnalyze!: () => void;
    const analyzeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"stage":"clone"}\n'));
        finishAnalyze = () => {
          controller.enqueue(encoder.encode('{"stage":"done","graphId":"pr-canceled"}\n'));
          controller.close();
        };
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(analyzeStream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore(ANALYZE_DEPS);
    store.setState(selectedPrState(7));
    const review = store.getState().reviewPrInGraph();

    expect(store.getState().prReviewStatus).toBe("preparing");
    store.getState().cancelPrReviewPreparation();
    expect(store.getState().prReviewStatus).toBe("idle");
    expect(store.getState().prPrepareStage).toBe(null);
    expect(store.getState().viewMode).toBe("prs");
    await review; // cancellation settles the blocking entry; the server stream is still open.

    finishAnalyze();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.filter(([input]) => input.toString().includes("/api/graph"))).toHaveLength(0);
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().review).toBe(null);
    expect(store.getState().prPreparedGraphId).toBe(null);
    expect(store.getState().artifact.generatedAt).toBe(ARTIFACT.generatedAt);
  });

  it("leaving the PRs view abandons an in-flight entry", async () => {
    const encoder = new TextEncoder();
    let finishAnalyze!: () => void;
    const analyzeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"stage":"clone"}\n'));
        finishAnalyze = () => {
          controller.enqueue(encoder.encode('{"stage":"done","graphId":"pr-left"}\n'));
          controller.close();
        };
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(analyzeStream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore(ANALYZE_DEPS);
    store.setState(selectedPrState(7));
    const review = store.getState().reviewPrInGraph();

    // Direct lens pivots bypass setViewMode but share beginLensTransition's cancellation guard.
    store.getState().openComposition(CLASS_ID);
    expect(store.getState().prReviewStatus).toBe("idle");
    await review; // leaving the waiting surface settles entry without waiting on server work.
    finishAnalyze();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getState().viewMode).toBe("call");
    expect(store.getState().prReviewed).toBe(null);
    expect(fetchMock.mock.calls.filter(([input]) => input.toString().includes("/api/graph"))).toHaveLength(0);
  });

  it("without an analyzeUrl the review stays synchronous and never fetches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    const bootIndex = store.getState().index;
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();
    // prepareHeadGraph is inert too — its precondition (an analyze endpoint) is missing.
    await store.getState().prepareHeadGraph();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getState().prReviewStatus).toBe("idle");
    expect(store.getState().prPreparedGraphId).toBe(null);
    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts"]);
    // No swap, no baseline: the review computed against the loaded artifact's own coordinates.
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().index).toBe(bootIndex);
    expect(store.getState().index.nodesById.get(METHOD_ID)?.location.startLine).toBe(10);
  });

  it("a graph fetch landing after a PR switch does not swap", async () => {
    let releaseGraph!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      releaseGraph = resolve;
    });
    const fetchMock = routedFetch({ graph: () => gate });
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore(ANALYZE_DEPS);
    store.setState(headSelectedPrState(7));
    const review = store.getState().reviewPrInGraph();
    // The stream has finished (done landed) and the artifact GET is in flight...
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => call[0].toString().includes("/api/graph"))).toBe(true);
    });
    // ...when the reader switches PRs; the artifact landing later must not swap anything in.
    await store.getState().selectPr(8);
    await review;
    releaseGraph(Response.json(HEAD_ARTIFACT));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Still the untouched boot graph in base coordinates.
    expect(store.getState().artifact.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(store.getState().index.nodesById.get(METHOD_ID)?.location.startLine).toBe(10);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().prPreparedGraphId).toBe(null);
  });

  it("switching PRs abandons an in-flight preparation", async () => {
    const encoder = new TextEncoder();
    let releaseAnalyze!: () => void;
    const analyzeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"stage":"clone"}\n'));
        releaseAnalyze = () => {
          controller.enqueue(encoder.encode('{"stage":"done","graphId":"pr-stale"}\n'));
          controller.close();
        };
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(analyzeStream, { status: 200 }))
      .mockResolvedValue(Response.json({ files: [], truncated: false }));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore(ANALYZE_DEPS);
    store.setState(selectedPrState(7));
    const review = store.getState().reviewPrInGraph();
    expect(store.getState().prReviewStatus).toBe("preparing");
    expect(fetchMock.mock.calls.filter(([input]) => input.toString().includes("/api/pr/analyze"))).toHaveLength(1);
    const select = store.getState().selectPr(8);
    await review;
    releaseAnalyze();
    await Promise.all([select, new Promise((resolve) => setTimeout(resolve, 0))]);
    // The indicator reset with the switch, and the stale stream landed on nothing: no swap.
    expect(store.getState().prReviewStatus).toBe("idle");
    expect(store.getState().prPreparedGraphId).toBe(null);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().artifact.generatedAt).toBe(ARTIFACT.generatedAt);
  });
});

describe("PR review artifact swap and restore", () => {
  it("drops source ghost inspection on both prepared swap and soft baseline restore", () => {
    const store = freshStore();
    const inspection = {
      anchorIds: new Set([CLASS_ID]),
      visitedIds: new Set([METHOD_ID]),
    };
    const invalidateArtifactCaches = vi.fn();
    store.setState({ moduleGhostInspection: inspection });

    swapToPreparedArtifact(store.getState, store.setState, HEAD_ARTIFACT, invalidateArtifactCaches);

    expect(store.getState().moduleGhostInspection).toBeNull();
    store.setState({ moduleGhostInspection: inspection });

    expect(restorePrReviewBaseline(
      store.getState,
      store.setState,
      invalidateArtifactCaches,
      { endSession: false },
    )).toBe(true);
    expect(store.getState().moduleGhostInspection).toBeNull();
  });

  it("swaps in the prepared artifact and reviews in HEAD coordinates, saving the boot pair once", async () => {
    const { store, bootIndex, fetchMock } = await swappedReviewStore();
    // The prepared artifact was fetched from the boot graph endpoint with the id exchanged.
    const graphCall = fetchMock.mock.calls.find((call) => call[0].toString().includes("/api/graph"));
    expect(graphCall?.[0].toString()).toBe("http://meridian.local/api/graph?id=pr-head-1");
    // The CURRENT graph is the head artifact/index, not the boot one.
    expect(store.getState().artifact.generatedAt).toBe(HEAD_ARTIFACT.generatedAt);
    expect(store.getState().index.nodesById.get(METHOD_ID)?.location.startLine).toBe(20);
    // The hunk (line 21) marks the method ONLY at its head position — with the boot coordinates
    // (method 10-12, class 3-20) it overlaps nothing, so this proves the review re-ran post-swap.
    expect(store.getState().reviewAffectedIds).toEqual(new Set([METHOD_ID]));
    expect(store.getState().index.changedIds.has(METHOD_ID)).toBe(true);
    // The boot pair was saved for the session-end restore and never received HEAD marking: the
    // first review application happened only after the prepared artifact became current.
    expect(store.getState().prReviewBaseline?.artifact.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(store.getState().prReviewBaseline?.index).toBe(bootIndex);
    expect(bootIndex.changedIds.has(METHOD_ID)).toBe(false);
    // The line-diff channel keeps the artifact's own extract-pipeline stamp (origin/<base>), not
    // the client-side GitHub-hunk join (which would have restamped it as "pr#7").
    const changedSince = (store.getState().artifact.extensions as { changedSince?: { baseRef?: string } }).changedSince;
    expect(changedSince?.baseRef).toBe("origin/main");
    expect(store.getState().prPreparedGraphId).toBe("pr-head-1");
    expect(store.getState().prPreparedHeadSha).toBe("abc1234def5678900000");
    expect(store.getState().prPreparedArtifactCurrent).toBe(true);
    expect(store.getState().prReviewed).toBe(7);
    // Head-mode guards: node locations are already head-relative, so the #134 base→head remap
    // machinery must be disarmed — showCode reads the prepared checkout via /api/source instead.
    expect(store.getState().reviewHeadRef).toBe(null);
    expect(store.getState().reviewDiffByFile).toEqual({});
  });

  it("refreshes a stale prepared review onto the new analyzed head without losing drafts", async () => {
    const { store, bootIndex } = await swappedReviewStore();
    const previousArtifact = store.getState().artifact;
    const path = store.getState().reviewFiles[0].path;
    store.getState().addReviewComment(path, null, "Carry this draft to the new head");
    // L31 exists in both revisions and remains inside the refreshed hunk context. The numeric
    // coincidence must not let an old-revision draft silently attach to different new code.
    store.getState().addReviewComment(path, null, "Keep this old line safely", 31);
    const drafts = store.getState().reviewComments;
    store.setState({ prReviewStale: true });
    const fetchMock = preparedRefreshFetch();
    vi.stubGlobal("fetch", fetchMock);

    await store.getState().refreshPrReview();

    expect(store.getState().artifact).not.toBe(previousArtifact);
    expect(store.getState().artifact.generatedAt).toBe(REFRESHED_HEAD_ARTIFACT.generatedAt);
    expect(store.getState().index.nodesById.get(METHOD_ID)?.location.startLine).toBe(30);
    expect(store.getState().prPreparedGraphId).toBe(REFRESHED_GRAPH_ID);
    expect(store.getState().prPreparedHeadSha).toBe(REFRESHED_HEAD_SHA);
    expect(store.getState().prPreparedArtifactCurrent).toBe(true);
    expect(store.getState().prReviewRevision?.headSha).toBe(REFRESHED_HEAD_SHA);
    expect(store.getState().prReviewStale).toBe(false);
    expect(store.getState().prReviewRefreshing).toBe(false);
    expect(store.getState().reviewComments[0]).toEqual(drafts[0]);
    expect(store.getState().reviewComments[1]).toEqual({ ...drafts[1], lineStale: true });
    expect(store.getState().review?.context.changedFiles[0].hunks).toEqual([{ start: 31, end: 31 }]);
    expect(selectedPrSummary(store.getState())?.headSha).toBe(REFRESHED_HEAD_SHA);
    // Replacing one prepared head must retain the original boot graph as the session restore target.
    expect(store.getState().prReviewBaseline?.artifact.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(store.getState().prReviewBaseline?.index).toBe(bootIndex);
    expect(fetchMock.mock.calls.some(([input]) => input.toString().includes(`/api/graph?id=${REFRESHED_GRAPH_ID}`))).toBe(true);
  });

  it("disarms a persisted line draft when a new session opens on a later head", async () => {
    stubReviewStorage();
    const { store: firstSession } = await swappedReviewStore();
    const path = firstSession.getState().reviewFiles[0].path;
    firstSession.getState().addReviewComment(path, null, "Drafted on the old head", 31);
    const oldDraft = firstSession.getState().reviewComments[0];
    expect(oldDraft.lineRevision).toContain("abc1234def5678900000");

    const reloaded = freshStore(ANALYZE_DEPS);
    reloaded.setState({
      viewMode: "prs",
      prSelected: 7,
      prsList: { open: [REFRESHED_SUMMARY], closed: null },
      prFiles: REFRESHED_FILES.files,
      prFilesTotal: REFRESHED_FILES.totalFiles,
      prFilesOutside: REFRESHED_FILES.outsideCount,
      prFilesSuggestedSubdir: REFRESHED_FILES.suggestedSubdir,
    });
    vi.stubGlobal("fetch", preparedRefreshFetch());

    await reloaded.getState().reviewPrInGraph();

    expect(reloaded.getState().prReviewRevision?.headSha).toBe(REFRESHED_HEAD_SHA);
    expect(reloaded.getState().reviewComments).toEqual([{ ...oldDraft, lineStale: true }]);
  });

  it("keeps the prior prepared review visible when refresh analysis fails before a swap", async () => {
    const { store } = await swappedReviewStore();
    const path = store.getState().reviewFiles[0].path;
    store.getState().addReviewComment(path, null, "Do not lose this draft on refresh failure", 31);
    const before = store.getState();
    store.setState({ prReviewStale: true });
    const fetchMock = preparedRefreshFetch({ analyzeError: "refresh clone failed" });
    vi.stubGlobal("fetch", fetchMock);

    await store.getState().refreshPrReview();

    expect(store.getState().artifact).toBe(before.artifact);
    expect(store.getState().index).toBe(before.index);
    expect(store.getState().prPreparedGraphId).toBe(before.prPreparedGraphId);
    expect(store.getState().prPreparedHeadSha).toBe(before.prPreparedHeadSha);
    expect(store.getState().prPreparedArtifactCurrent).toBe(true);
    expect(store.getState().review).toBe(before.review);
    expect(store.getState().reviewComments).toBe(before.reviewComments);
    expect(store.getState().prReviewRevision).toBe(before.prReviewRevision);
    expect(store.getState().prReviewStale).toBe(true);
    expect(store.getState().prReviewRefreshing).toBe(false);
    expect(store.getState().prReviewStatus).toBe("error");
    expect(store.getState().prPrepareError).toBe("refresh clone failed");
    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().prReviewed).toBe(7);
    expect(fetchMock.mock.calls.some(([input]) => input.toString().includes("/api/graph"))).toBe(false);
  });

  it("rolls back a zero-match prepared refresh payload so the prior review can resume", async () => {
    const { store } = await swappedReviewStore();
    const before = store.getState();
    const priorSummary = selectedPrSummary(before);
    const noMatchGraphId = "pr-head-no-match";
    const noMatchFiles = {
      files: [{ path: "src/no-longer-in-graph.ts", status: "modified" as const, additions: 3, deletions: 1 }],
      truncated: true,
      totalFiles: 5,
      outsideCount: 4,
      suggestedSubdir: "src",
    };
    store.setState({ prReviewStale: true });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/api/prs/one")) return Promise.resolve(Response.json({ pr: REFRESHED_SUMMARY }));
      if (url.includes("/api/prs/files")) return Promise.resolve(Response.json(noMatchFiles));
      if (url.includes("/api/prs/comments")) {
        return Promise.resolve(Response.json({ comments: [], reviews: { approved: [], changesRequested: [], commented: 0 }, hasMore: false }));
      }
      if (url.includes("/api/prs/checks")) {
        return Promise.resolve(Response.json({ total: 1, passed: 1, failed: 0, pending: 0, url: null }));
      }
      if (url.includes("/api/pr/analyze")) {
        return Promise.resolve(ndjsonResponse([
          { stage: "clone" },
          { stage: "checkout" },
          { stage: "extract" },
          { stage: "done", graphId: noMatchGraphId, headSha: REFRESHED_HEAD_SHA },
        ]));
      }
      if (url.includes(`/api/graph?id=${noMatchGraphId}`)) {
        return Promise.resolve(Response.json(REFRESHED_HEAD_ARTIFACT));
      }
      if (url.includes(`/api/graph?id=${before.prPreparedGraphId}`)) {
        return Promise.resolve(Response.json(HEAD_ARTIFACT));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    await store.getState().refreshPrReview();

    expect(store.getState().artifact).toBe(before.artifact);
    expect(store.getState().index).toBe(before.index);
    expect(store.getState().review).toBe(before.review);
    expect(store.getState().prReviewRevision).toBe(before.prReviewRevision);
    expect(store.getState().prFiles).toBe(before.prFiles);
    expect(store.getState().prFilesTotal).toBe(before.prFilesTotal);
    expect(store.getState().prFilesOutside).toBe(before.prFilesOutside);
    expect(selectedPrSummary(store.getState())).not.toBe(priorSummary);
    expect(selectedPrSummary(store.getState())?.headSha).toBe(REFRESHED_HEAD_SHA);
    expect(store.getState().prPrepareError).toBe("The refreshed pull request no longer matches this graph.");

    store.getState().closeMinimalGraph();
    await store.getState().resumePrReview();

    expect(store.getState().minimalSeedIds).toEqual([FILE_ID]);
    expect(store.getState().artifact.generatedAt).toBe(HEAD_ARTIFACT.generatedAt);
    expect(store.getState().prPreparedArtifactCurrent).toBe(true);
  });

  it("closing during prepared refresh cancels the analyze waiter promptly and rejects its late graph", async () => {
    const { store } = await swappedReviewStore();
    const oldRevision = store.getState().prReviewRevision;
    const oldGraphId = store.getState().prPreparedGraphId;
    const oldHeadSha = store.getState().prPreparedHeadSha;
    store.getState().addReviewComment(store.getState().reviewFiles[0].path, null, "Keep this resumable draft");
    const drafts = store.getState().reviewComments;
    store.setState({ prReviewStale: true });
    const encoder = new TextEncoder();
    let finishAnalyze!: () => void;
    const analyzeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"stage":"clone"}\n'));
        finishAnalyze = () => {
          controller.enqueue(encoder.encode(`{"stage":"done","graphId":"${REFRESHED_GRAPH_ID}","headSha":"${REFRESHED_HEAD_SHA}"}\n`));
          controller.close();
        };
      },
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/api/prs/one")) return Promise.resolve(Response.json({ pr: REFRESHED_SUMMARY }));
      if (url.includes("/api/prs/files")) return Promise.resolve(Response.json(REFRESHED_FILES));
      if (url.includes("/api/prs/comments")) {
        return Promise.resolve(Response.json({ comments: [], reviews: { approved: [], changesRequested: [], commented: 0 }, hasMore: false }));
      }
      if (url.includes("/api/prs/checks")) {
        return Promise.resolve(Response.json({ total: 1, passed: 1, failed: 0, pending: 0, url: null }));
      }
      if (url.includes("/api/pr/analyze")) return Promise.resolve(new Response(analyzeStream, { status: 200 }));
      if (url.includes("/api/graph")) return Promise.resolve(Response.json(REFRESHED_HEAD_ARTIFACT));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const refresh = store.getState().refreshPrReview();
    await vi.waitFor(() => expect(store.getState().prReviewStatus).toBe("preparing"));
    store.getState().closeMinimalGraph();
    const settledPromptly = await Promise.race([
      refresh.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);

    finishAnalyze();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settledPromptly).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => input.toString().includes("/api/graph"))).toBe(false);
    expect(store.getState().artifact.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(store.getState().prPreparedArtifactCurrent).toBe(false);
    expect(store.getState().prPreparedGraphId).toBe(oldGraphId);
    expect(store.getState().prPreparedHeadSha).toBe(oldHeadSha);
    expect(store.getState().prReviewRevision).toBe(oldRevision);
    expect(store.getState().reviewComments).toBe(drafts);
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().prReviewRefreshing).toBe(false);
    expect(store.getState().prReviewStatus).toBe("idle");
  });

  it("previews a prepared node in its existing HEAD coordinates without double-shifting it", async () => {
    const { store } = await swappedReviewStore();
    vi.stubGlobal("window", { location: { origin: "http://meridian.local" } });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      code: "line20\nline21\nline22",
      truncated: false,
      startLine: 20,
    }));
    vi.stubGlobal("fetch", fetchMock);
    store.setState({
      reviewDiffByFile: {
        "src/a.ts": {
          // Mapping this already-head node again would move 20..22 to 30..32.
          edits: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 11 }],
          kinds: [{ start: 21, end: 21, kind: "modified" }],
        },
      },
    });
    const method = store.getState().index.nodesById.get(METHOD_ID)!;

    const preview = await store.getState().loadCodePreview(method);

    expect(fetchMock.mock.calls[0][0].toString()).toBe(
      "http://meridian.local/api/source?id=pr-head-1&file=src%2Fa.ts&start=20&end=22",
    );
    expect(preview?.baseLine).toBe(20);
    expect(preview?.code).toBe("line20\nline21\nline22");
    // The prepared artifact's own 20..21 line kinds win over the weaker one-line GitHub detail.
    expect([...preview!.changedLineKinds!.entries()]).toEqual([[20, "modified"], [21, "modified"]]);
  });

  it("returning to the PRs lens parks the review and keeps Resume review visible", async () => {
    const { store, bootIndex } = await swappedReviewStore();
    // Pile in-place amber onto the boot index so the restore's clean-reapply is exercised.
    applyChangedIds(bootIndex, [METHOD_ID]);
    store.getState().setViewMode("prs");
    expect(store.getState().viewMode).toBe("prs");
    expect(store.getState().artifact.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(store.getState().index).toBe(bootIndex);
    expect(store.getState().index.nodesById.get(METHOD_ID)?.location.startLine).toBe(10);
    expect(bootIndex.changedIds.size).toBe(0);
    expect(bootIndex.changedDescendants.size).toBe(0);
    expect(store.getState().prReviewBaseline?.index).toBe(bootIndex);
    expect(store.getState().prPreparedGraphId).toBe("pr-head-1");
    expect(store.getState().prPreparedHeadSha).toBe("abc1234def5678900000");
    expect(store.getState().prPreparedArtifactCurrent).toBe(false);
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().review).not.toBe(null);
    expect(store.getState().reviewAffectedIds.size).toBeGreaterThan(0);
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().moduleExpanded.size).toBeGreaterThan(0);
    store.getInitialState = store.getState;
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, { store, children: createElement(PrReviewSection) }),
    );
    expect(markup).toContain("Resume review #7");
  });

  it("browsing a different PR keeps the parked review and resumes its snapshotted PR", async () => {
    const { store, bootIndex } = await swappedReviewStore();
    store.getState().setViewMode("prs");
    await store.getState().selectPr(9);
    expect(store.getState().artifact.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(store.getState().index).toBe(bootIndex);
    expect(store.getState().prReviewBaseline?.index).toBe(bootIndex);
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().review).not.toBe(null);
    expect(store.getState().prSelected).toBe(9);

    await store.getState().resumePrReview();

    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().prSelected).toBe(7);
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().prFiles?.[0]?.hunks).toEqual([{ start: 21, end: 21 }]);
    expect(store.getState().minimalSeedIds).toContain(FILE_ID);
  });

  it("replaces the parked review only when another PR starts reviewing", async () => {
    const { store } = await swappedReviewStore();
    store.getState().setViewMode("prs");
    store.setState(headSelectedPrState(9));

    await store.getState().reviewPrInGraph();

    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().prReviewed).toBe(9);
    expect(store.getState().prReviewSource?.number).toBe(9);
    expect(store.getState().minimalSeedIds).toContain(FILE_ID);
  });

  it("an explicit history exit restores the boot pair and ends the review", async () => {
    const { store, bootIndex } = await swappedReviewStore();
    await store.getState().selectPr(null, { endReviewSession: true });
    expect(store.getState().artifact.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(store.getState().index).toBe(bootIndex);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().minimalSeedIds).toEqual([]);
  });

  it("re-extracting without leaving the session keeps the ORIGINAL pair as the baseline", async () => {
    const { store, bootIndex } = await swappedReviewStore();
    await store.getState().prepareHeadGraph();
    expect(store.getState().prReviewBaseline?.artifact.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(store.getState().prReviewBaseline?.index).toBe(bootIndex);
  });

  it("soft close keeps the prepared id but routes source to the boot graph until resume re-swaps", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { origin: "http://meridian.local" } });
    const store = freshStore({ ...ANALYZE_DEPS, sourceUrl: "/api/source?id=artifact-1" });
    store.setState(headSelectedPrState(7));
    await store.getState().reviewPrInGraph();
    await vi.waitFor(() => {
      expect(store.getState().prPreparedGraphId).toBe("pr-head-1");
    });

    store.getState().closeMinimalGraph();
    expect(store.getState().artifact.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(store.getState().prPreparedGraphId).toBe("pr-head-1");
    expect(store.getState().prPreparedArtifactCurrent).toBe(false);
    await store.getState().showCode(store.getState().index.nodesById.get(METHOD_ID)!);
    const bootSourceCall = fetchMock.mock.calls.filter((call) => call[0].toString().includes("/api/source")).at(-1)!;
    expect(new URL(bootSourceCall[0].toString()).searchParams.get("id")).toBe("artifact-1");

    await store.getState().resumePrReview();
    expect(store.getState().artifact.generatedAt).toBe(HEAD_ARTIFACT.generatedAt);
    expect(store.getState().prPreparedArtifactCurrent).toBe(true);
    await store.getState().showCode(store.getState().index.nodesById.get(METHOD_ID)!);
    const headSourceCall = fetchMock.mock.calls.filter((call) => call[0].toString().includes("/api/source")).at(-1)!;
    expect(new URL(headSourceCall[0].toString()).searchParams.get("id")).toBe("pr-head-1");
  });

  it("keeps a failed resume retryable and succeeds on the next attempt", async () => {
    const { store } = await swappedReviewStore();
    store.getState().closeMinimalGraph();
    vi.stubGlobal("window", { location: { origin: "http://meridian.local" } });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("expired", { status: 404 }))));

    await store.getState().resumePrReview();

    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().prPreparedArtifactCurrent).toBe(false);
    expect(store.getState().prReviewStatus).toBe("error");
    expect(store.getState().prPrepareError).toContain("Could not resume the pull request review");

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json(HEAD_ARTIFACT))));
    await store.getState().resumePrReview();

    expect(store.getState().prReviewStatus).toBe("idle");
    expect(store.getState().prPrepareError).toBeNull();
    expect(store.getState().minimalSeedIds).toEqual([FILE_ID]);
    expect(store.getState().prPreparedArtifactCurrent).toBe(true);
  });

  it("shares concurrent resume clicks instead of swapping the prepared graph twice", async () => {
    const { store } = await swappedReviewStore();
    store.getState().closeMinimalGraph();
    vi.stubGlobal("window", { location: { origin: "http://meridian.local" } });
    let releaseGraph!: (response: Response) => void;
    const graph = new Promise<Response>((resolve) => {
      releaseGraph = resolve;
    });
    const fetchMock = vi.fn(() => graph);
    vi.stubGlobal("fetch", fetchMock);

    const first = store.getState().resumePrReview();
    const second = store.getState().resumePrReview();
    await vi.waitFor(() => expect(store.getState().prReviewStatus).toBe("preparing"));
    expect(fetchMock).toHaveBeenCalledOnce();

    releaseGraph(Response.json(HEAD_ARTIFACT));
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.getState().minimalSeedIds).toEqual([FILE_ID]);
    expect(store.getState().prReviewStatus).toBe("idle");
  });
});
