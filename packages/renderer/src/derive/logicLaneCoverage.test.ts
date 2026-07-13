import { describe, expect, it } from "vitest";
import type { CoverageReport, LeafCoverageStatus } from "@meridian/core";
import type { LogicBranchPort, LogicNodeData } from "./logicGraph";
import type { LogicRfEdge, LogicRfNode } from "../layout/logicElk";
import { COVERAGE_COLORS } from "../theme/coverageColors";
import {
  inferVisibleLaneReachability,
  paintInferredLaneReachability,
  visibleCallReachabilityTone,
  withInferredLaneReachability,
} from "./logicLaneCoverage";

describe("Logic branch-lane static coverage", () => {
  it("paints the split, internal, and rejoin edges for each lane without touching shared or async edges", () => {
    const thenPort = port("r::0", 0, "then", "then");
    const elsePort = port("r::0", 1, "else", "else");
    const nodes = [
      branch("r::0", [thenPort, elsePort]),
      call("r::0/b0/0", "direct-a"),
      call("r::0/b0/1", "direct-b"),
      call("r::0/b1/0", "missed"),
      join("r::0::join"),
      call("r::1", "after"),
    ];
    const edges = [
      split("then-split", "r::0", "r::0/b0/0", thenPort),
      seq("then-inside", "r::0/b0/0", "r::0/b0/1"),
      seq("then-rejoin", "r::0/b0/1", "r::0::join", { branchRole: "then" }),
      split("else-split", "r::0", "r::0/b1/0", elsePort),
      seq("else-rejoin", "r::0/b1/0", "r::0::join", { branchRole: "else" }),
      seq("shared-after", "r::0::join", "r::1"),
      seq("async-rail", "r::0/b0/0", "r::0/b0/1", { kind: "async" }),
    ];
    const originalThenStyle = { ...edges[0]!.style };
    const model = inferVisibleLaneReachability(nodes, edges, coverage({
      "direct-a": "covered",
      "direct-b": "covered",
      missed: "uncovered",
      after: "indirect",
    }));

    expect(model.byLaneId.get(thenPort.id)).toMatchObject({ tone: "covered", counts: { direct: 2, indirect: 0, uncovered: 0 } });
    expect(model.byLaneId.get(elsePort.id)).toMatchObject({ tone: "uncovered", counts: { direct: 0, indirect: 0, uncovered: 1 } });
    expect([...model.byEdgeId.keys()]).toEqual(["then-split", "then-inside", "then-rejoin", "else-split", "else-rejoin"]);

    const painted = paintInferredLaneReachability(edges, model);
    expect(painted.slice(0, 3).map(stroke)).toEqual(Array(3).fill(COVERAGE_COLORS.covered));
    expect(painted.slice(3, 5).map(stroke)).toEqual(Array(2).fill(COVERAGE_COLORS.uncovered));
    expect(painted[0]!.data?.staticLane?.laneId).toBe(thenPort.id);
    expect(painted[2]!.data?.staticLane?.laneId).toBe(thenPort.id);
    expect(painted[3]!.data?.staticLane?.laneId).toBe(elsePort.id);
    expect(painted[0]!.labelStyle).toMatchObject({ fill: COVERAGE_COLORS.covered });
    expect(painted[0]!.markerEnd).toMatchObject({ color: COVERAGE_COLORS.covered });
    expect(painted[0]!.ariaLabel).toContain("static callee reachability");
    expect(painted[0]!.ariaLabel).toContain("not branch execution data");
    expect(painted[5]).toBe(edges[5]);
    expect(painted[6]).toBe(edges[6]);
    expect(edges[0]!.style).toEqual(originalThenStyle);
    expect(edges[0]!.data?.staticLane).toBeUndefined();
  });

  it("reduces all-direct to green and indirect or mixed reachability to amber", () => {
    const lane = port("r::0", 0, "then", "then");
    const cases: Array<[string, LeafCoverageStatus[], string]> = [
      ["all direct", ["covered", "covered"], "covered"],
      ["contains indirect", ["covered", "indirect"], "indirect"],
      ["mixed direct and unreachable", ["covered", "uncovered"], "indirect"],
      ["all unreachable", ["uncovered", "uncovered"], "uncovered"],
    ];
    for (const [name, statuses, expected] of cases) {
      const nodes = [branch("r::0", [lane]), ...statuses.map((_, index) => call(`r::0/b0/${index}`, `t${index}`))];
      const report = coverage(Object.fromEntries(statuses.map((status, index) => [`t${index}`, status])));
      const model = inferVisibleLaneReachability(nodes, [split("lane", "r::0", "r::0/b0/0", lane)], report);
      expect(model.byLaneId.get(lane.id)?.tone, name).toBe(expected);
    }

    const mixedNodes = [
      branch("r::0", [lane]),
      call("r::0/b0/0", "direct"),
      call("r::0/b0/1", null, "unresolved"),
    ];
    const mixedModel = inferVisibleLaneReachability(
      mixedNodes,
      [split("lane", "r::0", "r::0/b0/0", lane)],
      coverage({ direct: "covered" }),
    );
    expect(mixedModel.byLaneId.get(lane.id)).toMatchObject({
      tone: "indirect",
      counts: { direct: 1, unmeasured: 1 },
    });
  });

  it("keeps empty, synthetic, unresolved-only, and external-only lanes unknown rather than red", () => {
    const explicit = port("r::0", 0, "else", "else");
    const synthetic = { ...port("r::0", 1, "no match", "fallthrough"), synthetic: true };
    const unresolved = port("r::0", 2, "dynamic", "case");
    const external = port("r::0", 3, "library", "case");
    const nodes = [
      branch("r::0", [explicit, synthetic, unresolved, external]),
      call("r::0/b2/0", null, "unresolved"),
      call("r::0/b3/0", "ext:lib#call", "external"),
      join("r::0::join"),
    ];
    const edges = [
      split("explicit", "r::0", "r::0::join", explicit),
      split("synthetic", "r::0", "r::0::join", synthetic),
      split("unresolved", "r::0", "r::0/b2/0", unresolved),
      split("external", "r::0", "r::0/b3/0", external),
    ];
    const model = inferVisibleLaneReachability(nodes, edges, coverage({}));
    expect([...model.byLaneId.values()].map((signal) => signal.tone)).toEqual(["none", "none", "none", "none"]);
    expect(model.byLaneId.get(unresolved.id)?.counts.unmeasured).toBe(1);
    expect(model.byLaneId.get(external.id)?.counts.unmeasured).toBe(1);
    expect(paintInferredLaneReachability(edges, model).map(stroke)).toEqual(Array(4).fill(COVERAGE_COLORS.none));
  });

  it("uses a resolved class/container roll-up for constructor-call lanes and the minimap", () => {
    const lane = port("r::0", 0, "then", "then");
    const constructorCall = call("r::0/b0/0", "class:Worker");
    const report = coverage({}, {
      "class:Worker": { covered: 1, total: 2, percent: 50, status: "partial" },
    });
    const model = inferVisibleLaneReachability(
      [branch("r::0", [lane]), constructorCall],
      [split("lane", "r::0", constructorCall.id, lane)],
      report,
    );

    expect(model.byLaneId.get(lane.id)).toMatchObject({ tone: "indirect", counts: { indirect: 1, unmeasured: 0 } });
    expect(visibleCallReachabilityTone(constructorCall, report)).toBe("indirect");

    const fullyReached = coverage({}, {
      "class:Worker": { covered: 2, total: 2, percent: 100, status: "covered" },
    });
    expect(visibleCallReachabilityTone(constructorCall, fullyReached)).toBe("indirect");
  });

  it("lets the innermost nested branch own its lane while outer continuation keeps outer context", () => {
    const outer = port("r::0", 0, "then", "then");
    const nestedId = "r::0/b0/1";
    const nestedThen = port(nestedId, 0, "then", "then");
    const nestedElse = port(nestedId, 1, "else", "else");
    const nodes = [
      branch("r::0", [outer]),
      call("r::0/b0/0", "outer-before"),
      branch(nestedId, [nestedThen, nestedElse]),
      call(`${nestedId}/b0/0`, "nested-missed"),
      call(`${nestedId}/b1/0`, "nested-direct"),
      join(`${nestedId}::join`),
      call("r::0/b0/2", "outer-after"),
      join("r::0::join"),
    ];
    const edges = [
      split("outer-split", "r::0", "r::0/b0/0", outer),
      seq("outer-before-nested", "r::0/b0/0", nestedId),
      split("nested-then-split", nestedId, `${nestedId}/b0/0`, nestedThen),
      seq("nested-then-rejoin", `${nestedId}/b0/0`, `${nestedId}::join`),
      split("nested-else-split", nestedId, `${nestedId}/b1/0`, nestedElse),
      seq("nested-else-rejoin", `${nestedId}/b1/0`, `${nestedId}::join`),
      seq("nested-join-continuation", `${nestedId}::join`, "r::0/b0/2"),
      seq("outer-rejoin", "r::0/b0/2", "r::0::join"),
    ];
    const model = inferVisibleLaneReachability(nodes, edges, coverage({
      "outer-before": "covered",
      "nested-missed": "uncovered",
      "nested-direct": "covered",
      "outer-after": "covered",
    }));

    expect(model.byLaneId.get(outer.id)?.tone).toBe("indirect");
    expect(model.byLaneId.get(nestedThen.id)?.tone).toBe("uncovered");
    expect(model.byLaneId.get(nestedElse.id)?.tone).toBe("covered");
    expect(model.byEdgeId.get("nested-then-split")?.laneId).toBe(nestedThen.id);
    expect(model.byEdgeId.get("nested-then-rejoin")?.laneId).toBe(nestedThen.id);
    expect(model.byEdgeId.get("nested-else-split")?.laneId).toBe(nestedElse.id);
    expect(model.byEdgeId.get("nested-join-continuation")?.laneId).toBe(outer.id);
    expect(model.byEdgeId.get("outer-rejoin")?.laneId).toBe(outer.id);
  });

  it("does not let an expanded callee's internal nodes change its caller lane", () => {
    const lane = port("r::0", 0, "then", "then");
    const parent = call("r::0/b0/0", "worker", "resolved", undefined, true);
    const child = call("r::0/b0/0/0", "worker-child", "resolved", parent.id);
    const secondChild = call("r::0/b0/0/1", "worker-child-2", "resolved", parent.id);
    const nodes = [branch("r::0", [lane]), parent, child, secondChild];
    const model = inferVisibleLaneReachability(nodes, [
      split("lane", "r::0", parent.id, lane),
      seq("callee-internal", child.id, secondChild.id),
    ], coverage({
      worker: "uncovered",
      "worker-child": "covered",
      "worker-child-2": "covered",
    }));
    expect(model.byLaneId.get(lane.id)).toMatchObject({ tone: "uncovered", counts: { direct: 0, uncovered: 1 } });
    expect(model.byEdgeId.has("callee-internal")).toBe(false);

    // The callee's own branch still gets a signal when it is visible inside that expanded call. The
    // containing call is shared context for this lane, not a reason to suppress its own children.
    const innerBranchId = `${parent.id}/0`;
    const innerLane = port(innerBranchId, 0, "then", "then");
    const innerBranch = branch(innerBranchId, [innerLane]);
    innerBranch.parentId = parent.id;
    const innerCall = call(`${innerBranchId}/b0/0`, "inner-target", "resolved", parent.id);
    const innerModel = inferVisibleLaneReachability(
      [parent, innerBranch, innerCall],
      [split("inner-lane", innerBranchId, innerCall.id, innerLane)],
      coverage({ "inner-target": "covered" }),
    );
    expect(innerModel.byLaneId.get(innerLane.id)?.tone).toBe("covered");
  });

  it("preserves catch edge grammar, returns exact inputs when coverage is off, and mirrors call tones", () => {
    const catchPort = port("r::0", 0, "catch error", "catch");
    const nodes = [branch("r::0", [catchPort], "try"), call("r::0/b0/0", "recover")];
    const catchEdge = split("catch", "r::0", "r::0/b0/0", catchPort, { strokeDasharray: "7 5", strokeWidth: 4 });
    const edges = [catchEdge];
    expect(withInferredLaneReachability(edges, nodes, null)).toBe(edges);

    const painted = withInferredLaneReachability(edges, nodes, coverage({ recover: "uncovered" }));
    expect(painted[0]!.style).toMatchObject({ stroke: COVERAGE_COLORS.uncovered, strokeDasharray: "7 5", strokeWidth: 4 });
    expect(painted[0]!.sourceHandle).toBe(catchPort.id);
    expect(painted[0]!.data?.kind).toBe("branch");
    expect(visibleCallReachabilityTone(nodes[1]!, coverage({ recover: "uncovered" }))).toBe("uncovered");

    const unknownCall = call("unknown", "missing");
    expect(visibleCallReachabilityTone(unknownCall, coverage({}))).toBe("none");
    const definition = call("definition", "recover");
    (definition.data as LogicNodeData).definition = true;
    expect(visibleCallReachabilityTone(definition, coverage({ recover: "covered" }))).toBe("covered");
    const testDefinition = call("test-definition", "test");
    (testDefinition.data as LogicNodeData).definition = true;
    expect(visibleCallReachabilityTone(testDefinition, coverage({}))).toBe("test");
  });
});

function coverage(
  statuses: Record<string, LeafCoverageStatus>,
  containers: CoverageReport["containers"] = {},
): CoverageReport {
  return {
    leaves: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, {
      status,
      distance: status === "covered" ? 1 : status === "indirect" ? 2 : null,
      directTestCallers: status === "covered" ? ["test"] : [],
      ...(status === "uncovered" ? { reason: { kind: "never-called" as const, callers: [] } } : {}),
    }])),
    containers,
    summary: {
      callables: Object.keys(statuses).length,
      covered: 0,
      indirect: 0,
      uncovered: 0,
      percent: 0,
      testNodes: 1,
      unresolvedFromTests: 0,
    },
    testIds: new Set(["test"]),
  };
}

function port(branchId: string, order: number, label: string, role: LogicBranchPort["role"]): LogicBranchPort {
  return { id: `${branchId}::port/${order}`, label, role, order };
}

function branch(id: string, branchPorts: LogicBranchPort[], kind: "if" | "try" = "if"): LogicRfNode {
  return {
    id,
    type: kind === "try" ? "exception" : "branch",
    position: { x: 0, y: 0 },
    data: {
      logicKind: kind,
      targetId: null,
      branchPorts,
    } as LogicNodeData,
  };
}

function call(
  id: string,
  targetId: string | null,
  resolution: "resolved" | "external" | "unresolved" = "resolved",
  parentId?: string,
  isContainer = false,
): LogicRfNode {
  return {
    id,
    type: "block",
    position: { x: 0, y: 0 },
    ...(parentId ? { parentId } : {}),
    data: {
      logicKind: "call",
      targetId,
      resolution,
      isContainer,
    } as LogicNodeData,
  };
}

function join(id: string): LogicRfNode {
  return {
    id,
    type: "join",
    position: { x: 0, y: 0 },
    data: { logicKind: "join", targetId: null } as LogicNodeData,
  };
}

function split(
  id: string,
  source: string,
  target: string,
  lane: LogicBranchPort,
  style: React.CSSProperties = {},
): LogicRfEdge {
  return {
    id,
    source,
    target,
    sourceHandle: lane.id,
    label: lane.label,
    type: "smoothstep",
    style: { stroke: "#base", strokeWidth: 2, ...style },
    labelStyle: { fill: "#base" },
    markerEnd: { type: "arrowclosed", color: "#base" } as LogicRfEdge["markerEnd"],
    data: { kind: "branch", sourcePort: lane.id, branchRole: lane.role },
  };
}

function seq(
  id: string,
  source: string,
  target: string,
  data: Partial<NonNullable<LogicRfEdge["data"]>> = {},
): LogicRfEdge {
  return {
    id,
    source,
    target,
    type: data.kind === "async" ? "logicAsync" : "smoothstep",
    style: { stroke: "#base", strokeWidth: 2 },
    markerEnd: { type: "arrowclosed", color: "#base" } as LogicRfEdge["markerEnd"],
    data: { kind: "seq", ...data },
  };
}

function stroke(edge: LogicRfEdge): React.CSSProperties["stroke"] {
  return edge.style?.stroke;
}
