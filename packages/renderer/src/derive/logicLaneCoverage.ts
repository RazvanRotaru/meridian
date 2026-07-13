/**
 * Static coverage paint for the Logic graph's branch lanes.
 *
 * Meridian's CoverageReport is a graph-reachability estimate: it knows whether tests directly call
 * a callable, reach it through production code, or cannot reach it in the extracted call graph. It
 * does NOT contain line/statement/branch hits. This module therefore summarizes the measurable call
 * targets visible inside each branch arm and labels the result explicitly as callee reachability.
 * Empty, external-only, and unresolved-only arms stay unknown instead of being called uncovered.
 */

import type { CoverageReport } from "@meridian/core";
import type { EdgeMarker } from "@xyflow/react";
import type { LogicNodeData } from "./logicGraph";
import type {
  LogicRfEdge,
  LogicRfEdgeData,
  LogicRfNode,
  StaticLaneSignal,
  StaticLaneTone,
} from "../layout/logicElk";
import { callTargetCoverageVerdict, COVERAGE_COLORS, type CallTargetCoverageVerdict } from "../theme/coverageColors";

export interface StaticLaneModel {
  byLaneId: ReadonlyMap<string, StaticLaneSignal>;
  byEdgeId: ReadonlyMap<string, StaticLaneSignal>;
}

interface LaneCandidate {
  signal: StaticLaneSignal;
  prefix: string;
  containingCalls: ReadonlySet<string>;
}

const EMPTY_MODEL: StaticLaneModel = {
  byLaneId: new Map<string, StaticLaneSignal>(),
  byEdgeId: new Map<string, StaticLaneSignal>(),
};

/** Build the branch-lane model without mutating the laid-out React Flow nodes or edges. */
export function inferVisibleLaneReachability(
  nodes: readonly LogicRfNode[],
  edges: readonly LogicRfEdge[],
  report: CoverageReport,
): StaticLaneModel {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const lanes: LaneCandidate[] = [];

  for (const node of nodes) {
    const data = execData(node);
    if (!data?.branchPorts?.length) continue;
    const containingCalls = expandedCallAncestors(node, byId);
    for (const port of data.branchPorts) {
      const prefix = `${node.id}/b${port.order}/`;
      lanes.push({
        prefix,
        containingCalls,
        signal: summarizeLane(node.id, port.id, port.order, port.label, port.role, prefix, nodes, byId, containingCalls, report),
      });
    }
  }

  if (lanes.length === 0) return EMPTY_MODEL;

  // Nested branches share their outer arm's prefix. Longest-first makes the innermost matching lane
  // own its split/body/rejoin edges; the nested join's continuation naturally falls back outward.
  lanes.sort((a, b) => b.prefix.length - a.prefix.length);
  const byLaneId = new Map(lanes.map(({ signal }) => [signal.laneId, signal]));
  const byEdgeId = new Map<string, StaticLaneSignal>();
  for (const edge of edges) {
    if (edge.data?.kind === "async") continue;
    const lane = lanes.find(({ prefix, signal, containingCalls }) => {
      const matchesLane = splitEdgeUsesLane(edge, signal)
        || edge.source.startsWith(prefix)
        || edge.target.startsWith(prefix);
      return matchesLane && !edgeTouchesNestedExpandedCall(edge, byId, containingCalls);
    });
    if (lane) byEdgeId.set(edge.id, lane.signal);
  }
  return { byLaneId, byEdgeId };
}

/** Apply the shared coverage palette to inferred lane edges while preserving routing/edge grammar. */
export function paintInferredLaneReachability(
  edges: readonly LogicRfEdge[],
  model: StaticLaneModel,
): LogicRfEdge[] {
  if (model.byEdgeId.size === 0) return edges as LogicRfEdge[];
  return edges.map((edge) => {
    const signal = model.byEdgeId.get(edge.id);
    if (!signal) return edge;
    const color = COVERAGE_COLORS[signal.tone];
    const data: LogicRfEdgeData = {
      kind: edge.data?.kind ?? (edge.label == null ? "seq" : "branch"),
      ...edge.data,
      staticLane: signal,
    };
    return {
      ...edge,
      ariaLabel: laneAriaLabel(edge, signal),
      style: { ...edge.style, stroke: color },
      labelStyle: { ...edge.labelStyle, fill: color },
      markerEnd: tintMarker(edge.markerEnd, color),
      data,
    };
  });
}

/** Coverage-off is deliberately allocation-free: return the exact layout edge array. */
export function withInferredLaneReachability(
  edges: LogicRfEdge[],
  nodes: readonly LogicRfNode[],
  report: CoverageReport | null,
): LogicRfEdge[] {
  if (!report) return edges;
  return paintInferredLaneReachability(edges, inferVisibleLaneReachability(nodes, edges, report));
}

/** The call-card verdict a Logic MiniMap may mirror; non-call nodes return null. */
export function visibleCallReachabilityTone(
  node: Pick<LogicRfNode, "id" | "parentId" | "data">,
  report: CoverageReport,
): CallTargetCoverageVerdict | null {
  const data = execData(node);
  if (data?.logicKind !== "call") return null;
  return callTargetCoverageVerdict(data.targetId, data.resolution, report);
}

function summarizeLane(
  branchNodeId: string,
  laneId: string,
  armIndex: number,
  label: string,
  role: StaticLaneSignal["role"],
  prefix: string,
  nodes: readonly LogicRfNode[],
  byId: ReadonlyMap<string, LogicRfNode>,
  containingCalls: ReadonlySet<string>,
  report: CoverageReport,
): StaticLaneSignal {
  const measured = new Map<string, "covered" | "indirect" | "uncovered">();
  const unmeasured = new Set<string>();
  for (const node of nodes) {
    if (!node.id.startsWith(prefix) || isInsideNestedExpandedCall(node, byId, containingCalls)) continue;
    const data = execData(node);
    if (data?.logicKind !== "call" || data.definition) continue;
    if (!isResolvedCall(data)) {
      unmeasured.add(data?.targetId ?? node.id);
      continue;
    }
    const tone = callTargetReachabilityTone(data, report);
    if (tone && tone !== "none") measured.set(data.targetId!, tone);
    else unmeasured.add(data.targetId!);
  }

  const counts = { direct: 0, indirect: 0, uncovered: 0, unmeasured: unmeasured.size };
  for (const status of measured.values()) {
    if (status === "covered") counts.direct += 1;
    else if (status === "indirect") counts.indirect += 1;
    else counts.uncovered += 1;
  }
  return {
    basis: "visible-callee-reachability",
    laneId,
    branchNodeId,
    armIndex,
    label,
    role,
    tone: laneTone(counts),
    counts,
  };
}

function laneTone(counts: StaticLaneSignal["counts"]): StaticLaneTone {
  const measured = counts.direct + counts.indirect + counts.uncovered;
  if (measured === 0) return "none";
  if (counts.unmeasured === 0 && counts.direct === measured) return "covered";
  if (counts.unmeasured === 0 && counts.uncovered === measured) return "uncovered";
  return "indirect";
}

function splitEdgeUsesLane(edge: LogicRfEdge, signal: StaticLaneSignal): boolean {
  return edge.source === signal.branchNodeId
    && (edge.sourceHandle === signal.laneId || edge.data?.sourcePort === signal.laneId);
}

/** Keep a caller-lane color off the expanded callee's own internal routing. */
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

/** The expanded call containers shared by a lane's branch node and everything charted inside it. */
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

/**
 * Expanded-callee children describe the callee's own flow, not the caller branch containing it.
 * Calls already containing the branch are allowed: an inline-expanded callee's own branches should
 * still receive lane colors; only a deeper call expanded inside that lane is excluded.
 */
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

function isResolvedCall(data: LogicNodeData | null): data is LogicNodeData & { targetId: string } {
  return data?.logicKind === "call"
    && data.resolution === "resolved"
    && data.targetId !== null;
}

/** A resolved call may target a callable leaf or a class/module container such as `new Class()`. */
function callTargetReachabilityTone(
  data: LogicNodeData | null,
  report: CoverageReport,
): StaticLaneTone | null {
  if (!isResolvedCall(data)) return null;
  const verdict = callTargetCoverageVerdict(data.targetId, data.resolution, report);
  return verdict === "test" ? "none" : verdict;
}

function execData(node: Pick<LogicRfNode, "data">): LogicNodeData | null {
  const data = node.data as Partial<LogicNodeData>;
  return typeof data.logicKind === "string" ? data as LogicNodeData : null;
}

function tintMarker(marker: LogicRfEdge["markerEnd"], color: string): LogicRfEdge["markerEnd"] {
  return marker && typeof marker === "object" ? { ...(marker as EdgeMarker), color } : marker;
}

function laneAriaLabel(edge: LogicRfEdge, signal: StaticLaneSignal): string {
  const { direct, indirect, uncovered, unmeasured } = signal.counts;
  const label = edge.label == null ? signal.label : String(edge.label);
  return `${label} · static callee reachability: ${direct} direct, ${indirect} indirect, ${uncovered} not test-reached, ${unmeasured} unmeasured; not branch execution data`;
}
