import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphArtifact, SyntheticExecution, SyntheticScenarioDescriptor } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type { LogicNodeData } from "../derive/logicGraph";
import { createBlueprintStore } from "./store";

const ROOT = "ts:src/order.ts#placeOrder";
const CHILD = "ts:src/order.ts#price";
const PACKAGE = "ts:src";
const FILE = "ts:src/order.ts";
const TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SPAN_ID = "1000000000000001";

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-12T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    { id: PACKAGE, kind: "package", qualifiedName: "src", displayName: "src", location: { file: "src", startLine: 1 } },
    { id: FILE, kind: "module", qualifiedName: "src/order.ts", displayName: "order.ts", parentId: PACKAGE, location: { file: "src/order.ts", startLine: 1 } },
    { id: ROOT, kind: "function", qualifiedName: "placeOrder", displayName: "placeOrder", parentId: FILE, location: { file: "src/order.ts", startLine: 1 } },
    { id: CHILD, kind: "function", qualifiedName: "price", displayName: "price", parentId: FILE, location: { file: "src/order.ts", startLine: 8 } },
  ],
  edges: [{ id: "call", source: ROOT, target: CHILD, kind: "calls", resolution: "resolved" }],
  extensions: {
    logicFlow: {
      [ROOT]: [{ kind: "call", label: "price", target: CHILD, resolution: "resolved" }],
    },
  },
};

const SCENARIO: SyntheticScenarioDescriptor = {
  id: "place-order-happy",
  label: "Place order — happy path",
  rootId: ROOT,
  defaultInput: { customerId: "cust_1" },
};

const ALTERNATE_SCENARIO: SyntheticScenarioDescriptor = {
  id: "place-order-validation-error",
  label: "Place order — validation error",
  rootId: ROOT,
  defaultInput: { customerId: "" },
};

function execution(): SyntheticExecution {
  return {
    executionVersion: "1.0.0",
    outcome: "completed",
    scenarioId: SCENARIO.id,
    rootId: ROOT,
    generatedAt: "2026-07-12T00:00:01.000Z",
    input: SCENARIO.defaultInput,
    output: { id: "ord_1" },
    warnings: [],
    trace: {
      traceId: TRACE_ID,
      name: "Synthetic placeOrder",
      rootSpanId: SPAN_ID,
      startedAtUnixNano: "1000000000",
      endedAtUnixNano: "1002000000",
      status: "ok",
      attributes: {},
      spans: [{
        spanId: SPAN_ID,
        nodeId: ROOT,
        name: "placeOrder",
        kind: "internal",
        startedAtUnixNano: "1000000000",
        endedAtUnixNano: "1002000000",
        status: "ok",
        attributes: {},
        events: [],
      }],
      completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
    },
    snapshots: [{
      spanId: SPAN_ID,
      nodeId: ROOT,
      occurrenceKey: "placeOrder:1",
      input: { customerId: "cust_1" },
      output: { id: "ord_1" },
    }],
    inputOverrideResults: [],
    watchHits: [],
  };
}

function executionFor(
  scenario: SyntheticScenarioDescriptor,
  input: SyntheticExecution["input"],
  traceId: string,
  generatedAt: string,
): SyntheticExecution {
  const result = execution();
  return {
    ...result,
    scenarioId: scenario.id,
    generatedAt,
    input,
    trace: { ...result.trace, traceId },
    snapshots: result.snapshots.map((snapshot) => ({ ...snapshot, input })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("synthetic flow execution state", () => {
  it("requires ephemeral sandbox consent and sends it only on the confirmed PR run", async () => {
    const result = execution();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);
    const store = makeStore();
    store.setState({
      flowSelection: { rootId: ROOT, blockPath: [] },
      flowPaneOrigin: "explorer",
      syntheticExecutionTrust: {
        mode: "sandboxed-pr",
        provenance: { repository: "acme/shopfront", headSha: "abcdef1234567890" },
      },
    });

    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: SCENARIO.defaultInput,
      host: "flow-pane",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      syntheticExecutionStatus: "error",
      syntheticExecutionError: "Confirm the untrusted PR sandbox before running code.",
    });

    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: SCENARIO.defaultInput,
      host: "flow-pane",
      sandboxConsent: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        "content-type": "application/json",
        "x-meridian-sandbox-consent": "true",
      },
    });
  });

  it("retains the immediately previous successful run for the same root and scenario", async () => {
    const first = executionFor(
      SCENARIO,
      { customerId: "cust_1" },
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2026-07-12T00:00:01.000Z",
    );
    const second = executionFor(
      SCENARIO,
      { customerId: "cust_2" },
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "2026-07-12T00:00:02.000Z",
    );
    const results = [first, second];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(results.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const store = makeStore();
    store.setState({ flowSelection: { rootId: ROOT, blockPath: [] }, flowPaneOrigin: "explorer" });

    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: first.input,
      host: "flow-pane",
    });
    expect(store.getState().syntheticPreviousExecution).toBeNull();

    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: second.input,
      host: "flow-pane",
    });
    expect(store.getState().syntheticExecution).toEqual(second);
    expect(store.getState().syntheticPreviousExecution).toEqual(first);

    store.getState().clearSyntheticExecution();
    expect(store.getState()).toMatchObject({
      syntheticExecution: null,
      syntheticPreviousExecution: null,
    });
  });

  it("does not treat a successful run from another scenario as a comparison baseline", async () => {
    const first = executionFor(
      SCENARIO,
      SCENARIO.defaultInput,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2026-07-12T00:00:01.000Z",
    );
    const alternate = executionFor(
      ALTERNATE_SCENARIO,
      ALTERNATE_SCENARIO.defaultInput,
      "cccccccccccccccccccccccccccccccc",
      "2026-07-12T00:00:03.000Z",
    );
    const results = [first, alternate];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(results.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const store = makeStore([SCENARIO, ALTERNATE_SCENARIO]);
    store.setState({ flowSelection: { rootId: ROOT, blockPath: [] }, flowPaneOrigin: "explorer" });

    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: first.input,
      host: "flow-pane",
    });
    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: ALTERNATE_SCENARIO.id,
      input: alternate.input,
      host: "flow-pane",
    });

    expect(store.getState().syntheticExecution).toEqual(alternate);
    expect(store.getState().syntheticPreviousExecution).toBeNull();
  });

  it("preserves the successful comparison pair across failed and stale reruns", async () => {
    const first = executionFor(
      SCENARIO,
      { customerId: "cust_1" },
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2026-07-12T00:00:01.000Z",
    );
    const second = executionFor(
      SCENARIO,
      { customerId: "cust_2" },
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "2026-07-12T00:00:02.000Z",
    );
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(jsonResponse(second));
    vi.stubGlobal("fetch", fetchMock);
    const store = makeStore();
    store.setState({ flowSelection: { rootId: ROOT, blockPath: [] }, flowPaneOrigin: "explorer" });
    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: first.input,
      host: "flow-pane",
    });
    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: second.input,
      host: "flow-pane",
    });
    const current = store.getState().syntheticExecution;
    const previous = store.getState().syntheticPreviousExecution;
    store.setState({ syntheticSelectedMomentId: "selected-child-occurrence" });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "runner timed out" }), {
      status: 504,
      headers: { "content-type": "application/json" },
    }));
    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: { customerId: "failed" },
      host: "flow-pane",
    });
    expect(store.getState().syntheticExecution).toBe(current);
    expect(store.getState().syntheticPreviousExecution).toBe(previous);
    expect(store.getState().syntheticSelectedMomentId).toBe("selected-child-occurrence");

    let resolveStale!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveStale = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "newer run failed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }));
    const stale = store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: { customerId: "stale" },
      host: "flow-pane",
    });
    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: { customerId: "newer-failed" },
      host: "flow-pane",
    });
    resolveStale(jsonResponse(executionFor(
      SCENARIO,
      { customerId: "stale" },
      "dddddddddddddddddddddddddddddddd",
      "2026-07-12T00:00:04.000Z",
    )));
    await stale;

    expect(store.getState().syntheticExecution).toBe(current);
    expect(store.getState().syntheticPreviousExecution).toBe(previous);
    expect(store.getState().syntheticSelectedMomentId).toBe("selected-child-occurrence");
  });

  it("keeps static review selection/baseline while reusing request layout with collapsed snapshots", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(execution()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const store = makeStore();
    const selection = { rootId: ROOT, blockPath: [] };
    const baseline = {
      moduleSelected: new Set([ROOT]),
      moduleExpanded: new Set<string>(),
      minimalSeedIds: [ROOT],
      minimalMemberIds: [ROOT],
      minimalBasePositions: {},
      minimalArrange: false,
      reviewSelectedId: null,
      reviewLitNodeIds: null,
    };
    store.setState({ flowSelection: selection, flowPaneOrigin: "explorer", reviewFlowBaseline: baseline });

    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: SCENARIO.defaultInput,
      host: "flow-pane",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      scenarioId: SCENARIO.id,
      rootNodeId: ROOT,
      input: SCENARIO.defaultInput,
      inputOverrides: [],
      watchers: [],
    });
    expect(store.getState()).toMatchObject({
      flowSelection: selection,
      flowPaneOrigin: "synthetic",
      reviewFlowBaseline: baseline,
      syntheticExecutionStatus: "ready",
      syntheticExecutionError: null,
      syntheticSelectedMomentId: `request:${TRACE_ID}:span:${SPAN_ID}`,
      syntheticFlowOrientation: "vertical",
      requestFlowExpansionOverrides: new Set<string>(),
    });
    const momentId = `request:${TRACE_ID}:span:${SPAN_ID}`;
    const moment = store.getState().flowPaneRfNodes.find((node) => node.id === momentId)!;
    expect(moment.data as LogicNodeData).toMatchObject({
      expandable: false,
      isExpanded: true,
      runtime: {
        focused: true,
      },
    });
    expect((moment.data as LogicNodeData).runtime?.snapshot).toBeUndefined();
    expect(store.getState().syntheticExecution?.snapshots).toContainEqual({
      spanId: SPAN_ID,
      nodeId: ROOT,
      occurrenceKey: "placeOrder:1",
      input: { customerId: "cust_1" },
      output: { id: "ord_1" },
    });

    // The target is not mounted: synthetic inspection must reuse the canonical request-map reveal,
    // not rely on a pre-existing card or on PR-review-only highlighting.
    store.setState({ moduleSelected: new Set<string>(), moduleRfNodes: [], moduleLayoutStatus: "idle" });
    store.getState().selectSyntheticMoment(momentId, ROOT);
    expect(store.getState().syntheticSelectedMomentId).toBe(momentId);
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT]));
    expect(store.getState().flowSelection).toBe(selection);
    expect(store.getState().flowPaneOrigin).toBe("synthetic");

    store.getState().clearSyntheticExecution();
    expect(store.getState()).toMatchObject({
      flowSelection: selection,
      flowPaneOrigin: "explorer",
      reviewFlowBaseline: baseline,
      syntheticExecution: null,
      syntheticExecutionStatus: "idle",
      syntheticSelectedMomentId: null,
    });
    // Clearing replays normal flow selection, restoring every related node after the exact runtime
    // occurrence narrowed the upper map to one target.
    expect(store.getState().moduleSelected).toEqual(new Set([FILE]));
  });

  it("runs from a full Logic root without a pre-existing split and closes back to that Logic flow", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(execution()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const store = makeStore();
    store.setState({ viewMode: "logic", logicRoot: ROOT, logicStack: [ROOT], flowSelection: null });

    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: SCENARIO.defaultInput,
      host: "logic",
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      scenarioId: SCENARIO.id,
      rootNodeId: ROOT,
      input: SCENARIO.defaultInput,
      inputOverrides: [],
      watchers: [],
    });
    expect(store.getState()).toMatchObject({
      viewMode: "logic",
      logicRoot: ROOT,
      logicStack: [ROOT],
      flowSelection: { rootId: ROOT, blockPath: [] },
      flowPaneOrigin: "synthetic",
      syntheticExecutionRootId: ROOT,
      syntheticExecutionHost: "logic",
      syntheticExecutionStatus: "ready",
    });
    expect(store.getState().flowPaneRfNodes.length).toBeGreaterThan(0);

    store.getState().clearSyntheticExecution();
    expect(store.getState()).toMatchObject({
      viewMode: "logic",
      logicRoot: ROOT,
      logicStack: [ROOT],
      flowSelection: null,
      flowPaneOrigin: null,
      syntheticExecutionRootId: null,
      syntheticExecutionHost: null,
      syntheticExecutionStatus: "idle",
      flowPaneLayoutStatus: "idle",
    });
  });

  it("reruns a Logic-hosted experiment after occurrence inspection reveals its node in Map", async () => {
    const first = executionFor(
      SCENARIO,
      SCENARIO.defaultInput,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2026-07-12T00:00:01.000Z",
    );
    const second = executionFor(
      SCENARIO,
      { customerId: "cust_2" },
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "2026-07-12T00:00:02.000Z",
    );
    const results = [first, second];
    const fetchMock = vi.fn(async () => jsonResponse(results.shift()!));
    vi.stubGlobal("fetch", fetchMock);
    const store = makeStore();
    store.setState({ viewMode: "logic", logicRoot: ROOT, logicStack: [ROOT], flowSelection: null });

    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: first.input,
      host: "logic",
    });

    store.setState({ moduleSelected: new Set<string>(), moduleRfNodes: [], moduleLayoutStatus: "idle" });
    store.getState().selectSyntheticMoment(`request:${first.trace.traceId}:span:${SPAN_ID}`, ROOT);
    expect(store.getState()).toMatchObject({
      viewMode: "modules",
      flowSelection: { rootId: ROOT, blockPath: [] },
      flowPaneOrigin: "synthetic",
      syntheticExecutionHost: "logic",
      syntheticExecutionRootId: ROOT,
    });

    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: second.input,
      host: "logic",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      viewMode: "modules",
      flowPaneOrigin: "synthetic",
      syntheticExecution: second,
      syntheticExecutionStatus: "ready",
      syntheticExecutionError: null,
    });
  });

  it("cancels a Logic-hosted run when navigation moves to another root", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    const store = makeStore();
    store.setState({ viewMode: "logic", logicRoot: ROOT, logicStack: [ROOT], flowSelection: null });

    const pending = store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: SCENARIO.defaultInput,
      host: "logic",
    });
    expect(store.getState().syntheticExecutionStatus).toBe("running");

    store.getState().drillLogicFlow(CHILD);
    expect(store.getState()).toMatchObject({
      logicRoot: CHILD,
      flowSelection: null,
      syntheticExecutionRootId: null,
      syntheticExecutionHost: null,
      syntheticExecutionStatus: "idle",
    });

    resolveFetch(new Response(JSON.stringify(execution()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await pending;
    expect(store.getState()).toMatchObject({
      logicRoot: CHILD,
      flowSelection: null,
      flowPaneOrigin: null,
      syntheticExecution: null,
      syntheticExecutionStatus: "idle",
    });
  });

  it("does not mutate telemetry source state when local execution fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "runner timed out" }), {
      status: 504,
      headers: { "content-type": "application/json" },
    })));
    const store = makeStore();
    store.setState({ flowSelection: { rootId: ROOT, blockPath: [] }, flowPaneOrigin: "explorer" });

    await store.getState().runSyntheticExecution({
      rootId: ROOT,
      scenarioId: SCENARIO.id,
      input: SCENARIO.defaultInput,
      host: "flow-pane",
    });

    expect(store.getState()).toMatchObject({
      flowPaneOrigin: "explorer",
      syntheticExecutionStatus: "error",
      syntheticExecutionError: "runner timed out",
      telemetrySourceId: null,
      environment: null,
      requestTraces: [],
    });
  });
});

function jsonResponse(value: SyntheticExecution): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeStore(scenarios: SyntheticScenarioDescriptor[] = [SCENARIO]) {
  return createBlueprintStore({
    artifact: ARTIFACT,
    index: buildGraphIndex(ARTIFACT),
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
    syntheticScenarios: scenarios,
    prsUrl: "",
    prOneUrl: "",
    prFilesUrl: "",
    prRelatedUrl: "",
    prCommentsUrl: "",
    prChecksUrl: "",
    prReviewUrl: "",
  });
}
