import { afterEach, describe, expect, it, vi } from "vitest";
import { prApiUrlsForGraph, readBootConfig } from "./bootConfig";

const BASE_CONFIG = {
  projectionGraphId: "graph-1",
  projectionManifestUrl: "/api/graph/manifest?id=graph-1",
  projectionUrl: "/api/graph/projection?id=graph-1",
  graphSearchUrl: "/api/graph/search?id=graph-1",
  metaUrl: "/api/meta?id=graph-1",
  overlayUrl: "/api/overlay?id=graph-1",
  traceUrl: "/api/traces?id=graph-1",
  hasOverlay: false,
  overlayKind: null,
  envRequired: true,
  preselectedEnv: null,
  sourceUrl: null,
  telemetrySources: [],
  preselectedTelemetrySourceId: null,
  syntheticExecutionUrl: null,
  syntheticExecutionTrust: null,
  syntheticScenarios: [],
  githubSource: null,
  preparedReviewUrl: null,
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

  it("rejects injected sessions that omit current contract fields", () => {
    const { telemetrySources: _telemetrySources, ...missingCatalog } = BASE_CONFIG;
    vi.stubGlobal("window", { __MERIDIAN__: missingCatalog });
    expect(() => readBootConfig()).toThrow("missing current field telemetrySources");
  });

  it("preserves bounded synthetic execution capability fields through projection boot", () => {
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
        syntheticExecutionTrust: { mode: "local" },
        syntheticScenarios: [scenario],
      },
    });

    expect(readBootConfig()).toMatchObject({
      graphSource: { kind: "projections" },
      syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
      syntheticExecutionTrust: { mode: "local" },
      syntheticScenarios: [scenario],
    });
  });

  it("disables the entire synthetic capability for a malformed or duplicate scenario catalog", () => {
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
        syntheticExecutionTrust: { mode: "local" },
        syntheticScenarios: [scenario, { ...scenario }],
      },
    });
    expect(readBootConfig()).toMatchObject({
      syntheticExecutionUrl: null,
      syntheticExecutionTrust: null,
      syntheticScenarios: [],
    });
  });

  it("disables an endpoint and trust claim when the scenario catalog is empty", () => {
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
        syntheticExecutionTrust: { mode: "local" },
        syntheticScenarios: [],
      },
    });

    expect(readBootConfig()).toMatchObject({
      syntheticExecutionUrl: null,
      syntheticExecutionTrust: null,
      syntheticScenarios: [],
    });
  });

  it("accepts only a complete sandboxed-PR trust claim alongside an execution endpoint", () => {
    const scenario = {
      id: "place-order",
      label: "Place order",
      rootId: "ts:src/order.ts#placeOrder",
      defaultInput: {},
    };
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
        syntheticScenarios: [scenario],
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
        syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
        syntheticScenarios: [scenario],
        syntheticExecutionTrust: { mode: "sandboxed-pr" },
      },
    });
    expect(readBootConfig().syntheticExecutionTrust).toBeNull();
  });

  it("never infers local trust from an execution URL", () => {
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
      },
    });
    expect(readBootConfig().syntheticExecutionTrust).toBeNull();

    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
        syntheticExecutionTrust: { mode: "host-process" },
      },
    });
    expect(readBootConfig().syntheticExecutionTrust).toBeNull();
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

  it("retains a valid descriptor and an explicit source selection", () => {
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
        telemetrySources: [source],
        preselectedTelemetrySourceId: "demo",
      },
    });

    expect(readBootConfig()).toMatchObject({
      telemetrySources: [source],
      preselectedTelemetrySourceId: "demo",
    });
  });

  it("rejects duplicate telemetry descriptors instead of filtering the authority catalog", () => {
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
      __MERIDIAN__: { ...BASE_CONFIG, telemetrySources: [source, { ...source }] },
    });

    expect(() => readBootConfig()).toThrow("telemetrySources contains an invalid or duplicate descriptor");
  });

  it("rejects a descriptor whose provenance contradicts its source kind", () => {
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

    expect(() => readBootConfig()).toThrow("telemetrySources contains an invalid");
  });
});

describe("graph projection boot config", () => {
  it("binds PR APIs to the explicit graph identity without inspecting endpoint URLs", () => {
    expect(prApiUrlsForGraph("graph-explicit")).toMatchObject({
      prsUrl: "/api/prs?id=graph-explicit",
      prFilesUrl: "/api/prs/files?id=graph-explicit",
      prReviewUrl: "/api/prs/review?id=graph-explicit",
    });
  });

  it("accepts only a same-origin prepared-review endpoint in a GitHub session", () => {
    const githubSource = { repository: "acme/shop", subdir: "packages/api" };
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        githubSource,
        preparedReviewUrl: "/api/pr/prepared?id=opaque%2Fhandoff",
      },
    });
    expect(readBootConfig()).toMatchObject({
      githubSource,
      preparedReviewUrl: "/api/pr/prepared?id=opaque%2Fhandoff",
    });

    for (const preparedReviewUrl of [
      "https://example.com/api/pr/prepared?id=opaque",
      "//example.com/api/pr/prepared?id=opaque",
      "/api/pr/prepared",
      "/api/pr/prepared?id=opaque&extra=1",
      "/api/pr/prepare?id=opaque",
    ]) {
      vi.stubGlobal("window", { __MERIDIAN__: { ...BASE_CONFIG, githubSource, preparedReviewUrl } });
      expect(() => readBootConfig()).toThrow("preparedReviewUrl");
    }
  });

  it("requires every projection capability endpoint in an injected session", () => {
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        projectionManifestUrl: "/api/graph/manifest?id=graph-1",
        projectionUrl: "/api/graph/projection?id=graph-1",
        graphSearchUrl: "/api/graph/search?id=graph-1",
      },
    });

    expect(readBootConfig().graphSource).toEqual({
      kind: "projections",
      graphId: "graph-1",
      manifestUrl: "/api/graph/manifest?id=graph-1",
      projectionUrl: "/api/graph/projection?id=graph-1",
      searchUrl: "/api/graph/search?id=graph-1",
    });

    const { projectionUrl: _projectionUrl, ...missingProjectionUrl } = BASE_CONFIG;
    vi.stubGlobal("window", { __MERIDIAN__: missingProjectionUrl });
    expect(() => readBootConfig()).toThrow(
      "missing current field projectionUrl",
    );

    const { graphSearchUrl: _graphSearchUrl, ...missingSearchUrl } = BASE_CONFIG;
    vi.stubGlobal("window", { __MERIDIAN__: missingSearchUrl });
    expect(() => readBootConfig()).toThrow(
      "missing current field graphSearchUrl",
    );

    const { projectionGraphId: _projectionGraphId, ...missingGraphId } = BASE_CONFIG;
    vi.stubGlobal("window", { __MERIDIAN__: missingGraphId });
    expect(() => readBootConfig()).toThrow(
      "missing current field projectionGraphId",
    );
  });
});
