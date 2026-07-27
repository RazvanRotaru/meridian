import {
  createPrReviewProgressSnapshot,
  reducePrReviewProgress,
  type PrReviewProgressSnapshot,
} from "@meridian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintStore } from "../state/store";
import type { PrReviewNavigationGuardOptions } from "./prReviewNavigationGuard";

const mocks = vi.hoisted(() => {
  const cancelPrReviewPreparation = vi.fn();
  const state = {
    prReviewStatus: "idle",
    prReviewProgress: null as unknown as PrReviewProgressSnapshot,
    cancelPrReviewPreparation,
  };
  const stopProgress = vi.fn();
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
    cancelPrReviewPreparation,
    completeInitialRestore: vi.fn(),
    dispose: vi.fn(),
    guardOptions: null as PrReviewNavigationGuardOptions | null,
    restoreFromUrl: vi.fn(),
    startUrlSync: vi.fn(),
    state,
    stopProgress,
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
  createBlueprintStore: vi.fn(() => mocks.store),
}));
vi.mock("../state/urlSync", () => ({
  restoreFromUrl: mocks.restoreFromUrl,
  startUrlSync: mocks.startUrlSync,
}));
vi.mock("./bootConfig", () => ({
  readBootConfig: vi.fn(() => ({
    graphUrl: "/sample-graph.json",
    graphViewLease: null,
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
  reviewRestoreRequested: vi.fn(() => true),
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
  startGraphViewLease: vi.fn(),
}));

import { bootstrap } from "./bootstrap";

describe("bootstrap initial URL restoration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guardOptions = null;
    mocks.state.prReviewStatus = "idle";
    mocks.state.prReviewProgress = createPrReviewProgressSnapshot();
    mocks.store.subscribe.mockImplementation(() => mocks.stopProgress);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cancels a stale review preparation and restores the accepted history URL before URL sync", async () => {
    const location = {
      origin: "http://meridian.local",
      pathname: "/",
      search: "?view=modules&prn=7&rev=1",
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
      search: "?id=head-7&prn=7&rev=1",
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
      search: "?id=head-7&prn=7&rev=1",
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
