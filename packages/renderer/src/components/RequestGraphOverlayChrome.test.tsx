import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { RequestTrace } from "@meridian/core";
import type { ProjectedRequestNodeEvidence, RequestEventCounts } from "../derive/requestGraphOverlay";
import { buildRendererReachabilityReport } from "../derive/reachabilityFacts";
import { freshStore } from "../parity/surfaceFixture";
import { StoreProvider } from "../state/StoreContext";
import type { BlueprintState } from "../state/store";
import type { TelemetryProvider, TelemetrySourceDescriptor } from "../telemetry/provider";
import {
  parentSpanCallerPath,
  requestFlowDisabledReason,
  requestRevealDisabledReason,
  RequestGraphNodeBadges,
  RequestGraphOverlayPanel,
} from "./RequestGraphOverlayChrome";

const toolbarCalls = vi.hoisted(() => [] as Array<{ nodeId?: string | string[]; className?: string }>);

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Panel: ({ children, position: _position, ...props }: React.HTMLAttributes<HTMLDivElement> & { position?: string }) => (
      <div {...props}>{children}</div>
    ),
    NodeToolbar: ({ children, nodeId, isVisible: _isVisible, position: _position, offset: _offset, ...props }:
      React.HTMLAttributes<HTMLDivElement> & { nodeId?: string | string[]; isVisible?: boolean; position?: unknown; offset?: number }) => {
      toolbarCalls.push({ nodeId, className: props.className });
      return <div {...props}>{children}</div>;
    },
  };
});

const PROVIDER: TelemetryProvider = {
  id: "mock",
  requiresEnvironment: true,
  listEnvironments: () => ["demo"],
  fetchMetrics: async () => ({}),
  fetchTraces: async () => { throw new Error("unused in render test"); },
};

const SYNTHETIC_SOURCE: TelemetrySourceDescriptor = {
  id: "synthetic-demo",
  kind: "mock",
  label: "Synthetic demo",
  provenance: "synthetic",
  environments: ["demo"],
  supportsMetrics: true,
  supportsTraces: true,
};

const EVENT_COUNTS: RequestEventCounts = {
  branchTaken: 1,
  dataObserve: 2,
  loopSummary: 0,
  asyncHandoff: 0,
  exception: 1,
};

describe("RequestGraphOverlayPanel", () => {
  it("renders nothing when no telemetry source, provider, or trace state exists", () => {
    expect(renderPanel({ telemetrySources: [], provider: null })).toBe("");
  });

  it("points setup to the one persistent request-data picker", () => {
    const markup = renderPanel({
      telemetrySources: [SYNTHETIC_SOURCE],
      telemetrySourceId: null,
      provider: null,
      environment: null,
    });

    expect(markup).toContain('aria-label="Request overlay setup"');
    expect(markup).toContain("REQUEST OVERLAY");
    expect(markup).toContain("Request data in the left panel");
    expect(markup).not.toContain('aria-label="Request data source"');
  });

  it("moves request controls beside the coverage panel when both overlays are active", () => {
    const markup = renderPanel({
      telemetrySources: [SYNTHETIC_SOURCE],
      telemetrySourceId: null,
      provider: null,
      coverageMode: true,
      coverage: buildRendererReachabilityReport([], []),
    });

    expect(markup).toContain("right:352px");
    expect(markup).toContain('aria-label="Request overlay setup"');
  });

  it("shows a loaded-empty status instead of duplicating the source picker", () => {
    const markup = renderPanel({
      telemetrySources: [SYNTHETIC_SOURCE],
      telemetrySourceId: SYNTHETIC_SOURCE.id,
      provider: PROVIDER,
      environment: "demo",
      requestTraces: [],
      traceLoading: false,
    });

    expect(markup).toContain('aria-label="Request overlay status"');
    expect(markup).toContain("No request captures are available in demo.");
    expect(markup).not.toContain('aria-label="Request data source"');
  });

  it("offers the newest loaded request when the graph overlay is hidden", () => {
    const old = trace("11111111111111111111111111111111", "1000000000", "1012500000", "old request");
    const newest = trace("22222222222222222222222222222222", "2000000000", "2012500000", "newest request");
    const markup = renderPanel({
      provider: PROVIDER,
      environment: "demo",
      requestTraces: [old, newest],
      selectedTraceId: null,
      traceSource: "mock",
    });

    expect(markup).toContain("Show request on map");
    expect(markup).toContain("newest request");
    expect(markup).not.toContain("old request");
    expect(markup).toContain("SYNTHETIC DEMO");
  });

  it("shows active request provenance, selector, completeness, mismatch, error, and legend counts", () => {
    const active = trace("22222222222222222222222222222222", "2000000000", "2012500000", "POST /orders", false);
    const other = trace("11111111111111111111111111111111", "1000000000", "1005000000", "POST /health");
    const markup = renderPanel({
      provider: PROVIDER,
      environment: "demo",
      requestTraces: [other, active],
      selectedTraceId: active.traceId,
      traceSource: "mock",
      traceLoading: true,
      traceError: "collector offline",
      moduleSelected: new Set(["ts:src/b.ts#save"]),
    }, {
      graphMismatches: ["node count 2 ≠ 3"],
      observedNodeCount: 2,
      visibleSummary: { observedNodes: 4, errorNodes: 1, notObservedNodes: 7 },
    });

    expect(markup).toContain('aria-label="Selected request graph overlay"');
    expect(markup).toContain("SYNTHETIC DEMO · DEMO");
    expect(markup).toContain("POST /orders");
    expect(markup).toContain('aria-label="Request shown on map"');
    expect(markup).toContain('aria-label="Previous request"');
    expect(markup).toContain('aria-label="Next request"');
    expect(markup).toContain('aria-label="Request 1 of 2"');
    expect(markup).toContain("1 of 2");
    expect(markup).toContain('aria-label="Hide request from map"');
    expect(markup).toContain('aria-label="Reveal observed nodes (2)"');
    expect(markup).toContain('title="This request belongs to a different graph."');
    expect(markup).toContain('aria-label="Show selected request logic flow"');
    expect(markup).toContain("Show request logic flow");
    expect(markup).toContain('aria-label="Request call path: run to save"');
    expect(markup).toContain("run → save");
    expect(markup).toContain("SELECTED OBSERVED · save");
    expect(markup).toContain("The request split reconstructs this whole execution; map clicks only inspect code.");
    expect(markup).toContain("12.5ms total");
    expect(markup).toContain("2 spans");
    expect(markup).toContain("2 events");
    expect(markup).toContain("partial capture");
    expect(markup).toContain("1 dropped spans · 2 dropped events · 3 dropped values");
    expect(markup).toContain("refreshing…");
    expect(markup).toContain("Map overlay disabled: trace graph reference mismatch");
    expect(markup).toContain("collector offline");
    expect(markup).toContain("Observed in selected request (4)");
    expect(markup).toContain("Error in selected request (1)");
    expect(markup).toContain("Not observed in selected request (7)");
  });
});

describe("requestRevealDisabledReason", () => {
  it("enables a mapped compatible request and explains every blocking state", () => {
    expect(requestRevealDisabledReason({
      graphMismatches: [],
      observedNodeCount: 3,
      minimalOpen: false,
      moduleLayoutStatus: "ready",
    })).toBeNull();
    expect(requestRevealDisabledReason({
      graphMismatches: ["wrong graph"],
      observedNodeCount: 3,
      minimalOpen: false,
      moduleLayoutStatus: "ready",
    })).toMatch(/different graph/);
    expect(requestRevealDisabledReason({
      graphMismatches: [],
      observedNodeCount: 0,
      minimalOpen: false,
      moduleLayoutStatus: "ready",
    })).toMatch(/No spans/);
    expect(requestRevealDisabledReason({
      graphMismatches: [],
      observedNodeCount: 3,
      minimalOpen: true,
      moduleLayoutStatus: "ready",
    })).toMatch(/Close the extracted graph/);
    expect(requestRevealDisabledReason({
      graphMismatches: [],
      observedNodeCount: 3,
      minimalOpen: false,
      moduleLayoutStatus: "laying-out",
    })).toMatch(/Wait for the graph layout/);
  });
});

describe("requestFlowDisabledReason", () => {
  it("keeps request reconstruction independent from node selection and explains true blockers", () => {
    expect(requestFlowDisabledReason({ graphMismatches: [], spanCount: 3, minimalOpen: false, flowOpen: false })).toBeNull();
    expect(requestFlowDisabledReason({ graphMismatches: ["wrong graph"], spanCount: 3, minimalOpen: false, flowOpen: false })).toMatch(/different graph/);
    expect(requestFlowDisabledReason({ graphMismatches: [], spanCount: 0, minimalOpen: false, flowOpen: false })).toMatch(/No spans/);
    expect(requestFlowDisabledReason({ graphMismatches: [], spanCount: 3, minimalOpen: true, flowOpen: false })).toMatch(/Close the extracted graph/);
    expect(requestFlowDisabledReason({ graphMismatches: [], spanCount: 3, minimalOpen: false, flowOpen: true })).toMatch(/already open/);
  });
});

describe("parentSpanCallerPath", () => {
  it("uses parent spans to explain the caller chain for selected observed code", () => {
    const request = trace("trace", "1000000000", "1012500000", "POST /orders");

    expect(parentSpanCallerPath(request, new Set(["ts:src/b.ts#save"]))).toEqual({
      labels: ["run", "save"],
      targetLabel: "save",
      matchedContext: true,
    });
  });

  it("falls back to the deepest deterministic caller chain", () => {
    const request = trace("trace", "1000000000", "1012500000", "POST /orders");

    expect(parentSpanCallerPath(request)).toEqual({
      labels: ["run", "save"],
      targetLabel: "save",
      matchedContext: false,
    });
  });
});

describe("RequestGraphNodeBadges", () => {
  beforeEach(() => {
    toolbarCalls.length = 0;
  });

  it("renders one always-visible evidence badge per visible mapped node and carries semantic depth", () => {
    const visibleNodes: Node[] = [
      { id: "node-a", type: "file", position: { x: 0, y: 0 }, data: { semanticDepth: 2 } },
      { id: "node-b", type: "file", position: { x: 200, y: 0 }, data: {} },
    ];
    const evidence = new Map<string, ProjectedRequestNodeEvidence>([
      ["node-a", projectedEvidence("node-a")],
      ["not-visible", projectedEvidence("not-visible")],
    ]);

    const markup = renderToStaticMarkup(
      <RequestGraphNodeBadges visibleNodes={visibleNodes} evidenceByNodeId={evidence} />,
    );

    expect(toolbarCalls).toEqual([{
      nodeId: "node-a",
      className: expect.stringContaining("semantic-layer-2"),
    }]);
    expect(toolbarCalls[0]?.className).toContain("semantic-layer");
    expect(markup).toContain('data-request-node-id="node-a"');
    expect(markup).toContain('data-request-status="error"');
    expect(markup).toContain("#2");
    expect(markup).toContain("12.0ms");
    expect(markup).toContain("×3");
    expect(markup).toContain("4 evt");
    expect(markup).toContain("3 occurrences, 4 events, error status");
    expect(markup).not.toContain("not-visible");
  });
});

function renderPanel(
  state: Partial<BlueprintState>,
  props: React.ComponentProps<typeof RequestGraphOverlayPanel> = { graphMismatches: [], observedNodeCount: 0 },
): string {
  const store = freshStore();
  store.setState(state);
  const initial = store.getState();
  // Zustand's SSR snapshot is its creation state unless advanced explicitly.
  Object.assign(store, { getInitialState: () => initial });
  return renderToStaticMarkup(
    <StoreProvider store={store}>
      <RequestGraphOverlayPanel {...props} />
    </StoreProvider>,
  );
}

function trace(
  traceId: string,
  startedAtUnixNano: string,
  endedAtUnixNano: string,
  name: string,
  complete = true,
): RequestTrace {
  return {
    traceId,
    name,
    rootSpanId: "1000000000000001",
    startedAtUnixNano,
    endedAtUnixNano,
    status: "ok",
    attributes: {},
    spans: [
      {
        spanId: "1000000000000001",
        nodeId: "ts:src/a.ts#run",
        name: "run",
        kind: "server",
        startedAtUnixNano,
        endedAtUnixNano,
        status: "ok",
        attributes: {},
        events: [{
          type: "data.observe",
          eventId: "event-1",
          timeUnixNano: startedAtUnixNano,
          attributes: {},
          name: "request.id",
          valueId: "request-id",
          value: "safe-id",
        }],
      },
      {
        spanId: "2000000000000002",
        parentSpanId: "1000000000000001",
        nodeId: "ts:src/b.ts#save",
        name: "save",
        kind: "internal",
        startedAtUnixNano,
        endedAtUnixNano,
        status: "ok",
        attributes: {},
        events: [{
          type: "exception",
          eventId: "event-2",
          timeUnixNano: endedAtUnixNano,
          attributes: {},
          exceptionType: "DemoError",
          handled: true,
        }],
      },
    ],
    completeness: complete
      ? { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 }
      : { complete: false, droppedSpans: 1, droppedEvents: 2, droppedValues: 3 },
  };
}

function projectedEvidence(visibleNodeId: string): ProjectedRequestNodeEvidence {
  return {
    visibleNodeId,
    occurrenceCount: 3,
    inclusiveSpanMs: 17,
    activeWallMs: 12,
    firstSequence: 2,
    status: "error",
    eventCounts: EVENT_COUNTS,
    directSourceIds: [visibleNodeId],
    rollupSourceIds: [],
  };
}
