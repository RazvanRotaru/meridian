import { describe, expect, it, vi } from "vitest";
import type { RequestTrace } from "@meridian/core";
import type { Node } from "@xyflow/react";
import {
  ALPHA_RUN,
  APP_PKG,
  ARTIFACT,
  BETA_RUN,
  ORDER,
  ORDER_LOAD,
  STORE_FILE,
  freshStore,
} from "../parity/surfaceFixture";

const TRACE_ID = "11111111111111111111111111111111";

describe("request-aware split flow pane", () => {
  it("opens the shared pane for the selected request without using a clicked callable as its subject", () => {
    const store = requestStore();
    const relayout = vi.fn(async () => {});
    store.setState({ flowPaneRelayout: relayout, moduleSelected: new Set([ALPHA_RUN]) });

    store.getState().openSelectedRequestFlowPane();

    expect(store.getState()).toMatchObject({
      flowSelection: null,
      flowPaneOrigin: "request",
      requestFlowTraceId: TRACE_ID,
      flowPaneLayoutStatus: "laying-out",
    });
    expect(store.getState().requestFlowExpansionOverrides).toEqual(new Set());
    expect(store.getState().moduleSelected).toEqual(new Set([ALPHA_RUN]));
    expect(relayout).toHaveBeenCalledOnce();
  });

  it("does not require a static callable flow, but rejects mismatched graph references", () => {
    const store = requestStore();
    const relayout = vi.fn(async () => {});
    store.setState({ flowPaneRelayout: relayout });

    // ORDER_LOAD has no static Logic flow in the parity fixture; the request reconstruction remains
    // meaningful because it is built from occurrences/events rather than `LogicFlows[clickedId]`.
    store.getState().openSelectedRequestFlowPane();
    expect(store.getState().requestFlowTraceId).toBe(TRACE_ID);
    expect(relayout).toHaveBeenCalledOnce();

    store.getState().selectFlowEntry(null);
    store.setState({ traceGraphRef: { schemaVersion: "1.0.0", generatedAt: "wrong", nodeCount: ARTIFACT.nodes.length } });
    store.getState().openSelectedRequestFlowPane();
    expect(store.getState().requestFlowTraceId).toBeNull();
  });

  it("opens flow-backed occurrences collapsed and folds their control evidence into the card", async () => {
    const store = requestStore();

    store.getState().openSelectedRequestFlowPane();

    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    const ids = store.getState().flowPaneRfNodes.map((node) => node.id);
    expect(ids).toContain(`request:${TRACE_ID}:span:1000000000000001`);
    expect(ids).toContain(`request:${TRACE_ID}:span:1000000000000002`);
    expect(ids).not.toContain(`request:${TRACE_ID}:event:1000000000000001:branch-1`);
    expect(ids.some((id) => id.includes(":exec::"))).toBe(false);
    expect(store.getState().flowPaneRfNodes.find((node) => node.id === `request:${TRACE_ID}:span:1000000000000001`)?.data)
      .toMatchObject({ expandable: true, isExpanded: false, isContainer: false, childCount: 2 });
    expect(ids.some((id) => id.startsWith(`${ALPHA_RUN}::`))).toBe(false);
    expect(store.getState().flowPaneRfEdges.length).toBeGreaterThan(0);
    expect(store.getState().flowPaneRfEdges.every((edge) => (
      edge.className?.includes("request-flow-edge--observed")
      && (edge.domAttributes as Record<string, unknown> | undefined)?.["data-request-flow-evidence"] === "observed"
    ))).toBe(true);
  });

  it("expands and collapses one request occurrence through request-owned state", async () => {
    const store = requestStore();
    const occurrenceId = `request:${TRACE_ID}:span:1000000000000001`;
    store.getState().openSelectedRequestFlowPane();
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));

    store.getState().toggleRequestFlowExpand(occurrenceId);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    expect(store.getState().requestFlowExpansionOverrides).toEqual(new Set([occurrenceId]));
    expect(store.getState().flowPaneRfNodes.find((node) => node.id === occurrenceId)?.data)
      .toMatchObject({ isExpanded: true, isContainer: true, childCount: 2 });
    expect(store.getState().flowPaneRfNodes.map((node) => node.id))
      .toContain(`${occurrenceId}:exec::p0/0`);
    expect(store.getState().flowPaneRfEdges.some((edge) => (
      edge.id.includes(":exec:")
      && edge.className?.includes("request-flow-edge--observed")
      && (edge.domAttributes as Record<string, unknown> | undefined)?.["data-request-flow-basis"] === "span-body"
    ))).toBe(true);

    store.getState().toggleRequestFlowExpand(occurrenceId);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    expect(store.getState().requestFlowExpansionOverrides).toEqual(new Set());
    expect(store.getState().flowPaneRfNodes.some((node) => node.id.startsWith(`${occurrenceId}:exec::`))).toBe(false);
  });

  it("does not replace an existing explorer or PR-compatible flow pane", () => {
    const store = requestStore();
    store.setState({ flowPaneRelayout: vi.fn(async () => {}) });
    const explorer = { rootId: ALPHA_RUN, blockPath: [] };
    store.getState().selectFlowEntry(explorer);

    store.getState().openSelectedRequestFlowPane();

    expect(store.getState().flowPaneOrigin).toBe("explorer");
    expect(store.getState().flowSelection).toBe(explorer);
  });

  it("keeps the request flow stable while map selection changes", () => {
    const store = requestStore();
    store.setState({ flowPaneRelayout: vi.fn(async () => {}) });
    store.getState().openSelectedRequestFlowPane();

    store.getState().selectModule(BETA_RUN);
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().flowPaneOrigin).toBe("request");
    expect(store.getState().requestFlowTraceId).toBe(TRACE_ID);
    expect(store.getState().moduleSelected).toEqual(new Set([BETA_RUN]));
  });

  it("highlights and recenters an already-drawn graph node when its request occurrence is clicked", () => {
    const store = requestStore();
    store.setState({
      flowPaneRelayout: vi.fn(async () => {}),
      moduleRfNodes: [drawnNode(ALPHA_RUN)],
      moduleSelected: new Set([BETA_RUN]),
      hiddenCategories: new Set(["util"]),
      showPrivate: false,
    });
    store.getState().openSelectedRequestFlowPane();

    store.getState().selectFlowPaneTarget(ALPHA_RUN);

    expect(store.getState().moduleSelected).toEqual(new Set([ALPHA_RUN]));
    expect(store.getState().hiddenCategories).toEqual(new Set());
    expect(store.getState().showPrivate).toBe(true);
    expect(store.getState().recenterSeq).toBe(1);
    expect(store.getState().flowPaneOrigin).toBe("request");
    expect(store.getState().requestFlowTraceId).toBe(TRACE_ID);
  });

  it("reveals a mapped nested static node even when it has no dedicated telemetry span", () => {
    const store = requestStore();
    store.setState({
      flowPaneRelayout: vi.fn(async () => {}),
      moduleRfNodes: [drawnNode(BETA_RUN)],
      moduleSelected: new Set([ALPHA_RUN]),
    });
    store.getState().openSelectedRequestFlowPane();
    // Expanded static bodies reuse artifact targets on their Logic nodes; they do not manufacture
    // spans for cheap nested calls merely to make the graph-link gesture work.
    store.setState({
      flowPaneRfNodes: [{
        id: `request:${TRACE_ID}:span:1000000000000001:exec::p0/0`,
        type: "block",
        position: { x: 0, y: 0 },
        data: {
          logicKind: "call",
          label: "nested static call",
          targetId: BETA_RUN,
          resolution: "resolved",
          expandable: false,
          isExpanded: false,
          isContainer: false,
          compact: false,
          callScope: "internal",
          greyed: false,
          provenance: null,
          childCount: 0,
        },
      }],
    });

    store.getState().selectFlowPaneTarget(BETA_RUN);

    expect(store.getState().moduleSelected).toEqual(new Set([BETA_RUN]));
    expect(store.getState().recenterSeq).toBe(1);
    expect(store.getState().flowPaneOrigin).toBe("request");
    expect(store.getState().requestFlowTraceId).toBe(TRACE_ID);
  });

  it("expands a collapsed owning path before highlighting the request node", async () => {
    const store = requestStore();
    store.setState({
      flowPaneRelayout: vi.fn(async () => {}),
      moduleFocus: APP_PKG,
      moduleRfNodes: [],
      moduleExpanded: new Set(),
    });
    store.getState().openSelectedRequestFlowPane();

    store.getState().selectFlowPaneTarget(ORDER_LOAD);

    expect(store.getState().moduleSelected).toEqual(new Set([ORDER_LOAD]));
    // The canonical reveal chooses the cheapest truthful tree: the owning file becomes the focus,
    // and only its class gate must open to draw the exact method.
    expect(store.getState().moduleFocus).toBe(STORE_FILE);
    expect(store.getState().moduleExpanded).toEqual(new Set([ORDER]));
    await vi.waitFor(() => expect(store.getState().moduleLayoutStatus).toBe("ready"));
    expect(store.getState().moduleRfNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ORDER_LOAD, type: expect.not.stringMatching(/^ghost$/) }),
    ]));
    await vi.waitFor(() => expect(store.getState().recenterSeq).toBe(1));
    expect(store.getState().requestFlowTraceId).toBe(TRACE_ID);
  });

  it("pivots a hidden Service-lens target to its exact canonical Map node without closing the split", async () => {
    const store = requestStore();
    const moduleRelayout = vi.fn(async () => {});
    store.setState({
      flowPaneRelayout: vi.fn(async () => {}),
      moduleRelayout,
      viewMode: "call",
      moduleRfNodes: [],
      moduleExpanded: new Set(),
      moduleLayoutStatus: "ready",
    });
    store.getState().openSelectedRequestFlowPane();

    store.getState().selectFlowPaneTarget(ORDER_LOAD);

    expect(store.getState().viewMode).toBe("modules");
    expect(store.getState().moduleFocus).toBe(STORE_FILE);
    expect(store.getState().moduleExpanded).toEqual(new Set([ORDER]));
    expect(store.getState().moduleSelected).toEqual(new Set([ORDER_LOAD]));
    expect(store.getState().flowPaneOrigin).toBe("request");
    expect(store.getState().requestFlowTraceId).toBe(TRACE_ID);
    expect(moduleRelayout).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(store.getState().recenterSeq).toBe(1));
  });

  it("promotes an exact-id ghost to the real canonical definition before highlighting it", async () => {
    const store = requestStore();
    const moduleRelayout = vi.fn(async () => {});
    store.setState({
      flowPaneRelayout: vi.fn(async () => {}),
      moduleRelayout,
      moduleRfNodes: [drawnNode(ORDER_LOAD, "ghost")],
      moduleLayoutStatus: "ready",
    });
    store.getState().openSelectedRequestFlowPane();

    store.getState().selectFlowPaneTarget(ORDER_LOAD);

    expect(store.getState().moduleRfNodes).toEqual([]);
    expect(store.getState().moduleFocus).toBe(STORE_FILE);
    expect(store.getState().moduleExpanded).toEqual(new Set([ORDER]));
    expect(store.getState().moduleSelected).toEqual(new Set([ORDER_LOAD]));
    expect(moduleRelayout).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(store.getState().recenterSeq).toBe(1));
  });

  it("ignores runtime targets when telemetry provenance mismatches the open graph", () => {
    const store = requestStore();
    store.setState({ flowPaneRelayout: vi.fn(async () => {}) });
    store.getState().openSelectedRequestFlowPane();
    store.setState({
      moduleSelected: new Set([BETA_RUN]),
      traceGraphRef: { schemaVersion: "1.0.0", generatedAt: "wrong", nodeCount: ARTIFACT.nodes.length },
    });

    store.getState().selectFlowPaneTarget(ALPHA_RUN);

    expect(store.getState().moduleSelected).toEqual(new Set([BETA_RUN]));
  });

  it("does not replace an open Minimal Graph from a request-flow click", () => {
    const store = requestStore();
    const moduleRelayout = vi.fn(async () => {});
    store.setState({ flowPaneRelayout: vi.fn(async () => {}), moduleRelayout });
    store.getState().openSelectedRequestFlowPane();
    store.setState({ minimalSeedIds: [BETA_RUN], moduleSelected: new Set([BETA_RUN]) });

    store.getState().selectFlowPaneTarget(ALPHA_RUN);

    expect(store.getState().minimalSeedIds).toEqual([BETA_RUN]);
    expect(store.getState().moduleSelected).toEqual(new Set([BETA_RUN]));
    expect(moduleRelayout).not.toHaveBeenCalled();
  });

  it("reconstructs the newly selected request in place and closes only when the request is hidden", () => {
    const store = requestStore();
    const second = { ...requestTrace(), traceId: "22222222222222222222222222222222", name: "POST /orders — second" };
    const relayout = vi.fn(async () => {});
    store.setState({ requestTraces: [requestTrace(), second], flowPaneRelayout: relayout });
    store.getState().openSelectedRequestFlowPane();
    store.setState({ requestFlowExpansionOverrides: new Set([`request:${TRACE_ID}:span:1000000000000001`]) });
    relayout.mockClear();

    store.getState().setSelectedTrace(second.traceId);
    expect(store.getState().flowPaneOrigin).toBe("request");
    expect(store.getState().requestFlowTraceId).toBe(second.traceId);
    expect(store.getState().requestFlowExpansionOverrides).toEqual(new Set());
    expect(store.getState().flowPaneLayoutStatus).toBe("laying-out");
    expect(relayout).toHaveBeenCalledOnce();

    store.getState().setSelectedTrace(null);
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().flowPaneOrigin).toBeNull();
    expect(store.getState().requestFlowTraceId).toBeNull();
  });
});

function drawnNode(id: string, type = "block"): Node {
  return { id, type, position: { x: 0, y: 0 }, data: {} };
}

function requestStore() {
  const store = freshStore();
  const trace = requestTrace();
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

function requestTrace(): RequestTrace {
  return {
    traceId: TRACE_ID,
    name: "POST /orders",
    rootSpanId: "1000000000000001",
    startedAtUnixNano: "1000000000",
    endedAtUnixNano: "1002000000",
    status: "ok",
    attributes: {},
    spans: [
      {
        spanId: "1000000000000001",
        nodeId: ALPHA_RUN,
        name: "run",
        kind: "server",
        startedAtUnixNano: "1000000000",
        endedAtUnixNano: "1002000000",
        status: "ok",
        attributes: {},
        events: [{
          eventId: "branch-1",
          type: "branch.taken",
          timeUnixNano: "1001000000",
          attributes: {},
          condition: "ready",
          outcome: true,
          pathId: "then",
          siteId: "site-1",
          source: { file: "app/core/a.ts", line: 1 },
        }],
      },
      {
        spanId: "1000000000000002",
        parentSpanId: "1000000000000001",
        nodeId: ORDER_LOAD,
        name: "load",
        kind: "internal",
        startedAtUnixNano: "1001000000",
        endedAtUnixNano: "1001500000",
        status: "ok",
        attributes: {},
        events: [],
      },
    ],
    completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
  };
}
