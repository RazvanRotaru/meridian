/**
 * Rank the charted logic flows a PR asks a reviewer to re-check. A flow qualifies when its root
 * callable lives in an affected file ("changed") OR any resolved call in its body reaches a node in
 * an affected file ("calls into"). Membership is by `location.file`, never modulePath. Qualification
 * rides the shared flow-containment index (target -> calling roots); each qualifying flow is then
 * enriched with its counts and touched modules (see `reviewFlowMetrics`). Changed flows sort first.
 * Files that no flow touches are returned separately so they stay OUT of the reviewed denominator.
 * Pure; no React, no store.
 */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { buildFlowContainmentIndex } from "./flowInspect";
import { normalizePath } from "./matchAffectedFiles";
import { calleeFiles, countSteps, fileOf, touchedModules } from "./reviewFlowMetrics";

const CALLABLE_KINDS: ReadonlySet<string> = new Set(["function", "method"]);

export type ReviewReason = "changed" | "calls-into";

export interface RankedReviewFlow {
  rootId: string;
  displayName: string;
  /** The root callable's defining file (normalized). */
  file: string;
  reasons: ReviewReason[];
  /** Affected files this flow calls into, other than its own file; sorted. */
  callsIntoFiles: string[];
  stepCount: number;
  branchCount: number;
  /** Module (file) node ids to highlight: the root's module + each affected callee's module. */
  touchedModuleIds: string[];
}

export interface NotCoveredFile {
  file: string;
  reason: string;
}

export interface ReviewFlowsResult {
  /** Qualifying flows, changed-first then by name. */
  flows: RankedReviewFlow[];
  notCovered: NotCoveredFile[];
}

export function reviewFlows(
  flows: LogicFlows,
  index: GraphIndex,
  affectedCallableIds: ReadonlySet<string>,
  affectedFiles: string[],
): ReviewFlowsResult {
  const affected = new Set(affectedFiles.map(normalizePath));
  const calleesByRoot = affectedCalleesByRoot(flows, affectedCallableIds);
  const ranked = rankFlows(flows, index, affected, calleesByRoot);
  return { flows: ranked, notCovered: notCoveredFiles(index, affected, ranked) };
}

/** Reverse the containment index into: flow root -> the affected callee target ids it calls. */
function affectedCalleesByRoot(flows: LogicFlows, affectedCallableIds: ReadonlySet<string>): Map<string, string[]> {
  const byRoot = new Map<string, string[]>();
  for (const [targetId, rootIds] of buildFlowContainmentIndex(flows)) {
    if (!affectedCallableIds.has(targetId)) {
      continue;
    }
    for (const rootId of rootIds) {
      append(byRoot, rootId, targetId);
    }
  }
  return byRoot;
}

function rankFlows(
  flows: LogicFlows,
  index: GraphIndex,
  affected: ReadonlySet<string>,
  calleesByRoot: Map<string, string[]>,
): RankedReviewFlow[] {
  const built: RankedReviewFlow[] = [];
  for (const rootId of Object.keys(flows)) {
    const flow = buildFlow(rootId, index, affected, calleesByRoot.get(rootId) ?? [], countSteps(flows[rootId]));
    if (flow !== null) {
      built.push(flow);
    }
  }
  return built.sort(byChangedThenName);
}

function buildFlow(
  rootId: string,
  index: GraphIndex,
  affected: ReadonlySet<string>,
  affectedCallees: string[],
  counts: { stepCount: number; branchCount: number },
): RankedReviewFlow | null {
  const rootFile = fileOf(index, rootId);
  const changed = rootFile !== null && affected.has(rootFile);
  const callsIntoFiles = calleeFiles(index, affectedCallees, rootFile);
  if (!changed && callsIntoFiles.length === 0) {
    return null;
  }
  return {
    rootId,
    displayName: index.nodesById.get(rootId)?.displayName ?? rootId,
    file: rootFile ?? "",
    reasons: reasonsFor(changed, callsIntoFiles.length > 0),
    callsIntoFiles,
    ...counts,
    touchedModuleIds: touchedModules(index, rootId, affectedCallees),
  };
}

function reasonsFor(changed: boolean, callsInto: boolean): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (changed) {
    reasons.push("changed");
  }
  if (callsInto) {
    reasons.push("calls-into");
  }
  return reasons;
}

function byChangedThenName(a: RankedReviewFlow, b: RankedReviewFlow): number {
  const rank = changedRank(a) - changedRank(b);
  if (rank !== 0) {
    return rank;
  }
  return a.displayName.localeCompare(b.displayName) || a.rootId.localeCompare(b.rootId);
}

function changedRank(flow: RankedReviewFlow): number {
  return flow.reasons.includes("changed") ? 0 : 1;
}

/** Affected files no qualifying flow defines or reaches — surfaced but out of the denominator. */
function notCoveredFiles(index: GraphIndex, affected: ReadonlySet<string>, ranked: RankedReviewFlow[]): NotCoveredFile[] {
  const covered = coveredFiles(ranked);
  const notCovered: NotCoveredFile[] = [];
  for (const file of [...affected].sort()) {
    if (!covered.has(file)) {
      notCovered.push({ file, reason: uncoveredReason(index, file) });
    }
  }
  return notCovered;
}

function coveredFiles(ranked: RankedReviewFlow[]): Set<string> {
  const covered = new Set<string>();
  for (const flow of ranked) {
    if (flow.reasons.includes("changed")) {
      covered.add(flow.file);
    }
    flow.callsIntoFiles.forEach((file) => covered.add(file));
  }
  return covered;
}

function uncoveredReason(index: GraphIndex, file: string): string {
  return hasCallable(index, file)
    ? "Not defined or reached by any charted flow"
    : "No callable code in this file";
}

function hasCallable(index: GraphIndex, file: string): boolean {
  for (const node of index.nodesById.values()) {
    if (CALLABLE_KINDS.has(node.kind) && node.location?.file && normalizePath(node.location.file) === file) {
      return true;
    }
  }
  return false;
}

function append(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
    return;
  }
  map.set(key, [value]);
}
