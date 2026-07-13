/**
 * Runtime execution coverage for the Logic graph.
 *
 * The CLI normalizes Istanbul's coverage-final.json into a provider-neutral artifact extension.
 * This module performs the final source join: callable ranges become node hit verdicts and
 * Istanbul branch-path counters become Logic lane signals. A missing/ambiguous join is UNKNOWN —
 * only an explicit counter with value zero is allowed to paint a node or lane red.
 */

import type {
  ExecutionCoverageSpan,
  FlowSourceAnchor,
  GraphArtifact,
  GraphNode,
  TestExecutionCoverage,
  TestExecutionCoverageFile,
} from "@meridian/core";
import { readTestExecutionCoverage } from "@meridian/core";
import type { EdgeMarker } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import type {
  ExecutionLaneSignal,
  LogicRfEdge,
  LogicRfEdgeData,
  LogicRfNode,
} from "../layout/logicElk";
import { COVERAGE_COLORS } from "../theme/coverageColors";
import type { LogicBranchPort, LogicNodeData } from "./logicGraph";

export type ExecutionCoverageVerdict = "covered" | "uncovered";

export interface IndexedExecutionCoverage {
  coverage: TestExecutionCoverage;
  files: ReadonlyMap<string, TestExecutionCoverageFile>;
}

export interface ExecutionFunctionEvidence {
  hits: number;
  verdict: ExecutionCoverageVerdict;
}

export interface ExecutionFlowTally {
  covered: number;
  uncovered: number;
  total: number;
}

/** Measured Istanbul branch paths for the callable whose Logic flow is currently open. */
export interface ExecutionBranchPathTally {
  /** Number of measured paths whose aggregate counter is non-zero. */
  hit: number;
  /** Number of measured paths. Unknown, unsupported, and ignored paths are not in this denominator. */
  total: number;
  percent: number;
}

export interface ExecutionLaneModel {
  byLaneId: ReadonlyMap<string, ExecutionLaneSignal>;
  byEdgeId: ReadonlyMap<string, ExecutionLaneSignal>;
}

const INDEX_CACHE = new WeakMap<GraphArtifact, IndexedExecutionCoverage | null>();
const EMPTY_LANE_MODEL: ExecutionLaneModel = {
  byLaneId: new Map<string, ExecutionLaneSignal>(),
  byEdgeId: new Map<string, ExecutionLaneSignal>(),
};

/** Parse and index the extension once per immutable artifact object. */
export function executionCoverageIndex(artifact: GraphArtifact): IndexedExecutionCoverage | null {
  const cached = INDEX_CACHE.get(artifact);
  if (cached !== undefined) return cached;
  const coverage = readTestExecutionCoverage(artifact);
  const indexed = coverage
    ? { coverage, files: new Map(Object.entries(coverage.files).map(([file, value]) => [normalizePath(file), value])) }
    : null;
  INDEX_CACHE.set(artifact, indexed);
  return indexed;
}

/** A graph callable is measured only when exactly one imported function range matches it. */
export function executionEvidenceForNode(
  node: GraphNode | undefined,
  execution: IndexedExecutionCoverage | null,
): ExecutionFunctionEvidence | null {
  if (!node || !execution || (node.kind !== "function" && node.kind !== "method")) return null;
  const file = execution.files.get(normalizePath(node.location.file));
  if (!file) return null;
  const match = uniqueBestFunction(node, file);
  return match ? { hits: match.hits, verdict: match.hits > 0 ? "covered" : "uncovered" } : null;
}

/** Runtime verdict for a resolved Logic call target. External/unresolved/container targets stay unknown. */
export function executionEvidenceForCallTarget(
  targetId: string | null,
  resolution: LogicNodeData["resolution"] | undefined,
  graph: GraphIndex,
  execution: IndexedExecutionCoverage | null,
): ExecutionFunctionEvidence | null {
  if (resolution !== "resolved" || targetId === null) return null;
  return executionEvidenceForNode(graph.nodesById.get(targetId), execution);
}

/** Aggregate the distinct, measurable callees visible in the current Logic projection. */
export function tallyVisibleExecutionCoverage(
  nodes: readonly LogicRfNode[],
  graph: GraphIndex,
  execution: IndexedExecutionCoverage,
): ExecutionFlowTally {
  const seen = new Set<string>();
  let covered = 0;
  let uncovered = 0;
  for (const node of nodes) {
    const data = execData(node);
    if (data?.logicKind !== "call" || data.definition || !data.targetId || seen.has(data.targetId)) continue;
    const evidence = executionEvidenceForCallTarget(data.targetId, data.resolution, graph, execution);
    if (!evidence) continue;
    seen.add(data.targetId);
    if (evidence.verdict === "covered") covered += 1;
    else uncovered += 1;
  }
  return { covered, uncovered, total: covered + uncovered };
}

/** Build per-port runtime signals and associate them with every visible edge in that lane. */
export function inferExecutionLaneCoverage(
  nodes: readonly LogicRfNode[],
  edges: readonly LogicRfEdge[],
  execution: IndexedExecutionCoverage,
): ExecutionLaneModel {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const lanes: LaneCandidate[] = [];

  for (const node of nodes) {
    const data = execData(node);
    if (!data?.branchPorts?.length) continue;
    const containingCalls = expandedCallAncestors(node, byId);
    const signals = branchSignals(node.id, data, execution);
    for (const signal of signals) {
      lanes.push({
        signal,
        prefix: `${node.id}/b${signal.armIndex}/`,
        containingCalls,
      });
    }
  }

  if (lanes.length === 0) return EMPTY_LANE_MODEL;
  lanes.sort((a, b) => b.prefix.length - a.prefix.length);
  const byLaneId = new Map(lanes.map(({ signal }) => [signal.laneId, signal]));
  const byEdgeId = new Map<string, ExecutionLaneSignal>();
  for (const edge of edges) {
    if (edge.data?.kind === "async") continue;
    const lane = lanes.find(({ prefix, signal, containingCalls }) => {
      const matches = splitEdgeUsesLane(edge, signal)
        || edge.source.startsWith(prefix)
        || edge.target.startsWith(prefix);
      return matches && !edgeTouchesNestedExpandedCall(edge, byId, containingCalls);
    });
    if (lane) byEdgeId.set(edge.id, lane.signal);
  }
  return { byLaneId, byEdgeId };
}

/**
 * Tally measured branch paths owned by the callable whose Logic flow is open.
 *
 * Expanded calls inline their callee flow below a `logicKind: "call"` container. Those nested
 * branches are useful lane evidence, but they do not belong in the selected callable's percentage.
 * Other containers (loops, callbacks, and service frames) remain part of the selected callable and
 * must not be filtered out. Iterating `byLaneId` also counts each path once even when its signal is
 * attached to several rendered edges.
 *
 * Unknown signals are deliberately excluded from both sides of the ratio. In particular, an
 * Istanbul-ignored arm has no counter and therefore cannot honestly increase the measured total.
 */
export function tallySelectedExecutionBranchCoverage(
  nodes: readonly LogicRfNode[],
  model: ExecutionLaneModel,
): ExecutionBranchPathTally | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selectedBranchIds = new Set(
    nodes
      .filter((node) => execData(node)?.branchPorts?.length && belongsToSelectedCallableFlow(node, byId))
      .map((node) => node.id),
  );

  let hit = 0;
  let total = 0;
  for (const signal of model.byLaneId.values()) {
    if (!selectedBranchIds.has(signal.branchNodeId) || signal.hits === null || signal.tone === "unknown") continue;
    total += 1;
    if (signal.hits > 0) hit += 1;
  }
  return total === 0 ? null : { hit, total, percent: Math.round((100 * hit) / total) };
}

/** Paint matched counters green/red and all unsupported/unmatched runtime lanes neutral gray. */
export function paintExecutionLaneCoverage(
  edges: readonly LogicRfEdge[],
  model: ExecutionLaneModel,
): LogicRfEdge[] {
  if (model.byEdgeId.size === 0) return edges as LogicRfEdge[];
  return edges.map((edge) => {
    const signal = model.byEdgeId.get(edge.id);
    if (!signal) return edge;
    const color = signal.tone === "unknown" ? COVERAGE_COLORS.none : COVERAGE_COLORS[signal.tone];
    const data: LogicRfEdgeData = {
      kind: edge.data?.kind ?? (edge.label == null ? "seq" : "branch"),
      ...edge.data,
      staticLane: undefined,
      executionLane: signal,
    };
    return {
      ...edge,
      ariaLabel: executionLaneAriaLabel(edge, signal),
      style: { ...edge.style, stroke: color },
      labelStyle: { ...edge.labelStyle, fill: color },
      markerEnd: tintMarker(edge.markerEnd, color),
      data,
    };
  });
}

export function withExecutionLaneCoverage(
  edges: LogicRfEdge[],
  nodes: readonly LogicRfNode[],
  execution: IndexedExecutionCoverage,
): LogicRfEdge[] {
  return paintExecutionLaneCoverage(edges, inferExecutionLaneCoverage(nodes, edges, execution));
}

interface LaneCandidate {
  signal: ExecutionLaneSignal;
  prefix: string;
  containingCalls: ReadonlySet<string>;
}

type NormalizedBranch = TestExecutionCoverageFile["branches"][number];
type NormalizedBranchPath = NormalizedBranch["paths"][number];

function branchSignals(
  branchNodeId: string,
  data: LogicNodeData,
  execution: IndexedExecutionCoverage,
): ExecutionLaneSignal[] {
  const ports = data.branchPorts ?? [];
  const unknown = (reason: NonNullable<ExecutionLaneSignal["reason"]>) =>
    ports.map((port) => unknownSignal(branchNodeId, port, reason));

  if (data.branchKind !== "if" && data.branchKind !== "switch") {
    return unknown("unsupported-branch-kind");
  }
  const source = preciseSpan(data.branchSource);
  if (!source) return unknown("missing-source");
  const file = execution.files.get(normalizePath(data.branchSource!.file));
  if (!file) return unknown("no-file-evidence");
  const type = data.branchKind;
  const candidates = file.branches.filter((branch) => branch.type === type && sameSourceStart(branch.location, source));
  const branch = uniqueByExactSpan(candidates, source);
  if (!branch) return unknown("no-branch-match");

  const claimed = new Set<number>();
  return ports.map((port) => {
    const path = type === "if"
      ? matchIfPath(port, branch, claimed)
      : matchSwitchPath(port, branch, claimed);
    if (!path) return unknownSignal(branchNodeId, port, "no-path-match");
    claimed.add(path.index);
    return {
      basis: "istanbul-branch-path",
      laneId: port.id,
      branchNodeId,
      armIndex: port.order,
      label: port.label,
      role: port.role,
      tone: path.hits > 0 ? "covered" : "uncovered",
      hits: path.hits,
      pathIndex: path.index,
    };
  });
}

/**
 * Istanbul's normal `if` instrumentation uses the whole-if location for the consequent counter,
 * while the alternate uses its own range. Range matching also survives ignored arms, whose removal
 * shifts numeric counter indexes. The implicit fallthrough receives the sole remaining counter.
 */
function matchIfPath(
  port: LogicBranchPort,
  branch: NormalizedBranch,
  claimed: ReadonlySet<number>,
): NormalizedBranchPath | null {
  const available = branch.paths.filter((path) => !claimed.has(path.index));
  if (port.role === "then") {
    return uniquePath(available.filter((path) => path.location && sameReportedSpan(path.location, branch.location)))
      ?? pathBySource(available, port.source);
  }
  if (port.role === "else") {
    return pathBySource(available, port.source);
  }
  if (port.role === "fallthrough" && port.synthetic) {
    return available.length === 1 ? available[0] : null;
  }
  return null;
}

function matchSwitchPath(
  port: LogicBranchPort,
  branch: NormalizedBranch,
  claimed: ReadonlySet<number>,
): NormalizedBranchPath | null {
  if (port.synthetic) return null; // Istanbul has no default-less "no match" counter.
  return pathBySource(branch.paths.filter((path) => !claimed.has(path.index)), port.source);
}

function pathBySource(paths: readonly NormalizedBranchPath[], source: FlowSourceAnchor | undefined): NormalizedBranchPath | null {
  const span = preciseSpan(source);
  if (!span) return null;
  return uniqueByExactSpan(paths.filter((path): path is NormalizedBranchPath & { location: ExecutionCoverageSpan } => path.location !== undefined), span);
}

function unknownSignal(
  branchNodeId: string,
  port: LogicBranchPort,
  reason: NonNullable<ExecutionLaneSignal["reason"]>,
): ExecutionLaneSignal {
  return {
    basis: "istanbul-branch-path",
    laneId: port.id,
    branchNodeId,
    armIndex: port.order,
    label: port.label,
    role: port.role,
    tone: "unknown",
    hits: null,
    reason,
  };
}

function preciseSpan(source: FlowSourceAnchor | undefined): ExecutionCoverageSpan | null {
  if (!source || source.col === undefined || source.endLine === undefined || source.endCol === undefined) return null;
  return {
    start: { line: source.line, column: source.col },
    end: { line: source.endLine, column: source.endCol },
  };
}

function uniqueBestFunction(node: GraphNode, file: TestExecutionCoverageFile): TestExecutionCoverageFile["functions"][number] | null {
  const named = new Set([node.displayName, node.qualifiedName.split(".").at(-1) ?? node.displayName]);
  const candidates = file.functions
    .map((fn) => ({
      fn,
      score:
        (fn.decl.start.line === node.location.startLine ? 8 : 0)
        + (fn.location.start.line === node.location.startLine ? 4 : 0)
        + (named.has(fn.name) ? 2 : 0)
        + (spanInsideLines(fn.decl, node.location.startLine, node.location.endLine ?? node.location.startLine) ? 1 : 0),
    }))
    .filter(({ score }) => score >= 8)
    .sort((a, b) => b.score - a.score);
  if (candidates.length === 0) return null;
  if (candidates.length > 1 && candidates[0]!.score === candidates[1]!.score) return null;
  return candidates[0]!.fn;
}

function spanInsideLines(span: ExecutionCoverageSpan, startLine: number, endLine: number): boolean {
  return span.start.line >= startLine && span.end.line <= endLine;
}

function uniqueByExactSpan<T extends { location: ExecutionCoverageSpan }>(
  candidates: readonly T[],
  source: ExecutionCoverageSpan,
): T | null {
  const exact = candidates.filter((candidate) => sameSourceSpan(candidate.location, source));
  if (exact.length === 1) return exact[0]!;
  const starts = candidates.filter((candidate) => sameSourceStart(candidate.location, source));
  return starts.length === 1 ? starts[0]! : null;
}

function uniquePath(paths: readonly NormalizedBranchPath[]): NormalizedBranchPath | null {
  return paths.length === 1 ? paths[0]! : null;
}

function sameSourceStart(reported: ExecutionCoverageSpan, source: ExecutionCoverageSpan): boolean {
  return reported.start.column !== undefined
    && reported.start.line === source.start.line
    && reported.start.column === source.start.column;
}

function sameSourceSpan(reported: ExecutionCoverageSpan, source: ExecutionCoverageSpan): boolean {
  return sameSourceStart(reported, source)
    && reported.end.column !== undefined
    && reported.end.line === source.end.line
    && reported.end.column === source.end.column;
}

/** Compare two locations from the same report; matching omissions are meaningful here (not a join). */
function sameReportedSpan(left: ExecutionCoverageSpan, right: ExecutionCoverageSpan): boolean {
  return left.start.line === right.start.line
    && left.start.column === right.start.column
    && left.end.line === right.end.line
    && left.end.column === right.end.column;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function execData(node: Pick<LogicRfNode, "data">): LogicNodeData | null {
  const data = node.data as Partial<LogicNodeData>;
  return typeof data.logicKind === "string" ? data as LogicNodeData : null;
}

function splitEdgeUsesLane(edge: LogicRfEdge, signal: ExecutionLaneSignal): boolean {
  return edge.source === signal.branchNodeId
    && (edge.sourceHandle === signal.laneId || edge.data?.sourcePort === signal.laneId);
}

function expandedCallAncestors(
  node: Pick<LogicRfNode, "id" | "parentId">,
  byId: ReadonlyMap<string, LogicRfNode>,
): ReadonlySet<string> {
  const calls = new Set<string>();
  const seen = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    const data = execData(parent);
    if (data?.logicKind === "call" && data.isContainer) calls.add(parent.id);
    parentId = parent.parentId;
  }
  return calls;
}

function edgeTouchesNestedExpandedCall(
  edge: Pick<LogicRfEdge, "source" | "target">,
  byId: ReadonlyMap<string, LogicRfNode>,
  containingCalls: ReadonlySet<string>,
): boolean {
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);
  return (source ? isInsideNestedExpandedCall(source, byId, containingCalls) : false)
    || (target ? isInsideNestedExpandedCall(target, byId, containingCalls) : false);
}

function isInsideNestedExpandedCall(
  node: Pick<LogicRfNode, "id" | "parentId">,
  byId: ReadonlyMap<string, LogicRfNode>,
  containingCalls: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return false;
    const data = execData(parent);
    if (data?.logicKind === "call" && data.isContainer && !containingCalls.has(parent.id)) return true;
    parentId = parent.parentId;
  }
  return false;
}

/**
 * A complete parent chain with no expanded-call boundary identifies structure owned by the open
 * callable. Missing/cyclic ancestry is not safe to attribute, so this intentionally fails closed.
 */
function belongsToSelectedCallableFlow(
  node: Pick<LogicRfNode, "id" | "parentId">,
  byId: ReadonlyMap<string, LogicRfNode>,
): boolean {
  const seen = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId) {
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return false;
    const data = execData(parent);
    if (data?.logicKind === "call" && data.isContainer) return false;
    parentId = parent.parentId;
  }
  return true;
}

function tintMarker(marker: LogicRfEdge["markerEnd"], color: string): LogicRfEdge["markerEnd"] {
  return marker && typeof marker === "object" ? { ...(marker as EdgeMarker), color } : marker;
}

function executionLaneAriaLabel(edge: LogicRfEdge, signal: ExecutionLaneSignal): string {
  const label = edge.label == null ? signal.label : String(edge.label);
  return signal.hits === null
    ? `${label} · execution coverage unknown (${signal.reason ?? "unmatched"})`
    : `${label} · aggregate Istanbul branch-path hits: ${signal.hits}`;
}
