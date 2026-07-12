import { describe, expect, it, vi } from "vitest";
import type { GraphArtifact, NodeMetrics, TraceBundle } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type { TelemetryProvider, TelemetrySourceRegistration } from "../telemetry/provider";
import { createBlueprintStore } from "./store";

const NODE_ID = "ts:src/a.ts#run";
const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-01-01T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [{ id: NODE_ID, kind: "function", qualifiedName: "run", displayName: "run", location: { file: "src/a.ts", startLine: 1 } }],
  edges: [],
};
const METRICS: Record<string, NodeMetrics> = {
  [NODE_ID]: { callCount: 1, errorRate: 0, latencyMs: { p50: 2, p95: 3, p99: 4 }, sampleCount: 1 },
};

function bundle(env: string, traceId = "11111111111111111111111111111111"): TraceBundle {
  return {
    traceVersion: "1.0.0",
    source: "mock",
    env,
    generatedAt: "2026-01-01T00:00:00.000Z",
    graphRef: { schemaVersion: "1.0.0", generatedAt: ARTIFACT.generatedAt, nodeCount: 1 },
    traces: [{
      traceId,
      name: "GET /run",
      rootSpanId: "1000000000000001",
      startedAtUnixNano: "1000000000",
      endedAtUnixNano: "1001000000",
      status: "ok",
      attributes: {},
      completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
      spans: [{
        spanId: "1000000000000001",
        nodeId: NODE_ID,
        name: "run",
        kind: "server",
        startedAtUnixNano: "1000000000",
        endedAtUnixNano: "1001000000",
        status: "ok",
        attributes: {},
        events: [],
      }],
    }],
  };
}

function provider(overrides: Partial<TelemetryProvider> = {}): TelemetryProvider {
  return {
    id: "mock",
    requiresEnvironment: true,
    listEnvironments: () => ["dev", "staging"],
    fetchMetrics: async () => METRICS,
    fetchTraces: async (env) => bundle(env),
    ...overrides,
  };
}

function registration(
  id: string,
  telemetryProvider: TelemetryProvider,
  overrides: Partial<Omit<TelemetrySourceRegistration, "id" | "provider">> = {},
): TelemetrySourceRegistration {
  return {
    id,
    kind: "mock",
    label: id,
    provenance: "synthetic",
    environments: ["dev", "staging"],
    supportsMetrics: true,
    supportsTraces: true,
    ...overrides,
    provider: telemetryProvider,
  };
}

function storeWith(
  telemetryProvider: TelemetryProvider | null,
  telemetryOptions: {
    telemetrySources?: TelemetrySourceRegistration[];
    telemetrySourceId?: string | null;
  } = {},
) {
  return createBlueprintStore({
    artifact: ARTIFACT,
    index: buildGraphIndex(ARTIFACT),
    provider: telemetryProvider,
    ...telemetryOptions,
    hasOverlay: true,
    sourceUrl: null,
    prsUrl: "/api/prs",
    prOneUrl: "/api/prs/one",
    prFilesUrl: "/api/prs/files",
    prRelatedUrl: "/api/prs/related",
    prCommentsUrl: "/api/prs/comments",
    prChecksUrl: "/api/prs/checks",
    prReviewUrl: "/api/prs/review",
  });
}

describe("request telemetry state", () => {
  it("starts outside explicit telemetry mode", () => {
    const store = storeWith(provider());

    expect(store.getState().telemetryMode).toBe(false);
  });

  it("exposes a source catalog without activating it until explicitly selected", () => {
    const demoProvider = provider({ id: "demo" });
    const demo = registration("demo", demoProvider);
    const store = storeWith(demoProvider, { telemetrySources: [demo] });

    expect(store.getState().telemetrySources).toEqual([{
      id: "demo",
      kind: "mock",
      label: "demo",
      provenance: "synthetic",
      environments: ["dev", "staging"],
      supportsMetrics: true,
      supportsTraces: true,
    }]);
    expect(store.getState().telemetrySourceId).toBeNull();
    expect(store.getState().provider).toBeNull();

    store.getState().setTelemetrySource("demo");
    expect(store.getState().telemetrySourceId).toBe("demo");
    expect(store.getState().provider).toBe(demoProvider);
    expect(store.getState().environment).toBeNull();
  });

  it("clears telemetry selection, data, loading, and errors when the source changes", () => {
    const firstProvider = provider({ id: "first" });
    const secondProvider = provider({ id: "second" });
    const store = storeWith(firstProvider, {
      telemetrySources: [registration("first", firstProvider), registration("second", secondProvider)],
      telemetrySourceId: "first",
    });
    store.setState({
      environment: "staging",
      telemetry: METRICS,
      requestTraces: bundle("staging").traces,
      selectedTraceId: bundle("staging").traces[0]!.traceId,
      traceGraphRef: bundle("staging").graphRef,
      traceSource: "mock",
      telemetryLoading: true,
      telemetryError: "old metrics error",
      traceLoading: true,
      traceError: "old trace error",
    });

    store.getState().setTelemetrySource("second");

    expect(store.getState()).toMatchObject({
      telemetrySourceId: "second",
      provider: secondProvider,
      environment: null,
      telemetry: {},
      requestTraces: [],
      selectedTraceId: null,
      traceGraphRef: null,
      traceSource: null,
      telemetryLoading: false,
      telemetryError: null,
      traceLoading: false,
      traceError: null,
    });
  });

  it("drops pending responses from a source that was superseded", async () => {
    let resolveOldMetrics: ((value: Record<string, NodeMetrics>) => void) | null = null;
    let resolveOldTraces: ((value: TraceBundle) => void) | null = null;
    const oldProvider = provider({
      id: "old",
      fetchMetrics: () => new Promise((resolve) => { resolveOldMetrics = resolve; }),
      fetchTraces: () => new Promise((resolve) => { resolveOldTraces = resolve; }),
    });
    const newProvider = provider({ id: "new" });
    const store = storeWith(oldProvider, {
      telemetrySources: [registration("old", oldProvider), registration("new", newProvider)],
      telemetrySourceId: "old",
    });
    store.getState().setEnvironment("dev");
    const oldLoad = store.getState().refreshTelemetry();

    await vi.waitFor(() => expect(store.getState().traceLoading).toBe(true));
    store.getState().setTelemetrySource("new");
    resolveOldMetrics!(METRICS);
    resolveOldTraces!(bundle("dev"));
    await oldLoad;

    expect(store.getState()).toMatchObject({
      telemetrySourceId: "new",
      provider: newProvider,
      environment: null,
      telemetry: {},
      requestTraces: [],
      selectedTraceId: null,
      telemetryLoading: false,
      traceLoading: false,
    });
  });

  it("only calls channels supported by the selected source", async () => {
    const fetchMetrics = vi.fn(async () => METRICS);
    const fetchTraces = vi.fn(async (env: string) => bundle(env));
    const metricsProvider = provider({ id: "metrics-only", fetchMetrics, fetchTraces });
    const store = storeWith(metricsProvider, {
      telemetrySources: [registration("metrics-only", metricsProvider, { supportsTraces: false })],
      telemetrySourceId: "metrics-only",
    });
    store.getState().setEnvironment("staging");

    await store.getState().refreshTelemetry();

    expect(fetchMetrics).toHaveBeenCalledWith("staging");
    expect(fetchTraces).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      telemetry: METRICS,
      requestTraces: [],
      telemetryLoading: false,
      traceLoading: false,
      traceError: null,
    });
  });

  it("turns telemetry off for an unknown or null source", () => {
    const demoProvider = provider({ id: "demo" });
    const store = storeWith(demoProvider, {
      telemetrySources: [registration("demo", demoProvider)],
      telemetrySourceId: "demo",
    });

    store.getState().setTelemetrySource("missing");
    expect(store.getState().telemetrySourceId).toBeNull();
    expect(store.getState().provider).toBeNull();
    store.getState().setTelemetrySource(null);
    expect(store.getState().telemetrySourceId).toBeNull();
  });

  it("keeps the environment gate and loads metrics + traces together", async () => {
    const store = storeWith(provider());
    await expect(store.getState().refreshTelemetry()).rejects.toThrow("before an environment was selected");
    store.getState().setEnvironment("staging");
    await store.getState().refreshTelemetry();
    expect(store.getState()).toMatchObject({
      environment: "staging",
      telemetry: METRICS,
      selectedTraceId: "11111111111111111111111111111111",
      traceGraphRef: { schemaVersion: "1.0.0", generatedAt: ARTIFACT.generatedAt, nodeCount: 1 },
      traceSource: "mock",
      telemetryLoading: false,
      traceLoading: false,
      telemetryError: null,
      traceError: null,
    });
    expect(store.getState().requestTraces).toHaveLength(1);
  });

  it("keeps successful metrics when the trace endpoint fails", async () => {
    const store = storeWith(provider({ fetchTraces: async () => { throw new Error("trace store offline"); } }));
    store.getState().setEnvironment("staging");
    await expect(store.getState().refreshTelemetry()).resolves.toBeUndefined();
    expect(store.getState().telemetry).toEqual(METRICS);
    expect(store.getState().requestTraces).toEqual([]);
    expect(store.getState().traceError).toBe("trace store offline");
  });

  it("commits metrics without waiting for a pending trace request", async () => {
    let resolveTraces: ((value: TraceBundle) => void) | null = null;
    const pendingTraces = new Promise<TraceBundle>((resolve) => { resolveTraces = resolve; });
    const store = storeWith(provider({ fetchTraces: async () => pendingTraces }));
    store.getState().setEnvironment("staging");
    const refresh = store.getState().refreshTelemetry();

    await vi.waitFor(() => {
      expect(store.getState().telemetry).toEqual(METRICS);
      expect(store.getState().telemetryLoading).toBe(false);
    });
    expect(store.getState().traceLoading).toBe(true);
    expect(store.getState().requestTraces).toEqual([]);

    resolveTraces!(bundle("staging"));
    await refresh;
    expect(store.getState().traceLoading).toBe(false);
    expect(store.getState().requestTraces).toHaveLength(1);
  });

  it("drops responses from an environment that was superseded", async () => {
    let resolveDev: ((value: TraceBundle) => void) | null = null;
    const devTraces = new Promise<TraceBundle>((resolve) => { resolveDev = resolve; });
    const store = storeWith(provider({
      fetchTraces: (env) => env === "dev" ? devTraces : Promise.resolve(bundle("staging", "22222222222222222222222222222222")),
    }));
    store.getState().setEnvironment("dev");
    const oldLoad = store.getState().refreshTelemetry();
    store.getState().setEnvironment("staging");
    const newLoad = store.getState().refreshTelemetry();
    await newLoad;
    resolveDev!(bundle("dev"));
    await oldLoad;
    expect(store.getState().environment).toBe("staging");
    expect(store.getState().selectedTraceId).toBe("22222222222222222222222222222222");
    expect(store.getState().requestTraces[0]?.name).toBe("GET /run");
  });

  it("only selects a trace that exists in the loaded bundle", async () => {
    const store = storeWith(provider());
    store.getState().setEnvironment("staging");
    await store.getState().refreshTelemetry();
    store.getState().setSelectedTrace("missing");
    expect(store.getState().selectedTraceId).toBe("11111111111111111111111111111111");
    store.getState().setSelectedTrace(null);
    expect(store.getState().selectedTraceId).toBeNull();
  });

  it("selects the newest trace regardless of provider order", async () => {
    const traces = bundle("staging");
    const oldTrace = { ...traces.traces[0]!, traceId: "22222222222222222222222222222222", startedAtUnixNano: "1", endedAtUnixNano: "2" };
    const newTrace = { ...traces.traces[0]!, traceId: "33333333333333333333333333333333", startedAtUnixNano: "3", endedAtUnixNano: "4" };
    const store = storeWith(provider({ fetchTraces: async () => ({ ...traces, traces: [oldTrace, newTrace] }) }));
    store.getState().setEnvironment("staging");
    await store.getState().refreshTelemetry();
    expect(store.getState().selectedTraceId).toBe(newTrace.traceId);
  });

  it("toggles telemetry presentation without unloading data and closes request-only UI on exit", async () => {
    const demoProvider = provider({ id: "demo" });
    const store = storeWith(demoProvider, {
      telemetrySources: [registration("demo", demoProvider)],
      telemetrySourceId: "demo",
    });
    store.getState().setEnvironment("staging");
    await store.getState().refreshTelemetry();

    const loaded = store.getState();
    const preservedTelemetry = {
      telemetrySourceId: loaded.telemetrySourceId,
      provider: loaded.provider,
      environment: loaded.environment,
      telemetry: loaded.telemetry,
      requestTraces: loaded.requestTraces,
      selectedTraceId: loaded.selectedTraceId,
      traceGraphRef: loaded.traceGraphRef,
      traceSource: loaded.traceSource,
    };

    store.getState().toggleTelemetryMode();
    expect(store.getState()).toMatchObject({ telemetryMode: true, ...preservedTelemetry });

    store.setState({
      logicView: "request",
      flowPaneOrigin: "request",
      requestFlowTraceId: loaded.selectedTraceId,
      requestFlowExpansionOverrides: new Set(["request:span:one"]),
      flowPaneLayoutStatus: "ready",
    });
    store.getState().toggleTelemetryMode();

    expect(store.getState()).toMatchObject({
      telemetryMode: false,
      ...preservedTelemetry,
      logicView: "graph",
      flowPaneOrigin: null,
      requestFlowTraceId: null,
      flowPaneLayoutStatus: "idle",
    });
    expect(store.getState().requestFlowExpansionOverrides).toEqual(new Set());
  });
});
