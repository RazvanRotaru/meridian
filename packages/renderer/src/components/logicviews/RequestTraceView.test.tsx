import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RequestTrace } from "@meridian/core";
import { ALPHA_RUN, freshIndex, freshStore } from "../../parity/surfaceFixture";
import { StoreProvider } from "../../state/StoreContext";
import type { BlueprintState } from "../../state/store";
import type { TelemetryProvider, TelemetrySourceDescriptor } from "../../telemetry/provider";
import { RequestTraceView } from "./RequestTraceView";

const SYNTHETIC_SOURCE: TelemetrySourceDescriptor = {
  id: "synthetic-demo",
  kind: "mock",
  label: "Synthetic demo",
  provenance: "synthetic",
  environments: ["demo"],
  supportsMetrics: true,
  supportsTraces: true,
};

const METRICS_ONLY_SOURCE: TelemetrySourceDescriptor = {
  id: "snapshot",
  kind: "file",
  label: "Saved metrics snapshot",
  provenance: "saved",
  environments: ["demo"],
  supportsMetrics: true,
  supportsTraces: false,
};

const PROVIDER: TelemetryProvider = {
  id: "mock",
  requiresEnvironment: true,
  listEnvironments: () => ["demo"],
  fetchMetrics: async () => ({}),
  fetchTraces: async () => { throw new Error("unused in render test"); },
};

describe("RequestTraceView empty request-data states", () => {
  it("points to the persistent request-data picker while the source is off", () => {
    const markup = renderView({ telemetrySources: [SYNTHETIC_SOURCE], telemetrySourceId: null, provider: null });

    expect(markup).toContain("Choose request data");
    expect(markup).toContain("Request data in the left panel");
    expect(markup).not.toContain('aria-label="Request data source"');
    expect(markup).toContain("timing, branches, and captured data");
  });

  it("keeps contextual load guidance before an environment is applied", () => {
    const markup = renderView({
      telemetrySources: [SYNTHETIC_SOURCE],
      telemetrySourceId: "synthetic-demo",
      provider: PROVIDER,
      environment: null,
    });

    expect(markup).toContain("Load request data");
    expect(markup).toContain("Request data in the left panel");
    expect(markup).not.toContain('aria-label="Request data source"');
    expect(markup).toContain("Nothing loads automatically");
  });

  it("explains when the session advertises no request source", () => {
    const markup = renderView({ telemetrySources: [], telemetrySourceId: null, provider: null });

    expect(markup).toContain("Request telemetry isn&#x27;t available");
    expect(markup).toContain("does not advertise a request telemetry source");
    expect(markup).not.toContain('aria-label="Request data source"');
  });

  it("explains a selected metrics-only source without implying captures are missing", () => {
    const markup = renderView({
      telemetrySources: [METRICS_ONLY_SOURCE],
      telemetrySourceId: METRICS_ONLY_SOURCE.id,
      provider: PROVIDER,
      environment: "demo",
    });

    expect(markup).toContain("Request traces unavailable");
    expect(markup).toContain("Saved metrics snapshot provides aggregate metrics only.");
    expect(markup).not.toContain("Run the flow");
  });
});

describe("RequestTraceView request navigation", () => {
  it("shows previous/next controls and position in newest-first candidate order", () => {
    const older = requestTrace("older", "1000000000", "older request");
    const newer = requestTrace("newer", "2000000000", "newer request");
    const markup = renderView({
      telemetrySources: [SYNTHETIC_SOURCE],
      telemetrySourceId: "synthetic-demo",
      provider: PROVIDER,
      environment: "demo",
      requestTraces: [older, newer],
      selectedTraceId: newer.traceId,
      traceSource: "mock",
    });

    expect(markup).toContain('aria-label="Request trace selection"');
    expect(markup).toContain('aria-label="Previous request"');
    expect(markup).toContain('aria-label="Next request"');
    expect(markup).toContain('aria-label="Request 1 of 2"');
    expect(markup).toContain("1 of 2");
    expect(markup.indexOf("newer request")).toBeLessThan(markup.indexOf("older request"));
  });
});

function requestTrace(traceId: string, startedAtUnixNano: string, name: string): RequestTrace {
  const endedAtUnixNano = (BigInt(startedAtUnixNano) + 1_000_000n).toString();
  return {
    traceId,
    name,
    rootSpanId: `${traceId}-span`,
    startedAtUnixNano,
    endedAtUnixNano,
    status: "ok",
    attributes: {},
    spans: [{
      spanId: `${traceId}-span`,
      nodeId: ALPHA_RUN,
      name: "run",
      kind: "server",
      startedAtUnixNano,
      endedAtUnixNano,
      status: "ok",
      attributes: {},
      events: [],
    }],
    completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
  };
}

function renderView(state: Partial<BlueprintState>): string {
  const store = freshStore();
  store.setState(state);
  const initial = store.getState();
  Object.assign(store, { getInitialState: () => initial });
  return renderToStaticMarkup(
    <StoreProvider store={store}>
      <RequestTraceView
        rootId={ALPHA_RUN}
        index={freshIndex()}
        selected={null}
        onSelect={() => undefined}
        onDrill={() => undefined}
      />
    </StoreProvider>,
  );
}
