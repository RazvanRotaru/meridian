import { describe, expect, it } from "vitest";
import type {
  CollapsedEdgeData,
  LogicEdgeSpec,
  LogicGraphSpec,
  LogicNodeData,
  LogicNodeSpec,
  LogicNodeType,
} from "./logicGraph";
import {
  collapseLogicEdges,
  logicEdgeCollapseKey,
  logicEdgeFoldNodeId,
} from "./collapseLogicEdges";

function node(
  id: string,
  options: { parentId?: string | null; type?: LogicNodeType; container?: boolean; label?: string } = {},
): LogicNodeSpec {
  const type = options.type ?? "block";
  const container = options.container ?? false;
  const data: LogicNodeData = {
    logicKind: type === "servicegroup" ? "service" : type === "branch" ? "if" : "call",
    label: options.label ?? id,
    targetId: null,
    resolution: null,
    expandable: container,
    isExpanded: container,
    isContainer: container,
    compact: false,
    callScope: null,
    greyed: false,
    provenance: null,
    childCount: 0,
  };
  return { id, parentId: options.parentId ?? null, type, data, width: 100, height: 50 };
}

function edge(
  id: string,
  source: string,
  target: string,
  options: Partial<Omit<LogicEdgeSpec, "id" | "source" | "target">> = {},
): LogicEdgeSpec {
  return { id, source, target, kind: "seq", ...options };
}

function project(spec: LogicGraphSpec, ...collapsed: LogicEdgeSpec[]): LogicGraphSpec {
  return collapseLogicEdges(spec, new Set(collapsed.map(logicEdgeCollapseKey)));
}

function foldNode(spec: LogicGraphSpec, collapsed: LogicEdgeSpec): LogicNodeSpec {
  const id = logicEdgeFoldNodeId(logicEdgeCollapseKey(collapsed));
  const found = spec.nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing fold node ${id}`);
  return found;
}

function ids(spec: LogicGraphSpec): string[] {
  return spec.nodes.map(({ id }) => id);
}

describe("logicEdgeCollapseKey", () => {
  it("is independent of sequential paint ids but distinguishes stable endpoints and ports", () => {
    const first = edge("e0", "decision", "body", {
      kind: "branch",
      sourcePort: "decision:then",
      branchRole: "then",
    });
    const renumbered = { ...first, id: "e91" };
    const otherArm = { ...first, id: "e1", sourcePort: "decision:else", branchRole: "else" as const };

    expect(logicEdgeCollapseKey(first)).toBe(logicEdgeCollapseKey(renumbered));
    expect(logicEdgeCollapseKey(first)).not.toBe(logicEdgeCollapseKey(otherArm));
  });
});

describe("collapseLogicEdges", () => {
  it("cuts a linear edge and replaces all exclusively downstream steps with one persistent stub", () => {
    const ab = edge("e0", "a", "b");
    const spec = { nodes: [node("a"), node("b"), node("c")], edges: [ab, edge("e1", "b", "c")] };

    const folded = project(spec, ab);
    const stub = foldNode(folded, ab);

    expect(ids(folded)).toEqual(["a", stub.id]);
    expect(stub).toMatchObject({
      type: "fold",
      data: { edgeKind: "seq", targetLabel: "b", hiddenStepCount: 2, collapseKey: logicEdgeCollapseKey(ab) },
    });
    expect(folded.edges).toEqual([
      expect.objectContaining({ source: "a", target: stub.id, kind: "seq", collapsible: false }),
    ]);
  });

  it("hides only one branch-exclusive region and reconnects its stub to a live join", () => {
    const thenEdge = edge("then", "decision", "then-body", {
      kind: "branch",
      label: "then",
      sourcePort: "decision:then",
      branchRole: "then",
    });
    const spec: LogicGraphSpec = {
      nodes: [
        node("decision", { type: "branch" }),
        node("then-body"),
        node("else-body"),
        node("join", { type: "join" }),
        node("after"),
      ],
      edges: [
        thenEdge,
        edge("else", "decision", "else-body", {
          kind: "branch",
          label: "else",
          sourcePort: "decision:else",
          branchRole: "else",
        }),
        edge("then-join", "then-body", "join", { branchRole: "then" }),
        edge("else-join", "else-body", "join", { branchRole: "else" }),
        edge("after", "join", "after"),
      ],
    };

    const folded = project(spec, thenEdge);
    const stub = foldNode(folded, thenEdge);

    expect(ids(folded)).toEqual(["decision", "else-body", "join", "after", stub.id]);
    expect(stub.data).toMatchObject({ hiddenStepCount: 1, edgeLabel: "then", branchRole: "then" });
    expect(folded.edges).toContainEqual(expect.objectContaining({
      source: "decision",
      target: stub.id,
      kind: "branch",
      sourcePort: "decision:then",
      label: "then",
      collapsible: false,
    }));
    expect(folded.edges).toContainEqual(expect.objectContaining({
      source: stub.id,
      target: "join",
      kind: "seq",
      collapsible: false,
    }));
    expect(folded.edges).toContainEqual(expect.objectContaining({ source: "join", target: "after" }));
  });

  it("keeps a target and continuation reached through another root, while preserving the folded connection", () => {
    const foldedConnection = edge("a-target", "a", "target");
    const spec: LogicGraphSpec = {
      nodes: [node("a"), node("x"), node("target"), node("after")],
      edges: [foldedConnection, edge("x-target", "x", "target"), edge("target-after", "target", "after")],
    };

    const folded = project(spec, foldedConnection);
    const stub = foldNode(folded, foldedConnection);

    expect(ids(folded)).toEqual(["a", "x", "target", "after", stub.id]);
    expect((stub.data as CollapsedEdgeData).hiddenStepCount).toBe(0);
    expect(folded.edges).toContainEqual(expect.objectContaining({
      source: stub.id,
      target: "target",
      kind: "seq",
      collapsible: false,
    }));
  });

  it("gates an expanded container body behind its owner so an outer cut cannot orphan-promote it", () => {
    const intoContainer = edge("into", "start", "container");
    const spec: LogicGraphSpec = {
      nodes: [
        node("start"),
        node("container", { type: "control", container: true }),
        node("after"),
        node("child-a", { parentId: "container" }),
        node("child-b", { parentId: "container" }),
      ],
      edges: [
        intoContainer,
        edge("outer-after", "container", "after"),
        edge("inner", "child-a", "child-b"),
      ],
    };

    const folded = project(spec, intoContainer);
    const stub = foldNode(folded, intoContainer);

    expect(ids(folded)).toEqual(["start", stub.id]);
    expect((stub.data as CollapsedEdgeData).hiddenStepCount).toBe(4);
    expect(folded.nodes.some((candidate) => candidate.parentId === "container")).toBe(false);
  });

  it("treats service frames as transparent and keeps a fold inside the common visible frame", () => {
    const ab = edge("ab", "a", "b");
    const spec: LogicGraphSpec = {
      nodes: [
        node("entry"),
        node("service", { type: "servicegroup", container: true }),
        node("a", { parentId: "service" }),
        node("b", { parentId: "service" }),
      ],
      edges: [edge("entry-a", "entry", "a"), ab],
    };

    const folded = project(spec, ab);
    const stub = foldNode(folded, ab);

    expect(ids(folded)).toEqual(["entry", "service", "a", stub.id]);
    expect(stub.parentId).toBe("service");
  });

  it("hides a join only after every live incoming path is cut", () => {
    const leftJoin = edge("left-join", "left", "join");
    const rightJoin = edge("right-join", "right", "join");
    const spec: LogicGraphSpec = {
      nodes: [node("split"), node("left"), node("right"), node("join", { type: "join" }), node("after")],
      edges: [
        edge("split-left", "split", "left", { kind: "branch", sourcePort: "left" }),
        edge("split-right", "split", "right", { kind: "branch", sourcePort: "right" }),
        leftJoin,
        rightJoin,
        edge("join-after", "join", "after"),
      ],
    };

    const folded = project(spec, leftJoin, rightJoin);

    expect(ids(folded)).not.toContain("join");
    expect(ids(folded)).not.toContain("after");
    expect((foldNode(folded, leftJoin).data as CollapsedEdgeData).hiddenStepCount).toBe(1);
    expect((foldNode(folded, rightJoin).data as CollapsedEdgeData).hiddenStepCount).toBe(1);
    expect(folded.edges.some((candidate) => candidate.source.includes("logic-fold:") && candidate.target === "join")).toBe(false);
  });

  it("folds an async rail without changing execution reachability", () => {
    const rail = edge("rail", "launch", "wait", {
      kind: "async",
      sourcePort: "launch:task",
      targetPort: "wait:task",
      taskId: "task",
    });
    const spec: LogicGraphSpec = {
      nodes: [node("launch"), node("wait")],
      edges: [edge("exec", "launch", "wait"), rail],
    };

    const folded = project(spec, rail);
    const stub = foldNode(folded, rail);

    expect(ids(folded)).toEqual(["launch", "wait", stub.id]);
    expect((stub.data as CollapsedEdgeData).hiddenStepCount).toBe(0);
    expect(folded.edges).toContainEqual(expect.objectContaining({ source: "launch", target: "wait", kind: "seq" }));
    expect(folded.edges).toContainEqual(expect.objectContaining({
      source: stub.id,
      target: "wait",
      kind: "async",
      targetPort: "wait:task",
      collapsible: false,
    }));
  });

  it("does not fold projection-owned non-collapsible segments", () => {
    const fixed = edge("fixed", "a", "b", { collapsible: false });
    const spec: LogicGraphSpec = { nodes: [node("a"), node("b")], edges: [fixed] };

    expect(collapseLogicEdges(spec, new Set([logicEdgeCollapseKey(fixed)]))).toBe(spec);
  });
});
