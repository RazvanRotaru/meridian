import {
  createPrReviewProgressSnapshot,
  reducePrReviewProgress,
  type GraphProjectionV1,
  type PrReviewProgressSnapshot,
} from "@meridian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintStore } from "../state/store";
import type { PrReviewNavigationGuardOptions } from "./prReviewNavigationGuard";

const mocks = vi.hoisted(() => {
  const cancelPrReviewPreparation = vi.fn();
  const fetchGraphProjection = vi.fn();
  const startProgressiveSymbolIndex = vi.fn(async () => undefined);
  const state = {
    prReviewStatus: "idle",
    prReviewProgress: null as unknown as PrReviewProgressSnapshot,
    cancelPrReviewPreparation,
    startProgressiveSymbolIndex,
  };
  const stopProgress = vi.fn();
  const createBlueprintStore = vi.fn(() => store);
  const preparedReviewHandoffCommit = vi.fn(async () => undefined);
  const preparedReviewHandoffRelease = vi.fn(async () => undefined);
  const beginPreparedReviewHandoff = vi.fn(async () => ({
    commit: preparedReviewHandoffCommit,
    release: preparedReviewHandoffRelease,
  }));
  const graphViewLeaseDispose = vi.fn();
  const startGraphViewLease = vi.fn(() => ({
    leaseId: "lease-1",
    beginPreparedGraphHandoff: vi.fn(),
    beginPreparedReviewHandoff,
    replacePreparedGraphIds: vi.fn(async () => undefined),
    dispose: graphViewLeaseDispose,
  }));
  const store = {
    getState: () => state,
    setState: vi.fn((update: unknown) => {
      const partial = typeof update === "function"
        ? (update as (current: typeof state) => Partial<typeof state>)(state)
        : update as Partial<typeof state>;
      Object.assign(state, partial);
    }),
    subscribe: vi.fn(() => stopProgress),
  };
  return {
    artifact: { schemaVersion: "1.0.0", nodes: [], edges: [] },
    bindStore: vi.fn(),
    beginPreparedReviewHandoff,
    cancelPrReviewPreparation,
    completeInitialRestore: vi.fn(),
    createBlueprintStore,
    dispose: vi.fn(),
    fetchGraphProjection,
    graphViewLeaseDispose,
    guardOptions: null as PrReviewNavigationGuardOptions | null,
    preparedReviewHandoffCommit,
    preparedReviewHandoffRelease,
    restoreFromUrl: vi.fn(),
    startUrlSync: vi.fn(),
    state,
    stopProgress,
    startProgressiveSymbolIndex,
    startGraphViewLease,
    store,
  };
});

vi.mock("../graph/graphIndex", () => ({
  buildGraphIndex: vi.fn(() => ({})),
}));
vi.mock("../telemetry/httpProvider", () => ({
  createHttpTelemetryProvider: vi.fn(),
}));
vi.mock("../state/store", () => ({
  createBlueprintStore: mocks.createBlueprintStore,
}));
vi.mock("../state/progressiveGraph", async () => {
  const actual = await vi.importActual<typeof import("../state/progressiveGraph")>(
    "../state/progressiveGraph",
  );
  return { ...actual, fetchGraphProjection: mocks.fetchGraphProjection };
});
vi.mock("../state/urlSync", () => ({
  restoreFromUrl: mocks.restoreFromUrl,
  startUrlSync: mocks.startUrlSync,
}));
vi.mock("./bootConfig", () => ({
  readBootConfig: vi.fn(() => ({
    graphUrl: "/sample-graph.json",
    graphProjectUrl: "/api/graph/project",
    graphSymbolsUrl: "/api/graph/symbols",
    graphViewLease: null,
    preparedReviewHandoff: null,
    metaUrl: "/api/meta",
    overlayUrl: "/api/overlay",
    traceUrl: "/api/traces",
    traceAvailable: false,
    hasOverlay: false,
    overlayKind: null,
    envRequired: false,
    preselectedEnv: null,
    telemetrySources: [],
    preselectedTelemetrySourceId: null,
    sourceUrl: null,
    syntheticExecutionUrl: null,
    syntheticExecutionTrust: null,
    syntheticScenarios: [],
    githubSource: null,
    defaultEnv: null,
  })),
  prApiUrlsFromGraphUrl: vi.fn(() => ({
    prsUrl: "/api/prs",
    prOneUrl: "/api/prs/one",
    prFilesUrl: "/api/prs/files",
    prRelatedUrl: "/api/prs/related",
    prCommentsUrl: "/api/prs/comments",
    prChecksUrl: "/api/prs/checks",
    prFileUrl: "/api/prs/file",
    prReviewUrl: "/api/prs/review",
    analyzeUrl: "/api/pr/analyze",
    graphId: null,
  })),
}));
vi.mock("./loadArtifact", () => ({
  loadArtifact: vi.fn(async () => mocks.artifact),
}));
vi.mock("./loadEnvironments", () => ({
  loadEnvironments: vi.fn(async () => []),
}));
vi.mock("./prReviewNavigationGuard", () => ({
  reviewRestoreRequested: vi.fn((search: string) => {
    const params = new URLSearchParams(search);
    const value = Number(params.get("prn"));
    return params.get("rev") === "1" && Number.isSafeInteger(value) && value > 0;
  }),
  reviewRestorePrNumber: vi.fn((search: string) => {
    const params = new URLSearchParams(search);
    const value = Number(params.get("prn"));
    return params.get("rev") === "1" && Number.isSafeInteger(value) && value > 0
      ? value
      : null;
  }),
  startPrReviewNavigationGuard: vi.fn((options: PrReviewNavigationGuardOptions) => {
    mocks.guardOptions = options;
    return {
      bindStore: mocks.bindStore,
      completeInitialRestore: mocks.completeInitialRestore,
      dispose: mocks.dispose,
    };
  }),
}));
vi.mock("./graphViewLease", () => ({
  startGraphViewLease: mocks.startGraphViewLease,
}));

import {
  bootstrap,
  isInitialProgressiveProjectionReady,
  isPartialPrGraphId,
  progressiveGraphDeliveryForAcceptedSearch,
  progressiveGraphDeliveryEnabled,
} from "./bootstrap";
import { fetchGraphProjection } from "../state/progressiveGraph";
import { prApiUrlsFromGraphUrl, readBootConfig, type BootConfig, type PrApiUrls } from "./bootConfig";
import { loadArtifact } from "./loadArtifact";
import { loadEnvironments } from "./loadEnvironments";
import { DEFAULT_NAV, mergeNavIntoSearch } from "../state/urlState";

const PROVISIONAL_PAIR_ID = "0123456789abcdefabcd";
const PARTIAL_GRAPH_ID = `pr-partial-${PROVISIONAL_PAIR_ID}-${"a".repeat(40)}`;
const COMPARISON_GRAPH_ID = `pr-partial-base-${PROVISIONAL_PAIR_ID}-${"b".repeat(40)}`;
const PREPARED_REVIEW_HANDOFF = {
  version: 1 as const,
  claimId: "c".repeat(32),
  url: `/api/pr-review-handoffs/${"c".repeat(32)}`,
  expiresAtMs: Date.now() + 60_000,
  headGraphId: PARTIAL_GRAPH_ID,
  comparisonGraphId: COMPARISON_GRAPH_ID,
};
const PROVISIONAL_PROJECTION = {
  graphId: PARTIAL_GRAPH_ID,
  rootFileIds: [],
  readyFileIds: [],
  requestedDepth: 1,
  loadedDepth: 1,
  schemaVersion: "1.0.0",
  nodes: [],
  edges: [],
} as unknown as GraphProjectionV1;
const COMPARISON_PROJECTION = {
  ...PROVISIONAL_PROJECTION,
  graphId: COMPARISON_GRAPH_ID,
} as unknown as GraphProjectionV1;

describe("bootstrap initial URL restoration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guardOptions = null;
    mocks.state.prReviewStatus = "idle";
    mocks.state.prReviewProgress = createPrReviewProgressSnapshot();
    mocks.store.subscribe.mockImplementation(() => mocks.stopProgress);
    mocks.createBlueprintStore.mockClear();
    mocks.preparedReviewHandoffCommit.mockReset().mockResolvedValue(undefined);
    mocks.preparedReviewHandoffRelease.mockReset().mockResolvedValue(undefined);
    mocks.beginPreparedReviewHandoff.mockReset().mockImplementation(async () => ({
      commit: mocks.preparedReviewHandoffCommit,
      release: mocks.preparedReviewHandoffRelease,
    }));
    mocks.startProgressiveSymbolIndex.mockClear();
    mocks.fetchGraphProjection.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cancels a stale review preparation and restores the accepted history URL before URL sync", async () => {
    const location = {
      origin: "http://meridian.local",
      pathname: "/",
      search: "?view=modules&prn=7&rev=1&progressive=0",
      hash: "",
    };
    vi.stubGlobal("window", { location });

    mocks.restoreFromUrl
      .mockImplementationOnce(async (
        _store: BlueprintStore,
        _search: string | undefined,
        progress: { isCurrent?: () => boolean },
      ) => {
        mocks.state.prReviewStatus = "preparing";
        location.search = "?view=logic";
        mocks.guardOptions?.onAcceptedPopState?.(location.search);
        expect(progress.isCurrent?.()).toBe(false);
      })
      .mockImplementationOnce(async (
        _store: BlueprintStore,
        search: string | undefined,
        progress: { isCurrent?: () => boolean },
      ) => {
        expect(search).toBe("?view=logic");
        expect(progress.isCurrent?.()).toBe(true);
        mocks.state.prReviewStatus = "idle";
      });

    const result = await bootstrap();

    expect(result.store).toBe(mocks.store);
    expect(mocks.cancelPrReviewPreparation).toHaveBeenCalledOnce();
    expect(mocks.restoreFromUrl).toHaveBeenCalledTimes(2);
    expect(mocks.completeInitialRestore).toHaveBeenCalledOnce();
    expect(mocks.startUrlSync).toHaveBeenCalledWith(mocks.store);
    expect(mocks.restoreFromUrl.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.completeInitialRestore.mock.invocationCallOrder[0]!,
    );
    expect(mocks.completeInitialRestore.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.startUrlSync.mock.invocationCallOrder[0]!,
    );

    // Once normal URL sync owns popstate, the boot-only callback must no longer double-cancel.
    mocks.state.prReviewStatus = "preparing";
    mocks.guardOptions?.onAcceptedPopState?.("?view=modules");
    expect(mocks.cancelPrReviewPreparation).toHaveBeenCalledOnce();
  });

  it("keeps healthy progressive capabilities after an explicit complete-benchmark review restore", async () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://meridian.local",
        pathname: "/view",
        search: "?id=head&view=modules&prn=7&rev=1&progressive=0",
        hash: "",
      },
    });

    await bootstrap();

    expect(mocks.createBlueprintStore).toHaveBeenCalledWith(expect.objectContaining({
      graphProjectUrl: "/api/graph/project",
      graphSymbolsUrl: "/api/graph/symbols",
      initialGraphProjection: null,
    }));
  });

  it("loads an ordinary source graph before re-preparing its partial review on reload", async () => {
    const sourceGraphId = "source-session";
    vi.stubGlobal("window", {
      location: {
        origin: "http://meridian.local",
        pathname: "/view",
        search: `?id=${sourceGraphId}&view=modules&prn=7&rev=1&progressive=1`,
        hash: "",
      },
    });
    useProvisionalBoot({}, sourceGraphId);

    await bootstrap();

    expect(loadArtifact).toHaveBeenCalledWith(`/api/graph?id=${sourceGraphId}`);
    expect(fetchGraphProjection).not.toHaveBeenCalled();
    expect(mocks.restoreFromUrl).toHaveBeenCalledOnce();
    expect(mocks.createBlueprintStore).toHaveBeenCalledWith(expect.objectContaining({
      initialGraphProjection: null,
      graphProjectUrl: "/api/graph/project",
      graphSymbolsUrl: "/api/graph/symbols",
    }));
    expect(mocks.beginPreparedReviewHandoff).not.toHaveBeenCalled();
  });

  it("boots an unmarked copied review from its depth-one partial projection", async () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://meridian.local",
        pathname: "/view",
        search: `?id=${PARTIAL_GRAPH_ID}&prn=7&rev=1`,
        hash: "",
      },
    });
    useProvisionalBoot();
    vi.mocked(fetchGraphProjection).mockResolvedValueOnce(PROVISIONAL_PROJECTION);

    await bootstrap();

    expect(fetchGraphProjection).toHaveBeenCalledOnce();
    expect(vi.mocked(fetchGraphProjection).mock.calls[0]?.[1]).toMatchObject({
      graphId: PARTIAL_GRAPH_ID,
      roots: { kind: "changed-files", seedGraphId: PARTIAL_GRAPH_ID },
      requestedDepth: 1,
      prefetchDepth: 3,
    });
    expect(loadArtifact).not.toHaveBeenCalled();
    expect(mocks.createBlueprintStore).toHaveBeenCalledWith(expect.objectContaining({
      initialGraphProjection: PROVISIONAL_PROJECTION,
      initialGraphProvisional: false,
      graphProjectUrl: "/api/graph/project",
      graphSymbolsUrl: "/api/graph/symbols",
    }));
  });

  it("attaches a prepared review before fetching either projection and commits after store creation", async () => {
    vi.stubGlobal("window", {
      location: provisionalWindowLocation(),
    });
    usePreparedReviewBoot();
    let resolveAttach!: (handoff: {
      commit: typeof mocks.preparedReviewHandoffCommit;
      release: typeof mocks.preparedReviewHandoffRelease;
    }) => void;
    mocks.beginPreparedReviewHandoff.mockReturnValueOnce(new Promise((resolve) => {
      resolveAttach = resolve;
    }));
    vi.mocked(fetchGraphProjection)
      .mockResolvedValueOnce(PROVISIONAL_PROJECTION)
      .mockResolvedValueOnce(COMPARISON_PROJECTION);

    const completion = bootstrap();
    await vi.waitFor(() => expect(mocks.beginPreparedReviewHandoff).toHaveBeenCalledOnce());
    expect(fetchGraphProjection).not.toHaveBeenCalled();

    resolveAttach({
      commit: mocks.preparedReviewHandoffCommit,
      release: mocks.preparedReviewHandoffRelease,
    });
    await completion;

    expect(mocks.beginPreparedReviewHandoff).toHaveBeenCalledWith(PREPARED_REVIEW_HANDOFF);
    expect(fetchGraphProjection).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchGraphProjection).mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        graphId: PARTIAL_GRAPH_ID,
        roots: { kind: "changed-files", seedGraphId: PARTIAL_GRAPH_ID },
      }),
      expect.objectContaining({
        graphId: COMPARISON_GRAPH_ID,
        roots: { kind: "changed-files", seedGraphId: PARTIAL_GRAPH_ID },
      }),
    ]);
    expect(mocks.createBlueprintStore).toHaveBeenCalledWith(expect.objectContaining({
      initialGraphProjection: PROVISIONAL_PROJECTION,
      initialComparisonGraphProjection: COMPARISON_PROJECTION,
    }));
    expect(mocks.createBlueprintStore.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.preparedReviewHandoffCommit.mock.invocationCallOrder[0]!,
    );
    expect(mocks.preparedReviewHandoffCommit).toHaveBeenCalledOnce();
    expect(mocks.preparedReviewHandoffRelease).not.toHaveBeenCalled();
  });

  it("releases an attached prepared review when projection bootstrap fails", async () => {
    vi.stubGlobal("window", {
      location: provisionalWindowLocation(),
    });
    usePreparedReviewBoot();
    vi.mocked(fetchGraphProjection)
      .mockResolvedValueOnce(PROVISIONAL_PROJECTION)
      .mockRejectedValueOnce(new Error("comparison unavailable"));

    await expect(bootstrap()).rejects.toThrow(
      "the provisional PR graph projection is unavailable",
    );

    expect(mocks.beginPreparedReviewHandoff).toHaveBeenCalledWith(PREPARED_REVIEW_HANDOFF);
    expect(mocks.createBlueprintStore).not.toHaveBeenCalled();
    expect(mocks.preparedReviewHandoffCommit).not.toHaveBeenCalled();
    expect(mocks.preparedReviewHandoffRelease).toHaveBeenCalledOnce();
    expect(mocks.graphViewLeaseDispose).toHaveBeenCalledOnce();
  });

  it("boots the URL written after leaving a partial review without treating consumed handoff markers as malformed", async () => {
    const cleanedSearch = mergeNavIntoSearch(
      `id=partial-head&view=modules&prn=7&rev=1&progressive=1&partial=1&pair=${PROVISIONAL_PAIR_ID}`,
      { ...DEFAULT_NAV, viewMode: "prs" },
    );
    vi.stubGlobal("window", {
      location: {
        origin: "http://meridian.local",
        pathname: "/view",
        search: `?${cleanedSearch}`,
        hash: "",
      },
    });

    await expect(bootstrap()).resolves.toMatchObject({ store: mocks.store });

    expect(cleanedSearch).toBe("id=partial-head&view=prs");
    expect(loadArtifact).toHaveBeenCalledOnce();
    expect(fetchGraphProjection).not.toHaveBeenCalled();
  });

  it.each([
    ["a different PR", "?view=modules&prn=8&rev=1", 8],
    ["a non-review destination", "?view=modules", null],
  ])("drops PR 7 handoff history when Back restores %s", async (
    _description,
    nextSearch,
    expectedPrNumber,
  ) => {
    const location = {
      origin: "http://meridian.local",
      pathname: "/view",
      search: "?id=head-7&prn=7&rev=1&progressive=0",
      hash: "",
    };
    vi.stubGlobal("window", { location });
    let handoff = reducePrReviewProgress(
      createPrReviewProgressSnapshot(7),
      { type: "stage", stage: "resolve" },
    );
    handoff = reducePrReviewProgress(handoff, { type: "analysis-done", cache: "hit" });
    handoff = reducePrReviewProgress(handoff, { type: "stage", stage: "handoff" });
    const onProgress = vi.fn();
    mocks.restoreFromUrl
      .mockImplementationOnce(async () => {
        expect(mocks.state.prReviewProgress).toEqual(
          reducePrReviewProgress(handoff, { type: "stage", stage: "load-artifacts" }),
        );
        location.search = nextSearch;
        mocks.guardOptions?.onAcceptedPopState?.(nextSearch);
      })
      .mockImplementationOnce(async (
        _store: BlueprintStore,
        search: string | undefined,
      ) => {
        expect(search).toBe(nextSearch);
        expect(mocks.state.prReviewProgress).toEqual(
          createPrReviewProgressSnapshot(expectedPrNumber),
        );
      });

    await bootstrap({ reviewProgressHandoff: handoff, onProgress });

    expect(mocks.state.prReviewProgress.prNumber).toBe(expectedPrNumber);
    expect(mocks.state.prReviewProgress.steps.workspace).toBe("pending");
    expect(mocks.state.prReviewProgress.steps.graphs).toBe("pending");
    expect(mocks.state.prReviewProgress.steps.artifacts).toBe("pending");
    if (expectedPrNumber === null) {
      expect(onProgress).toHaveBeenLastCalledWith({
        stage: "initial-layout",
        path: "graph",
        reviewProgress: null,
      });
    }
  });

  it("switches progress back to review analysis when Forward follows a non-review Back", async () => {
    const location = {
      origin: "http://meridian.local",
      pathname: "/view",
      search: "?id=head-7&prn=7&rev=1&progressive=0",
      hash: "",
    };
    vi.stubGlobal("window", { location });
    let handoff = reducePrReviewProgress(
      createPrReviewProgressSnapshot(7),
      { type: "stage", stage: "resolve" },
    );
    handoff = reducePrReviewProgress(handoff, { type: "analysis-done", cache: "hit" });
    handoff = reducePrReviewProgress(handoff, { type: "stage", stage: "handoff" });
    const onProgress = vi.fn();
    const nonReviewSearch = "?view=modules";
    const nextReviewSearch = "?id=head-8&prn=8&rev=1";
    mocks.restoreFromUrl
      .mockImplementationOnce(async () => {
        location.search = nonReviewSearch;
        mocks.guardOptions?.onAcceptedPopState?.(nonReviewSearch);
      })
      .mockImplementationOnce(async (
        _store: BlueprintStore,
        search: string | undefined,
      ) => {
        expect(search).toBe(nonReviewSearch);
        location.search = nextReviewSearch;
        mocks.guardOptions?.onAcceptedPopState?.(nextReviewSearch);
      })
      .mockImplementationOnce(async (
        _store: BlueprintStore,
        search: string | undefined,
      ) => {
        expect(search).toBe(nextReviewSearch);
        expect(mocks.state.prReviewProgress).toEqual(createPrReviewProgressSnapshot(8));
      });

    await bootstrap({ reviewProgressHandoff: handoff, onProgress });

    expect(onProgress).toHaveBeenCalledWith({
      stage: "initial-layout",
      path: "graph",
      reviewProgress: null,
    });
    expect(onProgress).toHaveBeenLastCalledWith({
      stage: "initial-layout",
      path: "review-analysis",
      reviewProgress: createPrReviewProgressSnapshot(8),
    });
  });
});

describe("progressive graph delivery opt-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guardOptions = null;
    mocks.fetchGraphProjection.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails closed when Back supersedes an in-flight provisional projection", async () => {
    const location = provisionalWindowLocation();
    vi.stubGlobal("window", { location });
    useProvisionalBoot();
    let resolveProjection!: (projection: GraphProjectionV1) => void;
    vi.mocked(fetchGraphProjection).mockImplementationOnce(() => new Promise((resolve) => {
      resolveProjection = resolve;
    }));

    const completion = bootstrap();
    const rejected = expect(completion).rejects.toThrow(
      "the provisional PR graph projection is unavailable",
    );
    await vi.waitFor(() => expect(fetchGraphProjection).toHaveBeenCalledOnce());

    location.search = "?view=modules";
    mocks.guardOptions?.onAcceptedPopState?.(location.search);
    resolveProjection(PROVISIONAL_PROJECTION);

    await rejected;
    expect(loadArtifact).not.toHaveBeenCalled();
    expect(mocks.createBlueprintStore).not.toHaveBeenCalled();
  });

  it("fails closed when Back supersedes a provisional projection during service startup", async () => {
    const location = provisionalWindowLocation();
    vi.stubGlobal("window", { location });
    useProvisionalBoot({
      hasOverlay: true,
      overlayKind: "tempo",
      preselectedTelemetrySourceId: "tempo",
    });
    vi.mocked(fetchGraphProjection).mockResolvedValueOnce(PROVISIONAL_PROJECTION);
    let resolveEnvironments!: (environments: string[]) => void;
    vi.mocked(loadEnvironments).mockImplementationOnce(() => new Promise((resolve) => {
      resolveEnvironments = resolve;
    }));

    const completion = bootstrap();
    const rejected = expect(completion).rejects.toThrow(
      "the provisional PR graph projection is unavailable",
    );
    await vi.waitFor(() => expect(loadEnvironments).toHaveBeenCalledOnce());

    location.search = "?view=modules";
    mocks.guardOptions?.onAcceptedPopState?.(location.search);
    resolveEnvironments([]);

    await rejected;
    expect(loadArtifact).not.toHaveBeenCalled();
    expect(mocks.createBlueprintStore).not.toHaveBeenCalled();
  });

  it.each([
    ["partial without pair", "partial=1&progressive=1"],
    ["pair without partial", "pair=0123456789abcdefabcd&progressive=1"],
    ["invalid pair", "partial=1&pair=not-a-pair&progressive=1"],
    ["duplicate partial", "partial=1&partial=1&pair=0123456789abcdefabcd&progressive=1"],
    ["duplicate pair", "partial=1&pair=0123456789abcdefabcd&pair=0123456789abcdefabcd&progressive=1"],
    ["missing progressive opt-in", "partial=1&pair=0123456789abcdefabcd"],
    ["duplicate progressive opt-in", "partial=1&pair=0123456789abcdefabcd&progressive=1&progressive=1"],
    ["wrong partial value", "partial=0&pair=0123456789abcdefabcd&progressive=1"],
  ])("fails closed for a malformed provisional URL: %s", async (_case, query) => {
    mocks.createBlueprintStore.mockClear();
    vi.stubGlobal("window", {
      location: {
        origin: "http://meridian.local",
        pathname: "/view",
        search: `?id=head&prn=7&rev=1&${query}`,
        hash: "",
      },
    });

    await expect(bootstrap()).rejects.toThrow("malformed provisional PR graph URL");
    expect(mocks.createBlueprintStore).not.toHaveBeenCalled();
  });

  it("fails closed when a provisional marker names a different partial pair", async () => {
    const mismatchedPairId = "fedcba98765432100123";
    vi.stubGlobal("window", {
      location: {
        origin: "http://meridian.local",
        pathname: "/view",
        search: `?id=${PARTIAL_GRAPH_ID}&prn=7&rev=1&progressive=1&partial=1&pair=${mismatchedPairId}`,
        hash: "",
      },
    });
    useProvisionalBoot();

    await expect(bootstrap()).rejects.toThrow(
      "the provisional PR graph cannot boot without its verified depth-one projection",
    );
    expect(fetchGraphProjection).not.toHaveBeenCalled();
    expect(loadArtifact).not.toHaveBeenCalled();
    expect(mocks.createBlueprintStore).not.toHaveBeenCalled();
  });

  it("defaults copied review URLs to partial-only and honors the benchmark opt-out", () => {
    expect(progressiveGraphDeliveryEnabled(true, "?id=head&prn=7&rev=1")).toBe(true);
    expect(progressiveGraphDeliveryEnabled(true, "?id=head&prn=7&rev=1&progressive=0")).toBe(false);
    expect(progressiveGraphDeliveryEnabled(true, "?id=head&prn=7&rev=1&progressive=1")).toBe(true);
  });

  it("recognizes only server-owned partial HEAD graph ids for projection boot", () => {
    expect(isPartialPrGraphId(PARTIAL_GRAPH_ID)).toBe(true);
    expect(isPartialPrGraphId(`pr-partial-${PROVISIONAL_PAIR_ID}-${"a".repeat(64)}`)).toBe(true);
    expect(isPartialPrGraphId(`pr-partial-base-${PROVISIONAL_PAIR_ID}-${"a".repeat(40)}`)).toBe(false);
    expect(isPartialPrGraphId("source-session")).toBe(false);
    expect(isPartialPrGraphId(null)).toBe(false);
  });

  it("allows a PR selected later from an ordinary SPA session to use the capability", () => {
    expect(progressiveGraphDeliveryEnabled(false, "?view=prs")).toBe(true);
  });

  it("honors the latest accepted history URL when bootstrap races with popstate", () => {
    expect(progressiveGraphDeliveryForAcceptedSearch(
      "?id=head-2&prn=8&rev=1",
      "?id=head-1&prn=7&rev=1&progressive=1",
    )).toBe(true);
    expect(progressiveGraphDeliveryForAcceptedSearch(
      "?id=head-2&prn=8&rev=1&progressive=0",
      "?id=head-1&prn=7&rev=1&progressive=1",
    )).toBe(false);
    expect(progressiveGraphDeliveryForAcceptedSearch(
      "?id=head-2&prn=8&rev=1&progressive=1",
      "?id=head-1&prn=7&rev=1",
    )).toBe(true);
  });

  it("admits an empty ready HEAD so a deletion-only review can load its merge-base tombstones", () => {
    const emptyHead = {
      rootFileIds: [],
      readyFileIds: [],
      requestedDepth: 1,
      loadedDepth: 1,
    } as unknown as GraphProjectionV1;

    expect(isInitialProgressiveProjectionReady(emptyHead)).toBe(true);
    expect(isInitialProgressiveProjectionReady({ ...emptyHead, loadedDepth: 0 })).toBe(false);
  });
});

function provisionalWindowLocation() {
  return {
    origin: "http://meridian.local",
    pathname: "/view",
    search: `?id=${PARTIAL_GRAPH_ID}&prn=7&rev=1&progressive=1&partial=1&pair=${PROVISIONAL_PAIR_ID}`,
    hash: "",
  };
}

function useProvisionalBoot(
  overrides: Partial<BootConfig> = {},
  graphId = PARTIAL_GRAPH_ID,
): void {
  vi.mocked(readBootConfig).mockReturnValueOnce({
    graphUrl: `/api/graph?id=${graphId}`,
    graphProjectUrl: "/api/graph/project",
    graphSymbolsUrl: "/api/graph/symbols",
    graphViewLease: {
      version: 1,
      leaseId: "lease-1",
      url: "/api/graph-view/lease-1",
      createUrl: "/api/graph-view",
      expiresAtMs: Date.now() + 60_000,
      heartbeatIntervalMs: 30_000,
    },
    preparedReviewHandoff: null,
    metaUrl: "/api/meta",
    overlayUrl: "/api/overlay",
    traceUrl: "/api/traces",
    traceAvailable: false,
    hasOverlay: false,
    overlayKind: null,
    envRequired: false,
    preselectedEnv: null,
    telemetrySources: [],
    preselectedTelemetrySourceId: null,
    sourceUrl: null,
    syntheticExecutionUrl: null,
    syntheticExecutionTrust: null,
    syntheticScenarios: [],
    githubSource: { repository: "https://github.com/org/repo.git", subdir: "" },
    defaultEnv: null,
    ...overrides,
  });
  vi.mocked(prApiUrlsFromGraphUrl).mockReturnValueOnce({
    prsUrl: `/api/prs?id=${graphId}`,
    prOneUrl: `/api/prs/one?id=${graphId}`,
    prFilesUrl: `/api/prs/files?id=${graphId}`,
    prViewedFilesUrl: `/api/prs/viewed-files?id=${graphId}`,
    prRelatedUrl: `/api/prs/related?id=${graphId}`,
    prCommentsUrl: `/api/prs/comments?id=${graphId}`,
    prChecksUrl: `/api/prs/checks?id=${graphId}`,
    prFileUrl: `/api/prs/file?id=${graphId}`,
    prReviewUrl: `/api/prs/review?id=${graphId}`,
    analyzeUrl: `/api/pr/analyze?id=${graphId}`,
    graphId,
  } satisfies PrApiUrls);
}

function usePreparedReviewBoot(): void {
  useProvisionalBoot({
    graphViewLease: {
      version: 1,
      leaseId: "lease-1",
      url: "/api/graph-view/lease-1",
      createUrl: "/api/graph-view",
      graphIds: [PARTIAL_GRAPH_ID, COMPARISON_GRAPH_ID],
      expiresAtMs: Date.now() + 60_000,
      heartbeatIntervalMs: 30_000,
    },
    preparedReviewHandoff: PREPARED_REVIEW_HANDOFF,
  });
}
