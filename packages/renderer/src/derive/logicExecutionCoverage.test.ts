import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode, JsonValue, TestExecutionCoverage } from "@meridian/core";
import type { LogicRfEdge, LogicRfNode } from "../layout/logicElk";
import { COVERAGE_COLORS } from "../theme/coverageColors";
import type { LogicBranchPort, LogicNodeData } from "./logicGraph";
import {
  executionCoverageIndex,
  executionEvidenceForNode,
  inferExecutionLaneCoverage,
  tallySelectedExecutionBranchCoverage,
  withExecutionLaneCoverage,
} from "./logicExecutionCoverage";

describe("Logic runtime execution coverage", () => {
  it("colors only a uniquely matched function and preserves an explicit zero", () => {
    const node = graphNode("fn", "validateOrderRequest", 7, 17);
    const zero = artifact([node], coverage({
      functions: [{ name: "validateOrderRequest", hits: 0, decl: span(7, 7, 16), location: span(7, 17, 1) }],
      branches: [],
    }));
    const execution = executionCoverageIndex(zero);

    expect(executionEvidenceForNode(node, execution)).toEqual({ hits: 0, verdict: "uncovered" });

    const ambiguous = artifact([node], coverage({
      functions: [
        { name: "(anonymous_1)", hits: 0, decl: span(7, 7, 16), location: span(7, 17, 1) },
        { name: "(anonymous_2)", hits: 3, decl: span(7, 7, 30), location: span(7, 17, 1) },
      ],
      branches: [],
    }));
    expect(executionEvidenceForNode(node, executionCoverageIndex(ambiguous))).toBeNull();
  });

  it("maps an Istanbul if counter to explicit then and synthetic else lanes", () => {
    const ports = [port("then", "then", 0, source(8, 2, 10, 3)), port("else", "fallthrough", 1, undefined, true)];
    const nodes = branchNodes("if", ports, source(8, 2, 10, 3));
    const edges = laneEdges(ports);
    const execution = executionCoverageIndex(artifact([], coverage({
      functions: [],
      branches: [{
        type: "if",
        location: span(8, 10, 3),
        paths: [
          { index: 0, hits: 0, location: span(8, 10, 3) },
          { index: 1, hits: 4, location: span(8, 8, 2) },
        ],
      }],
    })))!;

    const model = inferExecutionLaneCoverage(nodes, edges, execution);
    expect(model.byLaneId.get("then")).toMatchObject({ tone: "uncovered", hits: 0, pathIndex: 0 });
    expect(model.byLaneId.get("else")).toMatchObject({ tone: "covered", hits: 4, pathIndex: 1 });

    const painted = withExecutionLaneCoverage(edges, nodes, execution);
    expect(painted[0]?.style?.stroke).toBe(COVERAGE_COLORS.uncovered);
    expect(painted[1]?.style?.stroke).toBe(COVERAGE_COLORS.covered);
  });

  it("does not shift an ignored if arm onto the wrong Logic lane", () => {
    const ports = [
      port("then", "then", 0, source(8, 2, 10, 3)),
      port("else", "else", 1, source(10, 7, 12, 3)),
    ];
    const nodes = branchNodes("if", ports, source(8, 2, 12, 3));
    const execution = executionCoverageIndex(artifact([], coverage({
      functions: [],
      branches: [{
        type: "if",
        location: span(8, 12, 3),
        // `/* istanbul ignore if */` removes the then counter, so else becomes raw index 0.
        paths: [{ index: 0, hits: 2, location: span(10, 12, 3, 7) }],
      }],
    })))!;

    const model = inferExecutionLaneCoverage(nodes, laneEdges(ports), execution);
    expect(model.byLaneId.get("then")).toMatchObject({ tone: "unknown", hits: null, reason: "no-path-match" });
    expect(model.byLaneId.get("else")).toMatchObject({ tone: "covered", hits: 2, pathIndex: 0 });
  });

  it("keeps try/catch and a default-less switch no-match lane unknown", () => {
    const tryPorts = [port("try", "try", 0), port("catch", "catch", 1)];
    const tryModel = inferExecutionLaneCoverage(
      branchNodes("try", tryPorts, source(1, 0, 5, 1)),
      laneEdges(tryPorts),
      executionCoverageIndex(artifact([], coverage({ functions: [], branches: [] })))!,
    );
    expect([...tryModel.byLaneId.values()].every((signal) => signal.reason === "unsupported-branch-kind")).toBe(true);

    const switchPorts = [
      port("case-a", "case", 0, source(2, 2, 3, 8)),
      port("no-match", "fallthrough", 1, undefined, true),
    ];
    const switchModel = inferExecutionLaneCoverage(
      branchNodes("switch", switchPorts, source(1, 0, 4, 1)),
      laneEdges(switchPorts),
      executionCoverageIndex(artifact([], coverage({
        functions: [],
        branches: [{
          type: "switch",
          location: span(1, 4, 1, 0),
          paths: [{ index: 0, hits: 1, location: span(2, 3, 8, 2) }],
        }],
      })))!,
    );
    expect(switchModel.byLaneId.get("case-a")).toMatchObject({ tone: "covered", hits: 1 });
    expect(switchModel.byLaneId.get("no-match")).toMatchObject({ tone: "unknown", reason: "no-path-match" });
  });

  it("keeps source-less and report-missing branches gray instead of inferring red", () => {
    const ports = [port("then", "then", 0), port("else", "fallthrough", 1, undefined, true)];
    const nodes = branchNodes("if", ports, undefined);
    const edges = laneEdges(ports);
    const execution = executionCoverageIndex(artifact([], coverage({ functions: [], branches: [] })))!;

    const painted = withExecutionLaneCoverage(edges, nodes, execution);
    expect(painted.every((edge) => edge.style?.stroke === COVERAGE_COLORS.none)).toBe(true);
    expect(painted.every((edge) => edge.data?.executionLane?.reason === "missing-source")).toBe(true);
  });

  it("tallies the selected callable's measured paths without expanded-callee branches", () => {
    const customerPorts = [
      port("customer-then", "then", 0, source(8, 2, 10, 3)),
      port("customer-else", "fallthrough", 1, undefined, true),
    ];
    const linesPorts = [
      port("lines-then", "then", 0, source(11, 2, 13, 3)),
      port("lines-else", "fallthrough", 1, undefined, true),
    ];
    const calleePorts = [
      port("sku-then", "then", 0, source(21, 2, 23, 3)),
      port("sku-else", "fallthrough", 1, undefined, true),
    ];
    const expandedCall = logicNode("root::2", "call", { isContainer: true });
    const nodes = [
      branchNode("root::0", "if", customerPorts, source(8, 2, 10, 3)),
      branchNode("root::1", "if", linesPorts, source(11, 2, 13, 3)),
      expandedCall,
      branchNode("root::2/c0", "if", calleePorts, source(21, 2, 23, 3), expandedCall.id),
    ];
    const execution = executionCoverageIndex(artifact([], coverage({
      functions: [],
      branches: [
        ifBranch(8, 10, 0, 2),
        ifBranch(11, 13, 0, 2),
        // This measured callee decision is visible only because its call is expanded. It must not
        // make validateOrderRequest read as 4/6 instead of its own honest 2/4.
        ifBranch(21, 23, 3, 1),
      ],
    })))!;

    const model = inferExecutionLaneCoverage(nodes, [], execution);
    expect([...model.byLaneId.values()].filter((signal) => signal.hits !== null)).toHaveLength(6);
    expect(tallySelectedExecutionBranchCoverage(nodes, model)).toEqual({ hit: 2, total: 4, percent: 50 });
  });

  it("counts root-owned nested structure but excludes unknown and ignored paths", () => {
    const loop = logicNode("root::loop", "loop", { isContainer: true });
    const ports = [
      port("then", "then", 0, source(8, 2, 10, 3)),
      port("else", "else", 1, source(10, 7, 12, 3)),
    ];
    const nodes = [
      loop,
      branchNode("root::loop/0", "if", ports, source(8, 2, 12, 3), loop.id),
    ];
    const execution = executionCoverageIndex(artifact([], coverage({
      functions: [],
      branches: [{
        type: "if",
        location: span(8, 12, 3),
        // Ignoring the then arm removes its counter. The remaining measured else is hit.
        paths: [{ index: 0, hits: 2, location: span(10, 12, 3, 7) }],
      }],
    })))!;

    const model = inferExecutionLaneCoverage(nodes, [], execution);
    expect(model.byLaneId.get("then")).toMatchObject({ tone: "unknown", reason: "no-path-match" });
    expect(tallySelectedExecutionBranchCoverage(nodes, model)).toEqual({ hit: 1, total: 1, percent: 100 });
  });

  it("returns null when the selected callable has no measured branch paths", () => {
    const tryPorts = [port("try", "try", 0), port("catch", "catch", 1)];
    const nodes = branchNodes("try", tryPorts, source(1, 0, 5, 1));
    const model = inferExecutionLaneCoverage(
      nodes,
      laneEdges(tryPorts),
      executionCoverageIndex(artifact([], coverage({ functions: [], branches: [] })))!,
    );

    expect(tallySelectedExecutionBranchCoverage(nodes, model)).toBeNull();
  });
});

function graphNode(id: string, displayName: string, startLine: number, endLine: number): GraphNode {
  return {
    id,
    kind: "function",
    qualifiedName: displayName,
    displayName,
    location: { file: "src/validation/orderValidator.ts", startLine, endLine },
  };
}

function coverage(file: TestExecutionCoverage["files"][string]): TestExecutionCoverage {
  return {
    version: "1.0.0",
    aggregate: true,
    producer: { inputFormat: "istanbul-coverage-map" },
    files: { "src/validation/orderValidator.ts": file },
  };
}

function artifact(nodes: GraphNode[], runtime: TestExecutionCoverage): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-13T00:00:00.000Z",
    generator: { name: "test", version: "0" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes,
    edges: [],
    extensions: { testExecutionCoverage: runtime as unknown as JsonValue },
  };
}

function span(startLine: number, endLine: number, endColumn: number, startColumn = 2) {
  return { start: { line: startLine, column: startColumn }, end: { line: endLine, column: endColumn } };
}

function source(line: number, col: number, endLine: number, endCol: number) {
  return { file: "src/validation/orderValidator.ts", line, col, endLine, endCol };
}

function port(
  id: string,
  role: LogicBranchPort["role"],
  order: number,
  branchSource?: ReturnType<typeof source>,
  synthetic = false,
): LogicBranchPort {
  return { id, label: id, role, order, ...(branchSource ? { source: branchSource } : {}), ...(synthetic ? { synthetic } : {}) };
}

function branchNodes(
  kind: "if" | "switch" | "try",
  ports: LogicBranchPort[],
  branchSource: ReturnType<typeof source> | undefined,
): LogicRfNode[] {
  const data: LogicNodeData = {
    logicKind: kind,
    branchKind: kind,
    label: kind,
    targetId: null,
    resolution: null,
    expandable: false,
    isExpanded: false,
    isContainer: false,
    compact: false,
    callScope: null,
    greyed: false,
    provenance: null,
    childCount: ports.length,
    branchPorts: ports,
    ...(branchSource ? { branchSource } : {}),
  };
  return [
    { id: "root::0", type: kind === "try" ? "exception" : "branch", position: { x: 0, y: 0 }, data },
    ...ports.map((entry) => ({
      id: `root::0/b${entry.order}/0`,
      type: "terminal" as const,
      position: { x: 100, y: entry.order * 40 },
      data: { targetId: null, isContainer: false as const, terminal: "exit" as const, label: "EXIT" },
    })),
  ];
}

function branchNode(
  id: string,
  kind: "if" | "switch" | "try",
  ports: LogicBranchPort[],
  branchSource: ReturnType<typeof source> | undefined,
  parentId?: string,
): LogicRfNode {
  const [node] = branchNodes(kind, ports, branchSource);
  return { ...node!, id, ...(parentId ? { parentId } : {}) };
}

function logicNode(
  id: string,
  logicKind: "call" | "loop",
  override: Partial<LogicNodeData> = {},
): LogicRfNode {
  const data: LogicNodeData = {
    logicKind,
    label: logicKind,
    targetId: logicKind === "call" ? "callee" : null,
    resolution: logicKind === "call" ? "resolved" : null,
    expandable: true,
    isExpanded: true,
    isContainer: true,
    compact: false,
    callScope: logicKind === "call" ? "internal" : null,
    greyed: false,
    provenance: null,
    childCount: 1,
    ...override,
  };
  return { id, type: logicKind === "call" ? "block" : "control", position: { x: 0, y: 0 }, data };
}

function ifBranch(startLine: number, endLine: number, thenHits: number, elseHits: number) {
  return {
    type: "if" as const,
    location: span(startLine, endLine, 3),
    paths: [
      { index: 0, hits: thenHits, location: span(startLine, endLine, 3) },
      { index: 1, hits: elseHits },
    ],
  };
}

function laneEdges(ports: LogicBranchPort[]): LogicRfEdge[] {
  return ports.map((entry) => ({
    id: `edge-${entry.id}`,
    source: "root::0",
    target: `root::0/b${entry.order}/0`,
    sourceHandle: entry.id,
    style: { stroke: "#fff" },
    data: { kind: "branch", sourcePort: entry.id, branchRole: entry.role },
  }));
}
