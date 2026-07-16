import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowStep, GraphArtifact, GraphNode, SyntheticExecution } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type {
  GraphProjectionActivateOptions,
  GraphProjectionDataSource,
  GraphProjectionManifest,
  GraphProjectionRequest,
  GraphProjectionReviewPairOptions,
  LoadedGraphProjection,
  LoadedReviewProjection,
} from "../graph/graphProjectionClient";
import type { FlowSelectionRef } from "../derive/flowBlocks";
import { paintMinimalLevel } from "../components/paintMinimal";
import { createBlueprintStore, type StoreDependencies } from "./store";
import type { PrChangedFile, PrSummary } from "./prTypes";
import type { ReviewFlowSplitView } from "./reviewPreferences";

function node(
  id: string,
  kind: string,
  file: string,
  parentId: string | null,
  startLine: number,
  endLine: number,
): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id.split(/[.#]/).at(-1) ?? id,
    parentId,
    location: { file, startLine, endLine },
  };
}

const PACKAGE_ID = "ts:src";
const ROOT_FILE = "ts:src/orders.ts";
const ROOT_CLASS = `${ROOT_FILE}#OrderService`;
const ROOT_METHOD = `${ROOT_CLASS}.placeOrder`;
const ALT_ROOT_METHOD = `${ROOT_CLASS}.retryOrder`;
const SECOND_ALT_ROOT_METHOD = `${ROOT_CLASS}.resumeOrder`;
const TARGET_FILE = "ts:src/validation.ts";
const TARGET_FUNCTION = `${TARGET_FILE}#validateOrderRequest`;
const NEXT_FILE = "ts:src/policy.ts";
const NEXT_FUNCTION = `${NEXT_FILE}#loadPolicy`;
const CALLER_FILE = "ts:src/preview.ts";
const CALLER_FUNCTION = `${CALLER_FILE}#previewOrder`;
const UNRELATED_FILE = "ts:src/audit.ts";
const UNRELATED_FUNCTION = `${UNRELATED_FILE}#recordAttempt`;

const callTarget: FlowStep = {
  kind: "call",
  label: "validateOrderRequest",
  target: TARGET_FUNCTION,
  resolution: "resolved",
};
const callUnrelated: FlowStep = {
  kind: "call",
  label: "recordAttempt",
  target: UNRELATED_FUNCTION,
  resolution: "resolved",
};

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-11T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node(PACKAGE_ID, "package", "src", null, 1, 80),
    node(ROOT_FILE, "module", "src/orders.ts", PACKAGE_ID, 1, 50),
    node(ROOT_CLASS, "class", "src/orders.ts", ROOT_FILE, 3, 40),
    node(ROOT_METHOD, "method", "src/orders.ts", ROOT_CLASS, 10, 25),
    node(ALT_ROOT_METHOD, "method", "src/orders.ts", ROOT_CLASS, 30, 35),
    node(SECOND_ALT_ROOT_METHOD, "method", "src/orders.ts", ROOT_CLASS, 36, 39),
    node(TARGET_FILE, "module", "src/validation.ts", PACKAGE_ID, 1, 20),
    node(TARGET_FUNCTION, "function", "src/validation.ts", TARGET_FILE, 3, 8),
    node(NEXT_FILE, "module", "src/policy.ts", PACKAGE_ID, 1, 20),
    node(NEXT_FUNCTION, "function", "src/policy.ts", NEXT_FILE, 3, 8),
    node(CALLER_FILE, "module", "src/preview.ts", PACKAGE_ID, 1, 20),
    node(CALLER_FUNCTION, "function", "src/preview.ts", CALLER_FILE, 3, 8),
    node(UNRELATED_FILE, "module", "src/audit.ts", PACKAGE_ID, 1, 20),
    node(UNRELATED_FUNCTION, "function", "src/audit.ts", UNRELATED_FILE, 3, 8),
  ],
  edges: [
    {
      id: `imports@${ROOT_FILE}|${TARGET_FILE}`,
      source: ROOT_FILE,
      target: TARGET_FILE,
      kind: "imports",
      resolution: "resolved",
      weight: 1,
    },
    {
      id: `calls@${ROOT_METHOD}|${TARGET_FUNCTION}`,
      source: ROOT_METHOD,
      target: TARGET_FUNCTION,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
    },
    {
      id: `calls@${ALT_ROOT_METHOD}|${TARGET_FUNCTION}`,
      source: ALT_ROOT_METHOD,
      target: TARGET_FUNCTION,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
    },
    {
      id: `calls@${SECOND_ALT_ROOT_METHOD}|${TARGET_FUNCTION}`,
      source: SECOND_ALT_ROOT_METHOD,
      target: TARGET_FUNCTION,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
    },
    {
      id: `calls@${TARGET_FUNCTION}|${NEXT_FUNCTION}`,
      source: TARGET_FUNCTION,
      target: NEXT_FUNCTION,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
    },
    {
      id: `calls@${CALLER_FUNCTION}|${TARGET_FUNCTION}`,
      source: CALLER_FUNCTION,
      target: TARGET_FUNCTION,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
    },
    {
      id: `calls@${ROOT_METHOD}|${UNRELATED_FUNCTION}`,
      source: ROOT_METHOD,
      target: UNRELATED_FUNCTION,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
    },
  ],
  extensions: {
    logicFlow: {
      [ROOT_METHOD]: [callTarget],
      [ALT_ROOT_METHOD]: [callTarget],
      [SECOND_ALT_ROOT_METHOD]: [callTarget],
      [TARGET_FUNCTION]: [],
    },
  },
} as unknown as GraphArtifact;

const FLOW_SELECTION: FlowSelectionRef = { rootId: ROOT_METHOD, blockPath: [] };
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);

const INITIAL_PROJECTION_REQUEST: GraphProjectionRequest = {
  view: "modules",
  filePaths: [],
  focusIds: [],
  expandedIds: [],
  extraIds: [],
  depth: 1,
  radius: 0,
  includeTests: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function syntheticExecution(): SyntheticExecution {
  const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const spanId = "1000000000000001";
  return {
    executionVersion: "1.0.0",
    outcome: "completed",
    scenarioId: "place-order-happy",
    rootId: ROOT_METHOD,
    generatedAt: "2026-07-11T00:00:01.000Z",
    input: { orderId: "ord_1" },
    output: { accepted: true },
    warnings: [],
    trace: {
      traceId,
      name: "Synthetic placeOrder",
      rootSpanId: spanId,
      startedAtUnixNano: "1000000000",
      endedAtUnixNano: "1002000000",
      status: "ok",
      attributes: {},
      spans: [{
        spanId,
        nodeId: ROOT_METHOD,
        name: "placeOrder",
        kind: "internal",
        startedAtUnixNano: "1000000000",
        endedAtUnixNano: "1002000000",
        status: "ok",
        attributes: {},
        events: [],
      }],
      completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
    },
    snapshots: [{
      spanId,
      nodeId: ROOT_METHOD,
      occurrenceKey: "placeOrder:1",
      input: { orderId: "ord_1" },
      output: { accepted: true },
    }],
    inputOverrideResults: [],
    watchHits: [],
  };
}

function pr(number: number): PrSummary {
  return {
    number,
    title: `PR ${number}`,
    body: null,
    author: "octo",
    headRef: "feature/review-flow",
    headSha: null,
    baseRef: "main",
    updatedAt: "2026-07-11T00:00:00.000Z",
    draft: false,
    state: "open",
    url: `https://github.com/o/r/pull/${number}`,
  };
}

function freshStore(extra?: Partial<StoreDependencies>) {
  const artifact = extra?.artifact ?? ARTIFACT;
  const index = extra?.index ?? buildGraphIndex(artifact);
  const projectionDataSource = new FlowReviewProjectionSource(artifact);
  const initialProjection = projectionFor(artifact, "artifact-1", INITIAL_PROJECTION_REQUEST);
  projectionDataSource.seed(initialProjection);
  const store = createBlueprintStore({
    artifact,
    index,
    projectionDataSource,
    initialProjection,
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prSessionSource: { repository: "o/r", subdir: "" },
    prsUrl: "/api/prs?id=artifact-1",
    prOneUrl: "/api/prs/one?id=artifact-1",
    prFilesUrl: "/api/prs/files?id=artifact-1",
    prRelatedUrl: "/api/prs/related?id=artifact-1",
    prCommentsUrl: "/api/prs/comments?id=artifact-1",
    prChecksUrl: "/api/prs/checks?id=artifact-1",
    prReviewUrl: "/api/prs/review?id=artifact-1",
    prepareUrl: "/api/pr/prepare",
    ...extra,
  });
  if (extra?.projectionDataSource === undefined) {
    flowReviewProjectionSources.set(store, projectionDataSource);
  }
  return store;
}

const flowReviewProjectionSources = new WeakMap<object, FlowReviewProjectionSource>();
let preparedReviewSequence = 0;

class FlowReviewProjectionSource implements GraphProjectionDataSource {
  activeKey: string | undefined;
  private readonly projections = new Map<string, LoadedGraphProjection>();
  private readonly reviews = new Map<string, LoadedReviewProjection>();
  private preparedHead: GraphArtifact | null = null;

  constructor(private readonly mergeBase: GraphArtifact) {}

  seed(projection: LoadedGraphProjection): void {
    this.projections.set(projection.key, projection);
    this.activeKey = projection.key;
  }

  setPreparedHead(artifact: GraphArtifact): void {
    this.preparedHead = artifact;
  }

  async loadManifest(options: GraphProjectionActivateOptions = {}): Promise<GraphProjectionManifest> {
    const graphId = graphIdForOptions(options);
    const artifact = graphId.endsWith("-base") ? this.mergeBase : this.preparedHead ?? this.mergeBase;
    return {
      version: 3,
      graphId,
      contentId: "0".repeat(64),
      graphSummary: {
        schemaVersion: artifact.schemaVersion,
        generatedAt: artifact.generatedAt,
        nodeCount: artifact.nodes.length,
        edgeCount: artifact.edges.length,
      },
      defaultView: INITIAL_PROJECTION_REQUEST,
    };
  }

  async activate(
    request: GraphProjectionRequest,
    options: GraphProjectionActivateOptions = {},
  ): Promise<LoadedGraphProjection> {
    options.signal?.throwIfAborted();
    const graphId = graphIdForOptions(options);
    const artifact = graphId.endsWith("-base") ? this.mergeBase : this.preparedHead ?? this.mergeBase;
    const projection = projectionFor(artifact, graphId, request);
    this.projections.set(projection.key, projection);
    this.activeKey = projection.key;
    return projection;
  }

  async activateReviewPair(options: GraphProjectionReviewPairOptions): Promise<LoadedReviewProjection> {
    const [head, mergeBase] = await Promise.all([
      this.activate(options.head.request, { endpoints: options.head.endpoints, signal: options.signal }),
      this.activate(options.mergeBase.request, { endpoints: options.mergeBase.endpoints, signal: options.signal }),
    ]);
    const key = `review-pair\u0000${JSON.stringify([head.key, mergeBase.key])}`;
    const review = {
      key,
      projectionId: `${head.projectionId}\u0000${mergeBase.projectionId}`,
      head,
      mergeBase,
      serializedBytes: head.serializedBytes + mergeBase.serializedBytes,
      residentBytes: head.residentBytes + mergeBase.residentBytes,
    } satisfies LoadedReviewProjection;
    this.reviews.set(key, review);
    this.activeKey = key;
    return review;
  }

  activateCached(key: string): LoadedGraphProjection | undefined {
    const projection = this.projections.get(key);
    if (projection !== undefined) this.activeKey = projection.key;
    return projection;
  }

  activateCachedReview(key: string): LoadedReviewProjection | undefined {
    const review = this.reviews.get(key);
    if (review !== undefined) this.activeKey = review.key;
    return review;
  }

  searchSymbols(): Promise<never> {
    return Promise.reject(new Error("symbol search is not exercised by this projection source"));
  }
}

function graphIdForOptions(options: GraphProjectionActivateOptions): string {
  const manifestUrl = options.endpoints?.manifestUrl;
  return manifestUrl === undefined
    ? "artifact-1"
    : new URL(manifestUrl, "http://meridian.local").searchParams.get("id") ?? "artifact-1";
}

function projectionFor(
  artifact: GraphArtifact,
  graphId: string,
  request: GraphProjectionRequest,
): LoadedGraphProjection {
  const key = `${graphId}\u0000${JSON.stringify(request)}`;
  return {
    key,
    projectionId: `projection-${key}`,
    graphId,
    request,
    artifact,
    index: buildGraphIndex(artifact),
    serializedBytes: 100,
    residentBytes: 300,
  };
}

function preparedHeadArtifact(artifact: GraphArtifact, files: readonly PrChangedFile[]): GraphArtifact {
  const manifest = files.map((file) => ({
    path: file.path,
    status: file.status === "removed" ? "deleted" as const : file.status,
    ...(file.status === "renamed" ? { previousPath: file.previousPath } : {}),
  }));
  const ranges = Object.fromEntries(files.map((file) => [
    file.path,
    (file.hunks ?? []).map((range) => ({ ...range })),
  ]));
  const kinds = Object.fromEntries(files.map((file) => [
    file.path,
    file.status === "removed"
      ? []
      : (file.hunks ?? []).map((range) => ({
          ...range,
          kind: file.status === "added" ? "added" as const : "modified" as const,
        })),
  ]));
  const stats = Object.fromEntries(files.map((file) => [file.path, {
    added: file.additions,
    deleted: file.deletions,
  }]));
  return {
    ...artifact,
    extensions: {
      ...(artifact.extensions ?? {}),
      changedSince: {
        baseRef: "origin/main",
        manifest,
        files: ranges,
        kinds,
        diffLines: Object.fromEntries(files.map((file) => [file.path, []])),
        stats,
      },
    } as GraphArtifact["extensions"],
  };
}

async function enterPreparedReview(store: ReturnType<typeof freshStore>): Promise<void> {
  const source = flowReviewProjectionSources.get(store);
  if (source === undefined) throw new Error("missing flow-review projection fixture");
  const files = store.getState().prFiles ?? [];
  const graphId = `flow-review-${++preparedReviewSequence}`;
  source.setPreparedHead(preparedHeadArtifact(store.getState().artifact, files));
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/api/pr/prepare")) {
      return Promise.resolve(preparationResponse(graphId, files));
    }
    if (url.includes(`/api/meta?id=${graphId}`)) {
      return Promise.resolve(Response.json({
        syntheticExecutionUrl: null,
        syntheticScenarios: [],
        syntheticExecutionTrust: null,
      }));
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }));
  await store.getState().reviewPrInGraph();
  const prepareError = store.getState().prPrepareError;
  if (prepareError !== null) {
    throw new Error(prepareError);
  }
}

function preparationResponse(graphId: string, files: readonly PrChangedFile[]): Response {
  const descriptor = (id: string) => ({
    graphId: id,
    manifestUrl: `/api/graph/manifest?id=${id}`,
    projectionUrl: `/api/graph/projection?id=${id}`,
    sourceUrl: `/api/source?id=${id}`,
    metaUrl: `/api/meta?id=${id}`,
    graphSummary: {
      schemaVersion: ARTIFACT.schemaVersion,
      generatedAt: ARTIFACT.generatedAt,
      nodeCount: ARTIFACT.nodes.length,
      edgeCount: ARTIFACT.edges.length,
    },
  });
  const records = [
    { version: 1, type: "progress", stage: "resolve", elapsedMs: 0 },
    { version: 1, type: "progress", stage: "git", elapsedMs: 1 },
    { version: 1, type: "progress", stage: "extract-head", elapsedMs: 2 },
    { version: 1, type: "progress", stage: "extract-merge-base", elapsedMs: 3 },
    { version: 1, type: "progress", stage: "publish", elapsedMs: 4 },
    {
      version: 1,
      type: "done",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeBaseSha: MERGE_BASE_SHA,
      changedFiles: files.map((file) => ({
        path: file.path,
        status: file.status === "removed" ? "deleted" : file.status,
        ...(file.status === "renamed" ? { previousPath: file.previousPath } : {}),
      })),
      head: descriptor(graphId),
      mergeBase: descriptor(`${graphId}-base`),
      cache: "miss",
      timings: { totalMs: 5 },
      warnings: [],
      handoff: {
        id: `handoff-${graphId}`,
        url: `/api/pr/prepared?id=handoff-${graphId}`,
        viewUrl: `/view?id=${graphId}&view=modules&prn=17&rev=1&prepared=handoff-${graphId}`,
      },
    },
  ];
  const body = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

async function activeReviewStore(
  reviewFlowSplitView: ReviewFlowSplitView = "graph",
  reviewOpenFlowSplitOnSelect = true,
) {
  const store = freshStore();
  store.setState({
    reviewFlowSplitView,
    reviewOpenFlowSplitOnSelect,
    viewMode: "prs",
    prSelected: 17,
    prsList: { open: [pr(17)], closed: null },
    prFiles: [
      {
        path: "src/orders.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        hunks: [{ start: 15, end: 16 }],
      },
    ],
  });

  await enterPreparedReview(store);
  await vi.waitFor(() => {
    expect(store.getState().minimalLayoutStatus).toBe("ready");
  });
  expect(store.getState().review?.rows.map((row) => row.flow.flowId)).toContain(ROOT_METHOD);
  expect(store.getState().minimalSeedIds).toEqual([ROOT_FILE]);
  return store;
}

async function impactedFlowReviewStore() {
  const artifact = {
    ...ARTIFACT,
    extensions: {
      ...ARTIFACT.extensions,
      logicFlow: {
        [ROOT_METHOD]: [callTarget, callUnrelated],
        [ALT_ROOT_METHOD]: [callTarget],
        [SECOND_ALT_ROOT_METHOD]: [callTarget],
        [TARGET_FUNCTION]: [],
        [UNRELATED_FUNCTION]: [],
      },
    },
  } as unknown as GraphArtifact;
  const store = freshStore({ artifact, index: buildGraphIndex(artifact) });
  store.setState({
    reviewFlowSplitView: "graph",
    reviewOpenFlowSplitOnSelect: true,
    viewMode: "prs",
    prSelected: 17,
    prsList: { open: [pr(17)], closed: null },
    prFiles: [
      {
        path: "src/validation.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        hunks: [{ start: 3, end: 4 }],
      },
    ],
  });

  await enterPreparedReview(store);
  await vi.waitFor(() => {
    expect(store.getState().minimalLayoutStatus).toBe("ready");
  });
  expect(store.getState().review?.rows).toContainEqual(expect.objectContaining({
    group: "impacted",
    flow: expect.objectContaining({ flowId: ROOT_METHOD }),
  }));
  expect(store.getState().minimalSeedIds).toEqual([TARGET_FILE]);
  return store;
}

describe("PR-review logic-flow selection", () => {
  it.each(["timeline", "metro", "blocks"] as const)(
    "skips execution-graph ELK for %s and derives it only when requested",
    async (alternateView) => {
      const store = await activeReviewStore(alternateView);

      store.getState().selectFlowEntry(FLOW_SELECTION);
      await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
      expect(store.getState().flowPaneLayoutStatus).toBe("idle");
      expect(store.getState().flowPaneRfNodes).toEqual([]);
      expect(store.getState().flowPaneRfEdges).toEqual([]);

      store.getState().setReviewFlowSplitView("graph");
      await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
      expect(store.getState().flowPaneRfNodes.length).toBeGreaterThan(0);

      store.getState().setReviewFlowSplitView(alternateView);
      expect(store.getState().flowPaneLayoutStatus).toBe("idle");
      expect(store.getState().flowPaneRfNodes).toEqual([]);
      expect(store.getState().flowPaneRfEdges).toEqual([]);
    },
  );

  it("keeps graph context selected without deriving the disabled split", async () => {
    const store = await activeReviewStore("graph", false);

    store.getState().selectFlowEntry(FLOW_SELECTION);

    await vi.waitFor(() => {
      expect(store.getState().minimalLayoutStatus).toBe("ready");
      expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: ROOT_METHOD, type: "block" }));
    });
    expect(store.getState().flowSelection).toEqual(FLOW_SELECTION);
    expect(store.getState().reviewFlowBaseline).not.toBeNull();
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_METHOD, TARGET_FUNCTION]));
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");
    expect(store.getState().flowPaneRfNodes).toEqual([]);
    expect(store.getState().flowPaneRfEdges).toEqual([]);

    // Choosing Graph while its pane is disabled must remain layout-free.
    store.getState().setReviewFlowSplitView("graph");
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");

    store.getState().setReviewOpenFlowSplitOnSelect(true);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    expect(store.getState().flowPaneRfNodes.length).toBeGreaterThan(0);

    const baseline = store.getState().reviewFlowBaseline;
    store.getState().setReviewOpenFlowSplitOnSelect(false);
    expect(store.getState().flowSelection).toEqual(FLOW_SELECTION);
    expect(store.getState().reviewFlowBaseline).toBe(baseline);
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_METHOD, TARGET_FUNCTION]));
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");
    expect(store.getState().flowPaneRfNodes).toEqual([]);
    expect(store.getState().flowPaneRfEdges).toEqual([]);
  });

  it("opens an explicit sequence without overwriting saved review preferences", async () => {
    const store = await activeReviewStore("blocks", false);

    store.getState().openReviewFlow(FLOW_SELECTION, "timeline");
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));

    expect(store.getState().flowSelection).toEqual(FLOW_SELECTION);
    expect(store.getState().reviewFlowExplicitView).toBe("timeline");
    expect(store.getState().reviewFlowSplitView).toBe("blocks");
    expect(store.getState().reviewOpenFlowSplitOnSelect).toBe(false);
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");

    store.getState().selectFlowEntry(null);
    expect(store.getState().reviewFlowExplicitView).toBeNull();
    expect(store.getState().reviewFlowSplitView).toBe("blocks");
    expect(store.getState().reviewOpenFlowSplitOnSelect).toBe(false);
  });

  it("does not let an in-flight Graph layout repopulate a disabled split", async () => {
    const store = await activeReviewStore("graph", false);
    store.getState().selectFlowEntry(FLOW_SELECTION);
    // Enable directly so this test owns exactly one layout promise rather than racing the action's
    // automatic pass with a second manual one.
    store.setState({ reviewOpenFlowSplitOnSelect: true });
    const pendingLayout = store.getState().flowPaneRelayout();
    expect(store.getState().flowPaneLayoutStatus).toBe("laying-out");

    store.getState().setReviewOpenFlowSplitOnSelect(false);
    await pendingLayout;

    expect(store.getState().flowSelection).toEqual(FLOW_SELECTION);
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");
    expect(store.getState().flowPaneRfNodes).toEqual([]);
    expect(store.getState().flowPaneRfEdges).toEqual([]);
  });

  it.each(["timeline", "metro", "blocks"] as const)(
    "re-enables an active %s split without deriving ELK",
    async (alternateView) => {
      const store = await activeReviewStore(alternateView, false);
      store.getState().selectFlowEntry(FLOW_SELECTION);
      await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));

      store.getState().setReviewOpenFlowSplitOnSelect(true);

      expect(store.getState().flowSelection).toEqual(FLOW_SELECTION);
      expect(store.getState().flowPaneLayoutStatus).toBe("idle");
      expect(store.getState().flowPaneRfNodes).toEqual([]);
      expect(store.getState().flowPaneRfEdges).toEqual([]);
    },
  );

  it("opens the exact flow on the review graph, reveals its nested root, and resets on close", async () => {
    const store = await activeReviewStore();
    const reviewExpansion = new Set(store.getState().moduleExpanded);
    expect(reviewExpansion.has(ROOT_FILE)).toBe(true);
    expect(reviewExpansion.has(ROOT_CLASS)).toBe(false);

    store.getState().selectFlowEntry(FLOW_SELECTION);

    await vi.waitFor(() => {
      const state = store.getState();
      expect(state.flowPaneLayoutStatus).toBe("ready");
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: ROOT_METHOD, type: "block" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: TARGET_FUNCTION, type: "ghost" }));
    });
    expect(store.getState().flowSelection).toEqual(FLOW_SELECTION);
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_METHOD, TARGET_FUNCTION]));
    expect(store.getState().moduleExpanded.has(ROOT_FILE)).toBe(true);
    expect(store.getState().moduleExpanded.has(ROOT_CLASS)).toBe(true);
    expect(store.getState().reviewSelectedId).toBeNull();
    expect(store.getState().logicSelected).toBeNull();

    const defaultPaint = paintMinimalLevel(
      store.getState().minimalRfNodes,
      store.getState().minimalRfEdges,
      store.getState().moduleSelected,
      1,
      "subgraph",
    );
    expect(defaultPaint.nodes).toContainEqual(expect.objectContaining({ id: ROOT_METHOD }));
    expect(defaultPaint.nodes).toContainEqual(expect.objectContaining({ id: TARGET_FUNCTION, type: "ghost" }));
    expect(defaultPaint.nodes.some((candidate) => candidate.id === UNRELATED_FUNCTION)).toBe(false);
    expect(defaultPaint.edges).toContainEqual(expect.objectContaining({
      source: ROOT_METHOD,
      target: TARGET_FUNCTION,
      style: expect.objectContaining({ opacity: 1 }),
    }));

    store.getState().selectFlowEntry(null);

    await vi.waitFor(() => {
      const state = store.getState();
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfNodes.some((candidate) => candidate.id === ROOT_METHOD)).toBe(false);
    });
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");
    expect(store.getState().moduleSelected).toEqual(new Set());
    expect(store.getState().moduleExpanded).toEqual(reviewExpansion);
    expect(store.getState().reviewSelectedId).toBeNull();
    expect(store.getState().logicSelected).toBeNull();
  });

  it("extracts the complete multi-node flow selection as one nested PR graph", async () => {
    const store = await activeReviewStore();
    store.getState().selectFlowEntry(FLOW_SELECTION);
    await vi.waitFor(() => {
      expect(store.getState().minimalLayoutStatus).toBe("ready");
      expect(store.getState().flowPaneLayoutStatus).toBe("ready");
    });
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_METHOD, TARGET_FUNCTION]));

    store.getState().buildMinimalGraph();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));

    expect(new Set(store.getState().minimalSeedIds)).toEqual(new Set([ROOT_METHOD, TARGET_FUNCTION]));
    expect(store.getState().minimalRfNodes.some((node) => node.id === ROOT_METHOD)).toBe(true);
    expect(store.getState().minimalRfNodes.some((node) => node.id === TARGET_FUNCTION)).toBe(true);
    expect(store.getState().review).not.toBeNull();
    expect(store.getState().minimalGraphHistory).toHaveLength(1);
  });

  it("keeps an exact nested flow step selected in Diff-only review", async () => {
    const store = await activeReviewStore();
    const stepId = `step:${ROOT_METHOD}:0`;
    store.setState({
      moduleExpanded: new Set([
        ...store.getState().moduleExpanded,
        ROOT_CLASS,
        ROOT_METHOD,
      ]),
    });
    await store.getState().minimalRelayout({ label: "Opening changed flow…" });
    expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: stepId, type: "step" }));

    store.getState().selectModule(stepId);
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    store.getState().buildMinimalGraph();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    expect(store.getState().minimalSeedIds).toEqual([stepId]);

    store.getState().toggleReviewDiffOnly();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    expect(store.getState().reviewDiffOnly).toBe(true);
    expect(store.getState().moduleSelected).toEqual(new Set([stepId]));
    expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: stepId, type: "step" }));
  });

  it("narrows the graph to one flow target and restores the whole-flow selection", async () => {
    const store = await activeReviewStore();
    store.getState().selectFlowEntry(FLOW_SELECTION);
    await vi.waitFor(() => {
      expect(store.getState().flowPaneLayoutStatus).toBe("ready");
      expect(store.getState().minimalRfNodes.some((candidate) => candidate.id === ROOT_METHOD)).toBe(true);
    });

    store.getState().selectFlowPaneTarget(ROOT_METHOD);
    await vi.waitFor(() => {
      const state = store.getState();
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: ROOT_METHOD, type: "block" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: TARGET_FUNCTION, type: "ghost" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: UNRELATED_FUNCTION, type: "ghost" }));
      expect(state.minimalRfNodes.some((candidate) => candidate.id === NEXT_FUNCTION)).toBe(false);
      expect(state.minimalRfNodes.some((candidate) => candidate.id === CALLER_FUNCTION)).toBe(false);
      expect(state.minimalRfEdges.filter((edge) => edge.source === ROOT_METHOD && edge.target === TARGET_FUNCTION)).toHaveLength(1);
      expect(state.minimalRfEdges.some((edge) =>
        edge.source === ROOT_FILE
        && edge.target === TARGET_FILE
        && (edge.data as { category?: string } | undefined)?.category === "dep"
      )).toBe(false);
    });

    store.getState().selectFlowPaneTarget(TARGET_FUNCTION);

    await vi.waitFor(() => {
      const state = store.getState();
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: TARGET_FUNCTION, type: "block" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: NEXT_FUNCTION, type: "ghost" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: CALLER_FUNCTION, type: "ghost" }));
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: ROOT_METHOD, target: TARGET_FUNCTION }));
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: TARGET_FUNCTION, target: NEXT_FUNCTION }));
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: CALLER_FUNCTION, target: TARGET_FUNCTION }));
    });
    expect(store.getState().minimalMemberIds).toEqual([ROOT_FILE]);
    expect(store.getState().moduleSelected).toEqual(new Set([TARGET_FUNCTION]));
    expect(store.getState().reviewSelectedId).toBe(TARGET_FUNCTION);
    expect(store.getState().logicSelected).toBe(TARGET_FUNCTION);

    const targetPaint = paintMinimalLevel(
      store.getState().minimalRfNodes,
      store.getState().minimalRfEdges,
      store.getState().moduleSelected,
      1,
      "node",
    );
    expect(targetPaint.nodes).toContainEqual(expect.objectContaining({ id: NEXT_FUNCTION, type: "ghost" }));
    expect(targetPaint.nodes).toContainEqual(expect.objectContaining({ id: CALLER_FUNCTION, type: "ghost" }));
    expect(targetPaint.edges).toContainEqual(expect.objectContaining({
      source: TARGET_FUNCTION,
      target: NEXT_FUNCTION,
      style: expect.objectContaining({ opacity: 1 }),
    }));
    expect(targetPaint.edges).toContainEqual(expect.objectContaining({
      source: CALLER_FUNCTION,
      target: TARGET_FUNCTION,
      style: expect.objectContaining({ opacity: 1 }),
    }));

    // A graph-pane click routes through selectModule(null): while a review flow is open it must
    // clear the one-node inspection and restore the flow-wide default, never remove all emphasis.
    store.getState().selectModule(null);

    await vi.waitFor(() => {
      const state = store.getState();
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: ROOT_METHOD, type: "block" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: TARGET_FUNCTION, type: "ghost" }));
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: ROOT_METHOD, target: TARGET_FUNCTION }));
      expect(state.minimalRfNodes.some((candidate) => candidate.id === NEXT_FUNCTION)).toBe(false);
      expect(state.minimalRfNodes.some((candidate) => candidate.id === CALLER_FUNCTION)).toBe(false);
    });
    expect(store.getState().flowSelection).toEqual(FLOW_SELECTION);
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_METHOD, TARGET_FUNCTION]));
    expect(store.getState().reviewSelectedId).toBeNull();
    expect(store.getState().logicSelected).toBeNull();
  });

  it.each(["graph", "metro", "blocks", "timeline"] as const)(
    "extracts a selected %s flow target through arbitrarily nested PR graphs",
    async (projection) => {
      const store = await activeReviewStore(projection);
      store.getState().selectFlowEntry(FLOW_SELECTION);
      await vi.waitFor(() => {
        expect(store.getState().minimalLayoutStatus).toBe("ready");
        expect(store.getState().flowPaneLayoutStatus).toBe(projection === "graph" ? "ready" : "idle");
      });
      store.getState().selectFlowPaneTarget(TARGET_FUNCTION);
      await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));

      const flowParent = store.getState();
      const parentNodes = flowParent.minimalRfNodes;
      const parentFlowNodes = flowParent.flowPaneRfNodes;
      expect(flowParent.moduleSelected).toEqual(new Set([TARGET_FUNCTION]));

      store.getState().buildMinimalGraph();
      await vi.waitFor(() => {
        expect(store.getState().minimalLayoutStatus).toBe("ready");
        expect(store.getState().minimalSeedIds).toEqual([TARGET_FUNCTION]);
      });
      expect(store.getState().reviewFlowSplitView).toBe(projection);
      expect(store.getState().review).not.toBeNull();
      expect(store.getState().prReviewed).toBe(17);
      expect(store.getState().flowSelection).toBeNull();
      expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({
        id: TARGET_FUNCTION,
        type: "block",
      }));
      expect(store.getState().minimalGraphHistory).toHaveLength(1);
      expect(store.getState().minimalGraphHistory[0]?.label).toBe("PR graph");

      store.getState().selectModule(NEXT_FUNCTION);
      await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
      store.getState().buildMinimalGraph();
      await vi.waitFor(() => {
        expect(store.getState().minimalLayoutStatus).toBe("ready");
        expect(store.getState().minimalSeedIds).toEqual([NEXT_FUNCTION]);
      });
      expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({
        id: NEXT_FUNCTION,
        type: "block",
      }));
      expect(store.getState().minimalGraphHistory).toHaveLength(2);
      expect(store.getState().minimalGraphHistory[1]?.label).toBe("extracted graph");

      store.getState().backMinimalGraph();
      expect(store.getState().minimalSeedIds).toEqual([TARGET_FUNCTION]);
      expect(store.getState().flowSelection).toBeNull();

      store.getState().backMinimalGraph();
      const restored = store.getState();
      expect(restored.flowSelection).toEqual(FLOW_SELECTION);
      expect(restored.logicSelected).toBe(TARGET_FUNCTION);
      expect(restored.reviewFlowBaseline).not.toBeNull();
      expect(restored.minimalRfNodes).toBe(parentNodes);
      expect(restored.flowPaneRfNodes).toBe(parentFlowNodes);
      expect(restored.flowPaneLayoutStatus).toBe(projection === "graph" ? "ready" : "idle");
      expect(restored.minimalGraphHistory).toHaveLength(0);
    },
  );

  it("rebuilds a synthetic parent after Tests changes in a nested Metro review", async () => {
    const store = await activeReviewStore("metro", false);
    store.getState().selectFlowEntry(FLOW_SELECTION);
    await vi.waitFor(() => {
      expect(store.getState().minimalLayoutStatus).toBe("ready");
      expect(store.getState().flowPaneLayoutStatus).toBe("idle");
    });
    const execution = syntheticExecution();
    store.setState({
      flowPaneOrigin: "synthetic",
      syntheticExecution: execution,
      syntheticExecutionRootId: ROOT_METHOD,
      syntheticExecutionHost: "flow-pane",
      syntheticExecutionStatus: "ready",
      syntheticExecutionError: null,
      syntheticSelectedMomentId: null,
      syntheticFlowPresentation: "overview",
      flowPaneLayoutStatus: "laying-out",
    });
    await store.getState().flowPaneRelayout();
    expect(store.getState().flowPaneLayoutStatus).toBe("ready");
    expect(store.getState().flowPaneRfNodes.length).toBeGreaterThan(0);

    store.setState({ moduleSelected: new Set([TARGET_FUNCTION]) });
    store.getState().buildMinimalGraph();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    store.getState().toggleShowTests();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    expect(store.getState().showTests).toBe(true);

    store.getState().backMinimalGraph();
    await vi.waitFor(() => {
      expect(store.getState().minimalLayoutStatus).toBe("ready");
      expect(store.getState().flowPaneLayoutStatus).toBe("ready");
      expect(store.getState().flowPaneRfNodes.length).toBeGreaterThan(0);
    });
    expect(store.getState()).toMatchObject({
      showTests: false,
      reviewFlowSplitView: "metro",
      reviewOpenFlowSplitOnSelect: false,
      flowSelection: FLOW_SELECTION,
      flowPaneOrigin: "synthetic",
      syntheticExecution: execution,
      syntheticExecutionStatus: "ready",
      minimalGraphHistory: [],
    });
  });

  it("rebuilds a restored parent flow when its split preference changed in a child", async () => {
    const store = await activeReviewStore("metro", false);
    store.getState().selectFlowEntry(FLOW_SELECTION);
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");

    store.getState().buildMinimalGraph();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    expect(store.getState().flowSelection).toBeNull();

    // Preferences are session-global, so Back must retain these newer values while rebuilding the
    // restored parent pane that was captured under Metro/closed.
    store.setState({ reviewFlowSplitView: "graph", reviewOpenFlowSplitOnSelect: true });
    store.getState().backMinimalGraph();

    expect(store.getState().reviewFlowSplitView).toBe("graph");
    expect(store.getState().reviewOpenFlowSplitOnSelect).toBe(true);
    expect(store.getState().flowSelection).toEqual(FLOW_SELECTION);
    await vi.waitFor(() => {
      expect(store.getState().flowPaneLayoutStatus).toBe("ready");
      expect(store.getState().flowPaneRfNodes.length).toBeGreaterThan(0);
    });
  });

  it("materializes an unchanged impacted flow root so every flow member is highlighted", async () => {
    const store = await impactedFlowReviewStore();
    store.getState().selectFlowEntry(FLOW_SELECTION);

    await vi.waitFor(() => {
      const state = store.getState();
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: ROOT_METHOD, type: "block" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: TARGET_FUNCTION, type: "block" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: UNRELATED_FUNCTION, type: "ghost" }));
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: ROOT_METHOD, target: TARGET_FUNCTION }));
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: ROOT_METHOD, target: UNRELATED_FUNCTION }));
    });
    expect(store.getState().minimalMemberIds).toEqual([TARGET_FILE]);
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_METHOD, TARGET_FUNCTION, UNRELATED_FUNCTION]));
    const painted = paintMinimalLevel(
      store.getState().minimalRfNodes,
      store.getState().minimalRfEdges,
      store.getState().moduleSelected,
      1,
      "subgraph",
    );
    expect(painted.nodes).toContainEqual(expect.objectContaining({ id: UNRELATED_FUNCTION, type: "ghost" }));
    expect(painted.edges).toContainEqual(expect.objectContaining({
      source: ROOT_METHOD,
      target: UNRELATED_FUNCTION,
      style: expect.objectContaining({ opacity: 1 }),
    }));
  });

  it("reprojects exact edges when switching between flows with the same expansion footprint", async () => {
    const store = await impactedFlowReviewStore();
    store.getState().selectFlowEntry({ rootId: ALT_ROOT_METHOD, blockPath: [] });
    await vi.waitFor(() => {
      expect(store.getState().minimalRfEdges).toContainEqual(expect.objectContaining({
        source: ALT_ROOT_METHOD,
        target: TARGET_FUNCTION,
      }));
    });
    const expanded = new Set(store.getState().moduleExpanded);
    const members = [...store.getState().minimalMemberIds];
    const relayout = vi.fn(store.getState().minimalRelayout);
    store.setState({ minimalRelayout: relayout });

    store.getState().selectFlowEntry({ rootId: SECOND_ALT_ROOT_METHOD, blockPath: [] });
    await vi.waitFor(() => {
      const state = store.getState();
      expect(relayout).toHaveBeenCalledTimes(1);
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({
        source: SECOND_ALT_ROOT_METHOD,
        target: TARGET_FUNCTION,
      }));
    });
    expect(store.getState().moduleExpanded).toEqual(expanded);
    expect(store.getState().minimalMemberIds).toEqual(members);
    expect(store.getState().moduleSelected).toEqual(new Set([SECOND_ALT_ROOT_METHOD, TARGET_FUNCTION]));
    const painted = paintMinimalLevel(
      store.getState().minimalRfNodes,
      store.getState().minimalRfEdges,
      store.getState().moduleSelected,
      1,
      "subgraph",
    );
    expect(painted.nodes.find((node) => node.id === ALT_ROOT_METHOD)?.style?.opacity).toBe(0.28);
    expect(painted.edges).toContainEqual(expect.objectContaining({
      source: SECOND_ALT_ROOT_METHOD,
      target: TARGET_FUNCTION,
      style: expect.objectContaining({ opacity: 1 }),
    }));
  });

  it("keeps ordinary graph selection intact when the explorer closes without an active flow", async () => {
    const store = await activeReviewStore();
    store.setState({
      flowExplorerOpen: true,
      moduleSelected: new Set([ROOT_FILE]),
      reviewSelectedId: ROOT_FILE,
      reviewLitNodeIds: new Set([ROOT_METHOD]),
    });

    store.getState().toggleFlowExplorer();
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_FILE]));
    expect(store.getState().reviewSelectedId).toBe(ROOT_FILE);
    expect(store.getState().reviewLitNodeIds).toEqual(new Set([ROOT_METHOD]));
  });

  it("leaves flow review before selecting a real graph node outside that flow", async () => {
    const store = await activeReviewStore();
    store.getState().selectFlowEntry(FLOW_SELECTION);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));

    store.getState().selectModule(ROOT_FILE);
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().logicSelected).toBeNull();
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_FILE]));
    expect(store.getState().reviewSelectedId).toBeNull();

    store.getState().selectFlowEntry(FLOW_SELECTION);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    store.getState().toggleModuleSelect(TARGET_FILE);
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_FILE, TARGET_FILE]));
  });

  it("does not carry a normal base-Map flow into a resumed PR review", async () => {
    const store = await activeReviewStore();
    store.getState().closeMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual([]);

    // With the overlay closed this is the ordinary cross-cutting Code Flow explorer, not review
    // inspection, so it intentionally has no review baseline.
    store.getState().selectFlowEntry(FLOW_SELECTION);
    expect(store.getState().flowSelection).toEqual(FLOW_SELECTION);
    expect(store.getState().reviewFlowBaseline).toBeNull();

    await store.getState().resumePrReview();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    expect(store.getState().minimalSeedIds).toEqual([ROOT_FILE]);
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");
    expect(store.getState().reviewFlowBaseline).toBeNull();
    expect(store.getState().moduleSelected).toEqual(new Set());
  });

  it("does not carry a request telemetry split across a resumed PR artifact", async () => {
    const store = await activeReviewStore();
    store.getState().closeMinimalGraph();
    store.setState({
      flowSelection: null,
      flowPaneOrigin: "request",
      requestFlowTraceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requestFlowExpansionOverrides: new Set(["runtime-occurrence"]),
      flowPaneLayoutStatus: "ready",
    });

    await store.getState().resumePrReview();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));

    expect(store.getState().flowPaneOrigin).toBeNull();
    expect(store.getState().requestFlowTraceId).toBeNull();
    expect(store.getState().requestFlowExpansionOverrides).toEqual(new Set());
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");
  });

  it("preserves ordinary review selection across a soft close and resume when no flow is open", async () => {
    const store = await activeReviewStore();
    store.setState({
      moduleSelected: new Set([ROOT_FILE]),
      reviewSelectedId: ROOT_FILE,
      reviewLitNodeIds: new Set([ROOT_METHOD]),
    });
    store.getState().closeMinimalGraph();

    await store.getState().resumePrReview();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_FILE]));
    expect(store.getState().reviewSelectedId).toBe(ROOT_FILE);
    expect(store.getState().reviewLitNodeIds).toEqual(new Set([ROOT_METHOD]));
  });

  it("restores the pre-flow graph state when the explorer or review overlay closes", async () => {
    const store = await activeReviewStore();
    const moduleExpanded = new Set(store.getState().moduleExpanded);
    const minimalBasePositions = { [ROOT_FILE]: { x: 11, y: 17, width: 210, height: 54 } };
    store.setState({
      flowExplorerOpen: true,
      moduleSelected: new Set([ROOT_FILE]),
      minimalBasePositions,
      minimalArrange: true,
      reviewSelectedId: ROOT_FILE,
      reviewLitNodeIds: new Set([ROOT_METHOD]),
    });
    store.getState().selectFlowEntry(FLOW_SELECTION);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    // Flow inspection is transient even if one of the still-visible graph controls changes its
    // layout curation while the split is open.
    store.setState({ minimalBasePositions: {}, minimalArrange: false });

    store.getState().toggleFlowExplorer();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().moduleExpanded).toEqual(moduleExpanded);
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_FILE]));
    expect(store.getState().minimalBasePositions).toEqual(minimalBasePositions);
    expect(store.getState().minimalArrange).toBe(true);
    expect(store.getState().reviewSelectedId).toBe(ROOT_FILE);
    expect(store.getState().reviewLitNodeIds).toEqual(new Set([ROOT_METHOD]));

    store.setState({ flowExplorerOpen: true });
    store.getState().selectFlowEntry(FLOW_SELECTION);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    store.getState().closeMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");
    expect(store.getState().moduleExpanded).toEqual(moduleExpanded);
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_FILE]));
  });

  it("does not let an in-flight flow layout repopulate a pane that was immediately closed", async () => {
    const store = await activeReviewStore();
    store.getState().selectFlowEntry(FLOW_SELECTION);
    store.getState().selectFlowEntry(null);

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");
    expect(store.getState().flowPaneRfNodes).toEqual([]);
    expect(store.getState().flowPaneRfEdges).toEqual([]);
  });
});
