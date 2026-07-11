import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrReviewSection } from "../components/controlpanel/PrReviewSection";
import { applyChangedIds, buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore, selectedPrSummary, type StoreDependencies } from "./store";
import { StoreProvider } from "./StoreContext";
import type { PrSummary } from "./prTypes";

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

function freshStore(extra?: Partial<StoreDependencies>) {
  const index = buildGraphIndex(ARTIFACT);
  return createBlueprintStore({
    artifact: ARTIFACT,
    index,
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
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

  it("reviews a PR: lands on the Map, seeds the changed files, and joins their line diff", () => {
    const store = freshStore();
    store.setState({
      viewMode: "prs",
      prSelected: 7,
      prsList: { open: [pr(7)], closed: null },
      prFiles: [{ path: "repo/src/a.ts", status: "modified", additions: 1, deletions: 0, hunks: [{ start: 1, end: 1 }] }],
    });
    store.getState().reviewPrInGraph();
    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts"]);
    // The PR's line diff is joined into changedSince so the code panel's </> highlights the added
    // lines (green) over the block-level review.
    const changedSince = (store.getState().artifact.extensions as { changedSince?: { files?: Record<string, unknown>; kinds?: Record<string, unknown> } })?.changedSince;
    expect(changedSince?.files?.["src/a.ts"]).toEqual([{ start: 1, end: 1 }]);
    expect(changedSince?.kinds?.["src/a.ts"]).toEqual([{ start: 1, end: 1, kind: "added" }]);
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

  it("renders the Resume chip only for saved non-empty review seeds and never replaces the queue row", () => {
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

    store.setState({ reviewAllSeedIds: [FILE_ID] });
    const withSeeds = renderSection();
    expect(withSeeds).toContain("PR review");
    expect(withSeeds).toContain("1 open");
    expect(withSeeds).toContain("Resume review #7");
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

/** Open the sync review, then run the opt-in head extraction through the swap; returns the store
 * plus the boot pair for asserts. */
async function swappedReviewStore() {
  const fetchMock = routedFetch();
  vi.stubGlobal("fetch", fetchMock);
  const store = freshStore(ANALYZE_DEPS);
  const bootIndex = store.getState().index;
  store.setState(headSelectedPrState(7));
  await store.getState().reviewPrInGraph();
  await store.getState().prepareHeadGraph();
  return { store, bootIndex, fetchMock };
}

describe("PR head preparation (prepareHeadGraph)", () => {
  it("reviewPrInGraph never calls the analyze URL — the sync review is the only automatic path", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore(ANALYZE_DEPS);
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getState().prReviewStatus).toBe("idle");
    expect(store.getState().prPreparedGraphId).toBe(null);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().prReviewed).toBe(7);
  });

  it("walks clone→checkout→extract, stores the prepared graph id + head sha, and re-lands the review's post-conditions", async () => {
    const fetchMock = routedFetch({ graphId: "pr-deadbeef" });
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore(ANALYZE_DEPS);
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();
    const stages: (string | null)[] = [];
    store.subscribe((state) => {
      if (stages[stages.length - 1] !== state.prPrepareStage) {
        stages.push(state.prPrepareStage);
      }
    });
    await store.getState().prepareHeadGraph();
    expect(stages).toEqual(["clone", "checkout", "extract", null]);
    expect(store.getState().prReviewStatus).toBe("idle");
    expect(store.getState().prPrepareError).toBe(null);
    expect(store.getState().prPreparedGraphId).toBe("pr-deadbeef");
    expect(store.getState().prPreparedHeadSha).toBe("abc1234def5678900000");
    expect(store.getState().prPreparedArtifactCurrent).toBe(true);
    // The analyze POST carries the contract body (and is the FIRST fetch — the sync review made none).
    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://meridian.local/api/pr/analyze");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ id: "artifact-1", prNumber: 7, baseRef: "main", headRef: "feature" });
    // After the stream the review re-runs against the SWAPPED-IN prepared artifact, landing the
    // same Map post-conditions the synchronous review had.
    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts"]);
  });

  it("a second preparation supersedes a first still mid-stream", async () => {
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
      .mockResolvedValueOnce(ndjsonResponse([{ stage: "done", graphId: "pr-second" }]))
      // The winning run's artifact swap GETs the prepared graph.
      .mockResolvedValue(Response.json(HEAD_ARTIFACT));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore(ANALYZE_DEPS);
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();
    const first = store.getState().prepareHeadGraph();
    const second = store.getState().prepareHeadGraph();
    await second;
    releaseFirst();
    await first;
    // The superseded stream's completion must not clobber the newer run's result.
    expect(store.getState().prPreparedGraphId).toBe("pr-second");
    expect(store.getState().prReviewStatus).toBe("idle");
    expect(store.getState().prPrepareStage).toBe(null);
  });

  it("a failed extraction reports the error and leaves the sync review intact", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([{ stage: "clone" }, { stage: "error", message: "clone failed" }])));
    const store = freshStore(ANALYZE_DEPS);
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();
    await store.getState().prepareHeadGraph();
    expect(store.getState().prReviewStatus).toBe("error");
    expect(store.getState().prPrepareError).toBe("clone failed");
    expect(store.getState().prPrepareStage).toBe(null);
    // The review REMAINS in sync mode: overlay intact, still on the Map, nothing swapped.
    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts"]);
    expect(store.getState().prPreparedGraphId).toBe(null);
    expect(store.getState().prReviewBaseline).toBe(null);
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
    await store.getState().reviewPrInGraph();
    const prepare = store.getState().prepareHeadGraph();
    // The stream has finished (done landed) and the artifact GET is in flight...
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => call[0].toString().includes("/api/graph"))).toBe(true);
    });
    // ...when the reader switches PRs; the artifact landing later must not swap anything in.
    await store.getState().selectPr(8);
    releaseGraph(Response.json(HEAD_ARTIFACT));
    await prepare;
    // Still the boot graph in base coordinates (the sync review only stamped its line diff).
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
    await store.getState().reviewPrInGraph();
    const prepare = store.getState().prepareHeadGraph();
    const select = store.getState().selectPr(8);
    releaseAnalyze();
    await Promise.all([prepare, select]);
    // The indicator reset with the switch, and the stale stream landed on nothing: no swap.
    expect(store.getState().prReviewStatus).toBe("idle");
    expect(store.getState().prPreparedGraphId).toBe(null);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().artifact.generatedAt).toBe(ARTIFACT.generatedAt);
  });
});

describe("PR review artifact swap and restore", () => {
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
    // The pre-extract pair was saved for the session-end restore. Its amber never saw the head
    // marking (the sync review before the extract only marked the file-module fallback).
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

  it("returning to the PRs lens restores the boot pair and clears the review session", async () => {
    const { store, bootIndex } = await swappedReviewStore();
    // Pile extra in-place amber onto the boot index (on top of the sync review's own marking),
    // so the restore's clean-reapply is actually exercised.
    applyChangedIds(bootIndex, [METHOD_ID]);
    store.getState().setViewMode("prs");
    expect(store.getState().viewMode).toBe("prs");
    expect(store.getState().artifact.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(store.getState().index).toBe(bootIndex);
    expect(store.getState().index.nodesById.get(METHOD_ID)?.location.startLine).toBe(10);
    expect(bootIndex.changedIds.size).toBe(0);
    expect(bootIndex.changedDescendants.size).toBe(0);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().prPreparedGraphId).toBe(null);
    expect(store.getState().prPreparedHeadSha).toBe(null);
    expect(store.getState().prPreparedArtifactCurrent).toBe(false);
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().review).toBe(null);
    expect(store.getState().reviewAffectedIds.size).toBe(0);
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().moduleExpanded.size).toBe(0);
  });

  it("selecting a different PR restores the boot pair", async () => {
    const { store, bootIndex } = await swappedReviewStore();
    await store.getState().selectPr(9);
    expect(store.getState().artifact.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(store.getState().index).toBe(bootIndex);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().review).toBe(null);
    expect(store.getState().prSelected).toBe(9);
  });

  it("backing out of the PR (select null) restores the boot pair", async () => {
    const { store, bootIndex } = await swappedReviewStore();
    await store.getState().selectPr(null);
    expect(store.getState().artifact.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(store.getState().index).toBe(bootIndex);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().minimalSeedIds).toEqual([]);
  });

  it("re-reviewing and re-extracting without leaving the session keeps the ORIGINAL pair as the baseline", async () => {
    const { store, bootIndex } = await swappedReviewStore();
    await store.getState().reviewPrInGraph();
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
    await store.getState().prepareHeadGraph();

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
});
