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
  it("normalizes missing catalog fields for cached renderer HTML", () => {
    vi.stubGlobal("window", { __MERIDIAN__: BASE_CONFIG });

    expect(readBootConfig()).toMatchObject({
      traceUrl: "/api/traces",
      traceAvailable: false,
      telemetrySources: [],
      preselectedTelemetrySourceId: null,
    });
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
