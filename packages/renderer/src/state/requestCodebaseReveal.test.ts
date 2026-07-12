import { describe, expect, it, vi } from "vitest";
import type { RequestTrace } from "@meridian/core";
import {
  A_FILE,
  ALPHA,
  ALPHA_RUN,
  APP_PKG,
  ARTIFACT,
  BETA,
  BETA_PKG,
  BETA_RUN,
  B_FILE,
  CORE,
  TEST_FILE,
  freshStore,
} from "../parity/surfaceFixture";

const TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("selected request codebase reveal", () => {
  it("reuses the canonical LCA expansion, switches to Map, fits exact targets, and preserves the request split", async () => {
    const store = requestStore([ALPHA_RUN, BETA_RUN]);
    const relayout = vi.fn(async () => {});
    store.setState({
      viewMode: "call",
      moduleRelayout: relayout,
      moduleLayoutStatus: "ready",
      moduleSelected: new Set([ALPHA_RUN]),
      flowSelection: null,
      flowPaneOrigin: "request",
      requestFlowTraceId: TRACE_ID,
      showPrivate: false,
      hiddenCategories: new Set(["util" as const]),
    });

    store.getState().revealSelectedTraceInCodebase();

    const state = store.getState();
    expect(state.viewMode).toBe("modules");
    expect(state.moduleFocus).toBe(APP_PKG);
    expect(state.moduleExpanded).toEqual(new Set([
      CORE,
      A_FILE,
      ALPHA,
      BETA_PKG,
      B_FILE,
      BETA,
    ]));
    expect(state.moduleSelected).toEqual(new Set([ALPHA_RUN, BETA_RUN]));
    expect(state.serviceScope).toBeNull();
    expect(state.showPrivate).toBe(true);
    expect(state.hiddenCategories).toEqual(new Set());
    expect(state.flowSelection).toBeNull();
    expect(state.flowPaneOrigin).toBe("request");
    expect(state.requestFlowTraceId).toBe(TRACE_ID);
    expect(relayout).toHaveBeenCalledWith({ label: "Revealing 2 observed nodes…" });
    await vi.waitFor(() => expect(store.getState().recenterSeq).toBe(1));
  });

  it("shows an observed test path even when tests were hidden", () => {
    const store = requestStore([TEST_FILE]);
    store.setState({ moduleRelayout: vi.fn(async () => {}), moduleLayoutStatus: "ready", showTests: false });

    store.getState().revealSelectedTraceInCodebase();

    expect(store.getState().showTests).toBe(true);
    expect(store.getState().moduleSelected).toEqual(new Set([TEST_FILE]));
  });

  it("ignores unmapped spans but still reveals every exact mapped span", () => {
    const store = requestStore([ALPHA_RUN, "ts:missing/file.ts#gone", BETA_RUN]);
    store.setState({ moduleRelayout: vi.fn(async () => {}), moduleLayoutStatus: "ready" });

    store.getState().revealSelectedTraceInCodebase();

    expect(store.getState().moduleSelected).toEqual(new Set([ALPHA_RUN, BETA_RUN]));
  });

  it("installs the same canonical Map state for bulk and one-target request reveals", () => {
    const bulk = requestStore([BETA_RUN]);
    const single = requestStore([BETA_RUN]);
    const seedStaleLens = (store: typeof bulk) => store.setState({
      viewMode: "call",
      moduleRelayout: vi.fn(async () => {}),
      moduleLayoutStatus: "ready",
      moduleRfNodes: [{ id: ALPHA_RUN, type: "block", position: { x: 0, y: 0 }, data: {} }],
      mapExtra: new Set([ALPHA_RUN]),
      mapGhostPins: new Map([[ALPHA_RUN, new Set([BETA_RUN])]]),
      moduleGhostInspection: {
        anchorIds: new Set([ALPHA_RUN]),
        visitedIds: new Set([BETA_RUN]),
      },
      showPrivate: false,
      hiddenCategories: new Set(["util"]),
    });
    seedStaleLens(bulk);
    seedStaleLens(single);
    single.setState({
      flowPaneOrigin: "request",
      requestFlowTraceId: TRACE_ID,
    });

    bulk.getState().revealSelectedTraceInCodebase();
    single.getState().selectFlowPaneTarget(BETA_RUN);

    const snapshot = (store: typeof bulk) => {
      const state = store.getState();
      return {
        viewMode: state.viewMode,
        moduleFocus: state.moduleFocus,
        moduleExpanded: state.moduleExpanded,
        moduleSelected: state.moduleSelected,
        mapExtra: state.mapExtra,
        mapGhostPins: state.mapGhostPins,
        moduleGhostInspection: state.moduleGhostInspection,
        moduleRfNodes: state.moduleRfNodes,
        moduleRfEdges: state.moduleRfEdges,
        moduleSemanticLayers: state.moduleSemanticLayers,
        moduleEffectiveFocus: state.moduleEffectiveFocus,
        serviceScope: state.serviceScope,
        hiddenCategories: state.hiddenCategories,
        showPrivate: state.showPrivate,
        showTests: state.showTests,
      };
    };
    expect(snapshot(single)).toEqual(snapshot(bulk));
    expect(snapshot(bulk)).toMatchObject({
      viewMode: "modules",
      mapExtra: new Set(),
      mapGhostPins: new Map(),
      moduleGhostInspection: null,
      moduleRfNodes: [],
      hiddenCategories: new Set(),
      showPrivate: true,
    });
  });

  it("is inert for a graph mismatch, a fully unmapped request, or an open minimal graph", () => {
    const mismatch = requestStore([ALPHA_RUN]);
    const mismatchRelayout = vi.fn(async () => {});
    mismatch.setState({
      moduleRelayout: mismatchRelayout,
      moduleLayoutStatus: "ready",
      traceGraphRef: { schemaVersion: ARTIFACT.schemaVersion, generatedAt: "wrong", nodeCount: ARTIFACT.nodes.length },
    });
    mismatch.getState().revealSelectedTraceInCodebase();
    expect(mismatchRelayout).not.toHaveBeenCalled();
    expect(mismatch.getState().moduleSelected).toEqual(new Set());

    const unmapped = requestStore(["ts:missing/file.ts#gone"]);
    const unmappedRelayout = vi.fn(async () => {});
    unmapped.setState({ moduleRelayout: unmappedRelayout, moduleLayoutStatus: "ready" });
    unmapped.getState().revealSelectedTraceInCodebase();
    expect(unmappedRelayout).not.toHaveBeenCalled();

    const minimal = requestStore([ALPHA_RUN]);
    const minimalRelayout = vi.fn(async () => {});
    minimal.setState({
      moduleRelayout: minimalRelayout,
      moduleLayoutStatus: "ready",
      minimalSeedIds: [ALPHA_RUN],
      minimalMemberIds: [ALPHA_RUN],
    });
    minimal.getState().revealSelectedTraceInCodebase();
    expect(minimalRelayout).not.toHaveBeenCalled();
  });
});

function requestStore(nodeIds: string[]) {
  const store = freshStore();
  const trace = requestTrace(nodeIds);
  store.setState({
    requestTraces: [trace],
    selectedTraceId: trace.traceId,
    traceGraphRef: {
      schemaVersion: ARTIFACT.schemaVersion,
      generatedAt: ARTIFACT.generatedAt,
      nodeCount: ARTIFACT.nodes.length,
    },
    traceSource: "mock",
    environment: "demo",
  });
  return store;
}

function requestTrace(nodeIds: string[]): RequestTrace {
  const base = 1_000_000_000n;
  const spans = nodeIds.map((nodeId, index) => {
    const start = base + BigInt(index * 1_000_000);
    return {
      spanId: (index + 1).toString(16).padStart(16, "0"),
      ...(index > 0 ? { parentSpanId: index.toString(16).padStart(16, "0") } : {}),
      nodeId,
      name: nodeId.split("#").at(-1) ?? nodeId,
      kind: index === 0 ? "server" as const : "internal" as const,
      startedAtUnixNano: start.toString(),
      endedAtUnixNano: (start + 500_000n).toString(),
      status: "ok" as const,
      attributes: {},
      events: [],
    };
  });
  return {
    traceId: TRACE_ID,
    name: "POST /orders",
    rootSpanId: spans[0]?.spanId ?? "0000000000000001",
    startedAtUnixNano: base.toString(),
    endedAtUnixNano: (base + BigInt(Math.max(nodeIds.length, 1) * 1_000_000)).toString(),
    status: "ok",
    attributes: {},
    spans,
    completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
  };
}
