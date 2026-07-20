import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type { TelemetryProvider, TelemetrySourceRegistration } from "../telemetry/provider";
import { createBlueprintStore } from "./store";
import { restoreFromUrl, startUrlSync } from "./urlSync";

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

function freshStore(telemetry?: {
  provider: TelemetryProvider;
  sources: TelemetrySourceRegistration[];
}) {
  return createBlueprintStore({
    artifact: BOOT_ARTIFACT,
    index: buildGraphIndex(BOOT_ARTIFACT),
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
  it("restores an extracted review's boot graph before applying a pre-review Map URL", async () => {
    const store = freshStore();
    const bootIndex = store.getState().index;
    store.setState({
      artifact: HEAD_ARTIFACT,
      index: buildGraphIndex(HEAD_ARTIFACT),
      prReviewBaseline: {
        artifact: BOOT_ARTIFACT,
        index: bootIndex,
        review: null,
        syntheticExecutionUrl: null,
        syntheticScenarios: [],
        syntheticExecutionTrust: null,
      },
      prReviewed: 7,
      prSelected: 7,
      prPreparedGraphId: "pr-head-7",
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
    expect(store.getState().prPreparedGraphId).toBe(null);
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

  it("ends a synchronous review through the same baseline-clearing path", async () => {
    const store = freshStore();
    store.setState({
      prReviewed: 7,
      prSelected: 7,
      minimalSeedIds: [FILE_ID],
      minimalMemberIds: [FILE_ID],
    });
    stubWindow();

    await restoreFromUrl(store, "");

    expect(store.getState().artifact).toBe(BOOT_ARTIFACT);
    expect(store.getState().prReviewed).toBe(null);
    expect(store.getState().prSelected).toBe(null);
    expect(store.getState().prReviewBaseline).toBe(null);
    expect(store.getState().minimalSeedIds).toEqual([]);
  });
});

describe("startUrlSync extraction history", () => {
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
  const applyUrl = (url: string | URL | null) => {
    if (url === null) return;
    const next = new URL(String(url), location.origin);
    location.pathname = next.pathname;
    location.search = next.search;
    location.hash = next.hash;
  };
  const pushState = vi.fn((_data: unknown, _unused: string, url: string | URL | null) => applyUrl(url));
  const replaceState = vi.fn((_data: unknown, _unused: string, url: string | URL | null) => applyUrl(url));
  vi.stubGlobal("window", {
    location,
    history: { pushState, replaceState },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  return { location, pushState, replaceState };
}
