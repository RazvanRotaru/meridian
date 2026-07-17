/**
 * Transport-ready static-reachability facts.
 *
 * Coverage is calculated once over the complete revision. The summary and diagnostic rows remain
 * whole-revision facts, while a projection response can retain paint data only for its returned
 * node ids. This keeps navigation honest without requiring a renderer index or the full graph.
 */

import {
  computeCoverage,
  type ContainerCoverage,
  type CoverageSummary,
  type LeafCoverage,
  type UncoveredReason,
} from "./coverage";
import type { GraphEdge, GraphNode, NodeId } from "./types";

export const REACHABILITY_WORST_ROW_LIMIT = 10;

export interface ReachabilityUncoveredMember {
  id: NodeId;
  name: string;
  reason: string;
}

export interface ReachabilityCoverageRow {
  id: NodeId;
  name: string;
  kind: string;
  covered: number;
  total: number;
  percent: number;
  uncoveredMembers: readonly ReachabilityUncoveredMember[];
}

export interface ReachabilityPaintFacts {
  leaves: Readonly<Record<NodeId, LeafCoverage>>;
  containers: Readonly<Record<NodeId, ContainerCoverage>>;
}

/** Full-revision summary/diagnostics plus paint facts for the represented node slice. */
export interface ReachabilityProjectionFacts extends ReachabilityPaintFacts {
  summary: CoverageSummary;
  /** Worst-covered direct callable containers, capped by `REACHABILITY_WORST_ROW_LIMIT`. */
  worstRows: readonly ReachabilityCoverageRow[];
}

/** Strict shared parser for persisted facts and bounded projection responses. */
export function parseReachabilityProjectionFacts(value: unknown): ReachabilityProjectionFacts {
  if (!isRecord(value) || !exactKeys(value, ["summary", "worstRows", "leaves", "containers"])
    || !isCoverageSummary(value.summary)
    || !Array.isArray(value.worstRows) || value.worstRows.length > REACHABILITY_WORST_ROW_LIMIT
    || !value.worstRows.every(isCoverageRow)
    || !isFactRecord(value.leaves, isLeafCoverage)
    || !isFactRecord(value.containers, isContainerCoverage)) {
    throw new TypeError("invalid reachability projection facts");
  }
  const facts = value as unknown as ReachabilityProjectionFacts;
  assertCanonicalReachabilityFacts(facts);
  return facts;
}

export function buildReachabilityProjection(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): ReachabilityProjectionFacts {
  const report = computeCoverage([...nodes], [...edges]);
  const paint = canonicalPaintFacts(report);
  return parseReachabilityProjectionFacts({
    summary: { ...report.summary },
    worstRows: buildWorstRows(nodes, paint),
    ...paint,
  });
}

/** Select only paint facts whose node is present in the bounded projection response. */
export function filterReachabilityPaintFacts(
  facts: ReachabilityPaintFacts,
  returnedNodeIds: ReadonlySet<NodeId> | readonly NodeId[],
): ReachabilityPaintFacts {
  const returned = new Set(returnedNodeIds);
  return {
    leaves: filterRecord(facts.leaves, returned),
    containers: filterRecord(facts.containers, returned),
  };
}

function buildWorstRows(
  nodes: readonly GraphNode[],
  report: ReachabilityPaintFacts,
): ReachabilityCoverageRow[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const leafIdsByParent = new Map<NodeId, NodeId[]>();
  for (const leafId of Object.keys(report.leaves)) {
    const parentId = nodesById.get(leafId)?.parentId;
    if (!parentId) continue;
    const ids = leafIdsByParent.get(parentId) ?? [];
    ids.push(leafId);
    leafIdsByParent.set(parentId, ids);
  }

  return [...leafIdsByParent]
    .map(([containerId, leafIds]) => coverageRow(containerId, leafIds, report, nodesById))
    .filter((row): row is ReachabilityCoverageRow => row !== null)
    .sort(compareCoverageRows)
    .slice(0, REACHABILITY_WORST_ROW_LIMIT);
}

function coverageRow(
  containerId: NodeId,
  leafIds: readonly NodeId[],
  report: ReachabilityPaintFacts,
  nodesById: ReadonlyMap<NodeId, GraphNode>,
): ReachabilityCoverageRow | null {
  const node = nodesById.get(containerId);
  const coverage = report.containers[containerId];
  if (node === undefined || coverage === undefined || coverage.status === "no-callables") return null;
  return {
    id: containerId,
    name: node.qualifiedName,
    kind: node.kind,
    covered: coverage.covered,
    total: coverage.total,
    percent: coverage.percent,
    uncoveredMembers: leafIds
      .flatMap((leafId): ReachabilityUncoveredMember[] => {
        const leaf = report.leaves[leafId];
        if (leaf?.status !== "uncovered") return [];
        return [{
          id: leafId,
          name: nodesById.get(leafId)?.displayName ?? leafId,
          reason: uncoveredReasonText(leaf.reason, nodesById),
        }];
      })
      .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id)),
  };
}

function uncoveredReasonText(
  reason: UncoveredReason | undefined,
  nodesById: ReadonlyMap<NodeId, GraphNode>,
): string {
  if (reason === undefined || reason.kind === "never-called") {
    return "never called in the graph — likely an entry point or dead code";
  }
  const names = reason.callers
    .map((id) => nodesById.get(id)?.qualifiedName ?? id)
    .sort()
    .join(", ");
  return `only called by code not reachable from tests: ${names}`;
}

function compareCoverageRows(left: ReachabilityCoverageRow, right: ReachabilityCoverageRow): number {
  return left.percent - right.percent
    || right.total - left.total
    || compareText(left.name, right.name)
    || compareText(left.id, right.id);
}

function canonicalPaintFacts(facts: ReachabilityPaintFacts): ReachabilityPaintFacts {
  const leaves: Record<NodeId, LeafCoverage> = {};
  for (const id of Object.keys(facts.leaves).sort(compareText)) {
    const fact = facts.leaves[id]!;
    leaves[id] = {
      status: fact.status,
      distance: fact.distance,
      directTestCallers: [...new Set(fact.directTestCallers)].sort(compareText),
      ...(fact.reason === undefined ? {} : {
        reason: {
          kind: fact.reason.kind,
          callers: [...new Set(fact.reason.callers)].sort(compareText),
        },
      }),
    };
  }
  const containers: Record<NodeId, ContainerCoverage> = {};
  for (const id of Object.keys(facts.containers).sort(compareText)) {
    containers[id] = { ...facts.containers[id]! };
  }
  return { leaves, containers };
}

function assertCanonicalReachabilityFacts(facts: ReachabilityProjectionFacts): void {
  const rows = facts.worstRows;
  if (!isSortedBy(rows, compareCoverageRows)
    || new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new TypeError("reachability coverage rows must be canonical");
  }
  const memberIds = new Set<string>();
  for (const row of rows) {
    if (!isSortedBy(row.uncoveredMembers, compareUncoveredMembers)
      || new Set(row.uncoveredMembers.map((member) => member.id)).size !== row.uncoveredMembers.length
      || row.uncoveredMembers.length > row.total - row.covered) {
      throw new TypeError("reachability uncovered members must be canonical");
    }
    for (const member of row.uncoveredMembers) {
      if (memberIds.has(member.id)) {
        throw new TypeError("reachability uncovered members must belong to one row");
      }
      memberIds.add(member.id);
    }
  }
  for (const fact of Object.values(facts.leaves)) {
    if (!isSortedUnique(fact.directTestCallers)
      || (fact.reason !== undefined && !isSortedUnique(fact.reason.callers))) {
      throw new TypeError("reachability leaf references must be canonical");
    }
  }
}

function isCoverageSummary(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, [
    "callables", "covered", "indirect", "uncovered", "percent", "testNodes", "unresolvedFromTests",
  ])) return false;
  const counts = [
    value.callables, value.covered, value.indirect, value.uncovered,
    value.percent, value.testNodes, value.unresolvedFromTests,
  ];
  if (!counts.every(isNonNegativeInteger)) return false;
  const callables = Number(value.callables);
  const reached = Number(value.covered) + Number(value.indirect);
  return reached + Number(value.uncovered) === callables
    && Number(value.percent) === coveragePercent(reached, callables);
}

function isCoverageRow(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, [
    "id", "name", "kind", "covered", "total", "percent", "uncoveredMembers",
  ])
    && isId(value.id) && isText(value.name) && isId(value.kind)
    && isNonNegativeInteger(value.covered) && isPositiveInteger(value.total)
    && Number(value.covered) <= Number(value.total)
    && isNonNegativeInteger(value.percent)
    && Number(value.percent) === coveragePercent(Number(value.covered), Number(value.total))
    && Array.isArray(value.uncoveredMembers) && value.uncoveredMembers.every(isUncoveredMember);
}

function isUncoveredMember(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ["id", "name", "reason"])
    && isId(value.id) && isText(value.name) && isId(value.reason);
}

function isLeafCoverage(value: unknown): boolean {
  if (!isRecord(value) || !isId(value.status)
    || !Array.isArray(value.directTestCallers) || !value.directTestCallers.every(isId)) return false;
  if (value.status === "covered") {
    return exactKeys(value, ["status", "distance", "directTestCallers"])
      && value.distance === 1 && value.directTestCallers.length > 0;
  }
  if (value.status === "indirect") {
    return exactKeys(value, ["status", "distance", "directTestCallers"])
      && Number.isSafeInteger(value.distance) && Number(value.distance) >= 2
      && value.directTestCallers.length === 0;
  }
  if (value.status !== "uncovered" || !exactKeys(value, ["status", "distance", "directTestCallers", "reason"])
    || value.distance !== null || value.directTestCallers.length !== 0 || !isRecord(value.reason)
    || !exactKeys(value.reason, ["kind", "callers"]) || !Array.isArray(value.reason.callers)
    || !value.reason.callers.every(isId)) return false;
  return (value.reason.kind === "never-called" && value.reason.callers.length === 0)
    || (value.reason.kind === "only-uncovered-callers" && value.reason.callers.length > 0);
}

function isContainerCoverage(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["covered", "total", "percent", "status"])
    || !isNonNegativeInteger(value.covered) || !isNonNegativeInteger(value.total)
    || Number(value.covered) > Number(value.total) || !isNonNegativeInteger(value.percent)) return false;
  const covered = Number(value.covered);
  const total = Number(value.total);
  if (Number(value.percent) !== coveragePercent(covered, total)) return false;
  const status = total === 0
    ? "no-callables"
    : covered === 0
      ? "uncovered"
      : covered === total
        ? "covered"
        : "partial";
  return value.status === status;
}

function isFactRecord(
  value: unknown,
  isFact: (candidate: unknown) => boolean,
): boolean {
  return isRecord(value) && Object.entries(value).every(([id, fact]) => isId(id) && isFact(fact));
}

function coveragePercent(covered: number, total: number): number {
  return total === 0 ? 0 : Math.round((covered / total) * 100);
}

function compareUncoveredMembers(
  left: ReachabilityUncoveredMember,
  right: ReachabilityUncoveredMember,
): number {
  return compareText(left.name, right.name) || compareText(left.id, right.id);
}

function isSortedBy<T>(values: readonly T[], compare: (left: T, right: T) => number): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) <= 0);
}

function filterRecord<T>(
  source: Readonly<Record<NodeId, T>>,
  ids: ReadonlySet<NodeId>,
): Record<NodeId, T> {
  const filtered: Record<NodeId, T> = {};
  for (const id of [...ids].sort()) {
    const fact = source[id];
    if (fact !== undefined) filtered[id] = fact;
  }
  return filtered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const canonicalExpected = [...expected].sort(compareText);
  return actual.length === canonicalExpected.length
    && actual.every((key, index) => key === canonicalExpected[index]);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isText(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0");
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
