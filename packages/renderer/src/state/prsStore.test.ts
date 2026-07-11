import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { applyChangedIds, buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore, type StoreDependencies } from "./store";
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
    author: "octo",
    headRef: "feature",
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
    githubSource: true,
    prsUrl: "/api/prs?id=artifact-1",
    prFilesUrl: "/api/prs/files?id=artifact-1",
    prReviewUrl: "/api/prs/review?id=artifact-1",
    ...extra,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PR store slice", () => {
  it("does not call PR endpoints for a graph that is not connected to GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore({ githubSource: false });

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

  it("review with no matched files still lands on the Map", () => {
    const store = freshStore();
    store.setState({
      viewMode: "prs",
      prSelected: 7,
      prsList: { open: [pr(7)], closed: null },
      prFiles: [{ path: "docs/readme.md", status: "modified", additions: 1, deletions: 0 }],
    });
    store.getState().reviewPrInGraph();
    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().minimalSeedIds).toEqual([]);
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

/** A fetch stub routing the three endpoints a streamed review hits; `graph` overrides the GET. */
function routedFetch(options?: { graphId?: string; graph?: () => Promise<Response> }) {
  const graphId = options?.graphId ?? "pr-head-1";
  return vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("/api/pr/analyze")) {
      return Promise.resolve(
        ndjsonResponse([{ stage: "clone" }, { stage: "checkout" }, { stage: "extract" }, { stage: "done", graphId }]),
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

/** Run a full streamed review through the swap; returns the store plus the boot pair for asserts. */
async function swappedReviewStore() {
  const fetchMock = routedFetch();
  vi.stubGlobal("fetch", fetchMock);
  const store = freshStore({ ...ANALYZE_DEPS, prFileUrl: "/api/prs/file?id=artifact-1" });
  const bootIndex = store.getState().index;
  store.setState(headSelectedPrState(7));
  await store.getState().reviewPrInGraph();
  return { store, bootIndex, fetchMock };
}

describe("PR review preparation (streamed analyze)", () => {
  it("walks clone→checkout→extract, stores the prepared graph id, and lands the synchronous review's post-conditions", async () => {
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
    // The analyze POST carries the contract body.
    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://meridian.local/api/pr/analyze");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ id: "artifact-1", prNumber: 7, baseRef: "main", headRef: "feature" });
    // After the stream the review runs against the SWAPPED-IN prepared artifact, landing the same
    // Map post-conditions the synchronous path always has.
    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts"]);
  });

  it("a second review supersedes a first still mid-stream", async () => {
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
    const first = store.getState().reviewPrInGraph();
    const second = store.getState().reviewPrInGraph();
    await second;
    releaseFirst();
    await first;
    // The superseded stream's completion must not clobber the newer run's result.
    expect(store.getState().prPreparedGraphId).toBe("pr-second");
    expect(store.getState().prReviewStatus).toBe("idle");
    expect(store.getState().prPrepareStage).toBe(null);
  });

  it("a failed stream reports the error and leaves the review surface closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([{ stage: "clone" }, { stage: "error", message: "clone failed" }])));
    const store = freshStore(ANALYZE_DEPS);
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();
    expect(store.getState().prReviewStatus).toBe("error");
    expect(store.getState().prPrepareError).toBe("clone failed");
    expect(store.getState().prPrepareStage).toBe(null);
    // The overlay never opened: still on the PRs page, nothing seeded, nothing marked reviewed.
    expect(store.getState().viewMode).toBe("prs");
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().prReviewed).toBe(null);
  });

  it("without an analyzeUrl the review stays synchronous and never fetches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    const bootIndex = store.getState().index;
    store.setState(selectedPrState(7));
    await store.getState().reviewPrInGraph();
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
    releaseGraph(Response.json(HEAD_ARTIFACT));
    await review;
    expect(store.getState().artifact).toBe(ARTIFACT);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().viewMode).toBe("prs");
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
    const select = store.getState().selectPr(8);
    releaseAnalyze();
    await Promise.all([review, select]);
    // The indicator reset with the switch, and the stale stream landed on nothing.
    expect(store.getState().prReviewStatus).toBe("idle");
    expect(store.getState().prPreparedGraphId).toBe(null);
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().viewMode).toBe("prs");
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
    // (method 10-12, class 3-20) it overlaps nothing, so this proves the review ran post-swap.
    expect(store.getState().reviewAffectedIds).toEqual(new Set([METHOD_ID]));
    expect(store.getState().index.changedIds.has(METHOD_ID)).toBe(true);
    // The boot pair was saved for the session-end restore, and its index was never amber-marked.
    expect(store.getState().prReviewBaseline?.artifact).toBe(ARTIFACT);
    expect(store.getState().prReviewBaseline?.index).toBe(bootIndex);
    expect(bootIndex.changedIds.size).toBe(0);
    // The line-diff channel keeps the artifact's own extract-pipeline stamp (origin/<base>), not
    // the client-side GitHub-hunk join (which would have restamped it as "pr#7").
    const changedSince = (store.getState().artifact.extensions as { changedSince?: { baseRef?: string } }).changedSince;
    expect(changedSince?.baseRef).toBe("origin/main");
    expect(store.getState().prPreparedGraphId).toBe("pr-head-1");
    expect(store.getState().prReviewed).toBe(7);
  });

  it("previews a prepared node in its existing HEAD coordinates without double-shifting it", async () => {
    const { store } = await swappedReviewStore();
    vi.stubGlobal("window", { location: { origin: "http://meridian.local" } });
    const fullCode = Array.from({ length: 40 }, (_value, index) => `line${index + 1}`).join("\n");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: fullCode, truncated: false }));
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

    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://meridian.local/api/prs/file?id=artifact-1&path=src%2Fa.ts&ref=feature");
    expect(preview?.baseLine).toBe(20);
    expect(preview?.code).toBe("line20\nline21\nline22");
    // The prepared artifact's own 20..21 line kinds win over the weaker one-line GitHub detail.
    expect([...preview!.changedLineKinds!.entries()]).toEqual([[20, "modified"], [21, "modified"]]);
  });

  it("returning to the PRs lens restores the boot pair and clears the review session", async () => {
    const { store, bootIndex } = await swappedReviewStore();
    // Simulate a historic in-place amber marking of the boot index (the fallback path mutates it),
    // so the restore's clean-reapply is actually exercised.
    applyChangedIds(bootIndex, [METHOD_ID]);
    store.getState().setViewMode("prs");
    expect(store.getState().viewMode).toBe("prs");
    expect(store.getState().artifact).toBe(ARTIFACT);
    expect(store.getState().index).toBe(bootIndex);
    expect(bootIndex.changedIds.size).toBe(0);
    expect(bootIndex.changedDescendants.size).toBe(0);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().prPreparedGraphId).toBe(null);
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().review).toBe(null);
    expect(store.getState().reviewAffectedIds.size).toBe(0);
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().moduleExpanded.size).toBe(0);
  });

  it("selecting a different PR restores the boot pair", async () => {
    const { store, bootIndex } = await swappedReviewStore();
    await store.getState().selectPr(9);
    expect(store.getState().artifact).toBe(ARTIFACT);
    expect(store.getState().index).toBe(bootIndex);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().review).toBe(null);
    expect(store.getState().prSelected).toBe(9);
  });

  it("backing out of the PR (select null) restores the boot pair", async () => {
    const { store, bootIndex } = await swappedReviewStore();
    await store.getState().selectPr(null);
    expect(store.getState().artifact).toBe(ARTIFACT);
    expect(store.getState().index).toBe(bootIndex);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().minimalSeedIds).toEqual([]);
  });

  it("re-reviewing without leaving the session keeps the ORIGINAL boot pair as the baseline", async () => {
    const { store, bootIndex } = await swappedReviewStore();
    await store.getState().reviewPrInGraph();
    expect(store.getState().prReviewBaseline?.artifact).toBe(ARTIFACT);
    expect(store.getState().prReviewBaseline?.index).toBe(bootIndex);
  });
});
