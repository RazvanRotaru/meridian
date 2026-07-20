import { afterEach, describe, expect, it, vi } from "vitest";
import { readBootConfig } from "./bootConfig";

const BASE_CONFIG = {
  graphUrl: "/api/graph?id=graph-1",
  metaUrl: "/api/meta?id=graph-1",
  overlayUrl: "/api/overlay?id=graph-1",
  hasOverlay: false,
  overlayKind: null,
  envRequired: true,
  preselectedEnv: null,
  sourceUrl: null,
  defaultEnv: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("telemetry boot config", () => {
  it("offers the synthetic demo source in the plain renderer fallback", () => {
    vi.stubGlobal("window", {});

    expect(readBootConfig()).toMatchObject({
      telemetrySources: [expect.objectContaining({
        id: "demo",
        label: "Synthetic demo",
        provenance: "synthetic",
      })],
      preselectedTelemetrySourceId: null,
    });
  });

  it("normalizes missing catalog fields for cached renderer HTML", () => {
    vi.stubGlobal("window", { __MERIDIAN__: BASE_CONFIG });

    expect(readBootConfig()).toMatchObject({
      traceUrl: "/api/traces",
      traceAvailable: false,
      telemetrySources: [],
      preselectedTelemetrySourceId: null,
      syntheticExecutionUrl: null,
      syntheticExecutionTrust: null,
      syntheticScenarios: [],
    });
  });

  it("accepts only bounded synthetic scenarios and an explicit execution endpoint", () => {
    const scenario = {
      id: "place-order",
      label: "Place order",
      rootId: "ts:src/order.ts#placeOrder",
      defaultInput: { customerId: "cust_1" },
    };
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
        syntheticScenarios: [scenario, { ...scenario }, { id: "broken" }],
      },
    });

    expect(readBootConfig()).toMatchObject({
      syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
      syntheticExecutionTrust: { mode: "local" },
      syntheticScenarios: [scenario],
    });
  });

  it("accepts a bounded sandboxed-PR trust claim only alongside an execution endpoint", () => {
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
        syntheticExecutionTrust: {
          mode: "sandboxed-pr",
          provenance: {
            repository: "acme/shopfront",
            headSha: "abcdef1234567890",
            ignored: "never exposed",
          },
        },
      },
    });

    expect(readBootConfig().syntheticExecutionTrust).toEqual({
      mode: "sandboxed-pr",
      provenance: { repository: "acme/shopfront", headSha: "abcdef1234567890" },
    });

    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        syntheticExecutionTrust: { mode: "sandboxed-pr" },
      },
    });
    expect(readBootConfig().syntheticExecutionTrust).toBeNull();
  });

  it("fails closed for an invalid explicit execution trust claim", () => {
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
        syntheticExecutionTrust: { mode: "host-process" },
      },
    });

    expect(readBootConfig().syntheticExecutionTrust).toBeNull();

    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
        syntheticExecutionTrust: { mode: "sandboxed-pr" },
      },
    });
    expect(readBootConfig().syntheticExecutionTrust).toBeNull();
  });

  it("keeps a legacy single overlay selected when no catalog field was injected", () => {
    vi.stubGlobal("window", {
      __MERIDIAN__: { ...BASE_CONFIG, hasOverlay: true, overlayKind: "mock" },
    });

    expect(readBootConfig()).toMatchObject({
      preselectedTelemetrySourceId: "mock",
      traceAvailable: false,
    });
  });

  it("does not infer a selection when a catalog field is present", () => {
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        hasOverlay: true,
        overlayKind: "mock",
        telemetrySources: [],
      },
    });

    expect(readBootConfig().preselectedTelemetrySourceId).toBeNull();
  });

  it("retains valid unique descriptors and an explicit source selection", () => {
    const source = {
      id: "demo",
      kind: "mock",
      label: "Synthetic demo",
      provenance: "synthetic",
      environments: ["dev"],
      supportsMetrics: true,
      supportsTraces: true,
    };
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        telemetrySources: [source, { ...source }, { id: "invalid" }],
        preselectedTelemetrySourceId: "demo",
      },
    });

    expect(readBootConfig()).toMatchObject({
      telemetrySources: [source],
      preselectedTelemetrySourceId: "demo",
    });
  });

  it("drops a descriptor whose provenance contradicts its source kind", () => {
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        telemetrySources: [{
          id: "spoofed",
          kind: "mock",
          label: "Not actually observed",
          provenance: "observed",
          environments: ["prod"],
          supportsMetrics: true,
          supportsTraces: true,
        }],
      },
    });

    expect(readBootConfig().telemetrySources).toEqual([]);
  });
});
