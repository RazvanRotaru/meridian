import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import {
  OVERVIEW_PROJECTION_REQUEST,
  type GraphProjectionDataSource,
  type GraphProjectionRequest,
  type LoadedGraphProjection,
} from "../graph/graphProjectionClient";
import type { TelemetryProvider, TelemetrySourceRegistration } from "../telemetry/provider";
import { createBlueprintStore, type BlueprintState } from "./store";
import { RecentViewProjectionCache } from "./recentViewProjectionCache";
import { restoreFromUrl, startUrlSync } from "./urlSync";
import { DEFAULT_NAV, mergeNavIntoSearch } from "./urlState";

const PACKAGE_ID = "ts:src";
const FILE_ID = "ts:src/a.ts";

const BOOT_ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-01T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    { id: PACKAGE_ID, kind: "package", qualifiedName: PACKAGE_ID, displayName: "src", location: { file: "src", startLine: 1 } },
    { id: FILE_ID, kind: "module", qualifiedName: FILE_ID, displayName: "a.ts", parentId: PACKAGE_ID, location: { file: "src/a.ts", startLine: 1 } },
  ],
  edges: [],
};

const HEAD_ARTIFACT: GraphArtifact = {
  ...BOOT_ARTIFACT,
  generatedAt: "2026-07-02T00:00:00.000Z",
};

const BOOT_REQUEST: GraphProjectionRequest = {
  ...OVERVIEW_PROJECTION_REQUEST,
};

function freshStore(
  telemetry?: {
    provider: TelemetryProvider;
    sources: TelemetrySourceRegistration[];
  },
  projectionSource?: (initial: LoadedGraphProjection) => GraphProjectionDataSource,
) {
  const bootIndex = buildGraphIndex(BOOT_ARTIFACT);
  const initialProjection: LoadedGraphProjection = {
    key: "boot-projection-key",
    projectionId: "boot-projection-id",
    graphId: "artifact-1",
    request: BOOT_REQUEST,
    artifact: BOOT_ARTIFACT,
    index: bootIndex,
    reachability: null,
    review: null,
    serializedBytes: 100,
    residentBytes: 300,
  };
  const defaultProjectionDataSource: GraphProjectionDataSource = {
    activeKey: initialProjection.key,
    loadManifest: async () => ({
      version: 9,
      graphId: "artifact-1",
      contentId: "0".repeat(64),
      graphSummary: {
        schemaVersion: BOOT_ARTIFACT.schemaVersion,
        generatedAt: BOOT_ARTIFACT.generatedAt,
        nodeCount: BOOT_ARTIFACT.nodes.length,
        edgeCount: BOOT_ARTIFACT.edges.length,
      },
      repositorySummary: bootIndex.structure.repositorySummary,
      defaultView: BOOT_REQUEST,
    }),
    stage: async () => ({
      projection: initialProjection,
      commit: () => initialProjection,
      release: () => {},
    }),
    stageCached: (key) => key === initialProjection.key
      ? {
          projection: initialProjection,
          commit: () => initialProjection,
          release: () => {},
        }
      : undefined,
    stageReviewPair: async () => { throw new Error("review pair is not loaded during URL exit"); },
    stageCachedReview: () => undefined,
    discardInactiveReviewProjections: () => {},
    searchSymbols: async () => { throw new Error("symbol search is not loaded during URL exit"); },
  };
  const projectionDataSource = projectionSource?.(initialProjection) ?? defaultProjectionDataSource;
  return createBlueprintStore({
    artifact: BOOT_ARTIFACT,
    index: bootIndex,
    projectionDataSource,
    initialProjection,
    projectionEndpoints: {
      graphId: "artifact-1",
      manifestUrl: "/api/graph/manifest?id=artifact-1",
      projectionUrl: "/api/graph/projection?id=artifact-1",
      searchUrl: "/api/graph/search?id=artifact-1",
    },
    provider: telemetry?.provider ?? null,
    ...(telemetry === undefined ? {} : { telemetrySources: telemetry.sources }),
    hasOverlay: telemetry !== undefined,
    sourceUrl: null,
    prsUrl: "/api/prs?id=artifact-1",
    prOneUrl: "/api/prs/one?id=artifact-1",
    prFilesUrl: "/api/prs/files?id=artifact-1",
    prRelatedUrl: "/api/prs/related?id=artifact-1",
    prCommentsUrl: "/api/prs/comments?id=artifact-1",
    prChecksUrl: "/api/prs/checks?id=artifact-1",
    prReviewUrl: "/api/prs/review?id=artifact-1",
  });
}

function stubWindow(): void {
  vi.stubGlobal("window", {
    location: { origin: "http://meridian.local", search: "", pathname: "/", hash: "" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("restoreFromUrl review exit", () => {
  it("restores an extracted review's prior graph before applying a pre-review Map URL", async () => {
    const store = freshStore();
    const bootIndex = store.getState().index;
    store.setState({
      artifact: HEAD_ARTIFACT,
      index: buildGraphIndex(HEAD_ARTIFACT),
      activeProjectionGraphId: "pr-head-7",
      activeProjectionRequest: { ...BOOT_REQUEST, view: "review" },
      activeProjectionKey: "head-projection-key",
      activeProjectionId: "head-projection-id",
      prReviewBaseline: {
        graphId: "artifact-1",
        request: BOOT_REQUEST,
        projectionKey: "boot-projection-key",
        projectionId: "boot-projection-id",
        endpoints: {
          graphId: "artifact-1",
          manifestUrl: "/api/graph/manifest?id=artifact-1",
          projectionUrl: "/api/graph/projection?id=artifact-1",
          searchUrl: "/api/graph/search?id=artifact-1",
        },
        syntheticExecutionUrl: null,
        syntheticScenarios: [],
        syntheticExecutionTrust: null,
      },
      prReviewed: 7,
      prSelected: 7,
      prPreparedHead: preparedDescriptor("pr-head-7"),
      prPreparedMergeBase: preparedDescriptor("pr-head-7-base"),
      prPreparedReviewCursor: "file:0",
      prPreparedChangedFiles: [{ path: "src/a.ts", status: "modified" }],
      prPreparedHeadSha: "abc123",
      prPreparedArtifactCurrent: true,
      minimalSeedIds: [FILE_ID],
      minimalMemberIds: [FILE_ID],
    });
    stubWindow();

    await restoreFromUrl(store, `mfocus=${encodeURIComponent(PACKAGE_ID)}`);

    expect(store.getState().artifact).toBe(BOOT_ARTIFACT);
    expect(store.getState().index).toBe(bootIndex);
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().prSelected).toBe(null);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().prPreparedHead).toBe(null);
    expect(store.getState().minimalSeedIds).toEqual([]);
    // The baseline restore ran first; the target URL's Map focus therefore wins afterward.
    expect(store.getState().moduleFocus).toBe(PACKAGE_ID);
  });

  it("clears split identity and both pane-owned expansion sets during structural history restore", async () => {
    const store = freshStore();
    store.setState({
      flowPaneOrigin: "request",
      requestFlowTraceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requestFlowExpansionOverrides: new Set(["request:span:one"]),
      flowPaneExpansionOverrides: new Set(["static-occurrence"]),
      flowPaneLayoutStatus: "ready",
      reviewFocusedSubgraph: {
        rootId: PACKAGE_ID,
        label: "src",
        filePaths: ["src/a.ts"],
        moduleIds: [FILE_ID],
      },
    });
    stubWindow();

    await restoreFromUrl(store, `mfocus=${encodeURIComponent(PACKAGE_ID)}`);

    expect(store.getState().flowPaneOrigin).toBeNull();
    expect(store.getState().requestFlowTraceId).toBeNull();
    expect(store.getState().requestFlowExpansionOverrides).toEqual(new Set());
    expect(store.getState().flowPaneExpansionOverrides).toEqual(new Set());
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");
    expect(store.getState().reviewFocusedSubgraph).toBeNull();
  });

  it("releases every outgoing scene owner before publishing a restored coordinate", async () => {
    const store = freshStore();
    const clearSceneCache = vi.spyOn(RecentViewProjectionCache.prototype, "clear");
    store.setState({
      moduleRfNodes: [{ id: "stale-module" } as BlueprintState["moduleRfNodes"][number]],
      logicRfNodes: [{ id: "stale-logic" } as BlueprintState["logicRfNodes"][number]],
      minimalRfNodes: [{ id: "stale-minimal" } as BlueprintState["minimalRfNodes"][number]],
      flowPaneRfNodes: [{ id: "stale-flow" } as BlueprintState["flowPaneRfNodes"][number]],
      moduleSelected: new Set([FILE_ID]),
      mapExtra: new Set([FILE_ID]),
      mapGhostPins: new Map([[FILE_ID, new Set([FILE_ID])]]),
      logicFocus: [{ id: FILE_ID, label: "stale", bodies: [] }],
      expandedLogic: new Set([FILE_ID]),
      collapsedLogicEdges: new Set(["stale-edge"]),
      minimalProjectionExtraIds: new Set([FILE_ID]),
      minimalBasePositions: {
        [FILE_ID]: { x: 1, y: 2, width: 3, height: 4 },
      },
      minimalCodebaseTargetIds: [FILE_ID],
      minimalCodebaseRetainedExpandedIds: new Set([FILE_ID]),
      minimalCodebaseProjectionPending: true,
    });
    stubWindow();
    let firstTarget: BlueprintState | null = null;
    const unsubscribe = store.subscribe((state) => {
      if (firstTarget === null && state.viewMode === "logic") firstTarget = state;
    });

    await restoreFromUrl(store, `view=logic&lroot=${encodeURIComponent(FILE_ID)}`);
    unsubscribe();

    expect(clearSceneCache).toHaveBeenCalled();
    expect(firstTarget).not.toBeNull();
    expect(firstTarget!).toMatchObject({
      viewMode: "logic",
      logicRoot: FILE_ID,
      moduleRfNodes: [],
      logicRfNodes: [],
      minimalRfNodes: [],
      flowPaneRfNodes: [],
      minimalBasePositions: {},
      minimalCodebaseTargetIds: [],
      minimalCodebaseProjectionPending: false,
    });
    expect(firstTarget!.moduleSelected).toEqual(new Set());
    expect(firstTarget!.mapExtra).toEqual(new Set());
    expect(firstTarget!.mapGhostPins).toEqual(new Map());
    expect(firstTarget!.logicFocus).toEqual([]);
    expect(firstTarget!.expandedLogic).toEqual(new Set());
    expect(firstTarget!.collapsedLogicEdges).toEqual(new Set());
    expect(firstTarget!.minimalProjectionExtraIds).toEqual(new Set());
    expect(firstTarget!.minimalCodebaseRetainedExpandedIds).toEqual(new Set());
  });

  it("discards a confirmed session-only line composer before history changes its host", async () => {
    const store = freshStore();
    store.setState({
      review: {
        context: {
          changedFiles: [{ path: "src/a.ts", status: "modified", hunks: [{ start: 1, end: 1 }] }],
          baseRef: "main",
          baseSha: "base",
          headRef: "feature",
          reviewKey: "artifact-history-draft",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
    });
    store.getState().openReviewLineComposer("src/a.ts", 1);
    store.getState().setReviewLineComposerBody("Do not leave this invisible");
    stubWindow();

    await restoreFromUrl(store, "view=logic");

    expect(store.getState().viewMode).toBe("logic");
    expect(store.getState().reviewLineComposer).toBeNull();
  });

  it("enters telemetry mode for a deep-linked request trace", async () => {
    const store = freshStore();
    stubWindow();
    const search = new URLSearchParams({
      view: "logic",
      lroot: FILE_ID,
      lview: "request",
    }).toString();

    await restoreFromUrl(store, search);

    expect(store.getState()).toMatchObject({
      viewMode: "logic",
      logicRoot: FILE_ID,
      logicView: "request",
      telemetryMode: true,
    });
  });

  it("restores an explicit telemetry source before an arbitrary environment", async () => {
    const provider: TelemetryProvider = {
      id: "demo",
      requiresEnvironment: true,
      listEnvironments: () => ["demo"],
      fetchMetrics: async () => ({}),
      fetchTraces: async () => { throw new Error("metrics-only test provider"); },
    };
    const source: TelemetrySourceRegistration = {
      id: "demo",
      kind: "mock",
      label: "Synthetic demo",
      provenance: "synthetic",
      environments: ["demo"],
      environmentMode: "arbitrary",
      supportsMetrics: false,
      supportsTraces: false,
      provider,
    };
    const store = freshStore({ provider, sources: [source] });
    stubWindow();

    await restoreFromUrl(store, "tsrc=demo&env=qa-west");

    expect(store.getState().telemetrySourceId).toBe("demo");
    expect(store.getState().provider).toBe(provider);
    expect(store.getState().environment).toBe("qa-west");
  });

  it("skips the base layout and awaits the restored review plus its visible flow scene", async () => {
    const store = freshStore();
    stubWindow();
    const summary = {
      number: 7,
      title: "Prepared review",
      body: null,
      author: "octo",
      headRef: "feature",
      headSha: "a".repeat(40),
      baseRef: "main",
      updatedAt: "2026-07-16T00:00:00.000Z",
      draft: false,
      state: "open" as const,
      url: "https://github.com/o/r/pull/7",
    };
    const relayout = vi.fn(async () => {});
    let releaseReview!: () => void;
    const reviewLayout = new Promise<void>((resolve) => { releaseReview = resolve; });
    let releaseFlow!: () => void;
    const flowLayout = new Promise<void>((resolve) => { releaseFlow = resolve; });
    let releaseTarget!: () => void;
    const targetLayout = new Promise<void>((resolve) => { releaseTarget = resolve; });
    const ensurePrSummary = vi.fn(async () => {});
    const selectPr: BlueprintState["selectPr"] = vi.fn(async (number) => {
      store.setState({
        prSelected: number,
        prFiles: number === null ? null : [{
          path: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          hunks: [{ start: 1, end: 1 }],
        }],
      });
    });
    const reviewPrInGraph: BlueprintState["reviewPrInGraph"] = vi.fn(async (options) => {
      options?.onVisibleLayoutStart?.();
      await reviewLayout;
      store.setState({ prReviewed: 7, viewMode: "modules", minimalSeedIds: [FILE_ID], minimalMemberIds: [FILE_ID] });
    });
    const selectFlowEntry: BlueprintState["selectFlowEntry"] = vi.fn(async () => { await flowLayout; });
    const selectFlowPaneTarget: BlueprintState["selectFlowPaneTarget"] = vi.fn(async () => { await targetLayout; });
    store.setState({
      prsList: { open: [summary], closed: null },
      ensurePrSummary,
      selectPr,
      reviewPrInGraph,
      selectFlowEntry,
      selectFlowPaneTarget,
      relayout,
    });
    const flowSelection = { rootId: `${FILE_ID}#run`, blockPath: [] };
    const search = mergeNavIntoSearch("", {
      ...DEFAULT_NAV,
      flowSelection,
      logicSelected: FILE_ID,
      minimalSeedIds: [FILE_ID],
      reviewPr: 7,
      reviewActive: true,
    });

    let restored = false;
    const hydration = restoreFromUrl(store, search).then(() => { restored = true; });
    await vi.waitFor(() => expect(reviewPrInGraph).toHaveBeenCalledOnce());
    expect(relayout).not.toHaveBeenCalled();
    expect(restored).toBe(false);

    releaseReview();
    await vi.waitFor(() => expect(selectFlowEntry).toHaveBeenCalledWith(flowSelection));
    expect(restored).toBe(false);
    releaseFlow();
    await vi.waitFor(() => expect(selectFlowPaneTarget).toHaveBeenCalledWith(FILE_ID));
    expect(restored).toBe(false);
    releaseTarget();
    await hydration;
    expect(restored).toBe(true);
  });

  it.each([
    { label: "a different active review", current: 3, prepared: true },
    { label: "the same active review", current: 7, prepared: true },
    { label: "the same parked review", current: 7, prepared: false },
  ])("retires $label before publishing and preparing a review URL", async ({ current, prepared }) => {
    const store = freshStore();
    stubWindow();
    const order: string[] = [];
    const retirePrReviewForReplacement: BlueprintState["retirePrReviewForReplacement"] = vi.fn(async () => {
      order.push("retire");
      expect(store.getState().prReviewed).toBe(current);
      store.setState({ prReviewed: null, prPreparedArtifactCurrent: false });
      return true;
    });
    const restorePreparedPrReview: BlueprintState["restorePreparedPrReview"] = vi.fn(async (number) => {
      order.push("prepare");
      expect(number).toBe(7);
      expect(store.getState()).toMatchObject({
        prReviewed: null,
        prPreparedArtifactCurrent: false,
        viewMode: "prs",
      });
      return true;
    });
    store.setState({
      prReviewed: current,
      prSelected: current,
      prPreparedArtifactCurrent: prepared,
      viewMode: prepared ? "modules" : "prs",
      retirePrReviewForReplacement,
      restorePreparedPrReview,
    });
    const search = mergeNavIntoSearch("", {
      ...DEFAULT_NAV,
      reviewPr: 7,
      reviewActive: true,
    });

    await restoreFromUrl(store, search);

    expect(order).toEqual(["retire", "prepare"]);
    expect(retirePrReviewForReplacement).toHaveBeenCalledOnce();
    expect(restorePreparedPrReview).toHaveBeenCalledOnce();
  });

});

describe("startUrlSync extraction history", () => {
  it("supersedes a delayed prepared restore so the newest popstate wins immediately", async () => {
    const provider: TelemetryProvider = {
      id: "demo",
      requiresEnvironment: true,
      listEnvironments: () => ["demo"],
      fetchMetrics: async () => ({}),
      fetchTraces: async () => { throw new Error("metrics-only test provider"); },
    };
    const source: TelemetrySourceRegistration = {
      id: "demo",
      kind: "mock",
      label: "Synthetic demo",
      provenance: "synthetic",
      environments: ["demo"],
      environmentMode: "enumerated",
      supportsMetrics: false,
      supportsTraces: false,
      provider,
    };
    const store = freshStore({ provider, sources: [source] });
    const browser = stubUrlSyncBrowser();
    let releaseStaleHandoff!: () => void;
    const staleHandoff = new Promise<void>((resolve) => { releaseStaleHandoff = resolve; });
    const restorePreparedPrReview: BlueprintState["restorePreparedPrReview"] = vi.fn(async () => {
      store.setState({ prReviewStatus: "preparing" });
      await staleHandoff;
      return true;
    });
    const logicRelayout = vi.fn(async () => {});
    const selectFlowEntry: BlueprintState["selectFlowEntry"] = vi.fn(async () => {});
    const selectFlowPaneTarget: BlueprintState["selectFlowPaneTarget"] = vi.fn(async () => {});
    const setTelemetrySource: BlueprintState["setTelemetrySource"] = vi.fn();
    const setEnvironment: BlueprintState["setEnvironment"] = vi.fn();
    store.setState({
      restorePreparedPrReview,
      logicRelayout,
      selectFlowEntry,
      selectFlowPaneTarget,
      setTelemetrySource,
      setEnvironment,
    });
    await restoreFromUrl(store, "");
    const stop = startUrlSync(store);
    const staleFlow = { rootId: `${FILE_ID}#run`, blockPath: [] };
    const staleSearch = mergeNavIntoSearch("", {
      ...DEFAULT_NAV,
      flowExplorerOpen: true,
      flowSelection: staleFlow,
      logicSelected: FILE_ID,
      minimalSeedIds: [FILE_ID],
      reviewPr: 7,
      reviewActive: true,
      telemetrySourceId: "demo",
      environment: "demo",
    });
    const newestSearch = mergeNavIntoSearch("", {
      ...DEFAULT_NAV,
      viewMode: "logic",
      logicRoot: PACKAGE_ID,
    });

    browser.popTo(staleSearch);
    await vi.waitFor(() => expect(restorePreparedPrReview).toHaveBeenCalledOnce());

    // The second event must lay out and commit its own entry before the first handoff settles.
    browser.popTo(newestSearch);
    await vi.waitFor(() => expect(logicRelayout).toHaveBeenCalledOnce());
    expect(store.getState()).toMatchObject({ viewMode: "logic", logicRoot: PACKAGE_ID });
    expect(browser.location.search).toBe(`?${newestSearch}`);
    expect(selectFlowEntry).not.toHaveBeenCalled();
    expect(selectFlowPaneTarget).not.toHaveBeenCalled();
    expect(setTelemetrySource).not.toHaveBeenCalled();
    expect(setEnvironment).not.toHaveBeenCalled();

    // Draining the canceled promise cannot replay the stale flow or coordinates afterward.
    releaseStaleHandoff();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState()).toMatchObject({ viewMode: "logic", logicRoot: PACKAGE_ID });
    expect(selectFlowEntry).not.toHaveBeenCalled();
    expect(selectFlowPaneTarget).not.toHaveBeenCalled();
    expect(setTelemetrySource).not.toHaveBeenCalled();
    expect(setEnvironment).not.toHaveBeenCalled();

    stop();
  });

  it("prevents an abort-ignorant review retirement from overwriting a newer PR-selection URL", async () => {
    let releaseBaseline!: () => void;
    let retirementSignal: AbortSignal | undefined;
    let delayBaseline = false;
    let retirementStarted = false;
    const store = freshStore(undefined, (initial) => ({
      activeKey: initial.key,
      loadManifest: async () => ({
        version: 9,
        graphId: initial.graphId,
        contentId: "0".repeat(64),
        graphSummary: {
          schemaVersion: initial.artifact.schemaVersion,
          generatedAt: initial.artifact.generatedAt,
          nodeCount: initial.artifact.nodes.length,
          edgeCount: initial.artifact.edges.length,
        },
        repositorySummary: initial.index.structure.repositorySummary,
        defaultView: initial.request,
      }),
      stage: async (_request, options) => {
        if (!delayBaseline || retirementStarted) {
          return {
            projection: initial,
            commit: () => initial,
            release: () => {},
          };
        }
        retirementStarted = true;
        retirementSignal = options.signal;
        await new Promise<void>((resolve) => { releaseBaseline = resolve; });
        return {
          projection: initial,
          commit: () => initial,
          release: () => {},
        };
      },
      stageCached: () => undefined,
      stageReviewPair: async () => { throw new Error("replacement pair must not load before retirement"); },
      stageCachedReview: () => undefined,
      discardInactiveReviewProjections: () => {},
      searchSymbols: async () => { throw new Error("symbol search is not loaded during URL restore"); },
    }));
    const browser = stubUrlSyncBrowser();
    await restoreFromUrl(store, "");
    delayBaseline = true;
    const ensurePrSummary = vi.fn(async (number: number) => {
      store.setState({
        prExtraSummaries: {
          ...store.getState().prExtraSummaries,
          [number]: {
            number,
            title: `PR ${number}`,
            body: null,
            author: "octo",
            headRef: "feature",
            headSha: null,
            baseRef: "main",
            updatedAt: "2026-07-19T00:00:00.000Z",
            draft: false,
            state: "open",
            url: `https://github.com/o/r/pull/${number}`,
          },
        },
      });
    });
    const selectPr: BlueprintState["selectPr"] = vi.fn(async (number) => {
      store.setState({ prSelected: number });
    });
    store.setState({
      ensurePrSummary,
      selectPr,
      relayout: vi.fn(async () => {}),
      prSelected: 7,
      prReviewed: 7,
      prPreparedArtifactCurrent: true,
      prReviewBaseline: {
        graphId: "artifact-1",
        projectionKey: "boot-projection-key",
        projectionId: "boot-projection-id",
        request: BOOT_REQUEST,
        endpoints: {
          graphId: "artifact-1",
          manifestUrl: "/api/graph/manifest?id=artifact-1",
          projectionUrl: "/api/graph/projection?id=artifact-1",
          searchUrl: "/api/graph/search?id=artifact-1",
        },
        syntheticExecutionUrl: null,
        syntheticScenarios: [],
        syntheticExecutionTrust: null,
      },
    });
    const stop = startUrlSync(store);
    const retiringReview = mergeNavIntoSearch("", {
      ...DEFAULT_NAV,
      reviewPr: 7,
      reviewActive: true,
    });
    const newerSelection = mergeNavIntoSearch("", {
      ...DEFAULT_NAV,
      viewMode: "prs",
      prSelected: 9,
    });

    browser.popTo(retiringReview);
    await vi.waitFor(() => expect(retirementSignal).toBeInstanceOf(AbortSignal));
    browser.popTo(newerSelection);
    await vi.waitFor(() => expect(retirementSignal?.aborted).toBe(true));
    await vi.waitFor(() => expect(ensurePrSummary).toHaveBeenCalledWith(9));
    await vi.waitFor(() => expect(store.getState().prExtraSummaries[9]).toBeDefined());
    await vi.waitFor(() => expect(selectPr).toHaveBeenCalledWith(9));
    expect(store.getState()).toMatchObject({ prSelected: 9, prReviewed: 7 });

    releaseBaseline();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState()).toMatchObject({
      prSelected: 9,
      prReviewed: 7,
      prPreparedArtifactCurrent: true,
    });
    expect(store.getState().activeProjectionGraphId).toBe("artifact-1");
    stop();
  });

  it("pushes once when extraction opens and replaces nested frames in that entry", async () => {
    const store = freshStore();
    const browser = stubUrlSyncBrowser();
    await restoreFromUrl(store, "");
    const stop = startUrlSync(store);

    store.setState({ minimalSeedIds: [FILE_ID], minimalMemberIds: [FILE_ID] });
    expect(browser.pushState).toHaveBeenCalledOnce();
    expect(browser.replaceState).not.toHaveBeenCalled();

    const nestedId = `${FILE_ID}#run`;
    store.setState({ minimalSeedIds: [nestedId], minimalMemberIds: [nestedId] });
    expect(browser.pushState).toHaveBeenCalledOnce();
    expect(browser.replaceState).toHaveBeenCalledOnce();
    expect(new URLSearchParams(browser.location.search).get("mgraph")).toBe(nestedId);

    // The in-product Back action restores an outer frame in memory; URL sync rewrites the same
    // browser entry instead of manufacturing a history stack it cannot hydrate after popstate.
    store.setState({ minimalSeedIds: [FILE_ID], minimalMemberIds: [FILE_ID] });
    expect(browser.pushState).toHaveBeenCalledOnce();
    expect(browser.replaceState).toHaveBeenCalledTimes(2);
    expect(new URLSearchParams(browser.location.search).get("mgraph")).toBe(FILE_ID);

    stop();
  });

  it("does not write nested extraction frames into an active review URL", async () => {
    const store = freshStore();
    const browser = stubUrlSyncBrowser();
    await restoreFromUrl(store, "");
    const stop = startUrlSync(store);

    store.setState({
      prReviewed: 76,
      minimalSeedIds: [FILE_ID],
      minimalMemberIds: [FILE_ID],
    });
    expect(browser.pushState).toHaveBeenCalledOnce();
    expect(new URLSearchParams(browser.location.search).has("mgraph")).toBe(false);

    browser.pushState.mockClear();
    browser.replaceState.mockClear();
    const nestedId = `${FILE_ID}#run`;
    store.setState({ minimalSeedIds: [nestedId], minimalMemberIds: [nestedId] });

    expect(browser.pushState).not.toHaveBeenCalled();
    expect(browser.replaceState).not.toHaveBeenCalled();
    expect(new URLSearchParams(browser.location.search).has("mgraph")).toBe(false);

    stop();
  });
});

function stubUrlSyncBrowser() {
  const location = { origin: "http://meridian.local", search: "", pathname: "/", hash: "" };
  let popStateListener: (() => void) | null = null;
  const applyUrl = (url: string | URL | null) => {
    if (url === null) return;
    const next = new URL(String(url), location.origin);
    location.pathname = next.pathname;
    location.search = next.search;
    location.hash = next.hash;
  };
  const pushState = vi.fn((_data: unknown, _unused: string, url: string | URL | null) => applyUrl(url));
  const replaceState = vi.fn((_data: unknown, _unused: string, url: string | URL | null) => applyUrl(url));
  const addEventListener = vi.fn((type: string, listener: () => void) => {
    if (type === "popstate") popStateListener = listener;
  });
  const removeEventListener = vi.fn((type: string, listener: () => void) => {
    if (type === "popstate" && popStateListener === listener) popStateListener = null;
  });
  vi.stubGlobal("window", {
    location,
    history: { pushState, replaceState },
    addEventListener,
    removeEventListener,
  });
  return {
    location,
    pushState,
    replaceState,
    popTo(search: string) {
      location.search = search === "" ? "" : search.startsWith("?") ? search : `?${search}`;
      popStateListener?.();
    },
  };
}

function preparedDescriptor(graphId: string) {
  return {
    graphId,
    manifestUrl: `/api/graph/manifest?id=${graphId}`,
    projectionUrl: `/api/graph/projection?id=${graphId}`,
    searchUrl: `/api/graph/search?id=${graphId}`,
    sourceUrl: `/api/source?id=${graphId}`,
    metaUrl: `/api/meta?id=${graphId}`,
    graphSummary: {
      schemaVersion: "1.0.0",
      generatedAt: "2026-07-02T00:00:00.000Z",
      nodeCount: 2,
      edgeCount: 0,
    },
  };
}
