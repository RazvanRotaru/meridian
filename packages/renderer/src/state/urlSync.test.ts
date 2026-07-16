import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type {
  GraphProjectionDataSource,
  GraphProjectionRequest,
  LoadedGraphProjection,
  LoadedReviewProjection,
} from "../graph/graphProjectionClient";
import type { TelemetryProvider, TelemetrySourceRegistration } from "../telemetry/provider";
import { createBlueprintStore, type BlueprintState } from "./store";
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
  view: "modules",
  filePaths: [],
  focusIds: [],
  expandedIds: [],
  extraIds: [],
  depth: 1,
  radius: 0,
  includeTests: false,
};

function freshStore(telemetry?: {
  provider: TelemetryProvider;
  sources: TelemetrySourceRegistration[];
}) {
  const bootIndex = buildGraphIndex(BOOT_ARTIFACT);
  const initialProjection: LoadedGraphProjection = {
    key: "boot-projection-key",
    projectionId: "boot-projection-id",
    graphId: "artifact-1",
    request: BOOT_REQUEST,
    artifact: BOOT_ARTIFACT,
    index: bootIndex,
    serializedBytes: 100,
    residentBytes: 300,
  };
  const projectionDataSource: GraphProjectionDataSource = {
    activeKey: initialProjection.key,
    loadManifest: async () => ({
      version: 3,
      graphId: "artifact-1",
      contentId: "0".repeat(64),
      graphSummary: {
        schemaVersion: BOOT_ARTIFACT.schemaVersion,
        generatedAt: BOOT_ARTIFACT.generatedAt,
        nodeCount: BOOT_ARTIFACT.nodes.length,
        edgeCount: BOOT_ARTIFACT.edges.length,
      },
      defaultView: BOOT_REQUEST,
    }),
    activate: async () => initialProjection,
    activateCached: (key) => key === initialProjection.key ? initialProjection : undefined,
    activateReviewPair: async () => { throw new Error("review pair is not loaded during URL exit"); },
    activateCachedReview: (): LoadedReviewProjection | undefined => undefined,
    searchSymbols: async () => { throw new Error("symbol search is not loaded during URL exit"); },
  };
  return createBlueprintStore({
    artifact: BOOT_ARTIFACT,
    index: bootIndex,
    projectionDataSource,
    initialProjection,
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
          manifestUrl: "/api/graph/manifest?id=artifact-1",
          projectionUrl: "/api/graph/projection?id=artifact-1",
        },
        syntheticExecutionUrl: null,
        syntheticScenarios: [],
        syntheticExecutionTrust: null,
      },
      prReviewed: 7,
      prSelected: 7,
      prPreparedHead: preparedDescriptor("pr-head-7"),
      prPreparedMergeBase: preparedDescriptor("pr-head-7-base"),
      prPreparedFilePaths: ["src/a.ts"],
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
