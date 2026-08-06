import { afterEach, describe, expect, it, vi } from "vitest";
import { readBootConfig } from "./bootConfig";

const BASE_CONFIG = {
  graphUrl: "/api/graph?id=graph-1",
  graphViewLease: {
    version: 1,
    leaseId: "a".repeat(32),
    url: `/api/graph-views/${"a".repeat(32)}`,
    createUrl: "/api/graph-views",
    expiresAtMs: 10_000,
    heartbeatIntervalMs: 1_000,
  },
  metaUrl: "/api/meta?id=graph-1",
  overlayUrl: "/api/overlay?id=graph-1",
  hasOverlay: false,
  overlayKind: null,
  envRequired: true,
  preselectedEnv: null,
  sourceUrl: null,
  defaultEnv: null,
};

const HANDOFF_CLAIM_ID = "h".repeat(32);
const PREPARED_REVIEW_HANDOFF = {
  version: 1,
  claimId: HANDOFF_CLAIM_ID,
  url: `/api/pr-review-handoffs/${HANDOFF_CLAIM_ID}`,
  expiresAtMs: 10_000,
  headGraphId: "graph-1",
  comparisonGraphId: "base-graph",
};

const PREPARED_REVIEW_CONFIG = {
  ...BASE_CONFIG,
  graphViewLease: {
    ...BASE_CONFIG.graphViewLease,
    graphIds: ["graph-1", "base-graph"],
  },
  preparedReviewHandoff: PREPARED_REVIEW_HANDOFF,
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
      graphProjectUrl: null,
      graphSymbolsUrl: null,
      traceUrl: "/api/traces",
      traceAvailable: false,
      telemetrySources: [],
      preselectedTelemetrySourceId: null,
      syntheticExecutionUrl: null,
      syntheticExecutionTrust: null,
      syntheticScenarios: [],
      graphViewLease: BASE_CONFIG.graphViewLease,
      preparedReviewHandoff: null,
    });
  });

  it("accepts an exact prepared review handoff protected by the boot view lease", () => {
    vi.stubGlobal("window", { __MERIDIAN__: PREPARED_REVIEW_CONFIG });

    expect(readBootConfig()).toMatchObject({
      graphViewLease: {
        ...BASE_CONFIG.graphViewLease,
        graphIds: ["graph-1", "base-graph"],
      },
      preparedReviewHandoff: PREPARED_REVIEW_HANDOFF,
    });
  });

  it.each([
    ["missing", undefined],
    ["explicit null", null],
  ])("keeps an ordinary paired view claimless when the handoff is %s", (_label, handoffValue) => {
    const { preparedReviewHandoff: _omitted, ...claimlessConfig } = PREPARED_REVIEW_CONFIG;
    vi.stubGlobal("window", {
      __MERIDIAN__: handoffValue === undefined
        ? claimlessConfig
        : { ...claimlessConfig, preparedReviewHandoff: handoffValue },
    });

    expect(readBootConfig().preparedReviewHandoff).toBeNull();
  });

  it.each([
    ["non-object", "claim"],
    ["extra field", { ...PREPARED_REVIEW_HANDOFF, extra: true }],
    ["unsupported version", { ...PREPARED_REVIEW_HANDOFF, version: 2 }],
    ["short claim", {
      ...PREPARED_REVIEW_HANDOFF,
      claimId: "too-short",
      url: "/api/pr-review-handoffs/too-short",
    }],
    ["mismatched claim URL", {
      ...PREPARED_REVIEW_HANDOFF,
      url: `/api/pr-review-handoffs/${"i".repeat(32)}`,
    }],
    ["foreign claim URL", {
      ...PREPARED_REVIEW_HANDOFF,
      url: `https://example.test/api/pr-review-handoffs/${HANDOFF_CLAIM_ID}`,
    }],
    ["claim URL query", {
      ...PREPARED_REVIEW_HANDOFF,
      url: `/api/pr-review-handoffs/${HANDOFF_CLAIM_ID}?retry=1`,
    }],
    ["same pair graph", {
      ...PREPARED_REVIEW_HANDOFF,
      comparisonGraphId: "graph-1",
    }],
    ["negative expiry", { ...PREPARED_REVIEW_HANDOFF, expiresAtMs: -1 }],
  ])("rejects a malformed prepared review handoff: %s", (_label, preparedReviewHandoff) => {
    vi.stubGlobal("window", {
      __MERIDIAN__: { ...PREPARED_REVIEW_CONFIG, preparedReviewHandoff },
    });

    expect(() => readBootConfig()).toThrow("preparedReviewHandoff is invalid");
  });

  it.each([
    ["different boot graph", {
      ...PREPARED_REVIEW_CONFIG,
      graphUrl: "/api/graph?id=other-head",
    }],
    ["unprotected comparison graph", {
      ...PREPARED_REVIEW_CONFIG,
      graphViewLease: {
        ...PREPARED_REVIEW_CONFIG.graphViewLease,
        graphIds: ["graph-1"],
      },
    }],
    ["mismatched handoff head", {
      ...PREPARED_REVIEW_CONFIG,
      preparedReviewHandoff: {
        ...PREPARED_REVIEW_HANDOFF,
        headGraphId: "other-head",
      },
    }],
  ])("rejects a prepared review handoff bound to a %s", (_label, config) => {
    vi.stubGlobal("window", { __MERIDIAN__: config });

    expect(() => readBootConfig()).toThrow("preparedReviewHandoff is not protected by this view");
  });

  it("rejects duplicate graph protection instead of ambiguously accepting a handoff", () => {
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...PREPARED_REVIEW_CONFIG,
        graphViewLease: {
          ...PREPARED_REVIEW_CONFIG.graphViewLease,
          graphIds: ["graph-1", "base-graph", "base-graph"],
        },
      },
    });

    expect(() => readBootConfig()).toThrow("graphViewLease is invalid");
  });

  it("accepts only paired same-origin progressive graph capabilities", () => {
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        graphProjectUrl: "/api/graph/project",
        graphSymbolsUrl: "/api/graph/symbols",
      },
    });

    expect(readBootConfig()).toMatchObject({
      graphProjectUrl: "/api/graph/project",
      graphSymbolsUrl: "/api/graph/symbols",
    });

    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        graphProjectUrl: "https://example.test/api/graph/project",
        graphSymbolsUrl: "/api/graph/symbols?token=nope",
      },
    });
    expect(readBootConfig()).toMatchObject({ graphProjectUrl: null, graphSymbolsUrl: null });

    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        graphProjectUrl: "/api/graph/project",
        graphSymbolsUrl: "/api/graph/symbols?token=nope",
      },
    });
    expect(readBootConfig()).toMatchObject({ graphProjectUrl: null, graphSymbolsUrl: null });
  });

  it("rejects an injected server boot contract without a graph view lease", () => {
    const { graphViewLease: _omitted, ...withoutLease } = BASE_CONFIG;
    vi.stubGlobal("window", { __MERIDIAN__: withoutLease });

    expect(() => readBootConfig()).toThrow("graphViewLease is required");
  });

  it("accepts an explicit null lease only for a non-evicting static artifact server", () => {
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        ...BASE_CONFIG,
        graphUrl: "/api/graph",
        graphViewLease: null,
      },
    });

    expect(readBootConfig().graphViewLease).toBeNull();
  });

  it("rejects a registered graph id without its renewable view lease", () => {
    vi.stubGlobal("window", { __MERIDIAN__: { ...BASE_CONFIG, graphViewLease: null } });

    expect(() => readBootConfig())
      .toThrow("registered graph views require a graphViewLease");
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
