/**
 * Shape the coverage report into the panel's story: one row per container where callables
 * actually live (class, or module with top-level functions), worst-covered first, each
 * carrying its uncovered members WITH the reason they are uncovered. Pure — unit-testable
 * without React.
 */

import type { CoverageReport, NodeId } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";

export interface UncoveredMemberRow {
  id: NodeId;
  name: string;
  reason: string;
}

export interface CoverageRow {
  id: NodeId;
  name: string;
  kind: string;
  covered: number;
  total: number;
  percent: number;
  uncoveredMembers: UncoveredMemberRow[];
}

export function buildCoverageRows(report: CoverageReport, index: GraphIndex): CoverageRow[] {
  const leafParents = groupLeavesByParent(report, index);
  return [...leafParents.entries()]
    .map(([containerId, leafIds]) => toRow(containerId, leafIds, report, index))
    .filter((row): row is CoverageRow => row !== null)
    .sort((a, b) => a.percent - b.percent || b.total - a.total);
}

function groupLeavesByParent(report: CoverageReport, index: GraphIndex): Map<string, NodeId[]> {
  const byParent = new Map<string, NodeId[]>();
  for (const leafId of Object.keys(report.leaves)) {
    const parentId = index.parentOf.get(leafId);
    if (!parentId) {
      continue;
    }
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(leafId);
    byParent.set(parentId, siblings);
  }
  return byParent;
}

function toRow(
  containerId: string,
  leafIds: NodeId[],
  report: CoverageReport,
  index: GraphIndex,
): CoverageRow | null {
  const container = index.nodesById.get(containerId);
  const coverage = report.containers[containerId];
  if (!container || !coverage || coverage.status === "no-callables") {
    return null;
  }
  return {
    id: containerId,
    name: container.qualifiedName,
    kind: container.kind,
    covered: coverage.covered,
    total: coverage.total,
    percent: coverage.percent,
    uncoveredMembers: uncoveredMembers(leafIds, report, index),
  };
}

function uncoveredMembers(leafIds: NodeId[], report: CoverageReport, index: GraphIndex): UncoveredMemberRow[] {
  const rows: UncoveredMemberRow[] = [];
  for (const leafId of leafIds) {
    const leaf = report.leaves[leafId];
    if (leaf?.status !== "uncovered") {
      continue;
    }
    const node = index.nodesById.get(leafId);
    rows.push({
      id: leafId,
      name: node?.displayName ?? leafId,
      reason: reasonText(leaf.reason, index),
    });
  }
  return rows;
}

function reasonText(
  reason: { kind: string; callers: NodeId[] } | undefined,
  index: GraphIndex,
): string {
  if (!reason || reason.kind === "never-called") {
    return "never called in the graph — likely an entry point or dead code";
  }
  const names = reason.callers.map((id) => nameOf(id, index)).join(", ");
  return `only called by code not reachable from tests: ${names}`;
}

function nameOf(id: NodeId, index: GraphIndex): string {
  return index.nodesById.get(id)?.qualifiedName ?? id;
}
