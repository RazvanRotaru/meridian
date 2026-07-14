import { describe, expect, it } from "vitest";
import type { EdgeResolution, FlowStep, LogicFlows } from "@meridian/core";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { GraphIndex } from "../graph/graphIndex";
import { deriveLogicGraph, type LogicNodeSpec } from "../derive/logicGraph";
import { buildLogicElkGraph, LOGIC_ASYNC_EDGE_TYPE, toReactFlowLogic } from "./logicElk";
import { runElkLayout } from "./elkLayout";

const index = {
  nodesById: new Map(),
  ancestorsOf: () => [],
  changedIds: new Set<string>(),
} as unknown as GraphIndex;

const call = (label: string, resolution: EdgeResolution = "external"): FlowStep => ({
  kind: "call",
  label,
  target: `ext:test#${label}`,
  resolution,
});

function elkNode(root: ElkNode, id: string): ElkNode {
  const visit = (nodes: ElkNode[]): ElkNode | undefined => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const nested = visit(node.children ?? []);
      if (nested) return nested;
    }
    return undefined;
  };
  const found = visit(root.children ?? []);
  if (!found) throw new Error(`missing ELK node ${id}`);
  return found;
}

describe("logic ELK graph", () => {
  it("gives an expanded changed-call container enough width for its textual status rail", () => {
    const target = "ts:src/work.ts#work";
    const changedIndex = {
      ...index,
      nodesById: new Map([[target, { id: target, kind: "function", displayName: "work" }]]),
      changedStatus: new Map([[target, "modified"]]),
    } as unknown as GraphIndex;
    const flows: LogicFlows = {
      r: [{ kind: "call", label: "work", target, resolution: "resolved" }],
      [target]: [call("child")],
    };
    const spec = deriveLogicGraph("r", flows, changedIndex, new Set(["r::0"]), { hideGreyed: false });
    const measured = spec.nodes.find((node) => node.id === "r::0")!;
    const container = elkNode(buildLogicElkGraph(spec), "r::0");

    expect(measured.width).toBeGreaterThanOrEqual(260);
    expect(container.layoutOptions).toMatchObject({
      "elk.nodeSize.constraints": "MINIMUM_SIZE",
      "elk.nodeSize.minimum": `(${measured.width},${measured.height})`,
    });
  });

  it("uses a roomy horizontal cadence and fixed ordered ports for branch lanes", () => {
    const branch: FlowStep = {
      kind: "branch",
      label: "if ready",
      paths: [
        { label: "then", role: "then", body: [call("yes")] },
        { label: "else", role: "else", body: [call("no")] },
      ],
    };
    const spec = deriveLogicGraph("r", { r: [branch, call("after")] }, index, new Set(), { hideGreyed: false });
    const graph = buildLogicElkGraph(spec);
    expect(graph.layoutOptions).toMatchObject({
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "112",
      "elk.spacing.nodeNode": "120",
    });

    const split = elkNode(graph, "r::0");
    expect(split.layoutOptions?.["elk.portConstraints"]).toBe("FIXED_ORDER");
    expect(split.ports?.map((port) => ({ id: port.id, side: port.layoutOptions?.["elk.port.side"] }))).toEqual([
      { id: "r::0::port/0", side: "EAST" },
      { id: "r::0::port/1", side: "EAST" },
    ]);

    const byEdge = new Map((graph.edges ?? []).map((edge) => [edge.id, edge]));
    for (const edge of spec.edges.filter((candidate) => candidate.source === "r::0")) {
      expect(byEdge.get(edge.id)?.sources).toEqual([edge.sourcePort]);
      expect(elkNode(graph, edge.target).layoutOptions?.["elk.spacing.individual"]).toBe(
        "[top=48,left=0,bottom=48,right=0]",
      );
    }
    expect(spec.nodes.find((node) => node.id === "r::0::join")).toMatchObject({ type: "join", width: 42, height: 72 });
  });

  it("turns branch lanes and pins onto the vertical axis without changing the spec", () => {
    const branch: FlowStep = {
      kind: "branch",
      label: "if ready",
      paths: [
        { label: "then", role: "then", body: [call("yes")] },
        { label: "else", role: "else", body: [call("no")] },
      ],
    };
    const spec = deriveLogicGraph("r", { r: [branch, call("after")] }, index, new Set(), { hideGreyed: false });
    const graph = buildLogicElkGraph(spec, "vertical");

    expect(graph.layoutOptions).toMatchObject({
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "76",
    });
    const split = elkNode(graph, "r::0");
    expect(split.ports?.map((port) => port.layoutOptions?.["elk.port.side"])).toEqual(["SOUTH", "SOUTH"]);
    for (const edge of spec.edges.filter((candidate) => candidate.source === "r::0")) {
      expect(elkNode(graph, edge.target).layoutOptions?.["elk.spacing.individual"]).toBe(
        "[top=0,left=48,bottom=0,right=48]",
      );
    }
    const rf = toReactFlowLogic(graph, new Map(spec.nodes.map((node) => [node.id, node])), spec.edges, "vertical");
    expect(rf.edges.every((edge) => edge.data?.orientation === "vertical")).toBe(true);
  });

  it("does not install hidden lane ports on folded branch and try summaries", () => {
    const structures: FlowStep[] = [
      {
        kind: "branch",
        branchKind: "if",
        label: "if ready",
        paths: [
          { label: "then", role: "then", body: [call("yes")] },
          { label: "else", role: "else", body: [call("no")] },
        ],
      },
      {
        kind: "branch",
        branchKind: "try",
        label: "try/catch",
        paths: [
          { label: "try", role: "try", body: [call("normal")] },
          { label: "catch error", role: "catch", body: [call("recover")] },
        ],
      },
    ];

    for (const structure of structures) {
      const spec = deriveLogicGraph(
        "r",
        { r: [structure, call("after")] },
        index,
        new Set(["r::0"]),
        { hideGreyed: false },
      );
      const graph = buildLogicElkGraph(spec);
      const summary = elkNode(graph, "r::0");

      expect(spec.nodes.find((node) => node.id === "r::0")?.data).toMatchObject({
        expandable: true,
        isExpanded: false,
      });
      expect(summary.ports ?? []).toEqual([]);
      expect(summary.layoutOptions?.["elk.portConstraints"]).not.toBe("FIXED_ORDER");
      expect(spec.edges).toEqual([
        expect.objectContaining({ source: "r::0", target: "r::1", kind: "seq" }),
      ]);
      expect(spec.edges[0].sourcePort).toBeUndefined();
      expect(graph.edges?.[0]?.sources).toEqual(["r::0"]);
    }
  });

  it("passes branch and async endpoint ids through to React Flow handles", () => {
    const flows: LogicFlows = {
      r: [
        {
          kind: "call",
          label: "start",
          target: null,
          resolution: "unresolved",
          async: { kind: "launch", taskId: "task:1", binding: "pending" },
        },
        { kind: "await", label: "await pending", mode: "single", inputs: [{ label: "pending", taskId: "task:1" }] },
      ],
    };
    const spec = deriveLogicGraph("r", flows, index, new Set(), { hideGreyed: false });
    const graph = buildLogicElkGraph(spec);
    const asyncEdge = spec.edges.find((edge) => edge.kind === "async")!;
    const elkEdge = graph.edges?.find((edge) => edge.id === asyncEdge.id);
    expect(elkEdge).toMatchObject({
      sources: ["r::0::async/source/0"],
      targets: ["r::1::async/target/0"],
    });

    const rf = toReactFlowLogic(graph, new Map<string, LogicNodeSpec>(spec.nodes.map((node) => [node.id, node])), spec.edges);
    expect(rf.edges.find((edge) => edge.id === asyncEdge.id)).toMatchObject({
      sourceHandle: "r::0::async/source/0",
      targetHandle: "r::1::async/target/0",
      type: LOGIC_ASYNC_EDGE_TYPE,
      data: {
        kind: "async",
        taskId: "task:1",
        sourcePort: "r::0::async/source/0",
        targetPort: "r::1::async/target/0",
      },
    });
  });

  it("lays branch arms into visibly separate horizontal lanes", async () => {
    const branch: FlowStep = {
      kind: "branch",
      label: "if ready",
      paths: [
        { label: "then", role: "then", body: [call("yes"), call("yesAgain")] },
        { label: "else", role: "else", body: [call("no"), call("noAgain")] },
      ],
    };
    const spec = deriveLogicGraph("r", { r: [call("before"), branch, call("after")] }, index, new Set(), { hideGreyed: false });
    const laidOut = await runElkLayout(buildLogicElkGraph(spec));
    const split = elkNode(laidOut, "r::1");
    const yes = elkNode(laidOut, "r::1/b0/0");
    const no = elkNode(laidOut, "r::1/b1/0");
    const join = elkNode(laidOut, "r::1::join");
    const after = elkNode(laidOut, "r::2");
    expect(split.x).toBeLessThan(yes.x!);
    expect(yes.x).toBeLessThan(join.x!);
    expect(join.x).toBeLessThan(after.x!);
    expect(Math.abs(yes.y! - no.y!)).toBeGreaterThanOrEqual(140);
  });

  it("lays try/catch through an exception gate and carries a dashed catch route into the join", async () => {
    const tryCatch: FlowStep = {
      kind: "branch",
      branchKind: "try",
      label: "try/catch",
      paths: [
        { label: "try", role: "try", body: [call("normal")] },
        { label: "catch error", role: "catch", body: [call("recover")] },
      ],
    };
    const spec = deriveLogicGraph("r", { r: [tryCatch, call("after")] }, index, new Set(), { hideGreyed: false });
    expect(spec.nodes.find((node) => node.id === "r::0")).toMatchObject({
      type: "exception",
      width: 190,
      height: 66,
      data: { logicKind: "try", expandable: true, isExpanded: true, isContainer: false },
    });

    const laidOut = await runElkLayout(buildLogicElkGraph(spec));
    const gate = elkNode(laidOut, "r::0");
    const normal = elkNode(laidOut, "r::0/b0/0");
    const recover = elkNode(laidOut, "r::0/b1/0");
    const join = elkNode(laidOut, "r::0::join");
    expect(gate.x).toBeLessThan(normal.x!);
    expect(normal.x).toBeLessThan(join.x!);
    expect(Math.abs(normal.y! - recover.y!)).toBeGreaterThanOrEqual(140);

    const rf = toReactFlowLogic(laidOut, new Map<string, LogicNodeSpec>(spec.nodes.map((node) => [node.id, node])), spec.edges);
    const normalSplit = rf.edges.find((edge) => edge.data?.branchRole === "try" && edge.source === "r::0")!;
    const catchEdges = rf.edges.filter((edge) => edge.data?.branchRole === "catch");
    expect(normalSplit).toMatchObject({ sourceHandle: "r::0::port/0", style: { stroke: "#C8D3E0" }, data: { branchRole: "try" } });
    expect(catchEdges).toHaveLength(2);
    expect(catchEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "r::0", sourceHandle: "r::0::port/1", style: expect.objectContaining({ stroke: "#D98A5B", strokeDasharray: "7 5" }), data: expect.objectContaining({ branchRole: "catch" }) }),
      expect.objectContaining({ source: "r::0/b1/0", target: "r::0::join", style: expect.objectContaining({ stroke: "#D98A5B", strokeDasharray: "7 5" }), data: expect.objectContaining({ branchRole: "catch" }) }),
    ]));
  });

  it("places a mandatory finally phase after the protected lanes merge with no bypass edge", async () => {
    const tryFinally: FlowStep = {
      kind: "branch",
      branchKind: "try",
      label: "try/catch",
      paths: [
        { label: "try", role: "try", body: [call("normal")] },
        { label: "catch error", role: "catch", body: [call("recover")] },
        { label: "finally", role: "finally", body: [call("cleanup")] },
      ],
    };
    const spec = deriveLogicGraph("r", { r: [tryFinally, call("after")] }, index, new Set(), { hideGreyed: false });
    const laidOut = await runElkLayout(buildLogicElkGraph(spec));
    const join = elkNode(laidOut, "r::0::join");
    const phase = elkNode(laidOut, "r::0::finally");
    const cleanup = elkNode(laidOut, "r::0/finally/0");
    const after = elkNode(laidOut, "r::1");
    expect(join.x).toBeLessThan(phase.x!);
    expect(phase.x).toBeLessThan(cleanup.x!);
    expect(cleanup.x).toBeLessThan(after.x!);
    expect(spec.edges).toContainEqual(expect.objectContaining({ source: "r::0::join", target: "r::0::finally" }));
    expect(spec.edges).toContainEqual(expect.objectContaining({ source: "r::0::finally", target: "r::0/finally/0" }));
    expect(spec.edges.some((edge) => edge.source === "r::0::join" && edge.target === "r::1")).toBe(false);
  });
});
