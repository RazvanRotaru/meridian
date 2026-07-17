import { describe, expect, it } from "vitest";
import type {
  GraphArtifact,
  GraphEdge,
  GraphNode,
  RequestTrace,
  TimelineEvent,
  TimelineSpan,
} from "@meridian/core";
import type { Node } from "@xyflow/react";
import { buildGraphIndex } from "../graph/graphIndex";
import { frameIdOf } from "./serviceClusterEdges";
import { clusteringFor } from "./serviceClusteringCache";
import { deriveServiceDomains } from "./serviceDomains";
import { deriveRequestGraphOverlay, projectRequestGraphOverlay } from "./requestGraphOverlay";

const A = "ts:src/a.ts#a";
const B = "ts:src/b.ts#b";
const C = "ts:src/c.ts#c";
const D = "ts:src/d.ts#d";
const E = "ts:src/e.ts#e";

function graph(nodes: GraphNode[], edges: GraphEdge[] = []): GraphArtifact {
  return {
    schemaVersion: "1.0.0",
    generatedAt: "2026-07-12T00:00:00.000Z",
    generator: { name: "test", version: "0" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes,
    edges,
  };
}

function node(id: string, kind = "function", parentId?: string, displayName = id): GraphNode {
  return {
    id,
    kind,
    qualifiedName: displayName,
    displayName,
    ...(parentId === undefined ? {} : { parentId }),
    location: { file: id.split("#")[0].slice(3), startLine: 1 },
  };
}

function edge(id: string, source: string, target: string, kind: string): GraphEdge {
  return { id, source, target, kind, resolution: "resolved" };
}

function span(overrides: Partial<TimelineSpan> & Pick<TimelineSpan, "spanId" | "startedAtUnixNano" | "endedAtUnixNano">): TimelineSpan {
  return {
    name: overrides.spanId,
    kind: "internal",
    status: "ok",
    attributes: {},
    events: [],
    ...overrides,
  };
}

function trace(spans: TimelineSpan[], overrides: Partial<RequestTrace> = {}): RequestTrace {
  return {
    traceId: "11111111111111111111111111111111",
    name: "request",
    rootSpanId: spans[0]?.spanId ?? "root",
    startedAtUnixNano: "1000000000",
    endedAtUnixNano: "1100000000",
    status: "ok",
    attributes: {},
    spans,
    completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
    ...overrides,
  };
}

function visible(id: string, semanticDepth?: number): Node {
  return {
    id,
    position: { x: 0, y: 0 },
    data: semanticDepth === undefined ? {} : { semanticDepth },
  };
}

function branch(eventId: string): TimelineEvent {
  return {
    type: "branch.taken",
    eventId,
    timeUnixNano: "1001000000",
    attributes: {},
    siteId: "site:branch",
    pathId: "then",
    condition: "enabled",
    outcome: true,
    source: { file: "src/a.ts", line: 1 },
  };
}

function data(eventId: string): TimelineEvent {
  return {
    type: "data.observe",
    eventId,
    timeUnixNano: "1002000000",
    attributes: {},
    name: "value",
    valueId: "value-1",
    value: true,
  };
}

function exception(eventId: string): TimelineEvent {
  return {
    type: "exception",
    eventId,
    timeUnixNano: "1025000000",
    attributes: {},
    exceptionType: "Failure",
    handled: false,
  };
}

describe("deriveRequestGraphOverlay", () => {
  it("aggregates repeated exact-node occurrences while retaining order, wall time, events, and unmapped spans", () => {
    const index = buildGraphIndex(graph([node(A)]));
    const request = trace([
      span({
        spanId: "repeat",
        parentSpanId: "root",
        nodeId: A,
        startedAtUnixNano: "1020000000",
        endedAtUnixNano: "1040000000",
        status: "error",
        events: [exception("exception")],
      }),
      span({
        spanId: "root",
        nodeId: A,
        startedAtUnixNano: "1000000000",
        endedAtUnixNano: "1100000000",
        events: [branch("branch"), data("data")],
      }),
      span({ spanId: "missing", startedAtUnixNano: "1010000000", endedAtUnixNano: "1012000000" }),
      span({ spanId: "stale", nodeId: B, startedAtUnixNano: "1015000000", endedAtUnixNano: "1016000000" }),
    ], { rootSpanId: "root" });

    const overlay = deriveRequestGraphOverlay(request, index);
    expect(overlay.nodesById.get(A)).toMatchObject({
      occurrenceCount: 2,
      inclusiveSpanMs: 120,
      activeWallMs: 100,
      firstSequence: 1,
      firstStartMs: 0,
      lastEndMs: 100,
      status: "mixed",
      eventCounts: { branchTaken: 1, dataObserve: 1, loopSummary: 0, asyncHandoff: 0, exception: 1 },
    });
    expect(overlay.nodesById.get(A)?.occurrences.map((occurrence) => [occurrence.spanId, occurrence.sequence]))
      .toEqual([["root", 1], ["repeat", 4]]);
    expect(overlay.unmappedSpans).toEqual([
      { spanId: "missing", spanName: "missing", reason: "missing-node-id" },
      { spanId: "stale", spanName: "stale", requestedNodeId: B, reason: "node-not-in-graph" },
    ]);
    expect(overlay.counts).toMatchObject({
      totalSpans: 4,
      exactSpans: 2,
      unmappedSpans: 2,
      totalTransitions: 1,
      runtimeOnlyTransitions: 1,
    });
  });

  it("observes only unique execution edges, preferring calls over instantiates", () => {
    const edges = [
      edge("calls-a-b", A, B, "calls"),
      edge("new-a-b", A, B, "instantiates"),
      edge("new-b-c", B, C, "instantiates"),
      edge("imports-b-d", B, D, "imports"),
      edge("calls-a-e-1", A, E, "calls"),
      edge("calls-a-e-2", A, E, "calls"),
      edge("references-a-e", A, E, "references"),
    ];
    const index = buildGraphIndex(graph([A, B, C, D, E].map((id) => node(id)), edges));
    const request = trace([
      span({ spanId: "root", nodeId: A, startedAtUnixNano: "1000000000", endedAtUnixNano: "1100000000" }),
      span({ spanId: "b", parentSpanId: "root", nodeId: B, startedAtUnixNano: "1010000000", endedAtUnixNano: "1090000000" }),
      span({ spanId: "c", parentSpanId: "b", nodeId: C, startedAtUnixNano: "1020000000", endedAtUnixNano: "1030000000", status: "error" }),
      span({ spanId: "d", parentSpanId: "b", nodeId: D, startedAtUnixNano: "1040000000", endedAtUnixNano: "1050000000" }),
      span({ spanId: "e", parentSpanId: "root", nodeId: E, startedAtUnixNano: "1060000000", endedAtUnixNano: "1070000000" }),
    ]);

    const overlay = deriveRequestGraphOverlay(request, index);
    expect([...overlay.observedEdgeIds]).toEqual(["calls-a-b", "new-b-c"]);
    expect(overlay.edgesById.get("calls-a-b")).toMatchObject({ kind: "calls", occurrenceCount: 1, firstSequence: 2, status: "ok" });
    expect(overlay.edgesById.get("new-b-c")).toMatchObject({ kind: "instantiates", status: "error" });
    expect(overlay.transitions.map((transition) => [transition.targetSpanId, transition.disposition, transition.candidateEdgeIds])).toEqual([
      ["b", "observed", ["calls-a-b"]],
      ["c", "observed", ["new-b-c"]],
      ["d", "runtime-only", []],
      ["e", "ambiguous", ["calls-a-e-1", "calls-a-e-2"]],
    ]);
    expect(overlay.counts).toMatchObject({
      observedTransitions: 2,
      runtimeOnlyTransitions: 1,
      ambiguousTransitions: 1,
      observedStaticEdges: 2,
    });
  });

  it("optionally derives an execution edge from a same-trace link without duplicating parent evidence", () => {
    const index = buildGraphIndex(graph([node(A), node(B)], [edge("calls-a-b", A, B, "calls")]));
    const request = trace([
      span({ spanId: "root", nodeId: A, startedAtUnixNano: "1000000000", endedAtUnixNano: "1100000000" }),
      span({
        spanId: "async",
        nodeId: B,
        startedAtUnixNano: "1020000000",
        endedAtUnixNano: "1040000000",
        links: [{ traceId: "11111111111111111111111111111111", spanId: "root", relation: "async", attributes: {} }],
      }),
    ]);

    expect(deriveRequestGraphOverlay(request, index).transitions).toMatchObject([
      { relation: "async", disposition: "observed", candidateEdgeIds: ["calls-a-b"] },
    ]);
    expect(deriveRequestGraphOverlay(request, index, { includeSameTraceLinks: false }).transitions).toEqual([]);

    request.spans[1].parentSpanId = "root";
    expect(deriveRequestGraphOverlay(request, index).transitions).toHaveLength(1);
    expect(deriveRequestGraphOverlay(request, index).transitions[0].relation).toBe("parent");
  });
});

describe("projectRequestGraphOverlay", () => {
  it("projects ordinary containment on a bounded non-Service view without inferring service facts", () => {
    const packageId = "ts:src";
    const moduleId = "ts:src/work.ts";
    const callable = `${moduleId}#run`;
    const projectedArtifact = graph([
      node(packageId, "package"),
      node(moduleId, "module", packageId),
      node(callable, "function", moduleId),
    ]);
    const index = buildGraphIndex(projectedArtifact, {
      graphSummary: {
        schemaVersion: projectedArtifact.schemaVersion,
        generatedAt: projectedArtifact.generatedAt,
        nodeCount: 10_000,
        edgeCount: 20_000,
      },
      artifactComplete: false,
    });
    const overlay = deriveRequestGraphOverlay(trace([
      span({
        spanId: "run",
        nodeId: callable,
        startedAtUnixNano: "1000000000",
        endedAtUnixNano: "1010000000",
      }),
    ]), index);

    expect(projectRequestGraphOverlay(overlay, [visible(packageId)], index).get(packageId))
      .toMatchObject({ rollupSourceIds: [callable] });
  });

  it("rolls exact evidence to real visible ancestors and unions overlapping wall-clock intervals", () => {
    const packageId = "ts:src";
    const moduleId = "ts:src/work.ts";
    const first = `${moduleId}#first`;
    const second = `${moduleId}#second`;
    const index = buildGraphIndex(graph([
      node(packageId, "package"),
      node(moduleId, "module", packageId),
      node(first, "function", moduleId),
      node(second, "function", moduleId),
    ]));
    const overlay = deriveRequestGraphOverlay(trace([
      span({ spanId: "first", nodeId: first, startedAtUnixNano: "1000000000", endedAtUnixNano: "1010000000", events: [data("first-data")] }),
      span({ spanId: "second", nodeId: second, startedAtUnixNano: "1005000000", endedAtUnixNano: "1015000000", status: "error" }),
    ]), index);

    const projection = projectRequestGraphOverlay(overlay, [visible(packageId)], index);
    expect(projection.get(packageId)).toMatchObject({
      occurrenceCount: 2,
      inclusiveSpanMs: 20,
      activeWallMs: 15,
      firstSequence: 1,
      status: "mixed",
      directSourceIds: [],
      rollupSourceIds: [first, second],
      eventCounts: { dataObserve: 1 },
    });

    const split = projectRequestGraphOverlay(overlay, [visible(packageId), visible(first)], index);
    expect(split.get(first)).toMatchObject({ directSourceIds: [first], rollupSourceIds: [] });
    expect(split.get(packageId)).toMatchObject({ directSourceIds: [], rollupSourceIds: [second] });
  });

  it("projects one representative per mounted semantic-depth population", () => {
    const packageId = "ts:src";
    const moduleId = "ts:src/work.ts";
    const callable = `${moduleId}#run`;
    const index = buildGraphIndex(graph([
      node(packageId, "package"),
      node(moduleId, "module", packageId),
      node(callable, "function", moduleId),
    ]));
    const overlay = deriveRequestGraphOverlay(trace([
      span({ spanId: "run", nodeId: callable, startedAtUnixNano: "1000000000", endedAtUnixNano: "1010000000" }),
    ]), index);

    const projection = projectRequestGraphOverlay(overlay, [
      visible(callable, 0),
      visible(packageId, 1),
    ], index);
    expect([...projection.keys()]).toEqual([callable, packageId]);
    expect(projection.get(callable)).toMatchObject({ directSourceIds: [callable], rollupSourceIds: [] });
    expect(projection.get(packageId)).toMatchObject({ directSourceIds: [], rollupSourceIds: [callable] });
  });

  it("conservatively rolls hidden service members to their visible frame or active grouped domain", () => {
    const packageId = "ts:app";
    const alphaModule = "ts:app/a.ts";
    const betaModule = "ts:app/b.ts";
    const gammaModule = "ts:app/c.ts";
    const alpha = `${alphaModule}#AlphaService`;
    const beta = `${betaModule}#BetaService`;
    const gamma = `${gammaModule}#GammaService`;
    const alphaRun = `${alpha}.run`;
    const betaRun = `${beta}.run`;
    const gammaRun = `${gamma}.run`;
    const index = buildGraphIndex(graph([
      node(packageId, "package", undefined, "app"),
      node(alphaModule, "module", packageId, "a.ts"),
      node(alpha, "class", alphaModule, "AlphaService"),
      node(alphaRun, "method", alpha, "run"),
      node(betaModule, "module", packageId, "b.ts"),
      node(beta, "class", betaModule, "BetaService"),
      node(betaRun, "method", beta, "run"),
      node(gammaModule, "module", packageId, "c.ts"),
      node(gamma, "class", gammaModule, "GammaService"),
      node(gammaRun, "method", gamma, "run"),
    ], [
      edge("alpha-beta", alphaRun, betaRun, "calls"),
      edge("beta-gamma", betaRun, gammaRun, "calls"),
    ]));
    const overlay = deriveRequestGraphOverlay(trace([
      span({ spanId: "alpha-run", nodeId: alphaRun, startedAtUnixNano: "1000000000", endedAtUnixNano: "1010000000" }),
    ]), index);
    const frameId = frameIdOf(alpha);

    expect(projectRequestGraphOverlay(overlay, [visible(frameId)], index).get(frameId)).toMatchObject({
      directSourceIds: [],
      rollupSourceIds: [alphaRun],
    });
    expect(projectRequestGraphOverlay(overlay, [visible(frameIdOf(beta))], index).size).toBe(0);

    const domainId = deriveServiceDomains(clusteringFor(index), "folder", 6).domainByLead.get(alpha)?.id;
    expect(domainId).toBeDefined();
    expect(projectRequestGraphOverlay(overlay, [visible(domainId!)], index, {
      serviceGroupingMode: "folder",
      serviceGroupingTargetSize: 6,
    }).get(domainId!)).toMatchObject({ rollupSourceIds: [alphaRun] });

    const directWins = projectRequestGraphOverlay(overlay, [visible(alphaRun), visible(frameId)], index);
    expect([...directWins.keys()]).toEqual([alphaRun]);
  });
});
