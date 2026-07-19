import type { GraphArtifact, GraphNode, JsonValue, LogicFlows, RequestTrace } from "@meridian/core";
import { deriveSerializedServiceTopology } from "@meridian/design-metrics";
import { describe, expect, it, vi } from "vitest";
import {
  OVERVIEW_PROJECTION_REQUEST,
  type GraphProjectionActivateOptions,
  type GraphProjectionDataSource,
  type GraphProjectionManifest,
  type GraphProjectionRequest,
  type LoadedGraphProjection,
  type StagedGraphProjection,
} from "../graph/graphProjectionClient";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore, projectionRequestForState } from "./store";
import { frameIdOf } from "../derive/serviceClusterEdges";

const PACKAGE = "ts:src";
const FILE = "ts:src/app.ts";
const UNIT = `${FILE}#App`;
const METHOD = `${UNIT}.run`;

function node(id: string, kind: string, parentId: string | null = null): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file: id, startLine: 1 },
  };
}

const OVERVIEW = artifact([node(PACKAGE, "package")]);
const FOCUSED = artifact([
  node(PACKAGE, "package"),
  node(FILE, "module", PACKAGE),
  node(UNIT, "class", FILE),
]);
const SERVICE = artifact([
  node(PACKAGE, "package"),
  node(FILE, "module", PACKAGE),
  node(UNIT, "class", FILE),
  node(METHOD, "method", UNIT),
]);
const LOGIC: GraphArtifact = {
  ...SERVICE,
  extensions: {
    logicFlow: {
      [METHOD]: [{ kind: "await", label: "complete", mode: "single", inputs: [] }],
    },
  },
};

const TEST_PROJECTION_ENDPOINTS = {
  graphId: "graph-1",
  manifestUrl: "/api/graph/manifest?id=graph-1",
  projectionUrl: "/api/graph/projection?id=graph-1",
  searchUrl: "/api/graph/search?id=graph-1",
};

describe("view-scoped projection store integration", () => {
  it("rejects PR preparation when no projection transport was installed", () => {
    expect(() => createBlueprintStore({
      artifact: OVERVIEW,
      index: buildGraphIndex(OVERVIEW),
      projectionDataSource: null,
      provider: null,
      hasOverlay: false,
      sourceUrl: null,
      prsUrl: "",
      prOneUrl: "",
      prFilesUrl: "",
      prRelatedUrl: "",
      prCommentsUrl: "",
      prChecksUrl: "",
      prReviewUrl: "",
      prepareUrl: "/api/pr/prepare",
      prSessionSource: { repository: "o/r", subdir: "" },
    })).toThrow("PR preparation requires graph projection transport");
  });

  it("keeps overview selectors empty and bounds exact-file review navigation", () => {
    const store = freshStore(null);
    store.setState({
      viewMode: "logic",
      logicRoot: UNIT,
      logicStack: [UNIT],
      expandedLogic: new Set([`${UNIT}.run`]),
      logicInlineDepth: 2,
      moduleSelected: new Set([FILE]),
      minimalMemberIds: Array.from({ length: 1_000 }, (_, index) => `ts:changed-${index}`),
      prReviewed: 42,
      prPreparedArtifactCurrent: true,
      showTests: true,
    });

    const overviewRequest = projectionRequestForState(store.getState());
    expect(overviewRequest).toMatchObject({
      version: 9,
      view: "review",
      reviewCursor: null,
      focusIds: [],
      expandedIds: [],
      extraIds: [],
      causalIds: [],
      serviceExpandedLeadIds: [],
      depth: 3,
      includeTests: true,
      includeReachability: false,
    });

    store.setState({ prPreparedReviewCursor: "file:0" });
    const fileRequest = projectionRequestForState(store.getState());
    expect(fileRequest).toMatchObject({
      version: 9,
      view: "review",
      reviewCursor: "file:0",
      focusIds: [UNIT],
      expandedIds: [],
      extraIds: [FILE],
      depth: 3,
      includeTests: true,
      includeReachability: false,
    });
    expect(JSON.stringify(fileRequest)).not.toContain("changed-999");
  });

  it("translates renderer-only Service frames into real graph anchors", () => {
    const store = freshStore(null);
    const serviceFrame = frameIdOf(UNIT);
    const serviceDomain = "service-domain:folder:src";
    store.setState({
      artifact: FOCUSED,
      index: buildGraphIndex(FOCUSED),
      viewMode: "call",
      moduleFocus: serviceFrame,
      moduleSelected: new Set([serviceFrame, serviceDomain]),
      moduleExpanded: new Set([serviceFrame, serviceDomain]),
    });

    const request = projectionRequestForState(store.getState());

    expect(request).toMatchObject({
      view: "service",
      focusIds: [UNIT],
      extraIds: [UNIT],
      expandedIds: [],
      serviceExpandedLeadIds: [UNIT],
    });
    expect(JSON.stringify(request)).not.toContain("svc:");
    expect(JSON.stringify(request)).not.toContain("service-domain:");
  });

  it("requests only the selected trace's exact real node ids as causal context", () => {
    const store = freshStore(null);
    const selected = requestTrace("1".repeat(32), [UNIT, `${UNIT}.run`, UNIT]);
    const unselected = requestTrace("2".repeat(32), [FILE]);
    store.setState({
      selectedTraceId: selected.traceId,
      requestTraces: [selected, unselected],
      coverageMode: true,
    });

    const request = projectionRequestForState(store.getState());

    expect(request.causalIds).toEqual([UNIT, `${UNIT}.run`]);
    expect(request.includeReachability).toBe(true);
  });

  it("requests the exact static callable whose request-flow occurrence is expanded", () => {
    const store = freshStore(null);
    const trace = requestTrace("1".repeat(32), [UNIT]);
    const occurrenceId = `request:${trace.traceId}:span:${trace.spans[0]!.spanId}:exec::p0/0/p0/0`;
    const projected: GraphArtifact = {
      ...SERVICE,
      extensions: {
        logicFlow: {
          [UNIT]: [{
            kind: "loop",
            label: "loop",
            body: [{ kind: "call", label: "run", target: METHOD, resolution: "resolved" }],
          }],
        },
      },
    };
    store.setState({
      artifact: projected,
      index: buildGraphIndex(projected),
      flowPaneOrigin: "request",
      requestFlowTraceId: trace.traceId,
      requestTraces: [trace],
      requestFlowExpansionOverrides: new Set([occurrenceId]),
      flowPaneRfNodes: [],
    });

    expect(projectionRequestForState(store.getState()).causalIds).toEqual([UNIT, METHOD]);
  });

  it("hydrates a nested request-flow callee to semantic closure before laying it out", async () => {
    const dataSource = new FlowProjectionSource(SERVICE);
    const store = projectedStore(SERVICE, buildGraphIndex(SERVICE), dataSource);
    const trace = requestTrace("1".repeat(32), [UNIT]);
    const spanOccurrence = `request:${trace.traceId}:span:${trace.spans[0]!.spanId}`;
    const nestedCallOccurrence = `${spanOccurrence}:exec::p0/0/p0/0`;
    store.setState({
      selectedTraceId: trace.traceId,
      requestTraces: [trace],
      flowPaneOrigin: "request",
      requestFlowTraceId: trace.traceId,
      requestFlowExpansionOverrides: new Set([spanOccurrence, nestedCallOccurrence]),
    });

    await store.getState().flowPaneRelayout();

    expect(dataSource.requests.map((request) => request.causalIds)).toEqual([
      [UNIT],
      [UNIT, METHOD],
    ]);
    expect(store.getState().flowPaneLayoutStatus).toBe("ready");
    expect(store.getState().flowPaneRfNodes.map((node) => node.id))
      .toContain(`${nestedCallOccurrence}/0`);
  });

  it("fetches the bounded projection before deriving a Minimal Graph scene", async () => {
    const dataSource = new RecordingProjectionSource(FOCUSED);
    const store = freshStore(dataSource);
    store.setState({ minimalSeedIds: [FILE], minimalMemberIds: [FILE] });

    await store.getState().minimalRelayout();

    expect(dataSource.requests).toHaveLength(1);
    expect(dataSource.requests[0]?.request.extraIds).toContain(FILE);
    expect(dataSource.requests[0]?.options.endpoints).toBe(TEST_PROJECTION_ENDPOINTS);
    expect(store.getState().activeProjectionEndpoints).toBe(TEST_PROJECTION_ENDPOINTS);
    expect(store.getState().minimalLayoutStatus).toBe("ready");
  });

  it("rejects ordinary reprojection before transport when the active endpoint pair is missing", async () => {
    const dataSource = new RecordingProjectionSource(FOCUSED);
    const store = freshStore(dataSource, null);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    store.setState({ minimalSeedIds: [FILE], minimalMemberIds: [FILE] });

    try {
      await store.getState().minimalRelayout();
    } finally {
      consoleError.mockRestore();
    }

    expect(dataSource.requests).toHaveLength(0);
    expect(store.getState().minimalLayoutStatus).toBe("error");
    expect(store.getState().activeProjectionEndpoints).toBeNull();
  });

  it("does not start hidden Map work while Extract owns the structural coordinate", async () => {
    const dataSource = new RecordingProjectionSource(FOCUSED, true);
    const store = freshStore(dataSource);
    store.setState({ minimalSeedIds: [FILE], minimalMemberIds: [FILE] });

    const minimal = store.getState().minimalRelayout({ label: "minimal" });
    const module = store.getState().moduleRelayout({ label: "module" });
    await vi.waitFor(() => expect(dataSource.requests).toHaveLength(1));

    expect(dataSource.requests[0]?.options.signal?.aborted).toBe(false);
    dataSource.resolveLatest();
    await Promise.all([minimal, module]);

    expect(dataSource.requests).toHaveLength(1);
    expect(store.getState().minimalLayoutStatus).toBe("ready");
    expect(store.getState().moduleLayoutStatus).toBe("idle");
    expect(store.getState().moduleRfNodes).toEqual([]);
  });

  it("keeps same-coordinate hydration alive when one of several layout subscribers is superseded", async () => {
    const dataSource = new RecordingProjectionSource(FOCUSED, true);
    const store = freshStore(dataSource);
    const trace = requestTrace("1".repeat(32), [PACKAGE]);
    store.setState({
      selectedTraceId: trace.traceId,
      requestTraces: [trace],
      flowPaneOrigin: "request",
      requestFlowTraceId: trace.traceId,
    });

    const outgoingModule = store.getState().moduleRelayout({ label: "outgoing module" });
    await vi.waitFor(() => expect(dataSource.requests).toHaveLength(1));
    const flowPane = store.getState().flowPaneRelayout();
    const currentModule = store.getState().moduleRelayout({ label: "current module" });

    // The old module subscriber leaves immediately, allowing the latest structural request to join
    // the still-live flow subscriber. It must neither abort nor duplicate their shared hydration.
    await outgoingModule;
    expect(dataSource.requests).toHaveLength(1);
    expect(dataSource.requests[0]?.options.signal?.aborted).toBe(false);

    dataSource.resolveLatest();
    await Promise.all([flowPane, currentModule]);
    expect(dataSource.requests).toHaveLength(1);
    expect(store.getState().moduleLayoutStatus).toBe("ready");
    expect(store.getState().flowPaneLayoutStatus).toBe("ready");
  });

  it("activates the focused projection before deriving the module scene", async () => {
    const dataSource = new RecordingProjectionSource(FOCUSED);
    const store = freshStore(dataSource);
    store.setState({ moduleFocus: PACKAGE, moduleExpanded: new Set([FILE]) });

    await store.getState().moduleRelayout();

    expect(dataSource.requests).toHaveLength(1);
    expect(dataSource.requests[0]?.request).toMatchObject({
      view: "modules",
      focusIds: [PACKAGE],
      expandedIds: [FILE],
    });
    expect(store.getState().artifact).toBe(FOCUSED);
    expect(store.getState().activeProjectionKey).toBe("projection-key");
    expect(store.getState().index.nodesById.has(UNIT)).toBe(true);
    expect(store.getState().moduleLayoutStatus).toBe("ready");
  });

  it("aborts a superseded navigation request", async () => {
    const dataSource = new RecordingProjectionSource(FOCUSED, true);
    const store = freshStore(dataSource);
    const first = store.getState().moduleRelayout({ label: "first" });
    await vi.waitFor(() => expect(dataSource.requests).toHaveLength(1));
    store.setState({ moduleFocus: PACKAGE });
    const second = store.getState().moduleRelayout({ label: "second" });
    await vi.waitFor(() => expect(dataSource.requests).toHaveLength(2));

    expect(dataSource.requests[0]?.options.signal?.aborted).toBe(true);
    dataSource.resolveLatest();
    await Promise.all([first, second]);
    expect(store.getState().moduleLayoutStatus).toBe("ready");
  });

  it("hydrates Service before resolving a selected bounded-Map anchor, then loads the exact final coordinate", async () => {
    const dataSource = new DestinationProjectionSource(SERVICE);
    const store = projectedStore(SERVICE, boundedIndex(SERVICE, null), dataSource);
    store.setState({ moduleSelected: new Set([METHOD]) });

    store.getState().setViewMode("call");
    await vi.waitFor(() => expect(store.getState().moduleLayoutStatus).toBe("ready"));

    expect(dataSource.requests).toHaveLength(2);
    expect(dataSource.requests[0]).toMatchObject({
      view: "service",
      extraIds: [METHOD],
      serviceExpandedLeadIds: [],
    });
    expect(dataSource.requests[1]).toMatchObject({
      view: "service",
      extraIds: [METHOD],
      serviceExpandedLeadIds: [UNIT],
    });
    expect(store.getState().index.serviceTopology).not.toBeNull();
    expect(store.getState().moduleExpanded).toContain(frameIdOf(UNIT));
    expect(store.getState().serviceScope?.leadIds).toContain(UNIT);
  });

  it("enters Logic and PR views from a selected bounded Map without reading Service or graph projections", () => {
    const logicSource = new DestinationProjectionSource(SERVICE);
    const logicStore = projectedStore(SERVICE, boundedIndex(SERVICE, null), logicSource);
    logicStore.setState({ moduleSelected: new Set([METHOD]) });

    logicStore.getState().setViewMode("logic");

    expect(logicStore.getState().viewMode).toBe("logic");
    expect(logicSource.requests).toEqual([]);

    const prsSource = new DestinationProjectionSource(SERVICE);
    const prsStore = projectedStore(SERVICE, boundedIndex(SERVICE, null), prsSource, true);
    prsStore.setState({
      moduleSelected: new Set([METHOD]),
      prsList: { ...prsStore.getState().prsList, open: [] },
    });

    prsStore.getState().setViewMode("prs");

    expect(prsStore.getState().viewMode).toBe("prs");
    expect(prsSource.requests).toEqual([]);
  });

  it("does not let a deferred Service projection commit after Logic supersedes it", async () => {
    const dataSource = new RecordingProjectionSource(SERVICE, true, true);
    dataSource.activeKey = "visible-projection-key";
    const store = projectedStore(SERVICE, boundedIndex(SERVICE, null), dataSource);
    store.setState({
      activeProjectionKey: "visible-projection-key",
      moduleSelected: new Set([METHOD]),
    });
    const visibleArtifact = store.getState().artifact;
    const visibleIndex = store.getState().index;

    store.getState().setViewMode("call");
    await vi.waitFor(() => expect(dataSource.requests).toHaveLength(1));
    store.getState().setViewMode("logic");

    expect(dataSource.requests[0]?.options.signal?.aborted).toBe(true);
    expect(store.getState().viewMode).toBe("logic");
    expect(store.getState().index.serviceTopology).toBeNull();
    dataSource.resolveLatest();
    await vi.waitFor(() => expect(dataSource.stageDeliveries).toBe(1));

    expect(dataSource.activeKey).toBe("visible-projection-key");
    expect(store.getState().activeProjectionKey).toBe("visible-projection-key");
    expect(store.getState().artifact).toBe(visibleArtifact);
    expect(store.getState().index).toBe(visibleIndex);
  });

  it("does not let abort-ignorant outgoing hydration block or overwrite current Logic", async () => {
    const dataSource = new OutOfOrderProjectionSource(LOGIC);
    const store = freshStore(dataSource);
    const outgoingModule = store.getState().moduleRelayout({ label: "outgoing module" });
    await vi.waitFor(() => expect(dataSource.requests).toHaveLength(1));

    store.setState({ logicRoot: METHOD });
    store.getState().setViewMode("logic");
    await vi.waitFor(() => expect(dataSource.requests).toHaveLength(2));
    expect(dataSource.requests[0]?.options.signal?.aborted).toBe(true);
    expect(dataSource.requests[1]?.options.signal?.aborted).toBe(false);

    dataSource.resolve(1);
    await vi.waitFor(() => expect(store.getState().logicLayoutStatus).toBe("ready"));
    expect(dataSource.activeKey).toBe("projection-1");
    expect(store.getState().activeProjectionKey).toBe("projection-1");

    // The first transport deliberately drains after abort. Its staged projection is released and
    // cannot regain ownership after the current Logic coordinate has committed.
    dataSource.resolve(0);
    await vi.waitFor(() => expect(dataSource.stageDeliveries).toBe(2));
    await outgoingModule;
    expect(dataSource.activeKey).toBe("projection-1");
    expect(store.getState().activeProjectionKey).toBe("projection-1");
    expect(store.getState().viewMode).toBe("logic");
  });
});

class DestinationProjectionSource implements GraphProjectionDataSource {
  activeKey: string | undefined;
  readonly requests: GraphProjectionRequest[] = [];

  constructor(private readonly projected: GraphArtifact) {}

  loadManifest(): Promise<GraphProjectionManifest> {
    return Promise.resolve(manifestFor(this.projected));
  }

  stage(request: GraphProjectionRequest): Promise<StagedGraphProjection> {
    this.requests.push(request);
    const key = `projection-${this.requests.length}`;
    const result: LoadedGraphProjection = {
      key,
      projectionId: key,
      graphId: "graph-1",
      request,
      artifact: this.projected,
      index: boundedIndex(
        this.projected,
        request.view === "service" ? deriveSerializedServiceTopology(this.projected.nodes, this.projected.edges) : null,
      ),
      reachability: null,
      review: null,
      serializedBytes: 100,
      residentBytes: 300,
    };
    return Promise.resolve(stagedGraph(result, () => { this.activeKey = key; }));
  }

  stageCached(): StagedGraphProjection | undefined { return undefined; }
  stageReviewPair(): Promise<never> { return Promise.reject(new Error("review pair not used")); }
  stageCachedReview(): undefined { return undefined; }
  discardInactiveReviewProjections(): void {}
  searchSymbols(): Promise<never> { return Promise.reject(new Error("symbol search not used")); }
}

class FlowProjectionSource implements GraphProjectionDataSource {
  activeKey: string | undefined;
  readonly requests: GraphProjectionRequest[] = [];

  constructor(private readonly projected: GraphArtifact) {}

  loadManifest(): Promise<GraphProjectionManifest> {
    return Promise.resolve(manifestFor(this.projected));
  }

  stage(request: GraphProjectionRequest): Promise<StagedGraphProjection> {
    this.requests.push(request);
    const flows: LogicFlows = {};
    if (request.causalIds.includes(UNIT)) {
      flows[UNIT] = [{
        kind: "loop",
        label: "loop",
        body: [{ kind: "call", label: "run", target: METHOD, resolution: "resolved" }],
      }];
    }
    if (request.causalIds.includes(METHOD)) {
      flows[METHOD] = [{ kind: "await", label: "complete", mode: "single", inputs: [] }];
    }
    const artifact: GraphArtifact = {
      ...this.projected,
      ...(Object.keys(flows).length === 0
        ? {}
        : { extensions: { logicFlow: flows as unknown as JsonValue } }),
    };
    const key = `flow-projection-${this.requests.length}`;
    const result: LoadedGraphProjection = {
      key,
      projectionId: key,
      graphId: "graph-1",
      request,
      artifact,
      index: buildGraphIndex(artifact),
      reachability: null,
      review: null,
      serializedBytes: 100,
      residentBytes: 300,
    };
    return Promise.resolve(stagedGraph(result, () => { this.activeKey = key; }));
  }

  stageCached(): StagedGraphProjection | undefined { return undefined; }
  stageReviewPair(): Promise<never> { return Promise.reject(new Error("review pair not used")); }
  stageCachedReview(): undefined { return undefined; }
  discardInactiveReviewProjections(): void {}
  searchSymbols(): Promise<never> { return Promise.reject(new Error("symbol search not used")); }
}

class RecordingProjectionSource implements GraphProjectionDataSource {
  activeKey: string | undefined;
  stageDeliveries = 0;
  readonly requests: Array<{ request: GraphProjectionRequest; options: GraphProjectionActivateOptions }> = [];
  private latestResolve: ((projection: LoadedGraphProjection) => void) | null = null;

  constructor(
    private readonly projected: GraphArtifact,
    private readonly deferred = false,
    private readonly ignoreAbort = false,
  ) {}

  async loadManifest(): Promise<GraphProjectionManifest> {
    return {
      version: 9,
      graphId: "graph-1",
      contentId: "0".repeat(64),
      graphSummary: {
        schemaVersion: OVERVIEW.schemaVersion,
        generatedAt: OVERVIEW.generatedAt,
        nodeCount: OVERVIEW.nodes.length,
        edgeCount: OVERVIEW.edges.length,
      },
      repositorySummary: buildGraphIndex(OVERVIEW).structure.repositorySummary,
      defaultView: OVERVIEW_PROJECTION_REQUEST,
    };
  }

  stage(
    request: GraphProjectionRequest,
    options: GraphProjectionActivateOptions,
  ): Promise<StagedGraphProjection> {
    this.requests.push({ request, options });
    if (!this.deferred) {
      const projection = this.projection(request);
      return Promise.resolve(stagedGraph(projection, () => { this.activeKey = projection.key; }));
    }
    return new Promise<LoadedGraphProjection>((resolve, reject) => {
      this.latestResolve = resolve;
      if (!this.ignoreAbort) {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }
    }).then((projection) => {
      this.stageDeliveries += 1;
      return stagedGraph(projection, () => { this.activeKey = projection.key; });
    });
  }

  stageCached(): StagedGraphProjection | undefined {
    return undefined;
  }

  stageReviewPair(): Promise<never> {
    throw new Error("review pair is not exercised by this focused module-navigation source");
  }

  stageCachedReview(): undefined { return undefined; }

  discardInactiveReviewProjections(): void {}

  searchSymbols(): Promise<never> {
    return Promise.reject(new Error("symbol search is not exercised by this projection source"));
  }

  resolveLatest(): void {
    this.latestResolve?.(this.projection(this.requests.at(-1)!.request));
  }

  private projection(request: GraphProjectionRequest): LoadedGraphProjection {
    const result: LoadedGraphProjection = {
      key: "projection-key",
      projectionId: "projection-id",
      graphId: "graph-1",
      request,
      artifact: this.projected,
      index: buildGraphIndex(this.projected),
      reachability: null,
      review: null,
      serializedBytes: 100,
      residentBytes: 300,
    };
    return result;
  }
}

class OutOfOrderProjectionSource implements GraphProjectionDataSource {
  activeKey: string | undefined;
  stageDeliveries = 0;
  readonly requests: Array<{ request: GraphProjectionRequest; options: GraphProjectionActivateOptions }> = [];
  private readonly resolvers = new Map<number, () => void>();

  constructor(private readonly projected: GraphArtifact) {}

  loadManifest(): Promise<GraphProjectionManifest> {
    return Promise.resolve(manifestFor(this.projected));
  }

  stage(
    request: GraphProjectionRequest,
    options: GraphProjectionActivateOptions,
  ): Promise<StagedGraphProjection> {
    const index = this.requests.push({ request, options }) - 1;
    return new Promise<void>((resolve) => {
      this.resolvers.set(index, resolve);
      // Deliberately ignore AbortSignal: lifecycle correctness cannot rely on a cooperative transport.
    }).then(() => {
      this.stageDeliveries += 1;
      const key = `projection-${index}`;
      const projection: LoadedGraphProjection = {
        key,
        projectionId: key,
        graphId: "graph-1",
        request,
        artifact: this.projected,
        index: buildGraphIndex(this.projected),
        reachability: null,
        review: null,
        serializedBytes: 100,
        residentBytes: 300,
      };
      return stagedGraph(projection, () => { this.activeKey = key; });
    });
  }

  resolve(index: number): void {
    const resolve = this.resolvers.get(index);
    if (resolve === undefined) throw new Error(`missing deferred projection ${index}`);
    this.resolvers.delete(index);
    resolve();
  }

  stageCached(): StagedGraphProjection | undefined { return undefined; }
  stageReviewPair(): Promise<never> { return Promise.reject(new Error("review pair not used")); }
  stageCachedReview(): undefined { return undefined; }
  discardInactiveReviewProjections(): void {}
  searchSymbols(): Promise<never> { return Promise.reject(new Error("symbol search not used")); }
}

function stagedGraph(
  projection: LoadedGraphProjection,
  onCommit: () => void,
): StagedGraphProjection {
  let released = false;
  let committed = false;
  const read = () => {
    if (released) throw new Error("test graph stage was released");
    return projection;
  };
  return {
    get projection() { return read(); },
    commit: () => {
      const current = read();
      if (!committed) {
        committed = true;
        onCommit();
      }
      return current;
    },
    release: () => {
      if (!committed) released = true;
    },
  };
}

function freshStore(
  projectionDataSource: GraphProjectionDataSource | null,
  projectionEndpoints = projectionDataSource === null ? null : TEST_PROJECTION_ENDPOINTS,
) {
  return createBlueprintStore({
    artifact: OVERVIEW,
    index: buildGraphIndex(OVERVIEW),
    projectionDataSource,
    ...(projectionEndpoints === null ? {} : { projectionEndpoints }),
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "",
    prOneUrl: "",
    prFilesUrl: "",
    prRelatedUrl: "",
    prCommentsUrl: "",
    prChecksUrl: "",
    prReviewUrl: "",
  });
}

function projectedStore(
  graph: GraphArtifact,
  index: ReturnType<typeof buildGraphIndex>,
  projectionDataSource: GraphProjectionDataSource,
  github = false,
) {
  return createBlueprintStore({
    artifact: graph,
    index,
    projectionDataSource,
    projectionEndpoints: TEST_PROJECTION_ENDPOINTS,
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "",
    prOneUrl: "",
    prFilesUrl: "",
    prRelatedUrl: "",
    prCommentsUrl: "",
    prChecksUrl: "",
    prReviewUrl: "",
    ...(github ? { prSessionSource: { repository: "o/r", subdir: "" } } : {}),
  });
}

function boundedIndex(
  graph: GraphArtifact,
  serviceTopology: ReturnType<typeof deriveSerializedServiceTopology> | null,
) {
  const complete = buildGraphIndex(graph);
  return buildGraphIndex(graph, {
    structure: complete.structure,
    graphSummary: complete.graphSummary,
    serviceTopology,
    artifactComplete: false,
  });
}

function manifestFor(graph: GraphArtifact): GraphProjectionManifest {
  const index = buildGraphIndex(graph);
  return {
    version: 9,
    graphId: "graph-1",
    contentId: "0".repeat(64),
    graphSummary: index.graphSummary,
    repositorySummary: index.structure.repositorySummary,
    defaultView: OVERVIEW_PROJECTION_REQUEST,
  };
}

function artifact(nodes: GraphNode[]): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-14T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "repo", root: ".", language: "typescript" },
    nodes,
    edges: [],
  };
}

function requestTrace(traceId: string, nodeIds: readonly string[]): RequestTrace {
  return {
    traceId,
    name: "projection selectors",
    rootSpanId: "1".repeat(16),
    startedAtUnixNano: "1000000000",
    endedAtUnixNano: "1001000000",
    status: "ok",
    attributes: {},
    spans: nodeIds.map((nodeId, index) => ({
      spanId: (index + 1).toString(16).padStart(16, "0"),
      nodeId,
      name: nodeId,
      kind: index === 0 ? "server" : "internal",
      startedAtUnixNano: String(1_000_000_000 + index * 100_000),
      endedAtUnixNano: String(1_000_050_000 + index * 100_000),
      status: "ok",
      attributes: {},
      events: [],
    })),
    completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
  };
}
