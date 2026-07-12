import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetrySourceDescriptor } from "@meridian/core";
import { createHttpTelemetryProvider } from "./httpProvider";

const MOCK_SOURCE: TelemetrySourceDescriptor = {
  id: "mock",
  kind: "mock",
  label: "Synthetic demo",
  provenance: "synthetic",
  environments: ["staging"],
  supportsMetrics: true,
  supportsTraces: true,
};

const VALID_BUNDLE = {
  traceVersion: "1.0.0",
  source: "mock",
  env: "staging",
  generatedAt: "2026-01-01T00:00:00.000Z",
  graphRef: { schemaVersion: "1.0.0", generatedAt: "2026-01-01T00:00:00.000Z", nodeCount: 1 },
  traces: [{
    traceId: "11111111111111111111111111111111",
    name: "GET /run",
    rootSpanId: "1000000000000001",
    startedAtUnixNano: "1",
    endedAtUnixNano: "2",
    status: "ok",
    attributes: {},
    spans: [{
      spanId: "1000000000000001",
      nodeId: "ts:src/a.ts#run",
      name: "run",
      kind: "server",
      startedAtUnixNano: "1",
      endedAtUnixNano: "2",
      status: "ok",
      attributes: {},
      events: [],
    }],
    completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
  }],
};

afterEach(() => vi.unstubAllGlobals());

describe("HTTP trace provider boundary", () => {
  it("returns a runtime-validated trace bundle", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(VALID_BUNDLE));
    vi.stubGlobal("fetch", fetch);
    const provider = createHttpTelemetryProvider("/overlay", "/traces", MOCK_SOURCE);

    await expect(provider.fetchTraces("staging")).resolves.toMatchObject({ env: "staging", source: "mock" });
    expect(fetch).toHaveBeenCalledWith("/traces?env=staging&source=mock");
  });

  it("rejects structurally invalid trace JSON instead of trusting a cast", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...VALID_BUNDLE, traces: [{ nope: true }] })));
    const provider = createHttpTelemetryProvider("/overlay", "/traces", MOCK_SOURCE);

    await expect(provider.fetchTraces("staging")).rejects.toThrow("invalid request trace payload");
  });

  it("rejects a valid bundle for a different environment", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...VALID_BUNDLE, env: "production" })));
    const provider = createHttpTelemetryProvider("/overlay", "/traces", MOCK_SOURCE);

    await expect(provider.fetchTraces("staging")).rejects.toThrow("requested 'staging', received 'production'");
  });

  it("preserves endpoint parameters and appends encoded environment + source coordinates", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ ...VALID_BUNDLE, source: "tempo", env: "staging west" }));
    vi.stubGlobal("fetch", fetch);
    const provider = createHttpTelemetryProvider(
      "/overlay?id=graph-1",
      "/traces?id=graph-1",
      {
        id: "tempo/live",
        kind: "tempo",
        label: "Tempo",
        provenance: "observed",
        environments: ["staging west"],
        supportsMetrics: true,
        supportsTraces: true,
      },
    );

    expect(provider.id).toBe("tempo/live");
    await provider.fetchTraces("staging west");
    expect(fetch).toHaveBeenCalledWith("/traces?id=graph-1&env=staging+west&source=tempo%2Flive");
  });

  it("rejects a payload whose producer contradicts the selected source provenance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...VALID_BUNDLE, source: "tempo" })));
    const provider = createHttpTelemetryProvider("/overlay", "/traces", MOCK_SOURCE);

    await expect(provider.fetchTraces("staging")).rejects.toThrow("request trace provenance mismatch");
  });

  it("keeps absolute telemetry endpoints absolute", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      overlayVersion: "1.0.0",
      kind: "mock",
      env: "dev",
      generatedAt: "2026-01-01T00:00:00.000Z",
      graphRef: { schemaVersion: "1.0.0", generatedAt: "2026-01-01T00:00:00.000Z", nodeCount: 0 },
      metricsByNodeId: {},
    }));
    vi.stubGlobal("fetch", fetch);
    const provider = createHttpTelemetryProvider(
      "https://telemetry.example/overlay?id=graph-1",
      "/traces",
      { ...MOCK_SOURCE, id: "demo", environments: ["dev"] },
    );

    await provider.fetchMetrics("dev");
    expect(fetch).toHaveBeenCalledWith("https://telemetry.example/overlay?id=graph-1&env=dev&source=demo");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
