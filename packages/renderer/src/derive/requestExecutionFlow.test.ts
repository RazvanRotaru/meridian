import { describe, expect, it } from "vitest";
import type { LogicFlows, RequestTrace, SyntheticNodeSnapshot, TimelineSpan } from "@meridian/core";
import { ALPHA_RUN, BETA_RUN, freshStore } from "../parity/surfaceFixture";
import type { LogicNodeData } from "./logicGraph";
import { deriveFocusedRequestExecutionFlow, deriveRequestExecutionFlow } from "./requestExecutionFlow";

const TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("deriveRequestExecutionFlow", () => {
  it("reconstructs the whole request from span causality and preserves repeated occurrences", () => {
    const index = freshStore().getState().index;
    const trace = requestTrace();

    const graph = deriveRequestExecutionFlow(trace, index);
    const runtimeNodes = graph.nodes.filter((node) => node.type === "block");

    expect(graph.nodes.map((node) => node.id)).toEqual([
      `request:${TRACE_ID}:entry`,
      `request:${TRACE_ID}:span:1000000000000001`,
      `request:${TRACE_ID}:span:1000000000000002`,
      `request:${TRACE_ID}:event:1000000000000002:branch-1`,
      `request:${TRACE_ID}:span:1000000000000003`,
      `request:${TRACE_ID}:span:1000000000000004`,
      `request:${TRACE_ID}:exit`,
    ]);
    expect(runtimeNodes.filter((node) => {
      const data = node.data as LogicNodeData;
      return data.targetId === ALPHA_RUN && data.runtime?.kind === "span";
    })).toHaveLength(2);
    expect(runtimeNodes.map((node) => node.id)).toContain(`request:${TRACE_ID}:span:1000000000000002`);
    expect(runtimeNodes.map((node) => node.id)).toContain(`request:${TRACE_ID}:span:1000000000000003`);

    const firstOccurrence = runtimeNodes.find((node) => node.id.endsWith("1000000000000002"))!;
    expect((firstOccurrence.data as LogicNodeData).runtime).toMatchObject({
      kind: "span",
      status: "ok",
      detail: "called by route",
      badges: ["request.total = 42"],
    });

    const unmapped = runtimeNodes.find((node) => node.id.endsWith("1000000000000004"))!;
    expect((unmapped.data as LogicNodeData).targetId).toBeNull();
    expect((unmapped.data as LogicNodeData).label).toBe("external charge");

    const rootId = `request:${TRACE_ID}:span:1000000000000001`;
    const firstId = `request:${TRACE_ID}:span:1000000000000002`;
    const branchId = `request:${TRACE_ID}:event:1000000000000002:branch-1`;
    const repeatedId = `request:${TRACE_ID}:span:1000000000000003`;
    const unmappedId = `request:${TRACE_ID}:span:1000000000000004`;
    expect(edgePairs(graph)).toEqual(expect.arrayContaining([
      [`request:${TRACE_ID}:entry`, rootId],
      [rootId, firstId],
      [rootId, repeatedId],
      [rootId, unmappedId],
      [firstId, branchId],
      [branchId, `request:${TRACE_ID}:exit`],
    ]));
    expect(edgePairs(graph)).not.toContainEqual([branchId, repeatedId]);
    expect(edgePairs(graph)).not.toContainEqual([repeatedId, unmappedId]);
    expect(graph.edges.every((edge) => edge.requestTraversal?.basis === "runtime-causal")).toBe(true);
    expect(graph.edges[0]?.requestTraversal).toEqual({
      traceId: TRACE_ID,
      basis: "runtime-causal",
      relation: "trace-entry",
      sourceMomentId: `request:${TRACE_ID}:entry`,
      targetMomentId: `request:${TRACE_ID}:span:1000000000000001`,
    });
  });

  it("fans out overlapping siblings and joins detached work without inventing sibling order", () => {
    const rootId = "1000000000000001";
    const firstSiblingId = "2000000000000001";
    const secondSiblingId = "3000000000000001";
    const detachedId = "4000000000000001";
    const handoffId = "handoff-detached";
    const root = span(rootId, BETA_RUN, "route", undefined, 0, 20, [{
      type: "async.handoff",
      eventId: handoffId,
      timeUnixNano: at(1),
      attributes: {},
      mode: "detached",
      siteId: "route:detached",
      source: { file: "src/route.ts", line: 8 },
      targetSpanId: detachedId,
    }]);
    const firstSibling = span(firstSiblingId, ALPHA_RUN, "first sibling", rootId, 2, 14);
    const secondSibling = span(secondSiblingId, ALPHA_RUN, "second sibling", rootId, 3, 12);
    const detached: TimelineSpan = {
      ...span(detachedId, ALPHA_RUN, "detached worker", undefined, 4, 18),
      kind: "internal",
      links: [{ traceId: TRACE_ID, spanId: rootId, relation: "detached", attributes: {} }],
    };
    const trace: RequestTrace = {
      traceId: TRACE_ID,
      name: "POST /orders",
      rootSpanId: rootId,
      startedAtUnixNano: at(0),
      endedAtUnixNano: at(20),
      status: "ok",
      attributes: {},
      // Deliberately hostile producer order: derivation must remain structurally deterministic.
      spans: [detached, secondSibling, root, firstSibling],
      completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
    };

    const graph = deriveRequestExecutionFlow(trace, freshStore().getState().index);
    const moment = (kind: "span" | "event", spanId: string, eventId?: string) => (
      `request:${TRACE_ID}:${kind}:${spanId}${eventId === undefined ? "" : `:${eventId}`}`
    );
    const rootMoment = moment("span", rootId);
    const firstMoment = moment("span", firstSiblingId);
    const secondMoment = moment("span", secondSiblingId);
    const detachedMoment = moment("span", detachedId);
    const handoffMoment = moment("event", rootId, handoffId);
    const pairs = edgePairs(graph);

    expect(pairs).toEqual(expect.arrayContaining([
      [rootMoment, firstMoment],
      [rootMoment, secondMoment],
      [rootMoment, detachedMoment],
      [rootMoment, handoffMoment],
      [handoffMoment, detachedMoment],
    ]));
    expect(pairs).not.toContainEqual([firstMoment, secondMoment]);
    expect(pairs).not.toContainEqual([secondMoment, firstMoment]);
    expect(pairs).not.toContainEqual([firstMoment, detachedMoment]);
    expect(pairs).not.toContainEqual([secondMoment, detachedMoment]);
    expect(graph.edges.find((edge) => edge.source === rootMoment && edge.target === detachedMoment))
      .toMatchObject({
        kind: "branch",
        label: "detached link",
        requestTraversal: { basis: "runtime-causal", relation: "span-link" },
      });
    expect(graph.edges.find((edge) => edge.source === handoffMoment && edge.target === detachedMoment))
      .toMatchObject({
        kind: "branch",
        label: "detached handoff",
        requestTraversal: { basis: "runtime-causal", relation: "async-handoff" },
      });

    const reordered = deriveRequestExecutionFlow(
      { ...trace, spans: [...trace.spans].reverse() },
      freshStore().getState().index,
    );
    expect(reordered.edges).toEqual(graph.edges);
  });

  it("draws only the observed branch output and keeps its trigger value on the execution edge", () => {
    const graph = deriveRequestExecutionFlow(requestTrace(), freshStore().getState().index);
    const branchNode = graph.nodes.find((node) => node.id.includes(":event:") && (node.data as LogicNodeData).runtime?.kind === "branch")!;
    const branchEdge = graph.edges.find((edge) => edge.source === branchNode.id)!;

    expect((branchNode.data as LogicNodeData).label).toBe("total > limit");
    expect((branchNode.data as LogicNodeData).runtime).toMatchObject({
      detail: expect.stringContaining("request.total = 42"),
      badges: ["site order:limit"],
    });
    expect(branchEdge).toMatchObject({ kind: "branch", label: "then · request.total = 42" });
    expect(graph.edges.filter((edge) => edge.source === branchNode.id)).toHaveLength(1);
  });

  it("expands a mapped callable with no static body in place without inventing graph children", () => {
    const trace = requestTrace();
    const index = freshStore().getState().index;
    const mappedId = `request:${TRACE_ID}:span:1000000000000002`;
    const unmappedId = `request:${TRACE_ID}:span:1000000000000004`;
    const collapsed = deriveRequestExecutionFlow(trace, index, {}, new Set());

    const mappedCollapsed = collapsed.nodes.find((node) => node.id === mappedId)!;
    expect(mappedCollapsed).toMatchObject({ id: mappedId, type: "block", parentId: null });
    expect(mappedCollapsed.data).toMatchObject({
      targetId: ALPHA_RUN,
      resolution: "resolved",
      expandable: true,
      isExpanded: false,
      isContainer: false,
      childCount: 0,
      emptyFlow: true,
    });
    expect(collapsed.nodes.find((node) => node.id === unmappedId)?.data).toMatchObject({
      targetId: null,
      resolution: "unresolved",
      expandable: false,
      isExpanded: false,
      isContainer: false,
      childCount: 0,
    });

    // Even an accidental override cannot make an unresolved runtime span masquerade as a local
    // callable. The resolved occurrence, however, opens the same block node and renders its shared
    // empty state; there is no synthetic child or edge solely to justify the disclosure control.
    const expanded = deriveRequestExecutionFlow(trace, index, {}, new Set([mappedId, unmappedId]));
    const mappedExpanded = expanded.nodes.find((node) => node.id === mappedId)!;
    expect(mappedExpanded).toMatchObject({ id: mappedId, type: "block", parentId: null });
    expect(mappedExpanded.data).toMatchObject({
      targetId: ALPHA_RUN,
      expandable: true,
      isExpanded: true,
      isContainer: true,
      childCount: 0,
      emptyFlow: true,
    });
    expect(expanded.nodes.find((node) => node.id === unmappedId)?.data).toMatchObject({
      expandable: false,
      isExpanded: false,
      isContainer: false,
      childCount: 0,
    });
    expect(expanded.nodes.map((node) => node.id)).toEqual(collapsed.nodes.map((node) => node.id));
    expect(expanded.edges).toEqual(collapsed.edges);
    expect(expanded.nodes.some((node) => node.parentId === mappedId)).toBe(false);
    expect(expanded.nodes.some((node) => node.id.startsWith(`${mappedId}:exec::`))).toBe(false);
    expect(expanded.edges.some((edge) => edge.id.includes(":exec:"))).toBe(false);
  });

  it("starts every flow-backed occurrence collapsed and expands repeated calls independently", () => {
    const base = requestTrace();
    const trace: RequestTrace = {
      ...base,
      spans: base.spans.map((item) => item.nodeId === ALPHA_RUN
        ? { ...item, events: controlledEvents(item.spanId, item.startedAtUnixNano) }
        : item),
    };

    const spanIds = ["1000000000000002", "1000000000000003"];
    const occurrenceIds = spanIds.map((spanId) => `request:${TRACE_ID}:span:${spanId}`);
    const collapsed = deriveRequestExecutionFlow(trace, freshStore().getState().index, CONTROL_FLOWS);
    for (const occurrenceId of occurrenceIds) {
      expect(collapsed.nodes.find((node) => node.id === occurrenceId)?.data).toMatchObject({
        expandable: true,
        isExpanded: false,
        isContainer: false,
      });
      expect(collapsed.nodes.some((node) => node.id.startsWith(`${occurrenceId}:exec::`))).toBe(false);
    }
    // Parent spans and spans without control evidence are equally expandable when a real body exists.
    expect(collapsed.nodes.find((node) => node.id === `request:${TRACE_ID}:span:1000000000000001`)?.data)
      .toMatchObject({ expandable: true, isExpanded: false });

    const firstOnly = deriveRequestExecutionFlow(
      trace,
      freshStore().getState().index,
      CONTROL_FLOWS,
      new Set([occurrenceIds[0]!]),
    );
    expect(firstOnly.nodes.some((node) => node.id.startsWith(`${occurrenceIds[0]}:exec::`))).toBe(true);
    expect(firstOnly.nodes.some((node) => node.id.startsWith(`${occurrenceIds[1]}:exec::`))).toBe(false);
    expect(firstOnly.edges.filter((edge) => edge.id.includes(":exec:")).every((edge) => edge.requestTraversal === undefined)).toBe(true);
    expect(firstOnly.edges.filter((edge) => edge.requestTraversal !== undefined).map((edge) => edge.id))
      .toEqual(collapsed.edges.map((edge) => edge.id));

    const graph = deriveRequestExecutionFlow(
      trace,
      freshStore().getState().index,
      CONTROL_FLOWS,
      new Set(occurrenceIds),
    );
    for (const spanId of spanIds) {
      const occurrenceId = `request:${TRACE_ID}:span:${spanId}`;
      const occurrence = graph.nodes.find((node) => node.id === occurrenceId)!;
      expect(occurrence.data).toMatchObject({ isContainer: true, isExpanded: true });

      const branchA = graph.nodes.find((node) => node.id === `${occurrenceId}:exec::p0/0`)!;
      const branchB = graph.nodes.find((node) => node.id === `${occurrenceId}:exec::p0/1`)!;
      const loop = graph.nodes.find((node) => node.id === `${occurrenceId}:exec::p0/2`)!;
      const loopCall = graph.nodes.find((node) => node.id === `${occurrenceId}:exec::p0/2/p0/0`)!;
      expect(branchA).toMatchObject({ type: "branch", parentId: occurrenceId });
      expect(branchB).toMatchObject({ type: "branch", parentId: occurrenceId });
      expect(loop).toMatchObject({ type: "control", parentId: occurrenceId });
      expect(loopCall).toMatchObject({ type: "block", parentId: loop.id });
      expect((loopCall.data as LogicNodeData).label).toBe("assertLineIsSane");

      for (const eventId of ["branch-limit", "branch-blocked", "loop-items"]) {
        expect(graph.nodes.some((node) => node.id === `request:${TRACE_ID}:event:${spanId}:${eventId}`)).toBe(false);
      }
    }

    const graftEdgeIds = graph.edges.filter((edge) => edge.id.includes(":exec:e")).map((edge) => edge.id);
    expect(graftEdgeIds.length).toBeGreaterThan(0);
    expect(new Set(graftEdgeIds).size).toBe(graftEdgeIds.length);
    expect(graftEdgeIds.some((id) => id.includes(":span:1000000000000002:exec:"))).toBe(true);
    expect(graftEdgeIds.some((id) => id.includes(":span:1000000000000003:exec:"))).toBe(true);
  });

  it("attaches explicit IN/OUT snapshots to their exact span occurrence without target inference", () => {
    const snapshots: SyntheticNodeSnapshot[] = [{
      spanId: "1000000000000002",
      nodeId: ALPHA_RUN,
      occurrenceKey: "alpha:1",
      input: { total: 42 },
      output: { accepted: true },
    }, {
      // The span exists, but the node id disagrees. Pure derivation must ignore the stale snapshot.
      spanId: "1000000000000003",
      nodeId: BETA_RUN,
      occurrenceKey: "beta:1",
      input: { total: 99 },
      error: "wrong occurrence",
    }];
    const graph = deriveRequestExecutionFlow(
      requestTrace(),
      freshStore().getState().index,
      {},
      new Set<string>(),
      snapshots,
    );
    const first = graph.nodes.find((node) => node.id.endsWith(":span:1000000000000002"))!;
    const repeated = graph.nodes.find((node) => node.id.endsWith(":span:1000000000000003"))!;

    expect((first.data as LogicNodeData).runtime?.snapshot).toEqual({
      input: { total: 42 },
      output: { accepted: true },
    });
    expect(first.height).toBeGreaterThan(100);
    expect((repeated.data as LogicNodeData).runtime?.snapshot).toBeUndefined();
  });

  it("focuses one occurrence with its expanded static body and moves values out of the canvas", () => {
    const selectedId = `request:${TRACE_ID}:span:1000000000000002`;
    const graph = deriveFocusedRequestExecutionFlow(
      requestTrace(),
      freshStore().getState().index,
      CONTROL_FLOWS,
      selectedId,
      new Set<string>(),
      [{
        spanId: "1000000000000002",
        nodeId: ALPHA_RUN,
        occurrenceKey: "alpha:1",
        input: { total: 42 },
        output: { accepted: true },
      }],
    );

    expect(graph.nodes.length).toBeGreaterThan(1);
    expect(graph.nodes.some((node) => node.id.includes(":span:1000000000000003"))).toBe(false);
    expect(graph.nodes.every((node) => node.id === selectedId || node.parentId !== null)).toBe(true);
    const selected = graph.nodes.find((node) => node.id === selectedId)!;
    expect(selected.data as LogicNodeData).toMatchObject({
      isExpanded: true,
      isContainer: true,
      expandable: false,
      runtime: { focused: true },
    });
    expect((selected.data as LogicNodeData).runtime?.snapshot).toBeUndefined();
    const ids = new Set(graph.nodes.map((node) => node.id));
    expect(graph.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
  });
});

const CONTROL_FLOWS: LogicFlows = {
  [BETA_RUN]: [
    { kind: "call", label: "run", target: ALPHA_RUN, resolution: "resolved" },
  ],
  [ALPHA_RUN]: [
    {
      kind: "branch",
      branchKind: "if",
      label: "if total > limit",
      paths: [{ label: "then", role: "then", body: [] }],
    },
    {
      kind: "branch",
      branchKind: "if",
      label: "if blocked",
      paths: [{ label: "then", role: "then", body: [] }],
    },
    {
      kind: "loop",
      label: "for each item",
      body: [{ kind: "call", label: "assertLineIsSane", target: BETA_RUN, resolution: "resolved" }],
    },
  ],
};

function requestTrace(): RequestTrace {
  const root = span("1000000000000001", BETA_RUN, "route", undefined, 0, 10);
  const first = span("1000000000000002", ALPHA_RUN, "run", root.spanId, 2, 4, [{
    type: "data.observe",
    eventId: "value-1",
    timeUnixNano: at(2.2),
    attributes: {},
    name: "request.total",
    valueId: "total-1",
    value: 42,
  }, {
    type: "branch.taken",
    eventId: "branch-1",
    timeUnixNano: at(3),
    attributes: {},
    siteId: "order:limit",
    pathId: "then",
    condition: "total > limit",
    outcome: true,
    valueName: "request.total",
    value: 42,
    source: { file: "src/order.ts", line: 12 },
  }]);
  const repeated = span("1000000000000003", ALPHA_RUN, "run", root.spanId, 5, 6);
  const unmapped = span("1000000000000004", "ts:missing.ts#charge", "external charge", root.spanId, 7, 8);
  return {
    traceId: TRACE_ID,
    name: "POST /orders",
    rootSpanId: root.spanId,
    startedAtUnixNano: at(0),
    endedAtUnixNano: at(10),
    status: "ok",
    attributes: {},
    // Deliberately reversed/mixed: timestamps, never producer array order, own reconstruction.
    spans: [repeated, unmapped, root, first],
    completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
  };
}

function span(
  spanId: string,
  nodeId: string,
  name: string,
  parentSpanId: string | undefined,
  startMs: number,
  endMs: number,
  events: TimelineSpan["events"] = [],
): TimelineSpan {
  return {
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    nodeId,
    name,
    kind: parentSpanId ? "internal" : "server",
    startedAtUnixNano: at(startMs),
    endedAtUnixNano: at(endMs),
    status: "ok",
    attributes: {},
    events,
  };
}

function controlledEvents(spanId: string, startedAtUnixNano: string): TimelineSpan["events"] {
  const start = BigInt(startedAtUnixNano);
  const time = (quarterMs: number) => (start + BigInt(quarterMs) * 250_000n).toString();
  return [{
    type: "branch.taken",
    eventId: "branch-limit",
    timeUnixNano: time(1),
    attributes: {},
    siteId: `${spanId}:limit`,
    pathId: "else",
    condition: "total > limit",
    outcome: false,
    valueName: "request.total",
    value: 42,
    source: { file: "src/order.ts", line: 12 },
  }, {
    type: "branch.taken",
    eventId: "branch-blocked",
    timeUnixNano: time(2),
    attributes: {},
    siteId: `${spanId}:blocked`,
    pathId: "else",
    condition: "blocked",
    outcome: false,
    source: { file: "src/order.ts", line: 16 },
  }, {
    type: "loop.summary",
    eventId: "loop-items",
    timeUnixNano: time(3),
    attributes: {},
    siteId: `${spanId}:items`,
    label: "for request.items",
    iterations: 2,
    emittedIterations: 2,
    truncated: false,
    source: { file: "src/order.ts", line: 20 },
  }];
}

function at(ms: number): string {
  return (1_000_000_000n + BigInt(Math.round(ms * 1_000_000))).toString();
}

function edgePairs(graph: ReturnType<typeof deriveRequestExecutionFlow>): Array<[string, string]> {
  return graph.edges.map((edge) => [edge.source, edge.target]);
}
